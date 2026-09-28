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

/**
 * Comments removed, so a MENTION of a call is never read as a call.
 *
 * MEASURED, by the dispatcher's own differential after this landing: with the
 * strip applied to the `Authorization` check only, appending one block comment
 * merely MENTIONING a fetch call to `src/App.tsx` turned the fetch pin RED
 * although no call existed — a false red that the next writer would have chased
 * as a missing pin. Both checks now strip both comment forms.
 *
 * The line-comment arm deliberately requires a character OTHER than `:` (or the
 * start of the line) before the `//`, so it does not eat the `https://` scheme
 * inside the very base URL this seam is built around — the reason the original
 * author restricted this function to block comments in the first place.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FILES = sourceFiles(SRC);

it('exactly ONE module under src/ calls fetch( — the ServerStore transport', () => {
  const hits = FILES.filter((file) => /\bfetch\(/.test(stripComments(readFileSync(file, 'utf8'))));
  expect(hits.map(repoRelative)).toEqual(['src/server/store-client.ts']);
});

it('the Authorization header is BUILT in exactly ONE src/ module', () => {
  const hits = FILES.filter((file) =>
    stripComments(readFileSync(file, 'utf8')).includes('Authorization'),
  );
  expect(hits.map(repoRelative)).toEqual(['src/server/store-client.ts']);
});
