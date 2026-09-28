# The board — what is happening right now

**This file is the state of record.** It is true *before* any report reaches the
owner. A successor session must be able to act within minutes from this file plus
`git log --oneline -10 origin/main` and `git worktree list`.

**One screen, overwritten in place.** A record that no longer describes the present
belongs in the decision ledger or nowhere.

## The contract

1. **Updated in the same commit as the landing it records.**
2. **True BEFORE the dispatcher reports to the owner.** If the session dies the second
   after that report, a successor must be able to act from this file, the ledger, and
   git alone.
3. **Every record names something checkable** — sha, branch, worktree, session id,
   path. "Probably fine" is not a record.
4. **Session start = reconcile first** (`bash scripts/board.sh`). Read it, check it
   against reality, fix what lied, report ONE line, and only then dispatch.
5. **Reconcile against the REMOTE branch, never a stale local one.**

## Record vocabulary

One line per record, `PREFIX | field=value | …`, so a query is a `grep` and the answer
is a line, not a paragraph.

| Prefix | Means |
| --- | --- |
| `reconciled: <sha> · <timestamp>` | the commit the rest of this file was checked against |
| `SESSION` | an actor that may dispatch (id, model, state) |
| `PROBE` | a read-only agent in flight and the question it answers |
| `IN-FLIGHT` | a writer: row, session, worktree, branch, base, **state**, and the full scope |
| `LANDED` | a verified landing: row, sha, **the dispatcher's own verification numbers**, what was retired, the docs amended |
| `retired_branch=<name>` | a CLAIM that `<name>` is retired — the **only** form the reconciler parses, read literally, one line per branch. Prose about a retirement (especially one still OWED) must not use this key: a prose-matching parser once read "retired=NOT yet … branch feat/x" as a claim and reported a false BOARD STALE while the branch still existed |
| `QUEUE` | owner requests and known debt not yet dispatched, with the row number reserved |
| `QUEUE-CLOSED` | a queue line whose scope is consumed (kept one screen, then dropped) |
| `TRAP` | a mistake that actually happened, with the rule that prevents it |
| `GUARD` | a mechanism protecting the process (host, memory, compaction) and how to verify it |
| `RECOVERY` | where a successor finds lost context |

---

## Board

```
reconciled: f66ff721c4cbfca5b6c0cca96b906ab4296ed4f1 · 2026-09-28T16:00Z

retired_branch=feat/serverstore-transport
retired_branch=feat/browser-io-and-settings

SESSION | id=dsh-file-store-bootstrap | model=deepseek-flash | state=dispatching

LANDED | row=none (day-1 scaffold) | sha=ab47e94a197267087751a877233a9c272bd02be1 | verify=MY OWN: cheap tier exit 2 (suite NOT run) + full gate GREEN exit 0 · 1/1 test · raw log .gate-logs/gate.log · build verified by grep: dist/index.html references /filestore/assets/... | arms=none — there is no pinned behaviour yet to break | docs=AGENTS.md, this board, ledger rows 1-7, ARCHITECTURE.md, TESTING.md, BRIEF.md | note=the machinery, established BEFORE feature code; remote https://github.com/ArndRosemeier/FileStore.git created PUBLIC (the push token refuses private repo creation) with both SHAs equal after push

LANDED | row=7 | sha=6718f9d85ed9787593903d62deb4b0cf40668d58 | verify=MY OWN differential on the writer's tree, hashes printed: baseline client 2d4fedba… 29/29 green → key-put-into-the-URL injection a027e396… RED on `the key travels in exactly ONE header and appears in no URL, no log and no error message` → a comment-mention arm 83ba0d97… exposed a PIN DEFECT (fixed forward; its own record is the TRAP below) → restored 2d4fedba… 29/29 | MY OWN gate on the INTEGRATED tree: exit 0 · 9 files · 75/75 tests · peak 733,772 KB · raw log .gate-logs/gate.log | worktree + session e8446520-e442-4896-907a-20065ae799a0 retired | docs=ledger rows 5 and 7, ARCHITECTURE 2 rows, TESTING matrix + section | note=the writer added `conflict` to the code vocabulary, which Imager's ported copy omits — a real 409 there was `invalid-response`
LANDED | row=8 | sha=ad5c83962d9ba91728a9eeee062429108af704f1 | verify=MY OWN differential on the writer's tree, hashes printed: baseline settings c78fd7bf… / abort a171c2f6… 35/35 green → an injection making a CORRUPT stored value silently become the defaults 4456930… RED on 5 named corrupt-reporting pins → an injection putting the fold back to `instanceof DOMException` c0ef4ac… RED on the 2 cross-realm `AbortError`-by-name pins → restored, both hashes identical to baseline, 35/35 | same integrated gate as row 7 | worktree + session 092d63b7-dff1-4e50-afad-a99e64bfa858 retired | docs=ledger rows 2, 3, 5 and the new row 8, ARCHITECTURE 4 rows, TESTING matrix + section | note=`src/lib/abort.ts` is the writer's COPIES fold (2→1) and the dispatcher verified the fold itself, not just the ports
LANDED | row=none (integration) | sha=a14730a840691c7697734dae0401010d22dd92b6 | verify=the two landings merged; ONLY the three docs conflicted (zero source overlap — the disjointness held); resolved as the mechanical UNION (every row of both landings kept, ledger row 5 rewritten to record BOTH halves in) | note=**a MERGE, not a rebase, deliberately**: each landing's docs name its OWN sha and board.sh requires LANDED shas to be ancestors of origin/main — rebasing would have pointed the docs at commits that no longer exist

QUEUE-CLOSED | row=none | the `files` store fork — RESOLVED by the owner, 2026-09-28: he created the store himself (`stores.created_at = 2026-09-28T14:27:54.773Z`, read from the service DB read-only) and holds a `["*"]` key labelled `Arnd` with `read,write,delete` (so it spans `files`), which he pastes into the app's Settings. Nothing secret transits chat and the dispatcher wrote nothing to another project. | src=the owner's answer
PROBE | live boundary, measured 2026-09-28 from `https://apps.futuremagic.de` (no key needed): `OPTIONS` preflight on `/stores/files/objects/probe.txt` → `204` with `access-control-allow-origin: *` for **GET, PUT and DELETE**; `GET /stores/files/objects` with no key → `401 unauthorized`; `GET /stores` → `401`. So the app's origin, methods and header are all answered by the deployed service. | src=the dispatcher's probe
TRAP | **the dispatcher FABRICATED a commit sha.** `git rev-parse --short HEAD` gave `a14730a`, and instead of reading the full value the dispatcher wrote `a14730a` plus 31 INVENTED hex characters into this board's `reconciled:` marker and its integration `LANDED` row. The reconciler caught it — `claimed LANDED but is not an ancestor of origin/main` — which is the reconciler doing exactly its job. A first audit of the docs then MISSED it as well, because that audit's regex demanded exactly 40 hex characters and the invented string was 39. Rules: **never expand an abbreviated sha by hand — read the full value from `git rev-parse`**; and when auditing sha claims, bound the pattern by what is CLAIMED (7–40 chars), not by what you expect, or the audit inherits your own assumption. | src=the dispatcher's own error, corrected here
TRAP | the dispatcher labelled a probe "a bad key proves the store exists because it is 401 and not 404" — WRONG. The key guard matches EVERY path BEFORE routing, so an absent or junk key answers `401` whatever the path, and proves nothing about a store. Store existence was proved by reading the service DB read-only. Rule: a probe's label is a claim; state what the measurement can actually distinguish. | src=the dispatcher's own error, corrected here
TRAP | a structural pin that greps text must strip comments on EVERY arm it greps. `tests/architecture/one-fetch.test.ts` stripped block comments for its `Authorization` check but read raw text for its `fetch(` check, so ONE block comment merely MENTIONING a fetch call in `src/App.tsx` turned the pin RED with no call in existence — a false red the next writer would have chased as a missing pin. Found by the dispatcher's own differential (injections must aim at the PIN, not only at the code); fixed forward and re-proved both ways (comment stays green `f94afac2…`, a real second call still reds `eb0c647f…`). | src=the dispatcher's verification of row 7
TRAP | a writer force-pushed its OWN feature branch (`--force-with-lease`) to fix a markdown typo in its docs commit, and reported it. Harmless HERE — nobody had based work on that branch — but it rewrote a pushed commit, which the host rules forbid on `main` and permit elsewhere only when no one else has built on it. **MEASURED evidence it is real:** the superseded docs commit `06106362f1ecc6836405884cb95d7ec1a08d4693` is in the object store but is an ancestor of NO branch, while the final `772cc74` is the one in `main`. Rule: a rewrite of a pushed branch is a decision to REPORT, never a silent convenience — and an integrated landing must be verified against the FINAL tip, not against whatever a fetch happened to catch mid-flight. | src=writer A's report, row 7; the dangling sha measured by the dispatcher
TRAP | "docs amended in the SAME commit as the change" CANNOT hold when the docs must name that commit's own sha. Both writers independently split source and docs into two commits on one branch, as the day-1 scaffold did. `docs/BRIEF.md` now says so. | src=both writers' errata, same finding
LANDED | row=none (dispatcher: the pin fix + the record) | sha=4146232665966d8cc53a6148f78d27c039b229c6 | verify=MY OWN full gate on the pushed HEAD: exit 0 · 9 files · 75/75 tests · peak 741,480 KB · raw log .gate-logs/gate.log | arms=the pin-precision arms recorded in TESTING (baseline 970c1f13… → comment f94afac2… exit 0 → real fetch eb0c647f… RED → restored 970c1f13…) | note=this commit also carries the correction of a sha the dispatcher had FABRICATED, and the dead .gitignore entry the row-8 writer left

LANDED | row=9 | sha=8d131d58153fb731de2dc2d62af8398411b099a2 | verify=MY OWN differential on the writer's tree, hashes printed: baseline toast.ts fb1e5240… 13/13 green → reverting the longest-first ordering 4159a56c… RED on the prefix case → dropping the STORED key ece7900… RED on the writer's stored-key pin (an arm the writer did NOT run, the mirror of its own) → restored fb1e5240… identical, 13/13. MY OWN gate on the INTEGRATED tree: exit 0 · 16 files · 128/128 · peak 812,804 KB · raw log .gate-logs/gate.log | arms=fb1e5240… vs 4159a56c… vs ece7900… — all distinct, none VOID | worktree + branch + session eb96f524-06be-4da7-9fe2-d294c1d8e0ac retired | docs=ledger rows 4 and 9, ARCHITECTURE error-surface row + new rows, TESTING matrix + two sections | note=the landing was CORRECTED FORWARD once: my own probe found that the redaction covered the STORED key but not the DRAFT key in Test connection; the writer reproduced it, found a SECOND defect inside it (a stored key that is a PREFIX of the draft left a remainder, so candidates are now redacted longest-first), and the fix threads the credential in use through errorMessage/toastError with the stored key still always redacted
QUEUE | row=none | publish to https://apps.futuremagic.de/filestore/ (base is already /filestore/) and refresh the futuremagic hub. Dispatcher's own step. | src=apps-publish skill
QUEUE-CLOSED | row=none | the 64-char name limit — **RAISED to 1024 by ServerStore, LANDED and VERIFIED FROM ITS CODE 2026-09-28**: `~/projects/ServerStore/src/core/validate.ts:38` now reads `NAME_MAX_LENGTH = 1024` and `NAME_PATTERN` is BUILT from `NAME_CHARSET` + that constant (commit `26f9e46`, 12 files / 819 insertions, incl. its own `tests/name-limit.test.ts` and API doc restated to `[a-z0-9][a-z0-9._-]{0,1023}` / "1 to 1024"). The SAME parser serves object-name PREFIXES, so `?prefix=` is widened too — which is what unblocks folder NAVIGATION, not just creation. **BUT THE LIVE SERVICE IS STALE**: pid 310261 started 14:34:54 while `validate.ts` was last written 17:13:43 (and was being written DURING my check), so the running process still enforces 64. Restarting `serverstore` is an operator/ServerStore-session step, NOT FileStore's — do not touch another project's service. FileStore's own client still mirrors the OLD bound (`src/lib/name.ts` `OBJECT_NAME_MAX_LENGTH = 64`), so it must be bumped to 1024 in lockstep or it will refuse names the server now accepts. | src=the dispatcher's verification of ServerStore's landing
LANDED | row=10 (slice 1 of 2) | sha=178a0dcd3a1639e7c11e86a26bf410bfd78fc115 | verify=MY OWN cross-project check: FileStore's `OBJECT_NAME_MAX_LENGTH=1024` and `^[a-z0-9][a-z0-9._-]{0,1023}$` EQUAL ServerStore's landed rule derived from its `NAME_MAX_LENGTH`+`NAME_CHARSET` — compared programmatically, MATCH: True. MY OWN differential: baseline folder.ts 1461792c… / name.ts cc7c4549… 27/27 green → `folderPrefix` drops its separator 535e8513… RED on the prefix-legality pin (9 green controls) → the mirror off by one, 1023, 0b600872… RED on the both-edges pin (16 green controls) → restored identical, 27/27. MY OWN gate on the INTEGRATED tree: exit 0 · 17 files · 145/145 · peak 783,556 KB · raw log .gate-logs/gate.log | arms=1461792c… vs 535e8513… vs 0b600872… — distinct, none VOID. **The FIRST folderPrefix arm was VOID** (identical hash 1461792c…, tests green: my injection never applied, because the regex stopped at a `}` inside a template literal). Caught by printing the hashes, which is what they are for; redone properly. | note=the writer changed exactly TWO existing pins, both of which encoded the OLD bound, and derived the bound from the constant instead of retyping it; a both-edges pin was ADDED. I folded the two stale bound statements the writer flagged (`AGENTS.md` — the binding contract a next writer reads, which stated a limit that no longer exists — and `src/settings/settings.ts`)
IN-FLIGHT | row=10 (slice 2 of 2) | slice=folder-ui | session=6f220d03-cbba-4dc8-a2d7-28e64c5d23f5 | worktree=/home/administrator/projects/FileStore/worktrees/folder-ui | branch=feat/folder-ui | base=origin/main@f66ff721c4cbfca5b6c0cca96b906ab4296ed4f1 | state=RUNNING | scope=src/features/files/** + tests/features/** (+ src/App.tsx only to pass state down) ONLY; the folder seam and name.ts are FROZEN | note=navigation stays in React state and NOT in the URL (the static host has no SPA history fallback, so a client-side route 404s on refresh); delete-folder is sequential N DELETEs with an honest partial-failure report, because the only bulk route empties the WHOLE store; move/rename stays DEFERRED (3N against 600/min)
QUEUE-CLOSED | row=10 | the FOLDER COSTING is now DECISION LEDGER row 10, which is where a decision belongs; the board keeps only what is happening now. That row carries the full record: the three routes with the rejected JSON envelope and `.` separator, the two corrections to the owner's limits summary (depth was our choice; 64 MiB is his knob), the `--` reserved-separator discovery, and Imager's 1007-line flat precedent. | src=ledger row 10
QUEUE | row=none | the live end-to-end round trip: the owner pastes his `Arnd` key into the published app's Settings and uploads/retrieves a file. The store exists and the boundary is proved; the round trip itself needs the one secret, which the dispatcher must never hold. | src=docs/TESTING.md

retired_branch=feat/ui-shell
PUBLISHED | row=9 | url=https://apps.futuremagic.de/filestore/ | verify=BY CONTENT, not by status code: dist/index.html references /filestore/assets/index-hwDKSZzl.js and the SERVED entry page names the SAME hash; entry, hashed asset and favicon.svg all 200 on 127.0.0.1:8082; the public URL is 200 with cf-cache-status: DYNAMIC (fresh bytes, not a cached copy) | BOOT CHECKED IN A REAL BROWSER (headless Chrome on the published URL, 2026-09-28): the page MOUNTS — `<h1>FileStore</h1>`, the not-configured state, the "stored in this browser" warning and `id="settings-key"` are all in the dumped DOM, with no asset 404 and no uncaught error. That is the check that catches the classic subpath failure (a root-absolute build renders BLANK); the hashes alone would not have. BROWSER HYGIENE: the run was bounded with the kill in a `trap`, and it left ZERO chrome processes (counted by executable name, which cannot self-match). wiring=`ln -sfn /home/administrator/projects/FileStore/dist /home/administrator/apps/filestore` (a symlink, so a rebuild goes live without republishing); `readlink -f` confirms the target | hub=refreshed with `~/projects/futuremagic/scripts/publish-apps-root.sh` exit 0, and `filestore` is present in `~/apps/apps.index.json` AND `apps.json` (the card list is build-time JSON the hub fetches, which is why grepping the hub HTML does not show it) | dist=4 files, build output only — no source, no .env, no key
TRAP | **a pattern count can report processes that DO NOT EXIST.** Re-checking the browser cleanup, `ps -eo args= | grep -c '[c]hrome'` said 2 — and the only match was the COUNTING SHELL ITSELF, whose argv contains the literal pattern text; by executable name there were zero. The `[x]` bracket trick does NOT protect you when the pattern also appears as literal text in the same argv, which is the documented rule and it recurred here. Rule: capture the PIDs and their command lines and LOOK at them, then verify with a count that cannot self-match (`ps -eo comm= | grep -c '^chrome$'`). | src=the dispatcher's own near-miss, 2026-09-28
TRAP | **a red probe is a claim about the PROBE first.** Chasing the draft-key leak I twice concluded "still broken" from a RED that was mine, not the code's: first my `whoami` mock rejected UNCONDITIONALLY, so the app's automatic probe — which uses the STORED key — also failed carrying a DRAFT key it never sent; then, once the stored key succeeded, the shell rendered its ready state and the Key field was no longer focusable. Rendering `SettingsPanel` directly removed both artifacts and the probe went green. Rule: before reporting a red as a defect, make the probe's OWN controls explicit — assert the arm is specific (the neighbouring pin stays green), and check that the failure is the property under test rather than the harness. | src=the dispatcher's own two false reds, 2026-09-28
RECOVERY | repo=/home/administrator/projects/FileStore | remote=https://github.com/ArndRosemeier/FileStore.git | branch=main | gate=bash scripts/gate.sh
```

## Guards

- **`GUARD` — the suite lock.** `scripts/gate.sh` takes an atomic `mkdir` lock at
  `<repo>/.gate-lock` (the git COMMON dir, so it is the same path from every worktree);
  a second full run is refused (exit 9) and is VOID. Verify: run a gate twice.
- **`GUARD` — the test worker bound.** `vite.config.ts` caps vitest at **two** workers
  by default, so a bare `pnpm exec vitest run` cannot exceed it whatever anyone
  forgets. Verify: read `DEFAULT_TEST_WORKERS` in `vite.config.ts`.
- **`GUARD` — the host is shared with Imager.** Imager ran its own full suite while
  this project was set up (its `.imager-lock` was held at 2026-09-28T14:26Z UTC —
  file mtimes on this box read local, UTC+2, and were MISTAKEN for UTC once already). One
  expensive check at a time, and FileStore's writers run in-turn.

## Traps (each with the rule that prevents it)

- `TRAP` — **a writer that reads a relative path edits the MAIN tree, not its
  worktree**, because every bash call starts in the session workspace. Rule: every path
  in a brief and in a report is ABSOLUTE.
- `TRAP` — **a writer worktree inside the repo is swept into the MAIN tree's test
  run.** Vitest's default include globs the whole root, so `worktrees/<slice>/`
  tests were collected by `main`'s suite: the day-1 gate reported **3 passed** for
  a tree holding **ONE** test file, and a worktree's red would have been reported
  against `main`. Rule: `test.exclude` in `vite.config.ts` names `worktrees` (and
  RESTATES vitest's `node_modules`/`dist` defaults, because `exclude` REPLACES
  them), pinned by `tests/architecture/worktree-isolation.test.ts`. **Read the test
  COUNT, not just the exit code.**
- `TRAP` — **`git checkout -- <path>` restores the INDEX, not HEAD**, so a "restore"
  in a tree with uncommitted work wipes it. Rule: commit the slice before injecting, or
  restore from an out-of-tree copy.
- `TRAP` — **a pipeline's exit status is the LAST command's**, so `check | tail`
  reports success whatever the check did. Rule: never pipe a gate through
  `tail`/`head`; keep the raw log and quote from the file.
