import { expect, it } from 'vitest';

import {
  formatByteSize,
  formatObjectCount,
  formatTimestamp,
  shortSha256,
} from '@/lib/format';

/**
 * Ledger row 9 — THE DISPLAY HELPERS, and the two rules that make them pinnable:
 *
 *  1. **Deterministic.** No `Intl`, no locale, no machine time zone: the same
 *     value reads the same on every host, which is the only way a pin can hold.
 *     The timestamps are rendered in UTC WITH the `UTC` suffix, because that is
 *     the zone the service stored.
 *  2. **No silent fallback** (rule 1). A size that is not a byte count is a LOUD
 *     `RangeError`; a timestamp the service did not send in a parseable form is
 *     shown AS SENT rather than replaced by an invented date.
 */

it('a byte count reads in binary units, with the service’s own 64 MiB limit legible', () => {
  expect(formatByteSize(0)).toBe('0 B');
  expect(formatByteSize(1)).toBe('1 B');
  expect(formatByteSize(999)).toBe('999 B');
  expect(formatByteSize(1024)).toBe('1 KiB');
  expect(formatByteSize(1536)).toBe('1.5 KiB');
  expect(formatByteSize(1024 * 1024)).toBe('1 MiB');
  expect(formatByteSize(64 * 1024 * 1024)).toBe('64 MiB');
});

it('a size that is not a real byte count is a LOUD refusal, never a plausible 0 B', () => {
  expect(() => formatByteSize(-1)).toThrow(RangeError);
  expect(() => formatByteSize(Number.NaN)).toThrow(RangeError);
  expect(() => formatByteSize(Number.POSITIVE_INFINITY)).toThrow(RangeError);
});

it('an ISO timestamp reads as the UTC instant the service stored', () => {
  expect(formatTimestamp('2026-09-28T14:27:54.773Z')).toBe('2026-09-28 14:27 UTC');
  expect(formatTimestamp('2026-01-02T03:04:05.000Z')).toBe('2026-01-02 03:04 UTC');
});

it('a timestamp that is not a parseable date is shown EXACTLY as sent, never invented', () => {
  expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  expect(formatTimestamp('')).toBe('');
});

it('a digest is shortened for display and never rendered in full', () => {
  const full = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  expect(shortSha256(full)).toBe('abcdef012345…');
  expect(shortSha256('short')).toBe('short');
});

it('the object count is singular only for exactly one object', () => {
  expect(formatObjectCount(0)).toBe('0 objects');
  expect(formatObjectCount(1)).toBe('1 object');
  expect(formatObjectCount(3)).toBe('3 objects');
});
