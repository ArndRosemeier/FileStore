/**
 * Pins for `src/server/store-errors.ts` — the service's `{error:{code,message}}`
 * envelope becomes ONE typed error.
 *
 * The statement each test's name carries is the deliverable: a red here must say
 * what it protected. The differential that watched these go red is recorded in
 * `docs/TESTING.md` (row 7).
 */
import { expect, it } from 'vitest';

import {
  CLIENT_ERROR_CODES,
  SERVER_STORE_API_CODES,
  SERVER_STORE_ERROR_CODES,
  ServerStoreError,
  envelopeFromBody,
  errorFromResponse,
  isAuthFailure,
  retryAfterSecondsFrom,
} from '@/server/store-errors';

function envelopeResponse(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

it('carries the service’s own code and message verbatim from the envelope', () => {
  const error = errorFromResponse(
    envelopeResponse('not_found', 'no object "notes.txt" in store "files"', 404),
    JSON.stringify({ error: { code: 'not_found', message: 'no object "notes.txt" in store "files"' } }),
  );
  expect(error).toBeInstanceOf(ServerStoreError);
  expect(error.name).toBe('ServerStoreError');
  expect(error.code).toBe('not_found');
  expect(error.status).toBe(404);
  expect(error.serverMessage).toBe('no object "notes.txt" in store "files"');
  expect(error.message).toContain('not_found');
  expect(error.message).toContain('no object "notes.txt" in store "files"');
});

it('the vocabulary holds every code the contract documents, `conflict` included', () => {
  // The contract (`~/projects/ServerStore/docs/API.md` §Errors) documents all of
  // these; Imager's ported copy was MISSING `conflict`, so a real 409 was
  // reported there as `invalid-response`. A red here means the port regressed.
  expect([...SERVER_STORE_API_CODES]).toEqual([
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
  ]);
  expect([...CLIENT_ERROR_CODES]).toEqual(['transport', 'invalid-response']);
  for (const code of [...SERVER_STORE_API_CODES, ...CLIENT_ERROR_CODES]) {
    expect(SERVER_STORE_ERROR_CODES).toContain(code);
  }
});

it('a non-OK response WITHOUT the documented envelope is an invalid-response, never a fabricated code', () => {
  const html = errorFromResponse(new Response('<html>502 Bad Gateway</html>', { status: 502 }), '<html>502 Bad Gateway</html>');
  expect(html.code).toBe('invalid-response');
  expect(html.status).toBe(502);
  expect(html.serverMessage).toBeNull();
  expect(html.message).toContain('502');

  const empty = errorFromResponse(new Response('', { status: 500 }), '');
  expect(empty.code).toBe('invalid-response');
  expect(empty.status).toBe(500);
  expect(empty.message).toContain('(empty body)');
});

it('an unknown code in a well-formed envelope is refused loudly rather than mapped to a wrong code', () => {
  const error = errorFromResponse(
    envelopeResponse('invented_code', 'the service said this', 418),
    JSON.stringify({ error: { code: 'invented_code', message: 'the service said this' } }),
  );
  expect(error.code).toBe('invalid-response');
  expect(error.serverMessage).toBeNull();
  expect(error.message).toContain('invented_code');
});

it('surfaces a 429’s Retry-After in whole seconds, and nothing when it is absent or unreadable', () => {
  expect(retryAfterSecondsFrom(new Response('', { headers: { 'retry-after': '42' } }))).toBe(42);
  expect(retryAfterSecondsFrom(new Response('', { headers: { 'retry-after': '0' } }))).toBe(0);
  expect(retryAfterSecondsFrom(new Response('', { headers: { 'retry-after': '1.4' } }))).toBe(2);
  expect(retryAfterSecondsFrom(new Response('', { headers: { 'retry-after': 'soon' } }))).toBeNull();
  expect(retryAfterSecondsFrom(new Response(''))).toBeNull();

  const limited = errorFromResponse(
    envelopeResponse('rate_limited', 'too many requests', 429, { 'retry-after': '17' }),
    JSON.stringify({ error: { code: 'rate_limited', message: 'too many requests' } }),
  );
  expect(limited.code).toBe('rate_limited');
  expect(limited.retryAfterSeconds).toBe(17);
});

it('envelopeFromBody ignores anything that is not the documented envelope', () => {
  expect(envelopeFromBody(null)).toBeNull();
  expect(envelopeFromBody([])).toBeNull();
  expect(envelopeFromBody('error')).toBeNull();
  expect(envelopeFromBody({})).toBeNull();
  expect(envelopeFromBody({ error: null })).toBeNull();
  expect(envelopeFromBody({ error: { message: 'no code' } })).toBeNull();
  expect(envelopeFromBody({ error: { code: 42, message: 'not a string' } })).toBeNull();
  // A code with no message is still a real refusal; the code names it.
  expect(envelopeFromBody({ error: { code: 'forbidden' } })).toEqual({
    code: 'forbidden',
    message: 'forbidden',
  });
});

it('isAuthFailure is true only for unauthorized and forbidden', () => {
  expect(isAuthFailure(new ServerStoreError('unauthorized', 'x'))).toBe(true);
  expect(isAuthFailure(new ServerStoreError('forbidden', 'x'))).toBe(true);
  expect(isAuthFailure(new ServerStoreError('not_found', 'x'))).toBe(false);
  expect(isAuthFailure(new ServerStoreError('transport', 'x'))).toBe(false);
  expect(isAuthFailure(new Error('unauthorized'))).toBe(false);
  expect(isAuthFailure(null)).toBe(false);
});

it('a transport error carries no status and no server message — no envelope existed to carry one', () => {
  const error = new ServerStoreError('transport', 'Could not reach ServerStore at https://store.example');
  expect(error.code).toBe('transport');
  expect(error.status).toBeNull();
  expect(error.serverMessage).toBeNull();
  expect(error.retryAfterSeconds).toBeNull();
});
