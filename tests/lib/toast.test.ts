import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  ERROR_TOAST_DURATION_MS,
  errorMessage,
  redactCredential,
  toastError,
  toastSuccess,
} from '@/lib/toast';
import { ServerStoreError } from '@/server/store-errors';
import { writeSettings, type Settings } from '@/settings/settings';

/**
 * Ledger row 9 — THE ONE ERROR/NOTIFICATION SURFACE (rule 2).
 *
 * The pins here are about POLICY, not about sonner:
 *
 *  * a real error does NOT auto-dismiss;
 *  * the service's OWN message is what the owner reads;
 *  * a 429 carries the wait the service asked for;
 *  * the key never survives into a toast — even when the service's `message`
 *    echoes it back, which is arbitrary text a proxy controls;
 *  * the text rendered inline by a component is the SAME text the toast shows,
 *    because a second composition is a second place for the credential to leak.
 *
 * `tests/setup.ts` dismisses sonner's toasts after each test (an error toast is
 * not allowed to auto-dismiss, so it would otherwise outlive its test).
 */

const SECRET = 'ssk_TESTKEY_not_a_real_credential';

const errorSpy = vi.spyOn(toast, 'error');
const successSpy = vi.spyOn(toast, 'success');

/** The string message of a recorded toast call, or `''` when none was recorded. */
function recordedMessage(spy: typeof errorSpy, index: number): string {
  const message = spy.mock.calls[index]?.[0];
  return typeof message === 'string' ? message : '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

it('a store failure surfaces the service’s own message, with its code', () => {
  toastError(
    new ServerStoreError('not_found', 'ServerStore refused (not_found): no such store', {
      status: 404,
      serverMessage: 'no such store',
    }),
    'Could not list the store',
  );

  const message = recordedMessage(errorSpy, 0);
  expect(message).toContain('Could not list the store');
  expect(message).toContain('no such store');
  expect(message).toContain('not_found');
});

it('a real error is shown until the owner dismisses it — it never auto-dismisses', () => {
  toastError(new Error('the disk disappeared'));

  expect(errorSpy.mock.calls[0]?.[1]?.duration).toBe(ERROR_TOAST_DURATION_MS);
  expect(ERROR_TOAST_DURATION_MS).toBe(Number.POSITIVE_INFINITY);
});

it('a 429 is reported WITH the wait the service asked for, and says it was not retried', () => {
  toastError(
    new ServerStoreError('rate_limited', 'ServerStore refused (rate_limited): slow down', {
      status: 429,
      serverMessage: 'slow down',
      retryAfterSeconds: 30,
    }),
  );

  const message = recordedMessage(errorSpy, 0);
  expect(message).toContain('slow down');
  expect(message).toContain('30s');
  expect(message).toMatch(/nothing was retried/i);
});

it('the key never survives into a toast, even when the service’s message echoes it back', () => {
  writeSettings({
    baseUrl: 'https://store.example',
    store: 'files',
    key: SECRET,
  } satisfies Settings);

  toastError(
    new ServerStoreError(
      'unauthorized',
      `ServerStore refused (unauthorized): the key ${SECRET} was rejected`,
      { status: 401, serverMessage: `the key ${SECRET} was rejected` },
    ),
    'Could not use the key',
  );

  const message = recordedMessage(errorSpy, 0);
  expect(message).not.toContain(SECRET);
  expect(message).toContain('[redacted]');
  // The failure is still SHOWN: redaction removes the credential, not the error.
  expect(message).toContain('was rejected');
});

it('the credential is redacted at EVERY occurrence, not only the first', () => {
  writeSettings({ baseUrl: 'https://store.example', store: 'files', key: SECRET });

  const redacted = redactCredential(`first ${SECRET} then ${SECRET} again`);
  expect(redacted).not.toContain(SECRET);
  expect(redacted).toBe('first [redacted] then [redacted] again');
});

it('an empty stored key redacts nothing, so ordinary text is never mangled', () => {
  expect(redactCredential('nothing secret here')).toBe('nothing secret here');
});

it('the text a caller renders inline is the SAME redacted text the toast shows', () => {
  writeSettings({ baseUrl: 'https://store.example', store: 'files', key: SECRET });
  const failure = new ServerStoreError(
    'forbidden',
    `ServerStore refused (forbidden): key ${SECRET} may not read that store`,
    { status: 403, serverMessage: `key ${SECRET} may not read that store` },
  );

  toastError(failure, 'Could not list the store');

  expect(errorMessage(failure, 'Could not list the store')).toBe(recordedMessage(errorSpy, 0));
  expect(recordedMessage(errorSpy, 0)).not.toContain(SECRET);
});

it('a value that is not an Error still produces a readable message, never an empty toast', () => {
  toastError('the proxy answered with a string');

  expect(recordedMessage(errorSpy, 0)).toContain('the proxy answered with a string');
});

it('a success notification goes through the same surface', () => {
  toastSuccess('Uploaded 2 objects.');

  expect(successSpy).toHaveBeenCalledWith('Uploaded 2 objects.');
});
