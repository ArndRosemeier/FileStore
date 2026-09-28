/**
 * The folder TREE, derived from the ONE listing (ledger row 10, slice 2).
 *
 * ServerStore has no directories: a folder is a naming convention
 * (`src/lib/folder.ts`) over the one flat object list, and this module is the
 * ONE place that turns that list into what the owner sees. It is PURE — it takes
 * the entries the listing already returned and the folder the owner is standing
 * in, and answers four questions about them:
 *
 *  1. **which objects are FILES here** — their folder path deep-equals the
 *     current path;
 *  2. **which are in a SUBFOLDER** — their folder path has the current path as a
 *     STRICT prefix, so the object belongs to the child named at
 *     `folderPath[current.length]`, at any depth below it;
 *  3. **which objects are EMPTY-FOLDER MARKERS** — {@link isFolderMarkerName} is
 *     the ONE predicate for that (`src/lib/folder.ts`), never `endsWith('--')`
 *     restated here. A marker is NEVER a file: it denotes a folder, and it is
 *     what makes a folder that holds nothing visible at all. The marker for the
 *     CURRENT folder is the folder itself, so it is neither a file here nor a
 *     subfolder of itself;
 *  4. **which objects are DEEPER than this level** — they never appear as files
 *     here; they are counted inside the subfolder they belong to.
 *
 * NOTHING IS SPLIT OR JOINED HERE. Every path question goes through
 * `src/lib/folder.ts` (`splitObjectName`, `parseFolderPath`, `folderPrefix`,
 * `formatFolderPath`), so the `--` convention has exactly one implementation.
 *
 * TWO COUNTS, AND WHY THEY DIFFER. The row for a subfolder shows
 * {@link FolderRow.objectCount}: the objects a human would see if he walked in —
 * files at any depth, markers EXCLUDED, because a marker is the folder's own
 * bookkeeping and not something "inside" it. Deleting that folder removes
 * {@link FolderRow.deleteCount}: EVERY object under its prefix, markers
 * INCLUDED, because the marker is a real object that has to go too. The
 * difference is exactly the markers; the delete confirmation names the second
 * number, which is what the owner is actually authorising.
 *
 * WHAT THIS MODULE DOES NOT DO: it never issues a request, never guesses a
 * folder for an object whose name the convention cannot read (that name goes
 * through `splitObjectName`, which THROWS — rule 1), and never deletes the root
 * (that would be the whole store, which the bulk route is forbidden to touch).
 */

import {
  FOLDER_SEPARATOR,
  folderPrefix,
  isFolderMarkerName,
  parseFolderPath,
  splitObjectName,
  type FolderPath,
} from '@/lib/folder';
import type { ObjectEntry } from '@/server/store-client';

/** One object that is a FILE in the folder being viewed. */
export interface FolderFile {
  entry: ObjectEntry;
  /** The name within this folder: the object name minus the folder prefix. */
  filePart: string;
}

/** One subfolder of the folder being viewed, with the counts its row shows. */
export interface FolderRow {
  segment: string;
  path: FolderPath;
  /** Non-marker objects at ANY depth inside — "what is inside it". */
  objectCount: number;
  /** Distinct immediate subfolders inside it. */
  folderCount: number;
  /** Every object under its prefix, its own marker INCLUDED — what a delete removes. */
  deleteCount: number;
}

/** Everything the current folder holds, in the shape the UI renders. */
export interface FolderView {
  files: FolderFile[];
  subfolders: FolderRow[];
  /** Objects under the CURRENT folder's prefix, its own marker INCLUDED. */
  deleteCount: number;
}

/** True when the two paths are the same folder (deep equality, segment by segment). */
function sameFolder(left: FolderPath, right: FolderPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** The accumulator for one subfolder row while the one pass walks the listing. */
interface RowAccumulator {
  row: FolderRow;
  childSegments: Set<string>;
}

/** The row for `segment` under `current`, created on first sight. */
function rowFor(
  rows: Map<string, RowAccumulator>,
  current: FolderPath,
  segment: string,
): RowAccumulator {
  const existing = rows.get(segment);
  if (existing !== undefined) return existing;
  const created: RowAccumulator = {
    row: { segment, path: [...current, segment], objectCount: 0, folderCount: 0, deleteCount: 0 },
    childSegments: new Set<string>(),
  };
  rows.set(segment, created);
  return created;
}

/**
 * Derive the current folder's files and subfolders from ONE listing.
 *
 * `entries` is the listing for the current folder (its `?prefix=` subtree, or
 * the whole store at the root) already in display order; `current` is the folder
 * being viewed. The result's `files` keeps the incoming order, and `subfolders`
 * is sorted by segment (code-unit, like `src/features/files/useObjects.ts` — a
 * locale-dependent sort would read differently on two machines).
 */
export function describeFolder(entries: readonly ObjectEntry[], current: FolderPath): FolderView {
  const prefix = folderPrefix(current);
  const inCurrent =
    prefix === '' ? [...entries] : entries.filter((entry) => entry.name.startsWith(prefix));

  const files: FolderFile[] = [];
  const rows = new Map<string, RowAccumulator>();

  for (const entry of inCurrent) {
    if (isFolderMarkerName(entry.name)) {
      // A marker denotes the folder named by everything before the trailing
      // separator. Its own folder is therefore NOT a file and NOT a subfolder of
      // itself; a DEEPER marker belongs to the child at this level.
      const markerPath = parseFolderPath(entry.name.slice(0, -FOLDER_SEPARATOR.length));
      if (markerPath.length <= current.length) continue;
      const segment = markerPath[current.length];
      if (segment === undefined) continue;
      const found = rowFor(rows, current, segment);
      found.row.deleteCount += 1;
      if (markerPath.length > current.length + 1) {
        const child = markerPath[current.length + 1];
        if (child !== undefined) found.childSegments.add(child);
      }
      continue;
    }

    // `splitObjectName` THROWS on a name the convention cannot read rather than
    // inventing a folder (rule 1). The service only holds legal object names, so
    // reaching that throw means the store changed under us — and it must be
    // loud, not rendered as a file in the wrong place.
    const { folder, filePart } = splitObjectName(entry.name);
    if (sameFolder(folder, current)) {
      files.push({ entry, filePart });
      continue;
    }
    if (folder.length <= current.length) continue;
    const segment = folder[current.length];
    if (segment === undefined) continue;
    const found = rowFor(rows, current, segment);
    found.row.objectCount += 1;
    found.row.deleteCount += 1;
    if (folder.length > current.length + 1) {
      const child = folder[current.length + 1];
      if (child !== undefined) found.childSegments.add(child);
    }
  }

  const subfolders = [...rows.values()]
    .map(({ row, childSegments }) => ({ ...row, folderCount: childSegments.size }))
    .sort((left, right) => {
      if (left.segment === right.segment) return 0;
      return left.segment < right.segment ? -1 : 1;
    });

  return { files, subfolders, deleteCount: inCurrent.length };
}

/**
 * Every object under `path`'s prefix, markers included — the exact set a folder
 * delete removes and a folder create collides with.
 *
 * The ROOT is refused LOUDLY: at the root the prefix is `''`, so "everything
 * under it" would be the WHOLE store — the one destructive bulk operation this
 * app must never perform (`AGENTS.md` §What this app is). The root always
 * exists, so no caller has a legitimate reason to ask.
 */
export function objectsUnder(entries: readonly ObjectEntry[], path: FolderPath): ObjectEntry[] {
  if (path.length === 0) {
    throw new Error(
      'Refusing to treat the root folder as a deletable folder: everything is under it, so that would empty the whole store.',
    );
  }
  const prefix = folderPrefix(path);
  return entries.filter((entry) => entry.name.startsWith(prefix));
}

/** The object NAMES under `path`, the argument a sequential delete takes. */
export function objectNamesUnder(entries: readonly ObjectEntry[], path: FolderPath): string[] {
  return objectsUnder(entries, path).map((entry) => entry.name);
}

/** A folder path as the owner reads it: `docs / reports`; the root is `the root`. */
export function folderDisplayPath(path: FolderPath): string {
  return path.length === 0 ? 'the root' : path.join(' / ');
}

/** `1 folder` / `3 folders` — the folder side of a row's count line. */
export function formatFolderCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'folder' : 'folders'}`;
}
