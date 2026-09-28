/**
 * The store browser (ledger rows 9 and 10 slice 2; the chunked-file row is ledger
 * row 12 slice B): the folder tree, the listing, the download flow and the delete
 * flow, plus the upload panel.
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
 * A CHUNKED FILE IS ONE ROW, AND ONLY CONTENT SAYS SO. The listing is passed
 * through the chunk view (`src/features/files/chunks.ts`) before it reaches
 * `describeFolder`: every readable manifest is replaced by a synthetic entry for
 * the LOGICAL object (its TOTAL size, the manifest's `createdAt` and digest), the
 * parts are hidden, and a manifest-shaped object whose bytes do not parse stays
 * exactly where it was — a normal file. The lookup the actions use is
 * `view.byObjectName`, so Download and Delete address the chunked file as a whole
 * while the row still shows one file. Everything that needs attention (an
 * incomplete manifest, an unreadable one, an orphaned part) is REPORTED by
 * `src/features/files/ChunkPanel.tsx` — never acted on here.
 *
 * WHAT IS SHOWN IS ONLY WHAT IS STORED. A row is `name`, `sha256`, `size`,
 * `createdAt` — the four facts ServerStore holds and the only four it can hold
 * (ledger row 2). A file's row shows its name WITHIN this folder (that is the
 * readable part) while every ACTION — download, delete — uses the FULL object
 * name, which is what the store addresses. The digest is shown truncated FOR
 * DISPLAY with the full value in the element's `title`; nothing presents the
 * object name as an original file name, because the original name was never
 * stored. A chunked file has no whole-file digest (WebCrypto has no incremental
 * digest — ledger row 12), so its digest cell shows the digest of the manifest
 * object that describes it, and says so in its `title`.
 *
 * DOWNLOAD goes through the ONE save seam: `downloadObject` for a single object,
 * `downloadChunkedObject` for a chunked file, which verifies the manifest against
 * the listing and EVERY part against the service's own digest before it is
 * written, and streams them so the whole file is never in memory. A cancelled
 * dialog is an OUTCOME: the flow returns and shows NOTHING.
 *
 * DELETE asks first, in the row, and names what it will destroy: the API has no
 * undo and no version (ledger row 4's spirit, and row 9's decision). A chunked
 * file's confirmation names the COUNT of objects that will go — its manifest and
 * every part — because that is what the destructive act removes; the delete
 * itself is the ONE sequential delete (`src/features/files/folderOps.ts`), which
 * stops at the first failure and says what remains. A cancelled confirmation
 * issues NO request and shows nothing. Deleting a FOLDER is the panel's job
 * (`src/features/files/FolderPanel.tsx`), because it is N requests and its
 * confirmation names the count.
 *
 * NAVIGATION DISCARDS A PENDING UPLOAD REVIEW: the review's object names were
 * computed for the folder that was open, so the panel is keyed by the folder and
 * remounts when the owner moves. Its own choice, made visible, rather than
 * carrying names about a folder the owner has left.
 */

import { useState } from 'react';

import { FolderBreadcrumb } from '@/features/files/FolderBreadcrumb';
import { FolderPanel } from '@/features/files/FolderPanel';
import { ChunkPanel } from '@/features/files/ChunkPanel';
import { UploadPanel } from '@/features/files/UploadPanel';
import { downloadChunkedObject, type ChunkDownloadProgress } from '@/features/files/chunkDownload';
import { buildChunkView, formatChunkPartCount, visibleChunkEntries } from '@/features/files/chunks';
import { downloadObject } from '@/features/files/download';
import { deleteObjectNames } from '@/features/files/folderOps';
import { describeFolder } from '@/features/files/folders';
import { useChunkManifests } from '@/features/files/useChunkManifests';
import { listingErrorMessage, useObjects } from '@/features/files/useObjects';
import { CHUNK_PART_SIZE } from '@/lib/chunk';
import { formatObjectCount, formatByteSize, formatTimestamp, shortSha256 } from '@/lib/format';
import type { FolderPath } from '@/lib/folder';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  deleteObject,
  type ObjectEntry,
  type StoreTarget,
  type WhoAmI,
} from '@/server/store-client';

export interface FileBrowserProps {
  target: StoreTarget;
  /** What `whoami` said about the key, shown so the owner knows its scope. */
  who: WhoAmI;
  /**
   * The part size an upload is planned with; defaults to the service's own cap
   * (`src/lib/chunk.ts#CHUNK_PART_SIZE`). It exists so the pins can drive the
   * SAME chunked path with a few bytes — `planChunks` hard-codes the cap, and no
   * test may build a real 64 MiB buffer. Production never passes it.
   */
  chunkPartSize?: number;
}

export function FileBrowser({
  target,
  who,
  chunkPartSize = CHUNK_PART_SIZE,
}: FileBrowserProps): React.JSX.Element {
  const [folder, setFolder] = useState<FolderPath>([]);
  const { state, refresh } = useObjects(target, folder);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ChunkDownloadProgress | null>(null);

  const objects = state.status === 'ready' ? state.objects : [];
  const manifests = useChunkManifests(target, objects);
  const chunkView = buildChunkView(
    objects,
    manifests.documents,
    manifests.unread,
    manifests.loading,
  );
  const view = describeFolder(visibleChunkEntries(objects, chunkView), folder, objects);

  function navigate(next: FolderPath): void {
    setFolder(next);
    // A file confirmation belongs to the level it was opened at.
    setConfirmingDelete(null);
  }

  async function download(entry: ObjectEntry): Promise<void> {
    const chunked = chunkView.byObjectName.get(entry.name);
    try {
      const outcome =
        chunked === undefined
          ? await downloadObject(target, entry.name)
          : await downloadChunkedObject(target, chunked, { onProgress: setDownloadProgress });
      // A cancelled save is the owner changing his mind: no toast, no error.
      if (outcome.status === 'cancelled') return;
      toastSuccess(`${entry.name} was saved.`);
    } catch (error: unknown) {
      toastError(error, `Could not download ${entry.name}`);
    } finally {
      setDownloadProgress(null);
    }
  }

  async function remove(entry: ObjectEntry): Promise<void> {
    const chunked = chunkView.byObjectName.get(entry.name);
    try {
      if (chunked === undefined) {
        // The row-9 path, unchanged: ONE object, one request.
        await deleteObject(target, entry.name);
      } else {
        // The manifest first, then every part — the ONE sequential delete, which
        // stops at the first failure and reports what remains.
        const outcome = await deleteObjectNames(target, chunked.objectNames);
        setConfirmingDelete(null);
        refresh();
        if (outcome.failure !== null) {
          toastError(
            outcome.failure,
            `Deleted ${formatObjectCount(outcome.deleted.length)} of the ` +
              `${formatObjectCount(chunked.objectNames.length)} objects of ${entry.name}; ` +
              `${formatObjectCount(outcome.remaining.length)} remain and the file is not fully deleted`,
          );
          return;
        }
        toastSuccess(`${entry.name} was deleted (${formatObjectCount(outcome.deleted.length)}).`);
        return;
      }
      setConfirmingDelete(null);
      toastSuccess(`${entry.name} was deleted.`);
      refresh();
    } catch (error: unknown) {
      toastError(error, `Could not delete ${entry.name}`);
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
            className="rounded border border-edge px-3 py-1.5 text-sm"
            onClick={() => {
              refresh();
            }}
          >
            Refresh
          </button>
        </div>
        <p className="text-sm text-ink-muted">
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
        chunkPartSize={chunkPartSize}
        onUploaded={() => {
          refresh();
        }}
      />

      <ChunkPanel view={chunkView} />

      {state.status === 'loading' && <p className="text-sm text-ink-muted">Loading the store…</p>}

      {state.status === 'failed' && (
        <div role="alert" className="rounded border border-danger p-3 text-sm text-danger">
          <p>{listingErrorMessage(state.error)}</p>
          <button
            type="button"
            className="mt-2 rounded border border-edge px-3 py-1 text-sm"
            onClick={() => {
              refresh();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && view.files.length === 0 && view.subfolders.length === 0 && (
        <p className="text-sm text-ink-muted">
          {folder.length === 0
            ? chunkView.orphans.length > 0 || chunkView.reports.length > 0
              ? 'Nothing here is a complete file — see the chunk report above.'
              : 'The store is empty. Upload a file to put the first object in it.'
            : 'This folder is empty.'}
        </p>
      )}

      {downloadProgress !== null && (
        <div
          role="progressbar"
          aria-label={`Downloading ${downloadProgress.objectName}`}
          aria-valuemin={0}
          aria-valuemax={downloadProgress.total}
          aria-valuenow={downloadProgress.completed}
          className="text-sm text-ink-muted"
        >
          Downloading {downloadProgress.objectName}: {downloadProgress.completed} of{' '}
          {downloadProgress.total} parts verified and written.
        </div>
      )}

      {state.status === 'ready' && view.files.length > 0 && (
        <div>
          <p className="text-sm text-ink-muted">
            {formatObjectCount(view.files.length)} in this folder
          </p>
          <table className="mt-2 w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-edge">
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
              {view.files.map(({ entry, filePart }) => {
                const chunked = chunkView.byObjectName.get(entry.name);
                return (
                  <tr
                    key={chunked === undefined ? entry.name : `${entry.name}\u0000manifest`}
                    className="border-b border-edge align-top"
                  >
                    <td className="py-2 pr-3">
                      <code className="break-all" title={entry.name}>
                        {filePart}
                      </code>
                      {chunked !== undefined && (
                        <span className="block text-ink-muted">
                          stored as {formatChunkPartCount(chunked.manifest.parts.length)} and a
                          manifest
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatByteSize(entry.size)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {formatTimestamp(entry.createdAt)}
                    </td>
                    <td className="py-2 pr-3">
                      <code
                        title={
                          chunked === undefined
                            ? entry.sha256
                            : `${entry.sha256} — the digest of the chunk manifest; the store holds no whole-file digest`
                        }
                      >
                        {shortSha256(entry.sha256)}
                      </code>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="rounded border border-edge px-2 py-1"
                          onClick={() => {
                            void download(entry);
                          }}
                        >
                          Download
                        </button>
                        {confirmingDelete === entry.name ? (
                          <>
                            <span className="text-danger">
                              {chunked === undefined ? (
                                <>Delete {entry.name}? There is no undo.</>
                              ) : (
                                <>
                                  Delete {entry.name}? It is stored as{' '}
                                  {formatObjectCount(chunked.objectNames.length)} (its manifest and{' '}
                                  {formatChunkPartCount(chunked.objectNames.length - 1)}), and every
                                  one of them will be deleted. There is no undo.
                                </>
                              )}
                            </span>
                            <button
                              type="button"
                              className="rounded border border-danger px-2 py-1 text-danger"
                              onClick={() => {
                                void remove(entry);
                              }}
                            >
                              Yes, delete {entry.name}
                            </button>
                            <button
                              type="button"
                              className="rounded border border-edge px-2 py-1"
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
                            className="rounded border border-edge px-2 py-1"
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
