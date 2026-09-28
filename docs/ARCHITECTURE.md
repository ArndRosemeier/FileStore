# Architecture — the seam index

The seam index answers *"how does this codebase work, and where is the ONE place that
does X?"* — the layer map, the seam rows, the gotchas and the known debt. It is what a
brief is scoped against and what a writer reads before touching an area.

## 1 · Layer map

Dependencies point **downward only**. A lower layer never imports an upper one.

| Layer | What lives there | May import |
| --- | --- | --- |
| **UI** — `src/App.tsx`, `src/features/**` | React components and the flows (settings, upload, list, retrieve). Owns user-visible copy and confirmations. | everything below |
| **App services** — `src/settings/**`, `src/lib/toast.ts`, `src/app/**` | The app's own state (settings, the proven connection) and its ONE error/notification surface. | `lib/`, `server/` |
| **Seams** — `src/server/**`, `src/lib/name.ts`, `src/lib/folder.ts`, `src/lib/chunk.ts`, `src/lib/saveFile.ts`, `src/lib/openFile.ts`, `src/lib/sha256.ts`, `src/lib/format.ts` | The ONE place each external boundary is spoken to (ServerStore's HTTP API, the object-name mapping, the folder naming convention, the big-file chunking convention, the browser's save and open dialogs, the digest algorithm) — plus the pure, deterministic display formatters. | nothing above; `zod`, the platform and the sibling seams (`chunk.ts` reuses the name seam's bound) |

The rule that makes this map worth having: **the UI never calls `fetch`, never reads
`settings.key`, never builds an object name, and never composes its own error text.**
Each of those has exactly one home below it.

## 2 · The one way to do X

| Seam | The ONE way | Where | Notes |
| --- | --- | --- | --- |
| The app's name | the `served` state | [src/lib/name.ts](src/lib/name.ts) | **LANDED ad5c839, bound MIRRORED forward at 178a0dc (ledger row 10)** — `toObjectName` (L214), `OBJECT_NAME_PATTERN` (L73), `OBJECT_NAME_MAX_LENGTH` (L55), `ObjectNameMappingError` (L92). Real file name ↔ a ServerStore-legal object name (`[a-z0-9][a-z0-9._-]{0,1023}`). The bound is a MIRROR of `~/projects/ServerStore/src/core/validate.ts` (`NAME_MAX_LENGTH`, commit `26f9e46`), and the source is named in the module so the next reader can CHECK it. `toObjectName(fileName, folder?)` takes an optional `FolderPath` (L214): with none its result and `changed` are exactly the old root behaviour (the row-9 call site passes one argument), with a folder the name is folder + separator + mapped file part and the ONE 1024-character budget is shared between them. `changed` always describes the FILE part. The mapping is shown to the owner before an upload; a name that cannot map legally is a loud refusal, never a guess. |
| The folder convention | `src/lib/folder.ts` | [src/lib/folder.ts](src/lib/folder.ts) | **LANDED 178a0dc (ledger row 10, slice 1).** `FOLDER_SEPARATOR` (L44), `FolderPath` (L47), `FolderPathError` (L54), `isFolderSegment` (L73), `parseFolderPath` (L114), `formatFolderPath` (L122), `folderPrefix` (L135), `folderMarkerName` (L151), `isFolderMarkerName` (L166), `joinFolder` (L181), `splitObjectName` (L205), `parentFolder` (L222), `ancestors` (L231), `folderDepth` (L238); 240 lines. A folder is a naming convention over the one flat object list, NOT storage: ServerStore has no directories, no metadata and no rename route, and its only listing filter is `?prefix=`. `--` separates levels and a trailing `--` marks an EMPTY folder, both UNPRODUCIBLE by `toObjectName` because `collapseDashes` collapses runs of `-` — which is what makes `splitObjectName`/`joinFolder` exact inverses at any depth. A segment is a legal store name that also must not contain the separator or end in `-`; anything else THROWS `FolderPathError` rather than being folded into a different folder. |
| The app's settings | `src/settings/settings.ts` | [src/settings/settings.ts](src/settings/settings.ts) | **LANDED ad5c839** — `readSettings` (133), `writeSettings` (147), `forgetKey` (166), `DEFAULT_SETTINGS` (55). The ONE persisted state: `baseUrl`, `store`, `key`. `localStorage`, zod-validated on read; a corrupt stored value is reported as `{corrupt, problem}`, never silently replaced by defaults — and the key never enters a message. |
| The app's error surface | `src/lib/toast.ts` | [src/lib/toast.ts](src/lib/toast.ts) | **LANDED 80d7186, corrected forward 8d131d5** — `toastError` (136), `errorMessage` (131), `errorText` (119), `redactCredential` (83), `ToastErrorOptions.credential` (55), `REDACTED_CREDENTIAL` (52), `ERROR_TOAST_DURATION_MS` (49); 147 lines. The ONE place a failure becomes something the owner can see: a real error carries `duration: Infinity` (never auto-dismisses) and a cancellation never reaches it. `errorMessage` is the ONE composition the toast AND every inline failure render share, and it redacts every credential the app KNOWS ABOUT from arbitrary text — the STORED key always, plus the credential a caller says it actually SENT (`credential`), which is how the Settings panel's probe of an unsaved DRAFT key is covered; candidates are redacted longest-first, so a stored key that is a prefix of the one in use cannot leave the longer credential's remainder behind. A toast is rendered text, and the service's `message` is not trusted. |
| The proven connection | `useStore` | [src/app/useStore.ts](src/app/useStore.ts) | **LANDED 80d7186** — `useStore` (67), `storeTargetFrom` (51), `StoreConnection` (40); 101 lines. `unconfigured` (no key — an honest first run, NOT an error) · `connecting` · `ready` (carrying `WhoAmI`) · `failed` (carrying the error). The key is PROVEN with `whoami`, never assumed from `healthz` (which needs no key at all), and nothing throws into the shell. `storeTargetFrom` is the ONE place the three settings become a `StoreTarget`. |
| The digest of bytes | `sha256Hex` | [src/lib/sha256.ts](src/lib/sha256.ts) | **LANDED 80d7186** — `sha256Hex` (24); 31 lines. Lowercase hex SHA-256 via `crypto.subtle`. It exists for exactly ONE caller: the download flow's check of the received bytes against the service's `x-serverstore-sha256` (`src/features/files/download.ts` L47). |
| The store's flows | `src/features/files/**` | [src/features/files/](src/features/files/) | **LANDED 80d7186, extended `ef7ce5e` (ledger row 11) with the folder tree** — `reviewUploads` (upload.ts L~72, now `reviewUploads(files, folder)`), `unconfirmedOverwrites` (L~123 — ledger row 4's gate), `verifiedObjectBytes` / `downloadObject` (download.ts L41/L64), `useObjects` (L~78, now `useObjects(target, folder)` where the folder IS the `?prefix=`), `UploadPanel` (L~60), `FileBrowser` (L~61). The listing shows only `name`/`size`/`createdAt`/truncated `sha256`; the upload reviews every file before any request; a download verifies before the save seam is allowed to write; a delete asks first. The folder tree adds `FolderBreadcrumb` (L26) and `FolderPanel` (L59), and `FileBrowser` keeps the current folder in React state — never in the URL. **Slice B of row 12 (`c53bfa0`)** makes a chunked file ONE row here (the chunk view below): Download and Delete resolve through `view.byObjectName` to the whole file, the delete confirmation names the object COUNT, an overwrite writes a NEW GENERATION, and every problem (incomplete manifest, look-alike name, orphaned part) is REPORTED by `ChunkPanel.tsx` — never acted on. |
| The folder tree | `src/features/files/folders.ts`, `folderOps.ts` | [src/features/files/folders.ts](src/features/files/folders.ts) | **LANDED ef7ce5e (ledger row 11).** `describeFolder` (L116) turns ONE listing plus the current `FolderPath` into the files at this level and the subfolders below it, with three counts per row (`objectCount` — non-marker objects at any depth; `folderCount`; `deleteCount` — every object under the prefix, its own marker included). `objectsUnder` (L182) is the ONE "what is under this folder" predicate and REFUSES the root (everything is under it, i.e. the whole store); `objectNamesUnder` (L193) is its name form; `folderDisplayPath` (L198) is the human path. `folderOps.ts` carries the two WRITES: `folderMarkerBytes` (L49), `createFolder` (L71 — writes the marker via `putObject`, LOUDLY refuses a folder that already exists), `deleteFolderObjects` (L109, outcome L91 — one `DELETE` at a time, STOP at the first failure, and an honest `{deleted, remaining, failure}`). Nothing here splits on `--` or joins a name: every path question goes through `src/lib/folder.ts`. **`deleteObjectNames` (L~100) is the ONE sequential delete** — folder delete and a chunked file's delete both route through it (folded in row 12 slice B), so stop-at-the-first-failure and say-what-remains live in one place — and `describeFolder` takes the UNTRANSFORMED listing as an optional third argument (L~130) so a folder's DELETE count still counts the chunk objects the rows hide. |
| Display formatting | `src/lib/format.ts` | [src/lib/format.ts](src/lib/format.ts) | **LANDED 80d7186** — `formatByteSize` (33), `formatTimestamp` (67), `shortSha256` (84), `formatObjectCount` (90); 92 lines. Pure and deterministic: binary sizes, UTC timestamps, no `Intl`/locale/time zone. A size that is not a byte count is a LOUD `RangeError`, never `0 B`. |
| Talking to ServerStore | `src/server/store-client.ts` | [src/server/store-client.ts](src/server/store-client.ts) | **LANDED 6718f9d.** The ONE `fetch` to the store: `requestRaw` L148, `whoami` L238, `healthz` L248, `listObjects` L271, `getObject` L288, `putObject` L323, `deleteObject` L347 (356 lines). Puts the key in exactly ONE header (`Authorization: Bearer`); never logs it, never puts it in a URL or a message. Reports `429`/`5xx` with the `Retry-After`; **never retries**. A zero-byte `PUT` is refused before any request; a `GET` without a valid `x-serverstore-sha256`, or with zero bytes, is refused. |
| ServerStore's error vocabulary | `src/server/store-errors.ts` | [src/server/store-errors.ts](src/server/store-errors.ts) | **LANDED 6718f9d.** The service's `{error:{code,message}}` envelope → one typed `ServerStoreError` (`class` L71, `errorFromResponse` L157, `envelopeFromBody` L133, `retryAfterSecondsFrom` L120; 180 lines). `.code` is the ONE branchable field — the service's documented code (`conflict` included), plus the app-side `transport` and `invalid-response`. The service's own words are kept verbatim in `.serverMessage` for display; a `429`'s wait is in `.retryAfterSeconds`. |
| Putting bytes on disk | `src/lib/saveFile.ts` | [src/lib/saveFile.ts](src/lib/saveFile.ts) | **LANDED ad5c839; the STREAMING variant added at `3aa8864` (ledger row 12, slice A).** `saveFile` (L111) takes `buildBytes()` and is UNCHANGED: `showSaveFilePicker` where present, a temporary `<a download>` otherwise; the picker runs BEFORE `buildBytes()`. A cancelled picker is an OUTCOME (`{status:'cancelled'}`), not an error; a real failure throws. `saveFileStreaming` (L154) takes `buildParts: () => AsyncIterable<Blob>` instead — each part reaches `handle.createWritable()` as it arrives and the writable is closed EXACTLY ONCE, or the parts accumulate as `Blob`s for the anchor (NEVER raw arrays), so peak memory is ONE part and the browser decides whether Blob storage spills to disk. The same two rules hold (picker first; cancel silent). The whole-bytes anchor now routes through the ONE `anchorDownloadBlob` helper — a fold, not a second anchor. |
| Chunking a big file | `src/lib/chunk.ts` | [src/lib/chunk.ts](src/lib/chunk.ts) | **LANDED `3aa8864` (ledger row 12, slice A).** The ONE convention for a file too big for one request. Part size is EXACTLY the service's 64 MiB default (`CHUNK_PART_SIZE`, no margin); layout is manifest `<object>--manifest` and parts `<object>--g<generation>--part-000000`, zero-padded so lexical order IS part order. `planChunks` (the ordered write plan), `buildManifest`/`encodeManifest`/`parseManifest` (zod-validated, LOUD on malformed/wrong version, never defaulted), `isChunkManifestName`/`isChunkPartName`/`chunkedObjectNameFor`, `writeChunkedObject` (parts first, manifest LAST through an injected `ChunkWriter`; a `413` becomes a loud `ChunkPartTooLargeError` naming the part, NEVER retried or split smaller), and `analyseChunks(entries, manifestDocuments)` → per manifest COMPLETE / INCOMPLETE (naming what is missing/mismatched) / MALFORMED, plus the parts that belong to NO manifest. `analyseChunks` needs the manifest DOCUMENTS because a listing carries only name/size/sha256, never content. There is NO whole-file digest (WebCrypto has no incremental digest), so integrity is PER-PART against the service's own `x-serverstore-sha256`. The name predicates are a HEURISTIC — see §4. |
| Chunking in the UI | `src/features/files/chunks.ts`, `chunkUpload.ts`, `chunkDownload.ts`, `useChunkManifests.ts`, `ChunkPanel.tsx` | [src/features/files/](src/features/files/) | **LANDED `c53bfa0` (ledger row 12, slice B).** `chunks.ts` turns ONE listing plus the manifest documents READ from it into the view: `chunkManifestCandidates` (what must be read), `readChunkManifests` (one read at a time; a failure becomes a REPORT, never a fatal listing), `buildChunkView` (one `ChunkFileRow` per READABLE manifest — logical name, TOTAL size, the manifest's own `createdAt` and digest, and the ordered delete set — plus `reports`, `orphans`, `uncertainClaims`, `conflicts`), `visibleChunkEntries` and `takenObjectNames`. `useChunkManifests.ts` pays for the reads and makes NO claim while `loading`. `chunkUpload.ts` owns the SHAPE (`uploadShapeFor`: `<= CHUNK_PART_SIZE` → the row-9 single `putObject`, UNCHANGED; above it → `planUploadChunks` + `writeChunkedObject`, manifest LAST), the generation (`nextChunkGeneration` can never equal the previous one) and PER-PART progress; the bytes come from an injected `ChunkSource`: PRODUCTION uses `fileChunkSource` — one `slice()` per part over the picked `File` the open seam now hands over (ledger row 13, `00b4ce4`) — while `bytesChunkSource` (a zero-copy `subarray` view) remains for callers that already hold bytes and is what the pins drive. `chunkDownload.ts` verifies the manifest against the LISTING before any part, then EVERY part against the service's own `x-serverstore-sha256` AND the manifest's size+hash, streaming through `saveFileStreaming` so one part is in memory. `ChunkPanel.tsx` reports and offers NO action. **Content decides: the name only proposes** (see §3). |
| Taking files in from disk | `src/lib/openFile.ts` | [src/lib/openFile.ts](src/lib/openFile.ts) | **LANDED ad5c839; contract CHANGED at `00b4ce4` (ledger row 13).** `openFile` (161), `OpenFileRequest` (57), `OpenedFile` (69), `OpenOutcome` (82). `showOpenFilePicker` where present, a hidden `<input type=file>` otherwise; MULTIPLE files, forwarded to both branches. Same cancel-is-silent rule. **`OpenedFile` is `{fileName, file, size}` — the browser's own `File` and `size`, UNREAD.** This seam reads no bytes at all: the picker's `handle.getFile()` and the input's `input.files` are mapped straight through, so opening a GB-range selection costs handles, not memory. Every consumer reads only what it needs, when it needs it (review from `size`; the single-object path once at `putObject`; the chunked path one `slice()` per part). |
| The store's display name | — | — | none yet: the store name is a setting with the default `files`. |

## 3 · Gotchas

- **ServerStore has no metadata.** An object is a name and bytes. Nothing in this app
  may show an original file name, a MIME type or a modified time *as if the store held
  it* — the only stored facts are `name`, `sha256`, `size`, `createdAt`. (Ledger row 2.)
- **A `PUT` is an unconditional overwrite**, so an upload is a *destructive* operation
  and is treated as one: it checks the listing first and refuses a collision until the
  owner confirms. (Ledger row 4.)
- **An empty body is refused (`400 invalid_body`).** A zero-byte file therefore cannot
  be stored at all; the app must refuse it *before* the request and say why, rather
  than send it and report the service's `400` as a surprise.
- **`showSaveFilePicker` needs transient user activation.** The picker must be called
  in the click handler's own task, BEFORE any slow byte-building work, or the browser
  throws `SecurityError` — which is why the save seam takes a `buildBytes` callback
  rather than bytes.
- **`lib.dom` declares no picker methods.** `FileSystemFileHandle` exists, but
  `showSaveFilePicker`/`showOpenFilePicker` do not, so both seams read them through a
  widened structural type. That is also what makes "the API is genuinely absent" a
  check the compiler cannot narrow away.
- **CORS is `*` on the deployed service**, and `authorization` is named explicitly in
  `access-control-allow-headers` — so the key goes in `Authorization` (or `x-api-key`),
  never an undeclared custom header.
- **`base` is `/filestore/`.** Every asset URL must resolve under that subpath; a
  root-absolute `/favicon.svg` 404s. The dev server is unaffected.
- **A toast is rendered text, so the credential rule reaches it.** The service's
  `message` is arbitrary text a hostile or buggy proxy could make echo the
  `Authorization` header back, so the ONE owner-facing composition
  (`errorMessage`) redacts the credentials the app knows about before either the
  toast or an inline render sees it. **A caller that sent a credential other than
  the STORED one must say so** (`ToastErrorOptions.credential` /
  `errorMessage(error, context, credential)`) — the Settings panel's "Test
  connection" probes an unsaved DRAFT key, and that is the credential most likely
  to be new and wrong. Getting this wrong was a real defect, not a hypothetical:
  the row-9 first landing redacted only the stored key and printed the draft key in
  plain text in both surfaces (see `docs/TESTING.md` §`8d131d5`). A component that
  composes its own error string is a second place for that key to appear — route
  every failure through the seam, and pass the credential you actually sent.
- **The store documents NO order for a listing.** `?prefix=` is the only filter
  and there is no `sort`/`cursor`/`limit`, so the order the service answers with
  is not a contract. `src/features/files/useObjects.ts` sorts newest-first (then
  by name, code-unit) as a DISPLAY order only — never present it as the store's.
- **The overwrite confirmation is a UX guard, not a concurrency guard.** The
  listing is read, the owner confirms, and the `PUT` is unconditional: a second
  client can create the name in that window. The API offers no conditional write
  (no `ETag`, no `If-Match`), so this cannot be closed from inside this app and
  must not be described as atomic.
- **A chunk-shaped NAME is a heuristic, not a reservation, and a chunked file is
  only ever confirmed by CONTENT (row 12 slice B, `c53bfa0`).** `toObjectName` can
  never emit `--` inside one name SEGMENT, but the tokens are appended after the
  WHOLE object name and a full name carries folder separators — so
  `toObjectName('manifest', ['docs','report.pdf'])` IS `docs--report.pdf--manifest`,
  the manifest name of a chunked `docs--report.pdf` (**measured**;
  `docs/BOARD.md`'s trap). The app therefore READS a candidate and runs
  `parseManifest` before calling it a chunked file; a manifest-shaped object whose
  content does not parse stays a NORMAL FILE ROW (and is reported as ambiguous); a
  manifest that cannot be READ is reported, stays visible as a normal file, AND
  makes an upload under its heuristic logical name ask for confirmation; and
  **nothing is ever deleted on a name match** — an orphan sweep is a separate,
  destructive slice.

## 4 · Known debt

- **Two copies of the ServerStore transport and the browser save/open seams exist** —
  this repo's and Imager's (`~/projects/Imager/src/server/store-client.ts`,
  `src/lib/saveFile.ts`, `src/lib/openFile.ts`). This is a deliberate, recorded
  deviation (ledger row 5): lifting them into one shared package is the correct end
  state, and it was out of reach because Imager was mid-flight. **The fold target is a
  `serverstore-client` package** consumed by both apps. Until then, a fix to one copy
  is not a fix to the other — say so in the landing.
- **The object name loses the original file name** (ledger row 2). Bounded to
  `src/lib/name.ts` plus UI copy; `toObjectName` reports `changed` so the UI can
  show the mapping before an upload.
- **A dismissed open dialog can leave `openFile` pending.** On a browser with
  neither `showOpenFilePicker` nor `HTMLInputElement`'s `cancel` event (Chrome
  <113), the hidden-input fallback has no signal for "the owner dismissed it", so
  the promise stays PENDING and the UI must not treat the flow as finished. That
  is the honest failure — inventing a `cancelled` answer the browser never gave
  would be a silent fallback (rule 1). Documented in `src/lib/openFile.ts`'s
  header; not fixable from inside the browser.
- **Every browser-IO pin is jsdom with a stubbed picker, and every transport pin is
  a mock.** No test in this repo has driven a REAL
  `showSaveFilePicker`/`showOpenFilePicker`; the stubs stand in for the method's
  name, signature and async-ness, which is the strongest claim jsdom can make. The
  row-9 flows inherit this: the digest refusal is proven against a mocked
  `getObject` and the real `crypto.subtle`, never against a real disk. A
  real-browser, real-service round trip is owed and needs the owner's key (ledger
  rows 8 and 9, "unproven").
- **No pagination anywhere**, because the service has none: a very large store is one
  large listing. Mitigated only by `?prefix=` searching.
- **The UI has no prefix SEARCH, but the prefix IS now the folder.** Before row 11
  the service's ONE listing filter (`?prefix=`) was not used at all; the folder UI
  routes every listing through `folderPrefix(folder)` (`src/features/files/useObjects.ts`),
  and the root lists the whole store (the absent prefix), which is what makes the
  root's subfolders derivable. What is still missing is a SEARCH control: there is
  no way to look for an object by name fragment, and a very large store is still
  one large listing per folder. Fine at the scale the store has been used at;
  wrong for thousands of objects.
- **A folder row's counts are as fresh as the last listing.** `describeFolder` is
  pure over the entries the browser already holds, and the service documents NO
  order and no aggregate, so a count is a client-side tally of one read. The
  create/delete existence check is the same read-then-write shape as the overwrite
  confirmation: a second client can change the subtree in that window and the API
  has no conditional write to close it. A marker also STAYS after the first file
  is uploaded into its folder (harmless — the folder is no longer empty — but it
  remains an object a folder delete must remove, which is why `deleteCount`
  includes it).
- **A folder name is typed as a store segment, not mapped like a file name.** The
  New-folder field refuses `My Reports` (a space and a capital) with the name
  seam's own reason rather than silently creating `my-reports`; the hint under the
  field names the legal characters. Mapping it through `toObjectName` — as an
  upload does — is the obvious follow-up if the owner finds the refusal annoying,
  and it would need a review step so the create is never a silent rename.
- **The download's integrity check trusts the service's own header.** The digest is
  compared with the `x-serverstore-sha256` the same response carried; nothing signs
  it. A party who can rewrite the body AND the header is not detected — the check
  proves the bytes arrived intact, not that the service is honest. That is the
  strongest claim available over this API.
- **The success of a "Test connection" is not remembered.** The settings panel
  probes the DRAFT values, and the shell's connection state re-probes only when the
  settings change; a transient failure leaves the shell in `failed` until the owner
  saves or tests again (there is no retry control on the banner).
- **The LIVE ServerStore service is STALE, so the 1024-character bound is not
  actually live.** The running process started before ServerStore's `26f9e46`, so
  it still enforces 64 characters (measured 2026-09-28; `docs/BOARD.md`). Every pin
  in ledger row 10 is therefore **unit-level**: no name or `?prefix=` longer than
  64 characters has been exercised end to end, and a folder whose full name
  exceeds 64 will be refused by the live process until an operator restarts it.
  That restart is a ServerStore/operator step, never this app's. **The folder UI
  (row 11) inherits this and cannot be exercised past it end to end:** navigating
  into, creating, or uploading into a folder whose full name exceeds 64 characters
  is refused by the live process with `400 invalid_name` — the pins are jsdom over
  mocked transport, so they prove the DERIVATION, not a live round trip.
- **Folder move/rename is not implemented, and cannot be cheap.** The API has no
  rename and no copy route, so moving a folder is `GET` + `PUT` + `DELETE` per
  file — **3N requests** against the service's **600 requests/minute/client**
  limit, i.e. a ~200-file folder move IS the rate limit, and a `429` must be
  honoured by waiting, never retried. **Slice 2 (row 11, `ef7ce5e`) landed
  create / navigate / upload-into / delete-folder (N `DELETE`s, confirmed with
  the count, stopping at the first failure); move/rename remains DEFERRED**, and
  a future slice must warn the owner before it runs.
- **The folder convention is a CONVENTION, not an enforced boundary.** Another
  ServerStore client can `PUT` a legal name containing `--` and this app reads it
  as a nested path. What is pinned is that THIS app's mapper can never PRODUCE one
  (the reserved-separator property); a foreign name is interpreted by the
  convention, not validated against an owner's intent.
- **The chunk tokens are reserved only WITHIN ONE NAME SEGMENT, so name detection
  is a HEURISTIC (row 12 slice A, `3aa8864`).** `toObjectName` can never emit `--`
  inside one segment, so a mapped FILE PART can never contain `--manifest` or
  `--part-`. But the tokens are appended AFTER the whole object name, and a full
  name carries folder separators: `toObjectName('manifest', ['docs'])` IS
  `docs--manifest`, and a file `part-000000` in folder `docs/ga1b2c3d4` IS
  `docs--ga1b2c3d4--part-000000`. So `isChunkManifestName`/`isChunkPartName` can
  match an ordinary file. Slice B MUST confirm a candidate by reading it and
  running `parseManifest` (which checks the manifest names its own object), and a
  false positive is MALFORMED — never a silent sweep or delete. Pinned, with the
  ambiguity named, in `tests/lib/chunk.test.ts`; a future convention change that
  removes the ambiguity should update that pin.
- **Integrity is PER-PART, and there is no whole-file digest — by physical
  necessity, not by choice.** `crypto.subtle.digest` is one-shot and WebCrypto has
  no incremental digest, so hashing a 2 GB file would need all of it in memory.
  Each part is verified against the service's own `x-serverstore-sha256` on write
  (`writeChunkedObject` records it) and on read (slice B), and the manifest records
  the ordered full part names, sizes and hashes. That proves each part arrived
  intact; it does NOT prove the set of parts is the file the owner picked beyond
  what the manifest itself records.
- **A `413` is the ONLY signal that the server's cap moved, and the anchor path's
  memory safety is BROWSER behaviour this app cannot guarantee.** No route exposes
  the service's cap, so `CHUNK_PART_SIZE` (64 MiB) is an ASSUMPTION about server
  config; a `413` on a part is reported LOUDLY as "the cap may be LOWER than the
  part size", naming the part, and is never retried or silently split smaller
  (`ChunkPartTooLargeError`). On the save side, the no-picker streaming path
  accumulates `Blob`s and relies on the browser spilling Blob storage to disk for
  a multi-GB file — that is the browser's behaviour, not ours to guarantee, so
  peak memory on the anchor path is bounded by the browser, not by this app.
- **Every chunk pin is unit-level.** They run in jsdom with a stubbed picker and an
  INJECTED `ChunkWriter`; no part has been PUT to the live service and no chunked
  file has been saved through a real picker, so the 64 MiB assumption and the
  Cloudflare 100 MB wall are measured from the services' own docs, not exercised
  end to end. **Slice B (`c53bfa0`) is unit-level too**, and says so below; only the
  owner's round trip exercises the real thing.
- ~~**THE UPLOAD DOES NOT ADD A COPY OF THE FILE, BUT IT STILL HOLDS THE FILE — because the frozen open seam reads it whole.**~~ **CLOSED at `00b4ce4` (ledger row 13): the open seam now hands over the `File` UNREAD, so no boundary in this app materialises a whole picked file.** `src/lib/openFile.ts` reads no bytes at all (`OpenedFile` is `{fileName, file, size}`, L69); the review decides zero-byte from `size`; the single-object path reads the file ONCE at its `putObject` call; the chunked path reads one `file.slice(start, end)` per part through `fileChunkSource` (the default source, `chunkUpload.ts` L237). **The DOWNLOAD side never had the gap:** it streams one part at a time through `saveFileStreaming`. **What is still unproven:** no multi-GB upload has been exercised in a REAL browser — every pin is jsdom over a mocked transport and a stubbed picker — so the browser's own file-size and typed-array limits remain the ceiling, not this app's behaviour.

- **No multi-GB file has been exercised in a real browser.** Every chunk pin is unit-level: jsdom, mocked transport, a stubbed picker, and a `chunkPartSize` of a few BYTES — the service's 64 MiB cap is hard-coded in the frozen `planChunks`, and no test may build a real 64 MiB buffer. So the 64 MiB assumption, the Cloudflare 100 MB wall, the real speed of 33 sequential requests through the tunnel, and whether the anchor (no-picker) path's Blob accumulation spills to disk are taken from the services' own docs or from browser behaviour — not measured. `chunkPartSize` (on `FileBrowser`/`UploadPanel`) is the pin seam that makes small fixtures possible; production always passes the default.
- **A chunked file's row shows the MANIFEST's digest, and the store holds no whole-file digest.** The digest column is honest — its `title` says which object it describes — but it is not a digest of the file's bytes; the per-part hashes are the strongest claim this API allows (see the per-part row above).
- **An overwrite leaves the PREVIOUS representation in the store until the owner removes it.** A chunked→chunked overwrite keeps the old generation's parts (orphans, reported); a representation change (plain ↔ chunked) leaves the other object too, and the panel reports the double representation. The removal is OFFERED, never automatic — deleting on an inference is the destructive act rule 1 forbids — and a part-only subtree deliberately gets no folder row, so its objects are reachable only through their NAMES in the report.
