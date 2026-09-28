import { expect, it } from 'vitest';

import { sha256Hex } from '@/lib/sha256';

/**
 * Ledger row 9 — THE DIGEST SEAM.
 *
 * This is the function the download flow uses to answer one question: are the
 * bytes that arrived the bytes ServerStore's `x-serverstore-sha256` header
 * describes? So the pins are the PUBLISHED vectors (FIPS 180-4's own examples),
 * not a re-run of the implementation: a helper that agreed with itself would
 * certify nothing. `tests/setup.ts` installs Node's WebCrypto as
 * `crypto.subtle`, because jsdom has none — the same algorithm, the same
 * async-ness, so these vectors are the real thing.
 */

it('a known byte string digests to the PUBLISHED SHA-256, in lowercase hex', async () => {
  // FIPS 180-4 / NIST's example: SHA-256("abc").
  const digest = await sha256Hex(new Uint8Array([0x61, 0x62, 0x63]));
  expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

it('the empty byte string digests to the published empty SHA-256 (hashing is not a size check)', async () => {
  const digest = await sha256Hex(new Uint8Array([]));
  expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

it('any input yields exactly 64 lowercase hex characters — no uppercase, no base64, no padding', async () => {
  const bytes = new Uint8Array(1000);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) % 256;
  const digest = await sha256Hex(bytes);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
});
