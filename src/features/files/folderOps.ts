/**
 * The two folder WRITES (ledger row 10, slice 2): create a folder, and delete
 * one. Both are decided here, once, so `FileBrowser`/`FolderPanel` never compose
 * a store name or loop over the store themselves.
 *
 * WHY A FOLDER NEEDS A MARKER AT ALL. A folder is a naming convention over the
 * flat object list, so a folder that holds nothing has nothing to exist as —
 * unless something is stored whose NAME is the folder's prefix. That is the
 * empty-folder marker (`src/lib/folder.ts#folderMarkerName`): the path plus a
 * trailing separator, e.g. `docs--`. The service refuses an empty body
 * (`400 invalid_body`), so the marker carries a few bytes of its own name; the
 * bytes are never presented as a file's content, because the UI never renders a
 * marker as a file (`src/features/files/folders.ts#describeFolder`).
 *
 * CREATE IS NOT AN OVERWRITE. `PUT` is unconditional and there is no create-only
 * variant, so a second `PUT` of the same marker would silently do nothing
 * visible — but creating "docs" when "docs" ALREADY EXISTS (as a marker, or just
 * because files live under `docs--`) must be a LOUD refusal: the owner asked for
 * a new folder and would get an existing one. The marker write happens only
 * after that check, and the check is a UX guard, not a concurrency guard (the
 * API offers no conditional write; a second client can still win the race).
 *
 * DELETE IS SEQUENTIAL AND HONEST. There is NO bulk-prefix delete route, and the
 * ONE route that deletes in bulk empties the WHOLE store — which this app must
 * never call (`AGENTS.md` §What this app is). So a folder delete is one
 * `DELETE` per object under the prefix, markers included, one at a time: the
 * service rate limits at 600 requests/minute/client and a parallel burst buys
 * nothing. The FIRST failure STOPS the run — no further request is issued — and
 * the outcome carries what was deleted and what is left, so the caller can say
 * exactly that instead of claiming a success that did not happen. A `429` is
 * just such a failure: it carries `Retry-After`, the message names the wait, and
 * nothing here retries.
 */

import { folderMarkerName, formatFolderPath, type FolderPath } from '@/lib/folder';
import { formatObjectCount } from '@/lib/format';
import { folderDisplayPath, objectsUnder } from '@/features/files/folders';
import { deleteObject, putObject, type ObjectEntry, type StoreTarget } from '@/server/store-client';

/** The first line of every marker's bytes: it names what the object is for. */
export const FOLDER_MARKER_BODY_PREFIX = 'FileStore empty-folder marker for ';

/**
 * The bytes a marker is written with. Not empty — the service refuses an empty
 * body, and the marker is the ONE case where the content is not the point. The
 * path is included so a human reading the raw object with `curl` can see which
 * folder it records.
 */
export function folderMarkerBytes(path: FolderPath): Uint8Array<ArrayBuffer> {
  const text = `${FOLDER_MARKER_BODY_PREFIX}${formatFolderPath(path)}\n`;
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

/**
 * Create the folder `path` by writing its marker object, refusing LOUDLY when it
 * already exists.
 *
 * THROWS:
 *  * `FolderPathError` from `folderMarkerName` when `path` is the root, has an
 *    illegal segment, or is too long to be a legal object name — the ONE
 *    validity rule, reused rather than restated;
 *  * a plain `Error` when ANY object already lives under the folder's prefix
 *    (its marker, or a file inside it), because creating it would be a lie about
 *    a new folder and the `PUT` would be a silent no-op.
 *
 * Returns the marker object name that was written.
 */
export async function createFolder(
  target: StoreTarget,
  parent: FolderPath,
  segment: string,
  existing: readonly ObjectEntry[],
): Promise<string> {
  const path: FolderPath = [...parent, segment];
  const markerName = folderMarkerName(path);
  const occupants = objectsUnder(existing, path);
  if (occupants.length > 0) {
    throw new Error(
      `Refusing to create the folder “${folderDisplayPath(path)}”: it already exists ` +
        `(${formatObjectCount(occupants.length)} already under it). Nothing was written.`,
    );
  }
  await putObject(target, markerName, folderMarkerBytes(path));
  return markerName;
}

/** What a sequential folder delete did, and where it stopped. */
export interface FolderDeleteOutcome {
  /** The object names that were actually removed, in the order they went. */
  deleted: string[];
  /** The names not removed: the one that failed plus every name after it. */
  remaining: string[];
  /** The first failure, or `null` when every object was deleted. */
  failure: unknown;
}

/**
 * Delete `names` one at a time, in order, and STOP at the first failure —
 * issuing no further request. The outcome always says what was deleted and what
 * remains, so "it worked" can never be claimed for a partial run.
 *
 * This never retries: a retried `DELETE` is not the double-upload hazard a
 * retried `PUT` is, but a `429` means the service is asking for a wait, and the
 * honest answer is to report it rather than to hammer.
 */
export async function deleteFolderObjects(
  target: StoreTarget,
  names: readonly string[],
): Promise<FolderDeleteOutcome> {
  const deleted: string[] = [];
  const remaining: string[] = [];
  let failure: unknown = null;
  let stopped = false;

  for (const name of names) {
    if (stopped) {
      remaining.push(name);
      continue;
    }
    try {
      await deleteObject(target, name);
      deleted.push(name);
    } catch (error: unknown) {
      failure = error;
      stopped = true;
      remaining.push(name);
    }
  }

  return { deleted, remaining, failure };
}
