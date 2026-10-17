import type { Thread } from "@/lib/api";
import { cx, formatDateTime, formatNumber } from "@/lib/format";
import { DiscordAvatar, DiscordChip } from "./discord-identity";

/**
 * The discussion behind a record.
 *
 * On these forum threads the sanction is the first line and the *argument* is
 * everything after it — the appeal, the correction, the second opinion, the
 * decision to escalate a suspension to a ban. Showing the record without the
 * discussion would present the sanction as more settled than it was, so the
 * thread is rendered in full rather than summarised.
 *
 * Message HTML arrives pre-rendered and pre-sanitised from the API (see
 * services/render.ts), so this component does no markdown work and makes no
 * third-party requests beyond the avatars.
 */
export function ThreadPanel({ thread }: { thread: Thread | null | undefined }) {
  if (!thread) return null;

  const { messages, participants } = thread;
  // A thread with no surviving replies still has provenance worth showing.
  const hasDiscussion = messages.length > 0;

  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">
            Source discussion
          </h2>
          <p className="mt-1 text-sm text-muted">
            {hasDiscussion ? (
              <>
                {formatNumber(messages.length)}{" "}
                {messages.length === 1 ? "reply" : "replies"} archived
                {thread.replyCount > messages.length ? (
                  <> of {formatNumber(thread.replyCount)} on the thread</>
                ) : null}
              </>
            ) : (
              "No replies were archived for this thread."
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {thread.locked ? <ThreadFlag>Locked</ThreadFlag> : null}
          {thread.archived ? <ThreadFlag>Archived</ThreadFlag> : null}
          {thread.url ? (
            <a
              href={thread.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="btn btn-outline"
            >
              Open in Discord ↗
            </a>
          ) : null}
        </div>
      </div>

      {participants.length > 1 ? <Participants thread={thread} /> : null}

      {hasDiscussion ? (
        <ol className="card divide-y divide-line">
          {messages.map((message) => (
            <li key={message.messageId} className="flex gap-3 p-4">
              {message.author ? (
                <DiscordAvatar user={message.author} size="md" />
              ) : (
                <span
                  title="The account that wrote this reply is no longer known"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-raised text-2xs text-faint"
                >
                  ?
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-fg">
                    {message.author?.displayName ??
                      message.author?.username ??
                      "Unknown account"}
                  </span>
                  {message.author && message.author.id === thread.author?.id ? (
                    <span className="rounded bg-accent/15 px-1 text-2xs font-semibold uppercase tracking-wide text-accent">
                      filed this
                    </span>
                  ) : null}
                  <span className="text-xs text-faint">{formatDateTime(message.postedAt)}</span>
                  {message.editedAt ? (
                    <span className="text-xs text-faint" title={formatDateTime(message.editedAt)}>
                      (edited)
                    </span>
                  ) : null}
                </div>

                {message.html ? (
                  <div
                    className="prose-archive prose-archive-tight mt-1.5"
                    // Sanitised server-side before it was ever stored.
                    dangerouslySetInnerHTML={{ __html: message.html }}
                  />
                ) : (
                  <p className="mt-1.5 text-sm italic text-faint">
                    {message.imageCount
                      ? "Attachment only — see the evidence above."
                      : "No text content."}
                  </p>
                )}

                {message.imageCount ? (
                  <p className="mt-1.5 text-2xs text-faint">
                    {message.imageCount} attachment
                    {message.imageCount === 1 ? "" : "s"} — included in the evidence above
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function ThreadFlag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-raised px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-muted">
      {children}
    </span>
  );
}

/** Who took part, ordered by how much they said. */
function Participants({ thread }: { thread: Thread }) {
  return (
    <div className="card mb-4 flex flex-wrap gap-x-5 gap-y-3 p-4">
      {thread.participants.map((participant) => (
        <DiscordChip
          key={participant.id}
          user={participant}
          subtitle={
            <span className={cx(participant.role === "author" && "text-accent")}>
              {participant.role === "author"
                ? "filed the record"
                : `${formatNumber(participant.messageCount)} ${
                    participant.messageCount === 1 ? "reply" : "replies"
                  }`}
            </span>
          }
        />
      ))}
    </div>
  );
}
