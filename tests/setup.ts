import '@testing-library/jest-dom/vitest';

import { webcrypto } from 'node:crypto';

import { cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach } from 'vitest';

/*
 * jsdom implements no `SubtleCrypto` (MEASURED: jsdom 30's `Crypto` carries
 * `getRandomValues`/`randomUUID` only), so any code that verifies an object's
 * `sha256` would throw in every test. Node's WebCrypto is installed under the
 * SAME name with the SAME method signature and the SAME async-ness — an honest
 * stand-in for the algorithm, not a fake digest (a double that invents a
 * different shape certifies code the real object refuses).
 */
Object.defineProperty(globalThis.crypto, 'subtle', {
  configurable: true,
  value: webcrypto.subtle,
});

afterEach(() => {
  cleanup();
  // `toastError` uses `duration: Infinity` (a real error must not vanish on its
  // own), so a toast outlives its test unless it is dismissed. Two tests in one
  // file that both fail a run would otherwise leave the second one asserting
  // against the first one's toast too.
  toast.dismiss();
});

// Every test starts from the state a fresh browser load has: no stored
// settings. The settings seam is the ONE thing that persists across reloads,
// so leaking it between tests would hide exactly the bugs it can have.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // No localStorage in this environment; nothing to reset.
  }
});
