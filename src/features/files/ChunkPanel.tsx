/**
 * The chunk REPORT panel (ledger row 12, slice B): what the listing implies about
 * chunked files that is NOT a row.
 *
 * IT REPORTS AND NEVER ACTS. There is no button in this component, because every
 * state it shows is one the app must not resolve on its own:
 *
 *  * an INCOMPLETE manifest — a chunked file whose parts are not all there, named
 *    one by one, with what is missing or does not match;
 *  * an apparent manifest that could not be READ, or that does not parse — which
 *    is a NORMAL FILE, shown as a normal file row and named here so the ambiguity
 *    is visible rather than silently resolved in either direction;
 *  * ORPHANED PARTS — objects no readable manifest claims, which is exactly what
 *    an interrupted upload leaves. They are named, and NOTHING deletes them: a
 *    sweep is a separate, destructive slice with its own confirmation.
 *  * a name a PLAIN object and a chunk manifest both claim — two representations
 *    of one logical file. Both stay visible; the owner decides.
 *
 * The panel is the detail behind the ONE error surface: an unreadable manifest is
 * also toasted (with a stable id) where the listing is read
 * (`src/features/files/useChunkManifests.ts`), so a failure cannot pass unnoticed
 * just because it did not break the listing.
 */

import type { ChunkView } from '@/features/files/chunks';
import { formatObjectCount } from '@/lib/format';

export interface ChunkPanelProps {
  view: ChunkView;
}

export function ChunkPanel({ view }: ChunkPanelProps): React.JSX.Element | null {
  const incomplete = view.reports.filter((report) => report.status === 'incomplete');
  const malformed = view.reports.filter((report) => report.status === 'malformed');
  const hasAnything =
    incomplete.length > 0 ||
    malformed.length > 0 ||
    view.orphans.length > 0 ||
    view.conflicts.length > 0;
  if (!hasAnything) return null;

  return (
    <section
      aria-labelledby="chunk-report-heading"
      className="rounded-lg border border-edge bg-surface-raised p-4 text-sm"
    >
      <h3 id="chunk-report-heading" className="font-medium">
        Chunked files that need attention
      </h3>
      <p className="mt-1 text-ink-muted">
        This is a report. Nothing here deletes or repairs anything — a repair is a separate step
        with its own confirmation.
      </p>

      {incomplete.length > 0 && (
        <div className="mt-3">
          <h4 className="font-medium">Incomplete chunked files</h4>
          <ul className="mt-1 space-y-2">
            {incomplete.map((report) => (
              <li key={report.manifestName}>
                <code className="break-all">{report.objectName ?? report.manifestName}</code>
                {report.missing.length > 0 && (
                  <ul className="mt-1 text-danger">
                    {report.missing.map((name) => (
                      <li key={name}>
                        missing part <code className="break-all">{name}</code>
                      </li>
                    ))}
                  </ul>
                )}
                {report.mismatched.length > 0 && (
                  <ul className="mt-1 text-danger">
                    {report.mismatched.map((part) => (
                      <li key={part.name}>
                        <code className="break-all">{part.name}</code>: {part.problem}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {malformed.length > 0 && (
        <div className="mt-3">
          <h4 className="font-medium">Objects that only LOOK like a chunk manifest</h4>
          <ul className="mt-1 space-y-2">
            {malformed.map((report) => (
              <li key={report.manifestName}>
                <code className="break-all">{report.manifestName}</code>{' '}
                {report.unread
                  ? 'could not be read, so this app cannot tell whether it is a chunked file'
                  : 'is not a chunk manifest, so it is shown as a normal file'}
                :{' '}
                {report.problems.map((problem) => (
                  <span key={problem}>{problem} </span>
                ))}
                <span className="text-ink-muted">
                  It is still listed as a normal file, and it was NOT deleted.
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.conflicts.length > 0 && (
        <div className="mt-3">
          <h4 className="font-medium">One name, two representations</h4>
          <ul className="mt-1 list-inside list-disc">
            {view.conflicts.map((name) => (
              <li key={name}>
                <code className="break-all">{name}</code> exists as a plain object AND as a chunked
                file. Both are shown; nothing was removed.
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.orphans.length > 0 && (
        <div className="mt-3">
          <h4 className="font-medium">Parts that belong to no chunked file</h4>
          <p className="text-ink-muted">
            {formatObjectCount(view.orphans.length)} left behind by an upload that did not finish,
            or by a version that was replaced. They are not files and this app will not delete them.
          </p>
          <ul className="mt-1">
            {view.orphans.map((name) => (
              <li key={name}>
                <code className="break-all">{name}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
