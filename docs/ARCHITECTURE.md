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
| **Seams** — `src/server/**`, `src/lib/name.ts`, `src/lib/saveFile.ts`, `src/lib/openFile.ts`, `src/lib/sha256.ts`, `src/lib/format.ts` | The ONE place each external boundary is spoken to (ServerStore's HTTP API, the object-name mapping, the browser's save and open dialogs, the digest algorithm) — plus the pure, deterministic display formatters. | nothing above; `zod` and the platform only |

The rule that makes this map worth having: **the UI never calls `fetch`, never reads
`settings.key`, never builds an object name, and never composes its own error text.**
Each of those has exactly one home below it.

## 2 · The one way to do X

| Seam | The ONE way | Where | Notes |
| --- | --- | --- | --- |
| The app's name | the `served` state | [src/lib/name.ts](src/lib/name.ts) | **LANDED ad5c839** — `toObjectName` (line 146), `OBJECT_NAME_PATTERN` (44), `ObjectNameMappingError` (63). Real file name ↔ a ServerStore-legal object name (`[a-z0-9][a-z0-9._-]{0,63}`). The mapping is shown to the owner before an upload (`changed`); a name that cannot map legally is a loud refusal, never a guess. |
| The app's settings | `src/settings/settings.ts` | [src/settings/settings.ts](src/settings/settings.ts) | **LANDED ad5c839** — `readSettings` (133), `writeSettings` (147), `forgetKey` (166), `DEFAULT_SETTINGS` (55). The ONE persisted state: `baseUrl`, `store`, `key`. `localStorage`, zod-validated on read; a corrupt stored value is reported as `{corrupt, problem}`, never silently replaced by defaults — and the key never enters a message. |
| The app's error surface | `src/lib/toast.ts` | [src/lib/toast.ts](src/lib/toast.ts) | **LANDED 80d7186** — `toastError` (105), `errorMessage` (100), `errorText` (89), `redactCredential` (60), `ERROR_TOAST_DURATION_MS` (37); 116 lines. The ONE place a failure becomes something the owner can see: a real error carries `duration: Infinity` (never auto-dismisses) and a cancellation never reaches it. `errorMessage` is the ONE composition the toast AND every inline failure render share, and it redacts the stored credential from arbitrary text (a toast is rendered text; the service's `message` is not trusted). |
| The proven connection | `useStore` | [src/app/useStore.ts](src/app/useStore.ts) | **LANDED 80d7186** — `useStore` (67), `storeTargetFrom` (51), `StoreConnection` (40); 101 lines. `unconfigured` (no key — an honest first run, NOT an error) · `connecting` · `ready` (carrying `WhoAmI`) · `failed` (carrying the error). The key is PROVEN with `whoami`, never assumed from `healthz` (which needs no key at all), and nothing throws into the shell. `storeTargetFrom` is the ONE place the three settings become a `StoreTarget`. |
| The digest of bytes | `sha256Hex` | [src/lib/sha256.ts](src/lib/sha256.ts) | **LANDED 80d7186** — `sha256Hex` (24); 31 lines. Lowercase hex SHA-256 via `crypto.subtle`. It exists for exactly ONE caller: the download flow's check of the received bytes against the service's `x-serverstore-sha256` (`src/features/files/download.ts` L47). |
| The store's flows | `src/features/files/**` | [src/features/files/](src/features/files/) | **LANDED 80d7186** — `reviewUploads` (upload.ts L58), `unconfirmedOverwrites` (L109 — ledger row 4's gate), `verifiedObjectBytes` / `downloadObject` (download.ts L41/L64), `useObjects` (L58), `UploadPanel` (L53), `FileBrowser` (L35). The listing shows only `name`/`size`/`createdAt`/truncated `sha256`; the upload reviews every file before any request; a download verifies before the save seam is allowed to write; a delete asks first. |
| Display formatting | `src/lib/format.ts` | [src/lib/format.ts](src/lib/format.ts) | **LANDED 80d7186** — `formatByteSize` (33), `formatTimestamp` (67), `shortSha256` (84), `formatObjectCount` (90); 92 lines. Pure and deterministic: binary sizes, UTC timestamps, no `Intl`/locale/time zone. A size that is not a byte count is a LOUD `RangeError`, never `0 B`. |
| Talking to ServerStore | `src/server/store-client.ts` | [src/server/store-client.ts](src/server/store-client.ts) | **LANDED 6718f9d.** The ONE `fetch` to the store: `requestRaw` L148, `whoami` L238, `healthz` L248, `listObjects` L271, `getObject` L288, `putObject` L323, `deleteObject` L347 (356 lines). Puts the key in exactly ONE header (`Authorization: Bearer`); never logs it, never puts it in a URL or a message. Reports `429`/`5xx` with the `Retry-After`; **never retries**. A zero-byte `PUT` is refused before any request; a `GET` without a valid `x-serverstore-sha256`, or with zero bytes, is refused. |
| ServerStore's error vocabulary | `src/server/store-errors.ts` | [src/server/store-errors.ts](src/server/store-errors.ts) | **LANDED 6718f9d.** The service's `{error:{code,message}}` envelope → one typed `ServerStoreError` (`class` L71, `errorFromResponse` L157, `envelopeFromBody` L133, `retryAfterSecondsFrom` L120; 180 lines). `.code` is the ONE branchable field — the service's documented code (`conflict` included), plus the app-side `transport` and `invalid-response`. The service's own words are kept verbatim in `.serverMessage` for display; a `429`'s wait is in `.retryAfterSeconds`. |
| Putting bytes on disk | `src/lib/saveFile.ts` | [src/lib/saveFile.ts](src/lib/saveFile.ts) | **LANDED ad5c839** — `saveFile` (111). `showSaveFilePicker` where present, a temporary `<a download>` otherwise; the picker runs BEFORE `buildBytes()`. A cancelled picker is an OUTCOME (`{status:'cancelled'}`), not an error; a real failure throws. |
| Taking files in from disk | `src/lib/openFile.ts` | [src/lib/openFile.ts](src/lib/openFile.ts) | **LANDED ad5c839** — `openFile` (164), `OpenFileRequest` (50), `OpenedFile` (62). `showOpenFilePicker` where present, a hidden `<input type=file>` otherwise; MULTIPLE files, forwarded to both branches. Same cancel-is-silent rule. |
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
  (`errorMessage`) redacts the *stored* key before either the toast or an inline
  render sees it. A component that composes its own error string is a second
  place for that key to appear — route every failure through the seam.
- **The store documents NO order for a listing.** `?prefix=` is the only filter
  and there is no `sort`/`cursor`/`limit`, so the order the service answers with
  is not a contract. `src/features/files/useObjects.ts` sorts newest-first (then
  by name, code-unit) as a DISPLAY order only — never present it as the store's.
- **The overwrite confirmation is a UX guard, not a concurrency guard.** The
  listing is read, the owner confirms, and the `PUT` is unconditional: a second
  client can create the name in that window. The API offers no conditional write
  (no `ETag`, no `If-Match`), so this cannot be closed from inside this app and
  must not be described as atomic.

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
- **The UI has no prefix filter.** The service's ONE listing filter (`?prefix=`) is
  not exposed by any control in `src/features/files/**`; the whole store is listed
  and the owner scrolls. Fine at the scale the store has been used at, wrong for a
  store with thousands of objects — and it is a UI-only change (`useObjects` already
  takes a target, and `listObjects` already takes a prefix).
- **The download's integrity check trusts the service's own header.** The digest is
  compared with the `x-serverstore-sha256` the same response carried; nothing signs
  it. A party who can rewrite the body AND the header is not detected — the check
  proves the bytes arrived intact, not that the service is honest. That is the
  strongest claim available over this API.
- **The success of a "Test connection" is not remembered.** The settings panel
  probes the DRAFT values, and the shell's connection state re-probes only when the
  settings change; a transient failure leaves the shell in `failed` until the owner
  saves or tests again (there is no retry control on the banner).
