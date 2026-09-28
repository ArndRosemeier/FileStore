/**
 * The upload's SHAPE (ledger row 12, slice B): one request for a file that fits
 * the service's cap, a chunked write for one that does not.
 *
 * THE DECISION IS THE SIZE ALONE, and it is decided HERE, once, so no call site
 * can get it wrong:
 *
 *  * `<= partSize` → the row-9 single-object path. `PUT` is an unconditional
 *    overwrite and one request is atomic, so anything that fits stays exactly as
 *    it was — pinned, and deliberately NOT routed through this module's chunk
 *    machinery.
 *  * `> partSize` → `planChunks` for the layout and `writeChunkedObject` for the
 *    order. The frozen seam owns the WRITE ORDER (every part first, the manifest
 *    LAST), so the file does not exist until its last request has succeeded; an
 *    interrupted write leaves orphan parts and NO visible file.
 *
 * WHERE THE BYTES COME FROM IS AN INJECTED {@link ChunkSource}, not a byte array.
 * `src/lib/openFile.ts` hands the app one `Uint8Array` per picked file (it reads
 * the file whole, and `src/lib/**` is frozen for this slice), so the production
 * caller passes {@link bytesChunkSource} — a ZERO-COPY `subarray` view per part.
 * {@link fileChunkSource} is the same seam over a `File`/`Blob`, reading one part
 * at a time with `slice()`, and it is what the seam is shaped for: the day the
 * open seam can hand a `File` over (instead of reading it whole), the only change
 * is which source the caller constructs. That gap is named in
 * `docs/ARCHITECTURE.md` §4 rather than papered over.
 *
 * THE PART SIZE IS AN ASSUMPTION ABOUT SERVER CONFIG, so it is a parameter with
 * the service's own default ({@link CHUNK_PART_SIZE}). The frozen `planChunks`
 * hard-codes that default, and the pins must exercise the whole chunked path on a
 * few bytes rather than a real 64 MiB buffer, so {@link planUploadChunks} takes
 * the size and mirrors the layout when it is NOT the service's own — guarded by a
 * pin that the two agree at the default.
 *
 * A 413 ON A PART IS NEVER RETRIED AND NEVER SPLIT SMALLER. `writeChunkedObject`
 * raises {@link ChunkPartTooLargeError} naming the part; this module adds nothing
 * — a retry can double-upload and a smaller part would hide that the assumption
 * moved.
 *
 * PROGRESS IS PER PART, reported as each part is STORED (plus one `completed: 0`
 * report before the first request), so a 2 GB file's 33 sequential requests show
 * the owner where they are instead of a spinner that lies.
 */

import {
  CHUNK_MAX_PARTS,
  CHUNK_PART_SIZE,
  ChunkError,
  chunkManifestName,
  chunkPartName,
  planChunks,
  writeChunkedObject,
  type ChunkPart,
  type ChunkPlan,
  type ChunkWriter,
} from '@/lib/chunk';
import type { UploadReview } from '@/features/files/upload';
import { putObject, type StoreTarget } from '@/server/store-client';

/** Where a chunked upload's bytes come from, ONE part at a time. */
export interface ChunkSource {
  /** The file's total size in bytes — what the plan is laid out from. */
  size: number;
  /** The bytes of `[start, end)`. Never called for the whole file at once. */
  read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>>;
}

/** The source over bytes the caller already holds: each part is a VIEW, not a copy. */
export function bytesChunkSource(bytes: Uint8Array<ArrayBuffer>): ChunkSource {
  return {
    size: bytes.length,
    read: (start, end) => Promise.resolve(bytes.subarray(start, end)),
  };
}

/**
 * The source over a `File`/`Blob`: `slice()` reads ONE part, and the browser
 * never holds the whole file for this seam. This is the shape the production
 * caller wants; see the header for why it cannot be used yet.
 */
export function fileChunkSource(file: Blob): ChunkSource {
  return {
    size: file.size,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
  };
}

/** Which write a file of this size takes. */
export type UploadShape = 'single' | 'chunked';

/**
 * A file AT the part size is one part and takes the single-object path; one byte
 * more is chunked. `partSize` defaults to the service's own cap.
 */
export function uploadShapeFor(size: number, partSize: number = CHUNK_PART_SIZE): UploadShape {
  assertPartSize(partSize);
  return size <= partSize ? 'single' : 'chunked';
}

function assertPartSize(partSize: number): void {
  if (!Number.isSafeInteger(partSize) || partSize < 1) {
    throw new ChunkError(
      `Cannot plan a chunked upload: the part size ${String(partSize)} is not a positive safe integer.`,
    );
  }
}

/**
 * The plan for an upload, laid out by the frozen seam at the service's part size
 * and by the same arithmetic at any other size.
 *
 * The override exists because `planChunks` hard-codes {@link CHUNK_PART_SIZE} and
 * the pins must drive this path with a few bytes; a pin holds the two planners
 * EQUAL at the default, so the duplicate arithmetic cannot drift unnoticed.
 */
export function planUploadChunks(
  objectName: string,
  totalSize: number,
  generation: string,
  partSize: number = CHUNK_PART_SIZE,
): ChunkPlan {
  assertPartSize(partSize);
  if (partSize === CHUNK_PART_SIZE) return planChunks(objectName, totalSize, generation);
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new ChunkError(
      `Cannot plan a chunked write for ${JSON.stringify(objectName)}: the total size ` +
        `${String(totalSize)} is not a non-negative safe integer.`,
    );
  }
  const manifestName = chunkManifestName(objectName);
  const partCount = Math.ceil(totalSize / partSize);
  if (partCount > CHUNK_MAX_PARTS) {
    throw new ChunkError(
      `Cannot plan a chunked write for ${JSON.stringify(objectName)}: ${String(partCount)} parts ` +
        `exceeds the ${String(CHUNK_MAX_PARTS)} an index of the convention's width can address.`,
    );
  }
  const parts: ChunkPart[] = [];
  for (let index = 0; index < partCount; index += 1) {
    const start = index * partSize;
    parts.push({
      name: chunkPartName(objectName, generation, index),
      index,
      start,
      end: Math.min(totalSize, start + partSize),
    });
  }
  return { objectName, manifestName, generation, partSize, totalSize, parts };
}

/** How a chunked upload is getting on. Reported per part. */
export interface ChunkUploadProgress {
  /** The name on the owner's disk, so a multi-file batch says which one is running. */
  fileName: string;
  /** The logical store name it is being written as. */
  objectName: string;
  /** Parts STORED so far (`0` before the first request completes). */
  completed: number;
  /** Parts in total. */
  total: number;
  /** The part this report is about. */
  partName: string;
}

/** How a fresh generation is drawn; injectable so a pin can be deterministic. */
export type GenerationDraw = () => string;

/** Twelve lowercase hex characters, inside the generation pattern's 1–32. */
export function randomChunkGeneration(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A generation that is NEVER the previous one. Parts are immutable and the
 * manifest is the only object an overwrite touches, so reusing a generation would
 * overwrite the parts a live file is still being read from (ledger row 12).
 * THROWS rather than returning a generation equal to the previous one: a silent
 * reuse is exactly the corruption this rule exists to prevent.
 */
export function nextChunkGeneration(
  previous: string | null,
  draw: GenerationDraw = randomChunkGeneration,
): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = draw();
    if (candidate !== previous) return candidate;
  }
  throw new ChunkError(
    `Could not draw a new chunk generation different from ${JSON.stringify(previous)} ` +
      `in 16 attempts; refusing to overwrite the parts of the live file.`,
  );
}

/** What a finished chunked upload wrote. */
export interface ChunkedUploadResult {
  objectName: string;
  manifestName: string;
  generation: string;
  /** Every object the write created, in the order it was sent: the parts, then the manifest. */
  written: string[];
}

export interface ChunkedUploadOptions {
  /** The part size; defaults to the service's own cap (see {@link planUploadChunks}). */
  partSize?: number;
  /** The generation of the version being replaced, when there is one. */
  previousGeneration?: string | null;
  /** Where the bytes come from; defaults to the reviewed bytes. */
  source?: ChunkSource;
  /** Called before the first request and after EVERY stored part. */
  onProgress?: (progress: ChunkUploadProgress) => void;
  /** How a generation is drawn; defaults to {@link randomChunkGeneration}. */
  drawGeneration?: GenerationDraw;
  signal?: AbortSignal;
}

/**
 * Write one reviewed file as a chunked object: every part, then the manifest.
 *
 * The bytes never all live in a `Blob`: one part is read, sent, and dropped before
 * the next is read, and the manifest is built from what the SERVICE reported it
 * stored (its own `sha256` and size — `writeChunkedObject` does that), so the
 * manifest cannot describe bytes that are not there.
 *
 * A `413` on a part arrives as a loud {@link ChunkPartTooLargeError} naming the
 * part; nothing here retries and nothing here re-splits.
 */
export async function uploadChunkedReview(
  target: StoreTarget,
  review: UploadReview,
  options: ChunkedUploadOptions = {},
): Promise<ChunkedUploadResult> {
  const partSize = options.partSize ?? CHUNK_PART_SIZE;
  const source = options.source ?? bytesChunkSource(review.bytes);
  const generation = nextChunkGeneration(
    options.previousGeneration ?? null,
    options.drawGeneration,
  );
  const plan = planUploadChunks(review.objectName, source.size, generation, partSize);

  const writer: ChunkWriter = {
    async writePart(part, bytes) {
      const stored = await putObject(target, part.name, bytes, options.signal);
      options.onProgress?.({
        fileName: review.fileName,
        objectName: review.objectName,
        completed: part.index + 1,
        total: plan.parts.length,
        partName: part.name,
      });
      return { sha256: stored.sha256, size: stored.size };
    },
    async writeManifest(name, bytes) {
      await putObject(target, name, bytes, options.signal);
    },
  };

  options.onProgress?.({
    fileName: review.fileName,
    objectName: review.objectName,
    completed: 0,
    total: plan.parts.length,
    partName: plan.parts[0]?.name ?? plan.manifestName,
  });

  await writeChunkedObject(plan, writer, (part) => source.read(part.start, part.end));

  return {
    objectName: review.objectName,
    manifestName: plan.manifestName,
    generation,
    written: [...plan.parts.map((part) => part.name), plan.manifestName],
  };
}
