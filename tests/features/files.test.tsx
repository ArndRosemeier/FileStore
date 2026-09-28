import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { openFile } from '@/lib/openFile';
import {
  deleteObject,
  getObject,
  listObjects,
  putObject,
  whoami,
  type ObjectEntry,
  type WhoAmI,
} from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';
import { writeSettings, type Settings } from '@/settings/settings';

/**
 * Ledger rows 2 and 4, and the row-9 pins — THE LISTING, THE UPLOAD REVIEW AND
 * DELETE. Each statement here is one of the brief's pins:
 *
 *  * the listing shows the count and the four facts the store actually holds —
 *    name, size, `createdAt`, the truncated `sha256` — and never the original
 *    file name or a MIME type, which are not stored;
 *  * a zero-byte file is refused WITH A REASON before any request is issued;
 *  * a name that cannot map is an error, never a guess;
 *  * the name mapping is shown BEFORE anything is written;
 *  * an upload whose object name already exists REFUSES until the owner confirms,
 *    and the confirmation names BOTH the file and the object name (rule: `PUT` is
 *    an unconditional overwrite);
 *  * a delete asks first, and a cancelled confirmation issues no request and no
 *    toast;
 *  * a listing failure surfaces the service's own words.
 *
 * The store transport and the open seam are MOCKED (`vi.mock`); the flows, the
 * name seam, the review and the settings seam are the real ones.
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

const CONFIGURED: Settings = {
  baseUrl: 'https://store.futuremagic.de',
  store: 'files',
  key: 'ssk_TESTKEY_not_a_real_credential',
};

const FULL_SHA256 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const errorSpy = vi.spyOn(toast, 'error');

/** Every toast message recorded so far, joined — so "NOTHING was toasted" is one call. */
function allToasts(): string {
  return errorSpy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
    .join(' | ');
}

function entry(name: string, overrides: Partial<ObjectEntry> = {}): ObjectEntry {
  return {
    store: 'files',
    name,
    sha256: 'a'.repeat(64),
    size: 12,
    createdAt: '2026-09-28T14:27:54.773Z',
    ...overrides,
  };
}

function picked(fileName: string, bytes: number[]): { status: 'opened'; files: { fileName: string; bytes: Uint8Array<ArrayBuffer> }[] } {
  return { status: 'opened', files: [{ fileName, bytes: new Uint8Array(bytes) }] };
}

/**
 * Mount the real shell in the `ready` state and let the FIRST listing settle,
 * then forget its call: every assertion below is about what happens NEXT.
 */
async function openStore(): Promise<void> {
  writeSettings(CONFIGURED);
  render(<App />);
  await screen.findByRole('button', { name: 'Choose files…' });
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
  vi.mocked(listObjects).mockClear();
}

async function chooseFiles(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(whoami).mockResolvedValue(WHO);
  vi.mocked(listObjects).mockResolvedValue([]);
  vi.mocked(putObject).mockResolvedValue({
    store: 'files',
    name: 'anything.txt',
    sha256: 'b'.repeat(64),
    size: 3,
    createdAt: '2026-09-28T14:30:00.000Z',
  });
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  vi.mocked(getObject).mockRejectedValue(new Error('getObject is not used by this file'));
});

/* ------------------------------------------------------------- the listing */

it('the listing shows the count and each object’s name, size, creation time and TRUNCATED digest', async () => {
  vi.mocked(listObjects).mockResolvedValue([
    entry('report.txt', { size: 12 }),
    entry('photo.png', { size: 1536, createdAt: '2026-09-27T08:00:00.000Z', sha256: FULL_SHA256 }),
  ]);

  writeSettings(CONFIGURED);
  render(<App />);

  expect(await screen.findByText('2 objects in the store')).toBeInTheDocument();
  expect(screen.getByText('report.txt')).toBeInTheDocument();
  expect(screen.getByText('12 B')).toBeInTheDocument();
  expect(screen.getByText('2026-09-28 14:27 UTC')).toBeInTheDocument();
  expect(screen.getByText('1.5 KiB')).toBeInTheDocument();
  expect(screen.getByText('2026-09-27 08:00 UTC')).toBeInTheDocument();

  const short = screen.getByText('abcdef012345…');
  expect(short).toHaveAttribute('title', FULL_SHA256);
  // The full digest is a tooltip, never rendered as the visible text.
  expect(screen.queryByText(FULL_SHA256)).toBeNull();
});

it('Refresh re-reads the listing, so a change made by another program becomes visible', async () => {
  await openStore();
  const user = userEvent.setup();
  vi.mocked(listObjects).mockResolvedValue([entry('written-elsewhere.txt')]);

  await user.click(screen.getByRole('button', { name: 'Refresh' }));

  expect(await screen.findByText('written-elsewhere.txt')).toBeInTheDocument();
  expect(listObjects).toHaveBeenCalledTimes(1);
});

it('a listing failure surfaces the service’s own message, inline AND through the toast surface', async () => {
  vi.mocked(listObjects).mockRejectedValue(
    new ServerStoreError('forbidden', 'ServerStore refused (forbidden): no read permission', {
      status: 403,
      serverMessage: 'no read permission',
    }),
  );

  writeSettings(CONFIGURED);
  render(<App />);

  expect(await screen.findByText(/no read permission/)).toBeInTheDocument();
  expect(allToasts()).toContain('no read permission');
});

/* -------------------------------------------------------------- the upload */

it('a zero-byte file is refused with a reason BEFORE any request is issued', async () => {
  vi.mocked(openFile).mockResolvedValue(picked('empty.txt', []));
  await openStore();

  await chooseFiles();

  await waitFor(() => {
    expect(allToasts()).toMatch(/zero bytes/);
  });
  expect(allToasts()).toMatch(/empty\.txt/);
  expect(putObject).not.toHaveBeenCalled();
  // Not even the collision check was allowed to run for a file that cannot be
  // stored at all.
  expect(listObjects).not.toHaveBeenCalled();
});

it('a name that cannot map is reported as an error and NEVER guessed into an object name', async () => {
  vi.mocked(openFile).mockResolvedValue(picked('...', [1, 2, 3]));
  await openStore();

  await chooseFiles();

  await waitFor(() => {
    expect(allToasts()).toMatch(/cannot be stored/);
  });
  expect(putObject).not.toHaveBeenCalled();
  expect(listObjects).not.toHaveBeenCalled();
});

it('an upload shows the name mapping BEFORE anything is written', async () => {
  vi.mocked(openFile).mockResolvedValue(picked('My Report.PDF', [1, 2, 3]));
  await openStore();

  await chooseFiles();

  // Both names are on screen, side by side, before any write.
  expect(await screen.findByText('My Report.PDF')).toBeInTheDocument();
  expect(screen.getByText('my-report.pdf')).toBeInTheDocument();
  expect(putObject).not.toHaveBeenCalled();
});

it('an upload whose object name ALREADY EXISTS refuses until the owner confirms, and the confirmation names BOTH', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('report.txt')]);
  vi.mocked(openFile).mockResolvedValue(picked('Report.TXT', [7, 7, 7]));
  await openStore();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Choose files…' }));

  const checkbox = await screen.findByRole('checkbox');
  const label = checkbox.closest('label');
  expect(label).not.toBeNull();
  // The confirmation names the FILE and the OBJECT NAME it would replace.
  expect(label).toHaveTextContent('Report.TXT');
  expect(label).toHaveTextContent('report.txt');

  // Refused: the owner has not confirmed.
  await user.click(screen.getByRole('button', { name: 'Upload 1 object' }));
  expect(putObject).not.toHaveBeenCalled();
  expect(allToasts()).toMatch(/Refusing to overwrite/);

  // Confirmed explicitly, then written.
  await user.click(checkbox);
  await user.click(screen.getByRole('button', { name: 'Upload 1 object' }));
  await waitFor(() => {
    expect(putObject).toHaveBeenCalledTimes(1);
  });
  expect(putObject).toHaveBeenCalledWith(
    expect.objectContaining({ store: 'files' }),
    'report.txt',
    expect.any(Uint8Array),
  );
});

it('a NEW name needs no confirmation: the reviewed file is written and the listing refreshes', async () => {
  vi.mocked(openFile).mockResolvedValue(picked('notes.txt', [1, 2, 3]));
  await openStore();

  await chooseFiles();
  // The file name and the object name are both on screen, so the review list has
  // TWO nodes carrying this text.
  expect(await screen.findAllByText('notes.txt')).not.toHaveLength(0);
  const user = userEvent.setup();
  // Forget the review's own collision-check read: what is asserted below is the
  // refresh the upload causes.
  vi.mocked(listObjects).mockClear();
  await user.click(screen.getByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      'notes.txt',
      expect.any(Uint8Array),
    );
  });
  // The listing was asked again, so what the owner sees matches the store.
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('a cancelled open dialog issues NO request and shows NOTHING', async () => {
  vi.mocked(openFile).mockResolvedValue({ status: 'cancelled' });
  await openStore();

  await chooseFiles();

  expect(allToasts()).toBe('');
  expect(putObject).not.toHaveBeenCalled();
  expect(listObjects).not.toHaveBeenCalled();
});

it('a real failure from the open seam is surfaced — never a click that silently did nothing', async () => {
  vi.mocked(openFile).mockRejectedValue(new Error('The disk disappeared.'));
  await openStore();

  await chooseFiles();

  await waitFor(() => {
    expect(allToasts()).toContain('The disk disappeared.');
  });
  expect(listObjects).not.toHaveBeenCalled();
});

it('discarding a review is the owner changing his mind: no request, no toast', async () => {
  vi.mocked(openFile).mockResolvedValue(picked('notes.txt', [1, 2, 3]));
  await openStore();

  await chooseFiles();
  expect(await screen.findAllByText('notes.txt')).not.toHaveLength(0);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Discard' }));

  expect(screen.queryAllByText('notes.txt')).toHaveLength(0);
  expect(allToasts()).toBe('');
  expect(putObject).not.toHaveBeenCalled();
});

it('an upload failure surfaces the service’s own message and writes nothing else', async () => {
  vi.mocked(openFile).mockResolvedValue(picked('notes.txt', [1, 2, 3]));
  vi.mocked(putObject).mockRejectedValue(
    new ServerStoreError('payload_too_large', 'ServerStore refused (payload_too_large): too big', {
      status: 413,
      serverMessage: 'too big',
    }),
  );
  await openStore();

  await chooseFiles();
  expect(await screen.findAllByText('notes.txt')).not.toHaveLength(0);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Upload 1 object' }));

  await waitFor(() => {
    expect(allToasts()).toContain('too big');
  });
  // The refusal is not swallowed, and the owner can retry: the review is still up.
  expect(screen.getAllByText('notes.txt')).not.toHaveLength(0);
});

/* -------------------------------------------------------------- the delete */

it('a delete asks first, and a CANCELLED confirmation issues no request and no toast', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('report.txt')]);
  await openStore();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(deleteObject).not.toHaveBeenCalled();
  expect(screen.getByText(/Delete report\.txt\?/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(deleteObject).not.toHaveBeenCalled();
  expect(allToasts()).toBe('');
  expect(screen.queryByText(/Delete report\.txt\?/)).toBeNull();
});

it('a confirmed delete destroys exactly the named object and re-reads the listing', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('report.txt')]);
  await openStore();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await user.click(screen.getByRole('button', { name: 'Yes, delete report.txt' }));

  await waitFor(() => {
    expect(deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      'report.txt',
    );
  });
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalledTimes(1);
  });
});

it('a failed delete surfaces the service’s own message, never a silent success', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('report.txt')]);
  vi.mocked(deleteObject).mockRejectedValue(
    new ServerStoreError('forbidden', 'ServerStore refused (forbidden): no delete permission', {
      status: 403,
      serverMessage: 'no delete permission',
    }),
  );
  await openStore();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await user.click(screen.getByRole('button', { name: 'Yes, delete report.txt' }));

  await waitFor(() => {
    expect(allToasts()).toContain('no delete permission');
  });
  // Nothing was refreshed as if it had worked, and the row is still there.
  expect(listObjects).not.toHaveBeenCalled();
  expect(screen.getByText('report.txt')).toBeInTheDocument();
});
