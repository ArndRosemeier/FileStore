# Architecture — the seam index

The seam index answers *"how does this codebase work, and where is the ONE place that
does X?"* — the layer map, the seam rows, the gotchas and the known debt. It is what a
brief is scoped against and what a writer reads before touching an area.

## 1 · Layer map

Dependencies point **downward only**. A lower layer never imports an upper one.

| Layer | What lives there | May import |
| --- | --- | --- |
| **UI** — `src/App.tsx`, `src/features/**` | React components and the flows (settings, upload, list, retrieve). Owns user-visible copy and confirmations. | everything below |
| **App services** — `src/settings/**`, `src/lib/toast.ts` | The app's own state (settings) and its ONE error/notification surface. | `lib/`, `server/` |
| **Seams** — `src/server/**`, `src/lib/name.ts`, `src/lib/saveFile.ts`, `src/lib/openFile.ts` | The ONE place each external boundary is spoken to: ServerStore's HTTP API, the object-name mapping, the browser's save dialog, the browser's open dialog. | nothing above; `zod` and the platform only |

The rule that makes this map worth having: **the UI never calls `fetch`, never reads
`settings.key`, and never builds an object name.** Each of those has exactly one home
below it.

## 2 · The one way to do X

| Seam | The ONE way | Where | Notes |
| --- | --- | --- | --- |
| The app's name | the `served` state | [src/lib/name.ts](src/lib/name.ts) | **PLANNED — row 8.** Real file name ↔ a ServerStore-legal object name (`[a-z0-9][a-z0-9._-]{0,63}`). The mapping is shown to the owner before an upload; a name that cannot map legally is a loud refusal, never a guess. |
| The app's settings | `src/settings/settings.ts` | [src/settings/settings.ts](src/settings/settings.ts) | **PLANNED — row 8.** The ONE persisted state: `baseUrl`, `store`, `key`. `localStorage`, zod-validated on read; a corrupt stored value is reported, never silently replaced by defaults. |
| The app's error surface | `src/lib/toast.ts` | [src/lib/toast.ts](src/lib/toast.ts) | **PLANNED — row 8.** The ONE place a failure becomes something the owner can see. A real error does not auto-dismiss. |
| Talking to ServerStore | `src/server/store-client.ts` | [src/server/store-client.ts](src/server/store-client.ts) | **LANDED 6718f9d.** The ONE `fetch` to the store: `requestRaw` L148, `whoami` L238, `healthz` L248, `listObjects` L271, `getObject` L288, `putObject` L323, `deleteObject` L347 (356 lines). Puts the key in exactly ONE header (`Authorization: Bearer`); never logs it, never puts it in a URL or a message. Reports `429`/`5xx` with the `Retry-After`; **never retries**. A zero-byte `PUT` is refused before any request; a `GET` without a valid `x-serverstore-sha256`, or with zero bytes, is refused. |
| ServerStore's error vocabulary | `src/server/store-errors.ts` | [src/server/store-errors.ts](src/server/store-errors.ts) | **LANDED 6718f9d.** The service's `{error:{code,message}}` envelope → one typed `ServerStoreError` (`class` L71, `errorFromResponse` L157, `envelopeFromBody` L133, `retryAfterSecondsFrom` L120; 180 lines). `.code` is the ONE branchable field — the service's documented code (`conflict` included), plus the app-side `transport` and `invalid-response`. The service's own words are kept verbatim in `.serverMessage` for display; a `429`'s wait is in `.retryAfterSeconds`. |
| Putting bytes on disk | `src/lib/saveFile.ts` | [src/lib/saveFile.ts](src/lib/saveFile.ts) | **PLANNED — row 8.** `showSaveFilePicker` where present, a temporary `<a download>` otherwise. A cancelled picker is an OUTCOME (`{status:'cancelled'}`), not an error; a real failure throws. |
| Taking files in from disk | `src/lib/openFile.ts` | [src/lib/openFile.ts](src/lib/openFile.ts) | **PLANNED — row 8.** `showOpenFilePicker` where present, a hidden `<input type=file>` otherwise. Same cancel-is-silent rule. |
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

## 4 · Known debt

- **Two copies of the ServerStore transport and the browser save/open seams exist** —
  this repo's and Imager's (`~/projects/Imager/src/server/store-client.ts`,
  `src/lib/saveFile.ts`, `src/lib/openFile.ts`). This is a deliberate, recorded
  deviation (ledger row 5): lifting them into one shared package is the correct end
  state, and it was out of reach because Imager was mid-flight. **The fold target is a
  `serverstore-client` package** consumed by both apps. Until then, a fix to one copy
  is not a fix to the other — say so in the landing.
- **The object name loses the original file name** (ledger row 2). Bounded to
  `src/lib/name.ts` plus UI copy.
- **No pagination anywhere**, because the service has none: a very large store is one
  large listing. Mitigated only by `?prefix=` searching.
- **`src/App.tsx` is a day-1 placeholder** that renders no store browser; it is
  replaced by the UI slice, and `docs/BOARD.md` says so.
