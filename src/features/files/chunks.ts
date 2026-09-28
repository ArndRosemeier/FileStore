/**
 * The chunk VIEW (ledger row 12, slice B): the ONE place a flat ServerStore
 * listing plus the manifest documents that were READ from it become what the
 * owner sees.
 *
 * CONTENT DECIDES; THE NAME ONLY PROPOSES. The chunk name predicates
 * (`src/lib/chunk.ts#isChunkManifestName`) are a HEURISTIC: `toObjectName` can
 * never emit `--` INSIDE a name segment, but the manifest token is appended AFTER
 * the whole object name, so `docs--report.pdf--manifest` is BOTH the manifest of
 * a chunked `docs--report.pdf` AND the mapping of a real file named `manifest`
 * inside the folder `docs/report.pdf`. Therefore nothing here treats an object as
 * a chunked file until its OWN bytes have been read and `parseManifest` has
 * accepted them — and a manifest that does not parse is left where it was: a
 * NORMAL FILE ROW, reported as ambiguous, never hidden and never deleted.
 *
 * ONE FILE, ONE ROW. A chunked file is rendered as ONE row: the row's synthetic
 * entry carries the LOGICAL object name, the manifest's `createdAt` and the
 * manifest's own digest, and the TOTAL size the manifest records. Its parts are
 * NEVER rows, and neither is the manifest object itself; {@link hiddenNames} is
 * the ONE set the listing builder subtracts. There is no whole-file digest to
 * show (`crypto.subtle` has no incremental digest — ledger row 12), so the digest
 * column shows the digest of the object that DESCRIBES the file, and the UI says
 * so.
 *
 * ORPHANS ARE REPORTED, NEVER SWEPT. A part object no readable manifest claims is
 * exactly what an interrupted upload leaves behind; it is named in
 * {@link ChunkView.orphans} and shown as a report. Nothing in this module (or in
 * the UI that consumes it) deletes one — removing orphans is a separate,
 * destructive slice with its own confirmation.
 *
 * A MANIFEST THAT CANNOT BE READ IS AN UNCERTAIN CLAIM, NOT A FILE. When the bytes
 * of a manifest-shaped object cannot be fetched at all, this app cannot tell
 * whether it is a chunked file, so it is REPORTED, it stays visible as a normal
 * file, AND its heuristic logical name is added to
 * {@link ChunkView.uncertainClaims} — which makes an upload under that name ask
 * for confirmation. That is the safe direction: a spurious confirmation is
 * friction, a silent clobber is the data loss rule 1 forbids.
 *
 * WHAT THIS MODULE DOES NOT DO: it never issues a request (the reader is
 * injected), never composes a store name from parts (every path question goes
 * through `src/lib/folder.ts`, and a listed name is used verbatim), and never
 * throws on a bad manifest — a bad manifest is a REPORT, because refusing to
 * render the folder would hide every other file in it.
 */

import {
  analyseChunks,
  isChunkManifestName,
  isChunkPartName,
  parseManifest,
  type ChunkManifest,
  type ChunkManifestDocument,
  type ChunkPartMismatch,
} from '@/lib/chunk';
import type { ObjectEntry } from '@/server/store-client';

/** One manifest-shaped object whose bytes could not be read at all. */
export interface ChunkUnreadableManifest {
  name: string;
  /** The failure's own reason, verbatim (rule 1). */
  problem: string;
}

/** What reading the manifests of one listing produced. */
export interface ChunkManifestRead {
  /** The manifests whose bytes were read: the only ones content may be judged from. */
  documents: ChunkManifestDocument[];
  /** The manifest-shaped objects whose bytes could NOT be read. */
  unread: ChunkUnreadableManifest[];
}

/** One chunked file as ONE row, plus everything an action on it needs. */
export interface ChunkFileRow {
  /** The manifest object's store name (`<object>--manifest`). */
  manifestName: string;
  /** The logical object name the file is stored as. */
  objectName: string;
  /** The manifest's row in the listing: the row's `createdAt` and digest come from here. */
  manifestEntry: ObjectEntry;
  /** The parsed manifest: the part names, sizes and hashes the row describes. */
  manifest: ChunkManifest;
  /** `complete` when every recorded part is present and matches; otherwise `incomplete`. */
  status: 'complete' | 'incomplete';
  /** Parts the manifest records that the listing does not contain. */
  missing: string[];
  /** Parts present but not the bytes the manifest records. */
  mismatched: ChunkPartMismatch[];
  /** The SYNTHETIC listing entry the file row is rendered from: logical name, TOTAL size. */
  entry: ObjectEntry;
  /**
   * What a delete removes, in order: the MANIFEST FIRST, then every recorded part.
   * The manifest first makes the file invisible at once, so a failure part-way
   * leaves orphans (reported) rather than a visible file whose bytes are gone.
   * Nothing is removed until the owner confirms the COUNT.
   */
  objectNames: string[];
}

/** A manifest that is readable only as a PROBLEM: incomplete, or not a manifest at all. */
export interface ChunkReport {
  manifestName: string;
  /** The logical name the manifest name claims, or `null` when undecidable. */
  objectName: string | null;
  status: 'incomplete' | 'malformed';
  /** True when the object's BYTES could not be read, as opposed to not parsing. */
  unread: boolean;
  /** Why it could not be read as a chunk manifest. */
  problems: string[];
  missing: string[];
  mismatched: ChunkPartMismatch[];
}

/** Everything the listing needs to know about chunks, derived from ONE listing. */
export interface ChunkView {
  /** One entry per readable manifest: the chunked files of this subtree. */
  rows: ChunkFileRow[];
  /** The rows by LOGICAL object name — what an action on a rendered file row resolves to. */
  byObjectName: Map<string, ChunkFileRow>;
  /** Manifest object name → the synthetic entry that replaces it in the listing. */
  replacements: Map<string, ObjectEntry>;
  /** Object names that must NEVER be rendered as a file: readable manifests and every part. */
  hidden: Set<string>;
  /** The incomplete and malformed manifests, with what is missing or mismatched. */
  reports: ChunkReport[];
  /** Part objects claimed by NO readable manifest — an interrupted upload's leftovers. */
  orphans: string[];
  /**
   * Logical names that an UNREAD manifest-shaped object only MIGHT claim (the
   * name heuristic). An upload under one of these names must be confirmed.
   */
  uncertainClaims: string[];
  /** Plain objects that share a name with a chunked file's logical name. */
  conflicts: string[];
}

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The toast id for unreadable manifest-shaped objects: one report, one toast. */
export const CHUNK_MANIFEST_TOAST_ID = 'files-chunk-manifests';

/** The manifest-shaped object names of a listing, deduplicated — what must be READ. */
export function chunkManifestCandidates(entries: readonly ObjectEntry[]): string[] {
  return [
    ...new Set(
      entries.filter((entry) => isChunkManifestName(entry.name)).map((entry) => entry.name),
    ),
  ].sort();
}

/**
 * Read every manifest-shaped object's bytes, ONE at a time (the service rate
 * limits per client and a parallel burst buys nothing).
 *
 * A read that FAILS does not fail the listing: it becomes a
 * {@link ChunkUnreadableManifest} carrying the failure's own reason, which the
 * caller REPORTS (inline and through the toast surface). Continuing is not a
 * swallowed error here — the failure is the thing being reported, and refusing to
 * render a folder because one object could not be read would hide every other
 * file in it.
 */
export async function readChunkManifests(
  names: readonly string[],
  read: (name: string) => Promise<{ bytes: Uint8Array<ArrayBuffer> }>,
): Promise<ChunkManifestRead> {
  const documents: ChunkManifestDocument[] = [];
  const unread: ChunkUnreadableManifest[] = [];
  for (const name of names) {
    try {
      documents.push({ name, bytes: (await read(name)).bytes });
    } catch (error: unknown) {
      unread.push({ name, problem: problemText(error) });
    }
  }
  return { documents, unread };
}

/** The ONE line that reports unreadable manifest-shaped objects (panel and toast share it). */
export function unreadManifestMessage(unread: readonly ChunkUnreadableManifest[]): string {
  const named = unread.map((entry) => `${entry.name} (${entry.problem})`).join('; ');
  return (
    `${entryCount(unread.length, 'object')} whose name ends with the chunk-manifest token could not be ` +
    `read, so this app cannot tell whether they are chunked files: ${named}. They are shown as normal ` +
    `files, nothing was deleted, and an upload under a name they might claim will ask you to confirm.`
  );
}

function entryCount(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Turn ONE listing plus the manifest documents read from it into the chunk view.
 *
 * PURE. The completeness judgement is the frozen seam's (`analyseChunks`), so this
 * module never restates what "complete" means; it only decides what the owner
 * SEES for each answer.
 *
 * `loading` is the window in which the manifest-shaped objects have been
 * DISCOVERED but not yet READ. In that window this function makes NO CLAIM about
 * them: a not-yet-read manifest is neither reported as malformed (which would say
 * "this is a real file" about an object nobody has looked at) nor treated as a
 * certain chunked file. Parts stay hidden throughout — a part is never a row,
 * read or not — and the orphan report waits for the read, because an unread
 * manifest still claims its parts.
 */
export function buildChunkView(
  entries: readonly ObjectEntry[],
  documents: readonly ChunkManifestDocument[],
  unread: readonly ChunkUnreadableManifest[],
  loading = false,
): ChunkView {
  const analysis = analyseChunks(entries, documents);
  const unreadNames = new Set(unread.map((entry) => entry.name));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  // Parsed ONCE here, for the facts the analysis does not return (the total size
  // and the ordered part names). `analyseChunks` parses the same documents for its
  // status; a document this map cannot parse is exactly the one the analysis calls
  // MALFORMED, and the UI shows it as a normal file either way.
  const parsed = new Map<string, ChunkManifest | null>();
  for (const document of documents) {
    try {
      parsed.set(document.name, parseManifest(document.bytes));
    } catch {
      parsed.set(document.name, null);
    }
  }

  const rows: ChunkFileRow[] = [];
  const byObjectName = new Map<string, ChunkFileRow>();
  const replacements = new Map<string, ObjectEntry>();
  const hidden = new Set<string>();
  const reports: ChunkReport[] = [];
  const uncertainClaims: string[] = [];

  for (const report of analysis.manifests) {
    const manifest = parsed.get(report.manifestName) ?? null;
    const manifestEntry = byName.get(report.manifestName);
    if (report.status === 'malformed' || manifest === null || manifestEntry === undefined) {
      const isUnread = unreadNames.has(report.manifestName);
      // Still being read: make no claim about it at all (see the header).
      if (loading && !isUnread) continue;
      reports.push({
        manifestName: report.manifestName,
        objectName: report.objectName,
        status: 'malformed',
        unread: isUnread,
        problems:
          report.problems.length > 0
            ? report.problems
            : ['it could not be read as the chunk manifest it is named like'],
        missing: [],
        mismatched: [],
      });
      // An UNREAD manifest-shaped object might be a chunked file: its logical
      // name is an uncertain claim, so an upload under that name is confirmed.
      if (isUnread && report.objectName !== null) uncertainClaims.push(report.objectName);
      continue;
    }

    const objectName = manifest.objectName;
    // The row is rendered from the LOGICAL object: the total size is the
    // manifest's, and the two facts the store holds for the file as a whole are
    // the manifest object's own (see the header: there is no whole-file digest).
    const entry: ObjectEntry = {
      store: manifestEntry.store,
      name: objectName,
      sha256: manifestEntry.sha256,
      size: manifest.totalSize,
      createdAt: manifestEntry.createdAt,
    };
    const row: ChunkFileRow = {
      manifestName: report.manifestName,
      objectName,
      manifestEntry,
      manifest,
      status: report.status,
      missing: report.missing,
      mismatched: report.mismatched,
      entry,
      objectNames: [report.manifestName, ...manifest.parts.map((part) => part.name)],
    };
    rows.push(row);
    byObjectName.set(objectName, row);
    replacements.set(report.manifestName, entry);
    hidden.add(report.manifestName);
    if (report.status === 'incomplete') {
      reports.push({
        manifestName: report.manifestName,
        objectName,
        status: 'incomplete',
        unread: false,
        problems: [],
        missing: report.missing,
        mismatched: report.mismatched,
      });
    }
  }

  // A PART IS NEVER A ROW, whatever claims it: an orphan is reported instead. The
  // predicate is the heuristic, but the safe direction here is to hide a
  // part-shaped object from the file list and NAME it in the report — never to
  // render it as a file that a delete could then remove.
  for (const entry of entries) {
    if (isChunkPartName(entry.name)) hidden.add(entry.name);
  }

  // An unread manifest-shaped object is already reported above and its heuristic
  // logical name is already an uncertain claim; nothing further is derived here.

  const readableManifests = new Set(
    analysis.manifests
      .filter((report) => report.status !== 'malformed')
      .map((report) => report.manifestName),
  );
  const objectNames = new Set(rows.map((row) => row.objectName));
  const conflicts = entries
    .filter((entry) => !readableManifests.has(entry.name) && objectNames.has(entry.name))
    .map((entry) => entry.name);

  return {
    rows,
    byObjectName,
    replacements,
    hidden,
    reports,
    // An unread manifest may still claim its parts: no orphan claim until every
    // manifest has been read.
    orphans: loading ? [] : analysis.orphans,
    uncertainClaims: [...new Set(uncertainClaims)],
    conflicts,
  };
}

/**
 * The listing the folder view is built from: every part and every READABLE
 * manifest removed, each readable manifest replaced by its logical entry. The
 * rows a malformed or unread manifest-shaped object owns are left EXACTLY where
 * they were — that is what "renders as a normal file" means.
 */
export function visibleChunkEntries(
  entries: readonly ObjectEntry[],
  view: ChunkView,
): ObjectEntry[] {
  const visible: ObjectEntry[] = [];
  for (const entry of entries) {
    // A readable manifest is BOTH hidden and replaced: the replacement is the row,
    // so it is checked FIRST — a hidden name with no replacement (a part, or a
    // malformed manifest's own object) is simply not a row.
    const replacement = view.replacements.get(entry.name);
    if (replacement !== undefined) {
      visible.push(replacement);
      continue;
    }
    if (view.hidden.has(entry.name)) continue;
    visible.push(entry);
  }
  return visible;
}

/**
 * Every name an upload would REPLACE: the plain object names, every chunked
 * file's logical name, and the heuristic logical name of an unread manifest. The
 * overwrite gate keys on these, so a chunked file is protected by its LOGICAL
 * name rather than by the manifest object's name.
 */
export function takenObjectNames(entries: readonly ObjectEntry[], view: ChunkView): Set<string> {
  const taken = new Set(entries.map((entry) => entry.name));
  for (const row of view.rows) taken.add(row.objectName);
  for (const claim of view.uncertainClaims) taken.add(claim);
  return taken;
}

/**
 * `1 part` / `3 parts` — the chunk side of a count line. One wording, used by the
 * file row, the delete confirmation and the upload's overwrite hint.
 */
export function formatChunkPartCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'part' : 'parts'}`;
}
