/**
 * THE ServerStore transport seam (ledger row 7): the ONE place this app talks
 * to the store over HTTP. Every other module — settings, UI, dialogs — goes
 * through these functions; nothing else under `src/` calls `fetch(`.
 * (Pinned by `tests/architecture/one-fetch.test.ts`, which reads the files from
 * disk; and by `tests/architecture/one-fetch.test.ts`'s second pin that the
 * `Authorization` header is built in exactly one module.)
 *
 * PORTED from `~/projects/Imager/src/server/store-client.ts` (ledger row 5;
 * Imager is READ-ONLY and was not touched). What changed here, and why:
 *
 *  * **`DEFAULT_STORE_NAME` is `files`**, not Imager's `imager`.
 *  * **Everything Imager-specific was DROPPED**: folders, per-key ownership,
 *    the Dexie cache and the image encoder are not transport at all, and none of
 *    them exists in this app. What is left is the documented object API:
 *    `whoami`, `healthz`, `listObjects`, `getObject`, `putObject`,
 *    `deleteObject`.
 *  * **`putObject` REFUSES a zero-byte payload BEFORE issuing a request.** The
 *    service refuses an empty body (`400 invalid_body`), so sending it spends a
 *    round trip to learn what the client already knows — and the client can say
 *    why. The refusal is typed `invalid_body`, the same code the service would
 *    have used, so a caller branches once.
 *  * **`listObjects` sends `?prefix=` only when a prefix is GIVEN.** An absent
 *    prefix means "the whole store"; an empty string is a caller bug and is sent
 *    as-is so the service's loud `400 invalid_name` surfaces, rather than being
 *    silently reinterpreted as "all objects" (rule 1).
 *
 * WHAT IS KEPT, DELIBERATELY:
 *  * the **60 s headers timeout** (`HEADERS_TIMEOUT_MS`), and the caller's own
 *    `AbortSignal` composed with it — a hung socket aborts loudly instead of
 *    hanging the app;
 *  * **no retry, ever.** The service rate limits per client and answers
 *    `429 rate_limited` with `Retry-After`; this seam REPORTS it, with the wait.
 *    A silently retried `PUT` can double-upload, and a `PUT` is an
 *    unconditional overwrite (ledger row 7);
 *  * **zod parsing of every JSON body.** A body that does not match the
 *    schema is a loud `invalid-response`, never empty data (rule 3);
 *  * the **`x-serverstore-sha256` check** on every object read — without the
 *    service's own digest the app cannot claim what it received, so a missing
 *    or malformed digest is refused as `invalid-response`.
 *
 * THE KEY IS A PASSWORD. It travels in `Authorization: Bearer <key>` ONLY:
 * never a query string, never a URL, never a `console.*` call, never an error
 * message. Error text names CODES and ENDPOINTS.
 */
import { z } from 'zod';

import {
  ServerStoreError,
  errorFromResponse,
  type ServerStoreErrorCode,
} from '@/server/store-errors';

/** The documented production origin; the stored setting may point elsewhere. */
export const DEFAULT_BASE_URL = 'https://store.futuremagic.de';

/**
 * The store this app's files live in. The app never creates stores — that needs
 * a master admin key this app must never hold (AGENTS.md §What this app is).
 */
export const DEFAULT_STORE_NAME = 'files';

/** A request whose response headers never arrive is aborted loudly. */
export const HEADERS_TIMEOUT_MS = 60_000;

/** One object-row of a listing, exactly as `GET …/objects` documents it. */
export const objectEntrySchema = z.strictObject({
  store: z.string(),
  name: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ObjectEntry = z.infer<typeof objectEntrySchema>;

const listResponseSchema = z.object({ objects: z.array(objectEntrySchema) });

const whoamiSchema = z.object({
  id: z.string(),
  label: z.string(),
  stores: z.array(z.string()),
  perms: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type WhoAmI = z.infer<typeof whoamiSchema>;

const putResponseSchema = z.object({
  store: z.string(),
  name: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type PutResult = z.infer<typeof putResponseSchema>;

const healthzSchema = z.object({ ok: z.boolean() });

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What one object read produced. `sha256` is the SERVICE's own header. */
export interface ObjectBytes {
  bytes: Uint8Array<ArrayBuffer>;
  /** `x-serverstore-sha256` — CORS-exposed, so the browser can read it. */
  sha256: string;
  /**
   * The service's own `content-type` (`application/octet-stream` by contract).
   * It is NOT the file's MIME type — the service stores no metadata — so it is
   * reported for diagnostics only and must never be presented as the file's
   * type.
   */
  contentType: string;
}

/** The caller's ServerStore target: an origin, a store name and a key. */
export interface StoreTarget {
  baseUrl: string;
  store: string;
  /** The `ssk_…` credential. Never formatted into a message or a URL. */
  key: string;
}

/** `https://host` → `https://host` (trailing slashes dropped so path joins
 * cannot produce `//`); an empty base is a loud `transport` error. */
function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new ServerStoreError('transport', 'No ServerStore URL is configured.');
  return trimmed;
}

function storePath(target: StoreTarget, suffix: string): string {
  return `/stores/${encodeURIComponent(target.store)}${suffix}`;
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * ONE request. `init.json` is serialised here; everything else is the caller's.
 * A non-OK response becomes a typed `ServerStoreError`; a URL-level failure
 * becomes a `transport` error naming the method and path (never the key).
 */
export async function requestRaw(
  target: StoreTarget,
  path: string,
  init: {
    method: string;
    body?: Uint8Array<ArrayBuffer>;
    json?: unknown;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const base = normalizeBase(target.baseUrl);
  // THE one place the credential is attached, to THE one header it belongs in.
  const headers: Record<string, string> = { Authorization: `Bearer ${target.key}` };
  const requestInit: RequestInit = { method: init.method, headers };
  if (init.signal !== undefined) requestInit.signal = init.signal;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(init.json);
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    requestInit.body = init.body;
  }

  // The caller's signal and the headers timeout are COMPOSED into one signal:
  // either aborts the socket, and the reason that reaches `fetch` says which.
  const controller = new AbortController();
  const callerSignal = init.signal;
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `ServerStore request timed out: no response headers within ${String(Math.round(HEADERS_TIMEOUT_MS / 1000))}s for ${init.method} ${path}`,
        'TimeoutError',
      ),
    );
  }, HEADERS_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...requestInit, signal: controller.signal });
  } catch (error: unknown) {
    // A URL-level failure has NO envelope: report the method and path, and keep
    // the underlying reason (rule 1). The key is not part of either.
    throw new ServerStoreError(
      'transport',
      `Could not reach ServerStore at ${base} (${init.method} ${path}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }

  if (!response.ok) {
    throw errorFromResponse(response, await readText(response));
  }
  return response;
}

/** Parse a JSON body with zod; a mismatch is a loud `invalid-response`, never
 * empty data (rule 3). */
async function readJson<T>(response: Response, schema: z.ZodType<T>, path: string): Promise<T> {
  const text = await readText(response);
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ServerStoreError(
      'invalid-response',
      `ServerStore answered ${path} with a body that is not JSON (${String(error)}).`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ServerStoreError(
      'invalid-response',
      `ServerStore answered ${path} with a body this app does not understand: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** `GET /whoami` — which key, which scope, which permissions. No secret is in
 * the response; the UI shows this on connect. */
export async function whoami(target: StoreTarget, signal?: AbortSignal): Promise<WhoAmI> {
  const response = await requestRaw(target, '/whoami', {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  return readJson(response, whoamiSchema, '/whoami');
}

/** `GET /healthz` — no key required, never rate limited. Reachability is a
 * command, not an assumption. */
export async function healthz(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const base = normalizeBase(baseUrl);
  let response: Response;
  try {
    response = await fetch(`${base}/healthz`, signal === undefined ? {} : { signal });
  } catch (error: unknown) {
    throw new ServerStoreError(
      'transport',
      `Could not reach ServerStore at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) throw errorFromResponse(response, await readText(response));
  const body = await readJson(response, healthzSchema, '/healthz');
  return body.ok;
}

/**
 * `GET /stores/{store}/objects` — every object with its `sha256`, size and
 * `createdAt`. `prefix` is the route's ONE filter; an unmatchable prefix is a
 * `400 invalid_name` the service sends on purpose, so pass a legal prefix or
 * none.
 */
export async function listObjects(
  target: StoreTarget,
  prefix?: string,
  signal?: AbortSignal,
): Promise<ObjectEntry[]> {
  const query = prefix === undefined ? '' : `?prefix=${encodeURIComponent(prefix)}`;
  const path = `${storePath(target, '/objects')}${query}`;
  const response = await requestRaw(target, path, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  const body = await readJson(response, listResponseSchema, path);
  return body.objects;
}

/** `GET /stores/{store}/objects/{name}` — the exact bytes that were PUT, with
 * the service's own digest. */
export async function getObject(
  target: StoreTarget,
  name: string,
  signal?: AbortSignal,
): Promise<ObjectBytes> {
  const path = storePath(target, `/objects/${encodeURIComponent(name)}`);
  const response = await requestRaw(target, path, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = response.headers.get('x-serverstore-sha256');
  if (sha256 === null || !SHA256_HEX.test(sha256)) {
    // Without the service's own hash the app could not prove what it received;
    // reporting success here would be the silent trust rule 1 forbids.
    throw new ServerStoreError(
      'invalid-response',
      `ServerStore returned ${name} without a readable x-serverstore-sha256 header (64 lowercase hex), so the download cannot be verified.`,
    );
  }
  if (bytes.length === 0) {
    throw new ServerStoreError('invalid-response', `ServerStore returned ${name} with zero bytes.`);
  }
  return { bytes, sha256, contentType: response.headers.get('content-type') ?? '' };
}

/**
 * `PUT /stores/{store}/objects/{name}` — the body IS the object, and this is an
 * UNCONDITIONAL OVERWRITE (the API has no create-only variant), so a caller
 * that would lose an existing object must check the listing and confirm first.
 *
 * A ZERO-BYTE payload is refused here, before any request is issued: the
 * service refuses it too (`400 invalid_body`), and the client can say why.
 */
export async function putObject(
  target: StoreTarget,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<PutResult> {
  if (bytes.length === 0) {
    throw new ServerStoreError(
      'invalid_body',
      `Refusing to upload ${name}: the payload is zero bytes, and ServerStore refuses an empty body (400 invalid_body). Nothing was sent.`,
    );
  }
  const path = storePath(target, `/objects/${encodeURIComponent(name)}`);
  const response = await requestRaw(target, path, {
    method: 'PUT',
    body: bytes,
    ...(signal === undefined ? {} : { signal }),
  });
  return readJson(response, putResponseSchema, path);
}

/** `DELETE /stores/{store}/objects/{name}` — `204`, no body. Included because
 * the seam models the API's object operations ONCE; whether the UI exposes a
 * delete is the UI slice's call. */
export async function deleteObject(
  target: StoreTarget,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const path = storePath(target, `/objects/${encodeURIComponent(name)}`);
  await requestRaw(target, path, { method: 'DELETE', ...(signal === undefined ? {} : { signal }) });
}

export type { ServerStoreErrorCode };
