import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { storeTargetFrom, useStore } from '@/app/useStore';
import { errorMessage } from '@/lib/toast';
import { whoami, type WhoAmI } from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';

/**
 * Ledger row 9 — THE CONNECTION STATE, and the two rules it exists for:
 *
 *  1. **A key is PROVEN with `whoami`, not assumed from reachability.** `healthz`
 *     needs no key, so a green health check would say nothing about the
 *     credential; `whoami` is the operation the connection state is built on.
 *  2. **Nothing throws into the app shell.** A refused key becomes the `failed`
 *     state, which the shell renders — an exception escaping a hook would unmount
 *     the tree and leave a blank page.
 *
 * The store transport is MOCKED here (`vi.mock`), never re-implemented: the
 * module under test is the hook's state machine, not the HTTP seam.
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

const TARGET: Settings = {
  baseUrl: 'https://store.futuremagic.de',
  store: 'files',
  key: 'ssk_TESTKEY_not_a_real_credential',
};

/** A consumer of the hook: the hook has no DOM of its own, and this is its shell. */
function Probe({ settings }: { settings: Settings }): React.JSX.Element {
  const connection = useStore(settings);
  const detail =
    connection.status === 'ready'
      ? connection.who.label
      : connection.status === 'failed'
        ? errorMessage(connection.error)
        : '';
  return <p data-testid="state">{`${connection.status}|${detail}`}</p>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

it('with no key the hook is `unconfigured` and proves NOTHING with whoami', () => {
  render(<Probe settings={DEFAULT_SETTINGS} />);

  expect(screen.getByTestId('state')).toHaveTextContent('unconfigured|');
  expect(whoami).not.toHaveBeenCalled();
});

it('a whitespace-only key is the same honest first run, not a request with a blank credential', () => {
  render(<Probe settings={{ ...DEFAULT_SETTINGS, key: '   ' }} />);

  expect(screen.getByTestId('state')).toHaveTextContent('unconfigured|');
  expect(whoami).not.toHaveBeenCalled();
});

it('a stored key becomes `ready` carrying the WhoAmI, proven through whoami', async () => {
  vi.mocked(whoami).mockResolvedValue(WHO);

  render(<Probe settings={TARGET} />);

  await waitFor(() => {
    expect(screen.getByTestId('state')).toHaveTextContent('ready|Arnd');
  });
  expect(whoami).toHaveBeenCalledTimes(1);
  expect(whoami).toHaveBeenCalledWith(storeTargetFrom(TARGET), expect.any(AbortSignal));
});

it('a refused key becomes `failed` carrying the error, and NOTHING throws into the shell', async () => {
  vi.mocked(whoami).mockRejectedValue(
    new ServerStoreError('unauthorized', 'ServerStore refused (unauthorized): bad key', {
      status: 401,
      serverMessage: 'bad key',
    }),
  );

  render(<Probe settings={TARGET} />);

  await waitFor(() => {
    expect(screen.getByTestId('state')).toHaveTextContent('failed|');
  });
  // The failure is CARRIED and renderable: the shell is still mounted and the
  // service's own words are in the state.
  expect(screen.getByTestId('state')).toHaveTextContent('bad key');
  expect(whoami).toHaveBeenCalledTimes(1);
});

it('changing the settings proves the NEW key again', async () => {
  vi.mocked(whoami).mockResolvedValue(WHO);

  const view = render(<Probe settings={TARGET} />);
  await waitFor(() => {
    expect(screen.getByTestId('state')).toHaveTextContent('ready|Arnd');
  });

  view.rerender(<Probe settings={{ ...TARGET, key: 'ssk_ANOTHER_not_a_real_credential' }} />);
  await waitFor(() => {
    expect(whoami).toHaveBeenCalledTimes(2);
  });
  expect(vi.mocked(whoami).mock.calls[1]?.[0]).toEqual({
    ...TARGET,
    key: 'ssk_ANOTHER_not_a_real_credential',
  });
});
