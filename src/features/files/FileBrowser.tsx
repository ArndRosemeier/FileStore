/**
 * The store browser (ledger row 9): the listing, the download flow and the delete
 * flow, plus the upload panel.
 *
 * WHAT IS SHOWN IS ONLY WHAT IS STORED. A row is `name`, `sha256`, `size`,
 * `createdAt` — the four facts ServerStore holds and the only four it can hold
 * (ledger row 2). The digest is shown truncated FOR DISPLAY with the full value in
 * the element's `title`; nothing presents the object name as an original file
 * name, because the original name was never stored.
 *
 * DOWNLOAD goes through the ONE save seam (`src/features/files/download.ts`) and
 * therefore through the browser's file-location dialog where it exists. A cancelled
 * dialog is an OUTCOME: the flow returns and shows NOTHING.
 *
 * DELETE asks first, in the row, and names the object it will destroy: the API has
 * no undo and no version (ledger row 4's spirit, and row 9's decision). A
 * cancelled confirmation issues NO request and shows nothing.
 */

import { useState } from 'react';

import { downloadObject } from '@/features/files/download';
import { UploadPanel } from '@/features/files/UploadPanel';
import { listingErrorMessage, useObjects } from '@/features/files/useObjects';
import { formatByteSize, formatObjectCount, formatTimestamp, shortSha256 } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import { deleteObject, type StoreTarget, type WhoAmI } from '@/server/store-client';

export interface FileBrowserProps {
  target: StoreTarget;
  /** What `whoami` said about the key, shown so the owner knows its scope. */
  who: WhoAmI;
}

export function FileBrowser({ target, who }: FileBrowserProps): React.JSX.Element {
  const { state, refresh } = useObjects(target);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

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

      <UploadPanel
        target={target}
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

      {state.status === 'ready' && state.objects.length === 0 && (
        <p className="text-ink-muted text-sm">
          The store is empty. Upload a file to put the first object in it.
        </p>
      )}

      {state.status === 'ready' && state.objects.length > 0 && (
        <div>
          <p className="text-ink-muted text-sm">{formatObjectCount(state.objects.length)} in the store</p>
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
              {state.objects.map((entry) => (
                <tr key={entry.name} className="border-edge border-b align-top">
                  <td className="py-2 pr-3">
                    <code className="break-all">{entry.name}</code>
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
