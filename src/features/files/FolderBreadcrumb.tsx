/**
 * The breadcrumb (ledger row 10, slice 2): every ancestor of the current folder,
 * so the owner can walk back up.
 *
 * The crumbs come from `src/lib/folder.ts#ancestors`, which is the ONE place the
 * breadcrumb order is defined: ROOT FIRST, including the current folder. The
 * root's crumb is labelled with the STORE's name (`files`), because the root of
 * the app's folder tree IS the store; every other crumb is its segment.
 *
 * The current folder is rendered as text with `aria-current="page"`, not as a
 * button: navigating to where you already are is a no-op that would look like a
 * control. Every ANCESTOR is a button, which is the point of the component.
 */

import { ancestors, formatFolderPath, type FolderPath } from '@/lib/folder';

export interface FolderBreadcrumbProps {
  /** The store's name, used as the root crumb's label. */
  store: string;
  /** The folder being viewed. */
  current: FolderPath;
  /** Called with the ancestor's path when its crumb is clicked. */
  onNavigate: (path: FolderPath) => void;
}

export function FolderBreadcrumb({
  store,
  current,
  onNavigate,
}: FolderBreadcrumbProps): React.JSX.Element {
  const crumbs = ancestors(current);
  const lastIndex = crumbs.length - 1;

  return (
    <nav aria-label="Folder path">
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((path, index) => {
          const label = path.length === 0 ? store : path[path.length - 1];
          return (
            <li key={formatFolderPath(path)} className="flex items-center gap-1">
              {index > 0 ? (
                <span aria-hidden="true" className="text-ink-muted">
                  /
                </span>
              ) : null}
              {index === lastIndex ? (
                <span aria-current="page" className="font-medium">
                  {label}
                </span>
              ) : (
                <button
                  type="button"
                  className="border-edge rounded border px-2 py-0.5"
                  onClick={() => {
                    onNavigate(path);
                  }}
                >
                  {label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
