import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { openFile, type OpenFileRequest } from '@/lib/openFile';

/**
 * Ledger rows 8 and 13 — THE OPEN SEAM'S BRANCH MATRIX, the mirror of
 * `tests/lib/saveFile.test.ts` and pinned the same way: by stubbing the one
 * thing that differs between browsers.
 *
 * | `showOpenFilePicker` | outcome                      | result                        |
 * |----------------------|------------------------------|-------------------------------|
 * | present              | one file picked              | `{opened, files:[that file]}` |
 * | present              | several picked               | `{opened, files}` IN ORDER    |
 * | present              | `AbortError`                 | `{cancelled}` (SILENT)        |
 * | present              | anything else                | THROWS with its reason        |
 * | absent               | the input's `change` fires   | `{opened, files}` IN ORDER    |
 * | absent               | the input's `cancel` fires   | `{cancelled}` (SILENT)        |
 *
 * ROW 13'S CONTRACT: the seam hands over the browser's `File` and its own
 * `size`, and reads NO bytes. The pins that say so spy on each `File`'s own
 * `arrayBuffer` and assert it was never called — the whole-file read is the
 * exact thing this seam must never do again, so it is asserted as NOT CALLED,
 * not merely left unobserved.
 *
 * `lib.dom` declares no `showOpenFilePicker`, so these stubs stand in for the
 * real browser method's NAME, SIGNATURE and ASYNC-ness. EVERY STUB IS INSTALLED
 * AND REMOVED BY THIS FILE'S OWN HOOKS: the method lives on shared global state,
 * and a leaked stub would turn a later file's "picker absent" arm into a
 * "picker present" one.
 *
 * ONE ROW-8 PIN WAS RETIRED BY ROW 13, and it is named rather than quietly
 * dropped: `the input is removed even when reading a chosen file fails (loud
 * reason)` exercised a read that no longer exists — the input branch now maps
 * the browser's `File`s synchronously and has no failure path to clean up after.
 * Its cleanup guarantee is still pinned, by `choosing files through the input
 * hands over every real File, in order, and reads nothing` (`input.isConnected`
 * is `false` after the change) and by the cancel pin beside it.
 */

const REQUEST: OpenFileRequest = {
  description: 'Files to upload',
  extensions: ['.pdf', '.txt'],
  mimeType: 'application/octet-stream',
  multiple: true,
};

function fileNamed(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
}

/** A spy on the file's OWN whole-file read, so "no bytes were read" is provable. */
function watchWholeFileRead(file: File): MockInstance<() => Promise<ArrayBuffer>> {
  return vi.spyOn(file, 'arrayBuffer');
}

/** Installs a fake picker returning the given files, and records the options. */
function installPicker(files: readonly File[]): { calls: unknown[] } {
  const calls: unknown[] = [];
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: (options: unknown) => {
      calls.push(options);
      return Promise.resolve(
        files.map(
          (file) => ({ getFile: () => Promise.resolve(file) }) as unknown as FileSystemFileHandle,
        ),
      );
    },
  });
  return { calls };
}

function installRejectingPicker(error: Error): void {
  Object.defineProperty(window, 'showOpenFilePicker', {
    configurable: true,
    value: () => Promise.reject(error),
  });
}

let clickSpy: MockInstance<() => void>;

beforeEach(() => {
  Reflect.deleteProperty(window, 'showOpenFilePicker');
  clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'showOpenFilePicker');
});

/** The `<input type="file">` the fallback created (it is removed on settle). */
function lastInput(): HTMLInputElement | undefined {
  return clickSpy.mock.contexts.at(-1) as HTMLInputElement | undefined;
}

/* -------------------------------------------------------- picker present */

it('opening ONE file reads NO file bytes at all: the whole-file read is never called', async () => {
  const file = fileNamed('notes.txt', [1, 2, 3]);
  const read = watchWholeFileRead(file);
  installPicker([file]);
  const outcome = await openFile(REQUEST);

  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;
  expect(outcome.files).toHaveLength(1);
  expect(outcome.files[0]?.fileName).toBe('notes.txt');
  expect(read).not.toHaveBeenCalled();
  // The fallback was NOT touched.
  expect(clickSpy).not.toHaveBeenCalled();
});

it('opening SEVERAL files at once reads NO file bytes either, and keeps the chosen order', async () => {
  const files = [fileNamed('a.txt', [1]), fileNamed('b.txt', [2, 2]), fileNamed('c.txt', [3, 3, 3])];
  const reads = files.map((file) => watchWholeFileRead(file));
  installPicker(files);
  const outcome = await openFile(REQUEST);

  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;
  expect(outcome.files.map((file) => file.fileName)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  for (const read of reads) expect(read).not.toHaveBeenCalled();
});

it('both the picker and the hidden input hand over the REAL File the browser produced, not a copy', async () => {
  const picked = fileNamed('real.txt', [1, 2, 3]);
  installPicker([picked]);
  const fromPicker = await openFile(REQUEST);
  expect(fromPicker.status).toBe('opened');
  if (fromPicker.status !== 'opened') return;
  const pickerFile = fromPicker.files[0]?.file;
  expect(pickerFile).toBeInstanceOf(File);
  expect(pickerFile).toBe(picked);

  // The same claim for the fallback branch: the very File the input was given.
  Reflect.deleteProperty(window, 'showOpenFilePicker');
  const promise = openFile(REQUEST);
  const input = lastInput();
  if (input === undefined) throw new Error('no input was created');
  const chosen = fileNamed('real-two.txt', [4, 5]);
  Object.defineProperty(input, 'files', { configurable: true, value: [chosen] });
  input.dispatchEvent(new Event('change'));
  const fromInput = await promise;
  expect(fromInput.status).toBe('opened');
  if (fromInput.status !== 'opened') return;
  expect(fromInput.files[0]?.file).toBe(chosen);
});

it('size is the browser own file.size, and a zero-byte file reports 0 with no read', async () => {
  const empty = fileNamed('empty.bin', []);
  const read = watchWholeFileRead(empty);
  installPicker([empty]);
  const outcome = await openFile(REQUEST);

  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;
  expect(outcome.files[0]?.size).toBe(0);
  expect(outcome.files[0]?.size).toBe(empty.size);
  expect(read).not.toHaveBeenCalled();
});

it('`multiple` and the accept filter are forwarded to the picker, not just the fallback', async () => {
  const picker = installPicker([fileNamed('a.txt', [1])]);
  await openFile(REQUEST);
  expect(picker.calls).toEqual([
    {
      multiple: true,
      types: [
        {
          description: 'Files to upload',
          accept: { 'application/octet-stream': ['.pdf', '.txt'] },
        },
      ],
    },
  ]);
});

it('a cancelled picker is the owner changing his mind: silent and read-free', async () => {
  installRejectingPicker(new DOMException('The user aborted a request.', 'AbortError'));
  await expect(openFile(REQUEST)).resolves.toEqual({ status: 'cancelled' });
  expect(clickSpy).not.toHaveBeenCalled();
});

it('`AbortError` is matched by NAME, not by class (a cross-realm object cancels)', async () => {
  installRejectingPicker(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await expect(openFile(REQUEST)).resolves.toEqual({ status: 'cancelled' });
});

it('a real failure keeps its own reason — the caller must surface it loudly', async () => {
  installRejectingPicker(new DOMException('Permission denied.', 'NotAllowedError'));
  await expect(openFile(REQUEST)).rejects.toThrow('Permission denied.');
});

it('an empty handle list is a cancel, never an "opened" with no files', async () => {
  installPicker([]);
  await expect(openFile(REQUEST)).resolves.toEqual({ status: 'cancelled' });
});

/* --------------------------------------------------------- picker absent */

it('an absent picker falls back to a hidden file input that accepts the extension', () => {
  void openFile(REQUEST);
  const input = lastInput();
  expect(input).toBeDefined();
  expect(input?.type).toBe('file');
  expect(input?.hidden).toBe(true);
  expect(input?.multiple).toBe(true);
  expect(input?.accept).toBe('.pdf,.txt,application/octet-stream');
});

it('choosing files through the input hands over every real File, in order, and reads nothing', async () => {
  const files = [fileNamed('one.txt', [1]), fileNamed('two.txt', [2, 2])];
  const reads = files.map((file) => watchWholeFileRead(file));
  const promise = openFile(REQUEST);
  const input = lastInput();
  if (input === undefined) throw new Error('no input was created');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change'));

  const outcome = await promise;
  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;
  expect(outcome.files.map((file) => file.fileName)).toEqual(['one.txt', 'two.txt']);
  for (const [index, file] of files.entries()) {
    expect(outcome.files[index]?.file).toBe(file);
  }
  expect(outcome.files.map((file) => file.size)).toEqual([1, 2]);
  for (const read of reads) expect(read).not.toHaveBeenCalled();
  // The element existed only to be clicked.
  expect(input.isConnected).toBe(false);
});

it('a single-file request does not ask the input for several files', () => {
  void openFile({ ...REQUEST, multiple: false });
  const input = lastInput();
  expect(input?.multiple).toBe(false);
});

it('dismissing the input dialog is a SILENT cancel and removes the element', async () => {
  const promise = openFile(REQUEST);
  const input = lastInput();
  if (input === undefined) throw new Error('no input was created');
  input.dispatchEvent(new Event('cancel'));

  await expect(promise).resolves.toEqual({ status: 'cancelled' });
  expect(input.isConnected).toBe(false);
});

it('an empty selection through the input is a SILENT cancel too', async () => {
  const promise = openFile(REQUEST);
  const input = lastInput();
  if (input === undefined) throw new Error('no input was created');
  Object.defineProperty(input, 'files', { configurable: true, value: [] });
  input.dispatchEvent(new Event('change'));

  await expect(promise).resolves.toEqual({ status: 'cancelled' });
});
