/**
 * The upload flow (ledger rows 2 and 4; the chunked shape is ledger row 12 slice
 * B): pick files, REVIEW the name mapping, refuse what cannot be stored, and write
 * only what the owner has explicitly allowed.
 *
 * The order here is the point, and each step exists because of a rule:
 *
 *   1. `openFile` — the ONE open seam; a cancelled dialog returns and shows
 *      NOTHING (a cancel is not an error).
 *   2. `reviewUploads` — zero-byte files and unmappable names are refused HERE,
 *      with a reason, BEFORE any request is issued. Nothing is guessed.
 *   3. `listObjects` — ONE read, of the CURRENT FOLDER's subtree (`?prefix=`),
 *      to learn which of the reviewed object names already exist. A write has not
 *      happened yet. Because the mapping and the comparison are both on the FULL
 *      object name, the same file name in a DIFFERENT folder is not a collision.
 *      **A chunked file is claimed by its LOGICAL name**, which the listing does
 *      not carry — so the manifest-shaped objects are READ here and the chunk view
 *      (`src/features/files/chunks.ts`) supplies the names; an unreadable manifest
 *      supplies its heuristic name, which makes the confirmation happen rather
 *      than a silent clobber.
 *   4. the owner confirms each collision individually; `unconfirmedOverwrites` is
 *      the gate that then refuses the whole batch. This is ledger row 4: `PUT` is
 *      an unconditional overwrite, so an unconfirmed clobber is data loss.
 *   5. THE SHAPE IS DECIDED BY THE SIZE (`uploadShapeFor`): at or below the part
 *      size the row-9 single `putObject` runs, unchanged; above it the file is
 *      written as parts plus a manifest, with the manifest LAST, through
 *      `src/features/files/chunkUpload.ts`. Progress is reported PER PART, so a
 *      file that takes 33 requests shows where it is.
 *   6. an OVERWRITE of a chunked file uses a NEW GENERATION, and only after the
 *      manifest has been swapped is the OLD generation offered for removal —
 *      never removed on its own. A single-object overwrite of a chunked file
 *      offers the whole old representation the same way.
 *
 * A failure at any step is shown through the ONE error surface
 * (`src/lib/toast.ts`) and the batch stays in the panel so the owner can retry
 * rather than re-pick every file.
 */

import { useState } from 'react';

import {
  chunkManifestCandidates,
  buildChunkView,
  formatChunkPartCount,
  readChunkManifests,
  takenObjectNames,
  unreadManifestMessage,
  CHUNK_MANIFEST_TOAST_ID,
  type ChunkView,
} from '@/features/files/chunks';
import {
  uploadChunkedReview,
  uploadShapeFor,
  type ChunkUploadProgress,
} from '@/features/files/chunkUpload';
import { deleteObjectNames } from '@/features/files/folderOps';
import {
  collidingObjectNames,
  overwriteConfirmationLabel,
  reviewUploads,
  unconfirmedOverwrites,
  type UploadReview,
} from '@/features/files/upload';
import { CHUNK_PART_SIZE } from '@/lib/chunk';
import { folderPrefix, type FolderPath } from '@/lib/folder';
import { formatObjectCount } from '@/lib/format';
import { openFile, type OpenOutcome } from '@/lib/openFile';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  getObject,
  listObjects,
  putObject,
  type ObjectEntry,
  type StoreTarget,
} from '@/server/store-client';

export interface UploadPanelProps {
  target: StoreTarget;
  /** The folder being uploaded into; the root by default. */
  folder: FolderPath;
  /** Called after at least one object was written, so the listing can refresh. */
  onUploaded: () => void;
  /**
   * The part size an upload is planned with; defaults to the service's own cap.
   * It exists so the pins can drive the SAME chunked path with a few bytes — see
   * `FileBrowserProps.chunkPartSize`. Production never passes it.
   */
  chunkPartSize?: number;
}

/** One previous version that is still in the store, and what removing it takes. */
interface RetiredBatch {
  objectName: string;
  names: string[];
}

/** The ONE set of options this app opens files with. */
const OPEN_REQUEST = {
  description: 'Files to upload',
  extensions: [] as string[],
  mimeType: 'application/octet-stream',
  multiple: true,
};

export function UploadPanel({
  target,
  folder,
  onUploaded,
  chunkPartSize = CHUNK_PART_SIZE,
}: UploadPanelProps): React.JSX.Element {
  const [reviews, setReviews] = useState<UploadReview[]>([]);
  const [collisions, setCollisions] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<ObjectEntry[]>([]);
  const [chunkView, setChunkView] = useState<ChunkView | null>(null);
  const [progress, setProgress] = useState<ChunkUploadProgress | null>(null);
  const [retired, setRetired] = useState<RetiredBatch[]>([]);
  const [confirmingRetired, setConfirmingRetired] = useState(false);

  const retiredNames = [...new Set(retired.flatMap((batch) => batch.names))];

  function discard(): void {
    // The owner changing his mind about his own selection: no request, no toast.
    setReviews([]);
    setCollisions(new Set());
    setConfirmed(new Set());
    setChunkView(null);
    setListing([]);
    setRetired([]);
  }

  async function chooseFiles(): Promise<void> {
    let outcome: OpenOutcome;
    try {
      outcome = await openFile(OPEN_REQUEST);
    } catch (error: unknown) {
      // A real failure from the browser's file chooser keeps its own reason and
      // is SHOWN (rule 1/2): an unhandled rejection here would be a click that
      // silently did nothing.
      toastError(error, 'Could not open the file chooser');
      return;
    }
    if (outcome.status === 'cancelled') return;

    const { accepted, refused } = reviewUploads(outcome.files, folder);
    for (const refusal of refused) {
      // A refusal is an error the owner must see, and it names the file and the
      // reason (including an unmappable name and a folder with no room left). It
      // was decided BEFORE any request existed.
      toastError(new Error(refusal.message));
    }
    if (accepted.length === 0) return;

    try {
      // Only this folder's subtree can hold a collision: the comparison is on the
      // FULL object name, so a same-named file in another folder cannot appear
      // here at all.
      const prefix = folderPrefix(folder);
      const objects = await listObjects(target, prefix === '' ? undefined : prefix);
      // A chunked file is known by READING its manifest, never by its name (the
      // token can be spelled by an ordinary file inside a folder) — see
      // `docs/BOARD.md`'s trap.
      const read = await readChunkManifests(chunkManifestCandidates(objects), (name) =>
        getObject(target, name),
      );
      if (read.unread.length > 0) {
        toastError(
          new Error(unreadManifestMessage(read.unread)),
          'Could not read every object that looks like a chunk manifest',
          { id: CHUNK_MANIFEST_TOAST_ID },
        );
      }
      const view = buildChunkView(objects, read.documents, read.unread);
      setChunkView(view);
      setListing(objects);
      setReviews(accepted);
      setCollisions(new Set(collidingObjectNames(accepted, takenObjectNames(objects, view))));
      setConfirmed(new Set());
      setRetired([]);
    } catch (error: unknown) {
      toastError(error, 'Could not check which objects already exist');
    }
  }

  function toggleConfirmed(objectName: string): void {
    setConfirmed((current) => {
      const next = new Set(current);
      if (next.has(objectName)) next.delete(objectName);
      else next.add(objectName);
      return next;
    });
  }

  function chunkedRowFor(objectName: string): ChunkView['rows'][number] | null {
    return chunkView?.byObjectName.get(objectName) ?? null;
  }

  async function upload(): Promise<void> {
    const blocked = unconfirmedOverwrites(reviews, collisions, confirmed);
    if (blocked.length > 0) {
      const named = blocked.map((review) => `“${review.objectName}”`).join(', ');
      toastError(
        new Error(
          `Refusing to overwrite the existing object ${named} until you confirm each one. ` +
            `Nothing was uploaded.`,
        ),
      );
      return;
    }

    setBusy(true);
    setRetired([]);
    const written: string[] = [];
    const retiredNow: RetiredBatch[] = [];
    try {
      for (const review of reviews) {
        const chunked = chunkedRowFor(review.objectName);
        const plainExists = listing.some((entry) => entry.name === review.objectName);
        try {
          if (uploadShapeFor(review.bytes.length, chunkPartSize) === 'single') {
            // The row-9 path, UNCHANGED: one request, and the shape decision is
            // the only thing between it and the chunked branch.
            await putObject(target, review.objectName, review.bytes);
            // A chunked file that this single object replaces is offered for
            // removal — its manifest and its parts are still there.
            if (chunked !== null) {
              retiredNow.push({ objectName: review.objectName, names: chunked.objectNames });
            }
          } else {
            await uploadChunkedReview(target, review, {
              partSize: chunkPartSize,
              previousGeneration: chunked?.manifest.generation ?? null,
              onProgress: setProgress,
            });
            // The manifest name is the SAME object in the new generation, so it is
            // overwritten, not retired: only the OLD GENERATION'S PARTS go — and
            // only after the manifest has been swapped (the write above did that).
            const oldNames: string[] = [];
            if (chunked !== null) {
              for (const part of chunked.manifest.parts) oldNames.push(part.name);
            }
            if (plainExists) oldNames.push(review.objectName);
            if (oldNames.length > 0) {
              retiredNow.push({ objectName: review.objectName, names: oldNames });
            }
          }
          written.push(review.objectName);
        } catch (error: unknown) {
          toastError(error, `Could not upload ${review.fileName}`);
        }
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }

    if (written.length === 0) return;
    setReviews((current) => current.filter((review) => !written.includes(review.objectName)));
    setConfirmed(new Set());
    if (retiredNow.length > 0) setRetired(retiredNow);
    onUploaded();
    toastSuccess(`Uploaded ${formatObjectCount(written.length)}.`);
  }

  async function removeRetired(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await deleteObjectNames(target, retiredNames);
      setRetired([]);
      setConfirmingRetired(false);
      onUploaded();
      if (outcome.failure === null) {
        toastSuccess(
          `Removed ${formatObjectCount(outcome.deleted.length)} from the previous version.`,
        );
        return;
      }
      toastError(
        outcome.failure,
        `Removed ${formatObjectCount(outcome.deleted.length)} of the ` +
          `${formatObjectCount(retiredNames.length)} from the previous version; ` +
          `${formatObjectCount(outcome.remaining.length)} remain`,
      );
    } catch (error: unknown) {
      toastError(error, 'Could not remove the previous version');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-edge bg-surface-raised p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-surface"
          onClick={() => {
            void chooseFiles();
          }}
          disabled={busy}
        >
          Choose files…
        </button>
      </div>

      {reviews.length > 0 && (
        <div className="mt-4">
          <p className="text-sm text-ink-muted">
            {formatObjectCount(reviews.length)} ready to upload. Each one will be stored under the
            name shown.
          </p>
          <ul className="mt-2 space-y-2">
            {reviews.map((review) => {
              const chunked = chunkedRowFor(review.objectName);
              return (
                <li key={review.objectName} className="text-sm">
                  <span className="break-all">{review.fileName}</span>
                  <span aria-hidden="true"> → </span>
                  <code className="break-all text-ink">{review.objectName}</code>
                  {review.renamed ? (
                    <span className="text-ink-muted"> (renamed to a ServerStore-legal name)</span>
                  ) : null}
                  {chunked !== null ? (
                    <span className="text-ink-muted">
                      {' '}
                      (already stored as a chunked file:{' '}
                      {formatChunkPartCount(chunked.manifest.parts.length)} and a manifest)
                    </span>
                  ) : null}
                  {collisions.has(review.objectName) ? (
                    <label className="mt-1 flex items-start gap-2 text-danger">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={confirmed.has(review.objectName)}
                        onChange={() => {
                          toggleConfirmed(review.objectName);
                        }}
                      />
                      <span>
                        {overwriteConfirmationLabel(review)} — this object already exists and its
                        bytes will be replaced.
                      </span>
                    </label>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-surface"
              onClick={() => {
                void upload();
              }}
              disabled={busy}
            >
              Upload {formatObjectCount(reviews.length)}
            </button>
            <button
              type="button"
              className="rounded border border-edge px-3 py-1.5 text-sm"
              onClick={discard}
              disabled={busy}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {progress !== null && (
        <div
          role="progressbar"
          aria-label={`Uploading ${progress.fileName}`}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
          className="mt-3 text-sm text-ink-muted"
        >
          Uploading {progress.fileName} as {progress.objectName}: {progress.completed} of{' '}
          {progress.total} parts written ({progress.partName}).
        </div>
      )}

      {retired.length > 0 && (
        <div className="mt-4 rounded border border-danger/40 p-3 text-sm">
          <p>
            {formatObjectCount(retiredNames.length)} from the previous version{' '}
            {retired.length === 1 ? 'is' : 'are'} still in the store (
            {retired.map((batch) => batch.objectName).join(', ')}). Nothing was deleted.
          </p>
          {confirmingRetired ? (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded border border-danger px-3 py-1.5 text-sm text-danger"
                onClick={() => {
                  void removeRetired();
                }}
                disabled={busy}
              >
                Yes, remove {formatObjectCount(retiredNames.length)}
              </button>
              <button
                type="button"
                className="rounded border border-edge px-3 py-1.5 text-sm"
                onClick={() => {
                  setConfirmingRetired(false);
                }}
                disabled={busy}
              >
                Keep them
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="mt-2 rounded border border-edge px-3 py-1.5 text-sm"
              onClick={() => {
                setConfirmingRetired(true);
              }}
              disabled={busy}
            >
              Remove the previous version ({formatObjectCount(retiredNames.length)})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
