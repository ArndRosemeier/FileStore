/**
 * THE folder-path seam (ledger row 10): the ONE place the FOLDER CONVENTION
 * lives.
 *
 * ServerStore has NO directories, NO metadata, NO rename route and only a
 * `?prefix=` listing filter. So a folder here is not storage: it is a naming
 * convention over the one flat object list, plus a client-side view of it. This
 * module owns the convention; the UI that renders it is a separate slice.
 *
 * THE SEPARATOR IS `--`, AND IT IS RESERVED FOR FREE. `src/lib/name.ts`'s
 * `collapseDashes` (`replace(/-+/g, '-')`) means `toObjectName` can never emit
 * two adjacent dashes, so no mapped file name can contain `--`. That is what
 * makes splitting exact at any depth — and it is a PIN, not a hope
 * (`tests/lib/folder.test.ts`). A TRAILING `--` is therefore an empty-folder
 * marker no mapped name can collide with.
 *
 * WHY A SEGMENT IS MORE THAN A LEGAL OBJECT NAME. A segment must be a legal
 * store name, but that is not sufficient: the object-name language also allows
 * `a--b` and `a-`, and either one as a SEGMENT would make
 * `formatFolderPath`/`parseFolderPath` (and `joinFolder`/`splitObjectName`)
 * ambiguous — `joinFolder(['a-'], 'b')` would be `'a---b'`, which splits back as
 * folder `['a']` and file `'-b'`. So {@link isFolderSegment} ALSO refuses a
 * segment containing the separator or ending in `-`. That is a strictly
 * stronger rule than "a legal store name", and it is what makes the inverse
 * pins true at ANY depth.
 *
 * WHAT THIS SEAM REFUSES TO DO: guess. A malformed path THROWS
 * ({@link FolderPathError}) rather than being sanitised into a different folder
 * — the same rule as `src/lib/name.ts` (rule 1). `isFolderMarkerName` is the one
 * deliberate exception, and not a fallback: it is a PREDICATE over a name that
 * may be any object in the store (including one another client wrote), so "no"
 * is an answer, not a swallowed failure.
 *
 * A NOTE ON THE IMPORT CYCLE: `name.ts` imports this module's helpers, and this
 * module imports `name.ts`'s ONE name rule (`isLegalObjectName`,
 * `OBJECT_NAME_MAX_LENGTH`) rather than restating it (rule 4). The cycle is safe
 * because neither module calls the other at module-evaluation time — every
 * cross-reference happens inside a function body, after both are initialised.
 */

import { isLegalObjectName, OBJECT_NAME_MAX_LENGTH } from './name';

/** The one separator at every level. Unproducible by `toObjectName` (see header). */
export const FOLDER_SEPARATOR = '--';

/** A folder path as segments; `[]` is the root. Never a raw string — that is `string`. */
export type FolderPath = readonly string[];

/**
 * Thrown when a string is not a folder path under this convention, or when a
 * composition would produce a name that is not a legal object name. LOUD by
 * design (rule 1): no caller gets a silently different folder.
 */
export class FolderPathError extends Error {
  /** The path (or name) that could not be interpreted, kept for the caller's message. */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${JSON.stringify(path)} is not a folder path: ${reason}`);
    this.name = 'FolderPathError';
    this.path = path;
  }
}

/**
 * True when `value` is ONE legal folder segment: a legal ServerStore object name
 * that is neither empty nor ambiguous at a separator boundary.
 *
 * The two extra refusals earn their place (header): a segment containing
 * {@link FOLDER_SEPARATOR}, or ending in `-`, would make the join/split pair
 * non-invertible.
 */
export function isFolderSegment(value: string): boolean {
  return isLegalObjectName(value) && !value.includes(FOLDER_SEPARATOR) && !value.endsWith('-');
}

/**
 * The ONE validity rule for a whole path, returned as a reason or `null`. Shared
 * by `parseFolderPath`, `assertFolderPath` and `isFolderMarkerName` so the rule
 * is written once (rule 4) and a predicate never has to catch a throw.
 */
function folderPathRefusal(segments: readonly string[]): string | null {
  for (const segment of segments) {
    if (!isFolderSegment(segment)) {
      return `the segment ${JSON.stringify(segment)} is not one legal folder segment`;
    }
  }
  const text = segments.join(FOLDER_SEPARATOR);
  if (segments.length > 0 && text.length + FOLDER_SEPARATOR.length > OBJECT_NAME_MAX_LENGTH) {
    return (
      `it needs ${text.length + FOLDER_SEPARATOR.length} characters as a ` +
      `?prefix=, over the store's ${OBJECT_NAME_MAX_LENGTH}-character name bound`
    );
  }
  return null;
}

/** Throw {@link FolderPathError} unless `segments` is a valid, navigable path. */
function assertFolderPath(segments: readonly string[]): void {
  const refusal = folderPathRefusal(segments);
  if (refusal !== null) throw new FolderPathError(segments.join(FOLDER_SEPARATOR), refusal);
}

/**
 * Parse a folder path: `''` is the root, `'a--b'` is `['a','b']`. A malformed
 * path (an illegal segment, an empty segment, a trailing separator) THROWS
 * {@link FolderPathError}; nothing is dropped or sanitised.
 *
 * The whole path must also be NAVIGABLE — `formatFolderPath(path) + '--'` must
 * fit the name bound — because a path the listing cannot be filtered by is not a
 * folder this app can show. That is the same 1024 characters the file part
 * shares.
 */
export function parseFolderPath(path: string): FolderPath {
  if (path === '') return [];
  const segments = path.split(FOLDER_SEPARATOR);
  assertFolderPath(segments);
  return segments;
}

/** Format a folder path: `['a','b']` → `'a--b'`, `[]` → `''`. Pure; does not validate. */
export function formatFolderPath(path: FolderPath): string {
  return path.join(FOLDER_SEPARATOR);
}

/**
 * The `?prefix=` value for a folder: `'a--b--'` (each segment and the separator
 * after it), and `''` at the root — which is the store's documented "no filter",
 * i.e. the whole listing.
 *
 * The value is itself a LEGAL object-name prefix (pinned): `?prefix=` obeys the
 * SAME name parser as a name, so an over-long path is `400 invalid_name` and
 * would break navigation loudly rather than silently.
 */
export function folderPrefix(path: FolderPath): string {
  assertFolderPath(path);
  if (path.length === 0) return '';
  return `${formatFolderPath(path)}${FOLDER_SEPARATOR}`;
}

/**
 * The empty-folder MARKER object name for a non-root path: the path plus a
 * TRAILING separator (`['a','b']` → `'a--b--'`).
 *
 * An empty body is refused by the service and an empty folder has nothing to
 * exist as, so the folder is recorded as a zero-content object whose NAME is the
 * prefix. A mapped name can never equal it (it would need `--`). The ROOT has no
 * marker: the root always exists, so asking for one is a LOUD refusal rather
 * than a fabricated name.
 */
export function folderMarkerName(path: FolderPath): string {
  if (path.length === 0) {
    throw new FolderPathError('', 'the root has no empty-folder marker: the root always exists');
  }
  assertFolderPath(path);
  return `${formatFolderPath(path)}${FOLDER_SEPARATOR}`;
}

/**
 * True when `objectName` is exactly an empty-folder marker: it ends with the
 * separator AND the part before it is a valid non-root folder path.
 *
 * A predicate, so an ordinary object name answers `false` (the header explains
 * why that is not a swallowed parse error).
 */
export function isFolderMarkerName(objectName: string): boolean {
  if (!objectName.endsWith(FOLDER_SEPARATOR)) return false;
  const pathText = objectName.slice(0, -FOLDER_SEPARATOR.length);
  if (pathText === '') return false;
  return folderPathRefusal(pathText.split(FOLDER_SEPARATOR)) === null;
}

/**
 * Join a folder path and an object name into the full store name:
 * `(['docs','reports'], 'report.pdf')` → `'docs--reports--report.pdf'`; at the
 * root the name is returned unchanged.
 *
 * The result is asserted to be a legal object name, so this seam can never hand
 * a caller an unnameable string (rule 1).
 */
export function joinFolder(path: FolderPath, objectName: string): string {
  assertFolderPath(path);
  if (path.length === 0) {
    if (!isLegalObjectName(objectName)) {
      throw new FolderPathError('', `${JSON.stringify(objectName)} is not a legal object name`);
    }
    return objectName;
  }
  const joined = `${formatFolderPath(path)}${FOLDER_SEPARATOR}${objectName}`;
  if (!isLegalObjectName(joined)) {
    throw new FolderPathError(formatFolderPath(path), `${JSON.stringify(joined)} is not a legal object name`);
  }
  return joined;
}

/**
 * The exact inverse of {@link joinFolder}: `'docs--reports--report.pdf'` →
 * `{ folder: ['docs','reports'], filePart: 'report.pdf' }`; a name with no
 * separator is a root file.
 *
 * A marker name (`'a--b--'`), an ambiguous name, or a name that is not legal at
 * all THROWS — the caller asked what FILE a name denotes, and a marker denotes
 * no file.
 */
export function splitObjectName(objectName: string): { folder: FolderPath; filePart: string } {
  if (!isLegalObjectName(objectName)) {
    throw new FolderPathError(objectName, 'it is not a legal object name');
  }
  const parts = objectName.split(FOLDER_SEPARATOR);
  if (parts.length === 1) return { folder: [], filePart: objectName };
  const filePart = parts[parts.length - 1] ?? '';
  if (filePart === '') {
    throw new FolderPathError(
      objectName,
      `it ends with the separator ${JSON.stringify(FOLDER_SEPARATOR)}, so it is an empty-folder marker, not a file`,
    );
  }
  return { folder: parseFolderPath(parts.slice(0, -1).join(FOLDER_SEPARATOR)), filePart };
}

/** The folder one level up; the parent of the root is the root. */
export function parentFolder(path: FolderPath): FolderPath {
  return path.length === 0 ? [] : path.slice(0, -1);
}

/**
 * The breadcrumb for `path`, ROOT FIRST, including `path` itself:
 * `['docs','reports']` → `[[], ['docs'], ['docs','reports']]`, and the root's
 * breadcrumb is `[[]]` (one crumb — the root).
 */
export function ancestors(path: FolderPath): FolderPath[] {
  const crumbs: FolderPath[] = [];
  for (let depth = 0; depth <= path.length; depth += 1) crumbs.push(path.slice(0, depth));
  return crumbs;
}

/** How many levels deep `path` is; the root is `0`. */
export function folderDepth(path: FolderPath): number {
  return path.length;
}
