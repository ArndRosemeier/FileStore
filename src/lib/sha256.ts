/**
 * THE digest seam (ledger row 9): lowercase-hex SHA-256 of bytes, in ONE place.
 *
 * WHY IT EXISTS AT ALL: ServerStore answers an object read with an
 * `x-serverstore-sha256` header — the service's OWN digest of the bytes it
 * stores (`~/projects/ServerStore/docs/API.md`). The client seam
 * (`src/server/store-client.ts#getObject`) guarantees the header is present and
 * well-formed; it cannot know whether the BYTES that arrived are the bytes that
 * header describes. So the retrieval flow hashes what it received with THIS
 * function and refuses to put anything on disk when the two disagree. There is
 * no second reason to hash, and therefore no second home for the algorithm.
 *
 * `crypto.subtle` is asynchronous and returns an `ArrayBuffer`; the hex encoding
 * is done by hand, in lowercase, by a fixed-width byte conversion — never
 * `toString(16)` on the buffer, and never a locale-aware formatter.
 */

/**
 * The digest of `bytes`, as 64 lowercase hex characters. The parameter is
 * `Uint8Array<ArrayBuffer>` (not the wider `ArrayBufferLike`): `crypto.subtle`
 * accepts nothing backed by a `SharedArrayBuffer`, and every byte array this app
 * has — a picked file's, an object read's — is an `ArrayBuffer` view.
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
