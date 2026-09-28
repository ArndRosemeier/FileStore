/**
 * THE save seam (ledger row 8, ported from Imager): the ONE place FileStore puts
 * bytes on the owner's disk.
 *
 * THE BRANCH MATRIX (pinned by `tests/lib/saveFile.test.ts`):
 *
 * | `showSaveFilePicker` | outcome of the call            | result                   |
 * |----------------------|--------------------------------|--------------------------|
 * | present              | owner picks a file, write ok   | `{saved, 'file-picker'}` |
 * | present              | owner cancels (`AbortError`)   | `{cancelled}` (SILENT)   |
 * | present              | real failure                   | THROWS (loud, rule 1/2)  |
 * | absent               | an anchor download is issued   | `{saved, 'anchor'}`      |
 *
 * The cancel case is the one that must stay SILENT: the owner changed his mind,
 * so a toast would be the app arguing with him. The test is by NAME
 * (`AbortError`), shared with the open seam through `src/lib/abort.ts`. Anything
 * else propagates with its own reason and the caller surfaces it through the
 * toast seam (rule 2).
 *
 * WHY THE PICKER IS CALLED BEFORE THE BYTES ARE BUILT: `showSaveFilePicker`
 * requires TRANSIENT USER ACTIVATION. Retrieving an object means a `fetch` of up
 * to 64 MiB (and a `sha256` verification of it) — work that can outlive the
 * activation window, at which point the browser throws `SecurityError: Must be
 * handling a user gesture`. So the request carries a `buildBytes` callback: the
 * picker runs first, in the click handler's own task, and only the owner's chosen
 * destination triggers the (possibly slow) retrieval. A cancelled picker
 * therefore costs nothing — pinned, because that is the bug this shape prevents.
 *
 * `lib.dom` declares no `showSaveFilePicker` (checked: TypeScript 6.0 has
 * `FileSystemFileHandle` but no picker method), so the API is read through a
 * widened structural type. That is also what makes "the API is genuinely absent"
 * a check the compiler cannot narrow away.
 *
 * THE STREAMING VARIANT (ledger row 12, slice A) — `saveFileStreaming`, ADDED
 * beside `saveFile`, which is unchanged. Why it exists: `saveFile`'s
 * `buildBytes()` returns ONE `Uint8Array` and the seam then wraps it in a
 * `Blob`, a second copy — so saving a 2 GB file peaks near 4 GB of memory. The
 * streaming request yields the file as an ordered sequence of `Blob`s instead:
 *
 *  * with the picker, each part is written into `handle.createWritable()` as it
 *    arrives, and the writable is closed EXACTLY ONCE at the end;
 *  * without it, the parts are accumulated as `Blob`s (NEVER raw arrays) and
 *    concatenated into one `Blob` for the object URL, so peak memory is ONE part
 *    and the browser decides whether Blob storage spills to disk.
 *
 * The same two rules hold: the picker runs BEFORE `buildParts()` (transient user
 * activation), and a cancelled picker is a SILENT `{status:'cancelled'}`.
 */

import { isAbortError } from '@/lib/abort';

/** One thing to save: where it goes, what it is, and how to produce it. */
export interface SaveRequest {
  /** The suggested file name. Sanitized BEFORE it reaches here (`src/lib/name.ts`). */
  fileName: string;
  /** The blob's MIME type. */
  mimeType: string;
  /**
   * Produces the bytes. Called AFTER the picker returns (or, in the anchor
   * branch, immediately), so a cancel never pays for the build.
   */
  buildBytes: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>;
}

/** How the bytes reached the disk. */
export type SaveMethod = 'file-picker' | 'anchor';

/**
 * What happened. `cancelled` is an OUTCOME, not an error: the caller must not
 * toast, throw or report anything for it.
 */
export type SaveOutcome = { status: 'saved'; method: SaveMethod } | { status: 'cancelled' };

/**
 * How long an anchor's object URL is kept alive before it is revoked. Revoking
 * it in the same task as the click can abort the download in some browsers, so
 * the URL outlives the click by a moment; a constant, not a magic number.
 */
const ANCHOR_URL_REVOKE_DELAY_MS = 1000;

/** The picker call shape this seam needs, read structurally (see header). */
interface SaveTypeDescription {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types?: SaveTypeDescription[];
  }) => Promise<FileSystemFileHandle>;
}

/** The `accept` entry for a suggested file name, derived from its extension. */
function saveTypeFor(fileName: string, mimeType: string): SaveTypeDescription | undefined {
  const dot = fileName.lastIndexOf('.');
  const extension = dot === -1 ? '' : fileName.slice(dot);
  if (extension === '') return undefined;
  return { accept: { [mimeType]: [extension] } };
}

/**
 * The no-picker fallback: a temporary `<a download>` over an object URL. The
 * element is removed immediately (it exists only to be clicked); the object URL
 * is revoked a moment later. The seam — not its callers — owns this, because a
 * second hand-rolled anchor is exactly the drift rule 4 forbids.
 */
function anchorDownloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, ANCHOR_URL_REVOKE_DELAY_MS);
}

/** The whole-bytes anchor path, unchanged in behaviour: one Blob over the bytes. */
function anchorDownload(request: SaveRequest, bytes: Uint8Array<ArrayBuffer>): void {
  anchorDownloadBlob(request.fileName, new Blob([bytes], { type: request.mimeType }));
}

/**
 * One STREAMING thing to save (ledger row 12): where it goes, what it is, and
 * how to produce its parts one at a time.
 */
export interface StreamingSaveRequest {
  /** The suggested file name. Sanitized BEFORE it reaches here (`src/lib/name.ts`). */
  fileName: string;
  /** The blob's MIME type. */
  mimeType: string;
  /**
   * Yields the file's parts IN ORDER, as `Blob`s. A THUNK, invoked only after
   * the picker returns (or, in the anchor branch, immediately), so a cancel
   * never pays for building a part — the same activation rule as `saveFile`.
   *
   * Each part is written (or accumulated) as it arrives, so the seam never holds
   * more than ONE part at a time. The caller decides how a part is produced
   * (a `File.slice`, a chunk fetched back from the store); the seam decides how
   * it reaches the disk.
   */
  buildParts: () => AsyncIterable<Blob>;
}

/**
 * Save a file whose bytes are produced as an ordered stream of `Blob`s, never
 * holding the whole file. Resolves with how it went; THROWS on a real failure
 * (never on a cancel) — the same outcome vocabulary as `saveFile`.
 */
export async function saveFileStreaming(request: StreamingSaveRequest): Promise<SaveOutcome> {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  const type = saveTypeFor(request.fileName, request.mimeType);

  if (picker === undefined) {
    // BLOBS, never raw arrays: the browser owns how a Blob is backed and may
    // spill it to disk, so peak memory is one part plus the concatenated view.
    // Materialising a part as an array here is exactly the regression the
    // "never holds more than ONE part as an array" pin exists to catch.
    const parts: Blob[] = [];
    for await (const part of request.buildParts()) parts.push(part);
    anchorDownloadBlob(request.fileName, new Blob(parts, { type: request.mimeType }));
    return { status: 'saved', method: 'anchor' };
  }

  let handle: FileSystemFileHandle;
  try {
    handle = await picker({
      suggestedName: request.fileName,
      ...(type === undefined ? {} : { types: [type] }),
    });
  } catch (error: unknown) {
    if (isAbortError(error)) return { status: 'cancelled' };
    // A real failure keeps its own reason (rule 1): the caller shows it.
    throw error;
  }

  const writable = await handle.createWritable();
  try {
    for await (const part of request.buildParts()) {
      await writable.write(part);
    }
    await writable.close();
  } catch (error: unknown) {
    // The stream failed; do not leave the handle open. The failure that
    // PROPAGATES is the original one (rule 1), never this cleanup's.
    try {
      await writable.abort();
    } catch {
      // The stream may already be closed or errored; the real reason is above.
    }
    throw error;
  }
  return { status: 'saved', method: 'file-picker' };
}

/**
 * Save `request`. Resolves with how it went; THROWS on a real failure (never on
 * a cancel).
 */
export async function saveFile(request: SaveRequest): Promise<SaveOutcome> {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  const type = saveTypeFor(request.fileName, request.mimeType);
  if (picker === undefined) {
    anchorDownload(request, await request.buildBytes());
    return { status: 'saved', method: 'anchor' };
  }

  let handle: FileSystemFileHandle;
  try {
    handle = await picker({
      suggestedName: request.fileName,
      ...(type === undefined ? {} : { types: [type] }),
    });
  } catch (error: unknown) {
    if (isAbortError(error)) return { status: 'cancelled' };
    // A real failure keeps its own reason (rule 1): the caller shows it.
    throw error;
  }

  const bytes = await request.buildBytes();
  const writable = await handle.createWritable();
  await writable.write(new Blob([bytes], { type: request.mimeType }));
  await writable.close();
  return { status: 'saved', method: 'file-picker' };
}
