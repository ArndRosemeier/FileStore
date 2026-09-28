# FileStore — agent/workspace rules

FileStore is a **browser file store** backed by the owner's self-hosted
**ServerStore**. It is a Vite + React + TypeScript single-page app (Tailwind v4,
zod at the boundaries, vitest + Testing Library), served as static files from
`https://apps.futuremagic.de/filestore/`.

Read the relevant doc under `docs/` before working on an area. Start every task at
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the seam index ("the one way to do
X", the layer map, the gotchas, the known debt).

The full process — roles, the board, verification doctrine, the brief template — is
the shared doc `WAY-OF-WORKING.md` in the Toolbox repo (`~/projects/Toolbox`). This
file holds only what is **binding here**.

## What this app is, and what it is not

- **It is a file store.** Upload files into ServerStore's `files` store, list them,
  fetch them back, and put them on disk through the browser's file-location dialog
  where the browser supports it (a plain download otherwise).
- **It is NOT an admin console.** It never creates, deletes or lists *stores*, never
  mints, edits or revokes *keys*, and **never holds a master admin key**. The `files`
  store and the scoped key it uses are provisioned by the operator. A request that
  seems to need store administration belongs to the ServerStore console, not here.
- **It is not Imager.** Imager (`~/projects/Imager`) is a **READ-ONLY** reference: its
  ServerStore seams were read to design these and are the source the ports came from.
  Never write to, commit in, or push that repo. Divergence is expected; this repo has
  its own copies and its own reasons.

## The ServerStore contract, as it actually bit us

The service's own client contract is `~/projects/ServerStore/docs/API.md` (read it
there; it is the authority). These are the parts that change how this app must be
written, each of which cost something to learn:

- **Base URLs.** Deployed `https://store.futuremagic.de` (HTTPS at the Cloudflare
  tunnel, loopback behind it); on the box `http://127.0.0.1:8477`. Reachability is a
  command, not an assumption: `GET /healthz` → `200 {"ok":true}` with no key.
- **A key is scoped to a SET of stores and carries a subset of
  `read|write|delete|admin`.** There is no user, no session, no cookie — the key **is**
  the principal. This app needs only `read`, `write`, `delete` on `files`.
- **Object names are `[a-z0-9][a-z0-9._-]{0,1023}`** — lowercase letters, digits, `.`,
  `_`, `-`; 1–**1024** characters; must start with a letter or digit; no leading `.`; `.`
  and `..` are refused. A real file name is therefore **not** usually a legal object
  name. Mapping is the job of ONE seam (`src/lib/name.ts`) — never inline at a call
  site, never a silent second rule.
  **The bound is a MIRROR of another project's contract**, not this app's choice: the
  source of truth is `~/projects/ServerStore/src/core/validate.ts` (`NAME_MAX_LENGTH`,
  widened 64 → 1024 in commit `26f9e46`, 2026-09-28). `src/lib/name.ts` names that source
  and a pin holds the mirror equal to the server's rule at both edges — so if ServerStore
  moves it again, the pin is what tells us. **A mirror nobody checks is a lie waiting to
  happen.**
- **Folders are a NAMING CONVENTION, not storage.** ServerStore has no directories, no
  metadata and no rename route, and its only listing filter is `?prefix=`. The convention
  (`src/lib/folder.ts`, ledger row 10) is `--` as the separator at every level:
  `docs--reports--q1--report.pdf` is `report.pdf` in the folder `docs/reports/q1`. It is
  unambiguous **because `toObjectName` can never emit a double dash** — `collapseDashes`
  collapses runs of `-`, which is what RESERVES the separator. A **trailing** `--`
  (`docs--reports--`) is the marker for a folder that exists and holds nothing, and it is
  unproducible by mapping for the same reason. **Both of those are pinned properties, not
  prose**: if the collapse ever goes away, the separator stops being reserved. There is no
  artificial depth cap; the 1024-character budget is the bound, and it is **shared**
  between the folder path and the file name.
- **`PUT …/objects/{name}` is an UNCONDITIONAL OVERWRITE and an empty body is
  refused** (`400 invalid_body`). There is no create-only variant, no `ETag`, no
  `If-Match`, no version. So **an upload that would overwrite an existing name must
  refuse until the owner confirms it** — a silent clobber is the exact data loss
  rule 1 forbids.
- **There is no metadata.** An object is a name and its bytes; nothing more. The
  listing gives `store`, `name`, `sha256`, `size`, `createdAt`. An original file name,
  a MIME type and a modified time are **not** stored, so nothing may present them as
  if they were.
- **The listing has ONE filter: `?prefix=`.** No pagination, no cursor, no `limit`, no
  `since`, no sort. A prefix that can never match is a `400 invalid_name` on purpose;
  a valid prefix matching nothing is `200 {"objects":[]}`, never `404`.
- **`GET …/objects/{name}` returns the exact bytes** with
  `content-type: application/octet-stream` and an `x-serverstore-sha256` header (a
  lowercase hex digest). The service's own hash is the integrity proof; verify it
  rather than trusting the bytes arrived intact.
- **`SERVERSTORE_MAX_BYTES` defaults to 64 MiB per request.** Over it: `413
  payload_too_large`, never truncated, never partially stored. A client-side size
  check must report the limit it checked against, not a guess.
- **`429 rate_limited` carries `Retry-After`** (600 requests/minute/client by
  default). Do **not** hide it behind a retry loop: a silently retried `PUT` can
  double-upload. Report it, with the wait.
- **Errors are one envelope**: `{"error":{"code","message"}}`. `code` is stable and
  safe to branch on; `message` is for humans and may change.
- **CORS is `*` on the deployed service** (verified 2026-09-28: a preflight from
  `https://apps.futuremagic.de` is answered `204` with `access-control-allow-origin:
  *`), so this app's origin needs no allowlist entry. `authorization` is named
  explicitly in `access-control-allow-headers` — send the key in `Authorization` or
  `x-api-key`, never an undeclared custom header.

## The credential rule

**The ServerStore key is a password.** It is the only perimeter in front of the
service.

1. It lives in **`localStorage`** (the settings seam, `src/settings/settings.ts`) and
   in memory. Nowhere else: never a URL, never `history`, never a log line, never a
   `console.*` call, never a commit, never an error message, never a report, never a
   fixture, never a test snapshot.
2. It is sent in **exactly one header**, by exactly one module
   (`src/server/store-client.ts`). No other module may read `settings.key` to build a
   request.
3. Error and diagnostic text names **codes and endpoints**, never the key value.
4. It persists across reloads deliberately — that is why it is in `localStorage` and
   not a page variable — so the UI must carry a visible warning saying so and a
   **"Forget key"** action that clears it.

## Binding engineering rules

1. **No silent fallbacks.** When data, parsing or a step fails, propagate a LOUD
   error. Forbidden: finalizing an artifact from an empty or failed draft,
   `catch`-and-continue around parsing, logging an error with no user-visible surface,
   placeholder values standing in for required data. Defaults are allowed only for
   genuine user preference or optional enrichment — never to mask a failure.
2. **Errors must be visible** through the app's one error surface (`src/lib/toast.ts`).
3. **Validate at every boundary.** A response body from ServerStore is parsed against
   a schema; a validation failure fails the step loudly. It never becomes empty data.
4. **Centralize, and keep it simple.** When one idea is implemented in more than one
   place, make it ONE seam and route callers through it. When you touch an
   already-distributed pattern, folding it is part of the change — unless that is
   genuinely more expensive than the defect, in which case say so in writing where the
   next reader will hit it.
5. **A cross-cutting discovery starts with the seam question, and the answer is
   WRITTEN DOWN.** Every brief and every landing report carries ONE greppable line:
   `COPIES: n→1 — <the seam that now carries it>` when copies were folded, or
   `COPIES: 1 — checked, no duplication (grepped: <what>)` when the change is
   genuinely single-site. A brief without it is incomplete; a landing without it is
   not verified.

## Standing rule: critique the instruction

**The owner's instructions are INTENT, not design.**

1. **Extract the intent first** — the felt problem behind the literal ask.
2. **Say it when the ask is flawed**, plainly and briefly, with the better route and
   its reasoning.
3. **Do not silently substitute.** A different design may replace the asked-for one
   only when it serves the SAME intent *and* the owner has been told. The owner must
   always be able to see which decisions were theirs.
4. **Judge the friction.** Minor imperfections get decided in one line, not debated.
5. **Route the critique through reality, not taste.** "This breaks X, here is the
   code that proves it" is a critique; "this feels off" is not.
6. **Bind briefs to it too.** Every brief tells the writer to report BLOCKED — with
   evidence — rather than implement something it can prove is wrong, **including when
   the flaw is in the brief's own design**.
7. **The decision stays the owner's.** Present the better way once; if the owner
   reaffirms, execute it well and stop re-arguing.

## Reading the owner's reports

Unusual characters in a pasted report are the **transport**, not a symptom — text can
be mangled before anything of ours sees it. Do not scope work from a mangled glyph,
and do not report one as a defect.

## Parallel writers

Read-only agents always run in parallel. **At most TWO writing agents** may be in
flight, and only in **separate worktrees** (`git worktree add`) — writers sharing one
working tree share one git index, and `git commit` commits the whole index, so file
disjointness does NOT protect the commit phase.

1. **File disjointness applies to source files and CANNOT hold for the docs.** Every
   landing amends the board and usually the ledger, so two concurrent writers WILL
   conflict there. The dispatcher assigns the ledger row number in every brief; a
   writer that still hits a docs conflict resolves it as a mechanical UNION, renumbers
   its OWN row only, touches nothing of the other landing, proves that with
   `git diff --name-only`, re-gates on the rebased tree, and pushes.
2. **A conflict anywhere else** means the disjointness check missed something: STOP
   and report; do not resolve it.
3. **Rebase before every push** (`git pull --rebase origin main`), then push.
4. **Absolute paths in every brief.** Every shell call runs in a fresh shell whose cwd
   is the session workspace, and file tools resolve relative paths against it — so a
   writer told to work in a worktree edits the MAIN tree unless every path is absolute.
5. **Worktrees live INSIDE the repo** (`<repo>/worktrees/<slice>`, gitignored and
   excluded from lint) — never in `/tmp`.
6. **A writer that cannot finish must COMMIT the coherent partial state on its branch
   and report BLOCKED.** Uncommitted work dies with the session.
7. **Cadence contract.** Writers report on LANDING or BLOCKED, nothing in between.

## The gate

One command. Run it; do not invent another. See `scripts/gate.sh` for the exit-code
vocabulary (`0` green · `1` failed · `2` cheap tier only · `9` refused, VOID) and
`docs/BOARD.md` for how a result is recorded.

- **The cheap tier blocks a push; the expensive tier makes a change VERIFIED.**
- **A red gate is information, not an obstacle.** Fix the cause; never re-run until
  green.
- **Never pipe a check through `tail`/`head`** — it destroys the failing evidence, and
  the pipeline's exit status becomes the last command's, so unverified work lands
  under a message claiming a pass.
- **One expensive check at a time**, enforced by the lock, not by a glance.
- **A build-config change takes the build tier.** `pnpm run typecheck` cannot catch a
  broken `vite build`; when `vite.config.ts`, `index.html`, `tsconfig*.json` or
  `package.json` changes, run `pnpm run build` too and say so.

## Host hygiene

The box is shared; the discipline that protects it protects every other session on it.

1. **At most two writers in flight.** Count the registry before dispatching.
2. **No synthetic load, ever.** A flake is proved deterministic by delaying its cause,
   never by loading the machine. The test worker bound is in `vite.config.ts` (default
   two); raising it is an explicit act.
3. **Every run carries a memory ceiling**, and one suite runs at a time.
4. **An interrupted turn's processes are the dispatcher's to reap** — a turn that dies
   does not kill what it started. The audit includes **browsers** (`chrome`,
   `chromium`, `headless_shell`, `playwright`), not only test runners.
5. **Kill by PID captured in a SEPARATE call — never by a pattern in the same shell.**
   Capture (`pgrep -f '<pat>' > pids.txt`), then kill (`xargs -r kill < pids.txt`), then
   verify with a count that cannot self-match (`ps -eo comm= | grep -c '^chrome$'` —
   expect `0`).
6. **A headless browser is a process TREE, and its kill belongs in a `trap`.** Start a
   browser in-turn, kill the tree before you report, on success and failure alike.
7. **Nothing outlives the writer:** scratch harnesses live under its own worktree,
   never `/tmp`; every process it starts is foreground or killed before it reports.

## Publication

FileStore is static and public at `https://apps.futuremagic.de/filestore/` — the
build's `base` is `/filestore/`, and assets must resolve under that subpath. Publish
per the `apps-publish` skill (symlink `~/apps/filestore` → this repo's `dist/`, then
refresh the futuremagic hub). Never publish source, `.env` or a key.
