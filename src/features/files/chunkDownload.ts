/**
 * Retrieving a CHUNKED file (ledger row 12, slice B): read the manifest, prove it
 * is the one the listing described, then stream the parts to the ONE save seam —
 * verifying EVERY part against the service's own `x-serverstore-sha256` AND
 * against the size and hash the manifest records.
 *
 * WHY THE MANIFEST IS READ BEFORE ANY PART, AND INSIDE `buildParts`: the manifest
 * is what says which objects the file IS. A part fetched from a stale listing
 * would be bytes from an older generation, and the manifest is the only thing that
 * can tell the two apart. So the manifest is read and verified first, and a part
 * is fetched only once it has. It lives inside `buildParts` (not before
 * `saveFileStreaming`) because `showSaveFilePicker` needs TRANSIENT USER
 * ACTIVATION: the picker must run in the click handler's own task, before a
 * fetch that can outlive it (`src/lib/saveFile.ts`'s header). A cancelled dialog
 * therefore costs no manifest read and no part fetch.
 *
 * THE STREAM NEVER MATERIALISES THE FILE. {@link saveFileStreaming} writes each
 * `Blob` as it arrives (or accumulates Blobs for the anchor, where the browser
 * decides whether they spill to disk), so peak memory is ONE part — pinned by the
 * order the parts are fetched in relative to the writes.
 *
 * A MISMATCH REFUSES THE SAVE. Every failure here is a `ServerStoreError`
 * (`invalid-response`) naming the object and both digests, so it travels the app's
 * ONE error surface; with the picker, `saveFileStreaming` aborts the writable
 * (`src/lib/saveFile.ts`), and on the anchor branch nothing is anchored at all —
 * unverified bytes are never written.
 *
 * THERE IS NO WHOLE-FILE DIGEST, and this module must not pretend there is: the
 * manifest records per-part sizes and hashes because WebCrypto has no incremental
 * digest (ledger row 12), so what is proven is that each part is the part the
 * manifest describes — not that the manifest is what the owner uploaded.
 */

import { parseManifest, type ChunkManifest } from '@/lib/chunk';
import { OBJECT_MIME_TYPE } from '@/features/files/download';
import type { ChunkFileRow } from '@/features/files/chunks';
import { saveFileStreaming, type SaveOutcome } from '@/lib/saveFile';
import { sha256Hex } from '@/lib/sha256';
import { getObject, type StoreTarget } from '@/server/store-client';
import { ServerStoreError } from '@/server/store-errors';

/** How a chunked download is getting on. Reported per verified part. */
export interface ChunkDownloadProgress {
  objectName: string;
  /** Parts fetched and verified so far. */
  completed: number;
  /** Parts in total. */
  total: number;
  /** The part this report is about. */
  partName: string;
}

export interface ChunkDownloadOptions {
  onProgress?: (progress: ChunkDownloadProgress) => void;
  signal?: AbortSignal;
}

/** The refusal for a part or manifest that is not what the store said it was. */
function mismatch(what: string, problem: string): ServerStoreError {
  return new ServerStoreError(
    'invalid-response',
    `Refusing to save ${what}: ${problem}. Nothing was written to disk.`,
  );
}

/**
 * The manifest of `row`, verified: its bytes against the service's own
 * `x-serverstore-sha256`, THEN against the listing entry the row was rendered
 * from, and then parsed. A manifest that is not the object the listing described
 * means the listing is stale — and a stale listing is refused rather than
 * followed, because the parts it implies may not be the file's any more.
 */
export async function verifiedChunkManifest(
  target: StoreTarget,
  row: ChunkFileRow,
  signal?: AbortSignal,
): Promise<ChunkManifest> {
  const object = await getObject(target, row.manifestName, signal);
  const received = await sha256Hex(object.bytes);
  if (received !== object.sha256) {
    throw mismatch(
      row.manifestName,
      `the bytes that arrived hash to ${received}, but ServerStore's x-serverstore-sha256 says ${object.sha256}`,
    );
  }
  if (
    object.sha256 !== row.manifestEntry.sha256 ||
    object.bytes.length !== row.manifestEntry.size
  ) {
    throw mismatch(
      row.manifestName,
      `the listing described it as ${String(row.manifestEntry.size)} bytes with digest ` +
        `${row.manifestEntry.sha256}, but the stored object is ${String(object.bytes.length)} bytes ` +
        `with digest ${object.sha256} — the listing is stale, so refresh before downloading`,
    );
  }
  // `parseManifest` THROWS loudly on bytes that are not a manifest this app
  // writes (ledger row 12); it is never defaulted to an empty part list.
  const manifest = parseManifest(object.bytes);
  if (manifest.objectName !== row.objectName) {
    throw mismatch(
      row.manifestName,
      `it describes the object ${JSON.stringify(manifest.objectName)}, but the listing said ` +
        JSON.stringify(row.objectName),
    );
  }
  return manifest;
}

/**
 * The file's parts, in order, as `Blob`s — fetched ONE at a time and verified
 * against the manifest's recorded size and hash AND the service's own header
 * before the part is yielded. A part that does not match stops the stream, and
 * `saveFileStreaming` is left to abort what it has written.
 */
export async function* verifiedChunkPartBlobs(
  target: StoreTarget,
  objectName: string,
  manifest: ChunkManifest,
  options: ChunkDownloadOptions = {},
): AsyncGenerator<Blob> {
  for (const record of manifest.parts) {
    const object = await getObject(target, record.name, options.signal);
    if (object.bytes.length !== record.size) {
      throw mismatch(
        record.name,
        `it is ${String(object.bytes.length)} bytes, but the manifest records ${String(record.size)}`,
      );
    }
    const received = await sha256Hex(object.bytes);
    if (received !== object.sha256) {
      throw mismatch(
        record.name,
        `the bytes that arrived hash to ${received}, but ServerStore's x-serverstore-sha256 says ${object.sha256}`,
      );
    }
    if (received !== record.sha256) {
      throw mismatch(
        record.name,
        `the bytes that arrived hash to ${received}, but the manifest records ${record.sha256}`,
      );
    }
    options.onProgress?.({
      objectName,
      completed: record.index + 1,
      total: manifest.parts.length,
      partName: record.name,
    });
    yield new Blob([object.bytes], { type: OBJECT_MIME_TYPE });
  }
}

/**
 * Save a chunked file through the ONE save seam: the picker runs first, then the
 * manifest is read and verified, then every part is fetched, verified and written
 * as it arrives. A cancelled dialog is an OUTCOME; a real failure (including every
 * mismatch above) THROWS.
 */
export async function downloadChunkedObject(
  target: StoreTarget,
  row: ChunkFileRow,
  options: ChunkDownloadOptions = {},
): Promise<SaveOutcome> {
  return saveFileStreaming({
    fileName: row.objectName,
    mimeType: OBJECT_MIME_TYPE,
    buildParts: async function* buildParts(): AsyncGenerator<Blob> {
      const manifest = await verifiedChunkManifest(target, row, options.signal);
      yield* verifiedChunkPartBlobs(target, row.objectName, manifest, options);
    },
  });
}
