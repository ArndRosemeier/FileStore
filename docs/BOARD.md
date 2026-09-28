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
reconciled: f1da6d22905bc7ab3797c4a750f7dfe6beb03928 · 2026-09-28T15:30Z

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
QUEUE | row=10 | **NESTED FOLDERS — the owner's decision 2026-09-28: "lets have nested folders. Size limit stays."** This SUPERSEDES the earlier flat recommendation in this file (which was made when 64 chars was the limit). DEPENDENCY, MEASURED, NOT ASSUMED: the name limit is **NOT yet raised**. `~/projects/ServerStore/src/core/validate.ts:17` still reads `NAME_MAX_LENGTH = 64` on ServerStore's `main`, and the running service executes main. It is IN FLIGHT in that project's own session: its ledger row 87 DECIDED names to 1024 with the item cap KEPT at 64 MiB, and row 88 is DISPATCHED to a writer (brief `docs/briefs/slice-20-name-limit.md`, worktree `worktrees/name-limit`). Its intake cites "TWO LIMITS REPORTED BY THE OWNER'S OTHER PROJECT" — i.e. it picked these up from OUR findings. **FileStore must not build against 1024 until it LANDS and is verified from the landed code.** WHY IT BLOCKS NAVIGATION, NOT JUST CREATION: `?prefix=` obeys the SAME name rule, so a listing prefix longer than the limit is `400 invalid_name` — deep paths cannot even be *listed* until the bump lands. Short paths work today. DESIGN (dispatcher): the separator is `--` at EVERY level, because `src/lib/name.ts` `collapseDashes` (`replace(/-+/g,'-')`) makes a double dash UNPRODUCIBLE by `toObjectName`, so `docs--reports--q1--report.pdf` splits exactly into folder `docs/reports/q1` + file `report.pdf` with no ambiguity. EMPTY FOLDERS: a TRAILING `--` is the marker (`docs--reports--` = that folder exists and is empty), also unproducible by the sanitizer (a single trailing `-` is producible from a file named `a-`; a double is not) — and it must carry a few bytes because the service refuses an empty body. NO ARTIFICIAL DEPTH CAP: the 1024-char budget is the real bound (each level costs its length + 2), so an invented cap would be a second, arbitrary rule. THE WALL NESTING INTRODUCES, independent of the name limit: there is NO copy and NO rename route, so renaming or moving a folder is **3N requests** (GET+PUT+DELETE per file) against **600 requests/minute/client** — a ~200-file folder move IS the rate limit. So v1 = create / navigate / upload-into / delete-folder (N DELETEs, fine); **move/rename is a separate, explicitly-warned operation, or deferred.** EFFORT: ~2 writer slices — (a) the folder-path seam + `name.ts` made folder-aware and bumped to the landed limit, ~230 lines source + ~32 pins; (b) the UI (breadcrumb nav derived from the ONE flat listing, New folder, upload target, delete folder), ~350 lines + ~20 pins. SEQUENCING: after row 9's draft-key fix lands AND ServerStore's row 88 is verified landed; `src/lib/name.ts` is NOT in row 9's scope, so the bump will not conflict there. | src=the owner's decision 2026-09-28
QUEUE | row=none | the live end-to-end round trip: the owner pastes his `Arnd` key into the published app's Settings and uploads/retrieves a file. The store exists and the boundary is proved; the round trip itself needs the one secret, which the dispatcher must never hold. | src=docs/TESTING.md
QUEUE | row=10 (candidate) | FOLDERS — costed by the dispatcher 2026-09-28 at the owner's request. MEASURED CONSTRAINTS: object names are `[a-z0-9][a-z0-9._-]{0,63}` (VERIFIED IN THE SERVER'S CODE, not the doc: `~/projects/ServerStore/src/core/validate.ts:16` `NAME_MAX_LENGTH = 64`, `:19` the pattern, refused `400 invalid_name` at `:41`; it is a HARDCODED module constant with no env knob, and the same `parseName` serves store names, object names, object-name prefixes and key ids. Distinct from the OTHER 64: `SERVERSTORE_MAX_BYTES`, default `64 * 1024 * 1024`, which IS configurable — `src/server/config.ts:14`) so `/` CANNOT appear in a name; the service has no directories, no metadata, no rename route, and no bulk-prefix delete (the only bulk route, `DELETE /stores/{store}/objects?confirm={store}`, empties the WHOLE store); the listing's only filter is `?prefix=`; an EMPTY body is refused, so an empty folder has nothing to exist as. DISCOVERY: `--` is a RESERVED separator for free — `src/lib/name.ts` `collapseDashes` is `replace(/-+/g, '-')`, so `toObjectName` can never emit a double dash (pinned at `tests/lib/name.test.ts:41`). PRECEDENT: Imager already built folders on this same service — `src/server/store-folders.ts` (580) + `src/server/store-files.ts` (427) = 1007 lines — and it is FLAT BY DESIGN (`SLUG_PATTERN` is one segment; "no slashes exist in the API, and no subfolders exist in this design"). ROUTES: (A) Imager's record+index+JSON-envelope model — ~1000+ lines AND it reverses ledger row 2, losing byte portability (`curl` would return JSON); (B) flat folders via the reserved `--` in the object name, raw bytes kept, RECOMMENDED, ~1 writer slice plus a bit (seam ~140 lines, the `name.ts` budget change ~40, UI ~370, ~50 pins), with the honest costs that an empty folder needs a small marker object and that rename/move/delete-folder are N sequential PUT+DELETEs with no atomicity; (C) no folders, just a client-side filter/sort over the one flat listing — ~80 lines, a fraction of a slice, and it is what actually makes a long listing usable, so it is INCLUDED in (B) rather than being a rival to it. SEQUENCING: row 9 is in flight and owns `src/features/**` and `src/App.tsx`, so folders land AFTER it. TWO CORRECTIONS to the owner's own summary of the limits, both measured 2026-09-28: (1) "only 1 layer deep" is OUR DESIGN CHOICE, not a server limit — ServerStore has no folders at all, and the `--` separator could nest if we chose; it is reversible and was chosen for the shared 64-char budget, the segment grammar and Imager's identical flat precedent. (2) "no file bigger than 64 MB" is the CURRENT CONFIGURATION of a knob the OWNER controls, not a hard limit: `SERVERSTORE_MAX_BYTES` defaults to 64 MiB and is UNSET on the live service (verified by reading the process env: only DATA_ROOT and PORT are set), so raising it is one `Environment=` line in `deploy/serverstore.service` plus a restart — and the app needs NO change, because `putObject` hardcodes no cap (its only guard is zero bytes) and defers to the service's `413 payload_too_large`. NEW CONSEQUENCE recorded for the folder design: bulk operations are N requests and the service rate-limits 600 per client per 60 s, so deleting or renaming a folder of a few hundred files is one operation away from a `429` that must be honoured by wait, not retry. | src=the owner's question 2026-09-28

retired_branch=feat/ui-shell
PUBLISHED | row=9 | url=https://apps.futuremagic.de/filestore/ | verify=BY CONTENT, not by status code: dist/index.html references /filestore/assets/index-hwDKSZzl.js and the SERVED entry page names the SAME hash; entry, hashed asset and favicon.svg all 200 on 127.0.0.1:8082; the public URL is 200 with cf-cache-status: DYNAMIC (fresh bytes, not a cached copy) | wiring=`ln -sfn /home/administrator/projects/FileStore/dist /home/administrator/apps/filestore` (a symlink, so a rebuild goes live without republishing); `readlink -f` confirms the target | hub=refreshed with `~/projects/futuremagic/scripts/publish-apps-root.sh` exit 0, and `filestore` is present in `~/apps/apps.index.json` AND `apps.json` (the card list is build-time JSON the hub fetches, which is why grepping the hub HTML does not show it) | dist=4 files, build output only — no source, no .env, no key
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
