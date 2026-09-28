/**
 * Display formatting, as PURE functions (ledger row 9).
 *
 * The listing gives four facts and nothing else — `name`, `sha256`, `size`,
 * `createdAt` (`~/projects/ServerStore/docs/API.md`) — and the UI shows exactly
 * those, formatted. Each helper here is deterministic on purpose: no locale, no
 * `Intl`, no `Date` formatting that depends on the machine's time zone. A size or
 * a timestamp that reads differently on two machines is a display that cannot be
 * pinned, and a pin that cannot hold a property is not evidence.
 *
 * NO SILENT FALLBACK (rule 1): a size that is not a real byte count is a LOUD
 * `RangeError` rather than a plausible-looking `0 B`; a timestamp the service did
 * not send in a parseable form is shown AS SENT rather than replaced by an
 * invented date.
 */

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

const BYTES_PER_UNIT = 1024;

/** The service's own request ceiling, quoted in the UI's refusals. */
export const SERVERSTORE_MAX_BYTES = 64 * BYTES_PER_UNIT * BYTES_PER_UNIT;

/**
 * A byte count as a short human label: `0 B`, `999 B`, `1 KiB`, `1.5 KiB`,
 * `64 MiB`. Binary units (`KiB`), because the service's own limit is stated in
 * them (`SERVERSTORE_MAX_BYTES` defaults to 64 MiB).
 *
 * THROWS a `RangeError` for anything that is not a non-negative finite count: the
 * listing schema already refuses that (rule 3), so reaching here with one is a
 * bug, and a bug must not be formatted into a number the owner will believe.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`formatByteSize needs a non-negative finite byte count, got ${String(bytes)}.`);
  }
  if (bytes < BYTES_PER_UNIT) return `${String(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  const label = BYTE_UNITS[unit];
  const rounded = value.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded} ${String(label)}`;
}

/** Two digits, always: `7` → `07`. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * An ISO-8601 timestamp as a UTC label: `2026-09-28T14:27:54.773Z` →
 * `2026-09-28 14:27 UTC`.
 *
 * The `UTC` suffix is not decoration. The service stores a UTC instant and the
 * owner may be anywhere, so the one honest display is the zone it actually is;
 * rendering it in the machine's local zone would make two people read the same
 * object differently, and would make the pin depend on the test host's `TZ`.
 *
 * A value that is not a parseable date is returned EXACTLY as the service sent
 * it (rule 1): showing the raw string is honest, inventing a date is not.
 */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return (
    `${String(parsed.getUTCFullYear())}-${pad2(parsed.getUTCMonth() + 1)}-${pad2(parsed.getUTCDate())}` +
    ` ${pad2(parsed.getUTCHours())}:${pad2(parsed.getUTCMinutes())} UTC`
  );
}

/** How many leading hex characters of a digest the listing shows. */
export const SHORT_SHA256_LENGTH = 12;

/**
 * A digest shortened FOR DISPLAY: the first 12 characters and an ellipsis. The
 * full value is never lost — the UI puts it in the element's `title` — because a
 * shortened hash is a label, not the identity the integrity check uses.
 */
export function shortSha256(sha256: string): string {
  if (sha256.length <= SHORT_SHA256_LENGTH) return sha256;
  return `${sha256.slice(0, SHORT_SHA256_LENGTH)}…`;
}

/** `1 object` / `3 objects` — the count line's own grammar, in one place. */
export function formatObjectCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'object' : 'objects'}`;
}
