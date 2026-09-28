import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The worker budget a test run uses when nothing says otherwise.
 *
 * TWO, and that is deliberate (AGENTS.md §Host hygiene): a resource bound that
 * depends on every writer REMEMBERING an environment variable is not a bound.
 * With this default, `pnpm exec vitest run` cannot exceed two workers whatever
 * anyone forgets. Raising it is an explicit act by whoever owns the machine.
 */
export const DEFAULT_TEST_WORKERS = 2;

/**
 * The worker budget for a test run — the ONE bound that actually binds.
 *
 *   FILESTORE_TEST_WORKERS=4 pnpm exec vitest run
 *
 * A value that is present but not a positive integer is a loud error rather
 * than a silent fallback.
 */
export function testMaxWorkers(): number {
  const raw = process.env.FILESTORE_TEST_WORKERS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_TEST_WORKERS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `FILESTORE_TEST_WORKERS must be a positive integer (got "${raw}") — ` +
        `unset it to use the default of ${String(DEFAULT_TEST_WORKERS)}.`,
    );
  }
  return parsed;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // A TEST RUN MUST NOT BE AT THE MERCY OF AN AMBIENT NODE_ENV. Vitest sets
  // NODE_ENV to 'test' only when it is UNSET, so a harness that exports
  // NODE_ENV=production leaks straight in: React resolves its production build
  // ("act(...) is not supported in production builds of React"). Forcing it
  // here covers EVERY entry point (the gate, a bare `vitest run`, `pnpm test`),
  // and `mode === 'test'` keeps `vite build`/`vite dev` on their real NODE_ENV.
  if (mode === 'test') process.env.NODE_ENV = 'test';

  return {
    // The static host serves FileStore under https://apps.futuremagic.de/filestore/.
    // The dev server is unaffected.
    base: '/filestore/',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      // Default: serve only files inside the project root. Stated explicitly
      // so a future widening is a visible, reviewable choice.
      fs: {
        strict: true,
      },
    },
    build: {
      // The store's object bytes are read into memory by the app; a sourcemap
      // is for the app itself, and `false` keeps the published tree small.
      sourcemap: false,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['tests/setup.ts'],
      css: false,
      // The config default IS the bound (AGENTS.md §Host hygiene): a bare
      // `pnpm exec vitest run` cannot exceed two workers.
      maxWorkers: testMaxWorkers(),
      testTimeout: 20_000,
    },
  };
});
