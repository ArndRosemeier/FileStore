/**
 * ServerStore's failure vocabulary — the ONE typed error this app branches on.
 *
 * PORTED from `~/projects/Imager/src/server/store-errors.ts` (ledger row 5;
 * Imager is READ-ONLY and was not touched). What changed here, and why:
 *
 *  * **`conflict` was ADDED to the service's code list.** Imager's copy omits
 *    it even though the service's own contract documents `conflict` (HTTP
 *    `409`) — the code `DELETE /stores/{store}` answers while a key's scope
 *    names the store, and the last-live-admin-key refusal. In that copy a real
 *    `409 conflict` fell through to `invalid-response`, i.e. a genuine service
 *    refusal was reported as a parse failure. The pin "a `409` carries
 *    `conflict`" cannot hold without the member.
 *  * **Imager's `kind` (`'api' | 'transport' | 'invalid-response'`) is GONE.**
 *    This app branches on ONE field: `code`. A service envelope yields the
 *    service's own code; a URL-level failure yields `transport`; a body the app
 *    cannot understand yields `invalid-response`. A second parallel
 *    discriminant is a second rule for the same question (rule 4).
 *  * **The service's human message is kept verbatim in `serverMessage`.** The
 *    contract says `code` is stable and `message` "may change" and is for
 *    humans, so the seam stores the service's own words instead of folding them
 *    into a string the UI would have to un-parse. `Error.message` is this app's
 *    diagnostic: it names the code and the endpoint, never the key.
 *
 * THE KEY IS NEVER IN ANY OF THIS. Every message below names CODES and
 * ENDPOINTS only (AGENTS.md §The credential rule 3).
 */

/**
 * Every `code` the service documents in `~/projects/ServerStore/docs/API.md`
 * §Errors, in the doc's order. These are the service's words: branch on them.
 */
export const SERVER_STORE_API_CODES = [
  'bad_request',
  'invalid_name',
  'invalid_body',
  'invalid_scope',
  'payload_too_large',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'store_exists',
  'name_taken',
  'conflict',
  'unsupported_store_kind',
  'internal',
] as const;
export type ServerStoreApiCode = (typeof SERVER_STORE_API_CODES)[number];

/**
 * The two failures that have NO service envelope, because no valid response
 * exists to carry one:
 *  * `transport` — the request never produced a response (offline, DNS, CORS,
 *    an aborted signal, the headers timeout).
 *  * `invalid-response` — a response arrived but is not what the contract says
 *    (a non-JSON body, a body that fails zod, a missing integrity header).
 */
export const CLIENT_ERROR_CODES = ['transport', 'invalid-response'] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/** Everything `.code` can be: the service's vocabulary plus the app's two. */
export const SERVER_STORE_ERROR_CODES = [
  ...SERVER_STORE_API_CODES,
  ...CLIENT_ERROR_CODES,
] as const;
export type ServerStoreErrorCode = ServerStoreApiCode | ClientErrorCode;

const API_CODE_SET: ReadonlySet<string> = new Set<string>(SERVER_STORE_API_CODES);

export class ServerStoreError extends Error {
  /** The branchable discriminant. Never a guess, never a fallback. */
  readonly code: ServerStoreErrorCode;
  /** The HTTP status when there was a response, else `null`. */
  readonly status: number | null;
  /**
   * The service's own `message`, verbatim, for an envelope that parsed; else
   * `null`. The UI may show this to a human (the contract says it may change —
   * so it is shown, never branched on).
   */
  readonly serverMessage: string | null;
  /**
   * A `429`'s `Retry-After` in whole seconds (>= 0), when the service sent a
   * readable one; else `null`. CORS-exposed, so a browser can actually read it.
   */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: ServerStoreErrorCode,
    message: string,
    options: {
      status?: number | null;
      serverMessage?: string | null;
      retryAfterSeconds?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ServerStoreError';
    this.code = code;
    this.status = options.status ?? null;
    this.serverMessage = options.serverMessage ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** A `401`/`403` in one place: the key is missing, unknown, expired or scoped
 * elsewhere. The UI shows what happened verbatim rather than inventing a cause. */
export function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof ServerStoreError && (error.code === 'unauthorized' || error.code === 'forbidden')
  );
}

/**
 * The service's `Retry-After` on a `429`, in whole seconds, or `null` when the
 * header is absent or not a number. The service sends whole seconds `>= 1`; a
 * `0` is accepted as the honest value it is rather than rounded up to a lie.
 */
export function retryAfterSecondsFrom(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/**
 * The documented envelope, narrowed from an unknown body. `null` when the body
 * is not the envelope AT ALL, or when its `code` is not in the documented
 * vocabulary — a code this app does not know must not be silently relabelled,
 * so it becomes a loud `invalid-response` naming the raw answer instead.
 */
export function envelopeFromBody(
  body: unknown,
): { code: ServerStoreApiCode; message: string } | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error: unknown = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown; message?: unknown };
  if (typeof record.code !== 'string' || !API_CODE_SET.has(record.code)) return null;
  const code = SERVER_STORE_API_CODES.find((entry) => entry === record.code);
  if (code === undefined) return null;
  return {
    code,
    // A missing or non-string message falls back to the CODE — never to an
    // empty string pretending the service said nothing.
    message: typeof record.message === 'string' ? record.message : code,
  };
}

/**
 * The error for a non-OK HTTP response: the envelope's code and message when it
 * parses, otherwise an honest `invalid-response` naming the status and a body
 * snippet — a server that answers an HTML proxy error page must not be reported
 * as an API refusal it never sent (rule 1).
 */
export function errorFromResponse(response: Response, bodyText: string): ServerStoreError {
  const status = response.status;
  const retryAfterSeconds = status === 429 ? retryAfterSecondsFrom(response) : null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    body = undefined;
  }
  const envelope = envelopeFromBody(body);
  if (envelope !== null) {
    return new ServerStoreError(
      envelope.code,
      `ServerStore refused (${envelope.code}): ${envelope.message}`,
      { status, serverMessage: envelope.message, retryAfterSeconds },
    );
  }
  const snippet = bodyText.length > 200 ? `${bodyText.slice(0, 200)}…` : bodyText;
  return new ServerStoreError(
    'invalid-response',
    `ServerStore answered HTTP ${String(status)} without its error envelope: ${snippet === '' ? '(empty body)' : snippet}`,
    { status, retryAfterSeconds },
  );
}
