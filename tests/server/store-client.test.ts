/**
 * Pins for `src/server/store-client.ts` — THE one transport seam (ledger row 7).
 *
 * Every test here drives the REAL seam against a stubbed `fetch`. The only fake
 * is the network; the URL, the headers, the zod parsing, the retry policy and the
 * integrity check are the shipped code.
 *
 * The statement each test's name carries is the deliverable. The differential
 * that watched the zero-byte refusal and the digest check go red is recorded in
 * `docs/TESTING.md` (row 7).
 */
import { afterEach, expect, it, vi, type Mock } from 'vitest';

import { ServerStoreError } from '@/server/store-errors';
import {
  DEFAULT_BASE_URL,
  DEFAULT_STORE_NAME,
  HEADERS_TIMEOUT_MS,
  deleteObject,
  getObject,
  healthz,
  listObjects,
  objectEntrySchema,
  putObject,
  whoami,
  type StoreTarget,
} from '@/server/store-client';

const KEY = 'ssk_test_0123456789abcdef_SENTINEL';
const SHA = 'a'.repeat(64);
const TARGET: StoreTarget = { baseUrl: 'https://store.example', store: 'files', key: KEY };

const ENTRY = {
  store: 'files',
  name: 'notes.txt',
  sha256: SHA,
  size: 3,
  createdAt: '2026-09-28T00:00:00.000Z',
};
const PUT_RESULT = { ...ENTRY };
const WHOAMI = {
  id: 'key-1',
  label: 'owner',
  stores: ['files'],
  perms: ['read', 'write', 'delete'],
  expiresAt: null,
  lastUsedAt: null,
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
}

interface FetchStub {
  calls: CapturedCall[];
  mock: Mock;
}

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

/** The ONE fetch stand-in: it records what the seam ACTUALLY sent. */
function stubFetch(responder: Responder): FetchStub {
  const calls: CapturedCall[] = [];
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const requestInit: RequestInit = init ?? {};
    calls.push({
      url,
      method: requestInit.method ?? 'GET',
      headers: new Headers(requestInit.headers),
      body: requestInit.body,
      signal: requestInit.signal,
    });
    return Promise.resolve(responder(url, requestInit));
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function objectBytesResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'x-serverstore-sha256': SHA },
  });
}

/** The whole documented object API, routed by path and method. */
function fullRouter(url: string, init: RequestInit): Response {
  const path = new URL(url).pathname;
  if (path === '/healthz') return jsonResponse({ ok: true });
  if (path === '/whoami') return jsonResponse(WHOAMI);
  if (path.endsWith('/objects')) return jsonResponse({ objects: [ENTRY] });
  if (path.includes('/objects/')) {
    if (init.method === 'PUT') return jsonResponse(PUT_RESULT, 201);
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return objectBytesResponse(new Uint8Array([1, 2, 3]));
  }
  return jsonResponse({ error: { code: 'not_found', message: 'no such route' } }, 404);
}

/** A value that must exist: no cast, no non-null assertion. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Test setup: missing ${what}`);
  return value;
}

/** The typed error a call produced — and a FAILURE if it resolved instead. */
async function rejection(run: () => Promise<unknown>): Promise<ServerStoreError> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof ServerStoreError) return error;
    throw error;
  }
  throw new Error('Expected the call to reject, but it resolved — a silent fallback.');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('the key travels in exactly ONE header and appears in no URL, no log and no error message', async () => {
  const consoleSpies = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'info'),
    vi.spyOn(console, 'warn'),
    vi.spyOn(console, 'error'),
    vi.spyOn(console, 'debug'),
  ];
  const stub = stubFetch(fullRouter);

  await whoami(TARGET);
  await healthz(TARGET.baseUrl);
  await listObjects(TARGET);
  await getObject(TARGET, 'notes.txt');
  await putObject(TARGET, 'notes.txt', new Uint8Array([1, 2, 3]));
  await deleteObject(TARGET, 'notes.txt');

  // Never in a URL: not the path, not a query string.
  for (const call of stub.calls) {
    expect(call.url, `${call.method} ${call.url}`).not.toContain(KEY);
    expect(new URL(call.url).search).not.toContain(KEY);
  }

  // Exactly ONE header, and it is `Authorization: Bearer <key>` — on every
  // request that carries a credential at all.
  const keyed = stub.calls.filter((call) => !call.url.endsWith('/healthz'));
  expect(keyed).toHaveLength(5);
  for (const call of keyed) {
    const carrying = [...call.headers.entries()].filter(([, value]) => value.includes(KEY));
    expect(carrying, `${call.method} ${call.url}`).toHaveLength(1);
    expect(carrying[0]?.[0]).toBe('authorization');
    expect(carrying[0]?.[1]).toBe(`Bearer ${KEY}`);
  }

  // `/healthz` is the one unauthenticated route; it carries NO credential.
  const health = must(
    stub.calls.find((call) => call.url.endsWith('/healthz')),
    'the /healthz call',
  );
  expect([...health.headers.entries()].filter(([, value]) => value.includes(KEY))).toHaveLength(0);

  // Nor in any error message, on the API path and on the transport path.
  for (const responder of [
    () => jsonResponse({ error: { code: 'unauthorized', message: 'missing or invalid key' } }, 401),
    () => {
      throw new TypeError('Failed to fetch');
    },
  ]) {
    stubFetch(responder);
    const error = await rejection(() => whoami(TARGET));
    expect(error.message).not.toContain(KEY);
    expect(error.serverMessage ?? '').not.toContain(KEY);
    expect(error.stack ?? '').not.toContain(KEY);
  }

  // And in no log line: this seam never writes to the console at all.
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
});

it.each([
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [409, 'conflict'],
  [413, 'payload_too_large'],
  [429, 'rate_limited'],
] as const)(
  'a non-OK %i becomes a typed error carrying the service’s own code (%s)',
  async (status, code) => {
    stubFetch(() => jsonResponse({ error: { code, message: `service says ${code}` } }, status));
    const error = await rejection(() => whoami(TARGET));
    expect(error).toBeInstanceOf(ServerStoreError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.serverMessage).toBe(`service says ${code}`);
  },
);

it('a 429 is REPORTED, never retried, and its Retry-After is surfaced', async () => {
  const stub = stubFetch(() =>
    jsonResponse({ error: { code: 'rate_limited', message: 'slow down' } }, 429, {
      'retry-after': '42',
    }),
  );
  const error = await rejection(() => putObject(TARGET, 'notes.txt', new Uint8Array([1, 2, 3])));
  expect(error.code).toBe('rate_limited');
  expect(error.retryAfterSeconds).toBe(42);
  // ONE request. A retry would make this 2 — and a silently retried PUT
  // double-uploads (ledger row 7).
  expect(stub.calls).toHaveLength(1);
});

it('listObjects sends ?prefix= only when a prefix is given, and a legal prefix that matches nothing yields [], not an error', async () => {
  const stub = stubFetch((url) =>
    jsonResponse({ objects: new URL(url).searchParams.get('prefix') === 'zzz' ? [] : [ENTRY] }),
  );

  const all = await listObjects(TARGET);
  const unfiltered = must(stub.calls[0], 'the unfiltered listing call');
  expect(unfiltered.url).toBe('https://store.example/stores/files/objects');
  expect(new URL(unfiltered.url).search).toBe('');
  expect(all).toHaveLength(1);

  await listObjects(TARGET, 'notes');
  const filtered = must(stub.calls[1], 'the filtered listing call');
  expect(filtered.url).toBe('https://store.example/stores/files/objects?prefix=notes');

  const matchedNothing = await listObjects(TARGET, 'zzz');
  expect(matchedNothing).toEqual([]);
});

it('getObject refuses a response missing a valid x-serverstore-sha256, and refuses zero bytes', async () => {
  const cases: { label: string; response: Response }[] = [
    { label: 'no digest header at all', response: new Response(new Uint8Array([1, 2, 3])) },
    {
      label: 'uppercase hex is not the contract’s lowercase digest',
      response: new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'x-serverstore-sha256': SHA.toUpperCase() },
      }),
    },
    {
      label: '63 hex characters is not a sha256',
      response: new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'x-serverstore-sha256': SHA.slice(0, 63) },
      }),
    },
    {
      label: 'non-hex characters',
      response: new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'x-serverstore-sha256': 'z'.repeat(64) },
      }),
    },
    {
      label: 'a valid digest over ZERO bytes',
      response: new Response(new Uint8Array(0), { headers: { 'x-serverstore-sha256': SHA } }),
    },
  ];
  for (const { label, response } of cases) {
    stubFetch(() => response);
    const error = await rejection(() => getObject(TARGET, 'notes.txt'));
    expect(error.code, label).toBe('invalid-response');
    expect(error.serverMessage, label).toBeNull();
  }

  // The honest read: real bytes AND the service's own digest.
  stubFetch(() => objectBytesResponse(new Uint8Array([9, 8, 7])));
  const object = await getObject(TARGET, 'notes.txt');
  expect([...object.bytes]).toEqual([9, 8, 7]);
  expect(object.sha256).toBe(SHA);
  expect(object.contentType).toBe('application/octet-stream');
});

it('putObject refuses a zero-byte payload WITHOUT issuing a request', async () => {
  const stub = stubFetch(() => jsonResponse(PUT_RESULT, 201));
  const error = await rejection(() => putObject(TARGET, 'empty.txt', new Uint8Array(0)));
  expect(error).toBeInstanceOf(ServerStoreError);
  expect(error.code).toBe('invalid_body');
  // The whole point: nothing was sent, so no round trip and no `400` surprise.
  expect(stub.mock).not.toHaveBeenCalled();
  expect(stub.calls).toHaveLength(0);
});

it('putObject sends the exact bytes and returns the service-verified result', async () => {
  const stub = stubFetch(() => jsonResponse(PUT_RESULT, 201));
  const bytes = new Uint8Array([1, 2, 3]);
  const result = await putObject(TARGET, 'notes.txt', bytes);
  expect(result).toEqual(PUT_RESULT);
  const call = must(stub.calls[0], 'the PUT call');
  expect(call.method).toBe('PUT');
  expect(call.url).toBe('https://store.example/stores/files/objects/notes.txt');
  expect(call.body).toBe(bytes);
});

it('a JSON body that does not match the schema yields a typed invalid-response, never empty data', async () => {
  const cases: { label: string; respond: () => Response; run: () => Promise<unknown> }[] = [
    {
      label: 'a listing entry with no sha256/size/createdAt',
      respond: () => jsonResponse({ objects: [{ name: 'notes.txt' }] }),
      run: () => listObjects(TARGET),
    },
    {
      label: 'objects is not an array',
      respond: () => jsonResponse({ objects: 'nope' }),
      run: () => listObjects(TARGET),
    },
    {
      label: 'a non-JSON body from a proxy',
      respond: () => new Response('<html>proxy error</html>', { status: 200 }),
      run: () => listObjects(TARGET),
    },
    {
      label: 'a whoami body with no stores/perms',
      respond: () => jsonResponse({ id: 'key-1' }),
      run: () => whoami(TARGET),
    },
  ];
  for (const { label, respond, run } of cases) {
    stubFetch(respond);
    // `rejection` THROWS if the call resolved — resolving to `[]` here would be
    // exactly the silent "empty data" fallback rule 3 forbids.
    const error = await rejection(run);
    expect(error.code, label).toBe('invalid-response');
    expect(error.serverMessage, label).toBeNull();
  }
});

it('a URL-level failure becomes a transport error naming the endpoint and never the key', async () => {
  stubFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  const error = await rejection(() => listObjects(TARGET));
  expect(error.code).toBe('transport');
  expect(error.status).toBeNull();
  expect(error.serverMessage).toBeNull();
  expect(error.message).toContain('https://store.example');
  expect(error.message).not.toContain(KEY);
});

/** The Error a real `fetch` rejects with when its signal aborts: the client
 * aborts with a `DOMException` (a `TimeoutError` for the headers timeout), and
 * `DOMException` is not an `Error` subclass in every environment — so its
 * message is lifted out explicitly rather than rejected as a non-Error. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    const message: unknown = (reason as { message?: unknown }).message;
    if (typeof message === 'string') return new Error(message);
  }
  return new Error('The request was aborted.');
}

it('aborts a request whose response headers never arrive, at the 60s headers timeout', async () => {
  expect(HEADERS_TIMEOUT_MS).toBe(60_000);
  vi.useFakeTimers();
  try {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (signal === undefined || signal === null) return;
          signal.addEventListener('abort', () => {
            reject(abortError(signal));
          });
        }),
    );
    const pending = listObjects(TARGET).then(
      () => {
        throw new Error('Expected the request to abort, but it resolved.');
      },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(HEADERS_TIMEOUT_MS);
    const error = await pending;
    expect(error).toBeInstanceOf(ServerStoreError);
    expect((error as ServerStoreError).code).toBe('transport');
    expect((error as ServerStoreError).message).toContain('timed out');
  } finally {
    vi.useRealTimers();
  }
});

it('plumbs the caller’s AbortSignal into the request', async () => {
  const controller = new AbortController();
  const stub = stubFetch((_url, init) =>
    init.signal?.aborted === true
      ? Promise.reject(new Error('The operation was aborted.'))
      : jsonResponse({ objects: [] }),
  );
  controller.abort();
  const error = await rejection(() => listObjects(TARGET, undefined, controller.signal));
  expect(error.code).toBe('transport');
  expect(stub.calls).toHaveLength(1);
  expect(must(stub.calls[0], 'the aborted call').signal?.aborted).toBe(true);
});

it('objectEntrySchema accepts exactly the documented listing row and rejects anything else', () => {
  expect(objectEntrySchema.safeParse(ENTRY).success).toBe(true);
  expect(objectEntrySchema.safeParse({ ...ENTRY, sha256: 'nope' }).success).toBe(false);
  expect(objectEntrySchema.safeParse({ ...ENTRY, size: -1 }).success).toBe(false);
  // An extra key is not a documented field: this seam's entries are strict.
  expect(objectEntrySchema.safeParse({ ...ENTRY, extra: 1 }).success).toBe(false);
});

it('the documented defaults are the deployed origin and the `files` store', () => {
  expect(DEFAULT_BASE_URL).toBe('https://store.futuremagic.de');
  expect(DEFAULT_STORE_NAME).toBe('files');
});
