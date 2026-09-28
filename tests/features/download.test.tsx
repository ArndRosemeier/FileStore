import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { FileBrowser } from '@/features/files/FileBrowser';
import { sha256Hex } from '@/lib/sha256';
import {
  getObject,
  listObjects,
  type ObjectEntry,
  type StoreTarget,
  type WhoAmI,
} from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';

/**
 * Ledger row 9 — THE DOWNLOAD PIN, and the statement it holds:
 *
 *   **The received bytes are verified against the service's own
 *   `x-serverstore-sha256`, and a mismatch REFUSES the save — unverified bytes
 *   are never written to disk.**
 *
 * The save seam is the REAL one (`src/lib/saveFile.ts`), not a mock, because the
 * property being pinned is exactly that nothing reaches `createWritable` — and
 * jsdom has no `showSaveFilePicker`, so the real seam takes its anchor branch. The
 * anchor's `click` and `URL.createObjectURL` are what "written to disk" is
 * observed through; both are stubbed here because jsdom implements neither, the
 * same way `tests/lib/saveFile.test.ts` stubs them.
 *
 * The store transport is MOCKED; the digest is the REAL `crypto.subtle` digest
 * that `tests/setup.ts` installs Node's WebCrypto for.
 */

vi.mock('@/server/store-client', () => ({
  whoami: vi.fn(),
  listObjects: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));

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

const BYTES = new Uint8Array([1, 2, 3, 4]);

const errorSpy = vi.spyOn(toast, 'error');
const successSpy = vi.spyOn(toast, 'success');

function allToasts(): string {
  return errorSpy.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
    .join(' | ');
}

function entry(name: string, sha256: string): ObjectEntry {
  return {
    store: 'files',
    name,
    sha256,
    size: BYTES.length,
    createdAt: '2026-09-28T14:27:54.773Z',
  };
}

let createdUrls: Blob[];
let createObjectUrl: MockInstance<(blob: Blob | MediaSource) => string>;
let revokeObjectUrl: MockInstance<(url: string) => void>;
let clickSpy: MockInstance<() => void>;

/**
 * A cancellation has NO observable outcome — that is the point of it — so the
 * click handler's promise chain is flushed explicitly before asserting that
 * nothing was toasted and nothing was fetched.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  createdUrls = [];
  createObjectUrl = vi.fn((blob: Blob | MediaSource) => {
    createdUrls.push(blob as Blob);
    return 'blob:test';
  });
  URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL;
  revokeObjectUrl = vi.fn();
  URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL;
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  // ONLY the anchor spy is restored: `vi.restoreAllMocks()` would also restore
  // the module-scope toast spies below, and the later tests in this file would
  // then assert against a `toast.error` the code no longer calls.
  clickSpy.mockRestore();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

async function renderAndDownload(sha256: string): Promise<void> {
  vi.mocked(listObjects).mockResolvedValue([entry('report.txt', sha256)]);
  vi.mocked(getObject).mockResolvedValue({
    bytes: BYTES,
    sha256,
    contentType: 'application/octet-stream',
  });

  render(<FileBrowser target={TARGET} who={WHO} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download' }));
}

it('a digest MISMATCH refuses the save: unverified bytes are never written', async () => {
  const claimed = 'f'.repeat(64);
  const received = await sha256Hex(BYTES);

  await renderAndDownload(claimed);

  await waitFor(() => {
    expect(allToasts()).toMatch(/x-serverstore-sha256/);
  });
  // Both digests are named, so the owner can tell what arrived from what the
  // service claimed.
  expect(allToasts()).toContain(received);
  expect(allToasts()).toContain(claimed);
  // NOTHING reached the disk: neither an object URL nor a download click.
  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
  expect(successSpy).not.toHaveBeenCalled();
});

it('a verified download goes through the save seam with the object name and the exact bytes', async () => {
  const digest = await sha256Hex(BYTES);

  await renderAndDownload(digest);

  await waitFor(() => {
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
  const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined;
  expect(anchor?.download).toBe('report.txt');
  expect(anchor?.getAttribute('href')).toBe('blob:test');

  const saved = createdUrls[0];
  if (saved === undefined) throw new Error('nothing was saved');
  // The store holds no MIME type (ledger row 2), so the honest one is what the
  // service sent: `application/octet-stream`.
  expect(saved.type).toBe('application/octet-stream');
  expect(Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(Array.from(BYTES));
});

it('a CANCELLED save produces NO toast and NO error — and fetches nothing', async () => {
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: () => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')),
  });
  vi.mocked(listObjects).mockResolvedValue([entry('report.txt', 'a'.repeat(64))]);

  render(<FileBrowser target={TARGET} who={WHO} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download' }));
  await settle();

  expect(errorSpy).not.toHaveBeenCalled();
  expect(successSpy).not.toHaveBeenCalled();
  // The picker runs BEFORE the bytes are built: a cancel costs no fetch at all.
  expect(getObject).not.toHaveBeenCalled();
  expect(createObjectUrl).not.toHaveBeenCalled();
});

it('a failed object read surfaces the service’s own message and saves nothing', async () => {
  vi.mocked(listObjects).mockResolvedValue([entry('report.txt', 'a'.repeat(64))]);
  vi.mocked(getObject).mockRejectedValue(
    new ServerStoreError('not_found', 'ServerStore refused (not_found): no such object', {
      status: 404,
      serverMessage: 'no such object',
    }),
  );

  render(<FileBrowser target={TARGET} who={WHO} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Download' }));

  await waitFor(() => {
    expect(allToasts()).toContain('no such object');
  });
  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
});
