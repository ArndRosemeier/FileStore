/**
 * THE settings seam (ledger row 3): the ONE persisted state of the app —
 * `baseUrl`, `store`, `key`.
 *
 * WHY `localStorage` FOR A CREDENTIAL: this is a deliberate decision with a
 * recorded rejected alternative, not an oversight. ServerStore's own admin
 * console keeps its master key in a page variable and forgets it on reload
 * (`~/projects/ServerStore/docs/API.md` §The admin UI); FileStore is a utility
 * the owner returns to, and re-pasting a password on every reload is how a
 * credential ends up in a notes file instead. The cost is carried where the
 * owner can see it: the UI warns that the key is stored in this browser and
 * offers a **"Forget key"** action ({@link forgetKey}).
 *
 * THE CREDENTIAL RULE, enforced here as far as this seam can (AGENTS.md):
 *   - the key is never written anywhere but `localStorage` under
 *     {@link SETTINGS_STORAGE_KEY};
 *   - it is never logged, never put in a URL, never put in a message. That is
 *     why {@link readSettings} reports `problem` as the failing PATH plus the
 *     schema's own reason and never `JSON.stringify(storedValue)` — a problem
 *     string travels into a toast, and a toast must never carry the key;
 *   - {@link writeSettings} throws zod's `ZodError` on a bad value rather than
 *     writing it. The thrown error names the failing path; a zod issue does not
 *     echo the input value.
 *
 * NO SILENT FALLBACK (rule 1): a stored value that fails validation is REPORTED
 * — `{status:'corrupt'}` with the defaults handed back for the owner to inspect
 * and re-save — never quietly overwritten by the defaults. A read of an EMPTY
 * store is not corruption: that is a first run, and it is `ok` with the default
 * preferences.
 */

import { z } from 'zod';

/** The three settings, validated at both boundaries. */
export const settingsSchema = z.strictObject({
  /** The ServerStore origin, e.g. `https://store.futuremagic.de`. */
  baseUrl: z.url(),
  /**
   * The store objects live in. A legal ServerStore name
   * (`[a-z0-9][a-z0-9._-]{0,63}`) — the same language `src/lib/name.ts` maps
   * object names into, and the store name is provisioned by the operator.
   */
  store: z.string().min(1),
  /** The scoped access key (`ssk_…`). A credential: see the header. */
  key: z.string(),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * The first-run state. The base URL is the deployed service (the one this app
 * ships against), the store is the one the owner asked for, and the key is empty
 * — the honest "not configured yet" state, never a stand-in for a real key.
 */
export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://store.futuremagic.de',
  store: 'files',
  key: '',
};

/**
 * Where the settings live. ONE key; a name change here loses every owner's saved
 * settings, so it is a constant, not a literal at each call site.
 */
export const SETTINGS_STORAGE_KEY = 'filestore.settings';

/**
 * What a read found.
 *
 * `corrupt` is the LOUD case: something IS stored and it is not valid settings,
 * so the app must say so. `settings` in that branch is {@link DEFAULT_SETTINGS}
 * — what the owner is offered as a fresh start — and `problem` says what was
 * wrong, by PATH, never by value.
 */
export type SettingsRead =
  { status: 'ok'; settings: Settings } | { status: 'corrupt'; settings: Settings; problem: string };

/** `localStorage`, or `undefined` in an environment that has none. */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // A browser with storage disabled (or a non-browser environment) throws on
    // ACCESS. That is "no stored settings", not corruption.
    return undefined;
  }
}

/**
 * Describe a failed validation by PATH and by zod's own message. Deliberately
 * built from `issue.path`/`issue.message` only — the stored value never enters
 * the string, because the string is shown to the owner.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Parse a stored JSON string into settings, or say LOUDLY why not. */
function parseStored(raw: string): SettingsRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'corrupt',
      settings: DEFAULT_SETTINGS,
      problem: `the stored value is not valid JSON (${reason})`,
    };
  }

  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) {
    return {
      status: 'corrupt',
      settings: DEFAULT_SETTINGS,
      problem: `the stored value is not valid settings (${describeIssues(parsed.error)})`,
    };
  }
  return { status: 'ok', settings: parsed.data };
}

/**
 * Read the settings. Nothing stored is `ok` with {@link DEFAULT_SETTINGS}; a
 * stored value that fails validation is `corrupt` and NAMES the problem.
 */
export function readSettings(): SettingsRead {
  const store = storage();
  if (store === undefined) return { status: 'ok', settings: DEFAULT_SETTINGS };

  const raw = store.getItem(SETTINGS_STORAGE_KEY);
  if (raw === null) return { status: 'ok', settings: DEFAULT_SETTINGS };
  return parseStored(raw);
}

/**
 * Persist all three settings. THROWS zod's `ZodError` when a value is invalid —
 * a bad value is never written and never half-written. The whole object is
 * serialised (an explicit `key: ''` is preserved, not treated as absent).
 */
export function writeSettings(settings: Settings): void {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw parsed.error;
  }
  const store = storage();
  if (store === undefined) {
    throw new Error('This browser has no localStorage, so the settings cannot be saved.');
  }
  store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(parsed.data));
}

/**
 * Clear ONLY the key, leaving `baseUrl` and `store` as the owner set them.
 *
 * A corrupt stored value cannot be edited field by field, so it is replaced by
 * the defaults with the key cleared — which still removes exactly the credential
 * and reports nothing as if it had been fine.
 */
export function forgetKey(): void {
  const current = readSettings();
  writeSettings(
    current.status === 'ok' ? { ...current.settings, key: '' } : { ...DEFAULT_SETTINGS, key: '' },
  );
}
