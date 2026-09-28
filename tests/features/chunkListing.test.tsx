import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { FileBrowser } from '@/features/files/FileBrowser';
import {
  chunkFixture,
  entry,
  FIXTURE_CREATED_AT,
  readerFor,
  TARGET,
  type StoredObject,
} from './chunkFixture';
import { formatByteSize } from '@/lib/format';
import { sha256Hex } from '@/lib/sha256';
import type { WhoAmI } from '@/server/store-client';
import { deleteObject, getObject, listObjects, putObject } from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';

/**
 * Ledger row 12, slice B — THE CHUNKED ROW AND WHAT IT REFUSES TO ASSUME. Each
 * statement here is one of the brief's pins:
 *
 *  * a chunked file renders as ONE file row carrying the TOTAL size; its parts
 *    are never rows;
 *  * a REAL FILE whose name only LOOKS like a manifest renders as a normal file,
 *    because its content does not parse;
 *  * an apparent manifest that cannot be READ is REPORTED, never hidden and never
 *    deleted;
 *  * an interrupted chunked upload leaves NO visible file, and its parts are
 *    reported as orphans.
 *
 * The store transport is MOCKED (`vi.mock`) exactly as the other feature tests
 * do; the chunk convention, the manifest codec, the analysis and the view are the
 * REAL ones, and every digest is the real `crypto.subtle` one.
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

let clickSpy: MockInstance<() => void>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listObjects).mockResolvedValue([]);
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  vi.mocked(putObject).mockResolvedValue({
    store: 'files',
    name: 'anything.txt',
    sha256: 'b'.repeat(64),
    size: 3,
    createdAt: FIXTURE_CREATED_AT,
  });
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  clickSpy.mockRestore();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

async function openBrowser(): Promise<void> {
  render(<FileBrowser target={TARGET} who={WHO} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
}

/* -------------------------------------------------- one chunked file, one row */

it('a chunked file renders as ONE file row carrying the TOTAL size; its parts are never rows', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);
  vi.mocked(listObjects).mockResolvedValue(fixture.entries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  await openBrowser();

  // The row exists only once the manifest has been READ (before that the view
  // makes no claim about a manifest-shaped object), so this waits for the settled
  // state rather than for a transient one.
  expect(await screen.findByText(/stored as 3 parts and a manifest/)).toBeInTheDocument();
  // ONE file, named for the logical object — not for the manifest, and never for
  // a part.
  expect(screen.getByText('big.bin')).toBeInTheDocument();
  expect(screen.queryByText('big.bin--manifest')).toBeNull();
  for (const partName of fixture.partNames) {
    expect(screen.queryByText(partName)).toBeNull();
  }
  // The count is the FILES in this folder, not the objects the store holds.
  expect(screen.getByText('1 object in this folder')).toBeInTheDocument();
  // The total is the manifest's total, which is strictly larger than any part.
  expect(screen.getByText(formatByteSize(fixture.totalSize))).toBeInTheDocument();
  expect(fixture.totalSize).toBe(12);
  // ONE row, therefore one set of actions.
  expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  // The row says where the digest comes from, because the store holds no
  // whole-file digest — the note is what waited for the read above.
  // Its createdAt and digest are the manifest object's own — the only ones the
  // store has for the file as a whole.
  expect(screen.getByText('2026-09-28 14:27 UTC')).toBeInTheDocument();
  expect(
    screen.getByTitle(new RegExp(`^${fixture.objects.get(fixture.manifestName)?.sha256 ?? ''}`)),
  ).toBeInTheDocument();
  // Every part and the manifest WERE read, because only content decides.
  expect(getObject).toHaveBeenCalledWith(
    expect.objectContaining({ store: 'files' }),
    'big.bin--manifest',
  );
});

it('a chunked file in a folder is one row there, and the folder counts it once', async () => {
  const fixture = await chunkFixture('docs--report.pdf', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  vi.mocked(listObjects).mockResolvedValue(fixture.entries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  await openBrowser();

  // At the root the chunked file is INSIDE `docs`, counted once there. The count
  // is asserted only after the manifest has been read: before that the view makes
  // no claim.
  await screen.findByRole('button', { name: 'docs' });
  await waitFor(() => {
    expect(getObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      fixture.manifestName,
    );
  });
  expect(await screen.findByText('1 object')).toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'docs' }));

  // Inside it is ONE row for the logical file, with no part rows at all.
  expect(await screen.findByText('report.pdf')).toBeInTheDocument();
  expect(screen.getByText('1 object in this folder')).toBeInTheDocument();
  expect(screen.queryByText(fixture.partNames[0] ?? '')).toBeNull();
});

/* ------------------------------------- a name is not a proof: content decides */

it('a REAL FILE whose name only LOOKS like a manifest renders as a normal file, because its content does not parse', async () => {
  // THE MEASURED COLLISION (`docs/BOARD.md`): `toObjectName('manifest', ['docs'])`
  // IS `docs--manifest` — a real file with the manifest's own shape.
  const realBytes = new TextEncoder().encode('just a file, not a manifest');
  const realSha = await sha256Hex(realBytes);
  const objects = new Map<string, StoredObject>([
    ['docs--manifest', { bytes: realBytes, sha256: realSha }],
  ]);
  vi.mocked(listObjects).mockResolvedValue([entry('docs--manifest', realBytes.length, realSha)]);
  vi.mocked(getObject).mockImplementation(readerFor(objects));

  await openBrowser();

  // It was READ — the name only proposed.
  await waitFor(() => {
    expect(getObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      'docs--manifest',
    );
  });

  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'docs' }));

  // It renders where a REAL file inside `docs` belongs, with the row's own
  // actions — not as a chunked file and not hidden.
  expect(await screen.findByText('manifest')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  // The ambiguity is REPORTED, and the file says what it is.
  expect(screen.getByText(/only LOOK like a chunk manifest/)).toBeInTheDocument();
  expect(screen.getByText(/shown as a normal file/)).toBeInTheDocument();
  // NOTHING was deleted on a name match.
  expect(deleteObject).not.toHaveBeenCalled();
  expect(allToasts()).toBe('');
});

it('an apparent manifest that cannot be read is REPORTED, never hidden and never deleted', async () => {
  const bytes = new TextEncoder().encode('{}');
  const sha = await sha256Hex(bytes);
  vi.mocked(listObjects).mockResolvedValue([entry('docs--manifest', bytes.length, sha)]);
  vi.mocked(getObject).mockRejectedValue(
    new ServerStoreError('transport', 'Could not reach ServerStore (GET /objects/docs--manifest)', {
      cause: new Error('socket closed'),
    }),
  );

  await openBrowser();

  // REPORTED through the ONE error surface, naming the object and the reason.
  await waitFor(() => {
    expect(allToasts()).toContain('docs--manifest');
  });
  expect(allToasts()).toMatch(/Could not reach ServerStore/);

  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'docs' }));

  // NOT HIDDEN: it is still a normal file row, with its actions.
  expect(await screen.findByText('manifest')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  // NOT DELETED, and said so.
  expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  expect(deleteObject).not.toHaveBeenCalled();
});

/* ------------------------------------------------------- orphans are reported */

it('an interrupted chunked upload leaves NO visible file, and its parts are reported as orphans', async () => {
  // Exactly what a write that never reached the manifest leaves behind: parts and
  // no manifest.
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  const orphanEntries = fixture.entries.filter((row) => row.name !== fixture.manifestName);
  vi.mocked(listObjects).mockResolvedValue(orphanEntries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  await openBrowser();

  // NO visible file: the logical name is not a row, and there is nothing to act on.
  expect(await screen.findByText(/Nothing here is a complete file/)).toBeInTheDocument();
  expect(screen.queryByText('big.bin')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  // Every part is NAMED as an orphan, and the report says nothing will delete them.
  expect(screen.getByText(/Parts that belong to no chunked file/)).toBeInTheDocument();
  for (const partName of fixture.partNames) {
    expect(screen.getByText(partName)).toBeInTheDocument();
  }
  expect(screen.getByText(/this app will not delete them/)).toBeInTheDocument();
  // Reporting is not acting.
  expect(deleteObject).not.toHaveBeenCalled();
  expect(successSpy).not.toHaveBeenCalled();
});

it('an INCOMPLETE manifest is one row plus a report naming what is missing', async () => {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);
  const missing = fixture.partNames[2] ?? '';
  // The store lost one part.
  vi.mocked(listObjects).mockResolvedValue(fixture.entries.filter((row) => row.name !== missing));
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  await openBrowser();

  // It is STILL one file row — a chunked file whose bytes are not all there. The
  // report is what waits for the manifest read.
  expect(await screen.findByText(/Incomplete chunked files/)).toBeInTheDocument();
  // ONE row (its own actions), carrying the manifest's TOTAL size.
  expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  expect(screen.getByText(formatByteSize(fixture.totalSize))).toBeInTheDocument();
  // And it says exactly what is missing.
  expect(screen.getByText(/Incomplete chunked files/)).toBeInTheDocument();
  expect(screen.getByText(missing)).toBeInTheDocument();
  expect(screen.getByText(/missing part/)).toBeInTheDocument();
  // Reported, not acted on.
  expect(deleteObject).not.toHaveBeenCalled();
});

it('a part object is never a row even when no manifest can claim it', async () => {
  // A part-shaped name that no readable manifest owns is hidden from the file
  // rows and named in the report — the safe direction, because the predicate is a
  // heuristic.
  const fixture = await chunkFixture('big.bin', [[1, 2, 3, 4]]);
  const orphanEntries = fixture.entries.filter((row) => row.name !== fixture.manifestName);
  vi.mocked(listObjects).mockResolvedValue(orphanEntries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));

  await openBrowser();

  await screen.findByText(/Parts that belong to no chunked file/);
  const report = screen.getByRole('region', { name: 'Chunked files that need attention' });
  expect(within(report).getByText(fixture.partNames[0] ?? '')).toBeInTheDocument();
});
