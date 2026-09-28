import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { FileBrowser } from '@/features/files/FileBrowser';
import { sha256Hex } from '@/lib/sha256';
import { openFile } from '@/lib/openFile';
import {
  deleteObject,
  getObject,
  listObjects,
  putObject,
  type ObjectEntry,
  type StoreTarget,
  type WhoAmI,
} from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';

/**
 * Ledger row 10, slice 2 — THE FOLDER TREE THE OWNER CAN USE. Each statement
 * here is one of the brief's pins:
 *
 *  * ONE listing produces both the files at the current level AND its subfolders;
 *  * a marker object is NEVER rendered as a file;
 *  * an EMPTY folder (marker only) IS rendered as a folder;
 *  * a DEEPER object does not appear at the current level;
 *  * the breadcrumb names every ancestor and clicking one navigates there;
 *  * New folder writes a marker, and an existing folder is refused LOUDLY rather
 *    than overwritten;
 *  * an upload into a folder shows the FULL object name in the review and writes
 *    it there;
 *  * the same file name in two DIFFERENT folders is not a collision, but the same
 *    name in the SAME folder is;
 *  * deleting a folder confirms with the COUNT, and a partial failure reports what
 *    remains rather than claiming success;
 *  * a `429` while deleting a folder is reported with the wait and STOPS;
 *  * an upload into a folder whose full name would exceed the 1024 bound is
 *    refused with a reason before any request.
 *
 * The store transport and the open seam are MOCKED (`vi.mock`) exactly as
 * `tests/features/files.test.tsx` and `tests/features/download.test.tsx` do; the
 * folder convention, the derivation, the flows and the digest are the REAL ones.
 * `listObjects` is answered with the SAME listing whatever prefix is asked for —
 * so the client-side derivation is what is under test, not the mock.
 */

vi.mock('@/server/store-client', () => ({
  whoami: vi.fn(),
  listObjects: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('@/lib/openFile', () => ({ openFile: vi.fn() }));

const TARGET: StoreTarget = {
  baseUrl: 'https://store.futuremagic.de',
  store: 'files',
  key: 'ssk_TESTKEY_not_a_real_credential',
};

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

/** Every error toast recorded so far, joined — so "NOTHING was toasted" is one call. */
function allToasts(): string {
  return errorSpy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
    .join(' | ');
}

/** Every SUCCESS toast recorded so far, joined. */
function allSuccessToasts(): string {
  return successSpy.mock.calls
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

/**
 * The picked file the open seam now hands over UNREAD (ledger row 13): a real
 * `File` plus the browser's own `size`, never a pre-read `Uint8Array`.
 */
function picked(
  fileName: string,
  bytes: number[],
): { status: 'opened'; files: { fileName: string; file: File; size: number }[] } {
  const file = new File([new Uint8Array(bytes)], fileName, {
    type: 'application/octet-stream',
  });
  return { status: 'opened', files: [{ fileName, file, size: file.size }] };
}

let createObjectUrl: MockInstance<(blob: Blob | MediaSource) => string>;
let revokeObjectUrl: MockInstance<(url: string) => void>;
let clickSpy: MockInstance<() => void>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listObjects).mockResolvedValue([]);
  vi.mocked(putObject).mockResolvedValue({
    store: 'files',
    name: 'anything.txt',
    sha256: 'b'.repeat(64),
    size: 3,
    createdAt: '2026-09-28T14:30:00.000Z',
  });
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  vi.mocked(getObject).mockRejectedValue(new Error('getObject is not used by this test'));

  // jsdom implements neither the picker nor object URLs, so the REAL save seam
  // takes its anchor branch and that branch is observed through these stubs
  // (`tests/features/download.test.tsx` does the same).
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  createObjectUrl = vi.fn(() => 'blob:test');
  URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL;
  revokeObjectUrl = vi.fn();
  URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL;
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  // ONLY the anchor spy is restored: `vi.restoreAllMocks()` would also restore the
  // module-scope toast spies and the later tests would assert against a
  // `toast.error` the code no longer calls.
  clickSpy.mockRestore();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

/** Mount the real browser and let the FIRST listing settle. */
async function openBrowser(): Promise<void> {
  render(<FileBrowser target={TARGET} who={WHO} />);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
}

/** Click a folder row (or a breadcrumb crumb) by its label and let the re-list settle. */
async function navigateInto(label: string): Promise<void> {
  const user = userEvent.setup();
  // Wait for the control to exist first: a click on a row the previous navigation
  // has not rendered yet is a flake, not a finding.
  const control = await screen.findByRole('button', { name: label });
  await user.click(control);
  await waitFor(() => {
    expect(listObjects).toHaveBeenCalled();
  });
}

/* --------------------------------------------------- one listing, both levels */

it('one listing produces both the files at the current level and its subfolders', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('readme.txt'), entry('docs--report.txt')]);

  await openBrowser();

  // The subfolder is a row...
  expect(await screen.findByRole('button', { name: 'docs' })).toBeInTheDocument();
  // ... and the file at this level is a file row.
  expect(screen.getByText('readme.txt')).toBeInTheDocument();
  // The file INSIDE docs is not shown here, and neither is a document list.
  expect(screen.queryByText('report.txt')).toBeNull();
  // ONE listing answered both questions.
  expect(listObjects).toHaveBeenCalledTimes(1);
});

it('a marker object is never rendered as a file', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--')]);

  await openBrowser();

  // The marker made the folder visible...
  expect(await screen.findByRole('button', { name: 'docs' })).toBeInTheDocument();
  // ... and the marker itself is nowhere: not as a file row, not as text, and it
  // offers no file action.
  expect(screen.queryByText('docs--')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(allToasts()).toBe('');
});

it('an empty folder (marker only) is rendered as a folder', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--')]);

  await openBrowser();

  expect(await screen.findByRole('button', { name: 'docs' })).toBeInTheDocument();
  // It holds nothing, and it says so without inventing an object.
  expect(screen.getByText('empty')).toBeInTheDocument();
});

it('a deeper object does not appear at the current level', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--reports--q1.pdf')]);

  await openBrowser();

  // Root: only `docs` is visible; the file two levels down is nowhere near.
  expect(await screen.findByRole('button', { name: 'docs' })).toBeInTheDocument();
  expect(screen.queryByText('q1.pdf')).toBeNull();
  expect(screen.queryByText('reports')).toBeNull();

  vi.mocked(listObjects).mockClear();
  await navigateInto('docs');

  // Inside docs: only the `reports` folder; the file is still not at this level.
  expect(await screen.findByRole('button', { name: 'reports' })).toBeInTheDocument();
  expect(screen.queryByText('q1.pdf')).toBeNull();
  // The folder is asked for as the prefix the folder seam computes.
  expect(listObjects).toHaveBeenCalledWith(
    expect.objectContaining({ store: 'files' }),
    'docs--',
    expect.anything(),
  );

  vi.mocked(listObjects).mockClear();
  await navigateInto('reports');

  // Only at its own level does the file appear.
  expect(await screen.findByText('q1.pdf')).toBeInTheDocument();
});

/* ------------------------------------------------------------- the breadcrumb */

it('the breadcrumb names every ancestor and clicking one navigates there', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--reports--q1.pdf')]);

  await openBrowser();
  await navigateInto('docs');
  await navigateInto('reports');

  const path = screen.getByRole('navigation', { name: 'Folder path' });
  expect(path).toHaveTextContent('files');
  expect(path).toHaveTextContent('docs');
  expect(path).toHaveTextContent('reports');

  // The current folder is where we are, not a control; its ancestors are.
  expect(screen.queryByRole('button', { name: 'reports' })).toBeNull();
  expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument();

  vi.mocked(listObjects).mockClear();
  await navigateInto('docs');

  // Back one level: `docs` is now the current crumb and its child is a row again.
  expect(listObjects).toHaveBeenCalledWith(
    expect.objectContaining({ store: 'files' }),
    'docs--',
    expect.anything(),
  );
  expect(await screen.findByRole('button', { name: 'reports' })).toBeInTheDocument();
});

/* --------------------------------------------------------------- new folder */

it('New folder writes a marker, and an existing folder is refused LOUDLY rather than overwritten', async () => {
  await openBrowser();
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('New folder name'), 'notes');
  await user.click(screen.getByRole('button', { name: 'New folder' }));

  await waitFor(() => {
    expect(putObject).toHaveBeenCalledTimes(1);
  });
  const written = vi.mocked(putObject).mock.calls[0];
  expect(written?.[1]).toBe('notes--');
  // An empty body is refused by the service, so the marker carries bytes.
  const bytes = written?.[2];
  if (bytes === undefined) throw new Error('the marker was written with no bytes');
  expect(bytes.length).toBeGreaterThan(0);

  // Now the folder EXISTS. Creating it again is a loud refusal, not a silent
  // no-op overwrite of the marker.
  vi.mocked(listObjects).mockResolvedValue([entry('notes--')]);
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('button', { name: 'notes' });

  vi.mocked(putObject).mockClear();
  errorSpy.mockClear();
  await user.type(screen.getByLabelText('New folder name'), 'notes');
  await user.click(screen.getByRole('button', { name: 'New folder' }));

  await waitFor(() => {
    expect(allToasts()).toMatch(/already exists/);
  });
  expect(putObject).not.toHaveBeenCalled();
});

it('a new folder inside a folder writes its marker under that folder’s prefix', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--a.txt')]);

  await openBrowser();
  await navigateInto('docs');
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('New folder name'), 'reports');
  await user.click(screen.getByRole('button', { name: 'New folder' }));

  await waitFor(() => {
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      'docs--reports--',
      expect.any(Uint8Array),
    );
  });
});

/* ------------------------------------------------------ upload into a folder */

it('an upload into a folder shows the FULL object name in the review and writes it there', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--a.txt')]);
  vi.mocked(openFile).mockResolvedValue(picked('Report.TXT', [7, 7, 7]));

  await openBrowser();
  await navigateInto('docs');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));

  // The review shows the FULL store name the file will live under, before any write.
  expect(await screen.findByText('docs--report.txt')).toBeInTheDocument();
  expect(putObject).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: 'Upload 1 object' }));
  await waitFor(() => {
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      'docs--report.txt',
      expect.any(Uint8Array),
    );
  });
});

it('the same file name in two different folders is NOT a collision, but the same name in the SAME folder is', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--report.txt')]);
  vi.mocked(openFile).mockResolvedValue(picked('Report.TXT', [7, 7, 7]));

  await openBrowser();
  const user = userEvent.setup();

  // At the ROOT this file maps to `report.txt`, which does not exist — the
  // `docs--report.txt` in another folder is a DIFFERENT object name.
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  expect(await screen.findByText('report.txt')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).toBeNull();

  // Moving folders discards the pending review (the panel is keyed by the folder),
  // so nothing is written under a name reviewed for a folder the owner has left.
  await navigateInto('docs');
  expect(screen.queryByRole('checkbox')).toBeNull();

  // In `docs` the SAME file maps to the FULL name that already exists.
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));
  const checkbox = await screen.findByRole('checkbox');
  const label = checkbox.closest('label');
  expect(label).not.toBeNull();
  expect(label).toHaveTextContent('docs--report.txt');
  expect(label).toHaveTextContent('Report.TXT');
});

it('an upload into a folder whose full name would exceed the 1024 bound is refused with a reason before any request', async () => {
  // A legal folder whose prefix already spends the whole name budget: 1022
  // characters + the 2-character separator leaves NO room for a file name.
  const longSegment = 'a'.repeat(1022);
  vi.mocked(listObjects).mockResolvedValue([entry(`${longSegment}--`)]);
  vi.mocked(openFile).mockResolvedValue(picked('notes.txt', [1, 2, 3]));

  await openBrowser();
  await navigateInto(longSegment);

  vi.mocked(listObjects).mockClear();
  vi.mocked(putObject).mockClear();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Choose files…' }));

  await waitFor(() => {
    expect(allToasts()).toMatch(/leaves no room for a file name/);
  });
  // Refused before ANY request: no write, and not even the collision listing.
  expect(putObject).not.toHaveBeenCalled();
  expect(listObjects).not.toHaveBeenCalled();
});

/* ----------------------------------------------------------- delete a folder */

it('deleting a folder confirms with the COUNT, and a partial failure reports what remains instead of claiming success', async () => {
  vi.mocked(listObjects).mockResolvedValue([
    entry('docs--'),
    entry('docs--a.txt'),
    entry('docs--b.txt'),
  ]);

  await openBrowser();
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'Delete folder docs' }));

  // The confirmation names the COUNT of objects that will go, markers included,
  // and nothing has been deleted yet.
  expect(screen.getByText(/3 objects will be deleted/)).toBeInTheDocument();
  expect(deleteObject).not.toHaveBeenCalled();

  vi.mocked(deleteObject)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      new ServerStoreError('forbidden', 'ServerStore refused (forbidden): no delete permission', {
        status: 403,
        serverMessage: 'no delete permission',
      }),
    );

  await user.click(screen.getByRole('button', { name: 'Yes, delete folder docs' }));

  await waitFor(() => {
    expect(allToasts()).toContain('no delete permission');
  });
  // HONEST about the partial state: what was deleted, and what remains.
  expect(allToasts()).toMatch(/Deleted 1 object/);
  expect(allToasts()).toMatch(/2 objects remain/);
  // NEVER a success claim, and no request was issued after the failure.
  expect(allSuccessToasts()).not.toContain('Deleted the folder');
  expect(deleteObject).toHaveBeenCalledTimes(2);
});

it('a 429 while deleting a folder is reported with the wait and stops', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('docs--'), entry('docs--a.txt')]);
  vi.mocked(deleteObject).mockRejectedValue(
    new ServerStoreError('rate_limited', 'ServerStore refused (rate_limited): slow down', {
      status: 429,
      serverMessage: 'slow down',
      retryAfterSeconds: 42,
    }),
  );

  await openBrowser();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Delete folder docs' }));
  await user.click(screen.getByRole('button', { name: 'Yes, delete folder docs' }));

  await waitFor(() => {
    expect(allToasts()).toMatch(/42s wait/);
  });
  // STOPPED: the second object was never attempted, and nothing claims success.
  expect(deleteObject).toHaveBeenCalledTimes(1);
  expect(allSuccessToasts()).not.toContain('Deleted the folder');
});

/* ------------------------------------------- file actions inside a folder */

it('downloading or deleting a file inside a folder uses the FULL object name', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const digest = await sha256Hex(bytes);
  vi.mocked(listObjects).mockResolvedValue([
    entry('docs--report.txt', { sha256: digest, size: bytes.length }),
  ]);
  vi.mocked(getObject).mockResolvedValue({
    bytes,
    sha256: digest,
    contentType: 'application/octet-stream',
  });

  await openBrowser();
  await navigateInto('docs');

  // The row shows the readable part...
  expect(await screen.findByText('report.txt')).toBeInTheDocument();
  const user = userEvent.setup();
  // ... while the download addresses the FULL object name, on the wire AND on disk.
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => {
    expect(getObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      'docs--report.txt',
    );
  });
  const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
  expect(anchor?.download).toBe('docs--report.txt');

  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await user.click(screen.getByRole('button', { name: 'Yes, delete docs--report.txt' }));
  await waitFor(() => {
    expect(deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'files' }),
      'docs--report.txt',
    );
  });
});
