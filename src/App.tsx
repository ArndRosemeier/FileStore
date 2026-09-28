/**
 * The app shell (ledger row 9): the ONE component that decides which of the
 * app's states the owner is looking at.
 *
 * The shell owns exactly two pieces of state and nothing else:
 *
 *  * the last settings READ (`readSettings`), which carries a `corrupt` report
 *    when something stored is not valid settings — the panel shows it, and the
 *    shell never overwrites it silently;
 *  * the connection state, from {@link useStore}, which proves the stored key
 *    with `whoami`.
 *
 * THE FOUR RENDERED STATES, and the first is the important one:
 *
 *  1. **No key** — the settings form plus "Not configured". This is an honest
 *     first run, NOT an error, and the shell issues NO store request at all.
 *  2. **Connecting** — the key is being proven.
 *  3. **Ready** — the file browser, with the settings panel still reachable.
 *  4. **Failed** — the failure shown inline AND through the ONE error surface
 *     (rule 2). Nothing is swallowed and nothing crashes.
 *
 * `<h1>FileStore</h1>` is load-bearing: `tests/app/shell.test.tsx` asserts the
 * app's accessible name, and that pin must keep passing whatever the body does.
 */

import { useEffect, useState } from 'react';

import { storeTargetFrom, useStore } from '@/app/useStore';
import { FileBrowser } from '@/features/files/FileBrowser';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { errorMessage, toastError } from '@/lib/toast';
import {
  forgetKey,
  readSettings,
  writeSettings,
  type Settings,
  type SettingsRead,
} from '@/settings/settings';

/** One connection failure, one toast — React's development double effect included. */
export const CONNECTION_TOAST_ID = 'store-connection';

export function App(): React.JSX.Element {
  const [settingsRead, setSettingsRead] = useState<SettingsRead>(() => readSettings());
  const settings = settingsRead.settings;
  const connection = useStore(settings);

  const connectionError = connection.status === 'failed' ? connection.error : null;
  useEffect(() => {
    if (connectionError === null) return;
    // An automatic probe has no click to report through, so the failure is
    // toasted here as well as rendered inline below.
    toastError(connectionError, 'Could not use the key', { id: CONNECTION_TOAST_ID });
  }, [connectionError]);

  function saveSettings(next: Settings): void {
    try {
      writeSettings(next);
      setSettingsRead({ status: 'ok', settings: next });
    } catch (error: unknown) {
      // `writeSettings` throws zod's error on an invalid value and writes
      // nothing (rule 1). The state keeps the last good settings.
      toastError(error, 'The settings were not saved');
    }
  }

  function forget(): void {
    // Deliberately NOT caught here. If `forgetKey` throws (no `localStorage`, a
    // refused write) the credential was NOT cleared, and the panel that asked for
    // it is the one that knows not to show a cleared form. The panel surfaces it.
    forgetKey();
    setSettingsRead(readSettings());
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">FileStore</h1>
        <p className="text-ink-muted mt-1 text-sm">
          Put files into your ServerStore and take them out again.
        </p>
      </header>

      <SettingsPanel settingsRead={settingsRead} onSaved={saveSettings} onForgotten={forget} />

      <section aria-label="Connection" className="text-sm">
        {connection.status === 'unconfigured' && (
          <p className="text-ink-muted">
            Not configured — paste a ServerStore key in Settings to begin. Nothing has been
            requested from the store.
          </p>
        )}
        {connection.status === 'connecting' && <p className="text-ink-muted">Connecting to the store…</p>}
        {connection.status === 'ready' && <p>Connected as “{connection.who.label}”.</p>}
        {connection.status === 'failed' && (
          <p role="alert" className="text-danger">
            {errorMessage(connection.error, 'Could not use the key')}
          </p>
        )}
      </section>

      {connection.status === 'ready' ? (
        <FileBrowser target={storeTargetFrom(settings)} who={connection.who} />
      ) : null}
    </main>
  );
}
