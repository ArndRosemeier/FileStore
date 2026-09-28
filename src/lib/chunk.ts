/**
 * THE chunking convention (ledger row 12, slice A): the ONE place a file that is
 * too big for one ServerStore request is split, named, described and repaired.
 *
 * WHY THIS EXISTS AT ALL (measured, not preferred). The owner has files in the
 * GB range; the deployed path goes through Cloudflare, whose own 413 doc states a
 * 100 MB maximum upload on Free/Pro, and ServerStore reads the whole body into
 * one `Uint8Array` with the bytes living in its `objects.content` column. So no
 * `SERVERSTORE_MAX_BYTES` value makes a GB file storable; splitting it is the
 * only client-side answer, and the owner chose the part size that is ALREADY in
 * force: {@link CHUNK_PART_SIZE} is exactly the service's 64 MiB default. He
 * wrote: *"Lets just use the 64mb we have now, its ok for the majority of files
 * and the few bigger ones will just have some more chunks, acceptable."*
 *
 * THE LAYOUT, for a file stored as the object `docs--report.pdf`:
 *
 *   manifest  `docs--report.pdf--manifest`
 *   parts     `docs--report.pdf--g<generation>--part-000000`
 *
 * A part sits EXACTLY on the service's cap and IS accepted — ServerStore's
 * `readBodyCapped` refuses only when `total > maxBytes` — so there is NO margin
 * here on purpose.
 *
 * THE GENERATION IS WHAT MAKES AN OVERWRITE SAFE. The API has no transaction and
 * no rename route, so an in-place overwrite of a part would corrupt the live
 * file. Parts are therefore IMMUTABLE: a new version of the file writes a NEW
 * generation, and only after the manifest has been swapped are the old
 * generation's parts deleted. The manifest lists the FULL part names, and a
 * reader resolves parts from the manifest — it never derives a part name itself.
 *
 * THE MANIFEST IS REQUIRED FOR CORRECTNESS, NOT AN OPTIMISATION. Without it a
 * half-uploaded file is indistinguishable from a complete smaller one. It is
 * written LAST ({@link writeChunkedObject} enforces that): the manifest's
 * existence is what makes the file real, and an interrupted upload leaves
 * orphaned parts that {@link analyseChunks} names for repair.
 *
 * THE RESERVED TOKENS ARE RESERVED BY THE NAME SEAM, AND ONLY WITHIN ONE NAME
 * SEGMENT. `src/lib/name.ts` folds every illegal character to `-` and then
 * collapses runs of `-`, so the mapped FILE PART can never contain `--` — and
 * therefore can never contain `--manifest` or `--part-`. THAT is the property
 * pinned here, and it is the same property that reserves the folder separator.
 * **IT IS SCOPE-LIMITED, AND THE LIMIT IS REAL:** the tokens are appended AFTER
 * the whole object name, and a full object name carries folder separators, so
 * `toObjectName('manifest', ['docs']).objectName` is `docs--manifest` — a name
 * that ends in the manifest token without being a chunk manifest. The name
 * predicates below are therefore a HEURISTIC over a listing, not a proof; a
 * caller must confirm with {@link parseManifest}. That ambiguity is pinned as
 * debt, not hidden.
 *
 * THERE IS NO WHOLE-FILE DIGEST, AND THERE CANNOT BE ONE. `crypto.subtle.digest`
 * is one-shot and WebCrypto has no incremental digest, so hashing a 2 GB file
 * would require all of it in memory. Integrity is PER-PART: every part is
 * verified against the service's own `x-serverstore-sha256` on write and on
 * read, and the manifest records the ordered part names, sizes and hashes.
 *
 * WHAT THIS SEAM REFUSES TO DO: return a placeholder. A malformed or
 * wrong-version manifest THROWS ({@link ChunkManifestError}); it is never
 * defaulted to an empty part list, because that would present a corrupt file as
 * an empty one.
 *
 * A `413 payload_too_large` ON A PART IS THE ONLY SIGNAL THAT THE SERVER'S CAP
 * MOVED, and the app cannot read the cap (no route exposes it), so the part size
 * is an ASSUMPTION about server config. {@link writeChunkedObject} therefore
 * reports it LOUDLY as "the cap may be lower than the part size", naming the
 * part — never retried, never silently split smaller.
 */

import { z } from 'zod';

import { isLegalObjectName } from '@/lib/name';

/**
 * The part size in bytes: 64 MiB, EXACTLY the service's `SERVERSTORE_MAX_BYTES`
 * default. No margin — a part of exactly this size is accepted (`total >
 * maxBytes` is the service's refusal), and a margin would only make a big file
 * more requests for nothing.
 *
 * This is an ASSUMPTION ABOUT SERVER CONFIG, not a value the app can read: no
 * route exposes the service's cap. A `413` at this size is the only signal it
 * moved, and {@link ChunkPartTooLargeError} carries it.
 */
export const CHUNK_PART_SIZE = 64 * 1024 * 1024; // 67108864

/** The reserved suffix that marks a chunk MANIFEST object. */
export const CHUNK_MANIFEST_TOKEN = '--manifest';

/** The reserved infix that marks a chunk PART object. */
export const CHUNK_PART_TOKEN = '--part-';

/** The marker between the object name and the generation in a part name. */
export const CHUNK_GENERATION_TOKEN = '--g';

/**
 * The manifest format version this app WRITES. A stored manifest with any other
 * version is refused loudly rather than read as if it were this one.
 */
export const CHUNK_MANIFEST_VERSION = 1;

/**
 * How many digits a part index occupies. SIX, so lexical order IS part order for
 * every part count this convention can produce (a million parts is 64 TiB), and
 * no name ever compares out of order.
 */
export const CHUNK_PART_INDEX_DIGITS = 6;

/** The most parts one object can be split into, from the index width. */
export const CHUNK_MAX_PARTS = 10 ** CHUNK_PART_INDEX_DIGITS;

/** A generation is a short lowercase token the caller chooses for one version. */
const GENERATION_PATTERN = /^[a-z0-9]{1,32}$/;

/** The service's own digest shape (lowercase hex, 64 characters). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A part name, structurally: `<object>--g<generation>--part-<6 digits>`. */
const CHUNK_PART_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*--g[a-z0-9]{1,32}--part-[0-9]{6}$/;

/** Everything this seam refuses, thrown LOUDLY (rule 1). */
export class ChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkError';
  }
}

/** A manifest that cannot be read or built: the file's part list is unusable. */
export class ChunkManifestError extends Error {
  /** The object or manifest name the problem is about, when one is known. */
  readonly manifestName: string | null;

  constructor(manifestName: string | null, problem: string) {
    super(
      manifestName === null
        ? `The chunk manifest cannot be read: ${problem}`
        : `The chunk manifest ${JSON.stringify(manifestName)} cannot be read: ${problem}`,
    );
    this.name = 'ChunkManifestError';
    this.manifestName = manifestName;
  }
}

/**
 * A `413 payload_too_large` on a part. The part size is an assumption about
 * server config, so the only honest report is that the server's cap may be
 * LOWER than the part size — with the part named, and with no retry and no
 * silent split, because either would hide the fact from the owner.
 */
export class ChunkPartTooLargeError extends Error {
  /** The part the service refused. */
  readonly partName: string;
  /** The part's size in bytes, which the service refused. */
  readonly partSize: number;

  constructor(partName: string, partSize: number) {
    super(
      `ServerStore refused the part ${JSON.stringify(partName)} with 413 payload_too_large ` +
        `(the part is ${String(partSize)} bytes), so the server's cap may be LOWER than the ` +
        `part size. It was NOT retried and NOT split smaller — the part size is an assumption ` +
        `about server config this app cannot read, and the chunked upload stopped here.`,
    );
    this.name = 'ChunkPartTooLargeError';
    this.partName = partName;
    this.partSize = partSize;
  }
}

/* --------------------------------------------------------------- the names */

/**
 * The manifest name a chunked object is described by: `objectName--manifest`.
 * THROWS when the result would not be a legal object name (the name bound is
 * SHARED, so a near-1024-character object name has no room for the suffix).
 */
export function chunkManifestName(objectName: string): string {
  const name = `${objectName}${CHUNK_MANIFEST_TOKEN}`;
  if (!isLegalObjectName(name)) {
    throw new ChunkError(
      `Cannot build a chunk manifest name from ${JSON.stringify(objectName)}: ` +
        `${JSON.stringify(name)} is not a legal ServerStore object name (the suffix does not fit ` +
        `the shared 1024-character bound).`,
    );
  }
  return name;
}

/**
 * One part's name: `objectName--g<generation>--part-000000`. The index is
 * zero-padded to {@link CHUNK_PART_INDEX_DIGITS}, so lexical order IS part order.
 */
export function chunkPartName(objectName: string, generation: string, index: number): string {
  if (!GENERATION_PATTERN.test(generation)) {
    throw new ChunkError(
      `Cannot build a chunk part name: the generation ${JSON.stringify(generation)} is not ` +
        `1-32 lowercase letters or digits.`,
    );
  }
  if (!Number.isInteger(index) || index < 0 || index >= CHUNK_MAX_PARTS) {
    throw new ChunkError(
      `Cannot build a chunk part name: the index ${String(index)} is not an integer in ` +
        `0..${String(CHUNK_MAX_PARTS - 1)}.`,
    );
  }
  const name = `${objectName}${CHUNK_GENERATION_TOKEN}${generation}${CHUNK_PART_TOKEN}${String(index).padStart(CHUNK_PART_INDEX_DIGITS, '0')}`;
  if (!isLegalObjectName(name)) {
    throw new ChunkError(
      `Cannot build a chunk part name from ${JSON.stringify(objectName)}: ` +
        `${JSON.stringify(name)} is not a legal ServerStore object name (the suffix does not fit ` +
        `the shared 1024-character bound).`,
    );
  }
  return name;
}

/**
 * True when `objectName` has the SHAPE of a chunk manifest.
 *
 * A HEURISTIC, not a proof: the object name may carry folder separators, so a
 * file named `manifest` inside folder `docs` maps to `docs--manifest` and has
 * this shape without being a chunk manifest. Confirm with {@link parseManifest}.
 */
export function isChunkManifestName(objectName: string): boolean {
  return (
    isLegalObjectName(objectName) &&
    objectName.length > CHUNK_MANIFEST_TOKEN.length &&
    objectName.endsWith(CHUNK_MANIFEST_TOKEN)
  );
}

/**
 * True when `objectName` has the SHAPE of a chunk part. Same HEURISTIC caveat as
 * {@link isChunkManifestName}: `docs--part-000000` is also the mapping of the
 * file `part-000000` inside folder `docs`.
 */
export function isChunkPartName(objectName: string): boolean {
  return isLegalObjectName(objectName) && CHUNK_PART_NAME_PATTERN.test(objectName);
}

/**
 * The logical object a manifest name describes: the name with the manifest
 * token removed. THROWS when the name is not a manifest name at all.
 */
export function chunkedObjectNameFor(manifestName: string): string {
  if (!isChunkManifestName(manifestName)) {
    throw new ChunkError(
      `${JSON.stringify(manifestName)} is not a chunk manifest name (it must end with ` +
        `${JSON.stringify(CHUNK_MANIFEST_TOKEN)} and leave a non-empty object name).`,
    );
  }
  return manifestName.slice(0, -CHUNK_MANIFEST_TOKEN.length);
}

/* --------------------------------------------------------------- the plan */

/** One part of a planned chunked write. */
export interface ChunkPart {
  /** The FULL store name (`<object>--g<gen>--part-NNNNNN`). */
  name: string;
  /** Zero-based position; the part order IS the byte order. */
  index: number;
  /** The first byte of the object this part carries (inclusive). */
  start: number;
  /** One past the last byte this part carries (exclusive). */
  end: number;
}

/**
 * A whole chunked write, laid out in the order it must be performed: the
 * ordered {@link parts} FIRST and the manifest LAST. `manifestName` is separate
 * from `parts` on purpose — it is the one object that must not be written until
 * every part has been.
 */
export interface ChunkPlan {
  /** The logical object the file is stored as. */
  objectName: string;
  /** The manifest object that makes the file real. Written LAST. */
  manifestName: string;
  /** The generation every part of this write belongs to. */
  generation: string;
  /** The part size this plan was laid out with. */
  partSize: number;
  /** The whole object's size in bytes. */
  totalSize: number;
  /** The parts, in byte order. */
  parts: ChunkPart[];
}

/**
 * Split `totalSize` into parts of at most {@link CHUNK_PART_SIZE}, in order,
 * with contiguous byte ranges that cover the file EXACTLY once.
 *
 * A file of exactly one part size is ONE part; one byte more is TWO. A zero-byte
 * file is zero parts (the app refuses to upload one at all — the service refuses
 * an empty body — but the arithmetic is honest rather than a special case).
 *
 * THROWS when the object name, the generation or the size cannot produce a legal
 * plan: the name bound is SHARED, so an object name with no room for the chunk
 * suffix is refused HERE rather than sent and refused by the service.
 */
export function planChunks(objectName: string, totalSize: number, generation: string): ChunkPlan {
  if (!isLegalObjectName(objectName)) {
    throw new ChunkError(
      `Cannot plan a chunked write: ${JSON.stringify(objectName)} is not a legal ServerStore object name.`,
    );
  }
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new ChunkError(
      `Cannot plan a chunked write for ${JSON.stringify(objectName)}: the total size ` +
        `${String(totalSize)} is not a non-negative safe integer.`,
    );
  }
  const manifestName = chunkManifestName(objectName);
  const partCount = Math.ceil(totalSize / CHUNK_PART_SIZE);
  if (partCount > CHUNK_MAX_PARTS) {
    throw new ChunkError(
      `Cannot plan a chunked write for ${JSON.stringify(objectName)}: ${String(partCount)} parts ` +
        `exceeds the ${String(CHUNK_MAX_PARTS)} an index of ${String(CHUNK_PART_INDEX_DIGITS)} digits can address.`,
    );
  }
  const parts: ChunkPart[] = [];
  for (let index = 0; index < partCount; index += 1) {
    const start = index * CHUNK_PART_SIZE;
    parts.push({
      name: chunkPartName(objectName, generation, index),
      index,
      start,
      end: Math.min(totalSize, start + CHUNK_PART_SIZE),
    });
  }
  return {
    objectName,
    manifestName,
    generation,
    partSize: CHUNK_PART_SIZE,
    totalSize,
    parts,
  };
}

/* ------------------------------------------------------------ the manifest */

const chunkPartRecordSchema = z.strictObject({
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256_HEX),
});

/**
 * The manifest document's shape: the ordered parts with their FULL names, sizes
 * and the service's own hashes, plus the facts a reader needs to know what the
 * file IS. `strictObject`, so an unknown field is a refusal rather than data the
 * app silently ignores.
 */
export const chunkManifestSchema = z.strictObject({
  version: z.literal(CHUNK_MANIFEST_VERSION),
  objectName: z.string().min(1),
  generation: z.string().min(1),
  partSize: z.number().int().positive(),
  totalSize: z.number().int().nonnegative(),
  parts: z.array(chunkPartRecordSchema),
});

export type ChunkPartRecord = z.infer<typeof chunkPartRecordSchema>;
export type ChunkManifest = z.infer<typeof chunkManifestSchema>;

/** What {@link buildManifest} needs; the version is this app's, never a caller's. */
export interface ChunkManifestInput {
  objectName: string;
  generation: string;
  totalSize: number;
  parts: readonly ChunkPartRecord[];
  /** Defaults to {@link CHUNK_PART_SIZE}. */
  partSize?: number;
}

function manifestProblem(manifest: ChunkManifest): string | null {
  if (!isLegalObjectName(manifest.objectName)) {
    return `${JSON.stringify(manifest.objectName)} is not a legal object name`;
  }
  if (!isLegalObjectName(chunkManifestNameOrNull(manifest.objectName))) {
    return 'the object name leaves no room for the manifest suffix in the shared 1024-character bound';
  }
  if (!GENERATION_PATTERN.test(manifest.generation)) {
    return `the generation ${JSON.stringify(manifest.generation)} is not 1-32 lowercase letters or digits`;
  }
  const expectedCount =
    manifest.totalSize === 0 ? 0 : Math.ceil(manifest.totalSize / manifest.partSize);
  if (manifest.parts.length !== expectedCount) {
    return `it records ${String(manifest.parts.length)} parts, but ${String(manifest.totalSize)} bytes in ${String(manifest.partSize)}-byte parts is ${String(expectedCount)}`;
  }
  let covered = 0;
  for (let position = 0; position < manifest.parts.length; position += 1) {
    const record = manifest.parts[position];
    if (record?.index !== position) {
      return `part ${String(position)} does not carry index ${String(position)}`;
    }
    const expectedName = chunkPartNameOrNull(manifest.objectName, manifest.generation, position);
    if (expectedName === null || record.name !== expectedName) {
      return `part ${String(position)} is named ${JSON.stringify(record.name)}, not ${JSON.stringify(expectedName ?? '(an unbuildable name)')}`;
    }
    const expectedSize = Math.min(manifest.partSize, manifest.totalSize - covered);
    if (record.size !== expectedSize) {
      return `part ${String(position)} records ${String(record.size)} bytes, but the layout says ${String(expectedSize)}`;
    }
    covered += record.size;
  }
  if (covered !== manifest.totalSize) {
    return `its parts cover ${String(covered)} bytes, not the recorded total ${String(manifest.totalSize)}`;
  }
  return null;
}

/** {@link chunkManifestName}, `null` instead of a throw, for the invariant check. */
function chunkManifestNameOrNull(objectName: string): string {
  const name = `${objectName}${CHUNK_MANIFEST_TOKEN}`;
  return isLegalObjectName(name) ? name : '';
}

/** {@link chunkPartName}, `null` instead of a throw, for the invariant check. */
function chunkPartNameOrNull(objectName: string, generation: string, index: number): string | null {
  try {
    return chunkPartName(objectName, generation, index);
  } catch {
    return null;
  }
}

/**
 * Build a validated manifest. The version is THIS app's; the parts are checked
 * against the plan's own arithmetic (contiguous indices, contiguous byte
 * coverage, full names derived from the object name and generation), so a
 * manifest that would misdescribe the file is refused HERE.
 */
export function buildManifest(input: ChunkManifestInput): ChunkManifest {
  const candidate = {
    version: CHUNK_MANIFEST_VERSION,
    objectName: input.objectName,
    generation: input.generation,
    partSize: input.partSize ?? CHUNK_PART_SIZE,
    totalSize: input.totalSize,
    parts: input.parts.map((part) => ({
      name: part.name,
      index: part.index,
      size: part.size,
      sha256: part.sha256,
    })),
  };
  const parsed = chunkManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ChunkManifestError(
      input.objectName,
      `it does not match the manifest schema: ${parsed.error.message}`,
    );
  }
  const problem = manifestProblem(parsed.data);
  if (problem !== null) {
    throw new ChunkManifestError(parsed.data.objectName, problem);
  }
  return parsed.data;
}

/** The manifest as the bytes that go into the store: UTF-8 JSON, no more. */
export function encodeManifest(manifest: ChunkManifest): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/** A name to report a bad manifest by, when the body carries one. */
function manifestNameFromRaw(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || !('objectName' in raw)) return null;
  const objectName = (raw as { objectName?: unknown }).objectName;
  return typeof objectName === 'string' && objectName !== '' ? objectName : null;
}

/**
 * Read a manifest. A body that is not UTF-8 JSON, does not match the schema, is
 * not the version this app writes, or does not describe its own object name is
 * refused LOUDLY ({@link ChunkManifestError}) — NEVER defaulted to an empty or
 * partial part list, which would present a corrupt file as a whole one.
 */
export function parseManifest(bytes: Uint8Array<ArrayBuffer>): ChunkManifest {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new ChunkManifestError(
      null,
      `it is not valid UTF-8 (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new ChunkManifestError(
      null,
      `it is not JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (typeof raw === 'object' && raw !== null && 'version' in raw) {
    const version = (raw as { version?: unknown }).version;
    if (version !== CHUNK_MANIFEST_VERSION) {
      throw new ChunkManifestError(
        manifestNameFromRaw(raw),
        `its version is ${JSON.stringify(version)}, but this app writes version ` +
          `${String(CHUNK_MANIFEST_VERSION)}; refusing to read it as if it were.`,
      );
    }
  }
  const parsed = chunkManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ChunkManifestError(
      manifestNameFromRaw(raw),
      `it does not match the manifest schema: ${parsed.error.message}`,
    );
  }
  const problem = manifestProblem(parsed.data);
  if (problem !== null) {
    throw new ChunkManifestError(parsed.data.objectName, problem);
  }
  return parsed.data;
}

/* ------------------------------------------------------------- the writing */

/** One part's stored result: the service's own digest, and the size it stored. */
export interface StoredPart {
  sha256: string;
  size: number;
}

/** Where {@link writeChunkedObject} puts bytes. The seam owns the ORDER, not the transport. */
export interface ChunkWriter {
  /** `PUT` one part. May THROW; a `413` is reported by the caller, never retried. */
  writePart(part: ChunkPart, bytes: Uint8Array<ArrayBuffer>): Promise<StoredPart>;
  /** Write the manifest. Called EXACTLY ONCE, LAST, after every part. */
  writeManifest(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

/** The `code` of a typed transport failure, read structurally (no import cycle). */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Write a planned chunked object: EVERY part, in order, and the manifest LAST.
 *
 * THIS IS THE ONLY PLACE THE WRITE ORDER LIVES, so a caller cannot get it wrong.
 * A part failure STOPS the write: a `413` becomes a loud
 * {@link ChunkPartTooLargeError} naming the part and saying the server's cap may
 * be lower than the part size; anything else keeps its own reason (rule 1). There
 * is NO retry and NO silent split — a retried `PUT` can double-upload, and a
 * smaller part would hide that the assumption moved.
 *
 * The manifest is built from what the SERVICE stored (its own `sha256` and the
 * size it reports), not from what the caller hoped, and each part must have
 * stored exactly the bytes the plan sliced — a service that stored something
 * else is a loud failure, not a manifest that describes bytes that are not there.
 */
export async function writeChunkedObject(
  plan: ChunkPlan,
  writer: ChunkWriter,
  readPart: (part: ChunkPart) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<ChunkManifest> {
  const records: ChunkPartRecord[] = [];
  for (const part of plan.parts) {
    const bytes = await readPart(part);
    const expectedSize = part.end - part.start;
    if (bytes.length !== expectedSize) {
      throw new ChunkError(
        `The reader produced ${String(bytes.length)} bytes for ${JSON.stringify(part.name)}, but ` +
          `the plan lays out ${String(expectedSize)}; refusing to upload a part that is not the file's bytes.`,
      );
    }
    let stored: StoredPart;
    try {
      stored = await writer.writePart(part, bytes);
    } catch (error: unknown) {
      if (errorCode(error) === 'payload_too_large') {
        throw new ChunkPartTooLargeError(part.name, expectedSize);
      }
      throw error;
    }
    if (stored.size !== expectedSize) {
      throw new ChunkError(
        `ServerStore stored ${String(stored.size)} bytes for ${JSON.stringify(part.name)}, but the ` +
          `plan laid out ${String(expectedSize)}; refusing to describe a file whose part is not what was sent.`,
      );
    }
    if (!SHA256_HEX.test(stored.sha256)) {
      throw new ChunkError(
        `ServerStore did not report a readable sha256 for ${JSON.stringify(part.name)} ` +
          `(${JSON.stringify(stored.sha256)}); without the service's own digest the manifest cannot record what was stored.`,
      );
    }
    records.push({
      name: part.name,
      index: part.index,
      size: stored.size,
      sha256: stored.sha256,
    });
  }

  const manifest = buildManifest({
    objectName: plan.objectName,
    generation: plan.generation,
    totalSize: plan.totalSize,
    partSize: plan.partSize,
    parts: records,
  });
  // LAST, and only now: the manifest's existence is what makes the file real.
  await writer.writeManifest(plan.manifestName, encodeManifest(manifest));
  return manifest;
}

/* ------------------------------------------------------------ the analysis */

/** One row of the store's listing: what a listing can actually say. */
export interface ChunkListingEntry {
  name: string;
  sha256: string;
  size: number;
}

/**
 * A manifest document that was READ from the store. The listing does NOT carry
 * it: a listing gives an object's name, size and digest, never its content, so
 * completeness cannot be judged from a listing alone.
 */
export interface ChunkManifestDocument {
  /** The manifest object's name, which must appear in `entries`. */
  name: string;
  /** Its bytes, exactly as the store returned them. */
  bytes: Uint8Array<ArrayBuffer>;
}

/** A part the manifest records that is present but is not the bytes it recorded. */
export interface ChunkPartMismatch {
  name: string;
  problem: string;
}

export type ChunkManifestStatus = 'complete' | 'incomplete' | 'malformed';

/** What one manifest's presence in the listing means. */
export interface ChunkManifestReport {
  manifestName: string;
  /** The logical object the manifest name claims, or `null` when undecidable. */
  objectName: string | null;
  status: ChunkManifestStatus;
  /** Parts the manifest records that the listing does NOT contain. */
  missing: string[];
  /** Parts present but with a different size or hash than the manifest records. */
  mismatched: ChunkPartMismatch[];
  /** Why the manifest could not be read, when `status` is `malformed`. */
  problems: string[];
}

/** The whole analysis: every manifest's state, and the parts no manifest owns. */
export interface ChunkAnalysis {
  manifests: ChunkManifestReport[];
  /** Part objects that belong to NO readable manifest — the orphans a repair sweeps. */
  orphans: string[];
}

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Analyse a listing (plus the manifest documents that were read from it):
 *
 *  * COMPLETE — every part the manifest names is present with the size and hash
 *    the manifest records;
 *  * INCOMPLETE — the manifest is readable but a part is absent, or is present
 *    with a different size or hash (named in `missing`/`mismatched`);
 *  * MALFORMED — the manifest cannot be read at all (its bytes were not read, or
 *    `parseManifest` refused them), in which case it claims NO parts;
 *  * ORPHANS — part-shaped objects that belong to no readable manifest, which is
 *    exactly what an interrupted upload leaves behind.
 *
 * The name predicates are HEURISTICS (see {@link isChunkManifestName}), so a
 * manifest is only ever reported as complete after its OWN bytes have parsed and
 * named this object. A false positive is therefore reported as MALFORMED, never
 * silently swept as a chunk.
 */
export function analyseChunks(
  entries: readonly ChunkListingEntry[],
  manifestDocuments: readonly ChunkManifestDocument[],
): ChunkAnalysis {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const documents = new Map(manifestDocuments.map((document) => [document.name, document]));
  const manifestNames = entries
    .map((entry) => entry.name)
    .filter((name) => isChunkManifestName(name))
    .sort();

  const claimed = new Set<string>();
  const manifests: ChunkManifestReport[] = [];

  for (const manifestName of manifestNames) {
    const document = documents.get(manifestName);
    if (document === undefined) {
      manifests.push({
        manifestName,
        objectName: chunkedObjectNameFor(manifestName),
        status: 'malformed',
        missing: [],
        mismatched: [],
        problems: ['its bytes were not read, so the parts it claims are unknown'],
      });
      continue;
    }

    let manifest: ChunkManifest;
    try {
      manifest = parseManifest(document.bytes);
    } catch (error: unknown) {
      manifests.push({
        manifestName,
        objectName: chunkedObjectNameFor(manifestName),
        status: 'malformed',
        missing: [],
        mismatched: [],
        problems: [problemText(error)],
      });
      continue;
    }

    const objectName = chunkedObjectNameFor(manifestName);
    if (manifest.objectName !== objectName) {
      manifests.push({
        manifestName,
        objectName,
        status: 'malformed',
        missing: [],
        mismatched: [],
        problems: [
          `it names the object ${JSON.stringify(manifest.objectName)}, but its own name says ${JSON.stringify(objectName)}`,
        ],
      });
      continue;
    }

    const missing: string[] = [];
    const mismatched: ChunkPartMismatch[] = [];
    for (const record of manifest.parts) {
      claimed.add(record.name);
      const entry = byName.get(record.name);
      if (entry === undefined) {
        missing.push(record.name);
        continue;
      }
      if (entry.size !== record.size) {
        mismatched.push({
          name: record.name,
          problem: `the listing says ${String(entry.size)} bytes, the manifest records ${String(record.size)}`,
        });
      } else if (entry.sha256 !== record.sha256) {
        mismatched.push({
          name: record.name,
          problem: `the listing digest ${entry.sha256} is not the recorded ${record.sha256}`,
        });
      }
    }

    manifests.push({
      manifestName,
      objectName,
      status: missing.length === 0 && mismatched.length === 0 ? 'complete' : 'incomplete',
      missing,
      mismatched,
      problems: [],
    });
  }

  const orphans = entries
    .map((entry) => entry.name)
    .filter((name) => isChunkPartName(name) && !claimed.has(name))
    .sort();

  return { manifests, orphans };
}
