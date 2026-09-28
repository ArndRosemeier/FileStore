import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE worktree-isolation pin.
 *
 * Writers work in `worktrees/<slice>/`, INSIDE the repo root, so vitest's
 * default include glob — which walks the whole root — collects every worktree's
 * copy of every test into the MAIN tree's run. MEASURED on the day-1 scaffold:
 * with two worktrees present, `pnpm test` reported **3 passed** for a tree
 * holding ONE test file, so the gate's counts described three trees at once and
 * a worktree's failures would have been reported against `main` — a green that
 * is not about the tree it claims. (The same run caught it: the fix took the
 * count from 3 back to 1.)
 *
 * WHY THIS READS THE CONFIG AS TEXT INSTEAD OF IMPORTING IT: it was tried the
 * other way first and it CANNOT work — importing `vite.config.ts` and calling it
 * from inside the runner dies on `fileURLToPath(new URL('./src',
 * import.meta.url))` with `TypeError: The URL must be of scheme file`, because
 * vitest's transform gives the module a non-`file:` `import.meta.url`. That
 * measurement is the reason for the shape below, not a preference.
 *
 * So the pinned property is the one that actually holds the behaviour: the
 * `exclude` list in `vite.config.ts` names `worktrees`, and — because `exclude`
 * REPLACES vitest's defaults rather than extending them — it still names
 * `node_modules` and `dist`. Deleting any of the three is the change this exists
 * to catch. The behavioural half is proved by the differential in
 * `docs/TESTING.md`: a probe test dropped into a worktree must NOT change this
 * tree's count.
 */
describe('worktree isolation', () => {
  it('the suite never collects tests from a writer worktree, and keeps the default excludes', () => {
    const source = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

    const excludeBlock = /exclude:\s*\[([\s\S]*?)\]/.exec(source)?.[1];
    expect(
      excludeBlock,
      'vite.config.ts has no test.exclude array — the worktree isolation is gone',
    ).toBeDefined();

    expect(excludeBlock).toContain('worktrees');
    expect(excludeBlock).toContain('node_modules');
    expect(excludeBlock).toContain('dist');
  });
});
