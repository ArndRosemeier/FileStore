import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import { FileBrowser } from '@/features/files/FileBrowser';
import {
  deleteObject,
  getObject,
  listObjects,
  putObject,
  type WhoAmI,
} from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';
import { chunkFixture, FIXTURE_CREATED_AT, readerFor, TARGET } from './chunkFixture';

/**
 * Ledger row 12, slice B — DELETING A CHUNKED FILE. The brief's pin is:
 *
 *   **Deleting a chunked file removes the manifest AND every part, after a
 *   confirmation naming the COUNT.**
 *
 * And the honesty rule every destructive act in this app carries: a run that
 * fails part way says WHAT REMAINS instead of claiming a success, and stops — no
 * further request is issued.
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listObjects).mockResolvedValue([]);
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  vi.mocked(putObject).mockResolvedValue({
    store: 'files',
    name: 'anything',
    sha256: 'b'.repeat(64),
    size: 3,
    createdAt: FIXTURE_CREATED_AT,
  });
  vi.mocked(getObject).mockRejectedValue(new Error('getObject is not used by this test'));
});

/** A complete three-part chunked file, mounted and settled. */
async function mountChunkedFile(): Promise<Awaited<ReturnType<typeof chunkFixture>>> {
  const fixture = await chunkFixture('big.bin', [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ]);
  vi.mocked(listObjects).mockResolvedValue(fixture.entries);
  vi.mocked(getObject).mockImplementation(readerFor(fixture.objects));
  render(<FileBrowser target={TARGET} who={WHO} />);
  // Settle on the row, which exists only after the manifest has been read.
  await screen.findByText(/stored as 3 parts and a manifest/);
  return fixture;
}

it('deleting a chunked file removes the manifest AND every part, after a confirmation naming the count', async () => {
  const fixture = await mountChunkedFile();
  vi.mocked(listObjects).mockClear();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Delete' }));

  // The confirmation names the COUNT of objects that will go: the manifest plus
  // its three parts.
  const confirmation = screen.getByText(/It is stored as/);
  expect(confirmation).toHaveTextContent('4 objects');
  expect(confirmation).toHaveTextContent('3 parts');
  expect(deleteObject).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Yes, delete big.bin' }));

  await waitFor(() => {
    expect(deleteObject).toHaveBeenCalledTimes(4);
  });
  const removed = vi.mocked(deleteObject).mock.calls.map((call) => call[1]);
  // The MANIFEST FIRST, so the file stops existing at once and a later failure
  // leaves orphans (reported) rather than a visible file with missing bytes...
  expect(removed).toEqual([fixture.manifestName, ...fixture.partNames]);
  // ...and the listing is re-read, so what the owner sees matches the store.
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalledTimes(1);
  });
  expect(successSpy).toHaveBeenCalled();
});

it('a chunked delete that fails part way says what remains instead of claiming success', async () => {
  const fixture = await mountChunkedFile();
  // The manifest goes; the FIRST part then fails.
  vi.mocked(deleteObject)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      new ServerStoreError('forbidden', 'ServerStore refused (forbidden): no delete permission', {
        status: 403,
        serverMessage: 'no delete permission',
      }),
    );
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await user.click(screen.getByRole('button', { name: 'Yes, delete big.bin' }));

  await waitFor(() => {
    expect(allToasts()).toContain('no delete permission');
  });
  // HONEST about the partial state: what went, and what is left.
  expect(allToasts()).toMatch(/Deleted 1 object/);
  expect(allToasts()).toMatch(/3 objects remain/);
  // STOPPED: the two parts after the failure were never attempted.
  expect(deleteObject).toHaveBeenCalledTimes(2);
  // And the file is NOT claimed to have been deleted.
  expect(successSpy).not.toHaveBeenCalledWith(expect.stringContaining('big.bin was deleted'));
  expect(fixture.partNames[1]).toBe('big.bin--gaaaa1111--part-000001');
});
