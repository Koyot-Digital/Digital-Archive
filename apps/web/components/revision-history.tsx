import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";

/**
 * Edit history.
 *
 * The Wikipedia part of the design: nothing in the archive changes silently.
 * Each entry is the state *before* an edit, together with the reason the
 * editor gave, so a reader can see what a record used to say and why it was
 * changed.
 *
 * Rendered as its own async component so a slow history query streams in
 * after the record body rather than delaying it.
 */
export async function RevisionHistory({
  logId,
  currentRevision,
}: {
  logId: string;
  currentRevision: number;
}) {
  if (currentRevision <= 1) {
    return (
      <section className="mt-10 border-t border-line pt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">Edit history</h2>
        <p className="mt-2 text-sm text-muted">
          This record has not been edited since it was archived.
        </p>
      </section>
    );
  }

  const data = await api.revisions(logId).catch(() => null);

  return (
    <section className="mt-10 border-t border-line pt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">Edit history</h2>
        <span className="text-2xs text-faint">
          {formatNumber(currentRevision)} revision{currentRevision === 1 ? "" : "s"}
        </span>
      </div>

      {!data?.revisions.length ? (
        <p className="mt-2 text-sm text-muted">History is unavailable.</p>
      ) : (
        <ol className="mt-4 space-y-0">
          {data.revisions.map((revision, index) => (
            <li key={revision.revision} className="relative flex gap-3 pb-5 last:pb-0">
              {/* Timeline rail */}
              {index < data.revisions.length - 1 ? (
                <span aria-hidden className="absolute left-[7px] top-4 h-full w-px bg-line" />
              ) : null}
              <span
                aria-hidden
                className="relative mt-1.5 h-[15px] w-[15px] shrink-0 rounded-full border-2 border-bg bg-line-strong"
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-fg">
                    Revision {revision.revision}
                  </span>
                  <time dateTime={revision.createdAt} className="text-2xs text-faint">
                    {formatDateTime(revision.createdAt)}
                  </time>
                  {revision.changedByKey ? (
                    <span className="chip">automated</span>
                  ) : revision.changedBy ? (
                    <span className="chip">moderator</span>
                  ) : null}
                </div>

                {revision.changeReason ? (
                  <p className="mt-1 text-sm leading-6 text-muted">{revision.changeReason}</p>
                ) : (
                  <p className="mt-1 text-sm italic text-faint">No reason recorded.</p>
                )}

                {typeof revision.snapshot.title === "string" ? (
                  <p className="mt-1 truncate text-2xs text-faint">
                    Title was: <span className="text-muted">{revision.snapshot.title}</span>
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
