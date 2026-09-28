/**
 * Reading the manifests the current listing implies (ledger row 12, slice B).
 *
 * A listing carries only `name`, `size`, `sha256` and `createdAt` — never
 * content — so whether a manifest-shaped object IS a chunk manifest cannot be
 * decided from the listing (`src/lib/chunk.ts` says so, and `docs/BOARD.md`
 * records the measured collision). This hook is the ONE place the app pays for
 * that: for every manifest-shaped name in the listing it fetches the object and
 * hands the bytes to the pure view builder (`src/features/files/chunks.ts`).
 *
 * ONE READ AT A TIME, and a failure is REPORTED rather than fatal: an object whose
 * bytes cannot be read is not hidden and does not blank the folder — it stays a
 * normal file row and is named, with its reason, in the report panel and through
 * the ONE error surface. The toast carries a stable id, so React's
 * development-time double effect replaces one message instead of stacking two.
 *
 * The effect depends on the manifest names as a PRIMITIVE string, not on the
 * listing array: the parent rebuilds that array on every render, and depending on
 * its identity would re-read every manifest on every render.
 */

import { useEffect, useState } from 'react';

import {
  CHUNK_MANIFEST_TOAST_ID,
  chunkManifestCandidates,
  readChunkManifests,
  unreadManifestMessage,
  type ChunkManifestRead,
} from '@/features/files/chunks';
import { toastError } from '@/lib/toast';
import { getObject, type ObjectEntry, type StoreTarget } from '@/server/store-client';

/**
 * What the manifests of the current listing yielded, and whether the read is
 * still running. `loading` is load-bearing: while it is true the view makes NO
 * claim about a manifest-shaped object, so the owner is never told "this is a
 * real file" about an object nobody has read yet.
 */
export interface ChunkManifestsState extends ChunkManifestRead {
  loading: boolean;
}

const EMPTY: ChunkManifestsState = { documents: [], unread: [], loading: false };

/**
 * Read every manifest-shaped object of `entries`, re-reading whenever the set of
 * such names changes (a new upload, a refresh, a navigation).
 */
export function useChunkManifests(
  target: StoreTarget,
  entries: readonly ObjectEntry[],
): ChunkManifestsState {
  const { baseUrl, store, key } = target;
  const manifestKey = chunkManifestCandidates(entries).join('\n');
  const [state, setState] = useState<ChunkManifestsState>(EMPTY);

  useEffect(() => {
    const names = manifestKey === '' ? [] : manifestKey.split('\n');
    if (names.length === 0) {
      setState(EMPTY);
      return;
    }

    let current = true;
    setState({ documents: [], unread: [], loading: true });
    void readChunkManifests(names, (name) => getObject({ baseUrl, store, key }, name)).then(
      (read) => {
        if (!current) return;
        setState({ ...read, loading: false });
        if (read.unread.length > 0) {
          // REPORTED, never hidden (rule 2): the panel is the detail, this is the
          // surface that makes sure it was noticed.
          toastError(
            new Error(unreadManifestMessage(read.unread)),
            'Could not read every object that looks like a chunk manifest',
            { id: CHUNK_MANIFEST_TOAST_ID },
          );
        }
      },
      (error: unknown) => {
        // `readChunkManifests` reports a per-object failure itself and does not
        // reject; a rejection here is a defect in that seam, and it is surfaced
        // rather than swallowed.
        if (!current) return;
        setState({
          documents: [],
          unread: names.map((name) => ({ name, problem: String(error) })),
          loading: false,
        });
        toastError(error, 'Could not read the objects that look like chunk manifests', {
          id: CHUNK_MANIFEST_TOAST_ID,
        });
      },
    );

    return () => {
      current = false;
    };
  }, [baseUrl, store, key, manifestKey]);

  return state;
}
