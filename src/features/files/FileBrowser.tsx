/**
 * The store browser (ledger rows 9 and 10 slice 2): the folder tree, the
 * listing, the download flow and the delete flow, plus the upload panel.
 *
 * THE FOLDER IS REACT STATE, NEVER A URL. The app is served as static files with
 * no SPA history fallback, so a client-side route 404s on refresh; the folder
 * being viewed therefore lives in `useState` as a `FolderPath` (`[]` is the
 * root), and every folder operation routes that path through
 * `src/lib/folder.ts`. Nothing here splits on `--` or joins a name inline.
 *
 * ONE LISTING, TWO LEVELS. `useObjects(target, folder)` asks the service for the
 * current folder's subtree (`?prefix=`), and
 * `src/features/files/folders.ts#describeFolder` turns that ONE answer into the
 * files at this level AND the subfolders below it. An object deeper than this
 * level is never rendered as a file; a marker is never a file; a marker-only
 * folder still shows because the marker is what records it.
 *
 * WHAT IS SHOWN IS ONLY WHAT IS STORED. A row is `name`, `sha256`, `size`,
 * `createdAt` — the four facts ServerStore holds and the only four it can hold
 * (ledger row 2). A file's row shows its name WITHIN this folder (that is the
 * readable part) while every ACTION — download, delete — uses the FULL object
 * name, which is what the store addresses. The digest is shown truncated FOR
 * DISPLAY with the full value in the element's `title`; nothing presents the
 * object name as an original file name, because the original name was never
 * stored.
 *
 * DOWNLOAD goes through the ONE save seam (`src/features/files/download.ts`) and
 * therefore through the browser's file-location dialog where it exists. A
 * cancelled dialog is an OUTCOME: the flow returns and shows NOTHING.
 *
 * DELETE asks first, in the row, and names what it will destroy: the API has no
 * undo and no version (ledger row 4's spirit, and row 9's decision). A cancelled
 * confirmation issues NO request and shows nothing. Deleting a FOLDER is the
 * panel's job (`src/features/files/FolderPanel.tsx`), because it is N requests
 * and its confirmation names the count.
 *
 * NAVIGATION DISCARDS A PENDING UPLOAD REVIEW: the review's object names were
 * computed for the folder that was open, so the panel is keyed by the folder and
 * remounts when the owner moves. Its own choice, made visible, rather than
 * carrying names about a folder the owner has left.
 */

import { useState } from 'react';

import { FolderBreadcrumb } from '@/features/files/FolderBreadcrumb';
import { FolderPanel } from '@/features/files/FolderPanel';
import { UploadPanel } from '@/features/files/UploadPanel';
import { downloadObject } from '@/features/files/download';
import { describeFolder } from '@/features/files/folders';
import { listingErrorMessage, useObjects } from '@/features/files/useObjects';
import { formatObjectCount, formatByteSize, formatTimestamp, shortSha256 } from '@/lib/format';
import type { FolderPath } from '@/lib/folder';
import { toastError, toastSuccess } from '@/lib/toast';
import { deleteObject, type StoreTarget, type WhoAmI } from '@/server/store-client';

export interface FileBrowserProps {
  target: StoreTarget;
  /** What `whoami` said about the key, shown so the owner knows its scope. */
  who: WhoAmI;
}

export function FileBrowser({ target, who }: FileBrowserProps): React.JSX.Element {
  const [folder, setFolder] = useState<FolderPath>([]);
  const { state, refresh } = useObjects(target, folder);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const objects = state.status === 'ready' ? state.objects : [];
  const view = describeFolder(objects, folder);

  function navigate(next: FolderPath): void {
    setFolder(next);
    // A file confirmation belongs to the level it was opened at.
    setConfirmingDelete(null);
  }

  async function download(name: string): Promise<void> {
    try {
      const outcome = await downloadObject(target, name);
      // A cancelled save is the owner changing his mind: no toast, no error.
      if (outcome.status === 'cancelled') return;
      toastSuccess(`${name} was saved.`);
    } catch (error: unknown) {
      toastError(error, `Could not download ${name}`);
    }
  }

  async function remove(name: string): Promise<void> {
    try {
      await deleteObject(target, name);
      setConfirmingDelete(null);
      toastSuccess(`${name} was deleted.`);
      refresh();
    } catch (error: unknown) {
      toastError(error, `Could not delete ${name}`);
    }
  }

  return (
    <section aria-labelledby="files-heading" className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="files-heading" className="text-lg font-medium">
            Files in <code>{target.store}</code>
          </h2>
          <button
            type="button"
            className="border-edge rounded border px-3 py-1.5 text-sm"
            onClick={() => {
              refresh();
            }}
          >
            Refresh
          </button>
        </div>
        <p className="text-ink-muted text-sm">
          Key “{who.label}” — stores: {who.stores.length === 0 ? '(none)' : who.stores.join(', ')} —
          permissions: {who.perms.length === 0 ? '(none)' : who.perms.join(', ')}.
        </p>
      </div>

      <FolderBreadcrumb store={target.store} current={folder} onNavigate={navigate} />

      {state.status === 'ready' && (
        <FolderPanel
          target={target}
          current={folder}
          subfolders={view.subfolders}
          objects={objects}
          onNavigate={navigate}
          onChanged={refresh}
        />
      )}

      <UploadPanel
        key={folder.join('/')}
        target={target}
        folder={folder}
        onUploaded={() => {
          refresh();
        }}
      />

      {state.status === 'loading' && <p className="text-ink-muted text-sm">Loading the store…</p>}

      {state.status === 'failed' && (
        <div role="alert" className="border-danger text-danger rounded border p-3 text-sm">
          <p>{listingErrorMessage(state.error)}</p>
          <button
            type="button"
            className="border-edge mt-2 rounded border px-3 py-1 text-sm"
            onClick={() => {
              refresh();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && view.files.length === 0 && view.subfolders.length === 0 && (
        <p className="text-ink-muted text-sm">
          {folder.length === 0
            ? 'The store is empty. Upload a file to put the first object in it.'
            : 'This folder is empty.'}
        </p>
      )}

      {state.status === 'ready' && view.files.length > 0 && (
        <div>
          <p className="text-ink-muted text-sm">
            {formatObjectCount(view.files.length)} in this folder
          </p>
          <table className="mt-2 w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-edge border-b">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Object name
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Size
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Created
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  SHA-256
                </th>
                <th scope="col" className="py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {view.files.map(({ entry, filePart }) => (
                <tr key={entry.name} className="border-edge border-b align-top">
                  <td className="py-2 pr-3">
                    <code className="break-all" title={entry.name}>
                      {filePart}
                    </code>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatByteSize(entry.size)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatTimestamp(entry.createdAt)}</td>
                  <td className="py-2 pr-3">
                    <code title={entry.sha256}>{shortSha256(entry.sha256)}</code>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="border-edge rounded border px-2 py-1"
                        onClick={() => {
                          void download(entry.name);
                        }}
                      >
                        Download
                      </button>
                      {confirmingDelete === entry.name ? (
                        <>
                          <span className="text-danger">Delete {entry.name}? There is no undo.</span>
                          <button
                            type="button"
                            className="border-danger text-danger rounded border px-2 py-1"
                            onClick={() => {
                              void remove(entry.name);
                            }}
                          >
                            Yes, delete {entry.name}
                          </button>
                          <button
                            type="button"
                            className="border-edge rounded border px-2 py-1"
                            onClick={() => {
                              setConfirmingDelete(null);
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="border-edge rounded border px-2 py-1"
                          onClick={() => {
                            setConfirmingDelete(entry.name);
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
