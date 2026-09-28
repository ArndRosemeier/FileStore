/**
 * THE one-fetch pin (ledger row 7; rule 4).
 *
 * The app has exactly ONE module that speaks HTTP to the store, and exactly ONE
 * module that builds the credential header. A second `fetch(` is a second
 * client with no named owner; a second `Authorization` builder is a second place
 * the key can leak into a URL or a log.
 *
 * This test READS THE FILES FROM DISK and never imports them: importing the
 * client would prove only that the module runs, not which module in the tree
 * holds the call. The walker is local to this file on purpose — the sibling
 * worktree-isolation pin (`tests/architecture/worktree-isolation.test.ts`, the
 * dispatcher's) also reads its subject as text rather than through a shared
 * helper, and `tests/helpers.ts` is not this slice's to create.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');

/** Every `.ts`/`.tsx` file under `dir`, recursively, as absolute paths. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function repoRelative(file: string): string {
  return relative(process.cwd(), file);
}

/** Block comments only. A `//`-to-end-of-line strip would eat the `https://`
 * scheme inside the very base URL this seam is built around. */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const FILES = sourceFiles(SRC);

it('exactly ONE module under src/ calls fetch( — the ServerStore transport', () => {
  const hits = FILES.filter((file) => /\bfetch\(/.test(readFileSync(file, 'utf8')));
  expect(hits.map(repoRelative)).toEqual(['src/server/store-client.ts']);
});

it('the Authorization header is BUILT in exactly ONE src/ module', () => {
  const hits = FILES.filter((file) =>
    stripBlockComments(readFileSync(file, 'utf8')).includes('Authorization'),
  );
  expect(hits.map(repoRelative)).toEqual(['src/server/store-client.ts']);
});
