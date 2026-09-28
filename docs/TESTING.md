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
| A file name maps to a legal object name, or THROWS (and the bound is the server's landed 1024) | 17 tests, incl. `OBJECT_NAME_MAX_LENGTH is 1024 and the pattern accepts exactly the server’s landed rule at both edges` · `an ordinary messy name maps to a legal one and REPORTS the change` · `a 1200-character name maps to at most 1024 legal characters and keeps its extension` · `an extension too long for the whole 1024-character budget is dropped, never half-kept` · `a name that CANNOT map throws, and never returns a placeholder` | `tests/lib/name.test.ts` | **Arm B below (row 10):** under-count the folder's characters → the folder-aware truncation pin RED. The old `a 200-character name …64…` arm (row 8) is retired with its pin, which was rewritten to the new bound. |
| A folder is a naming convention with an exact inverse, and an illegal path is REFUSED | 10 tests, incl. `a mapped file name can NEVER contain the folder separator (the reserved-separator property)` · `the empty-folder marker name can never be produced by mapping a file name` · `parseFolderPath and formatFolderPath are exact inverses, and '' is the root` · `a nested path round-trips: joinFolder(['docs','reports'], 'report.pdf') splits back to exactly that folder and file part` · `folderPrefix returns a value that is itself a LEGAL object-name prefix` · `folderMarkerName is a legal object name and ends with the separator` · `ancestors returns the breadcrumb root-first, and parentFolder of the root is the root` · `an illegal folder segment is REFUSED loudly rather than sanitised into a different folder` | `tests/lib/folder.test.ts` | **Arm A below:** stop collapsing runs of `-` → the reserved-separator pin RED (9 neighbours green). **Arm C below:** weaken `isFolderSegment` to plain name legality → the segment-refusal and marker pins RED (8 neighbours green). |
| Mapping into a folder keeps the full name legal and `changed` describing the FILE part only | ``mapping into a folder returns the FULL store name and keeps `changed` describing the FILE name only`` · `a file name longer than the bound maps into a folder to a legal name of at most the bound, keeping its extension` · `toObjectName(fileName) with no folder behaves EXACTLY as before — the row-9 call site is untouched` · `mapping into an ILLEGAL folder segment throws ObjectNameMappingError rather than guessing a folder` | `tests/lib/name.test.ts` | **Arm B below:** under-count the folder's characters; the folder-aware truncation pin RED while the root-behaviour pin beside it stays green. |
| Settings: defaults on empty, round-trip, corrupt REPORTED (not silent), key cleared alone | 13 tests, incl. `invalid JSON is REPORTED as corrupt, with the defaults and a problem — never silent` · `forgetKey clears ONLY the key and leaves baseUrl and store exactly as they were` · `the thrown validation error names the failing FIELD and never the credential value` | `tests/settings/settings.test.ts` | The corruption arms are the two `corrupt` tests; the credential check is `not.toContain(secret)`. |

| The key travels in exactly ONE header and appears in no URL, no message, no log | `the key travels in exactly ONE header and appears in no URL, no log and no error message` | `tests/server/store-client.test.ts` | Send the key in a query string or a second header: the capture loop finds a second header carrying it, or the URL assertion fires. |
| A non-OK response becomes a typed error carrying the service's own `code` (401/403/404/409/413/429) | `a non-OK %i becomes a typed error carrying the service's own code (%s)` | `tests/server/store-client.test.ts` | Delete `'conflict',` from `SERVER_STORE_API_CODES` — **watched RED (Arm D)**. |
| A `429` is reported, never retried, and its `Retry-After` is surfaced | `a 429 is REPORTED, never retried, and its Retry-After is surfaced` | `tests/server/store-client.test.ts` | Wrap the request in a retry loop: `calls` length becomes 2. |
| `listObjects` sends `?prefix=` only when a prefix is given; a matching-nothing prefix is `[]` | `listObjects sends ?prefix= only when a prefix is given, and a legal prefix that matches nothing yields [], not an error` | `tests/server/store-client.test.ts` | Always append `?prefix=`: the unfiltered call's URL assertion fires. |
| `getObject` refuses a missing/malformed `x-serverstore-sha256`, and zero bytes | `getObject refuses a response missing a valid x-serverstore-sha256, and refuses zero bytes` | `tests/server/store-client.test.ts` | Weaken the digest check to `if (sha256 === null)` — **watched RED (Arm C)**. |
| `putObject` refuses a zero-byte payload without issuing a request | `putObject refuses a zero-byte payload WITHOUT issuing a request` | `tests/server/store-client.test.ts` | Disable the byte-length guard — **watched RED (Arm B)**; `assert fetch was NOT called`. |
| A JSON body that does not match the schema is a typed `invalid-response`, never empty data | `a JSON body that does not match the schema yields a typed invalid-response, never empty data` | `tests/server/store-client.test.ts` | `catch` the zod failure and return `[]` instead of throwing. |
| Exactly ONE module under `src/` calls `fetch(` | `exactly ONE module under src/ calls fetch( — the ServerStore transport` | `tests/architecture/one-fetch.test.ts` | Add a `fetch(` to any other `src/` file: the file list gains a member. Reads `src/` from DISK; never imports. |
| The `Authorization` header is built in exactly ONE `src/` module | `the Authorization header is BUILT in exactly ONE src/ module` | `tests/architecture/one-fetch.test.ts` | Build the header in a second `src/` module: the file list gains a member. |
| With no stored key the app shows the settings form, says it is NOT CONFIGURED, and issues NO store request | `with no stored key the app renders the settings form, says it is NOT CONFIGURED, and issues NO store request` | `tests/features/settings.test.tsx` | Make `useStore` probe anyway (drop the empty-key branch): `whoami` is called. Or render `FileBrowser` unconditionally: `listObjects` is called. |
| A corrupt stored settings value is SURFACED with its problem, never silently ignored | `a CORRUPT stored value is SURFACED with its problem text, never silently ignored` · `a corrupt value that IS json but not settings names the failing field, and still no request` | `tests/features/settings.test.tsx` | Render the form as if the read were `ok` (drop the `corrupt` branch in `SettingsPanel`): the `alert` disappears. |
| "Forget key" clears ONLY the key and returns the app to unconfigured | `"Forget key" clears the key, leaves baseUrl and store as they were, and returns the app to unconfigured` | `tests/features/settings.test.tsx` | `setSettingsRead({status:'ok', settings: DEFAULT_SETTINGS})` instead of re-reading after `forgetKey()`: `baseUrl`/`store` change and the pin REDs. |
| The key is a password field, and the panel warns that it is stored in this browser | `the key field is a password and the panel warns that the key is stored in this browser` | `tests/features/settings.test.tsx` | Change `type="password"` to `type="text"`, or delete the warning paragraph. |
| "Test connection" proves the DRAFT key with `whoami` and reports label, stores and permissions | `"Test connection" proves the DRAFT key with whoami and reports its label, stores and permissions` | `tests/features/settings.test.tsx` | Show a hard-coded "OK" instead of the `WhoAmI`: the label/stores/perms assertions RED. |
| A failed probe/test shows the service's own words, inline AND through the toast | `a failed "Test connection" shows the service’s own words inline AND through the toast surface` · `a listing failure surfaces the service’s own message, inline AND through the toast surface` · `a failed object read surfaces the service’s own message and saves nothing` · `a failed delete surfaces the service’s own message, never a silent success` · `an upload failure surfaces the service’s own message and writes nothing else` | `tests/features/{settings,files,download}.test.tsx` | `catch {}` the failure (or report only `error.code`): the service message assertion REDs. |
| After a FAILED request the STORED key is in NO rendered text, NO toast and NO URL | `after a FAILED request the key appears in NO rendered text and NO toast` | `tests/features/settings.test.tsx` | Disable `redactCredential` (Arm D below): `document.body.textContent` and the toast text carry the key. This pin covers the STORED-key path only; the credential actually in use is the row below. |
| A FAILED test of a DRAFT key redacts THAT key too, not only the stored one | `a FAILED test of a DRAFT key redacts THAT key too, not only the stored one` | `tests/features/settings.test.tsx` | **Arm E below**: drop the explicit credential from `redactCredential`'s candidates → the alert reads `the key [redacted]_credential_111` (the draft key in plain text) while the stored-key pin beside it stays GREEN, so the arm is specific. Before the fix this pin was RED with exactly that output. |
| The settings seam refuses an invalid value LOUDLY and writes nothing | `saving an invalid Base URL is refused LOUDLY and writes nothing` | `tests/features/settings.test.tsx` | Swallow the `writeSettings` throw: no toast, and the pin's `errorSpy` assertion REDs. |
| The four connection states, and nothing thrown into the shell | `with no key the hook is unconfigured and proves NOTHING with whoami` · `a whitespace-only key is the same honest first run, not a request with a blank credential` · `a stored key becomes ready carrying the WhoAmI, proven through whoami` · `a refused key becomes failed carrying the error, and NOTHING throws into the shell` · `changing the settings proves the NEW key again` | `tests/app/useStore.test.tsx` | Remove the empty-key branch (`whoami` with a blank credential); or let the rejection escape the `.then` handler: the `failed` state never arrives. |
| The listing shows the count and the four stored facts, with the digest TRUNCATED | `the listing shows the count and each object’s name, size, creation time and TRUNCATED digest` | `tests/features/files.test.tsx` | Render the full digest (or drop `size`/`createdAt`): the `title`/`queryByText` assertions RED. |
| Refresh re-reads the listing | `Refresh re-reads the listing, so a change made by another program becomes visible` | `tests/features/files.test.tsx` | Point the button at a no-op: the new object never appears. |
| A zero-byte file is refused with a reason BEFORE any request | `a zero-byte file is refused with a reason BEFORE any request is issued` | `tests/features/files.test.tsx` | Move the `bytes.length === 0` check after the collision listing: `listObjects` is called and the pin REDs. |
| An unmappable name is an error, never a guess | `a name that cannot map is reported as an error and NEVER guessed into an object name` | `tests/features/files.test.tsx` | `catch` the `ObjectNameMappingError` and substitute a placeholder: the refusal toast disappears and `putObject` is reached. |
| The name mapping is shown BEFORE anything is written | `an upload shows the name mapping BEFORE anything is written` | `tests/features/files.test.tsx` | Write on pick (skip the review): `putObject` is called before the assertions. |
| An existing object name REFUSES until the owner confirms, and the confirmation names BOTH | `an upload whose object name ALREADY EXISTS refuses until the owner confirms, and the confirmation names BOTH` | `tests/features/files.test.tsx` | Arm B below: make `unconfirmedOverwrites` return `[]` → the write happens unconfirmed. |
| A new name needs no confirmation and refreshes the listing | `a NEW name needs no confirmation: the reviewed file is written and the listing refreshes` | `tests/features/files.test.tsx` | Drop the `onUploaded()` refresh: `listObjects` is not called again. |
| A cancelled open / a discarded review / a cancelled delete toasts NOTHING and issues no request | `a cancelled open dialog issues NO request and shows NOTHING` · `discarding a review is the owner changing his mind: no request, no toast` · `a delete asks first, and a CANCELLED confirmation issues no request and no toast` | `tests/features/files.test.tsx` | Toast on the `cancelled` outcome: `allToasts()` is no longer `''`. |
| A real failure from the open seam is surfaced, never silent | `a real failure from the open seam is surfaced — never a click that silently did nothing` | `tests/features/files.test.tsx` | Drop the `try`/`catch` around `openFile`: the rejection is unhandled and no toast is recorded. |
| A confirmed delete destroys the named object and re-reads the listing | `a confirmed delete destroys exactly the named object and re-reads the listing` | `tests/features/files.test.tsx` | Call `deleteObject(target, '')`/skip the refresh: the argument or `listObjects` assertion REDs. |
| A download is VERIFIED against `x-serverstore-sha256`, and a mismatch writes NOTHING | `a digest MISMATCH refuses the save: unverified bytes are never written` | `tests/features/download.test.tsx` | Arm C below: `if (received !== object.sha256)` → `if (false)` → the bytes reach the anchor. |
| A verified download goes through the REAL save seam with the object name and exact bytes | `a verified download goes through the save seam with the object name and the exact bytes` | `tests/features/download.test.tsx` | Suggest `file.name`/a MIME type, or pass pre-built bytes: the `anchor.download`/blob assertions RED. |
| A CANCELLED save toasts nothing, errors nothing, and fetches nothing | `a CANCELLED save produces NO toast and NO error — and fetches nothing` | `tests/features/download.test.tsx` | Build the bytes before the picker: `getObject` is called before the cancel. |
| A real error never auto-dismisses; the service's own message and a 429's wait are shown | `a real error is shown until the owner dismisses it — it never auto-dismisses` · `a store failure surfaces the service’s own message, with its code` · `a 429 is reported WITH the wait the service asked for, and says it was not retried` | `tests/lib/toast.test.ts` | Drop `duration: Infinity`; report `error.code` instead of `error.message`; drop the retry note. |
| The credentials the app knows about are redacted at EVERY occurrence, and an empty key redacts nothing | `the key never survives into a toast, even when the service’s message echoes it back` · `the credential is redacted at EVERY occurrence, not only the first` · `an empty stored key redacts nothing, so ordinary text is never mangled` · `the text a caller renders inline is the SAME redacted text the toast shows` | `tests/lib/toast.test.ts` | Arm D below: redaction off. Replace `split/join` with a single `replace`: only the first occurrence goes. These pins exercise `redactCredential` through the STORED key; the in-use credential is threaded by the panel and pinned at `tests/features/settings.test.tsx` (the DRAFT-key row). |
| The digest is the PUBLISHED SHA-256, in lowercase hex, for any input | `a known byte string digests to the PUBLISHED SHA-256, in lowercase hex` · `the empty byte string digests to the published empty SHA-256 (hashing is not a size check)` · `any input yields exactly 64 lowercase hex characters — no uppercase, no base64, no padding` | `tests/lib/sha256.test.ts` | Encode with `toString(16)` on the buffer, or hash the text form of the bytes: the published vector REDs. |
| Sizes and timestamps are deterministic, and a bad value is LOUD or shown as sent | `a byte count reads in binary units, with the service’s own 64 MiB limit legible` · `a size that is not a real byte count is a LOUD refusal, never a plausible 0 B` · `an ISO timestamp reads as the UTC instant the service stored` · `a timestamp that is not a parseable date is shown EXACTLY as sent, never invented` | `tests/lib/format.test.ts` | Use `toLocaleString()` for the timestamp: the UTC assertion REDs on a host in another zone. Return `'0 B'` for a bad size: the `RangeError` pin REDs. |

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

### 6718f9d — row 7 (the ServerStore transport seam)

- **Gate:** the ONE command, full tier, **exit 0** — cheap (`pnpm run typecheck`)
  then lint + suite; **5 test files, 30/30 tests**; raw log `.gate-logs/gate.log`
  (the git COMMON dir's, `/home/administrator/projects/FileStore/.gate-logs/gate.log`,
  so every worktree shares one log). A measured run under `/usr/bin/time -v`:
  **peak RSS 696,052 KB**, wall **12.02 s** (the gate itself sets
  `NODE_OPTIONS=--max-old-space-size=4096`). **The COUNT was read, not just the exit
  code** (BOARD trap): 5 files for a tree holding 5 test files — the other writer's
  worktree copies were NOT swept in. My own files hold 28 of the 30 tests
  (`tests/server/store-errors.test.ts` 8, `tests/server/store-client.test.ts` 18,
  `tests/architecture/one-fetch.test.ts` 2); the other 2 are the day-1 shell and
  worktree-isolation pins.
- **Differential** (the author's own; three injections against the COMMITTED tree,
  under the shared gate lock, restore from HEAD in a `trap`, every arm's hash
  printed). Run at the feat commit (`98b3e1e`, rebased to `6718f9d` with the same
  blobs — re-measured: `git show HEAD:src/server/store-client.ts | sha256sum`
  equals Arm A exactly). Two arms with identical hashes would be VOID; none are.
  - **Arm A — baseline, untouched HEAD:** `store-client.ts`
    `sha256=2d4fedbadd3b9317fa13bb073c4581396f734981a9e6657c21fb6ac9603ca3c8`,
    `store-errors.ts`
    `sha256=44ef239979fade30c240b05829859894162db810361d26d3d921aa312574a3ba` →
    both pin files **PASS** (2 files, **26/26** tests, exit 0).
  - **Arm B — injection: `if (bytes.length === 0) {` → `if (bytes.length < 0) {`**
    (the zero-byte guard): `store-client.ts`
    `sha256=bddcaf162180a12ce5a82bafd9fc8de3d2933f5eb2d12db373d6160c901ac088` — a
    DIFFERENT hash, so not VOID → **RED** (exit 1, **2 failed | 16 passed**):
    `putObject refuses a zero-byte payload WITHOUT issuing a request` and
    `getObject refuses a response missing a valid x-serverstore-sha256, and refuses
    zero bytes`. The guard is the same literal text in both functions, so one edit
    disabled both byte-length checks — two distinct pins red is honest evidence
    that both hold the property, not a wrong-file signal.
  - **Arm C — injection: digest check weakened to `if (sha256 === null) {`:**
    `store-client.ts`
    `sha256=d51d15b65a19393327f1c6880604e7259d04e4cbd088bc99f59b6c2c85a8155a` —
    DIFFERENT → **RED** (exit 1, **1 failed | 17 passed**): `getObject refuses a
    response missing a valid x-serverstore-sha256, and refuses zero bytes`.
  - **Arm D — injection: `'conflict',` deleted from `SERVER_STORE_API_CODES`:**
    `store-errors.ts`
    `sha256=eec64c9f625f4f4bf7398461127f3fedd97e87a55c24a08e55a60038a75b0e57` —
    DIFFERENT → **RED** (exit 1, **1 failed | 17 passed**): `a non-OK 409 becomes a
    typed error carrying the service's own code (conflict)`. This is exactly the
    state Imager's ported copy was in — a real `409` reported as `invalid-response`.
  - **Arm E — restored from HEAD:** both hashes identical to Arm A → both pin files
    **PASS** (26/26, exit 0). No injection escaped.
- **COPIES: 1 — checked** (grepped: `fetch(` and `Authorization` across `src/`; each
  occurs in exactly `src/server/store-client.ts`, pinned by
  `tests/architecture/one-fetch.test.ts`, which reads the files from disk). The
  OTHER copy this repo carries is Imager's, across the repo boundary — that is
  named debt in ledger row 5, not a second seam inside this tree.

### the one-fetch pin's precision — a false red the dispatcher's own differential found

Found while verifying row 7. This is the class the doctrine points at: the pin was
**GREEN on the real tree**, so nothing was failing — but an injection aimed at the
*pin* (not at the code) proved it could report a failure that did not exist.

The pin stripped BLOCK COMMENTS before looking for `Authorization`, but its `fetch(`
check read the raw text. So a `src/` file carrying a comment that merely MENTIONED a
fetch call turned the structural pin RED with no call in existence — a false red the
next writer would have chased as a missing-pin signal.

Fix: `stripBlockComments` → `stripComments`, applied to BOTH checks, with the
line-comment arm requiring a character other than `:` before `//` so it cannot eat the
`https://` scheme the original author was protecting.

- **Arm 1 — baseline:** `src/App.tsx`
  `sha256=970c1f13916ea0260510ddb98411089b5d15d408356e806a6ba112bef2a5ede2` → pin
  **PASS** (2/2, exit 0).
- **Arm 2 — a block comment in `src/App.tsx` that merely mentions a fetch call:**
  `sha256=f94afac259365bb256eb5057d07a4599740c8f3331ec5bfb5cd0efa6fde1721d` —
  DIFFERENT → **exit 0, 2/2**: the false red is GONE. (The same file was RED before the
  fix; this arm is the regression test for it.)
- **Arm 3 — a REAL second `fetch(` call appended to `src/App.tsx`:**
  `sha256=eb0c647f8862b1b0b18adc6f642b2ad061c04c8a1a56d5f0937a90bb635aa4de` —
  DIFFERENT → **RED** (exit 1) on `exactly ONE module under src/ calls fetch( — the
  ServerStore transport`. The pin still holds the property it exists for, so the fix
  removed a false red WITHOUT blunting the pin.
- **Arm 4 — restored from HEAD:** `src/App.tsx`
  `sha256=970c1f13916ea0260510ddb98411089b5d15d408356e806a6ba112bef2a5ede2`, identical
  to Arm 1; pin 2/2, exit 0.

The general lesson: **a structural pin that greps text must strip comments on EVERY
term it greps, not only on the one where the need was first noticed.** The asymmetry
was invisible until an injection aimed at the pin rather than at the code.

### the integration — rows 7 and 8 merged (a14730a)

- **Conflicts:** `docs/DECISION-LEDGER.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`
  ONLY. **Zero source files overlapped** — the file-disjointness the briefs were built
  on held, and the docs conflict is the one the rules predict and call mechanical.
- **Resolution:** a union, built programmatically from the merge stages rather than
  retyped (`:2:` ours, `:3:` theirs) so no row could be transcribed wrong: every row of
  both landings kept; ledger row 5 rewritten because BOTH halves of the port deviation
  are now in; the union was checked by counting (8 ledger rows, 7 seam rows, both
  landing sections present, zero conflict markers).
- **Dispatcher's own gate on the INTEGRATED tree:** `bash scripts/gate.sh` → **exit 0**,
  **9 test files, 75/75 tests**, peak RSS **733,772 KB**, raw log `.gate-logs/gate.log`.
- **A merge, not a rebase:** each landing's docs name its own sha, and every `LANDED`
  sha must be an ancestor of `origin/main`. A rebase would have rewritten `6718f9d` and
  `ad5c839` and left the docs pointing at commits that do not exist.
- **Dispatcher cleanup in the same landing:** removed a dead `.gitignore` entry
  (`/.differential-row8/` — the whole `worktrees/` tree is already ignored, so it could
  never match), and `docs/BOARD.md` records the force-push and pin-precision traps.

### 80d7186 — row 9 (the UI slice: settings, listing, upload, download, delete)

**Corrected forward at `8d131d5`** — the dispatcher's probe found a DRAFT-key
redaction gap in this landing; see the section below. Everything in THIS section
is what was measured at `80d7186`, kept as history.

- **Gate:** the ONE command, `bash scripts/gate.sh` (cheap `pnpm run typecheck`, then
  lint + the whole suite), run **in-turn and UN-PIPED** with the output redirected to
  files rather than filtered — **exit 0**. Counts read from the raw log, not inferred
  from the exit code (the worktree-isolation TRAP): **16 test files, 127 passed / 127
  tests**. The baseline before this slice was **9 files / 75 tests**, so the landing's
  contribution is **7 new files and 52 pins**; every one of the original 9 files is
  still collected and green. Peak RSS **762,488 KB**, wall **22.70 s**
  (`/usr/bin/time -v`; the gate itself sets `NODE_OPTIONS=--max-old-space-size=4096`).
  Raw log kept twice: the git COMMON dir's
  `/home/administrator/projects/FileStore/.gate-logs/gate.log` and a copy at
  `/home/administrator/projects/FileStore/worktrees/ui-shell/.gate-logs/gate.log`
  (that directory is gitignored from the worktree root too — verified with
  `git check-ignore`).
- **Rebase before the docs, deliberately:** `origin/main` had advanced by 3 commits
  (all `docs/BOARD.md`) while this slice was being written, so the branch was rebased
  onto `6e1287e` BEFORE the docs commit. The source+tests tip is `80d7186` — the sha
  the docs name — and it is an ancestor of the pushed branch, not a commit that a later
  rebase would have replaced. The gate above ran on exactly that tree.
- **Differential** (my own; three injections against the COMMITTED tree, restore from
  HEAD inside a `trap`, every arm's hash printed BEFORE and AFTER). No two arms share a
  hash, so none is a VOID probe.
  - **Arm A — baseline, untouched HEAD:** `src/features/files/upload.ts`
    `sha256=d9cdade6acc89f838db24acfd0d2319d5cdbcb7a524db2a45b7c9b76fa01cee8`,
    `src/features/files/download.ts`
    `sha256=2cf4e989de9b0b219546c2de26e3b56489cf3aa4bdb25f1fcadab78e80e3eec2`,
    `src/lib/toast.ts`
    `sha256=c493c69704498a105f7de8fa96ea35320afe1bae07a6b96ba181ff5430545dff` → the
    four pin files **PASS** (4 files, **38/38** tests, exit 0).
  - **Arm B — injection: the overwrite gate returns nothing.** `upload.ts`:
    `(review) => collisions.has(review.objectName) && !confirmed.has(review.objectName)`
    → `() => false`; `sha256=de40f21c7067b3d70e14faea076f03892687ac63cf208afb8eaaafd821720f86`
    — a DIFFERENT hash, so not VOID → **RED** (exit 1, **1 failed | 14 passed**):
    `an upload whose object name ALREADY EXISTS refuses until the owner confirms, and the
    confirmation names BOTH` — the unconfirmed `PUT` went through. This is exactly the
    silent clobber ledger row 4 exists to forbid.
  - **Arm C — injection: the digest comparison disabled.** `download.ts`:
    `if (received !== object.sha256) {` → `if (false) {`;
    `sha256=05c8901c1f736dd88a2ea113ae27ba284a68de5510322d59d2ab51736e94c497` —
    DIFFERENT → **RED** (exit 1, **1 failed | 3 passed**): `a digest MISMATCH refuses the
    save: unverified bytes are never written` — the mismatched bytes reached the anchor
    download, i.e. the disk.
  - **Arm D — injection: credential redaction off.** `src/lib/toast.ts`:
    `if (key === '') return text;` → `return text;` (the function returns unconditionally);
    `sha256=4cc2a5684b34352535d3eceeb32ad5f1dbe198b86d0f768b511b22ab4a8e9748` —
    DIFFERENT → **RED** (exit 1, **4 failed | 15 passed**): `after a FAILED request the key
    appears in NO rendered text and NO toast`, plus three in `tests/lib/toast.test.ts`
    (`the key never survives into a toast…`, `the credential is redacted at EVERY
    occurrence…`, `the text a caller renders inline is the SAME redacted text the toast
    shows`). Four named pins hold the property from two directions: the composition and
    the surface.
  - **Restore:** every arm's file returned to its Arm-A hash
    (`d9cdade6…`, `2cf4e989…`, `c493c697…`), `git status` clean, and
    `git show HEAD:<file> | sha256sum` matches each restored file. No browser was
    started (`ps -eo comm= | grep -cE '^(chrome|chromium|headless_shell|playwright)$'`
    → `0`), so no tree was owed a kill.
- **COPIES: 1 — checked, no duplication** (grepped: `crypto.subtle` — ONE site,
  `src/lib/sha256.ts:25`; `toObjectName` — ONE call site,
  `src/features/files/upload.ts:71`; `errorMessage` — ONE composition,
  `src/lib/toast.ts:100`, shared by the toast and the three inline render sites
  (`src/App.tsx:97`, `src/features/files/useObjects.ts:48`,
  `src/features/settings/SettingsPanel.tsx:197`); `storeTargetFrom` — ONE
  settings→`StoreTarget` mapping, `src/app/useStore.ts:51`, used by `src/App.tsx:103`
  and `SettingsPanel.tsx:79`; `isAbortError` — still ONE predicate,
  `src/lib/abort.ts:17`, row 8's fold intact with its two callers). The one thing this
  slice FOLDED is the owner-facing error text: before it, each failure render composed
  its own string; now the toast and every inline render share `errorMessage`, and the
  credential redaction rides on that single composition.
- **What is NOT pinned, and is debt rather than a papered-over gap:** the collision
  check is read-then-write (another client can win the race — the API has no conditional
  write); the digest is the service's own header, unsigned, so a party who rewrites both
  the body and the header is not detected; `showSaveFilePicker` is only ever stubbed, so
  no byte has been written through a real picker or against the live service; and the
  whole-app round trip needs the owner's `Arnd` key, which no agent may hold. See
  `docs/ARCHITECTURE.md` §4.

### 8d131d5 — row 9, CORRECTED FORWARD: the DRAFT-key redaction gap

**The claim was broader than the code, and the dispatcher's probe caught it.** The
row-9 landing said the credential is redacted at every occurrence. It was not:
`redactCredential` read the STORED key through `readSettings()`, while the Settings
panel's "Test connection" sends a DRAFT key that is not saved yet — the key most
likely to be brand new and therefore wrong.

- **The dispatcher's probe** (a scratch file, since deleted; the branch tip was and is
  untouched by it): stored `ssk_STORED_old_credential_000`, typed
  `ssk_DRAFT_new_credential_111` into the Key field, mocked `whoami` to reject with a
  `ServerStoreError` whose `message` and `serverMessage` contain the draft key, clicked
  "Test connection", and read the DOM:

  ```
  PROBE-RESULT draft_in_dom=true draft_in_toast=true redacted_marker=false
  AssertionError: expected 'Could not use the key: the key ssk_DR…' not to contain
                  'ssk_DRAFT_new_credential_111'
  Received: "Could not use the key: the key ssk_DRAFT_new_credential_111 was rejected"
  ```

  Rendered TWICE, in plain text, both `<p role="alert">`: `The connection test failed:
  the key ssk_DRAFT_new_credential_111 was rejected` and `Could not use the key: the key
  ssk_DRAFT_new_credential_111 was rejected`.
- **The probe's own CONTROL, so it was not a broken probe:** the landing's
  `after a FAILED request the key appears in NO rendered text and NO toast` still
  PASSED for the stored key (`1 passed | 9 skipped`). The mechanism worked; its SCOPE
  was one credential too narrow.
- **My own reproduction, before touching the code:** the new pin was written FIRST and
  run against the unfixed tree — **RED** (raw log `.gate-logs/pre-fix-repro.log`):

  ```
  FAIL  tests/features/settings.test.tsx > a FAILED test of a DRAFT key redacts THAT key too, not only the stored one
  Expected element to have text content:  the key [redacted] was rejected
  Received: The connection test failed: ServerStore refused (unauthorized): the key [redacted]_credential_111 was rejected
  ```

  That output also exposed a second defect in the same function, which the fix closes:
  the STORED key was a prefix of the draft key, so a naive `split/join` per credential
  redacted the shorter one and left the remainder of the longer one in the text. The
  candidates are now redacted **longest first**, and the new pin holds that too (its
  draft key is deliberately a superstring of the stored one).
- **The fix** (`src/lib/toast.ts`, `src/features/settings/SettingsPanel.tsx`):
  `redactCredential(text, credential?)` redacts the stored key ALWAYS and the caller's
  credential IN USE when one is given — neither path depends on the other;
  `errorMessage(error, context?, credential?)` and `ToastErrorOptions.credential` thread
  it; every existing call site is unchanged and keeps the stored-key default. The panel
  passes `draft.key` to the toast AND to the inline message, and its failed-probe state
  now carries that already-composed message rather than the raw error, so an edit to the
  key field after a failure cannot un-redact the old one, and the key does not enter
  React state.
- **Why the panel is the ONLY such call site, checked rather than assumed:**
  `storeTargetFrom` has exactly two callers (`src/App.tsx:103`, the shell's stored-settings
  probe, and `SettingsPanel.tsx:79`, the draft probe); every files flow builds its target
  from the stored settings. The save path cannot echo a key either — a zod `ZodError`
  message carries `path`/`code`/`message` and never the input value, measured for a
  `too_small` and an `invalid_format` issue with the key in the same object.
- **Gate on the fix tip (`8d131d5`):** the ONE command, in-turn, foreground, UN-PIPED,
  raw log kept — **exit 0**, **16 test files, 128 passed / 128 tests** (the file count is
  unchanged and the count is the row-9 baseline +1, as required), peak RSS **772,188 KB**,
  wall **22.36 s**.
- **Arm E (the new property watched RED), hashes printed before/after, restore from HEAD
  in a `trap`:** injection — drop the explicit credential from the candidate list,
  `const secrets = [storedKey(), credential ?? '']` → `const secrets = [storedKey(), '']`;
  `src/lib/toast.ts` `sha256=fb1e5240111d2cc4e3c4572e38f1a3368af1ded2d658157ef4cc1a319ccbd92b`
  → `sha256=efd8b740943fd45e3bd7626a78a24b7acc0f735287c5b1e1a46c0c5d90097ea5` — a
  DIFFERENT hash, so not VOID → **RED** (exit 1, **1 failed | 10 passed**) on exactly
  `a FAILED test of a DRAFT key redacts THAT key too, not only the stored one`, while the
  stored-key pin in the same file stayed GREEN (the arm is specific, not a broken file).
  Restored to `fb1e5240…`, identical to `git show HEAD:src/lib/toast.ts | sha256sum`; the
  tree is clean and no browser was started (`ps -eo comm= | grep -cE
  '^(chrome|chromium|headless_shell|playwright)$'` → `0`).
- **What remains unproven:** the redaction is still a TEXT guard, not a guarantee — it can
  only remove credentials the app knows about, so a credential that reached a message
  from somewhere else (a key the owner typed into a field the app never read, a
  server-side echo of a DIFFERENT key) is out of its reach. That is why the seams below
  must never format a key into a message in the first place; this surface is the last
  line, not the first.

### 178a0dc — row 10, slice 1 (the folder-path seam and the 1024 name bound)

- **Gate:** the ONE command, `bash scripts/gate.sh` (cheap `pnpm run typecheck`, then
  lint + the whole suite), run **in-turn and UN-PIPED** with output redirected to a file
  — **exit 0**. Counts read from the raw log, not inferred from the exit code (the
  worktree-isolation TRAP): **17 test files, 145 passed / 145 tests**. The baseline on
  the rebased base (`80e8a5a`) is **16 files / 128 tests**, so this landing adds **1 test
  file and 17 pins** (`tests/lib/folder.test.ts` 10; `tests/lib/name.test.ts` 10 → 17,
  i.e. +7). Peak RSS **776,440 KB**, wall **23.33 s** (`/usr/bin/time -v`; the gate
  itself sets `NODE_OPTIONS=--max-old-space-size=4096`). Raw log:
  `/home/administrator/projects/FileStore/.gate-logs/gate.log` — the git COMMON dir's, so
  every worktree shares one log. No browser was started (every pin is jsdom), so no
  browser tree was owed a kill.
- **Rebase before the docs, deliberately:** `origin/main` advanced from `0ebaaf9` to
  `80e8a5a` (a `docs/BOARD.md` commit) while this slice was written, so the branch was
  rebased onto it BEFORE the docs commit. The source+tests tip is `178a0dc` — the sha
  the docs name — and it is an ancestor of the pushed branch, not a commit a later
  rebase would replace.
- **The only existing pins changed, and why:** exactly TWO, both because they encoded
  the old 64-character bound. (1) the row-8 pin `a 200-character name maps to at most 64
  legal characters and keeps its extension` became `a 1200-character name maps to at
  most 1024 legal characters and keeps its extension` — under the new bound a
  200-character name is not truncated at all, so the old fixture had stopped exercising
  the truncation it was named for. (2) `an extension too long for the whole budget is
  dropped, never half-kept` became `an extension too long for the whole 1024-character
  budget is dropped, never half-kept`, its 80-character fixture widened to 1100 and its
  hard-coded `repeat(59)` derivation replaced by `OBJECT_NAME_MAX_LENGTH`. Both test
  NAMES now carry the bound. Every other existing pin is unmodified and green — the
  count (128 + 17 = 145, zero failures) is the evidence.
- **Differential** (my own; three arms against the COMMITTED tree `178a0dc`, restore
  from HEAD inside a `trap`, every arm's sha256 printed BEFORE and AFTER). No two arms
  share a hash, so none is a VOID probe. The scratch harness lived inside the writer
  worktree and was deleted before the report.
  - **Arm A — injection: `collapseDashes` stops collapsing.** `src/lib/name.ts`
    `sha256=cc7c45490f5b41f49f0efa5d658ad1bc813054221c948e31f6885140c256b62e` →
    `return value.replace(/-+/g, '-')` changed to `return value` →
    `sha256=28e186d2628ac55b48886f07c64a593eefd01691320ec52771bbec3ad46d6d0e` — DIFFERENT,
    so not VOID → `tests/lib/folder.test.ts` **RED** (exit 1, **1 failed | 9 passed**):
    `a mapped file name can NEVER contain the folder separator (the reserved-separator
    property)`. The nine neighbours in that file stayed green, so the red is the pin's
    own property and not a broken harness.
  - **Arm B — injection: the folder's characters are left out of the name budget.**
    `src/lib/name.ts` `cc7c4549…` → `return cost;` changed to
    `return cost - FOLDER_SEPARATOR.length;` →
    `sha256=d7e7a4ed84d50590435c3d4a5b3cb7a2899187e4c42b56f7338c6717049ef45f` — DIFFERENT →
    `tests/lib/name.test.ts` **RED** (exit 1, **1 failed | 16 passed**): `a file name
    longer than the bound maps into a folder to a legal name of at most the bound,
    keeping its extension` — the full name overran 1024 and `joinFolder` refused it
    loudly. The 16 neighbours, including `toObjectName(fileName) with no folder behaves
    EXACTLY as before — the row-9 call site is untouched`, stayed green.
  - **Arm C — injection: `isFolderSegment` weakened to plain name legality.**
    `src/lib/folder.ts`
    `sha256=1461792c022d584343266c9da90e870f688e7df8a899b96006d3a0e9dc853375` → the
    `&& !value.includes(FOLDER_SEPARATOR) && !value.endsWith('-')` arms removed →
    `sha256=eebe2a5edf6cc825f80a92ad9d333130da057df13c701c52228439fb9a7ae39c` — DIFFERENT →
    `tests/lib/folder.test.ts` **RED** (exit 1, **2 failed | 8 passed**): `an illegal
    folder segment is REFUSED loudly rather than sanitised into a different folder` and
    `folderMarkerName is a legal object name and ends with the separator` (the marker
    pin's `isFolderMarkerName('docs---') === false` arm rests on the same segment rule).
    Both reds guard the one rule the injection broke; the 8 pins for the inverse, the
    prefix, the marker string and the breadcrumb stayed green.
  - **Restore:** all three arms returned their file to its Arm-A hash
    (`name.ts` = `cc7c4549…`, `folder.ts` = `1461792c…`), `git status --short` clean, and
    `git show HEAD:<file> | sha256sum` matches each restored file. No browser was started
    (`ps -eo comm= | grep -cE '^(chrome|chromium|headless_shell|playwright)$'` → `0`).
- **COPIES: 1 — checked, no duplication** (grepped: `FOLDER_SEPARATOR` — ONE definition,
  `src/lib/folder.ts:44`, imported by `src/lib/name.ts` rather than restated as `'--'`;
  `toObjectName` — ONE call site, `src/features/files/upload.ts:71`, still one argument;
  `OBJECT_NAME_MAX_LENGTH` — ONE mirror, `src/lib/name.ts:55`, tied to the pattern
  literal at `:73` by the both-edges pin; `parseFolderPath`/`joinFolder` — the ONE path
  validation and the ONE name composition, reused by `folderPrefix`, `folderMarkerName`
  and `splitObjectName`). The one thing this slice FOLDED is the folder convention
  itself: without `src/lib/folder.ts` the separator, the marker rule and the prefix
  arithmetic would live in the mapper and, in slice 2, in the UI.
- **What is NOT pinned, and is debt rather than a papered-over gap:** every pin here is
  **unit-level**, because the LIVE ServerStore process is stale and still enforces 64
  characters — no live name or `?prefix=` longer than 64 has been exercised (the
  dispatcher measured the stale pid on 2026-09-28). The `--` reservation rests on
  `collapseDashes` alone, so the pins ARE the guard; and a foreign client can `PUT` a
  legal name containing `--`, which this app will read as a nested path, because the
  convention is not enforceable at the service. See `docs/ARCHITECTURE.md` §4.
