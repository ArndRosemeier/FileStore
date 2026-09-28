import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import { FileBrowser } from '@/features/files/FileBrowser';
import {
  bytesChunkSource,
  fileChunkSource,
  nextChunkGeneration,
  planUploadChunks,
  uploadChunkedReview,
  uploadShapeFor,
} from '@/features/files/chunkUpload';
import type { UploadReview } from '@/features/files/upload';
import { CHUNK_PART_SIZE, chunkManifestName, parseManifest, planChunks } from '@/lib/chunk';
import { openFile } from '@/lib/openFile';
import { sha256Hex } from '@/lib/sha256';
import {
  deleteObject,
  getObject,
  listObjects,
  putObject,
  type PutResult,
  type WhoAmI,
} from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';
import { chunkFixture, FIXTURE_CREATED_AT, readerFor, TARGET } from './chunkFixture';

/**
 * Ledger row 12, slice B — THE UPLOAD'S SHAPE. Each statement here is one of the
 * brief's pins:
 *
 *  * an upload at or below the part size takes the UNCHANGED single-object path;
 *  * an upload above the part size writes every part and the manifest LAST, and
 *    only then does the file appear;
 *  * a part that exceeds the server's cap fails LOUDLY naming the part, with no
 *    retry and no smaller split;
 *  * progress is reported per part;
 *  * overwriting a chunked file writes a NEW GENERATION before the manifest is
 *    swapped (and only then offers the old generation's parts for removal);
 *  * an interrupted chunked upload leaves NO visible file, and its parts are
 *    reported as orphans;
 *  * the existing no-silent-overwrite gate applies, keyed on the LOGICAL name.
 *
 * `chunkPartSize` is a few BYTES here: the pins must drive the whole chunked path
 * without building a 64 MiB buffer, and `planChunks` (frozen) hard-codes the
 * service's cap. The store transport and the open seam are MOCKED; the chunk
 * convention, the manifest codec, the shape decision and the flows are real.
 */

vi.mock('@/server/store-client', () => ({
  whoami: vi.fn(),
  listObjects: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('@/lib/openFile', () => ({ openFile: vi.fn() }));

const WHO: WhoAmI = {
  id: 'key_1',
  label: 'Arnd',
  stores: ['files'],
  perms: ['read', 'write', 'delete'],
  expiresAt: null,
  lastUsedAt: null,
};

const PART_SIZE = 4;

const errorSpy = vi.spyOn(toast, 'error');
const successSpy = vi.spyOn(toast, 'success');

/** Every error toast recorded so far, joined — so "NOTHING was toasted" is one call. */
function allToasts(): string {
  return errorSpy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
    .join(' | ');
}

/** What the store reports back for a written object: its own size and digest. */
async function stored(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<PutResult> {
  return {
    store: 'files',
    name,
    sha256: await sha256Hex(bytes),
    size: bytes.length,
    createdAt: FIXTURE_CREATED_AT,
  };
}

/**
 * What the open seam now hands over (ledger row 13): a REAL `File` plus its own
 * size, so a chunked upload reads it through `fileChunkSource` slice by slice
 * instead of receiving pre-read bytes.
 */
function pickedFile(
  fileName: string,
  bytes: Uint8Array<ArrayBuffer>,
): { status: 'opened'; files: { fileName: string; file: File; size: number }[] } {
  const file = new File([bytes], fileName, { type: 'application/octet-stream' });
  return { status: 'opened', files: [{ fileName, file, size: file.size }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listObjects).mockResolvedValue([]);
  vi.mocked(getObject).mockRejectedValue(new Error('getObject is not used by this test'));
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  vi.mocked(putObject).mockImplementation((_target, name, bytes) => stored(name, bytes));
});

/* --------------------------------------------------------- the shape decision */

it('an upload AT the part size takes the single-object path, and the decision is the size alone', () => {
  // The frozen seam's own cap is the production threshold...
  expect(uploadShapeFor(CHUNK_PART_SIZE)).toBe('single');
  expect(uploadShapeFor(CHUNK_PART_SIZE + 1)).toBe('chunked');
  // ...and one byte is the whole difference, at any size.
  expect(uploadShapeFor(4, PART_SIZE)).toBe('single');
  expect(uploadShapeFor(5, PART_SIZE)).toBe('chunked');
});

it('the small planner and the frozen one agree EXACTLY at the service’s part size', () => {
  expect(planUploadChunks('big.bin', 100, 'abc123')).toEqual(planChunks('big.bin', 100, 'abc123'));
});

it('the chunk source reads ONE part at a time: a zero-copy view over bytes, and slice() over a File', async () => {
  // The bytes source, for a caller that already holds them: each part is a VIEW,
  // so it makes no second copy. Production does NOT use it (ledger row 13): a
  // `Uint8Array` here would mean the whole file had already been read.
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const fromBytes = bytesChunkSource(bytes);
  expect(fromBytes.size).toBe(6);
  const view = await fromBytes.read(1, 4);
  expect(Array.from(view)).toEqual([2, 3, 4]);
  expect(view.buffer).toBe(bytes.buffer);

  // The File source — the SAME seam over a `File`/`Blob`, and the PRODUCTION
  // source: the open seam hands over a `File`, and each part is one `slice()`.
  const file = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])]);
  const slice = vi.spyOn(file, 'slice');
  const fromFile = fileChunkSource(file);
  expect(fromFile.size).toBe(6);
  expect(Array.from(await fromFile.read(2, 5))).toEqual([3, 4, 5]);
  expect(slice).toHaveBeenCalledWith(2, 5);
});

it('an upload at or below the part size takes the UNCHANGED single-object path', async () => {
  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue(pickedFile('exact.bin', new Uint8Array([1, 2, 3, 4])));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  await user.click(await screen.findByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(putObject).toHaveBeenCalledTimes(1);
  });
  // ONE request, and it is the object itself: no part, no manifest.
  expect(putObject).toHaveBeenCalledWith(
    expect.objectContaining({ store: 'files' }),
    'exact.bin',
    expect.any(Uint8Array),
  );
  const names = vi.mocked(putObject).mock.calls.map((call) => call[1]);
  expect(names.some((name) => name.includes('--part-') || name.endsWith('--manifest'))).toBe(false);
});

/* --------------------------------------------------- every part, manifest LAST */

it('an upload above the part size writes every part and the manifest LAST, and never the object itself', async () => {
  const bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);

  // The first listing is the initial one; the second is the collision check; the
  // store then HOLDS what the upload wrote, so the refresh can show it.
  vi.mocked(listObjects)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValue(fixture.entries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue(pickedFile('big.bin', new Uint8Array(bytes)));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  await user.click(await screen.findByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(putObject).toHaveBeenCalledTimes(4);
  });
  const names = vi.mocked(putObject).mock.calls.map((call) => call[1]);
  // The logical object itself is NEVER written: a chunked file is its manifest.
  expect(names).not.toContain('big.bin');
  // The manifest goes LAST — its existence is what makes the file real, so an
  // interrupted write leaves no visible file.
  expect(names[3]).toBe(chunkManifestName('big.bin'));
  // Every PART came first, in order, and the manifest describes exactly the bytes
  // that were sent.
  const manifestCall = vi.mocked(putObject).mock.calls[3];
  const manifestBytes = manifestCall?.[2];
  if (manifestBytes === undefined) throw new Error('the manifest was not written');
  const manifest = parseManifest(manifestBytes);
  expect(names.slice(0, 3)).toEqual(manifest.parts.map((part) => part.name));
  expect(manifest.objectName).toBe('big.bin');
  expect(manifest.totalSize).toBe(bytes.length);
  expect(manifest.parts.map((part) => part.size)).toEqual([4, 4, 4]);

  // AND ONLY THEN does the file appear. The store's answer to the refresh is a
  // complete chunked `big.bin` (the fixture: the generation and digests are the
  // service's own, and this one stands for the state the write produced), so the
  // manifest is read, parsed, and rendered as ONE row with the TOTAL size.
  expect(await screen.findByText(/stored as 3 parts and a manifest/)).toBeInTheDocument();
  expect(screen.getByText('12 B')).toBeInTheDocument();
  expect(screen.queryByText(fixture.partNames[0] ?? '')).toBeNull();
});

it('the chunked path reads only SLICES: the whole-file read is never called, and each part read covers only that part range', async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], 'big.bin', {
    type: 'application/octet-stream',
  });
  // The whole-file read is the thing row 13 removed from this path, so it is
  // asserted NOT CALLED rather than merely left alone.
  const wholeRead = vi.spyOn(file, 'arrayBuffer');
  const ranges: [number, number][] = [];
  const originalSlice = file.slice.bind(file);
  vi.spyOn(file, 'slice').mockImplementation((start?: number, end?: number) => {
    ranges.push([start ?? 0, end ?? file.size]);
    return originalSlice(start, end);
  });

  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue({
    status: 'opened',
    files: [{ fileName: 'big.bin', file, size: file.size }],
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  await user.click(await screen.findByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(putObject).toHaveBeenCalledTimes(4);
  });

  // No whole-file read at all...
  expect(wholeRead).not.toHaveBeenCalled();
  // ...and exactly one slice per PART, each covering only that part's byte range.
  expect(ranges).toEqual([
    [0, 4],
    [4, 8],
    [8, 12],
  ]);
  // The bytes each request carried are exactly the file's own slice.
  expect(
    vi
      .mocked(putObject)
      .mock.calls.slice(0, 3)
      .map((call) => Array.from(call[2])),
  ).toEqual([
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);
});

/* ---------------------------------------------------------------- the 413 rule */

it('a part that exceeds the server’s cap fails LOUDLY naming the part, with no retry and no smaller split', async () => {
  vi.mocked(putObject)
    .mockImplementationOnce((_target, name, bytes) => stored(name, bytes))
    .mockImplementationOnce(() =>
      Promise.reject(
        new ServerStoreError(
          'payload_too_large',
          'ServerStore refused (payload_too_large): too big',
          {
            status: 413,
            serverMessage: 'too big',
          },
        ),
      ),
    );

  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue(pickedFile('big.bin', new Uint8Array(12)));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  await user.click(await screen.findByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(errorSpy).toHaveBeenCalled();
  });
  const messages = allToasts();
  // The part is NAMED, and the only honest report is that the assumption moved.
  expect(messages).toContain('big.bin--g');
  expect(messages).toContain('part-000001');
  expect(messages).toMatch(/cap may be LOWER/);
  expect(messages).toMatch(/NOT retried and NOT split smaller/);
  // NO retry, and no smaller parts: two parts were attempted and the write STOPPED.
  const names = vi.mocked(putObject).mock.calls.map((call) => call[1]);
  expect(names).toHaveLength(2);
  expect(names).not.toContain(chunkManifestName('big.bin'));
});

/* ------------------------------------------------------------------- progress */

it('progress is reported per part, in order, and the manifest is not a part', async () => {
  const review: UploadReview = {
    fileName: 'big.bin',
    objectName: 'big.bin',
    renamed: false,
    file: new File([new Uint8Array(12)], 'big.bin', { type: 'application/octet-stream' }),
    size: 12,
  };
  const progress: { completed: number; total: number; partName: string }[] = [];

  await uploadChunkedReview(TARGET, review, {
    partSize: PART_SIZE,
    drawGeneration: () => 'bbbb2222',
    onProgress: (report) => {
      progress.push({
        completed: report.completed,
        total: report.total,
        partName: report.partName,
      });
    },
  });

  // One report before the first request, then one per STORED part.
  expect(progress.map((report) => report.completed)).toEqual([0, 1, 2, 3]);
  expect(progress.every((report) => report.total === 3)).toBe(true);
  expect(progress.map((report) => report.partName)).toEqual([
    'big.bin--gbbbb2222--part-000000',
    'big.bin--gbbbb2222--part-000000',
    'big.bin--gbbbb2222--part-000001',
    'big.bin--gbbbb2222--part-000002',
  ]);
});

it('the upload shows a per-part progress surface while the parts are being written', async () => {
  const pending: (() => Promise<PutResult>)[] = [];
  vi.mocked(putObject).mockImplementation(
    (_target, name, bytes) =>
      new Promise<PutResult>((resolve) => {
        pending.push(async () => {
          const result = await stored(name, bytes);
          resolve(result);
          return result;
        });
      }),
  );

  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue(pickedFile('big.bin', new Uint8Array(12)));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  await user.click(await screen.findByRole('button', { name: 'Upload 1 object' }));

  // The surface is REAL, not a spinner: it says how many parts are written and
  // which one is in flight, and it moves as the store answers.
  await waitFor(() => {
    expect(pending).toHaveLength(1);
  });
  const bar = screen.getByRole('progressbar');
  expect(bar).toHaveAttribute('aria-valuemax', '3');
  expect(bar).toHaveAttribute('aria-valuenow', '0');

  for (let index = 0; index < 3; index += 1) {
    const resolveOne = pending[index];
    if (resolveOne === undefined) throw new Error('the next part was never requested');
    await act(async () => {
      await resolveOne();
    });
    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(index + 1));
    });
  }
});

/* ------------------------------------------------- the overwrite gate and generations */

it('a chunked file is protected by its LOGICAL name: the upload refuses until the owner confirms', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);
  vi.mocked(listObjects).mockResolvedValue(fixture.entries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue(pickedFile('Big.BIN', new Uint8Array(12)));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));

  // The listing holds NO object named `big.bin` — the collision is found by
  // READING the manifest, so the confirmation is on the LOGICAL name.
  const checkbox = await screen.findByRole('checkbox');
  const label = checkbox.closest('label');
  expect(label).toHaveTextContent('big.bin');
  expect(label).toHaveTextContent('Big.BIN');

  await user.click(screen.getByRole('button', { name: 'Upload 1 object' }));
  expect(putObject).not.toHaveBeenCalled();
  expect(allToasts()).toMatch(/Refusing to overwrite/);
  expect(successSpy).not.toHaveBeenCalled();
});

it('overwriting a chunked file writes a NEW GENERATION before the manifest is swapped', async () => {
  const fixture = await chunkFixture(
    'big.bin',
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    'aaaa1111',
  );
  vi.mocked(listObjects).mockResolvedValue(fixture.entries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));
  vi.mocked(deleteObject).mockResolvedValue(undefined);

  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue(pickedFile('big.bin', new Uint8Array(12)));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  await user.click(await screen.findByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(putObject).toHaveBeenCalledTimes(4);
  });
  const names = vi.mocked(putObject).mock.calls.map((call) => call[1]);
  // The manifest object is the SAME name in every generation, and it goes LAST.
  expect(names[3]).toBe(fixture.manifestName);
  const manifestBytes = vi.mocked(putObject).mock.calls[3]?.[2];
  if (manifestBytes === undefined) throw new Error('the manifest was not written');
  const manifest = parseManifest(manifestBytes);
  // A generation that is NOT the live one, on every part — otherwise the new
  // version would overwrite the parts the old one is still read from.
  expect(manifest.generation).not.toBe(fixture.generation);
  expect(names[0]).toBe(`big.bin--g${manifest.generation}--part-000000`);
  expect(names[1]).toBe(`big.bin--g${manifest.generation}--part-000001`);
  expect(names[2]).toBe(`big.bin--g${manifest.generation}--part-000002`);

  // AND ONLY THEN is the OLD generation OFFERED for removal: nothing was deleted
  // by the upload itself.
  expect(await screen.findByText(/from the previous version/)).toBeInTheDocument();
  expect(deleteObject).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: /Remove the previous version/ }));
  await user.click(screen.getByRole('button', { name: /Yes, remove/ }));

  await waitFor(() => {
    expect(deleteObject).toHaveBeenCalledTimes(3);
  });
  const removed = vi.mocked(deleteObject).mock.calls.map((call) => call[1]);
  // The OLD generation's parts go; the manifest is NOT removed, because it now
  // describes the NEW version.
  expect(removed).toEqual(fixture.partNames);
  expect(removed).not.toContain(fixture.manifestName);
});

it('nextChunkGeneration refuses to reuse the previous generation', () => {
  const draws = ['aaaa1111', 'aaaa1111', 'bbbb2222'];
  let index = 0;
  const generation = nextChunkGeneration('aaaa1111', () => {
    const next = draws[index] ?? 'cccc3333';
    index += 1;
    return next;
  });
  expect(generation).toBe('bbbb2222');
  expect(index).toBe(3);
});

/* --------------------------------------------------------- an interrupted write */

it('an interrupted chunked upload leaves NO visible file, and its parts are reported as orphans', async () => {
  // The third part fails: the store now holds the first two parts and NO manifest.
  vi.mocked(putObject)
    .mockImplementationOnce((_target, name, bytes) => stored(name, bytes))
    .mockImplementationOnce((_target, name, bytes) => stored(name, bytes))
    .mockImplementationOnce(() =>
      Promise.reject(new ServerStoreError('transport', 'the socket died', {})),
    );

  render(<FileBrowser target={TARGET} who={WHO} chunkPartSize={PART_SIZE} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(openFile).mockResolvedValue(pickedFile('big.bin', new Uint8Array(12)));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  await user.click(await screen.findByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(errorSpy).toHaveBeenCalled();
  });
  // The MANIFEST was never written, so nothing about this file exists.
  const names = vi.mocked(putObject).mock.calls.map((call) => call[1]);
  expect(names).toHaveLength(3);
  expect(names).not.toContain('big.bin--manifest');

  // What the store holds now — the two orphaned parts — is what the listing shows:
  // NO file row, and every part NAMED as an orphan.
  const orphanNames = names.slice(0, 2);
  vi.mocked(listObjects).mockResolvedValue(
    orphanNames.map((name) => ({
      store: 'files',
      name,
      sha256: 'a'.repeat(64),
      size: PART_SIZE,
      createdAt: FIXTURE_CREATED_AT,
    })),
  );
  await user.click(screen.getByRole('button', { name: 'Refresh' }));

  expect(await screen.findByText(/Nothing here is a complete file/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  for (const name of orphanNames) {
    expect(await screen.findByText(name)).toBeInTheDocument();
  }
  expect(screen.getByText(/this app will not delete them/)).toBeInTheDocument();
  expect(deleteObject).not.toHaveBeenCalled();
});
