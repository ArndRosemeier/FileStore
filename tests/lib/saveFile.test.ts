import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { saveFile, type SaveRequest } from '@/lib/saveFile';

/**
 * Ledger row 8 — THE SAVE SEAM'S BRANCH MATRIX, pinned by stubbing the one thing
 * that differs between browsers:
 *
 * | `showSaveFilePicker` | outcome            | result                   |
 * |----------------------|--------------------|--------------------------|
 * | present              | written            | `saved` / `file-picker`  |
 * | present              | `AbortError`       | `cancelled` (SILENT)     |
 * | present              | anything else      | THROWS with its reason   |
 * | absent               | anchor download    | `saved` / `anchor`       |
 *
 * `lib.dom` declares no `showSaveFilePicker` (TypeScript 6.0), so these stubs
 * also stand in for the real browser method's NAME, SIGNATURE and ASYNC-ness: a
 * double that invents a different shape certifies code the real object refuses.
 *
 * EVERY STUB IS INSTALLED AND REMOVED BY THE FILE'S OWN HOOKS. The picker lives
 * on `window`, i.e. on shared global state, so one test's accepting stub would
 * silently turn the next test's "picker absent" arm into a "picker present" arm.
 * `beforeEach`/`afterEach` both delete it for that reason.
 */

const BYTES = new Uint8Array([1, 2, 3, 4]);

interface PickerOptions {
  suggestedName: string;
  types?: { accept: Record<string, string[]> }[];
}

function request(overrides: Partial<SaveRequest> = {}): SaveRequest {
  return {
    fileName: 'quarterly-report.pdf',
    mimeType: 'application/pdf',
    buildBytes: () => BYTES,
    ...overrides,
  };
}

/** Installs an accepting fake picker; records its options and what was written. */
function installPicker(): { options: PickerOptions[]; blobs: Blob[]; closes: number[] } {
  const options: PickerOptions[] = [];
  const blobs: Blob[] = [];
  const closes: number[] = [];
  const handle = {
    createWritable: () =>
      Promise.resolve({
        write: (data: Blob) => {
          blobs.push(data);
          return Promise.resolve();
        },
        close: () => {
          closes.push(1);
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
  return { options, blobs, closes };
}

function installRejectingPicker(error: Error): void {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(error),
  });
}

let clickSpy: MockInstance<() => void>;
let createdUrls: Blob[];
/**
 * `URL.createObjectURL`/`revokeObjectURL` are stubbed by ASSIGNMENT, and the
 * mocks are held in locals: asserting against `URL.revokeObjectURL` directly
 * would take an unbound reference to the real method (lint), and the DOM
 * signature takes `Blob | MediaSource`, which a `Blob`-only mock does not
 * satisfy — hence the one cast, on the variable, not on the call.
 */
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

/* -------------------------------------------------------- picker present */

it('a present picker is used: suggested name, MIME type, bytes written and closed', async () => {
  const picker = installPicker();
  const outcome = await saveFile(request());

  expect(outcome).toEqual({ status: 'saved', method: 'file-picker' });
  expect(picker.options).toHaveLength(1);
  expect(picker.options[0]?.suggestedName).toBe('quarterly-report.pdf');
  expect(picker.options[0]?.types).toEqual([{ accept: { 'application/pdf': ['.pdf'] } }]);
  expect(picker.blobs).toHaveLength(1);
  const written = picker.blobs[0];
  if (written === undefined) throw new Error('nothing was written');
  expect(await bytesOf(written)).toEqual(Array.from(BYTES));
  expect(picker.closes).toHaveLength(1);
  // The anchor fallback was NOT taken.
  expect(clickSpy).not.toHaveBeenCalled();
  expect(createdUrls).toEqual([]);
});

it('the bytes are built AFTER the picker returns, so a slow build cannot lose the click', async () => {
  installPicker();
  const buildBytes = vi.fn(() => BYTES);
  await saveFile(request({ buildBytes }));
  expect(buildBytes).toHaveBeenCalledTimes(1);
});

it('the anchor branch revokes its object URL a moment later, not during the click', async () => {
  vi.useFakeTimers();
  try {
    const outcome = await saveFile(request());
    expect(outcome).toEqual({ status: 'saved', method: 'anchor' });
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test');
  } finally {
    vi.useRealTimers();
  }
});

it('a name with no extension sends no `types` filter (nothing to constrain)', async () => {
  const picker = installPicker();
  await saveFile(request({ fileName: 'handover' }));
  expect(picker.options[0]?.types).toBeUndefined();
});

/* --------------------------------------------------- picker cancels/fails */

it('a cancelled picker is the owner changing his mind: silent, and nothing was built', async () => {
  installPicker();
  installRejectingPicker(new DOMException('The user aborted a request.', 'AbortError'));
  const buildBytes = vi.fn(() => BYTES);

  await expect(saveFile(request({ buildBytes }))).resolves.toEqual({ status: 'cancelled' });
  expect(buildBytes).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
});

it('`AbortError` is matched by NAME, not by class (a cross-realm object still cancels)', async () => {
  installRejectingPicker(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await expect(saveFile(request())).resolves.toEqual({ status: 'cancelled' });
});

it('a real failure keeps its own reason — the caller must surface it loudly', async () => {
  installRejectingPicker(new DOMException('Disk is full.', 'NotAllowedError'));
  await expect(saveFile(request())).rejects.toThrow('Disk is full.');
});

it('a failure while writing the picked file is loud too, and keeps its reason', async () => {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: () => Promise.reject(new Error('The disk disappeared.')),
            close: () => Promise.resolve(),
          }),
      } as unknown as FileSystemFileHandle),
  });

  await expect(saveFile(request())).rejects.toThrow('The disk disappeared.');
});

/* --------------------------------------------------------- picker absent */

it('an absent picker falls back to the anchor download with the suggested name', async () => {
  const outcome = await saveFile(request());

  expect(outcome).toEqual({ status: 'saved', method: 'anchor' });
  expect(clickSpy).toHaveBeenCalledTimes(1);
  const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
  expect(anchor?.download).toBe('quarterly-report.pdf');
  expect(anchor?.getAttribute('href')).toBe('blob:test');
  expect(anchor?.isConnected).toBe(false); // it exists only to be clicked
  expect(createdUrls).toHaveLength(1);
});
