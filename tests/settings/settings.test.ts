import { expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  forgetKey,
  readSettings,
  SETTINGS_STORAGE_KEY,
  writeSettings,
  type Settings,
} from '@/settings/settings';

/**
 * Ledger row 3 / row 8 — THE SETTINGS SEAM. It is the ONLY thing in this app
 * that persists across a reload, so these pins hold the two rules that make it
 * safe to keep a credential in `localStorage`:
 *
 *   1. a stored value that fails validation is REPORTED (`corrupt` + `problem`),
 *      never silently replaced by the defaults (rule 1);
 *   2. the key is a password: it stays in `localStorage` and nowhere else, which
 *      is why no assertion below ever formats it into a message the app could
 *      show.
 *
 * `tests/setup.ts` clears `localStorage` before every test, so each one starts
 * from the state a fresh browser load has.
 */

const CONFIGURED: Settings = {
  baseUrl: 'http://127.0.0.1:8477',
  store: 'files',
  key: 'ssk_TESTKEY_not_a_real_credential',
};

it('nothing stored is a first run: the defaults, status `ok`, not corruption', () => {
  expect(readSettings()).toEqual({ status: 'ok', settings: DEFAULT_SETTINGS });
  expect(DEFAULT_SETTINGS.store).toBe('files');
});

it('a write→read round-trip returns the same three values', () => {
  writeSettings(CONFIGURED);
  expect(readSettings()).toEqual({ status: 'ok', settings: CONFIGURED });
});

it('a round-trip stores the values under the ONE documented storage key', () => {
  writeSettings(CONFIGURED);
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw ?? 'null')).toEqual(CONFIGURED);
});

it('an explicit empty key survives the round-trip (it is a value, not an absence)', () => {
  writeSettings({ ...DEFAULT_SETTINGS, key: '' });
  expect(readSettings()).toEqual({ status: 'ok', settings: { ...DEFAULT_SETTINGS, key: '' } });
});

it('invalid JSON is REPORTED as corrupt, with the defaults and a problem — never silent', () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json');

  const read = readSettings();
  expect(read.status).toBe('corrupt');
  expect(read.settings).toEqual(DEFAULT_SETTINGS);
  if (read.status !== 'corrupt') return;
  expect(read.problem).toContain('JSON');
  // The corrupt value is still THERE — a read never rewrites storage.
  expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe('{not json');
});

it('a wrong SHAPE is REPORTED as corrupt, naming the field, and still keeps the defaults', () => {
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ baseUrl: 'https://store.futuremagic.de', store: 42 }),
  );

  const read = readSettings();
  expect(read.status).toBe('corrupt');
  expect(read.settings).toEqual(DEFAULT_SETTINGS);
  if (read.status !== 'corrupt') return;
  expect(read.problem).toContain('store');
});

it('a value that is not even an object is corrupt, not a crash', () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify('nonsense'));
  const read = readSettings();
  expect(read.status).toBe('corrupt');
  expect(read.settings).toEqual(DEFAULT_SETTINGS);
});

it('an unknown extra field is REFUSED, so a stale schema cannot smuggle state through', () => {
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...CONFIGURED, legacyToken: 'left-over' }),
  );
  expect(readSettings().status).toBe('corrupt');
});

it('a bad value passed to writeSettings THROWS and writes nothing', () => {
  const bad = { ...CONFIGURED, baseUrl: 'not a url' };
  expect(() => {
    writeSettings(bad);
  }).toThrow();
  expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
});

it('the thrown validation error names the failing FIELD and never the credential value', () => {
  const secret = 'ssk_THIS_VALUE_MUST_NOT_APPEAR_ANYWHERE';
  const bad = { ...CONFIGURED, baseUrl: 'not a url', key: secret };

  let thrown: unknown;
  try {
    writeSettings(bad);
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const text = thrown instanceof Error ? `${thrown.message}${thrown.stack ?? ''}` : '';
  expect(text).toContain('baseUrl');
  expect(text).not.toContain(secret);
});

it('a corrupt stored value never leaks its content into the reported problem', () => {
  const secret = 'ssk_THIS_VALUE_MUST_NOT_APPEAR_ANYWHERE';
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ key: secret }));

  const read = readSettings();
  expect(read.status).toBe('corrupt');
  if (read.status !== 'corrupt') return;
  expect(read.problem).toContain('baseUrl');
  expect(read.problem).not.toContain(secret);
});

it('forgetKey clears ONLY the key and leaves baseUrl and store exactly as they were', () => {
  writeSettings(CONFIGURED);
  forgetKey();

  expect(readSettings()).toEqual({ status: 'ok', settings: { ...CONFIGURED, key: '' } });
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  expect(raw).not.toBeNull();
  const stored = JSON.parse(raw ?? 'null') as Record<string, unknown>;
  expect(stored.baseUrl).toBe(CONFIGURED.baseUrl);
  expect(stored.store).toBe(CONFIGURED.store);
  expect(stored.key).toBe('');
});

it('forgetKey on a store that holds nothing is a no-op, not a crash', () => {
  forgetKey();
  expect(readSettings()).toEqual({ status: 'ok', settings: DEFAULT_SETTINGS });
});
