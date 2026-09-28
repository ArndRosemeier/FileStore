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
reconciled: ab47e94a197267087751a877233a9c272bd02be1 · 2026-09-28T14:32Z

SESSION | id=dsh-file-store-bootstrap | model=deepseek-flash | state=dispatching

LANDED | row=none (day-1 scaffold) | sha=ab47e94a197267087751a877233a9c272bd02be1 | verify=MY OWN: cheap tier exit 2 (suite NOT run) + full gate GREEN exit 0 · 1/1 test · raw log .gate-logs/gate.log · build verified by grep: dist/index.html references /filestore/assets/... | arms=none — there is no pinned behaviour yet to break | docs=AGENTS.md, this board, ledger rows 1-7, ARCHITECTURE.md, TESTING.md, BRIEF.md | note=the machinery, established BEFORE feature code; remote https://github.com/ArndRosemeier/FileStore.git created PUBLIC (the push token refuses private repo creation) with both SHAs equal after push

IN-FLIGHT | row=7 | slice=serverstore-transport | session=e8446520-e442-4896-907a-20065ae799a0 | worktree=/home/administrator/projects/FileStore/worktrees/serverstore-transport | branch=feat/serverstore-transport | base=origin/main@54b98170edadee8aeda36238169e832d7a116e49 | state=RUNNING | scope=src/server/store-errors.ts + src/server/store-client.ts + tests/server/** + tests/architecture/one-fetch.test.ts ONLY
IN-FLIGHT | row=8 | slice=browser-io-and-settings | session=092d63b7-dff1-4e50-afad-a99e64bfa858 | worktree=/home/administrator/projects/FileStore/worktrees/browser-io-and-settings | branch=feat/browser-io-and-settings | base=origin/main@54b98170edadee8aeda36238169e832d7a116e49 | state=RUNNING | scope=src/lib/saveFile.ts + src/lib/openFile.ts + src/lib/name.ts + src/settings/settings.ts + tests/lib/** + tests/settings/** ONLY

QUEUE-CLOSED | row=none | the `files` store fork — RESOLVED by the owner, 2026-09-28: he created the store himself (`stores.created_at = 2026-09-28T14:27:54.773Z`, read from the service DB read-only) and holds a `["*"]` key labelled `Arnd` with `read,write,delete` (so it spans `files`), which he pastes into the app's Settings. Nothing secret transits chat and the dispatcher wrote nothing to another project. | src=the owner's answer
PROBE | live boundary, measured 2026-09-28 from `https://apps.futuremagic.de` (no key needed): `OPTIONS` preflight on `/stores/files/objects/probe.txt` → `204` with `access-control-allow-origin: *` for **GET, PUT and DELETE**; `GET /stores/files/objects` with no key → `401 unauthorized`; `GET /stores` → `401`. So the app's origin, methods and header are all answered by the deployed service. | src=the dispatcher's probe
TRAP | the dispatcher labelled a probe "a bad key proves the store exists because it is 401 and not 404" — WRONG. The key guard matches EVERY path BEFORE routing, so an absent or junk key answers `401` whatever the path, and proves nothing about a store. Store existence was proved by reading the service DB read-only. Rule: a probe's label is a claim; state what the measurement can actually distinguish. | src=the dispatcher's own error, corrected here
QUEUE | row=9 | the UI slice: the app shell, settings panel, upload/list/retrieve flows — replaces the day-1 placeholder src/App.tsx. Dispatched after rows 7 and 8 land. | src=the owner's request
QUEUE | row=none | publish to https://apps.futuremagic.de/filestore/ (base is already /filestore/) and refresh the futuremagic hub. Dispatcher's own step. | src=apps-publish skill
QUEUE | row=none | the live end-to-end round trip: the owner pastes his `Arnd` key into the published app's Settings and uploads/retrieves a file. The store exists and the boundary is proved; the round trip itself needs the one secret, which the dispatcher must never hold. | src=docs/TESTING.md

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
