/**
 * Retrieval (ledger row 9): fetch an object, PROVE it is the object the service
 * says it is, and only then hand it to the save seam.
 *
 * ServerStore answers a read with the exact bytes and its own
 * `x-serverstore-sha256` (`~/projects/ServerStore/docs/API.md`). The client seam
 * (`src/server/store-client.ts#getObject`) refuses a response whose digest header
 * is missing or malformed, and refuses zero bytes — but it cannot know whether the
 * bytes that arrived are the bytes that header describes: a truncated or mangled
 * body with an intact header is exactly the case a store must not save silently.
 * So this module hashes what it received with the ONE digest seam and refuses on a
 * mismatch, with BOTH digests named. The refusal is a `ServerStoreError`
 * (`invalid-response`) so it travels the app's error surface like every other
 * store failure.
 *
 * WHY THE CHECK IS IN `buildBytes` AND NOT BEFORE `saveFile`: `showSaveFilePicker`
 * requires transient user activation and must be called in the click handler's own
 * task, BEFORE a fetch of up to 64 MiB and its hash (`src/lib/saveFile.ts`'s
 * header). Passing the verification as the `buildBytes` callback keeps both
 * properties: the picker runs first, and a verification failure throws BEFORE the
 * seam ever calls `createWritable`, so **unverified bytes are never written**.
 *
 * THE SAVED FILE'S NAME AND TYPE: the object name, and
 * `application/octet-stream`. There is no metadata in the store (ledger row 2), so
 * the original file name and a real MIME type do not exist to be restored, and
 * presenting either would be inventing data.
 */

import { saveFile, type SaveOutcome } from '@/lib/saveFile';
import { sha256Hex } from '@/lib/sha256';
import { getObject, type StoreTarget } from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';

/** The only content type the store has: it stores a name and bytes. */
export const OBJECT_MIME_TYPE = 'application/octet-stream';

/**
 * The object's bytes, verified against the service's own digest.
 *
 * THROWS `invalid-response` when the two disagree. Nothing is written.
 */
export async function verifiedObjectBytes(
  target: StoreTarget,
  name: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const object = await getObject(target, name);
  const received = await sha256Hex(object.bytes);
  if (received !== object.sha256) {
    throw new ServerStoreError(
      'invalid-response',
      `Refusing to save ${name}: the bytes that arrived hash to ${received}, but ` +
        `ServerStore's x-serverstore-sha256 says ${object.sha256}. Nothing was written to disk.`,
    );
  }
  return object.bytes;
}

/**
 * Put an object on the owner's disk through the ONE save seam — the file-location
 * dialog where the browser has it, a plain download otherwise. A cancelled dialog
 * comes back as `{status:'cancelled'}` and must be treated as an OUTCOME: the
 * caller shows nothing for it.
 *
 * THROWS on a real failure (including the verification refusal above).
 */
export async function downloadObject(target: StoreTarget, name: string): Promise<SaveOutcome> {
  return saveFile({
    fileName: name,
    mimeType: OBJECT_MIME_TYPE,
    buildBytes: () => verifiedObjectBytes(target, name),
  });
}
