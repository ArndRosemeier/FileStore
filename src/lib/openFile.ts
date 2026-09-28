/**
 * THE open seam (ledger row 8): the ONE place FileStore takes files IN from the
 * owner's disk. It is the mirror of `src/lib/saveFile.ts` — same branch matrix,
 * same cancel-is-silent rule (through `src/lib/abort.ts`), same widened
 * structural read of a picker method `lib.dom` does not declare (TypeScript 6.0
 * has the file-handle types but no picker method).
 *
 * THE ONE DELIBERATE DIVERGENCE FROM THE IMAGER PORT: it takes MULTIPLE files.
 * Imager imports exactly one backup archive; a file store's primary verb is
 * "put these files in", so a single-file open would make the owner repeat the
 * dialog once per file. `multiple` is forwarded to BOTH branches — the picker's
 * `multiple` option and the fallback input's `multiple` attribute — because a
 * capability that exists in one branch and not the other is the drift this seam
 * exists to prevent.
 *
 * THE BRANCH MATRIX (pinned by `tests/lib/openFile.test.ts`):
 *
 * | `showOpenFilePicker` | outcome                      | result                        |
 * |----------------------|------------------------------|-------------------------------|
 * | present              | owner picks one file         | `{opened, files:[that file]}` |
 * | present              | owner picks several          | `{opened, files}` IN ORDER    |
 * | present              | owner cancels (`AbortError`) | `{cancelled}` (SILENT)        |
 * | present              | real failure                 | THROWS (loud, rule 1/2)       |
 * | absent               | input `change` with files    | `{opened, files}` IN ORDER    |
 * | absent               | input `cancel`               | `{cancelled}` (SILENT)        |
 *
 * `files` is never empty when the status is `'opened'` — an empty selection is
 * resolved as `{cancelled}` rather than handed on as a successful open of
 * nothing.
 *
 * **THIS SEAM READS NO FILE BYTES (ledger row 13).** It hands over the `File`
 * the browser produced — the picker's `handle.getFile()` or the input's
 * `input.files[0]` — plus the browser's own `file.size`. Reading a picked file
 * whole HERE would force a GB-range upload to materialise the whole file before
 * anything downstream could stream it, which is exactly what the chunked write
 * exists to avoid. Each consumer reads only what it needs, when it needs it:
 * the upload's review decides zero-byte from `size`, the single-object path
 * reads the file ONCE at `putObject` time, and the chunked path reads one
 * `file.slice(start, end)` per part (`src/features/files/chunkUpload.ts`'s
 * `fileChunkSource`). Nothing about the branch matrix, the cancel rule or the
 * ordering below changed when the bytes left this module.
 *
 * THE ABSENT-PICKER FALLBACK AND ITS HONEST LIMIT: a hidden
 * `<input type="file">` is appended, clicked and removed. Its `change` event
 * carries the choice; its `cancel` event (Chrome 113+, Firefox 91+, Safari
 * 16.4+) carries the dismissal. On a browser with NEITHER the picker NOR the
 * input `cancel` event, a dismissed dialog leaves this promise PENDING — the
 * caller keeps waiting and nothing is uploaded. That is the honest failure: no
 * file was opened, and inventing a "cancelled" answer the browser never gave
 * would be a silent fallback (rule 1). It is documented rather than papered
 * over, and it is why the picker branch is preferred wherever the API exists.
 */

import { isAbortError } from '@/lib/abort';

/** What the owner is being asked for. */
export interface OpenFileRequest {
  /** The picker's own description, e.g. `Files to upload`. */
  description: string;
  /** The allowed file-name extensions, e.g. `['.png', '.jpg']`. */
  extensions: readonly string[];
  /** The MIME type those extensions carry, e.g. `image/png`. */
  mimeType: string;
  /** Whether the owner may choose more than one file. Defaults to `false`. */
  multiple?: boolean;
}

/** One chosen file, handed on UNREAD. */
export interface OpenedFile {
  /** The name the file had on disk (shown to the owner, never trusted as a path). */
  fileName: string;
  /** The browser's `File` — the bytes are read by the caller, on demand, never here. */
  file: File;
  /** The browser's own `file.size`; no read was needed to learn it. */
  size: number;
}

/**
 * What happened. `cancelled` is an OUTCOME, not an error: the caller must not
 * toast, throw or report anything for it.
 */
export type OpenOutcome = { status: 'opened'; files: OpenedFile[] } | { status: 'cancelled' };

/** The picker call shape this seam needs, read structurally (see header). */
interface OpenTypeDescription {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerWindow {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: OpenTypeDescription[];
  }) => Promise<FileSystemFileHandle[]>;
}

/** The `accept` entry for the requested extensions. */
function openTypeFor(request: OpenFileRequest): OpenTypeDescription | undefined {
  if (request.extensions.length === 0) return undefined;
  return {
    description: request.description,
    accept: { [request.mimeType]: [...request.extensions] },
  };
}

/**
 * Hand one chosen `File` on UNREAD: its name, the handle itself and the
 * browser's own size. No bytes are touched — mapping a selection through this
 * hands the order the owner chose over without a single whole-file read.
 */
function openedFrom(file: File): OpenedFile {
  return { fileName: file.name, file, size: file.size };
}

/**
 * The no-picker fallback: a hidden `<input type="file">`. It exists only to be
 * clicked and is removed as soon as the dialog answers, so a second open starts
 * from a clean element rather than reusing one with a stale `files` list.
 */
function inputOpen(request: OpenFileRequest): Promise<OpenOutcome> {
  return new Promise<OpenOutcome>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    input.multiple = request.multiple === true;
    input.accept = [...request.extensions, request.mimeType].join(',');

    const cleanup = (): void => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const settle = (outcome: OpenOutcome): void => {
      cleanup();
      resolve(outcome);
    };
    const onChange = (): void => {
      const files = input.files;
      if (files === null || files.length === 0) {
        settle({ status: 'cancelled' });
        return;
      }
      settle({ status: 'opened', files: [...files].map((file) => openedFrom(file)) });
    };
    const onCancel = (): void => {
      settle({ status: 'cancelled' });
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    document.body.append(input);
    input.click();
  });
}

/**
 * Ask the owner for one or more files and hand each one over UNREAD. Resolves
 * with the `File`s or with `cancelled`; THROWS on a real failure (never on a
 * cancel), including a picker handle whose `getFile()` rejects.
 */
export async function openFile(request: OpenFileRequest): Promise<OpenOutcome> {
  const picker = (window as unknown as OpenFilePickerWindow).showOpenFilePicker;
  if (picker === undefined) return inputOpen(request);

  const multiple = request.multiple === true;
  const type = openTypeFor(request);
  let handles: FileSystemFileHandle[];
  try {
    handles = await picker({
      multiple,
      ...(type === undefined ? {} : { types: [type] }),
    });
  } catch (error: unknown) {
    if (isAbortError(error)) return { status: 'cancelled' };
    throw error;
  }
  if (handles.length === 0) return { status: 'cancelled' };
  const files = await Promise.all(handles.map((handle) => handle.getFile()));
  return { status: 'opened', files: files.map((file) => openedFrom(file)) };
}
