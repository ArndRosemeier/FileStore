/**
 * The upload review (ledger rows 2 and 4; rule 9's pins): what is about to be
 * written, and what must NOT be.
 *
 * The flow exists because `PUT /stores/{store}/objects/{name}` is an
 * UNCONDITIONAL OVERWRITE with no `ETag`, no `If-Match` and no version
 * (`~/projects/ServerStore/docs/API.md`), and because the object name is the file
 * name sanitized with the original name NOT stored anywhere (ledger row 2). Two
 * consequences, and this module is where both are decided before any request:
 *
 *  1. **Every picked file is reviewed before it is written.** The mapping is
 *     computed with the ONE name seam (`src/lib/name.ts`) and handed to the UI so
 *     the owner sees `My Report.PDF → my-report.pdf` BEFORE the write. A name that
 *     cannot map is a refusal carrying the seam's own reason — never a guess.
 *  2. **A zero-byte file cannot be stored at all** (`400 invalid_body`), so it is
 *     refused here, with the reason, before any request is issued — the client can
 *     say why instead of spending a round trip to learn it.
 *
 * The collision test is deliberately its own step: the caller lists the store,
 * hands the names to {@link collidingObjectNames}, and {@link unconfirmedOverwrites}
 * is the gate the upload flow must pass before it writes anything.
 */

import { toObjectName } from '@/lib/name';
import type { OpenedFile } from '@/lib/openFile';
import type { ObjectEntry } from '@/server/store-client';

/** One file that passed review: what it is called, and what it will be called. */
export interface UploadReview {
  /** The name on the owner's disk, shown so the mapping is never silent. */
  fileName: string;
  /** The ServerStore-legal name it will be stored under. */
  objectName: string;
  /** True when the two differ — the owner is about to see a rename. */
  renamed: boolean;
  /** Every byte, ready to be PUT. */
  bytes: Uint8Array<ArrayBuffer>;
}

/** One file that will NOT be stored, and why. Nothing was sent for it. */
export interface UploadRefusal {
  fileName: string;
  message: string;
}

/** The reason a zero-byte file is refused, stated once. */
export function zeroByteRefusal(fileName: string): string {
  return (
    `Refusing to upload ${JSON.stringify(fileName)}: it is zero bytes, and ServerStore ` +
    `refuses an empty body (400 invalid_body). Nothing was sent.`
  );
}

/**
 * Split the picked files into what can be uploaded and what cannot — WITHOUT
 * issuing any request. The caller shows the refusals and continues with the rest.
 */
export function reviewUploads(files: readonly OpenedFile[]): {
  accepted: UploadReview[];
  refused: UploadRefusal[];
} {
  const accepted: UploadReview[] = [];
  const refused: UploadRefusal[] = [];

  for (const file of files) {
    if (file.bytes.length === 0) {
      refused.push({ fileName: file.fileName, message: zeroByteRefusal(file.fileName) });
      continue;
    }
    try {
      const mapping = toObjectName(file.fileName);
      accepted.push({
        fileName: file.fileName,
        objectName: mapping.objectName,
        renamed: mapping.changed,
        bytes: file.bytes,
      });
    } catch (error: unknown) {
      // `toObjectName` throws `ObjectNameMappingError` rather than inventing a
      // placeholder (ledger row 2). Its message names the file and the reason.
      refused.push({
        fileName: file.fileName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { accepted, refused };
}

/**
 * The object names in this review that ALREADY EXIST in the store. An empty array
 * means the whole review is new names and needs no confirmation.
 */
export function collidingObjectNames(
  reviews: readonly UploadReview[],
  objects: readonly ObjectEntry[],
): string[] {
  const stored = new Set(objects.map((entry) => entry.name));
  return reviews.map((review) => review.objectName).filter((name) => stored.has(name));
}

/**
 * THE OVERWRITE GATE (ledger row 4): the reviews that would clobber an existing
 * object and have NOT been explicitly confirmed by the owner. As long as this
 * returns anything, the upload flow must write NOTHING — a silent clobber is the
 * data loss rule 1 forbids.
 */
export function unconfirmedOverwrites(
  reviews: readonly UploadReview[],
  collisions: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
): UploadReview[] {
  return reviews.filter(
    (review) => collisions.has(review.objectName) && !confirmed.has(review.objectName),
  );
}

/** One human line naming BOTH the file and the object name it would replace. */
export function overwriteConfirmationLabel(review: UploadReview): string {
  return `Overwrite the existing object “${review.objectName}” with “${review.fileName}”`;
}
