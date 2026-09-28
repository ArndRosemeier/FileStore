/**
 * The listing state (ledger row 9): every object in the store, as the service
 * gives it, and a way to ask again.
 *
 * WHAT THE SERVICE GIVES IS ALL THERE IS. An entry is `{store, name, sha256, size,
 * createdAt}` and nothing else (ledger row 2): no original file name, no MIME
 * type, no modified time. This hook carries the rows through unchanged, so the UI
 * cannot present a fact the store does not hold.
 *
 * ORDER: the API documents ONE filter (`?prefix=`) and NO sort, pagination or
 * cursor, so the order it answers with is not a contract. The listing is presented
 * newest-first, then by name — a DISPLAY order chosen so the file the owner just
 * uploaded is where he looks for it. The comparison is code-unit, not
 * `localeCompare`: a locale-dependent sort would make the same listing read
 * differently on two machines.
 *
 * A LISTING FAILURE IS LOUD (rule 1/2): it becomes the `failed` state for the UI
 * to render inline AND one toast through the ONE error surface. The toast carries
 * a stable id, so React's development-time double effect produces one toast, not
 * two, and a repeated failure replaces its own message instead of stacking.
 */

import { useEffect, useState } from 'react';

import { errorMessage, toastError } from '@/lib/toast';
import { listObjects, type ObjectEntry, type StoreTarget } from '@/server/store-client';

/** What the listing is doing right now. */
export type ObjectsState =
  | { status: 'loading' }
  | { status: 'ready'; objects: ObjectEntry[] }
  | { status: 'failed'; error: unknown };

/** The toast id for a listing failure: one failure, one toast. */
export const LISTING_TOAST_ID = 'files-listing';

/** Newest first, then by name — a display order (the service documents none). */
export function sortForDisplay(objects: readonly ObjectEntry[]): ObjectEntry[] {
  return [...objects].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    return 0;
  });
}

/** The display line for a listing failure — the same text the toast shows. */
export function listingErrorMessage(error: unknown): string {
  return errorMessage(error, 'Could not list the store');
}

/**
 * List the store whenever the target changes, and on demand via `refresh`.
 *
 * The effect depends on the target's three PRIMITIVE fields, not on the object,
 * so a parent that rebuilds the target each render does not re-list on every
 * render.
 */
export function useObjects(target: StoreTarget): { state: ObjectsState; refresh: () => void } {
  const { baseUrl, store, key } = target;
  const [state, setState] = useState<ObjectsState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ status: 'loading' });

    void listObjects({ baseUrl, store, key }, undefined, controller.signal).then(
      (objects) => {
        if (current) setState({ status: 'ready', objects: sortForDisplay(objects) });
      },
      (error: unknown) => {
        if (!current) return;
        setState({ status: 'failed', error });
        toastError(error, 'Could not list the store', { id: LISTING_TOAST_ID });
      },
    );

    return () => {
      current = false;
      controller.abort();
    };
  }, [baseUrl, store, key, revision]);

  return {
    state,
    refresh: () => {
      setRevision((value) => value + 1);
    },
  };
}
