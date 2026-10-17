import { and, asc, eq, inArray, notInArray, sql as raw } from "drizzle-orm";
import {
  INVERSE_RELATION,
  renderMentions,
  subjectArchivePath,
  type DiscordThread,
  type RelatedAccount,
  type SubjectPlatform,
  type SubjectRelation,
  type ThreadRole,
} from "@archive/shared";
import { db } from "../db/client.js";
import {
  discordUsers,
  modlogMessages,
  modlogParticipants,
  modlogs,
  subjectRelations,
  subjects,
} from "../db/schema.js";
import { renderBody } from "./render.js";
import { seedDiscordUsers, toDiscordIdentity, type DiscordIdentity } from "./discord-users.js";
import { upsertSubject } from "./subjects.js";

/**
 * Thread persistence: the discussion around a record, and the accounts it
 * groups together.
 *
 * Both halves are *derived* from a record's source and are rewritten whenever
 * that source is re-ingested, which is why neither is edited through the
 * moderation API. A moderator corrects a record; the thread is what the
 * source said, and the archive's job is to keep it faithfully.
 */

/* ───────────────────────────── participants ───────────────────────────── */

interface ParticipantTally {
  role: ThreadRole;
  messageCount: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

/**
 * Count each account's contribution to a thread.
 *
 * Derived from the messages rather than taken on trust, so the number next to
 * a name on the record page is always the number of messages the archive
 * actually holds - not the number the scraper happened to see.
 */
function tallyParticipants(thread: DiscordThread): Map<string, ParticipantTally> {
  const tallies = new Map<string, ParticipantTally>();

  const touch = (id: string, role: ThreadRole): ParticipantTally => {
    const existing = tallies.get(id);
    if (existing) {
      // Opening the thread outranks replying in it.
      if (role === "author") existing.role = "author";
      return existing;
    }
    const fresh: ParticipantTally = { role, messageCount: 0, firstAt: null, lastAt: null };
    tallies.set(id, fresh);
    return fresh;
  };

  // Everyone the scrape saw, so a lurking participant with no surviving
  // message still appears.
  for (const user of thread.users) touch(user.id, user.role);
  if (thread.authorId) touch(thread.authorId, "author");

  for (const message of thread.messages) {
    if (!message.authorId) continue;
    const tally = touch(message.authorId, "commenter");
    tally.messageCount += 1;
    const at = message.postedAt ?? null;
    if (at) {
      if (!tally.firstAt || at < tally.firstAt) tally.firstAt = at;
      if (!tally.lastAt || at > tally.lastAt) tally.lastAt = at;
    }
  }

  return tallies;
}

/* ───────────────────────────── the sync ───────────────────────────── */

export interface ThreadSyncResult {
  participants: number;
  messages: number;
  /** Every Discord id the thread touched, for the background refresh. */
  discordIds: string[];
}

/**
 * Write a record's thread.
 *
 * Replace-in-place rather than insert-only: a re-scrape is the authority on
 * what the thread now contains, so a deleted reply must disappear from the
 * archive too. Message rows are matched on `(modlog_id, message_id)`, so an
 * edited reply updates rather than duplicating, and the whole thing runs in
 * one transaction - a record is never left with half a discussion attached.
 */
export async function syncThread(
  modlogId: string,
  thread: DiscordThread,
): Promise<ThreadSyncResult> {
  // Identities must exist before anything can reference them.
  await seedDiscordUsers(thread.users);

  const tallies = tallyParticipants(thread);
  // Only ids that made it into discord_users can be referenced; a mention of
  // an account the scrape never described is not a participant.
  const known = tallies.size
    ? await db
        .select({ id: discordUsers.id })
        .from(discordUsers)
        .where(inArray(discordUsers.id, [...tallies.keys()]))
        .then((rows) => new Set(rows.map((r) => r.id)))
    : new Set<string>();

  /* Resolve mentions to names, so replies read as prose rather than ids. */
  const names = new Map<string, string>();
  for (const user of thread.users) {
    const name = user.displayName ?? user.username;
    if (name) names.set(user.id, name);
  }

  const messages = thread.messages
    .filter((message) => !message.authorId || known.has(message.authorId))
    .map((message, index) => {
      const source = renderMentions(message.content, names);
      const rendered = renderBody(source);
      return {
        modlogId,
        messageId: message.messageId,
        authorId: message.authorId ?? null,
        position: index,
        contentMd: source,
        contentHtml: rendered.html,
        postedAt: message.postedAt ?? null,
        editedAt: message.editedAt ?? null,
        imageCount: Math.min(message.imageUrls.length, 32_767),
      };
    });

  await db.transaction(async (tx) => {
    /* ── thread metadata on the record itself ── */
    await tx
      .update(modlogs)
      .set({
        discordPostId: thread.postId,
        discordGuildId: thread.guildId ?? null,
        discordForumId: thread.forumId ?? null,
        discordForumName: thread.forumName ?? null,
        discordAuthorId: thread.authorId && known.has(thread.authorId) ? thread.authorId : null,
        threadReplyCount: thread.replyCount,
        threadLastAt: thread.lastMessageAt ?? null,
        threadArchived: thread.archived,
        threadLocked: thread.locked,
      })
      .where(eq(modlogs.id, modlogId));

    /* ── participants ── */
    await tx.delete(modlogParticipants).where(eq(modlogParticipants.modlogId, modlogId));
    const rows = [...tallies.entries()]
      .filter(([id]) => known.has(id))
      .map(([discordId, tally]) => ({
        modlogId,
        discordId,
        role: tally.role,
        messageCount: tally.messageCount,
        firstAt: tally.firstAt,
        lastAt: tally.lastAt,
      }));
    if (rows.length) await tx.insert(modlogParticipants).values(rows);

    /* ── messages ── */
    if (messages.length) {
      await tx
        .insert(modlogMessages)
        .values(messages)
        .onConflictDoUpdate({
          target: [modlogMessages.modlogId, modlogMessages.messageId],
          set: {
            authorId: raw`excluded.author_id`,
            position: raw`excluded.position`,
            contentMd: raw`excluded.content_md`,
            contentHtml: raw`excluded.content_html`,
            postedAt: raw`excluded.posted_at`,
            editedAt: raw`excluded.edited_at`,
            imageCount: raw`excluded.image_count`,
          },
        });

      // A reply the source no longer has was deleted upstream; the archive
      // follows, because the thread is a copy and not a record of its own.
      await tx.delete(modlogMessages).where(
        and(
          eq(modlogMessages.modlogId, modlogId),
          notInArray(
            modlogMessages.messageId,
            messages.map((m) => m.messageId),
          ),
        ),
      );
    } else {
      await tx.delete(modlogMessages).where(eq(modlogMessages.modlogId, modlogId));
    }
  });

  return {
    participants: [...tallies.keys()].filter((id) => known.has(id)).length,
    messages: messages.length,
    discordIds: [...tallies.keys()],
  };
}

/* ───────────────────────────── alt groupings ───────────────────────────── */

/**
 * Link the other accounts a record named.
 *
 * Each named account gets a `subjects` row of its own - with a `log_count` of
 * zero, since the sanction is filed under the primary account - so that
 * visiting its URL lands on a real page that points at the record, rather
 * than a 404 that hides the connection.
 *
 * Groupings cross platforms: the Discord forum routinely names a Discord
 * account and the Roblox account behind it in one title. That is why the
 * table keys on surrogate subject ids rather than raw account numbers - a
 * link between a snowflake and a Roblox id has no meaning as a pair of
 * integers.
 */
export async function syncRelatedAccounts(
  modlogId: string,
  subjectId: string,
  related: RelatedAccount[],
): Promise<number> {
  const unique = new Map<string, RelatedAccount>();
  for (const account of related) {
    unique.set(`${account.platform}:${account.externalId}`, account);
  }
  if (!unique.size) return 0;

  const rows: {
    subjectId: string;
    relatedSubjectId: string;
    relation: SubjectRelation;
    assertedBy: string;
  }[] = [];

  for (const account of unique.values()) {
    const other = await upsertSubject({
      platform: account.platform,
      externalId: account.externalId,
      username: account.username,
    });
    // A title that names the same account twice, or names the subject again
    // alongside itself, must not produce a self-referential row.
    if (other.id === subjectId) continue;

    rows.push({
      subjectId,
      relatedSubjectId: other.id,
      relation: account.relation,
      assertedBy: modlogId,
    });
    // The mirror row, worded from the other account's side.
    rows.push({
      subjectId: other.id,
      relatedSubjectId: subjectId,
      relation: INVERSE_RELATION[account.relation],
      assertedBy: modlogId,
    });
  }

  if (!rows.length) return 0;

  await db
    .insert(subjectRelations)
    .values(rows)
    .onConflictDoUpdate({
      target: [subjectRelations.subjectId, subjectRelations.relatedSubjectId],
      set: {
        relation: raw`excluded.relation`,
        assertedBy: raw`excluded.asserted_by`,
      },
    });

  return rows.length / 2;
}

/* ───────────────────────────── reads ───────────────────────────── */

export interface PublicThreadMessage {
  messageId: string;
  position: number;
  html: string;
  postedAt: string | null;
  editedAt: string | null;
  imageCount: number;
  author: DiscordIdentity | null;
}

export interface PublicParticipant extends DiscordIdentity {
  role: ThreadRole;
  messageCount: number;
}

export interface PublicThread {
  postId: string | null;
  guildId: string | null;
  forumName: string | null;
  url: string | null;
  replyCount: number;
  archived: boolean;
  locked: boolean;
  lastMessageAt: string | null;
  author: DiscordIdentity | null;
  participants: PublicParticipant[];
  messages: PublicThreadMessage[];
}

/**
 * One record's thread, with every identity inlined.
 *
 * Two queries regardless of thread length: the identities are collected from
 * both the participant list and the message authors and fetched together,
 * because a 40-reply thread rendering 40 avatars must not become 40 queries.
 */
export async function getThread(
  modlogId: string,
  options: { includeHidden?: boolean } = {},
): Promise<PublicThread | null> {
  const record = await db
    .select({
      discordPostId: modlogs.discordPostId,
      discordGuildId: modlogs.discordGuildId,
      discordForumName: modlogs.discordForumName,
      discordAuthorId: modlogs.discordAuthorId,
      sourceUrl: modlogs.sourceUrl,
      threadReplyCount: modlogs.threadReplyCount,
      threadArchived: modlogs.threadArchived,
      threadLocked: modlogs.threadLocked,
      threadLastAt: modlogs.threadLastAt,
    })
    .from(modlogs)
    .where(eq(modlogs.id, modlogId))
    .limit(1)
    .then((r) => r[0]);

  if (!record?.discordPostId) return null;

  const [participantRows, messageRows] = await Promise.all([
    db
      .select({
        role: modlogParticipants.role,
        messageCount: modlogParticipants.messageCount,
        user: discordUsers,
      })
      .from(modlogParticipants)
      .innerJoin(discordUsers, eq(discordUsers.id, modlogParticipants.discordId))
      .where(eq(modlogParticipants.modlogId, modlogId))
      .orderBy(asc(modlogParticipants.role), raw`${modlogParticipants.messageCount} desc`),
    db
      .select({ message: modlogMessages, author: discordUsers })
      .from(modlogMessages)
      .leftJoin(discordUsers, eq(discordUsers.id, modlogMessages.authorId))
      .where(
        and(
          eq(modlogMessages.modlogId, modlogId),
          options.includeHidden ? raw`true` : eq(modlogMessages.status, "published"),
        ),
      )
      .orderBy(asc(modlogMessages.position), asc(modlogMessages.id)),
  ]);

  const participants: PublicParticipant[] = participantRows.map((row) => ({
    ...toDiscordIdentity(row.user),
    role: row.role,
    messageCount: row.messageCount,
  }));

  return {
    postId: record.discordPostId,
    guildId: record.discordGuildId,
    forumName: record.discordForumName,
    url: record.sourceUrl,
    replyCount: record.threadReplyCount,
    archived: record.threadArchived,
    locked: record.threadLocked,
    lastMessageAt: record.threadLastAt?.toISOString() ?? null,
    author:
      participants.find((p) => p.id === record.discordAuthorId) ??
      (record.discordAuthorId
        ? (participants.find((p) => p.role === "author") ?? null)
        : null),
    participants,
    messages: messageRows.map((row) => ({
      messageId: row.message.messageId,
      position: row.message.position,
      html: row.message.contentHtml,
      postedAt: row.message.postedAt?.toISOString() ?? null,
      editedAt: row.message.editedAt?.toISOString() ?? null,
      imageCount: row.message.imageCount,
      author: row.author ? toDiscordIdentity(row.author) : null,
    })),
  };
}

export interface PublicRelatedAccount {
  subjectId: string;
  platform: SubjectPlatform;
  externalId: string;
  username: string | null;
  relation: SubjectRelation;
  logCount: number;
  archiveUrl: string;
  /** The record that asserted the link, so the claim can be checked. */
  assertedBy: string | null;
}

/** Accounts grouped with this one, in either direction. */
export async function getRelatedAccounts(subjectId: string): Promise<PublicRelatedAccount[]> {
  const rows = await db
    .select({
      relation: subjectRelations.relation,
      assertedBy: subjectRelations.assertedBy,
      subject: subjects,
    })
    .from(subjectRelations)
    .innerJoin(subjects, eq(subjects.id, subjectRelations.relatedSubjectId))
    .where(eq(subjectRelations.subjectId, subjectId))
    .orderBy(asc(subjectRelations.relation), raw`${subjects.logCount} desc`);

  return rows.map((row) => ({
    subjectId: row.subject.id,
    platform: row.subject.platform,
    externalId: row.subject.externalId.toString(),
    username: row.subject.username,
    relation: row.relation,
    logCount: row.subject.logCount,
    archiveUrl: subjectArchivePath(row.subject.platform, row.subject.externalId.toString()),
    assertedBy: row.assertedBy,
  }));
}
