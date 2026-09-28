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
