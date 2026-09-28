/**
 * THE name-mapping seam (ledger row 2): the ONE place a real file name becomes a
 * ServerStore object name.
 *
 * THE RULE THE STORE ACTUALLY ENFORCES, read from the authority rather than
 * guessed: `~/projects/ServerStore/src/core/validate.ts` holds
 * `NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/` and refuses `.`/`..` as a whole
 * name and any name starting with `.` or `/`. It PARSES names, it never
 * sanitises them — so a name like `My Report (final).PDF` is a 400
 * (`invalid_name`) if sent verbatim, and the rewriting has to happen HERE, once,
 * before any request exists.
 *
 * WHY THE MAPPING IS SHOWN TO THE OWNER BEFORE AN UPLOAD: the object name is the
 * file name, sanitized, and the ORIGINAL NAME IS NOT STORED ANYWHERE (ledger row
 * 2 — the store holds a name and bytes, nothing more). So this seam returns
 * `changed` alongside the name, and the UI puts the mapping in front of the owner
 * so nothing is renamed silently. That is what `changed` is FOR; it is not
 * decoration.
 *
 * WHAT THIS SEAM REFUSES TO DO: return a placeholder. A name that cannot become a
 * legal object name throws ({@link ObjectNameMappingError}) — an empty name, a
 * name of dots (`'...'`), or anything the pattern still rejects. A fabricated
 * name would be a silent fallback (rule 1) and would also be data loss: the owner
 * believes he stored `...` and something else is in the store.
 *
 * DETERMINISM: the lowering step is `toLowerCase()`, NEVER `toLocaleLowerCase()`.
 * A locale-sensitive lower would make the same file map to different object names
 * on a Turkish-locale browser (`I` → `ı`), i.e. the store's contents would depend
 * on a browser setting. Only ASCII survives the mapping anyway, so the two agree
 * on everything that can reach the store — the rule is written down because the
 * next reader will wonder.
 */

/** The store's own limit: 64 characters total (`NAME_MAX_LENGTH` in ServerStore). */
export const OBJECT_NAME_MAX_LENGTH = 64;

/**
 * The legal object-name language, anchored: `[a-z0-9][a-z0-9._-]{0,63}`.
 *
 * Anchored on purpose — an unanchored test would accept `'notes.txt '` or
 * `'../notes.txt'` as "legal", which is exactly the class of bug this constant
 * exists to prevent.
 */
export const OBJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** True when `name` is, on its own, a legal ServerStore object name. */
export function isLegalObjectName(name: string): boolean {
  return OBJECT_NAME_PATTERN.test(name);
}

/** The result of mapping a file name: the object name, and whether it differs. */
export interface ObjectNameMapping {
  /** A name the store will accept; always matches {@link OBJECT_NAME_PATTERN}. */
  objectName: string;
  /** True when `objectName !== fileName` — i.e. the owner is about to see a rename. */
  changed: boolean;
}

/**
 * Thrown when a file name cannot be turned into a legal object name at all. It is
 * LOUD by design (rule 1): the caller shows it, and no request is made.
 */
export class ObjectNameMappingError extends Error {
  /** The file name that could not be mapped, kept for the caller's message. */
  readonly fileName: string;

  constructor(fileName: string, reason: string) {
    super(`${JSON.stringify(fileName)} cannot be stored: ${reason}`);
    this.name = 'ObjectNameMappingError';
    this.fileName = fileName;
  }
}

/** The last path segment, for both separators: a picked name is NOT trusted as a path. */
function basename(fileName: string): string {
  let cut = -1;
  for (let index = 0; index < fileName.length; index += 1) {
    const char = fileName[index];
    if (char === '/' || char === '\\') cut = index;
  }
  return fileName.slice(cut + 1);
}

/** Every character the store does not accept becomes one `-`. */
function replaceIllegalCharacters(value: string): string {
  return value.replace(/[^a-z0-9._-]/g, '-');
}

/** Runs of `-` collapse to one, so `a  b` and `a - b` do not produce different names. */
function collapseDashes(value: string): string {
  return value.replace(/-+/g, '-');
}

/**
 * Drop everything before the first alphanumeric character. This is what removes a
 * leading `.` (the store refuses one) together with any leading `_` or `-`.
 */
function dropLeadingNonAlphanumerics(value: string): string {
  const match = /^[^a-z0-9]*/.exec(value);
  return value.slice(match === null ? 0 : match[0].length);
}

/**
 * The extension this name should keep, or `null` when there is none worth
 * keeping. The whole `.ext` must fit in the length budget: a truncated
 * extension (`file.zi`) is a different extension, so it is dropped rather than
 * half-written.
 */
function extensionWithin(value: string, budget: number): string | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = value.slice(dot);
  if (extension.length > budget - 1) return null;
  return extension;
}

/**
 * Cut `value` to at most {@link OBJECT_NAME_MAX_LENGTH} characters, KEEPING the
 * extension when one exists and leaves room, so `my-very-long-report.pdf` stays a
 * `.pdf` after the cut.
 */
function truncateKeepingExtension(value: string): string {
  if (value.length <= OBJECT_NAME_MAX_LENGTH) return value;
  const extension = extensionWithin(value, OBJECT_NAME_MAX_LENGTH);
  if (extension === null) return value.slice(0, OBJECT_NAME_MAX_LENGTH);
  const base = value.slice(0, value.length - extension.length);
  const baseBudget = OBJECT_NAME_MAX_LENGTH - extension.length;
  if (base.length <= baseBudget) return value.slice(0, OBJECT_NAME_MAX_LENGTH);
  return `${base.slice(0, baseBudget)}${extension}`;
}

/**
 * Map a file name to the object name it will be stored under.
 *
 * The pipeline, in order, and each step earns its place:
 *   1. reduce to the BASENAME (strip everything before the last `/` or `\`);
 *   2. lowercase, locale-independently;
 *   3. every character outside `[a-z0-9._-]` becomes `-`;
 *   4. runs of `-` collapse;
 *   5. drop leading non-alphanumerics (a leading `.` may never survive);
 *   6. truncate to 64, keeping the extension when one exists and leaves room.
 *
 * THROWS {@link ObjectNameMappingError} when the result is empty or still illegal
 * (`.`, `..`, or anything the pattern rejects). There is no placeholder path.
 */
export function toObjectName(fileName: string): ObjectNameMapping {
  const base = basename(fileName);
  const folded = dropLeadingNonAlphanumerics(
    collapseDashes(replaceIllegalCharacters(base.toLowerCase())),
  );
  const objectName = truncateKeepingExtension(folded);

  if (objectName === '') {
    throw new ObjectNameMappingError(fileName, 'its name has no letter or digit to start with');
  }
  if (objectName === '.' || objectName === '..') {
    throw new ObjectNameMappingError(fileName, 'the store refuses "." and ".." as a whole name');
  }
  if (!isLegalObjectName(objectName)) {
    throw new ObjectNameMappingError(
      fileName,
      `the mapped name ${JSON.stringify(objectName)} does not match ${String(OBJECT_NAME_PATTERN)}`,
    );
  }

  return { objectName, changed: objectName !== fileName };
}
