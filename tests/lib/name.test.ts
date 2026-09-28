import { expect, it } from 'vitest';

import {
  isLegalObjectName,
  OBJECT_NAME_MAX_LENGTH,
  OBJECT_NAME_PATTERN,
  ObjectNameMappingError,
  toObjectName,
} from '@/lib/name';

/**
 * Ledger row 2 / row 8 — THE NAME-MAPPING SEAM. The store's rule is
 * `[a-z0-9][a-z0-9._-]{0,63}` (read from `~/projects/ServerStore/src/core/validate.ts`,
 * which PARSES and never sanitises), so a real file name has to be mapped here,
 * once, before any request exists.
 *
 * These pins hold the mapping's two obligations at the same time: the result is
 * always a name the store accepts, and `changed` tells the owner when the name he
 * chose is not the name that will be stored. The refusal arm is as important as
 * the mapping arms — a placeholder would be a silent fallback (rule 1) and would
 * store a file under a name nobody chose.
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

it('a 200-character name maps to at most 64 legal characters and keeps its extension', () => {
  // Built to be EXACTLY 200 characters: 168 of base, then the extension.
  const fileName = `Report ${'x'.repeat(200 - 'Report '.length - 'final.pdf'.length)}final.pdf`;
  expect(fileName).toHaveLength(200);

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

it('an extension too long for the whole budget is dropped, never half-kept', () => {
  const mapping = toObjectName(`name.${'x'.repeat(80)}`);
  expect(mapping.objectName).toHaveLength(OBJECT_NAME_MAX_LENGTH);
  expect(isLegalObjectName(mapping.objectName)).toBe(true);
  // The base survived to the budget; no part of the impossible extension did.
  expect(mapping.objectName).toBe(`name.${'x'.repeat(59)}`);
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
