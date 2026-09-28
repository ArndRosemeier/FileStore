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
reconciled: PENDING · 2026-09-28T16:40Z

SESSION | id=dsh-file-store-bootstrap | model=deepseek-flash | state=dispatching

IN-FLIGHT | row=7 | slice=serverstore-transport | session=<none yet> | worktree=/home/administrator/projects/FileStore/worktrees/serverstore-transport | branch=feat/serverstore-transport | base=origin/main@PENDING | state=DISPATCHED | scope=src/server/store-errors.ts + src/server/store-client.ts + tests/server/** ONLY
IN-FLIGHT | row=8 | slice=browser-io-and-settings | session=<none yet> | worktree=/home/administrator/projects/FileStore/worktrees/browser-io-and-settings | branch=feat/browser-io-and-settings | base=origin/main@PENDING | state=DISPATCHED | scope=src/lib/saveFile.ts + src/lib/openFile.ts + src/lib/name.ts + src/settings/settings.ts + tests/lib/** + tests/settings/** ONLY

QUEUE | row=none | OPERATOR ACTION: ServerStore has NO `files` store, and this app holds no key. The `files` store must exist and a key scoped to ["files"] with perms read,write,delete must be minted. Measured 2026-09-28 by reading the service DB: stores are master, colossus, imager. | src=the dispatcher's report
QUEUE | row=9 | the UI slice: the app shell, settings panel, upload/list/retrieve flows — replaces the day-1 placeholder src/App.tsx. Dispatched after rows 7 and 8 land. | src=the owner's request
QUEUE | row=none | publish to https://apps.futuremagic.de/filestore/ (base is already /filestore/) and refresh the futuremagic hub. Dispatcher's own step. | src=apps-publish skill
QUEUE | row=none | optional live end-to-end proof against the deployed service once the operator has provisioned the store and key. | src=docs/TESTING.md

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
  this project was set up (its `.imager-lock` was held at 2026-09-28T16:26Z). One
  expensive check at a time, and FileStore's writers run in-turn.

## Traps (each with the rule that prevents it)

- `TRAP` — **a writer that reads a relative path edits the MAIN tree, not its
  worktree**, because every bash call starts in the session workspace. Rule: every path
  in a brief and in a report is ABSOLUTE.
- `TRAP` — **`git checkout -- <path>` restores the INDEX, not HEAD**, so a "restore"
  in a tree with uncommitted work wipes it. Rule: commit the slice before injecting, or
  restore from an out-of-tree copy.
- `TRAP` — **a pipeline's exit status is the LAST command's**, so `check | tail`
  reports success whatever the check did. Rule: never pipe a gate through
  `tail`/`head`; keep the raw log and quote from the file.
