import { describe, expect, it } from 'vitest';

import {
  analyseChunks,
  buildManifest,
  CHUNK_MANIFEST_TOKEN,
  CHUNK_PART_INDEX_DIGITS,
  CHUNK_PART_SIZE,
  CHUNK_PART_TOKEN,
  chunkedObjectNameFor,
  chunkManifestName,
  ChunkPartTooLargeError,
  chunkPartName,
  ChunkError,
  ChunkManifestError,
  encodeManifest,
  isChunkManifestName,
  isChunkPartName,
  parseManifest,
  planChunks,
  writeChunkedObject,
  type ChunkListingEntry,
  type ChunkManifestDocument,
  type ChunkPart,
  type ChunkPlan,
  type StoredPart,
  type ChunkWriter,
} from '@/lib/chunk';
import { FOLDER_SEPARATOR, splitObjectName, type FolderPath } from '@/lib/folder';
import { OBJECT_NAME_MAX_LENGTH, toObjectName } from '@/lib/name';

/**
 * Ledger row 12, slice A — THE CHUNKING CONVENTION.
 *
 * Big files are split into 64 MiB parts because the deployed path goes through
 * Cloudflare (a 100 MB upload wall no `SERVERSTORE_MAX_BYTES` value moves) and
 * ServerStore reads a whole body into one `Uint8Array`. The manifest is the ONE
 * object that makes a chunked file real, so it is written LAST and read FIRST;
 * integrity is PER-PART (WebCrypto has no incremental digest, so a whole-file
 * SHA-256 is impossible in a browser); parts are IMMUTABLE (a generation in the
 * name) because the API has no transaction and no rename.
 *
 * The pins here hold three separate things:
 *   1. the RESERVED-TOKEN property — pinned against the name seam that grants
 *      it (`collapseDashes`), with its real SCOPE stated honestly;
 *   2. the layout, the codec and the analysis, as pure functions;
 *   3. the write ORDER and the 413 rule, through an injected writer, so no test
 *      here touches the network or allocates 64 MiB.
 */

const GEN = 'a1b2c3d4';

/** The digest the fake writer reports for an even-indexed part. */
const DIGEST_A = 'a'.repeat(64);

/** The digest the fake writer reports for an odd-indexed part. */
const DIGEST_B = 'b'.repeat(64);

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** An out-of-tree plan at a TINY part size, so the writer pins allocate nothing. */
function tinyPlan(objectName: string, totalSize: number, partSize: number): ChunkPlan {
  const parts: ChunkPart[] = [];
  for (let start = 0, index = 0; start < totalSize; start += partSize, index += 1) {
    parts.push({
      name: chunkPartName(objectName, GEN, index),
      index,
      start,
      end: Math.min(totalSize, start + partSize),
    });
  }
  return {
    objectName,
    manifestName: chunkManifestName(objectName),
    generation: GEN,
    partSize,
    totalSize,
    parts,
  };
}

/** A writer that records every call and can be told to fail one part. */
class RecordingWriter implements ChunkWriter {
  readonly calls: string[] = [];
  readonly failures = new Map<number, Error>();
  manifestName: string | null = null;
  manifestBytes: Uint8Array<ArrayBuffer> | null = null;

  writePart(part: ChunkPart): Promise<StoredPart> {
    this.calls.push(`part:${part.name}`);
    const failure = this.failures.get(part.index);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve({
      sha256: part.index % 2 === 0 ? DIGEST_A : DIGEST_B,
      size: part.end - part.start,
    });
  }

  writeManifest(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.calls.push(`manifest:${name}`);
    this.manifestName = name;
    this.manifestBytes = bytes;
    return Promise.resolve();
  }
}

/** The bytes a part claims, without allocating the part's real size. */
function fakeBytes(part: ChunkPart): Promise<Uint8Array<ArrayBuffer>> {
  return Promise.resolve(new Uint8Array(part.end - part.start));
}

/* --------------------------------------------- the reserved tokens */

/** File names whose MAPPED form must never smuggle in a chunk token. */
const MESSY_FILE_NAMES = [
  'notes.txt',
  'My Report (final).PDF',
  'a  b -- c.txt',
  'x - - y.pdf',
  'manifest',
  'part-000000',
  'a--manifest.txt',
  'b--part-000001.bin',
  '2026 Q3 — budget.xlsx',
];

const FOLDER_PATHS: FolderPath[] = [['docs'], ['docs', 'reports'], ['a', 'b', 'c']];

describe('the reserved-token property', () => {
  it('a mapped FILE PART can never contain the manifest token --manifest (the reserved-token property)', () => {
    for (const fileName of MESSY_FILE_NAMES) {
      expect(toObjectName(fileName).objectName).not.toContain(CHUNK_MANIFEST_TOKEN);
      for (const folder of FOLDER_PATHS) {
        const full = toObjectName(fileName, folder).objectName;
        expect(splitObjectName(full).filePart).not.toContain(CHUNK_MANIFEST_TOKEN);
      }
    }
    // The mechanism, named so a reader can see WHY: runs of dashes collapse, so
    // a file name that IS the token maps to something that is not.
    expect(toObjectName('a--manifest.txt').objectName).toBe('a-manifest.txt');
    expect(toObjectName('manifest').objectName).toBe('manifest');
  });

  it('a mapped FILE PART can never contain the part token --part- (the reserved-token property)', () => {
    for (const fileName of MESSY_FILE_NAMES) {
      expect(toObjectName(fileName).objectName).not.toContain(CHUNK_PART_TOKEN);
      for (const folder of FOLDER_PATHS) {
        const full = toObjectName(fileName, folder).objectName;
        expect(splitObjectName(full).filePart).not.toContain(CHUNK_PART_TOKEN);
      }
    }
    expect(toObjectName('b--part-000001.bin').objectName).toBe('b-part-000001.bin');
  });

  it('a mapped FILE PART can never contain the folder separator, which is what reserves both chunk tokens', () => {
    for (const fileName of MESSY_FILE_NAMES) {
      expect(toObjectName(fileName).objectName).not.toContain(FOLDER_SEPARATOR);
      for (const folder of FOLDER_PATHS) {
        expect(splitObjectName(toObjectName(fileName, folder).objectName).filePart).not.toContain(
          FOLDER_SEPARATOR,
        );
      }
    }
    // The implication the two pins above rest on: no `--` means no `--manifest`
    // and no `--part-`, because both tokens CONTAIN the separator.
    expect(CHUNK_MANIFEST_TOKEN).toContain(FOLDER_SEPARATOR);
    expect(CHUNK_PART_TOKEN).toContain(FOLDER_SEPARATOR);
  });

  it('the tokens are reserved only WITHIN one name segment: a folder boundary CAN spell --manifest or --part-, so the name predicates are a HEURISTIC (the known ambiguity)', () => {
    // A file genuinely named `manifest` inside folder `docs` is NOT a chunk
    // manifest, yet its mapped name has the manifest token's shape. The part
    // token needs TWO boundaries (a folder level that reads `g<generation>`,
    // then the file `part-NNNNNN`), and that is reachable too. This pin
    // documents the ambiguity rather than hiding it: slice B must confirm a
    // candidate with parseManifest, and a false positive must be reported
    // MALFORMED, never silently swept as a chunk.
    const inFolder = toObjectName('manifest', ['docs']).objectName;
    expect(inFolder).toBe('docs--manifest');
    expect(isChunkManifestName(inFolder)).toBe(true);
    expect(chunkedObjectNameFor(inFolder)).toBe('docs');

    const partInFolder = toObjectName('part-000000', ['docs', `g${GEN}`]).objectName;
    expect(partInFolder).toBe(chunkPartName('docs', GEN, 0));
    expect(isChunkPartName(partInFolder)).toBe(true);

    // And at the ROOT the predicates are exact for the names this seam builds.
    expect(isChunkManifestName(chunkManifestName('docs--report.pdf'))).toBe(true);
    expect(isChunkManifestName('docs--report.pdf')).toBe(false);
    expect(isChunkPartName(chunkPartName('docs--report.pdf', GEN, 0))).toBe(true);
    expect(isChunkPartName('docs--report.pdf')).toBe(false);
  });

  it('a manifest name and a part name round-trip: chunkedObjectNameFor is the inverse of the manifest suffix', () => {
    const objectName = 'docs--reports--q1--report.pdf';
    const manifestName = chunkManifestName(objectName);
    expect(manifestName).toBe(`${objectName}${CHUNK_MANIFEST_TOKEN}`);
    expect(chunkedObjectNameFor(manifestName)).toBe(objectName);
    expect(() => chunkedObjectNameFor('docs--report.pdf')).toThrow(ChunkError);

    const part = chunkPartName(objectName, GEN, 7);
    expect(part).toBe(`${objectName}--g${GEN}${CHUNK_PART_TOKEN}000007`);
    expect(isChunkPartName(part)).toBe(true);
  });
});

/* --------------------------------------------------- the plan */

describe('planChunks', () => {
  it('planChunks splits a total size into parts of at most 64 MiB, in order, with contiguous byte ranges that cover the file EXACTLY once', () => {
    const sizes = [
      0,
      1,
      CHUNK_PART_SIZE - 1,
      CHUNK_PART_SIZE,
      CHUNK_PART_SIZE + 1,
      3 * CHUNK_PART_SIZE + 12345,
    ];
    for (const totalSize of sizes) {
      const plan = planChunks('big.bin', totalSize, GEN);
      expect(plan.manifestName).toBe('big.bin--manifest');
      expect(plan.partSize).toBe(CHUNK_PART_SIZE);
      expect(plan.parts).toHaveLength(Math.ceil(totalSize / CHUNK_PART_SIZE));

      let cursor = 0;
      let covered = 0;
      for (const [position, part] of plan.parts.entries()) {
        expect(part.index).toBe(position);
        // Contiguous: this part starts exactly where the last one ended.
        expect(part.start).toBe(cursor);
        expect(part.end).toBeGreaterThan(part.start);
        expect(part.end - part.start).toBeLessThanOrEqual(CHUNK_PART_SIZE);
        expect(part.name).toBe(chunkPartName('big.bin', GEN, position));
        cursor = part.end;
        covered += part.end - part.start;
      }
      // EXACTLY once: the ranges tile [0, totalSize) with no gap and no overlap.
      expect(cursor).toBe(totalSize);
      expect(covered).toBe(totalSize);
    }
  });

  it('a file of exactly the part size is ONE part; one byte more is TWO', () => {
    expect(planChunks('big.bin', CHUNK_PART_SIZE, GEN).parts).toHaveLength(1);
    const one = planChunks('big.bin', CHUNK_PART_SIZE, GEN).parts[0];
    expect(one).toMatchObject({ index: 0, start: 0, end: CHUNK_PART_SIZE });

    const more = planChunks('big.bin', CHUNK_PART_SIZE + 1, GEN).parts;
    expect(more).toHaveLength(2);
    expect(more[0]).toMatchObject({ start: 0, end: CHUNK_PART_SIZE });
    expect(more[1]).toMatchObject({ start: CHUNK_PART_SIZE, end: CHUNK_PART_SIZE + 1 });
  });

  it('part names are zero-padded so lexical order equals part order', () => {
    const names = Array.from({ length: 12 }, (_, index) => chunkPartName('big.bin', GEN, index));
    expect(names[0]).toBe(`big.bin--g${GEN}--part-000000`);
    expect(names[10]).toBe(`big.bin--g${GEN}--part-000010`);
    expect(names[11]).toBe(`big.bin--g${GEN}--part-000011`);
    // The padded strings sort in the same order the parts were planned in.
    expect([...names].sort()).toEqual(names);

    const plan = planChunks('big.bin', 12 * CHUNK_PART_SIZE, GEN);
    const planned = plan.parts.map((part) => part.name);
    expect([...planned].sort()).toEqual(planned);
    expect(planned[0]).toContain(String(0).padStart(CHUNK_PART_INDEX_DIGITS, '0'));
  });

  it('planChunks REFUSES an object name with no room for the chunk suffix, an illegal generation and a bad size', () => {
    const fullLengthName = 'a'.repeat(OBJECT_NAME_MAX_LENGTH);
    expect(() => planChunks(fullLengthName, 1, GEN)).toThrow(ChunkError);
    expect(() => planChunks('ok.bin', 1, 'NOT GEN')).toThrow(ChunkError);
    expect(() => planChunks('ok.bin', -1, GEN)).toThrow(ChunkError);
    expect(() => planChunks('ok.bin', 1.5, GEN)).toThrow(ChunkError);
    expect(() => planChunks('Not Legal', 1, GEN)).toThrow(ChunkError);
  });
});

/* ----------------------------------------------- the manifest codec */

describe('the manifest codec', () => {
  it('the manifest round-trips through encodeManifest and parseManifest with names, sizes and hashes intact', () => {
    const plan = planChunks('docs--report.pdf', CHUNK_PART_SIZE + 7, GEN);
    const manifest = buildManifest({
      objectName: plan.objectName,
      generation: plan.generation,
      totalSize: plan.totalSize,
      parts: plan.parts.map((part) => ({
        name: part.name,
        index: part.index,
        size: part.end - part.start,
        sha256: part.index % 2 === 0 ? DIGEST_A : DIGEST_B,
      })),
    });

    const bytes = encodeManifest(manifest);
    expect(bytes.length).toBeGreaterThan(0);
    const parsed = parseManifest(bytes);
    expect(parsed).toEqual(manifest);
    expect(parsed.parts.map((part) => part.name)).toEqual(plan.parts.map((part) => part.name));
    expect(parsed.parts[1]).toMatchObject({ size: 7, sha256: DIGEST_B });
  });

  it('a malformed manifest is refused LOUDLY, never defaulted to an empty part list', () => {
    const bodies = [
      'not json at all',
      '[]',
      '{}',
      '{"version":1}',
      '{"version":1,"objectName":"x.bin"}',
      JSON.stringify({
        version: 1,
        objectName: 'x.bin',
        generation: GEN,
        partSize: CHUNK_PART_SIZE,
        totalSize: 1,
        parts: [],
      }),
      JSON.stringify({
        version: 1,
        objectName: 'x.bin',
        generation: GEN,
        partSize: CHUNK_PART_SIZE,
        totalSize: 1,
        parts: [{ name: 'x.bin--g' + GEN + '--part-000000', index: 0, size: 1, sha256: 'nope' }],
      }),
      JSON.stringify({
        version: 1,
        objectName: 'x.bin',
        generation: GEN,
        partSize: CHUNK_PART_SIZE,
        totalSize: 1,
        parts: [
          { name: 'x.bin--g' + GEN + '--part-000000', index: 0, size: 1, sha256: DIGEST_A },
        ],
        extra: 'a field this app must not silently ignore',
      }),
    ];
    for (const body of bodies) {
      expect(() => parseManifest(utf8(body)), body).toThrow(ChunkManifestError);
    }
  });

  it('a manifest whose version is not this app version is refused LOUDLY, naming the version', () => {
    const body = JSON.stringify({
      version: 2,
      objectName: 'x.bin',
      generation: GEN,
      partSize: CHUNK_PART_SIZE,
      totalSize: 1,
      parts: [{ name: chunkPartName('x.bin', GEN, 0), index: 0, size: 1, sha256: DIGEST_A }],
    });
    let caught: unknown;
    try {
      parseManifest(utf8(body));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChunkManifestError);
    expect((caught as Error).message).toContain('its version is 2');
  });

  it('a manifest that does not describe its own object name, generation, total size or layout is refused LOUDLY', () => {
    const plan = tinyPlan('docs--report.pdf', 12, 4);
    const manifest = buildManifest({
      objectName: plan.objectName,
      generation: plan.generation,
      totalSize: plan.totalSize,
      partSize: plan.partSize,
      parts: plan.parts.map((part) => ({
        name: part.name,
        index: part.index,
        size: part.end - part.start,
        sha256: DIGEST_A,
      })),
    });
    const wrongPartName = {
      ...manifest,
      parts: [{ ...manifest.parts[0], name: 'docs--report.pdf--gother--part-000000' }],
    };
    const wrongTotal = { ...manifest, totalSize: manifest.totalSize + 1 };
    const wrongSize = { ...manifest, parts: [{ ...manifest.parts[0], size: 3 }] };

    for (const body of [wrongPartName, wrongTotal, wrongSize]) {
      expect(() => parseManifest(utf8(JSON.stringify(body)))).toThrow(ChunkManifestError);
    }
  });
});

/* --------------------------------------------------- the write path */

describe('writeChunkedObject', () => {
  it('the chunked write commits the manifest LAST, after every part, and records the SERVICE own digest for each part', async () => {
    const plan = tinyPlan('tiny.bin', 12, 4);
    const writer = new RecordingWriter();

    const manifest = await writeChunkedObject(plan, writer, fakeBytes);

    // Every part, in order, and the manifest only after all of them.
    expect(writer.calls).toEqual([
      `part:${plan.parts[0]?.name ?? ''}`,
      `part:${plan.parts[1]?.name ?? ''}`,
      `part:${plan.parts[2]?.name ?? ''}`,
      `manifest:${plan.manifestName}`,
    ]);
    expect(writer.manifestName).toBe(plan.manifestName);
    // The manifest records the SERVICE's digests, not what the caller hoped.
    expect(manifest.parts.map((part) => part.sha256)).toEqual([DIGEST_A, DIGEST_B, DIGEST_A]);
    expect(manifest.parts.map((part) => part.name)).toEqual(plan.parts.map((part) => part.name));
    // The bytes handed to the store ARE the encoded manifest.
    expect(writer.manifestBytes).not.toBeNull();
    expect(parseManifest(writer.manifestBytes ?? new Uint8Array())).toEqual(manifest);
  });

  it('a 413 on a part is reported as the server cap possibly being LOWER than the part size, naming the part, and is NEVER retried', async () => {
    const plan = tinyPlan('tiny.bin', 8, 4);
    const writer = new RecordingWriter();
    writer.failures.set(
      1,
      Object.assign(new Error('ServerStore refused (payload_too_large): too large'), {
        code: 'payload_too_large',
      }),
    );

    let caught: unknown;
    try {
      await writeChunkedObject(plan, writer, fakeBytes);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChunkPartTooLargeError);
    const failure = caught as ChunkPartTooLargeError;
    expect(failure.partName).toBe(plan.parts[1]?.name);
    expect(failure.partSize).toBe(4);
    expect(failure.message).toContain(plan.parts[1]?.name ?? '');
    expect(failure.message).toContain('may be LOWER than the part size');
    // NEVER retried: part 1 was attempted exactly once, and the file never became real.
    expect(writer.calls).toEqual([
      `part:${plan.parts[0]?.name ?? ''}`,
      `part:${plan.parts[1]?.name ?? ''}`,
    ]);
    expect(writer.manifestName).toBeNull();
    expect(writer.manifestBytes).toBeNull();
  });

  it('a NON-413 part failure keeps its own reason, so the 413 rule is specific and not a blanket wrapper', async () => {
    const plan = tinyPlan('tiny.bin', 8, 4);
    const writer = new RecordingWriter();
    writer.failures.set(0, new Error('The disk disappeared.'));

    await expect(writeChunkedObject(plan, writer, fakeBytes)).rejects.toThrow(
      'The disk disappeared.',
    );
    expect(writer.manifestName).toBeNull();
  });

  it('a part the writer stored at the wrong size is a LOUD failure, never a manifest describing bytes that are not there', async () => {
    const plan = tinyPlan('tiny.bin', 8, 4);
    const writer = new RecordingWriter();
    const liar: ChunkWriter = {
      writePart: (part) => Promise.resolve({ sha256: DIGEST_A, size: (part.end - part.start) / 2 }),
      writeManifest: writer.writeManifest.bind(writer),
    };

    await expect(writeChunkedObject(plan, liar, fakeBytes)).rejects.toThrow(ChunkError);
    expect(writer.manifestName).toBeNull();
  });
});

/* ----------------------------------------------------- the analysis */

describe('analyseChunks', () => {
  // A REAL 64 MiB plan: the listing entries are tiny, so nothing here allocates a part.
  const plan = planChunks('big.bin', CHUNK_PART_SIZE + 7, GEN);
  const records = plan.parts.map((part) => ({
    name: part.name,
    index: part.index,
    size: part.end - part.start,
    sha256: part.index % 2 === 0 ? DIGEST_A : DIGEST_B,
  }));
  const manifest = buildManifest({
    objectName: plan.objectName,
    generation: plan.generation,
    totalSize: plan.totalSize,
    parts: records,
  });
  const manifestBytes = encodeManifest(manifest);
  const manifestEntry: ChunkListingEntry = {
    name: plan.manifestName,
    sha256: 'c'.repeat(64),
    size: manifestBytes.length,
  };
  const partEntries: ChunkListingEntry[] = records.map((record) => ({
    name: record.name,
    sha256: record.sha256,
    size: record.size,
  }));
  const document: ChunkManifestDocument = { name: plan.manifestName, bytes: manifestBytes };

  it('analyseChunks reports a manifest COMPLETE only when every part it names is present with the recorded size and hash', () => {
    const complete = analyseChunks([manifestEntry, ...partEntries], [document]);
    expect(complete.manifests).toHaveLength(1);
    expect(complete.manifests[0]).toMatchObject({
      manifestName: plan.manifestName,
      objectName: plan.objectName,
      status: 'complete',
      missing: [],
      mismatched: [],
      problems: [],
    });
    expect(complete.orphans).toEqual([]);

    // A part present with the WRONG HASH is not complete.
    const wrongHash = partEntries.map((entry, index) =>
      index === 0 ? { ...entry, sha256: 'd'.repeat(64) } : entry,
    );
    const hashed = analyseChunks([manifestEntry, ...wrongHash], [document]);
    expect(hashed.manifests[0]?.status).toBe('incomplete');
    expect(hashed.manifests[0]?.mismatched.map((entry) => entry.name)).toEqual([
      records[0]?.name ?? '',
    ]);

    // A part present at the WRONG SIZE is not complete either.
    const wrongSize = partEntries.map((entry, index) =>
      index === 1 ? { ...entry, size: entry.size + 1 } : entry,
    );
    const sized = analyseChunks([manifestEntry, ...wrongSize], [document]);
    expect(sized.manifests[0]?.status).toBe('incomplete');
    expect(sized.manifests[0]?.mismatched.map((entry) => entry.name)).toEqual([
      records[1]?.name ?? '',
    ]);
  });

  it('analyseChunks reports INCOMPLETE, naming what is missing, when a part is absent, and MALFORMED when the manifest itself cannot be read', () => {
    // Absent: part 0 is gone from the listing.
    const absent = analyseChunks([manifestEntry, ...partEntries.slice(1)], [document]);
    expect(absent.manifests[0]?.status).toBe('incomplete');
    expect(absent.manifests[0]?.missing).toEqual([records[0]?.name ?? '']);

    // Malformed: the document's bytes are not a manifest at all.
    const badDocument: ChunkManifestDocument = { name: plan.manifestName, bytes: utf8('not json') };
    const malformed = analyseChunks([manifestEntry, ...partEntries], [badDocument]);
    expect(malformed.manifests[0]?.status).toBe('malformed');
    expect(malformed.manifests[0]?.problems[0]).toMatch(/not JSON/i);

    // Malformed: the manifest object is in the listing but its bytes were never read.
    const unread = analyseChunks([manifestEntry, ...partEntries], []);
    expect(unread.manifests[0]?.status).toBe('malformed');
    expect(unread.manifests[0]?.problems[0]).toMatch(/not read/i);

    // Malformed: the manifest names a DIFFERENT object than its own name claims.
    const other = buildManifest({
      objectName: 'other.bin',
      generation: GEN,
      totalSize: 4,
      partSize: 4,
      parts: [{ name: chunkPartName('other.bin', GEN, 0), index: 0, size: 4, sha256: DIGEST_A }],
    });
    const mismatch = analyseChunks(
      [manifestEntry, ...partEntries],
      [{ name: plan.manifestName, bytes: encodeManifest(other) }],
    );
    expect(mismatch.manifests[0]?.status).toBe('malformed');
    expect(mismatch.manifests[0]?.problems[0]).toContain('other.bin');
  });

  it('analyseChunks lists the parts that belong to NO manifest — the orphans an interrupted upload leaves', () => {
    // No manifest at all: every part is an orphan.
    const lonely = analyseChunks(partEntries, []);
    expect(lonely.manifests).toEqual([]);
    expect(lonely.orphans).toEqual(records.map((record) => record.name).sort());

    // A complete manifest claims its own parts, so they are NOT orphans.
    const owned = analyseChunks([manifestEntry, ...partEntries], [document]);
    expect(owned.orphans).toEqual([]);

    // A part from ANOTHER generation is an orphan even beside a complete manifest.
    const strayName = chunkPartName('big.bin', 'ffffffff', 0);
    const stray: ChunkListingEntry = { name: strayName, sha256: DIGEST_B, size: 4 };
    const withStray = analyseChunks([manifestEntry, ...partEntries, stray], [document]);
    expect(withStray.orphans).toEqual([strayName]);

    // A MALFORMED manifest claims nothing, so its own parts are orphans too.
    const broken = analyseChunks([manifestEntry, ...partEntries], [
      { name: plan.manifestName, bytes: utf8('not json') },
    ]);
    expect(broken.orphans).toEqual(records.map((record) => record.name).sort());
  });
});
