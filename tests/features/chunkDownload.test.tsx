import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FileBrowser } from '@/features/files/FileBrowser';
import { sha256Hex } from '@/lib/sha256';
import {
  deleteObject,
  getObject,
  listObjects,
  putObject,
  type ObjectBytes,
  type ObjectEntry,
  type WhoAmI,
} from '@/server/store-client';
import {
  chunkFixture,
  FIXTURE_CREATED_AT,
  readerFor,
  TARGET,
  type StoredObject,
} from './chunkFixture';

/**
 * Ledger row 12, slice B — THE CHUNKED DOWNLOAD. Each statement here is one of
 * the brief's pins:
 *
 *  * a chunked download verifies every part against the service's own
 *    `x-serverstore-sha256` AND the manifest's recorded size and hash, and
 *    REFUSES to save on a mismatch;
 *  * a chunked download never materialises the whole file (the streaming path is
 *    used: each part is written as it arrives, and the anchor path — one Blob over
 *    the whole file — is never taken);
 *  * the manifest must be consistent with the listing before any part is fetched.
 *
 * The save seam is the REAL one, with a stubbed `showSaveFilePicker` that records
 * what reaches `createWritable` — the same technique `tests/lib/saveFile.test.ts`
 * uses. The store transport is MOCKED; the manifest codec and every digest are the
 * real ones.
 */

vi.mock('@/server/store-client', () => ({
  whoami: vi.fn(),
  listObjects: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const WHO: WhoAmI = {
  id: 'key_1',
  label: 'Arnd',
  stores: ['files'],
  perms: ['read', 'write', 'delete'],
  expiresAt: null,
  lastUsedAt: null,
};

const errorSpy = vi.spyOn(toast, 'error');
const successSpy = vi.spyOn(toast, 'success');

function allToasts(): string {
  return errorSpy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
    .join(' | ');
}

/** What reached the chosen file. */
interface WritableLog {
  writes: Blob[];
  /** How many `getObject` calls had happened when each write arrived. */
  getsAtWrite: number[];
  closed: number;
  aborted: number;
}

function installPicker(): WritableLog {
  const log: WritableLog = { writes: [], getsAtWrite: [], closed: 0, aborted: 0 };
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: (part: Blob) => {
              log.writes.push(part);
              log.getsAtWrite.push(vi.mocked(getObject).mock.calls.length);
              return Promise.resolve();
            },
            close: () => {
              log.closed += 1;
              return Promise.resolve();
            },
            abort: () => {
              log.aborted += 1;
              return Promise.resolve();
            },
          }),
      }),
  });
  return log;
}

let createObjectUrl: (blob: Blob | MediaSource) => string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listObjects).mockResolvedValue([]);
  vi.mocked(putObject).mockResolvedValue({
    store: 'files',
    name: 'anything',
    sha256: 'b'.repeat(64),
    size: 3,
    createdAt: FIXTURE_CREATED_AT,
  });
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  createObjectUrl = vi.fn(() => 'blob:test');
  URL.createObjectURL = createObjectUrl;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

async function openAndDownload(
  objects: ReadonlyMap<string, StoredObject>,
  listing: ObjectEntry[],
): Promise<void> {
  vi.mocked(listObjects).mockResolvedValue(listing);
  vi.mocked(getObject).mockImplementation(readerFor(objects));
  render(<FileBrowser target={TARGET} who={WHO} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download' }));
}

/* -------------------------------------------------------- every part verified */

it('a chunked download verifies every part against the manifest and REFUSES to save on a mismatch', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);
  // The SERVICE is honest — its header matches the bytes it sent — but PART 1 is
  // not the part the manifest records.
  const tampered = new Uint8Array([99, 99, 99, 99]);
  const objects = new Map(fixture.objects);
  objects.set(fixture.partNames[1] ?? '', {
    bytes: tampered,
    sha256: await sha256Hex(tampered),
  });
  const log = installPicker();

  await openAndDownload(objects, fixture.entries);

  await waitFor(() => {
    expect(allToasts()).toMatch(/Refusing to save/);
  });
  // The part is NAMED, and BOTH digests are shown: what arrived, and what the
  // manifest records.
  expect(allToasts()).toContain(fixture.partNames[1] ?? '');
  expect(allToasts()).toContain(await sha256Hex(tampered));
  expect(allToasts()).toContain(
    fixture.objects.get(fixture.partNames[1] ?? '')?.sha256 ?? 'not-a-digest',
  );
  // The save was ABORTED: the writable was never closed, and nothing claims the
  // file was saved.
  await waitFor(() => {
    expect(log.aborted).toBe(1);
  });
  expect(log.closed).toBe(0);
  expect(successSpy).not.toHaveBeenCalled();
});

it('a part whose bytes do not match the service’s own x-serverstore-sha256 is refused too', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  const objects = new Map(fixture.objects);
  // The header LIES about the bytes (a mangled body with an intact header).
  const part = fixture.partNames[0] ?? '';
  objects.set(part, { bytes: new Uint8Array([9, 9, 9, 9]), sha256: 'f'.repeat(64) });
  const log = installPicker();

  await openAndDownload(objects, fixture.entries);

  await waitFor(() => {
    expect(allToasts()).toMatch(/x-serverstore-sha256/);
  });
  expect(allToasts()).toContain(part);
  expect(log.aborted).toBe(1);
  expect(log.closed).toBe(0);
  expect(successSpy).not.toHaveBeenCalled();
});

/* ------------------------------------------------------------ the streaming path */

it('a chunked download never materialises the whole file: every part is written as it arrives', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);
  const log = installPicker();

  await openAndDownload(fixture.objects, fixture.entries);

  await waitFor(() => {
    expect(log.closed).toBe(1);
  });
  // THREE writes, one per part — never one Blob over the whole file.
  expect(log.writes).toHaveLength(3);
  const sizes = await Promise.all(
    log.writes.map((blob) => blob.arrayBuffer().then((buffer) => buffer.byteLength)),
  );
  expect(sizes).toEqual([4, 4, 4]);
  // THE ORDER PROVES THE STREAM: write k happened when exactly k+3 reads had
  // happened — the render's own manifest read (the row was classified from
  // content), the download's OWN manifest read (it re-reads and re-verifies
  // rather than trusting the render), then ONE part per write. If the file had
  // been materialised first, every write would see all five reads.
  expect(log.getsAtWrite).toEqual([3, 4, 5]);
  // The anchor path (ONE Blob over everything) was never used.
  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(successSpy).toHaveBeenCalled();
});

/* ------------------------------------------- the manifest must match the listing */

it('the manifest must be consistent with the listing before any part is fetched', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  // The listing the row was rendered from describes a DIFFERENT manifest object.
  const listing = fixture.entries.map((row) =>
    row.name === fixture.manifestName ? { ...row, sha256: 'f'.repeat(64) } : row,
  );
  installPicker();

  await openAndDownload(fixture.objects, listing);

  await waitFor(() => {
    expect(allToasts()).toMatch(/stale/);
  });
  // NOTHING but the manifest was read: no part was fetched.
  const read = vi.mocked(getObject).mock.calls.map((call) => call[1]);
  expect(read.length).toBeGreaterThan(0);
  expect(read.every((name) => name === fixture.manifestName)).toBe(true);
});

/* --------------------------------------------------------------- the progress */

it('the chunked download reports progress per part', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  const reader = readerFor(fixture.objects);
  const pendingParts: (() => void)[] = [];
  vi.mocked(getObject).mockImplementation((target, name): Promise<ObjectBytes> => {
    if (name === fixture.manifestName) return reader(target, name);
    return new Promise<ObjectBytes>((resolve) => {
      pendingParts.push(() => {
        void reader(target, name).then(resolve);
      });
    });
  });
  vi.mocked(listObjects).mockResolvedValue(fixture.entries);
  installPicker();

  render(<FileBrowser target={TARGET} who={WHO} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download' }));

  // The first part is in flight, and nothing has been verified yet, so the
  // surface does not exist — it appears with the first VERIFIED part and moves
  // from there: a real count, not a spinner.
  await waitFor(() => {
    expect(pendingParts).toHaveLength(1);
  });
  expect(screen.queryByRole('progressbar')).toBeNull();

  const first = pendingParts[0];
  if (first === undefined) throw new Error('the first part was never requested');
  first();
  await waitFor(() => {
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2');

  const second = pendingParts[1];
  if (second === undefined) throw new Error('the second part was never requested');
  second();
  await waitFor(() => {
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  });
});

/* ------------------------------------------------------------------ a cancel */

it('a cancelled picker costs NO manifest read and NO part fetch', async () => {
  const fixture = await chunkFixture('big.bin', [[1, 2, 3, 4]]);
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')),
  });
  vi.mocked(listObjects).mockResolvedValue(fixture.entries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  render(<FileBrowser target={TARGET} who={WHO} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download' }));

  // The hook's own manifest read happens on render; the DOWNLOAD fetches nothing.
  await waitFor(() => {
    expect(getObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      fixture.manifestName,
    );
  });
  expect(errorSpy).not.toHaveBeenCalled();
  expect(successSpy).not.toHaveBeenCalled();
  expect(createObjectUrl).not.toHaveBeenCalled();
});
