/**
 * The ONE chunk fixture set (ledger row 12 slice B).
 *
 * It builds manifests with the REAL frozen codec (`buildManifest` /
 * `encodeManifest` / `chunkPartName`) over a few BYTES per part, so a pin never
 * builds a 64 MiB buffer: the chunked path is driven with `chunkPartSize` a few
 * bytes wide (see `FileBrowserProps.chunkPartSize`), and the bytes under test are
 * the real ones the store would return.
 *
 * The helper is a plain module, not a test file: vitest collects only
 * `*.test.ts(x)`, so nothing here runs on its own.
 */

import { buildManifest, chunkManifestName, chunkPartName, encodeManifest } from '@/lib/chunk';
import { sha256Hex } from '@/lib/sha256';
import type { ObjectEntry, ObjectBytes, StoreTarget } from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';

export const FIXTURE_STORE = 'files';
export const FIXTURE_CREATED_AT = '2026-09-28T14:27:54.773Z';

export const TARGET: StoreTarget = {
  baseUrl: 'https://store.futuremagic.de',
  store: FIXTURE_STORE,
  key: 'ssk_TESTKEY_not_a_real_credential',
};

/** One object a mocked store holds: its bytes and the digest the service reports. */
export interface StoredObject {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
}

/** One listing row, with the digest defaulting to a plausible value. */
export function entry(name: string, size: number, sha256 = 'a'.repeat(64)): ObjectEntry {
  return { store: FIXTURE_STORE, name, sha256, size, createdAt: FIXTURE_CREATED_AT };
}

/** A complete chunked file: the manifest, its parts, and the listing rows for both. */
export interface ChunkFixture {
  objectName: string;
  manifestName: string;
  generation: string;
  partNames: string[];
  /** Every object the store holds for this file, by name. */
  objects: Map<string, StoredObject>;
  /** The listing rows a COMPLETE file produces. */
  entries: ObjectEntry[];
  totalSize: number;
  /** The content of one part, by index. */
  partBytes: Uint8Array<ArrayBuffer>[];
}

/**
 * Build a chunked file whose parts are the given byte arrays. Every part except
 * the last must be the same length — that is the layout the manifest validates.
 */
export async function chunkFixture(
  objectName: string,
  partBytes: readonly (readonly number[])[],
  generation = 'aaaa1111',
): Promise<ChunkFixture> {
  const first = partBytes[0];
  if (first === undefined) throw new Error('a chunk fixture needs at least one part');
  const partSize = first.length;

  const objects = new Map<string, StoredObject>();
  const records: { name: string; index: number; size: number; sha256: string }[] = [];
  const parts: Uint8Array<ArrayBuffer>[] = [];
  partBytes.forEach((raw, index) => {
    const bytes = new Uint8Array(raw);
    const name = chunkPartName(objectName, generation, index);
    records.push({ name, index, size: bytes.length, sha256: '' });
    parts.push(bytes);
  });

  // The digests are real (`crypto.subtle`), so a verification pin fails for the
  // right reason.
  for (const record of records) {
    const bytes = parts[record.index];
    if (bytes === undefined) throw new Error('a part lost its bytes');
    record.sha256 = await sha256Hex(bytes);
    objects.set(record.name, { bytes, sha256: record.sha256 });
  }

  const totalSize = parts.reduce((total, bytes) => total + bytes.length, 0);
  const manifest = buildManifest({ objectName, generation, totalSize, partSize, parts: records });
  const manifestBytes = encodeManifest(manifest);
  const manifestName = chunkManifestName(objectName);
  const manifestSha = await sha256Hex(manifestBytes);
  objects.set(manifestName, { bytes: manifestBytes, sha256: manifestSha });

  const entries: ObjectEntry[] = [
    entry(manifestName, manifestBytes.length, manifestSha),
    ...records.map((record) => entry(record.name, record.size, record.sha256)),
  ];

  return {
    objectName,
    manifestName,
    generation,
    partNames: records.map((record) => record.name),
    objects,
    entries,
    totalSize,
    partBytes: parts,
  };
}

/** A `getObject` implementation over a set of objects; an absent name is `not_found`. */
export function readerFor(
  objects: ReadonlyMap<string, StoredObject>,
): (target: StoreTarget, name: string) => Promise<ObjectBytes> {
  return (_target, name) => {
    const found = objects.get(name);
    if (found === undefined) {
      throw new ServerStoreError('not_found', `no such object: ${name}`, {
        status: 404,
        serverMessage: 'no such object',
      });
    }
    return Promise.resolve({
      bytes: found.bytes,
      sha256: found.sha256,
      contentType: 'application/octet-stream',
    });
  };
}

/** An object whose bytes are NOT a chunk manifest: a real file with a chunk-shaped name. */
export async function plainObject(bytes: readonly number[]): Promise<StoredObject> {
  const array = new Uint8Array(bytes);
  return { bytes: array, sha256: await sha256Hex(array) };
}
