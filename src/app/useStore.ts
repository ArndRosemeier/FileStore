/**
 * The connection state of the app (ledger row 9): whether the configured key is
 * usable, proven by `whoami` before any other request is made.
 *
 * WHY `whoami` AND NOT `healthz`: reachability is not permission.
 * `GET /healthz` needs no key at all, so a green health check would prove nothing
 * about the credential — ServerStore's own console makes the same point
 * (`~/projects/ServerStore/docs/API.md` §The admin UI: "Nothing is fetched until
 * the key is proven"). `whoami` is the ONE way to prove a key, and it is what the
 * connection state is built from.
 *
 * THE FOUR STATES, and why `unconfigured` is not one of the failures:
 *
 * | state          | meaning                                                        |
 * |----------------|----------------------------------------------------------------|
 * | `unconfigured` | no key is stored. The honest FIRST-RUN state — never an error.   |
 * | `connecting`   | a key is stored and `whoami` is in flight.                      |
 * | `ready`        | the key is proven, carrying the `WhoAmI` the service returned.   |
 * | `failed`       | the probe was refused or unreachable, carrying the error.        |
 *
 * NOTHING THROWS INTO THE APP SHELL. A rejected `whoami` is caught here and
 * becomes the `failed` state; the shell renders it and offers a retry. An
 * exception escaping a hook would unmount the tree and leave the owner with a
 * blank page — the loud error rule 1 wants, achieved by *showing* the failure
 * rather than by crashing.
 *
 * THE KEY IS NEVER SENT FROM HERE. This module builds a {@link StoreTarget} — the
 * settings carried into the one shape the transport seam takes — and
 * `src/server/store-client.ts` is still the only module that reads it into a
 * header. A second `Authorization` builder is what `tests/architecture/one-fetch.test.ts`
 * exists to refuse.
 */

import { useEffect, useState } from 'react';

import { whoami, type StoreTarget, type WhoAmI } from '@/server/store-client';
import type { Settings } from '@/settings/settings';

/** What the shell needs to know about the configured key, and nothing more. */
export type StoreConnection =
  | { status: 'unconfigured' }
  | { status: 'connecting' }
  | { status: 'ready'; who: WhoAmI }
  | { status: 'failed'; error: unknown };

/**
 * The ONE place the three settings become a transport target. Both the automatic
 * probe below and the Settings panel's "Test connection" build it here, so there
 * is no second copy of the mapping to drift.
 */
export function storeTargetFrom(settings: Settings): StoreTarget {
  return { baseUrl: settings.baseUrl, store: settings.store, key: settings.key };
}

/** True when there is no key at all — the first-run state, not a failure. */
function isUnconfigured(settings: Settings): boolean {
  return settings.key.trim() === '';
}

/**
 * Probe the configured key with `whoami` whenever the settings change.
 *
 * The effect's dependencies are the three PRIMITIVE settings, not the settings
 * object: a caller that builds a fresh object each render must not re-probe on
 * every render.
 */
export function useStore(settings: Settings): StoreConnection {
  const { baseUrl, store, key } = settings;
  const [connection, setConnection] = useState<StoreConnection>(() =>
    isUnconfigured(settings) ? { status: 'unconfigured' } : { status: 'connecting' },
  );

  useEffect(() => {
    if (key.trim() === '') {
      setConnection({ status: 'unconfigured' });
      return;
    }

    const controller = new AbortController();
    let current = true;
    setConnection({ status: 'connecting' });

    void whoami({ baseUrl, store, key }, controller.signal).then(
      (who) => {
        if (current) setConnection({ status: 'ready', who });
      },
      (error: unknown) => {
        if (current) setConnection({ status: 'failed', error });
      },
    );

    return () => {
      // A settings change or an unmount abandons the probe: the rejection it
      // causes is this cleanup's own doing, so it must NOT become a failure.
      current = false;
      controller.abort();
    };
  }, [baseUrl, store, key]);

  return connection;
}
