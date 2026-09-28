/**
 * THE name-mapping seam (ledger row 2): the ONE place a real file name becomes a
 * ServerStore object name.
 *
 * THE RULE THE STORE ACTUALLY ENFORCES, read from the authority rather than
 * guessed: `~/projects/ServerStore/src/core/validate.ts` builds `NAME_PATTERN`
 * from `NAME_CHARSET` (`[a-z0-9._-]`) and `NAME_MAX_LENGTH`, and refuses `.`/`..`
 * as a whole name and any name starting with `.` or `/`. It PARSES names, it
 * never sanitises them — so a name like `My Report (final).PDF` is a 400
 * (`invalid_name`) if sent verbatim, and the rewriting has to happen HERE, once,
 * before any request exists.
 *
 * THE NUMBER IS A MIRROR, AND THE MIRROR NAMES ITS SOURCE: see
 * {@link OBJECT_NAME_MAX_LENGTH}. The SAME parser serves store names, object
 * names, object-name PREFIXES and key ids, which is what lets
 * `src/lib/folder.ts` navigate with `?prefix=`.
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
 *
 * FOLDERS (ledger row 10): the optional `folder` argument makes the mapped name
 * the FULL store name — folder path, separator, mapped file part — while `changed`
 * keeps describing the FILE part alone. The folder convention itself (the `--`
 * separator, path parsing, prefix and marker) is `src/lib/folder.ts`, imported
 * here rather than restated (rule 4); `name.ts` and `folder.ts` reference each
 * other only inside function bodies, so the import cycle is safe.
 */

import {
  FOLDER_SEPARATOR,
  formatFolderPath,
  isFolderSegment,
  joinFolder,
  type FolderPath,
} from './folder';

/** The store's own limit: 1024 characters total. */
export const OBJECT_NAME_MAX_LENGTH = 1024;

/**
 * The legal object-name language, anchored: `[a-z0-9][a-z0-9._-]{0,1023}`.
 *
 * THIS IS A MIRROR of another project's contract, so it names the contract it
 * mirrors — `~/projects/ServerStore/src/core/validate.ts`, where
 * `NAME_MAX_LENGTH = 1024` and `NAME_PATTERN` is BUILT from `NAME_CHARSET` and
 * that constant. It landed in ServerStore commit
 * `26f9e468334363ed745b1fbdcbc13aed34a1666c` (2026-09-28). CHECK THE SOURCE
 * rather than trusting this line: a mirror that cannot be checked is a lie
 * waiting to happen, and the LIVE SERVICE may still be running the older process
 * (see `docs/ARCHITECTURE.md` §4 — the running service is STALE).
 *
 * Anchored on purpose — an unanchored test would accept `'notes.txt '` or
 * `'../notes.txt'` as "legal", which is exactly the class of bug this constant
 * exists to prevent.
 */
export const OBJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,1023}$/;

/** True when `name` is, on its own, a legal ServerStore object name. */
export function isLegalObjectName(name: string): boolean {
  return OBJECT_NAME_PATTERN.test(name);
}

/** The result of mapping a file name: the object name, and whether it differs. */
export interface ObjectNameMapping {
  /** A name the store will accept; always matches {@link OBJECT_NAME_PATTERN}. */
  objectName: string;
  /** True when the mapped FILE part differs from `fileName` — the owner's rename. */
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
 * Cut `value` to at most `budget` characters, KEEPING the extension when one
 * exists and leaves room, so `my-very-long-report.pdf` stays a `.pdf` after the
 * cut. The budget is passed in because a folder path shares the one name bound
 * with the file part (ledger row 10).
 */
function truncateKeepingExtension(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const extension = extensionWithin(value, budget);
  if (extension === null) return value.slice(0, budget);
  const base = value.slice(0, value.length - extension.length);
  const baseBudget = budget - extension.length;
  if (base.length <= baseBudget) return value.slice(0, budget);
  return `${base.slice(0, baseBudget)}${extension}`;
}

/**
 * Characters the folder path costs in the full name, `0` at the root. Refuses an
 * illegal segment or a path that leaves no room for a file at all — LOUDLY, with
 * the mapping seam's own error, so a caller cannot be handed a different folder.
 *
 * The cost is `folderPrefix`'s length (`formatFolderPath(path) + separator`), and
 * the refusal is STRICTER than the folder seam's: a path may be legal and
 * navigable as a `?prefix=` and still leave zero characters for a file name,
 * which this seam cannot map.
 */
function folderCost(fileName: string, folder: FolderPath): number {
  if (folder.length === 0) return 0;
  for (const segment of folder) {
    if (!isFolderSegment(segment)) {
      throw new ObjectNameMappingError(
        fileName,
        `the folder segment ${JSON.stringify(segment)} is not one legal folder segment`,
      );
    }
  }
  const cost = formatFolderPath(folder).length + FOLDER_SEPARATOR.length;
  if (cost >= OBJECT_NAME_MAX_LENGTH) {
    throw new ObjectNameMappingError(
      fileName,
      `the folder path ${JSON.stringify(formatFolderPath(folder))} leaves no room for a file name`,
    );
  }
  return cost;
}

/**
 * Map a file name to the object name it will be stored under — in `folder` when
 * one is given, at the root otherwise.
 *
 * The pipeline, in order, and each step earns its place:
 *   1. reduce to the BASENAME (strip everything before the last `/` or `\`);
 *   2. lowercase, locale-independently;
 *   3. every character outside `[a-z0-9._-]` becomes `-`;
 *   4. runs of `-` collapse;
 *   5. drop leading non-alphanumerics (a leading `.` may never survive);
 *   6. truncate the FILE part to what the folder path leaves of the name bound,
 *      keeping the extension when one exists and leaves room.
 *
 * With no folder (or an empty path) the behaviour and the returned
 * `{objectName, changed}` are EXACTLY the root case of before this seam had a
 * folder argument — the row-9 call site (`src/features/files/upload.ts`) passes
 * one argument and is untouched.
 *
 * THROWS {@link ObjectNameMappingError} when the result is empty or still illegal
 * (`.`, `..`, anything the pattern rejects, an illegal folder segment, or a
 * folder with no room for a file). There is no placeholder path.
 */
export function toObjectName(fileName: string, folder?: FolderPath): ObjectNameMapping {
  const path = folder ?? [];
  const budget = OBJECT_NAME_MAX_LENGTH - folderCost(fileName, path);
  const base = basename(fileName);
  const folded = dropLeadingNonAlphanumerics(
    collapseDashes(replaceIllegalCharacters(base.toLowerCase())),
  );
  const filePart = truncateKeepingExtension(folded, budget);

  if (filePart === '') {
    throw new ObjectNameMappingError(fileName, 'its name has no letter or digit to start with');
  }
  if (filePart === '.' || filePart === '..') {
    throw new ObjectNameMappingError(fileName, 'the store refuses "." and ".." as a whole name');
  }

  const objectName = joinFolder(path, filePart);
  if (!isLegalObjectName(objectName)) {
    throw new ObjectNameMappingError(
      fileName,
      `the mapped name ${JSON.stringify(objectName)} does not match ${String(OBJECT_NAME_PATTERN)}`,
    );
  }

  // `changed` describes the FILE part, not the folder: the folder is the
  // caller's explicit choice, so it is never a "rename" to report.
  return { objectName, changed: filePart !== fileName };
}
