import { expect, it } from 'vitest';

import {
  ancestors,
  FOLDER_SEPARATOR,
  folderDepth,
  folderMarkerName,
  folderPrefix,
  FolderPathError,
  formatFolderPath,
  isFolderMarkerName,
  isFolderSegment,
  joinFolder,
  parentFolder,
  parseFolderPath,
  splitObjectName,
  type FolderPath,
} from '@/lib/folder';
import { isLegalObjectName, toObjectName } from '@/lib/name';

/**
 * Ledger row 10 — THE FOLDER-PATH SEAM. ServerStore has no directories, no
 * metadata, no rename route and only a `?prefix=` filter, so a folder is a
 * NAMING CONVENTION over the one flat object list: `--` separates levels, and a
 * trailing `--` marks an empty folder.
 *
 * The convention's whole correctness rests on ONE property of the OTHER seam:
 * `src/lib/name.ts`'s `collapseDashes` makes a double dash unproducible by
 * `toObjectName`. Every pin in this file that mentions "reserved separator" or
 * "marker" is holding that property up — if `collapseDashes` ever stops
 * collapsing, splitting stops being exact and the folder tree silently grows
 * phantom levels.
 *
 * The OTHER half — a segment must be a legal store name AND unambiguous at a
 * separator boundary — is what makes the join/split pair invertible at any depth,
 * so it is pinned as a refusal, not left to prose.
 */

/** File names whose MAPPED form must never smuggle in the separator. */
const MESSY_FILE_NAMES = [
  'notes.txt',
  'My Report (final).PDF',
  'a  b -- c.txt',
  'x - - y.pdf',
  '2026 Q3 — budget.xlsx',
  'a/b/c/d/e/f/deep.json',
  'a-',
];

/** Folder paths a file can be mapped into. */
const FOLDER_PATHS: FolderPath[] = [['docs'], ['docs', 'reports'], ['a', 'b', 'c'], ['q1-2026']];

it('a mapped file name can NEVER contain the folder separator (the reserved-separator property)', () => {
  for (const fileName of MESSY_FILE_NAMES) {
    // At the root the mapped name IS the file part.
    expect(toObjectName(fileName).objectName).not.toContain(FOLDER_SEPARATOR);
    for (const folder of FOLDER_PATHS) {
      const full = toObjectName(fileName, folder).objectName;
      // The full name carries the separators by design; the FILE PART is what
      // must never contain one, or the split at that depth would be ambiguous.
      expect(splitObjectName(full).filePart).not.toContain(FOLDER_SEPARATOR);
      expect(splitObjectName(full).folder).toEqual([...folder]);
    }
  }

  // The mechanism, named so a reader can see WHY: runs of dashes collapse, so a
  // file name full of dashes still yields at most single dashes.
  expect(toObjectName('a  b -- c.txt').objectName).toBe('a-b-c.txt');
  expect(toObjectName('x - - y.pdf').objectName).toBe('x-y.pdf');
  expect('a-b-c.txt').not.toContain(FOLDER_SEPARATOR);
});

it('the empty-folder marker name can never be produced by mapping a file name', () => {
  for (const folder of FOLDER_PATHS) {
    const marker = folderMarkerName(folder);
    // A marker carries the reserved separator, and no mapped name does.
    expect(marker).toContain(FOLDER_SEPARATOR);
    expect(isFolderMarkerName(marker)).toBe(true);
    for (const fileName of MESSY_FILE_NAMES) {
      expect(toObjectName(fileName).objectName).not.toBe(marker);
      expect(toObjectName(fileName, folder).objectName).not.toBe(marker);
      expect(isFolderMarkerName(toObjectName(fileName, folder).objectName)).toBe(false);
      expect(isFolderMarkerName(toObjectName(fileName).objectName)).toBe(false);
    }
  }
});

it('parseFolderPath and formatFolderPath are exact inverses, and \'\' is the root', () => {
  expect(parseFolderPath('')).toEqual([]);
  expect(formatFolderPath([])).toBe('');

  for (const path of FOLDER_PATHS) {
    expect(parseFolderPath(formatFolderPath(path))).toEqual([...path]);
  }
  for (const text of ['a', 'a--b', 'docs--reports', 'a--b--c--d', 'q1-2026--notes']) {
    expect(formatFolderPath(parseFolderPath(text))).toBe(text);
  }
});

it('a nested path round-trips: joinFolder([\'docs\',\'reports\'], \'report.pdf\') splits back to exactly that folder and file part', () => {
  const joined = joinFolder(['docs', 'reports'], 'report.pdf');
  expect(joined).toBe('docs--reports--report.pdf');
  expect(splitObjectName(joined)).toEqual({
    folder: ['docs', 'reports'],
    filePart: 'report.pdf',
  });

  // The same inverse, exercised across depths and file parts.
  const cases: { folder: FolderPath; filePart: string }[] = [
    { folder: [], filePart: 'report.pdf' },
    { folder: ['docs'], filePart: 'notes.txt' },
    { folder: ['a', 'b', 'c', 'd'], filePart: 'archive.tar.gz' },
    { folder: ['q1-2026'], filePart: 'a-b-c.txt' },
  ];
  for (const { folder, filePart } of cases) {
    const full = joinFolder(folder, filePart);
    expect(splitObjectName(full)).toEqual({ folder, filePart });
    // And `joinFolder` at the root is the identity.
    if (folder.length === 0) expect(full).toBe(filePart);
  }
});

it("folderPrefix returns a value that is itself a LEGAL object-name prefix", () => {
  // The root's prefix is the store's documented "no filter": the whole listing.
  expect(folderPrefix([])).toBe('');

  for (const path of FOLDER_PATHS) {
    const prefix = folderPrefix(path);
    // `?prefix=` obeys the SAME name parser as a name, so an illegal prefix is a
    // 400 `invalid_name` that would break navigation loudly.
    expect(isLegalObjectName(prefix)).toBe(true);
    expect(prefix.endsWith(FOLDER_SEPARATOR)).toBe(true);
    expect(prefix.startsWith(formatFolderPath(path))).toBe(true);
    // A prefix is exactly what the marker name is.
    expect(prefix).toBe(folderMarkerName(path));
  }
  expect(folderPrefix(['docs', 'reports'])).toBe('docs--reports--');
});

it('folderMarkerName is a legal object name and ends with the separator', () => {
  for (const path of FOLDER_PATHS) {
    const marker = folderMarkerName(path);
    expect(isLegalObjectName(marker)).toBe(true);
    expect(marker.endsWith(FOLDER_SEPARATOR)).toBe(true);
    expect(marker).toBe(`${formatFolderPath(path)}${FOLDER_SEPARATOR}`);
    expect(isFolderMarkerName(marker)).toBe(true);
  }

  // Ordinary names are not markers, and neither is the root (which has none).
  expect(isFolderMarkerName('docs--report.pdf')).toBe(false);
  expect(isFolderMarkerName('report.pdf')).toBe(false);
  expect(isFolderMarkerName('')).toBe(false);
  expect(isFolderMarkerName('--')).toBe(false);
  expect(isFolderMarkerName('docs---')).toBe(false);
  expect(() => folderMarkerName([])).toThrow(FolderPathError);
});

it('ancestors returns the breadcrumb root-first, and parentFolder of the root is the root', () => {
  expect(ancestors(['docs', 'reports'])).toEqual([[], ['docs'], ['docs', 'reports']]);
  expect(ancestors(['a'])).toEqual([[], ['a']]);
  // The root's breadcrumb is one crumb — the root itself.
  expect(ancestors([])).toEqual([[]]);

  expect(parentFolder([])).toEqual([]);
  expect(parentFolder(['docs'])).toEqual([]);
  expect(parentFolder(['docs', 'reports'])).toEqual(['docs']);
  expect(parentFolder(['a', 'b', 'c'])).toEqual(['a', 'b']);

  expect(folderDepth([])).toBe(0);
  expect(folderDepth(['docs'])).toBe(1);
  expect(folderDepth(['docs', 'reports'])).toBe(2);
});

it('an illegal folder segment is REFUSED loudly rather than sanitised into a different folder', () => {
  const illegalSegments = ['A', 'a b', '', '.hidden', 'a--b', 'a-', 'a/b', 'a\\b', 'ä'];
  for (const segment of illegalSegments) {
    expect(isFolderSegment(segment)).toBe(false);
  }
  expect(isFolderSegment('docs')).toBe(true);
  expect(isFolderSegment('a-b')).toBe(true);
  expect(isFolderSegment('a.b')).toBe(true);
  expect(isFolderSegment('q1_2026')).toBe(true);

  // A malformed PATH throws; it never drops, folds or re-segments anything.
  for (const bad of ['A--b', 'a b', 'a--', '--a', 'a---b', 'a-', 'docs//reports', 'a--b--']) {
    expect(() => parseFolderPath(bad)).toThrow(FolderPathError);
  }

  // The specific silent-substitution this pin forbids: `A--b` must not become
  // the DIFFERENT folder `a/b`, and an ambiguous `a---b` must not resolve to
  // either possible reading.
  try {
    parseFolderPath('A--b');
    throw new Error('unreachable: `A--b` should have thrown');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(FolderPathError);
    expect((error as FolderPathError).path).toContain('A');
  }
});

it('splitObjectName refuses a marker, an ambiguous name and an illegal name rather than guessing a file', () => {
  expect(splitObjectName('report.pdf')).toEqual({ folder: [], filePart: 'report.pdf' });
  expect(splitObjectName('docs--report.pdf')).toEqual({
    folder: ['docs'],
    filePart: 'report.pdf',
  });

  // A marker denotes a FOLDER, not a file, so it is a loud refusal.
  expect(() => splitObjectName('docs--')).toThrow(FolderPathError);
  expect(() => splitObjectName('docs--reports--')).toThrow(FolderPathError);
  // Not a legal object name at all.
  expect(() => splitObjectName('Docs--x')).toThrow(FolderPathError);
  expect(() => splitObjectName('')).toThrow(FolderPathError);
});

it('a folder path that cannot be navigated within the name bound is refused, not silently shortened', () => {
  // Each segment is legal on its own, but the WHOLE path plus its separator would
  // exceed the 1024-character name bound, so `?prefix=` could never be sent.
  const longSegment = 'a'.repeat(1023);
  expect(isLegalObjectName(longSegment)).toBe(true);
  expect(() => parseFolderPath(longSegment)).toThrow(FolderPathError);
  expect(() => joinFolder([longSegment], 'notes.txt')).toThrow(FolderPathError);
  expect(() => folderPrefix([longSegment])).toThrow(FolderPathError);
  expect(() => folderMarkerName([longSegment])).toThrow(FolderPathError);
});
