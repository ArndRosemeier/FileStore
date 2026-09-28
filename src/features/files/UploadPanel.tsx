/**
 * The upload flow (ledger rows 2 and 4; the brief's pins): pick files, REVIEW the
 * name mapping, refuse what cannot be stored, and write only what the owner has
 * explicitly allowed.
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
 *   4. the owner confirms each collision individually; `unconfirmedOverwrites` is
 *      the gate that then refuses the whole batch. This is ledger row 4: `PUT` is
 *      an unconditional overwrite, so an unconfirmed clobber is data loss.
 *   5. `putObject` — one object at a time, sequentially: 600 requests/minute is
 *      the service's limit and a parallel burst buys nothing.
 *
 * A failure at any step is shown through the ONE error surface
 * (`src/lib/toast.ts`) and the batch stays in the panel so the owner can retry
 * rather than re-pick every file.
 */

import { useState } from 'react';

import {
  collidingObjectNames,
  overwriteConfirmationLabel,
  reviewUploads,
  unconfirmedOverwrites,
  type UploadReview,
} from '@/features/files/upload';
import { folderPrefix, type FolderPath } from '@/lib/folder';
import { formatObjectCount } from '@/lib/format';
import { openFile, type OpenOutcome } from '@/lib/openFile';
import { toastError, toastSuccess } from '@/lib/toast';
import { listObjects, putObject, type StoreTarget } from '@/server/store-client';

export interface UploadPanelProps {
  target: StoreTarget;
  /** The folder being uploaded into; the root by default. */
  folder: FolderPath;
  /** Called after at least one object was written, so the listing can refresh. */
  onUploaded: () => void;
}

/** The ONE set of options this app opens files with. */
const OPEN_REQUEST = {
  description: 'Files to upload',
  extensions: [] as string[],
  mimeType: 'application/octet-stream',
  multiple: true,
};

export function UploadPanel({ target, folder, onUploaded }: UploadPanelProps): React.JSX.Element {
  const [reviews, setReviews] = useState<UploadReview[]>([]);
  const [collisions, setCollisions] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  function discard(): void {
    // The owner changing his mind about his own selection: no request, no toast.
    setReviews([]);
    setCollisions(new Set());
    setConfirmed(new Set());
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
      setReviews(accepted);
      setCollisions(new Set(collidingObjectNames(accepted, objects)));
      setConfirmed(new Set());
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
    const written: string[] = [];
    try {
      for (const review of reviews) {
        try {
          await putObject(target, review.objectName, review.bytes);
          written.push(review.objectName);
        } catch (error: unknown) {
          toastError(error, `Could not upload ${review.fileName}`);
        }
      }
    } finally {
      setBusy(false);
    }

    if (written.length === 0) return;
    setReviews((current) => current.filter((review) => !written.includes(review.objectName)));
    setConfirmed(new Set());
    onUploaded();
    toastSuccess(`Uploaded ${formatObjectCount(written.length)}.`);
  }

  return (
    <div className="border-edge bg-surface-raised rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="bg-accent text-surface rounded px-3 py-1.5 text-sm font-medium"
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
          <p className="text-ink-muted text-sm">
            {formatObjectCount(reviews.length)} ready to upload. Each one will be stored under the
            name shown.
          </p>
          <ul className="mt-2 space-y-2">
            {reviews.map((review) => (
              <li key={review.objectName} className="text-sm">
                <span className="break-all">{review.fileName}</span>
                <span aria-hidden="true"> → </span>
                <code className="text-ink break-all">{review.objectName}</code>
                {review.renamed ? (
                  <span className="text-ink-muted"> (renamed to a ServerStore-legal name)</span>
                ) : null}
                {collisions.has(review.objectName) ? (
                  <label className="text-danger mt-1 flex items-start gap-2">
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
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className="bg-accent text-surface rounded px-3 py-1.5 text-sm font-medium"
              onClick={() => {
                void upload();
              }}
              disabled={busy}
            >
              Upload {formatObjectCount(reviews.length)}
            </button>
            <button
              type="button"
              className="border-edge rounded border px-3 py-1.5 text-sm"
              onClick={discard}
              disabled={busy}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
