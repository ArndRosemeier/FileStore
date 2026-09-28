import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { saveFileStreaming, type StreamingSaveRequest } from '@/lib/saveFile';

/**
 * Ledger row 12, slice A — THE STREAMING SAVE.
 *
 * `saveFile` builds ONE `Uint8Array` and wraps it in a `Blob` (a second copy),
 * so a 2 GB file peaks near 4 GB of memory. `saveFileStreaming` takes the file
 * as an ordered sequence of `Blob`s instead and hands each one on as it arrives:
 * into `handle.createWritable()` with the picker, or into a `Blob[]` for the
 * anchor fallback. The three properties pinned here are the ones that make it
 * worth having — every part reaches the disk in order, the writable is closed
 * exactly once, and the no-picker path NEVER materialises a part as an array.
 *
 * `showSaveFilePicker` is a `window` global and `lib.dom` declares no such
 * method, so the stubs stand in for its NAME, SIGNATURE and ASYNC-ness, exactly
 * as `tests/lib/saveFile.test.ts` does. Every stub is installed and removed by
 * this file's own hooks, so one arm cannot leak into the next.
 */

/** The parts a test streams, as the `Blob`s the seam must not re-copy. */
const PARTS = [
  new Blob([new Uint8Array([1, 2, 3])]),
  new Blob([new Uint8Array([4, 5])]),
  new Blob([new Uint8Array([6])]),
];

const ALL_BYTES = [1, 2, 3, 4, 5, 6];

/** Yields the parts in order, lazily, like a real chunked producer. */
async function* streamOf(parts: Blob[]): AsyncIterable<Blob> {
  for (const part of parts) {
    // A real producer (a `File.slice`, a part fetched back from the store) is
    // async between parts; the await keeps this stand-in the same SHAPE.
    await Promise.resolve();
    yield part;
  }
}

function request(overrides: Partial<StreamingSaveRequest> = {}): StreamingSaveRequest {
  return {
    fileName: 'big-file.bin',
    mimeType: 'application/octet-stream',
    buildParts: () => streamOf(PARTS),
    ...overrides,
  };
}

interface PickerOptions {
  suggestedName: string;
  types?: { accept: Record<string, string[]> }[];
}

/** Installs an accepting fake picker and records every write/close/abort. */
function installPicker(): {
  options: PickerOptions[];
  writes: Blob[];
  closes: number[];
  aborts: number[];
} {
  const options: PickerOptions[] = [];
  const writes: Blob[] = [];
  const closes: number[] = [];
  const aborts: number[] = [];
  const handle = {
    createWritable: () =>
      Promise.resolve({
        write: (data: Blob) => {
          writes.push(data);
          return Promise.resolve();
        },
        close: () => {
          closes.push(1);
          return Promise.resolve();
        },
        abort: () => {
          aborts.push(1);
          return Promise.resolve();
        },
      }),
  };
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: (received: PickerOptions) => {
      options.push(received);
      return Promise.resolve(handle as unknown as FileSystemFileHandle);
    },
  });
  return { options, writes, closes, aborts };
}

function installRejectingPicker(error: Error): void {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(error),
  });
}

let clickSpy: MockInstance<() => void>;
let createdUrls: Blob[];
let createObjectUrl: MockInstance<(blob: Blob | MediaSource) => string>;
let revokeObjectUrl: MockInstance<(url: string) => void>;

/** The bytes of a Blob, as a plain array a matcher can compare. */
async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

beforeEach(() => {
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  createdUrls = [];
  createObjectUrl = vi.fn((blob: Blob | MediaSource) => {
    createdUrls.push(blob as Blob);
    return 'blob:test';
  });
  revokeObjectUrl = vi.fn();
  URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL;
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

/* ------------------------------------------------------ picker present */

it('the streaming save writes every part, in order, and closes the writable exactly once', async () => {
  const picker = installPicker();
  const outcome = await saveFileStreaming(request());

  expect(outcome).toEqual({ status: 'saved', method: 'file-picker' });
  expect(picker.options).toHaveLength(1);
  expect(picker.options[0]?.suggestedName).toBe('big-file.bin');
  // EVERY part, in the order it was yielded — compared by bytes, not by count.
  expect(picker.writes.map((blob) => blob.size)).toEqual([3, 2, 1]);
  const written: number[] = [];
  for (const blob of picker.writes) written.push(...(await bytesOf(blob)));
  expect(written).toEqual(ALL_BYTES);
  expect(picker.closes).toHaveLength(1);
  expect(picker.aborts).toHaveLength(0);
  // The anchor fallback was NOT taken.
  expect(clickSpy).not.toHaveBeenCalled();
  expect(createdUrls).toEqual([]);
});

it('the streaming picker is called BEFORE any part is built, so a cancel never pays for the file', async () => {
  const picker = installPicker();
  const buildParts = vi.fn(() => {
    // The picker has already returned by the time a part is asked for.
    expect(picker.options).toHaveLength(1);
    return streamOf(PARTS);
  });

  await saveFileStreaming(request({ buildParts }));
  expect(buildParts).toHaveBeenCalledTimes(1);
});

it('a cancelled streaming picker is SILENT and writes nothing', async () => {
  installRejectingPicker(new DOMException('The user aborted a request.', 'AbortError'));
  const buildParts = vi.fn(() => streamOf(PARTS));

  await expect(saveFileStreaming(request({ buildParts }))).resolves.toEqual({
    status: 'cancelled',
  });
  expect(buildParts).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
  expect(createdUrls).toEqual([]);
});

it('a real streaming failure keeps its own reason, and aborts the writable rather than leaving it open', async () => {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: () => Promise.reject(new Error('The disk disappeared.')),
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          }),
      } as unknown as FileSystemFileHandle),
  });

  await expect(saveFileStreaming(request())).rejects.toThrow('The disk disappeared.');
});

/* ------------------------------------------------------- picker absent */

it("the streaming save's no-picker path accumulates BLOBS, never arrays: no part is materialised as an array", async () => {
  const arrayBufferSpy = vi.spyOn(Blob.prototype, 'arrayBuffer');

  const outcome = await saveFileStreaming(request());

  expect(outcome).toEqual({ status: 'saved', method: 'anchor' });
  // THE property: accumulating raw `Uint8Array`s would require reading each part
  // as an array, which calls `Blob.prototype.arrayBuffer`. It is never called.
  expect(arrayBufferSpy).not.toHaveBeenCalled();
  expect(clickSpy).toHaveBeenCalledTimes(1);
  const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
  expect(anchor?.download).toBe('big-file.bin');
  expect(anchor?.isConnected).toBe(false);

  arrayBufferSpy.mockRestore();
  expect(createdUrls).toHaveLength(1);
  const saved = createdUrls[0];
  if (saved === undefined) throw new Error('nothing was handed to the anchor');
  expect(await bytesOf(saved)).toEqual(ALL_BYTES);
});
