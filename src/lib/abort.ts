/**
 * The owner-cancelled test, in ONE place.
 *
 * Both browser seams (`src/lib/saveFile.ts`, `src/lib/openFile.ts`) must treat a
 * dismissed dialog as an OUTCOME and everything else as a real failure —
 * `saveFile`'s header explains why. The check is by NAME (`'AbortError'`), read
 * STRUCTURALLY rather than with `instanceof`, because a `DOMException` created in
 * another realm (an iframe, a worker's error crossing a boundary) is not
 * `instanceof` this realm's `DOMException`, and an `instanceof` test would then
 * report the owner's cancel as a real error and toast at him.
 *
 * It lives in its own module because two copies of this predicate is exactly the
 * drift rule 4 forbids: the two seams must never disagree about what a cancel is.
 */

/** True when `error` is the browser's "the owner dismissed the dialog" signal. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
