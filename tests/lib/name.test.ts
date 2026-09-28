import { expect, it } from 'vitest';

import {
  FolderPathError,
  folderMarkerName,
  joinFolder,
  splitObjectName,
  type FolderPath,
} from '@/lib/folder';
import {
  isLegalObjectName,
  OBJECT_NAME_MAX_LENGTH,
  OBJECT_NAME_PATTERN,
  ObjectNameMappingError,
  toObjectName,
} from '@/lib/name';

/**
 * Ledger row 2 / row 8 — THE NAME-MAPPING SEAM. The store's rule is
 * `[a-z0-9][a-z0-9._-]{0,1023}` (read from
 * `~/projects/ServerStore/src/core/validate.ts`, which PARSES and never
 * sanitises), so a real file name has to be mapped here, once, before any
 * request exists.
 *
 * These pins hold the mapping's two obligations at the same time: the result is
 * always a name the store accepts, and `changed` tells the owner when the name he
 * chose is not the name that will be stored. The refusal arm is as important as
 * the mapping arms — a placeholder would be a silent fallback (rule 1) and would
 * store a file under a name nobody chose.
 *
 * Ledger row 10 adds the FOLDER arms at the bottom: a mapping into a folder is
 * the full store name, while `changed` keeps describing the FILE part alone.
 */

it('an already-legal file name maps to itself and reports no change', () => {
  const mapping = toObjectName('notes.txt');
  expect(mapping).toEqual({ objectName: 'notes.txt', changed: false });
  expect(isLegalObjectName(mapping.objectName)).toBe(true);
});

it('an ordinary messy name maps to a legal one and REPORTS the change', () => {
  const mapping = toObjectName('My Report (final).PDF');
  expect(mapping.changed).toBe(true);
  // `(final)` becomes `-final-`, and the `-` before the dot stays: the mapping
  // folds characters and collapses runs, it does not tidy punctuation the store
  // would have accepted.
  expect(mapping.objectName).toBe('my-report-final-.pdf');
  expect(mapping.objectName).toMatch(OBJECT_NAME_PATTERN);
  expect(isLegalObjectName(mapping.objectName)).toBe(true);
});

it('every character outside the store charset is folded, and runs of `-` collapse', () => {
  expect(toObjectName('a  b -- c').objectName).toBe('a-b-c');
  expect(toObjectName('héllo wörld.txt').objectName).toBe('h-llo-w-rld.txt');
});

it('a name carrying a POSIX path is reduced to its basename', () => {
  expect(toObjectName('/tmp/a/b/notes.txt')).toEqual({ objectName: 'notes.txt', changed: true });
});

it('a name carrying a Windows path is reduced to its basename too', () => {
  expect(toObjectName('C:\\docs\\notes.txt')).toEqual({ objectName: 'notes.txt', changed: true });
});

it('a leading `.` never survives into an object name', () => {
  expect(toObjectName('.env').objectName).toBe('env');
  expect(toObjectName('..hidden.txt').objectName).toBe('hidden.txt');
  expect(toObjectName('.gitignore').objectName).toBe('gitignore');
  // The store refuses a leading `.` outright, so the mapped name must not have one.
  expect(OBJECT_NAME_PATTERN.test('.env')).toBe(false);
});

it('OBJECT_NAME_MAX_LENGTH is 1024 and the pattern accepts exactly the server’s landed rule at both edges', () => {
  // The mirror names its source in `src/lib/name.ts`; these are the two edges.
  expect(OBJECT_NAME_MAX_LENGTH).toBe(1024);
  expect(OBJECT_NAME_PATTERN.source).toBe('^[a-z0-9][a-z0-9._-]{0,1023}$');

  // A 1024-character name is ACCEPTED.
  const atBound = 'a'.repeat(OBJECT_NAME_MAX_LENGTH);
  expect(isLegalObjectName(atBound)).toBe(true);
  expect(OBJECT_NAME_PATTERN.test(atBound)).toBe(true);

  // A 1025-character one is REFUSED: the mirrored rule rejects it, and the
  // composition seam throws rather than composing an unnameable string.
  const overBound = 'a'.repeat(OBJECT_NAME_MAX_LENGTH + 1);
  expect(isLegalObjectName(overBound)).toBe(false);
  expect(OBJECT_NAME_PATTERN.test(overBound)).toBe(false);
  expect(() => joinFolder([], overBound)).toThrow(FolderPathError);
});

it('a 1200-character name maps to at most 1024 legal characters and keeps its extension', () => {
  // Built to be EXACTLY 1200 characters: 195 of base, then the extension.
  const fileName = `Report ${'x'.repeat(1200 - 'Report '.length - 'final.pdf'.length)}final.pdf`;
  expect(fileName).toHaveLength(1200);

  const mapping = toObjectName(fileName);
  expect(mapping.objectName).toHaveLength(OBJECT_NAME_MAX_LENGTH);
  expect(isLegalObjectName(mapping.objectName)).toBe(true);
  expect(mapping.objectName.endsWith('.pdf')).toBe(true);
  expect(mapping.changed).toBe(true);
});

it('a name that CANNOT map throws, and never returns a placeholder', () => {
  expect(() => toObjectName('...')).toThrow(ObjectNameMappingError);
  expect(() => toObjectName('')).toThrow(ObjectNameMappingError);
  expect(() => toObjectName('///')).toThrow(ObjectNameMappingError);
  expect(() => toObjectName('!!!')).toThrow(ObjectNameMappingError);
  // e.g. `'...'` — no partial name was fabricated on the way to the throw.
  try {
    toObjectName('...');
    throw new Error('unreachable: a mapping should have thrown');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ObjectNameMappingError);
    expect((error as Error).message).toContain('...');
  }
});

it('an extension too long for the whole 1024-character budget is dropped, never half-kept', () => {
  const mapping = toObjectName(`name.${'x'.repeat(1100)}`);
  expect(mapping.objectName).toHaveLength(OBJECT_NAME_MAX_LENGTH);
  expect(isLegalObjectName(mapping.objectName)).toBe(true);
  // The base survived to the budget; no part of the impossible extension did.
  expect(mapping.objectName).toBe(`name.${'x'.repeat(OBJECT_NAME_MAX_LENGTH - 'name.'.length)}`);
  expect(mapping.objectName.endsWith('xxxx')).toBe(true);
});

it('the mapped name is legal for a representative set of real-world file names', () => {
  const inputs = [
    'holiday photo.JPG',
    '2026 Q3 — budget.xlsx',
    'Ünïcödé Ñame.txt',
    'archive.tar.gz',
    'README',
    '  spaced out  .txt',
    'a/b/c/d/e/f/deep.json',
  ];
  for (const input of inputs) {
    const mapping = toObjectName(input);
    expect(isLegalObjectName(mapping.objectName)).toBe(true);
    expect(mapping.objectName).not.toBe('');
    expect(mapping.changed).toBe(mapping.objectName !== input);
  }
});

/**
 * Ledger row 10 — the FOLDER-aware arms. The folder convention lives in
 * `src/lib/folder.ts`; these pins hold the half that belongs to THIS seam: the
 * full name is the folder path plus the mapped file part, the budget is shared,
 * and `changed` still means "the FILE part was renamed".
 */

it('toObjectName(fileName) with no folder behaves EXACTLY as before — the row-9 call site is untouched', () => {
  // The row-9 UI calls this with ONE argument; these are the exact mapping
  // results it sees, and passing an empty path must be indistinguishable.
  const before: [string, { objectName: string; changed: boolean }][] = [
    ['notes.txt', { objectName: 'notes.txt', changed: false }],
    ['My Report (final).PDF', { objectName: 'my-report-final-.pdf', changed: true }],
    ['/tmp/a/b/notes.txt', { objectName: 'notes.txt', changed: true }],
    ['.env', { objectName: 'env', changed: true }],
  ];
  for (const [input, expected] of before) {
    expect(toObjectName(input)).toEqual(expected);
    expect(toObjectName(input, [])).toEqual(expected);
  }
});

it('mapping into a folder returns the FULL store name and keeps `changed` describing the FILE name only', () => {
  // An already-legal file name is not renamed by a folder, so `changed` is false
  // even though the returned name is longer than the input.
  expect(toObjectName('notes.txt', ['docs'])).toEqual({
    objectName: 'docs--notes.txt',
    changed: false,
  });
  expect(toObjectName('notes.txt', ['docs', 'reports'])).toEqual({
    objectName: 'docs--reports--notes.txt',
    changed: false,
  });
  // A messy file name IS renamed, and `changed` says so — the folder is the
  // caller's explicit choice, never a "rename" to report.
  expect(toObjectName('My File.PDF', ['docs'])).toEqual({
    objectName: 'docs--my-file.pdf',
    changed: true,
  });
  // The mapping is always the folder plus the file part, exactly.
  const folder: FolderPath = ['docs', 'reports'];
  const mapped = toObjectName('2026 Q3 — budget.xlsx', folder);
  expect(splitObjectName(mapped.objectName)).toEqual({
    folder,
    filePart: '2026-q3-budget.xlsx',
  });
});

it('a file name longer than the bound maps into a folder to a legal name of at most the bound, keeping its extension', () => {
  const fileName = `Report ${'x'.repeat(1200 - 'Report '.length - 'final.pdf'.length)}final.pdf`;
  expect(fileName).toHaveLength(1200);
  const folder: FolderPath = ['docs', 'reports'];

  const mapping = toObjectName(fileName, folder);
  // The folder's characters are PART of the one bound: the full name fits.
  expect(isLegalObjectName(mapping.objectName)).toBe(true);
  expect(mapping.objectName.length).toBeLessThanOrEqual(OBJECT_NAME_MAX_LENGTH);
  expect(mapping.objectName.startsWith('docs--reports--')).toBe(true);
  expect(mapping.objectName.endsWith('.pdf')).toBe(true);
  expect(mapping.changed).toBe(true);
  expect(splitObjectName(mapping.objectName).folder).toEqual([...folder]);
});

it('mapping into an ILLEGAL folder segment throws ObjectNameMappingError rather than guessing a folder', () => {
  for (const bad of [['A'], ['a b'], ['a--b'], ['a-'], ['']] as FolderPath[]) {
    expect(() => toObjectName('notes.txt', bad)).toThrow(ObjectNameMappingError);
    // Nothing was fabricated on the way to the throw.
    try {
      toObjectName('notes.txt', bad);
      throw new Error('unreachable: an illegal folder segment should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ObjectNameMappingError);
    }
  }
});

it('a folder with no room left for a file name is refused LOUDLY, not truncated to nothing', () => {
  const huge: FolderPath = ['a'.repeat(1023)];
  expect(() => toObjectName('notes.txt', huge)).toThrow(ObjectNameMappingError);
});

it('a mapped name is never the empty-folder marker of the folder it is mapped into', () => {
  const folder: FolderPath = ['docs', 'reports'];
  const marker = folderMarkerName(folder);
  for (const input of ['notes.txt', 'a  b -- c.txt', 'My Report (final).PDF']) {
    expect(toObjectName(input, folder).objectName).not.toBe(marker);
  }
});
