# Testing — what proves this

This doc exists because **"it compiles" is never "it passed"**, and because a green
result whose evidence was discarded cannot be diagnosed. It records the pins, the
differential arms with their hashes, and the VOID probes — per landing, as they were
actually run.

It is not a test plan. It is the record of what *proves* the behaviour, and of what
was *executed*.

## The pin

A **pin** is a test that goes red when the behaviour it protects is broken. Three rules
make a pin worth having:

1. **A test's NAME is part of the deliverable.** A pin that reds must say what it
   protects. Green with no name is unverifiable later.
2. **A pin must be watched red at least once.** A test that has never failed against a
   broken implementation has not been shown to hold anything — that is what the
   differential below is for.
3. **Reuse the existing harness.** A second fixture set for the same idea is
   duplication that drifts.
4. **A real-browser pin reaps its browser.** A headless browser is a process *tree* —
   one upstream run left **33 Chrome processes** alive — so start it in-turn, put the
   kill in a `trap`, and verify the count is zero before you report, on success and
   failure alike.

## The differential (the injection)

To prove a pin actually holds a property, break the property on purpose and watch the
pin go red. The arms are the runs; each has rules, and every one of them was learned
the hard way:

- **Print every arm's file hash.** A finished injection whose hash was not printed is
  not evidence.
- **Two arms with identical output are a VOID probe**, never evidence against a
  landing: the mutation did not change what ran. Identical arms are the *tell*, not the
  result.
- **A green arm whose mutation certainly changed behaviour is a WRONG-FILE or
  missing-pin signal FIRST.** Grep for the pin's own test file and run *that* file.
- **Restore from HEAD, and only the bytes HEAD actually holds.** `git checkout -- <path>`
  restores the *index*; a bare restore from HEAD in a tree whose change is still
  **uncommitted** WIPES the work. Either commit the slice first, or restore from an
  out-of-tree copy.
- **Take the lock before injecting, and restore in a `trap`.** An injection left in a
  shared tree while another writer gates can be committed by that writer.
- **The first arm is the untouched baseline**, and its hash should match the author's
  reported baseline. That is provenance, and it has caught verification against the
  wrong tree.

## What "verified" means

- The commit is on the **remote** branch, not the local tree.
- The **dispatcher's own** gate ran on the integrated tree, raw log kept, with the
  summed counts and peak quoted.
- The **dispatcher's own** differential ran, arms hash-printed, at least one injection
  the author did not run.
- The docs were amended **in the same commit** as the change.

The author's gate proves the change does what the author *meant*. Only the independent
arm proves the pins hold the property. Both are needed.

## The pin matrix

| Behaviour | Pin (test) | Where | How it is watched red |
| --- | --- | --- | --- |
| The app mounts and names itself (and the whole test harness agrees end to end) | `mounts and names the app` | `tests/app/shell.test.tsx` | Change the heading text in `src/App.tsx`; the role/name query finds nothing. |
| The suite collects NOTHING from a writer worktree, and keeps vitest's default excludes | `the suite never collects tests from a writer worktree, and keeps the default excludes` | `tests/architecture/worktree-isolation.test.ts` | Delete `'**/worktrees/**'` from `test.exclude` in `vite.config.ts` — watched RED, arms below. |
| The save seam's branch matrix: picker used; a cancel is silent and free; a real failure is loud; the anchor is the fallback | 9 tests, incl. `a present picker is used: suggested name, MIME type, bytes written and closed` · `a cancelled picker is the owner changing his mind: silent, and nothing was built` · `a real failure keeps its own reason — the caller must surface it loudly` · `an absent picker falls back to the anchor download with the suggested name` | `tests/lib/saveFile.test.ts` | Arm A below: build the bytes BEFORE the picker → the cancel-cost pin and the ordering pin both RED. |
| The open seam's branch matrix, MULTIPLE files, and the input fallback | 13 tests, incl. `several picked files all come back, in the order they were chosen` · `a cancelled picker is the owner changing his mind: silent` · `dismissing the input dialog is a SILENT cancel and removes the element` · `choosing files through the input yields every name and every byte, in order` | `tests/lib/openFile.test.ts` | `multiple` is forwarded to BOTH branches, pinned; the pending-on-old-browser case has no pin because it has no signal to pin (see the debt row). |
| A file name maps to a legal object name, or THROWS | 10 tests, incl. `an ordinary messy name maps to a legal one and REPORTS the change` · `a name carrying a POSIX path is reduced to its basename` · `a 200-character name maps to at most 64 legal characters and keeps its extension` · `a name that CANNOT map throws, and never returns a placeholder` | `tests/lib/name.test.ts` | Arm B below: stop keeping the extension past 64 chars → the 200-character pin RED. |
| Settings: defaults on empty, round-trip, corrupt REPORTED (not silent), key cleared alone | 13 tests, incl. `invalid JSON is REPORTED as corrupt, with the defaults and a problem — never silent` · `forgetKey clears ONLY the key and leaves baseUrl and store exactly as they were` · `the thrown validation error names the failing FIELD and never the credential value` | `tests/settings/settings.test.ts` | The corruption arms are the two `corrupt` tests; the credential check is `not.toContain(secret)`. |

## Raw logs

The gate writes to `.gate-logs/gate.log` (gitignored). The raw log is kept until the
landing is verified. **Never pipe a run through `tail`/`head`.**

## Per landing

### day-1 scaffold — no ledger row (the machinery itself)

- **Gate:** cheap tier `pnpm run typecheck` (exit 2, suite NOT run); full gate
  **exit 0** on **2/2 tests**, raw log `.gate-logs/gate.log`.
- **Differential:** the worktree-isolation arms below (this is the one pinned
  behaviour the scaffold owns).
- **Acceptance test for the machinery** (upstream `scaffold/README.md`):
  `bash scripts/board.sh` → `BOARD RECONCILED` (exit 0), and
  `GATE_TESTS=0 bash scripts/gate.sh` → exit **2**. **`2` is never "the gate
  passed".**

### worktree isolation — the defect the day-1 gate caught on itself

Found by reading a count, not by luck: the first full gate reported **3 passed**
for a tree holding **ONE** test file. Vitest's default include globs the repo
root, and writers' worktrees live at `worktrees/<slice>/` INSIDE it — so the MAIN
tree's run collected each worktree's copy of every test. A worktree's red would
have been reported against `main`, and `main`'s counts would have described three
trees at once.

- **Arm A — baseline, hash printed, suite run whole:** `vite.config.ts`
  `sha256=bf6da9f7dd52eb81c1c5184aa7a1d9fb684b57ffe6cbe494ac193a69b62d6516` → pin
  **PASS** (exit 0); whole suite **2 test files, 2/2 tests**, exit 0.
- **Arm B — injection: `'**/worktrees/**',` deleted from `test.exclude`:** hash
  `sha256=63762060c274bb8d95b039eda063dece5aa8c896d6c264a3299dd69537d3e4df` — a
  DIFFERENT hash, so the arms are not VOID → the pin goes **RED** (exit 1, "Failed
  Tests 1") AND the whole suite collects **4 test files** (`1 failed | 3 passed`):
  the two worktrees' copies are back, which is the defect itself, observed.
- **Arm C — restored from HEAD:** hash returns to
  `bf6da9f7dd52eb81c1c5184aa7a1d9fb684b57ffe6cbe494ac193a69b62d6516`, identical to
  Arm A; suite **2/2**, exit 0. The injection ran under the gate lock
  (`.gate-lock` held by the differential's own pid) and the restore was in a
  `trap`, from HEAD on a COMMITTED tree — never `git checkout -- <path>` in a tree
  with uncommitted work.
- **Why the pin reads the config as TEXT:** importing `vite.config.ts` and calling
  it from inside the runner dies with `TypeError: The URL must be of scheme file`
  (`fileURLToPath(new URL('./src', import.meta.url))`, because vitest's transform
  hands the module a non-`file:` URL). Measured, not assumed — the first version
  of this pin failed exactly that way, and the log is in `.gate-logs/`.

### ad5c839 — row 8 (the browser IO seams and the settings seam)

- **Gate:** `bash scripts/gate.sh`, cheap tier (typecheck) + full tier (lint + the
  whole suite) — **exit 0**. Counts read from the raw log, not inferred from the exit
  code (the worktree-isolation TRAP): **6 test files, 47 passed / 47 tests**. The suite
  was **2 test files / 2 tests** before this landing, so the new files are the 45 pins
  in the matrix above. Raw log `.gate-logs/gate.log` (the gate writes it to the git
  COMMON dir, which is this `/home/administrator/projects/FileStore` checkout's
  `.gate-logs/`; a copy is kept in the writer's worktree).
- **Peak memory:** the gate's own ceiling, `NODE_OPTIONS=--max-old-space-size=4096`
  (set inside `scripts/gate.sh`, not remembered by hand); the suite run took 3.5 s
  wall. No browser was started — every pin is jsdom — so no browser tree was owed a
  kill.
- **COPIES: 2→1 — the owner-cancel predicate (`src/lib/abort.ts`).** The Imager ports
  would have carried two verbatim copies of `isAbortError` (one per seam); it was
  folded into `src/lib/abort.ts` before either seam shipped. Checked by grep:
  `isAbortError` appears in exactly three places — its definition (`src/lib/abort.ts`
  line 17) and its two imports and calls (`src/lib/saveFile.ts` line 126,
  `src/lib/openFile.ts` line 177). There is no fourth definition and no inline
  `name === 'AbortError'` test outside that module (the remaining `AbortError`
  occurrences are the picker stubs in the two test files, which must name the browser's
  real error, and the two seam headers' branch matrices).
- **Arm A — injection: the save seam builds its bytes BEFORE the picker.**
  `src/lib/saveFile.ts`
  `sha256=b61f07374f1768660a6a1433c821e9f9eb41d5a88a1ea09e16d469670216dcd6` → injected
  `sha256=d8f3ef59fe29dcaf5502587f460340255a08f80cacb5e0f8ee61ba55d86da155` (a
  DIFFERENT hash, so the arms are not VOID). The pin's OWN test file run alone goes
  **RED** (exit 1):
  `a cancelled picker is the owner changing his mind: silent, and nothing was built`
  → `AssertionError: expected "vi.fn()" to not be called at all, but actually been
  called 1 times`; and the companion ordering pin
  `the bytes are built AFTER the picker returns, so a slow build cannot lose the click`
  → `expected "vi.fn()" to be called 1 times, but got 2 times`. The property broken is
  the one the seam's shape exists for: a cancel must never pay for the build.
- **Arm B — injection: the name mapping stops keeping the extension past 64
  characters.** `src/lib/name.ts`
  `sha256=f4254ded417da40621d7f3849b3a648a14317d04553c5870418a5f260e0a7256` → injected
  `sha256=6c73549bee792be372b80ab3ff5fa42d4171d96c37eb545318ae5febcdda4f57`
  (different, so not VOID, and different from arm A's because it is a different file).
  Pin **RED** (exit 1):
  `a 200-character name maps to at most 64 legal characters and keeps its extension` →
  `AssertionError: expected false to be true` (the mapped name no longer ends `.pdf`).
- **Arm C — restore from HEAD, in a `trap`:** both files returned to their `before`
  hashes (`saveFile.ts` = `b61f073…`, `name.ts` = `f4254de…`), on a tree whose source
  was COMMITTED first (`ad5c839`), so the restore was `git checkout -- <path>` from
  HEAD and could not wipe uncommitted work. The injection ran with no second actor in
  the tree; the gate lock was not taken, because the differential is not a shared
  expensive check.
- **What is NOT pinned, and is debt rather than a papered-over gap:** a dismissed dialog
  on a browser with neither the picker nor the input `cancel` event leaves `openFile`'s
  promise PENDING. There is no signal to assert on, so there is no pin; the alternative
  — inventing a `cancelled` the browser never sent — is the silent fallback rule 1
  forbids. See `docs/ARCHITECTURE.md` §4.

