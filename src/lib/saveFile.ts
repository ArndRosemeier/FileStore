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
function anchorDownload(request: SaveRequest, bytes: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: request.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = request.fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, ANCHOR_URL_REVOKE_DELAY_MS);
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
