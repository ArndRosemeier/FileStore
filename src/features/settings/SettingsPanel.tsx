/**
 * The settings panel (ledger rows 1, 3 and 9): the three settings the app has
 * (`baseUrl`, `store`, `key`), the warning the credential rule requires, the
 * "Forget key" action, and a "Test connection" that proves the key with `whoami`.
 *
 * THE PANEL NEVER WRITES STORAGE ITSELF. Saving and forgetting go through the
 * callbacks the shell hands it, which call the ONE settings seam
 * (`src/settings/settings.ts`) — so there is exactly one place that persists a
 * credential, and its zod validation and its credential rules apply unchanged.
 *
 * THE KEY'S WARNING IS NOT DECORATION (ledger row 3): the key persists in
 * `localStorage` across reloads by deliberate decision, and the cost of that
 * decision is a visible statement of it plus a way out. Both are here, and both
 * are pinned.
 *
 * A CORRUPT STORED VALUE IS SURFACED (rule 1): `readSettings()` reports
 * `{status:'corrupt', problem}` when something IS stored and is not valid
 * settings. The panel shows that problem text — naming the failing field, never
 * the value — beside the defaults it offers as a fresh start. Silently showing a
 * blank form would hide a real defect in whatever wrote that value.
 *
 * "TEST CONNECTION" PROVES THE KEY, it does not just ping the host: it calls
 * `whoami`, the same operation the shell's connection state is built on, and shows
 * what the key IS — its label, its stores and its permissions. It probes the DRAFT
 * values, so a key can be checked before it is saved. A failure is shown inline
 * AND through the ONE error surface; a success shows the `WhoAmI`.
 */

import { useState } from 'react';

import { storeTargetFrom } from '@/app/useStore';
import { errorMessage, toastError } from '@/lib/toast';
import { whoami, type WhoAmI } from '@/server/store-client';
import type { Settings, SettingsRead } from '@/settings/settings';

export interface SettingsPanelProps {
  /** The last READ of the settings, including a `corrupt` report to surface. */
  settingsRead: SettingsRead;
  /** Persist the draft. The shell owns the write and its failure. */
  onSaved: (settings: Settings) => void;
  /** Clear ONLY the stored key; the shell re-reads the settings afterwards. */
  onForgotten: () => void;
}

/** What the manual probe is doing right now. */
type ProbeState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; who: WhoAmI }
  | { status: 'failed'; error: unknown };

export function SettingsPanel({
  settingsRead,
  onSaved,
  onForgotten,
}: SettingsPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<Settings>(settingsRead.settings);
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });

  function forget(): void {
    try {
      onForgotten();
    } catch (error: unknown) {
      // The write failed, so the credential is STILL STORED: the form must keep
      // showing it, and the failure must be loud (rule 1). Showing a cleared form
      // here would be the silent lie.
      toastError(error, 'Could not forget the key');
      return;
    }
    // The form follows the action: the key field is cleared, and nothing else the
    // owner typed in it is thrown away by a "forget the key" action.
    setDraft((current) => ({ ...current, key: '' }));
    setProbe({ status: 'idle' });
  }

  async function testConnection(): Promise<void> {
    setProbe({ status: 'testing' });
    try {
      const who = await whoami(storeTargetFrom(draft));
      setProbe({ status: 'ok', who });
    } catch (error: unknown) {
      setProbe({ status: 'failed', error });
      toastError(error, 'The connection test failed');
    }
  }

  return (
    <section
      aria-labelledby="settings-heading"
      className="border-edge bg-surface-raised rounded-lg border p-4"
    >
      <h2 id="settings-heading" className="text-lg font-medium">
        Settings
      </h2>

      {settingsRead.status === 'corrupt' ? (
        <p role="alert" className="text-danger mt-2 text-sm">
          Your saved settings could not be read: {settingsRead.problem}. Nothing has been
          overwritten — the form below shows the defaults, and saving replaces the stored value.
        </p>
      ) : null}

      <p className="text-ink-muted mt-2 text-sm">
        Your key is stored in this browser (<code>localStorage</code>) and is sent only to the store
        you configure here. It is a password: use “Forget key” on a shared computer.
      </p>

      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor="settings-base-url" className="text-sm">
          Base URL
        </label>
        <input
          id="settings-base-url"
          type="url"
          className="border-edge bg-surface rounded border px-2 py-1"
          value={draft.baseUrl}
          onChange={(event) => {
            setDraft((current) => ({ ...current, baseUrl: event.target.value }));
          }}
        />
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor="settings-store" className="text-sm">
          Store
        </label>
        <input
          id="settings-store"
          type="text"
          className="border-edge bg-surface rounded border px-2 py-1"
          value={draft.store}
          onChange={(event) => {
            setDraft((current) => ({ ...current, store: event.target.value }));
          }}
        />
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor="settings-key" className="text-sm">
          Key
        </label>
        <input
          id="settings-key"
          type="password"
          autoComplete="off"
          className="border-edge bg-surface rounded border px-2 py-1"
          value={draft.key}
          onChange={(event) => {
            setDraft((current) => ({ ...current, key: event.target.value }));
          }}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="bg-accent text-surface rounded px-3 py-1.5 text-sm font-medium"
          onClick={() => {
            onSaved(draft);
          }}
        >
          Save settings
        </button>
        <button
          type="button"
          className="border-edge rounded border px-3 py-1.5 text-sm"
          onClick={forget}
        >
          Forget key
        </button>
        <button
          type="button"
          className="border-edge rounded border px-3 py-1.5 text-sm"
          onClick={() => {
            void testConnection();
          }}
          disabled={probe.status === 'testing'}
        >
          Test connection
        </button>
      </div>

      {probe.status === 'testing' ? (
        <p className="text-ink-muted mt-3 text-sm">Testing the key…</p>
      ) : null}

      {probe.status === 'ok' ? (
        <p className="mt-3 text-sm">
          Key “{probe.who.label}” — stores:{' '}
          {probe.who.stores.length === 0 ? '(none)' : probe.who.stores.join(', ')} — permissions:{' '}
          {probe.who.perms.length === 0 ? '(none)' : probe.who.perms.join(', ')}.
        </p>
      ) : null}

      {probe.status === 'failed' ? (
        <p role="alert" className="text-danger mt-3 text-sm">
          {errorMessage(probe.error, 'The connection test failed')}
        </p>
      ) : null}
    </section>
  );
}
