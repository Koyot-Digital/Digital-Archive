import type { Thread } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { DiscordAvatar, DiscordChip } from "./discord-identity";
import {
  IconArchived,
  IconAttachment,
  IconAuthor,
  IconExternal,
  IconLock,
  IconReply,
  IconThread,
} from "./icons";

/**
 * The discussion behind a record.
 *
 * On these forum threads the sanction is the first line and the *argument* is
 * everything after it - the appeal, the correction, the second opinion, the
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
  const partial = thread.replyCount > messages.length;

  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-faint">
          <IconThread className="icon" />
          Source discussion
          {hasDiscussion ? (
            <span
              className="font-normal normal-case tracking-normal text-muted"
              // The distinction matters: a thread can have had replies deleted
              // upstream, or carry messages the scraper chose not to keep.
              title={
                partial
                  ? `${messages.length} of ${thread.replyCount} replies archived`
                  : `${messages.length} replies archived`
              }
            >
              {formatNumber(messages.length)}
              {partial ? `/${formatNumber(thread.replyCount)}` : ""}
            </span>
          ) : null}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {thread.locked ? (
            <ThreadFlag icon={IconLock} label="Thread locked - no further replies accepted" />
          ) : null}
          {thread.archived ? (
            <ThreadFlag icon={IconArchived} label="Thread archived on Discord" />
          ) : null}
          {thread.url ? (
            <a
              href={thread.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="btn btn-outline"
              title="Open the original thread on Discord"
            >
              Discord
              <IconExternal className="icon-sm" />
            </a>
          ) : null}
        </div>
      </div>

      {participants.length > 1 ? <Participants thread={thread} /> : null}

      {hasDiscussion ? (
        <ol className="card divide-y divide-line">
          {messages.map((message) => {
            const isFiler = Boolean(message.author && message.author.id === thread.author?.id);
            return (
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
                    {isFiler ? (
                      <span
                        className="text-muted"
                        title="Filed this record"
                        role="img"
                        aria-label="Filed this record"
                      >
                        <IconAuthor className="icon-sm" />
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
                  ) : null}

                  {/* Attachments live in the record's evidence gallery above,
                      so this is a pointer rather than a second gallery. */}
                  {message.imageCount ? (
                    <span
                      className="meta mt-1.5"
                      title={`${message.imageCount} attachment${
                        message.imageCount === 1 ? "" : "s"
                      } - shown in the evidence above`}
                    >
                      <IconAttachment className="icon-sm" />
                      <span aria-hidden>{message.imageCount}</span>
                      <span className="sr-only">
                        {message.imageCount} attachment
                        {message.imageCount === 1 ? "" : "s"}, shown in the evidence above
                      </span>
                    </span>
                  ) : null}

                  {!message.html && !message.imageCount ? (
                    <p className="mt-1.5 text-sm italic text-faint">No content.</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

/**
 * Icon-only thread state. The word lives in the tooltip and the a11y name.
 *
 * A 2rem square, matching `.btn`'s height, so the lock and archive flags line
 * up with the Discord button they sit beside.
 */
function ThreadFlag({
  icon: Icon,
  label,
}: {
  icon: (p: { className?: string }) => React.ReactNode;
  label: string;
}) {
  return (
    <span
      className="grid h-8 w-8 place-items-center rounded-md border border-line bg-raised text-muted"
      title={label}
      role="img"
      aria-label={label}
    >
      <Icon className="icon" />
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
            participant.role === "author" ? (
              <span className="meta" title="Filed this record">
                <IconAuthor className="icon-sm" />
                <span className="sr-only">Filed this record</span>
                <span aria-hidden>filed</span>
              </span>
            ) : (
              <span
                className="meta"
                title={`${formatNumber(participant.messageCount)} ${
                  participant.messageCount === 1 ? "reply" : "replies"
                }`}
              >
                <IconReply className="icon-sm" />
                <span aria-hidden>{formatNumber(participant.messageCount)}</span>
                <span className="sr-only">
                  {formatNumber(participant.messageCount)}{" "}
                  {participant.messageCount === 1 ? "reply" : "replies"}
                </span>
              </span>
            )
          }
        />
      ))}
    </div>
  );
}
