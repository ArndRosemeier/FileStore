import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import { App } from '@/App';
import {
  deleteObject,
  getObject,
  listObjects,
  putObject,
  whoami,
  type WhoAmI,
} from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';
import { SETTINGS_STORAGE_KEY, writeSettings, type Settings } from '@/settings/settings';

/**
 * Ledger rows 1, 3 and 9 — THE SETTINGS SURFACE, and the four statements this
 * file holds:
 *
 *  * with no stored key the app shows the form, says it is NOT CONFIGURED and
 *    issues NO store request at all — an honest first run, not an error;
 *  * a CORRUPT stored value is surfaced with its own `problem` text, never
 *    silently replaced by a blank form;
 *  * the key is a password: the field masks it and the panel warns that it is
 *    stored in this browser;
 *  * "Forget key" clears ONLY the key and returns the app to the unconfigured
 *    state, leaving `baseUrl` and `store` as the owner set them.
 *
 * The panel's "Test connection" is the other half: it PROVES the key with
 * `whoami` and shows what the key is (label, stores, permissions). The store
 * transport is mocked; the settings seam is the real one, so `localStorage` is
 * the state under test.
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

const CONFIGURED: Settings = {
  baseUrl: 'http://127.0.0.1:8477',
  store: 'files',
  key: 'ssk_TESTKEY_not_a_real_credential',
};

const errorSpy = vi.spyOn(toast, 'error');

/** The string message of a recorded toast call, or `''` when none was recorded. */
function recordedToast(index: number): string {
  const message = errorSpy.mock.calls[index]?.[0];
  return typeof message === 'string' ? message : '';
}

function storedSettings(): Settings | null {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (raw === null) return null;
  return JSON.parse(raw) as Settings;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(whoami).mockResolvedValue(WHO);
  vi.mocked(listObjects).mockResolvedValue([]);
});

it('with no stored key the app renders the settings form, says it is NOT CONFIGURED, and issues NO store request', () => {
  render(<App />);

  expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
  expect(screen.getByLabelText('Store')).toBeInTheDocument();
  expect(screen.getByLabelText('Key')).toBeInTheDocument();
  expect(screen.getByText(/not configured/i)).toBeInTheDocument();

  // The pin: an unconfigured app proves nothing and asks for nothing.
  expect(whoami).not.toHaveBeenCalled();
  expect(listObjects).not.toHaveBeenCalled();
  expect(getObject).not.toHaveBeenCalled();
  expect(putObject).not.toHaveBeenCalled();
  expect(deleteObject).not.toHaveBeenCalled();
});

it('a CORRUPT stored value is SURFACED with its problem text, never silently ignored', () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, '{ this is not json');

  render(<App />);

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('the stored value is not valid JSON');
  // The defaults are what the owner is offered as a fresh start — and nothing
  // was requested while the stored value is unreadable.
  expect(screen.getByLabelText('Store')).toHaveValue('files');
  expect(whoami).not.toHaveBeenCalled();
});

it('a corrupt value that IS json but not settings names the failing field, and still no request', () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ baseUrl: 42, store: 'files' }));

  render(<App />);

  expect(screen.getByRole('alert')).toHaveTextContent('baseUrl');
  expect(whoami).not.toHaveBeenCalled();
});

it('the key field is a password and the panel warns that the key is stored in this browser', () => {
  render(<App />);

  expect(screen.getByLabelText('Key')).toHaveAttribute('type', 'password');
  expect(screen.getByText(/stored in this browser/i)).toBeInTheDocument();
});

it('"Forget key" clears the key, leaves baseUrl and store as they were, and returns the app to unconfigured', async () => {
  const user = userEvent.setup();
  writeSettings(CONFIGURED);
  render(<App />);
  await screen.findByText(/connected as/i);

  await user.click(screen.getByRole('button', { name: 'Forget key' }));

  expect(storedSettings()).toEqual({ ...CONFIGURED, key: '' });
  expect(screen.getByLabelText('Key')).toHaveValue('');
  expect(screen.getByLabelText('Base URL')).toHaveValue(CONFIGURED.baseUrl);
  expect(screen.getByLabelText('Store')).toHaveValue(CONFIGURED.store);
  expect(screen.getByText(/not configured/i)).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByText(/connected as/i)).toBeNull();
  });
});

it('"Test connection" proves the DRAFT key with whoami and reports its label, stores and permissions', async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.clear(screen.getByLabelText('Base URL'));
  await user.type(screen.getByLabelText('Base URL'), CONFIGURED.baseUrl);
  await user.clear(screen.getByLabelText('Store'));
  await user.type(screen.getByLabelText('Store'), CONFIGURED.store);
  await user.type(screen.getByLabelText('Key'), CONFIGURED.key);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));

  expect(await screen.findByText(/Key “Arnd”/)).toBeInTheDocument();
  expect(screen.getByText(/read, write, delete/)).toBeInTheDocument();
  expect(screen.getByText(/stores: files/)).toBeInTheDocument();
  expect(whoami).toHaveBeenCalledTimes(1);
  expect(whoami).toHaveBeenCalledWith(CONFIGURED);
});

it('a failed "Test connection" shows the service’s own words inline AND through the toast surface', async () => {
  const user = userEvent.setup();
  vi.mocked(whoami).mockRejectedValue(
    new ServerStoreError('unauthorized', 'ServerStore refused (unauthorized): that key is unknown', {
      status: 401,
      serverMessage: 'that key is unknown',
    }),
  );
  render(<App />);

  await user.type(screen.getByLabelText('Key'), CONFIGURED.key);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));

  expect(await screen.findByText(/that key is unknown/)).toBeInTheDocument();
  expect(recordedToast(0)).toContain('that key is unknown');
  // The credential itself is never in the toast.
  expect(recordedToast(0)).not.toContain(CONFIGURED.key);
});

it('after a FAILED request the key appears in NO rendered text and NO toast', async () => {
  vi.mocked(whoami).mockRejectedValue(
    new ServerStoreError(
      'unauthorized',
      `ServerStore refused (unauthorized): the key ${CONFIGURED.key} was rejected`,
      { status: 401, serverMessage: `the key ${CONFIGURED.key} was rejected` },
    ),
  );
  writeSettings(CONFIGURED);

  render(<App />);

  // The failure IS shown (this is not silence) …
  expect(await screen.findByText(/was rejected/)).toBeInTheDocument();
  // … and the credential is nowhere in it: not in the rendered tree (the two
  // panels, the banner, the password field), not in any toast, not in the URL.
  expect(document.body.textContent).not.toContain(CONFIGURED.key);
  expect(recordedToast(0)).not.toContain(CONFIGURED.key);
  expect(recordedToast(0)).toContain('[redacted]');
  expect(window.location.href).not.toContain(CONFIGURED.key);
});

it('a FAILED test of a DRAFT key redacts THAT key too, not only the stored one', async () => {
  // The stored key is deliberately a PREFIX of the draft one: redacting the
  // shorter string first would leave `[redacted]_credential_111` — a partial
  // leak — so this pin also holds the longest-credential-first order.
  const STORED = 'ssk_STORED_old';
  const DRAFT = 'ssk_STORED_old_credential_111';
  const user = userEvent.setup();
  writeSettings({ ...CONFIGURED, key: STORED });
  // The shell proves the STORED key first; only the panel's manual probe sees the
  // draft, and it is refused with the draft key echoed back (the same threat
  // model as the stored-key pin above: a proxy echoing the header).
  vi.mocked(whoami)
    .mockResolvedValueOnce(WHO)
    .mockRejectedValue(
      new ServerStoreError(
        'unauthorized',
        `ServerStore refused (unauthorized): the key ${DRAFT} was rejected`,
        { status: 401, serverMessage: `the key ${DRAFT} was rejected` },
      ),
    );

  render(<App />);
  await screen.findByText(/connected as/i);
  await user.clear(screen.getByLabelText('Key'));
  await user.type(screen.getByLabelText('Key'), DRAFT);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));

  // The credential IN USE is redacted in BOTH surfaces, in full.
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('the key [redacted] was rejected');
  expect(document.body.textContent).not.toContain(DRAFT);
  expect(document.body.textContent).not.toContain(STORED);
  expect(recordedToast(0)).not.toContain(DRAFT);
  expect(recordedToast(0)).toContain('[redacted]');
});

it('saving an invalid Base URL is refused LOUDLY and writes nothing', async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.clear(screen.getByLabelText('Base URL'));
  await user.type(screen.getByLabelText('Base URL'), 'not-a-url');
  await user.click(screen.getByRole('button', { name: 'Save settings' }));

  await waitFor(() => {
    expect(errorSpy).toHaveBeenCalled();
  });
  // The failure names the failing FIELD, and the stored value is untouched.
  expect(recordedToast(0)).toContain('baseUrl');
  expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  expect(whoami).not.toHaveBeenCalled();
});

it('saving a valid key persists it, proves it, and reaches the store browser', async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.type(screen.getByLabelText('Key'), CONFIGURED.key);
  await user.click(screen.getByRole('button', { name: 'Save settings' }));

  await waitFor(() => {
    expect(whoami).toHaveBeenCalledTimes(1);
  });
  expect(storedSettings()).toEqual({
    baseUrl: 'https://store.futuremagic.de',
    store: 'files',
    key: CONFIGURED.key,
  });
  expect(await screen.findByText(/connected as/i)).toBeInTheDocument();
});
