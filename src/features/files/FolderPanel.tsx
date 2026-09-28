/**
 * The folder rows and the "New folder" control (ledger row 10, slice 2).
 *
 * EVERY ROW IS DERIVED, NEVER FETCHED. The subfolders and their counts come from
 * `src/features/files/folders.ts#describeFolder` over the ONE listing the browser
 * already holds, so a row's number is the same objects the row's folder would
 * show if the owner walked into it. Nothing here reads the store on its own
 * except the two writes below.
 *
 * A FOLDER NAME IS A STORE SEGMENT. The typed name goes straight to
 * `createFolder`, which routes it through `folderMarkerName` — the ONE validity
 * rule (`src/lib/folder.ts`). A name with a space, a capital letter, `--`, or a
 * trailing `-` is therefore a LOUD refusal naming the segment, never a silently
 * mapped different folder; the hint under the field says which characters are
 * legal so the refusal is rare rather than mysterious.
 *
 * A DELETE NAMES THE FOLDER AND THE COUNT. The row already shows how many
 * objects are inside; the confirmation names the number of objects that will
 * actually go, markers included, because that is the destructive act being
 * authorised. It then runs one `DELETE` at a time (`deleteFolderObjects`) and
 * the toast says what was deleted and what REMAINS when it stops early — a
 * partial delete is never reported as a success.
 */

import { useState } from 'react';

import { createFolder, deleteFolderObjects } from '@/features/files/folderOps';
import {
  formatFolderCount,
  folderDisplayPath,
  objectNamesUnder,
  type FolderRow,
} from '@/features/files/folders';
import type { FolderPath } from '@/lib/folder';
import { formatObjectCount } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import type { ObjectEntry, StoreTarget } from '@/server/store-client';

export interface FolderPanelProps {
  target: StoreTarget;
  /** The folder being viewed: where a new folder is created. */
  current: FolderPath;
  subfolders: readonly FolderRow[];
  /** The one listing the browser holds — what existence and deletion are read from. */
  objects: readonly ObjectEntry[];
  onNavigate: (path: FolderPath) => void;
  /** Called after a write, so the browser re-reads the listing. */
  onChanged: () => void;
}

/** What a row says it holds: `3 objects, 1 folder`, or `empty`. */
function contentsLabel(row: FolderRow): string {
  if (row.objectCount === 0 && row.folderCount === 0) return 'empty';
  const parts = [formatObjectCount(row.objectCount)];
  if (row.folderCount > 0) parts.push(formatFolderCount(row.folderCount));
  return parts.join(', ');
}

export function FolderPanel({
  target,
  current,
  subfolders,
  objects,
  onNavigate,
  onChanged,
}: FolderPanelProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function create(): Promise<void> {
    // An empty field is the owner's own incomplete input, not a store question;
    // it gets its own sentence rather than the segment validator's.
    const segment = name.trim();
    if (segment === '') {
      toastError(new Error('Type a folder name before creating one.'));
      return;
    }
    setBusy(true);
    try {
      const markerName = await createFolder(target, current, segment, objects);
      setName('');
      toastSuccess(
        `Created the folder “${folderDisplayPath([...current, segment])}” (${markerName}).`,
      );
      onChanged();
    } catch (error: unknown) {
      toastError(error, 'Could not create the folder');
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: FolderRow): Promise<void> {
    setBusy(true);
    try {
      const names = objectNamesUnder(objects, row.path);
      const outcome = await deleteFolderObjects(target, names);
      setConfirming(null);
      // The store changed either way, so the listing is re-read: what the owner
      // sees next must match what is actually there.
      onChanged();
      if (outcome.failure === null) {
        toastSuccess(
          `Deleted the folder “${folderDisplayPath(row.path)}” and ` +
            `${formatObjectCount(outcome.deleted.length)} under it.`,
        );
        return;
      }
      toastError(
        outcome.failure,
        `Deleted ${formatObjectCount(outcome.deleted.length)} under ` +
          `“${folderDisplayPath(row.path)}”; ${formatObjectCount(outcome.remaining.length)} ` +
          `remain and the folder still exists`,
      );
    } catch (error: unknown) {
      toastError(error, `Could not delete the folder “${folderDisplayPath(row.path)}”`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-edge bg-surface-raised flex flex-col gap-4 rounded-lg border p-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span>New folder name</span>
          <input
            type="text"
            className="border-edge rounded border px-2 py-1"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            disabled={busy}
          />
        </label>
        <button
          type="submit"
          className="bg-accent text-surface rounded px-3 py-1.5 text-sm font-medium"
          disabled={busy}
        >
          New folder
        </button>
        <p className="text-ink-muted text-xs">
          Lowercase letters, digits, dot, underscore and dash — no two dashes in a row, and it cannot
          end in a dash.
        </p>
      </form>

      {subfolders.length > 0 && (
        <table className="w-full border-collapse text-left text-sm">
          <caption className="text-ink-muted sr-only">Folders in this folder</caption>
          <thead>
            <tr className="border-edge border-b">
              <th scope="col" className="py-2 pr-3 font-medium">
                Folder
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Contents
              </th>
              <th scope="col" className="py-2 font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {subfolders.map((row) => {
              const display = folderDisplayPath(row.path);
              const key = row.path.join('/');
              return (
                <tr key={key} className="border-edge border-b align-top">
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      className="border-edge rounded border px-2 py-1"
                      onClick={() => {
                        onNavigate(row.path);
                      }}
                    >
                      {row.segment}
                    </button>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{contentsLabel(row)}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {confirming === key ? (
                        <>
                          <span className="text-danger">
                            Delete the folder “{display}”? {formatObjectCount(row.deleteCount)} will
                            be deleted (the folder’s own marker included). There is no undo.
                          </span>
                          <button
                            type="button"
                            className="border-danger text-danger rounded border px-2 py-1"
                            onClick={() => {
                              void remove(row);
                            }}
                            disabled={busy}
                          >
                            Yes, delete folder {display}
                          </button>
                          <button
                            type="button"
                            className="border-edge rounded border px-2 py-1"
                            onClick={() => {
                              setConfirming(null);
                            }}
                            disabled={busy}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="border-edge rounded border px-2 py-1"
                          onClick={() => {
                            setConfirming(key);
                          }}
                          disabled={busy}
                        >
                          Delete folder {display}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
