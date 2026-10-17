-- ───────────────────────────────────────────────────────────────────────────
--  0002 - Discord forum provenance
--
--  The archive's first real data source is a Discord forum channel, where one
--  thread is one moderation event. A thread carries three things the original
--  schema had nowhere to put:
--
--    * who posted it and who argued about it, as Discord accounts;
--    * the discussion itself, which is frequently where the appeal, the
--      correction and the second opinion live;
--    * other Roblox accounts named in the same title - alts, or an account
--      that was abandoned for a new one.
--
--  Discord identities get their own table rather than being denormalised onto
--  every record: eighteen moderators wrote five hundred of these threads, and
--  a username or avatar that changes should change in one row, not five
--  hundred. It is also a cache - scraped values seed it, the Discord API
--  refreshes it - so it needs its own freshness bookkeeping.
-- ───────────────────────────────────────────────────────────────────────────

-- ───────────────────────── discord identities ─────────────────────────

CREATE TABLE discord_users (
  -- Snowflake. Text, not bigint: it is an opaque identifier everywhere it is
  -- used, and Discord's own API treats it as a string for exactly that reason.
  id             varchar(24) PRIMARY KEY,
  username       varchar(64),
  -- The "display name" Discord shows above a message, when one is set.
  global_name    varchar(64),
  -- Avatar hash, kept so a CDN URL can be rebuilt at any size.
  avatar         varchar(128),
  avatar_url     varchar(2048),
  bot            boolean     NOT NULL DEFAULT false,

  -- Provenance of the values above. A row seeded from a scrape is usable but
  -- stale; one resolved through the API is authoritative until it expires.
  resolved_from  varchar(16) NOT NULL DEFAULT 'scrape'
                 CHECK (resolved_from IN ('scrape', 'discord_api')),
  fetched_at     timestamptz,
  -- Consecutive failures. A deleted account 404s forever; backing off stops
  -- an import from spending its whole rate-limit budget on the same ghost.
  fetch_failures smallint    NOT NULL DEFAULT 0,
  fetch_error    text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The refresh sweep asks for the least recently resolved rows first, and
-- treats a never-fetched row as infinitely stale.
CREATE INDEX discord_users_staleness_idx
  ON discord_users (fetched_at NULLS FIRST, fetch_failures);
CREATE INDEX discord_users_username_idx ON discord_users (lower(username));

CREATE TRIGGER discord_users_touch BEFORE UPDATE ON discord_users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ───────────────────────── thread provenance ─────────────────────────

ALTER TABLE modlogs
  ADD COLUMN discord_post_id    varchar(24),
  ADD COLUMN discord_guild_id   varchar(24),
  ADD COLUMN discord_forum_id   varchar(24),
  ADD COLUMN discord_forum_name varchar(128),
  -- The moderator who opened the thread. ON DELETE SET NULL, not CASCADE:
  -- pruning an identity must never delete a moderation record.
  ADD COLUMN discord_author_id  varchar(24) REFERENCES discord_users(id) ON DELETE SET NULL,
  ADD COLUMN thread_reply_count integer     NOT NULL DEFAULT 0,
  ADD COLUMN thread_last_at     timestamptz,
  ADD COLUMN thread_archived    boolean     NOT NULL DEFAULT false,
  ADD COLUMN thread_locked      boolean     NOT NULL DEFAULT false,
  -- Support ticket reference as written, e.g. '#6066'.
  ADD COLUMN ticket_ref         varchar(32);

-- One thread is one record. Partial, because every other source has no post.
CREATE UNIQUE INDEX modlogs_discord_post_key
  ON modlogs (discord_post_id) WHERE discord_post_id IS NOT NULL;
CREATE INDEX modlogs_discord_author_idx
  ON modlogs (discord_author_id) WHERE discord_author_id IS NOT NULL;
CREATE INDEX modlogs_ticket_idx
  ON modlogs (ticket_ref) WHERE ticket_ref IS NOT NULL;

-- ───────────────────────── who was in the thread ─────────────────────────

CREATE TABLE modlog_participants (
  modlog_id     char(16)    NOT NULL REFERENCES modlogs(id) ON DELETE CASCADE,
  discord_id    varchar(24) NOT NULL REFERENCES discord_users(id) ON DELETE CASCADE,
  -- 'author' opened the thread; 'commenter' replied in it.
  role          varchar(16) NOT NULL DEFAULT 'commenter'
                CHECK (role IN ('author', 'commenter')),
  message_count integer     NOT NULL DEFAULT 0,
  first_at      timestamptz,
  last_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (modlog_id, discord_id)
);

CREATE INDEX modlog_participants_user_idx ON modlog_participants (discord_id, role);

-- ───────────────────────── the discussion ─────────────────────────

CREATE TABLE modlog_messages (
  id           bigserial   PRIMARY KEY,
  modlog_id    char(16)    NOT NULL REFERENCES modlogs(id) ON DELETE CASCADE,
  -- Discord message snowflake. Scoped to the record, not globally unique, so
  -- re-ingesting a thread updates its replies instead of duplicating them.
  message_id   varchar(24) NOT NULL,
  author_id    varchar(24) REFERENCES discord_users(id) ON DELETE SET NULL,
  position     smallint    NOT NULL DEFAULT 0,
  content_md   text        NOT NULL DEFAULT '',
  -- Sanitised on write, exactly like a record body: the discussion is
  -- user-written text from outside the archive and is never trusted.
  content_html text        NOT NULL DEFAULT '',
  posted_at    timestamptz,
  edited_at    timestamptz,
  image_count  smallint    NOT NULL DEFAULT 0,
  status       varchar(16) NOT NULL DEFAULT 'published'
               CHECK (status IN ('published', 'hidden', 'removed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX modlog_messages_key ON modlog_messages (modlog_id, message_id);
CREATE INDEX modlog_messages_modlog_idx ON modlog_messages (modlog_id, position);
CREATE INDEX modlog_messages_author_idx
  ON modlog_messages (author_id) WHERE author_id IS NOT NULL;

-- ───────────────────────── alt groupings ─────────────────────────

-- Stored in both directions so either account's page can show the link
-- without a UNION, and with the relation worded from each side: "A moved to
-- B" must not read as "B moved to A" on B's page.
CREATE TABLE subject_relations (
  roblox_id         bigint      NOT NULL REFERENCES subjects(roblox_id) ON DELETE CASCADE,
  related_roblox_id bigint      NOT NULL REFERENCES subjects(roblox_id) ON DELETE CASCADE,
  relation          varchar(16) NOT NULL DEFAULT 'alt'
                    CHECK (relation IN ('alt', 'successor', 'predecessor', 'related')),
  -- The record that asserted the link, so a reader can check the claim.
  asserted_by       char(16)    REFERENCES modlogs(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (roblox_id, related_roblox_id),
  CONSTRAINT subject_relations_not_self CHECK (roblox_id <> related_roblox_id)
);

CREATE INDEX subject_relations_related_idx ON subject_relations (related_roblox_id);

-- ───────────────────────── search ─────────────────────────

-- A ticket number is how moderators refer to these records among themselves,
-- so '#6066' has to be a working query. Weight B: below the title and the
-- subject's names, above the body.
DROP FUNCTION IF EXISTS modlog_search_vector(text, text, text[], text, text, text);

CREATE OR REPLACE FUNCTION modlog_search_vector(
  p_title text, p_subject_terms text, p_tags text[],
  p_reason text, p_source text, p_body text, p_refs text
) RETURNS tsvector
LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(p_title, '')), 'A')
      || setweight(to_tsvector('simple',  coalesce(p_subject_terms, '')), 'A')
      || setweight(to_tsvector('simple',  array_to_string(coalesce(p_tags, '{}'), ' ')), 'B')
      || setweight(to_tsvector('english', coalesce(p_reason, '')), 'B')
      || setweight(to_tsvector('simple',  coalesce(p_refs, '')), 'B')
      || setweight(to_tsvector('simple',  coalesce(p_source, '')), 'C')
      || setweight(to_tsvector('english', left(coalesce(p_body, ''), 40000)), 'D');
$$;

-- The '#' is stripped so both '#6066' and '6066' match: websearch_to_tsquery
-- drops the punctuation from the query side either way.
CREATE OR REPLACE FUNCTION modlog_search_refs(p_ticket text, p_post_id text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT trim(both ' ' FROM
           coalesce(replace(p_ticket, '#', ''), '') || ' ' || coalesce(p_post_id, ''));
$$;

CREATE OR REPLACE FUNCTION modlogs_search_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := modlog_search_vector(
    NEW.title, subject_search_terms(NEW.roblox_id),
    NEW.tags, NEW.reason, NEW.source, NEW.body_md,
    modlog_search_refs(NEW.ticket_ref, NEW.discord_post_id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER modlogs_search ON modlogs;
CREATE TRIGGER modlogs_search BEFORE INSERT OR UPDATE OF
  title, reason, body_md, tags, source, roblox_id, ticket_ref, discord_post_id ON modlogs
  FOR EACH ROW EXECUTE FUNCTION modlogs_search_refresh();

CREATE OR REPLACE FUNCTION subjects_cascade_search() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE modlogs m
     SET search_vector = modlog_search_vector(
           m.title, subject_search_terms(NEW.roblox_id),
           m.tags, m.reason, m.source, m.body_md,
           modlog_search_refs(m.ticket_ref, m.discord_post_id)
         )
   WHERE m.roblox_id = NEW.roblox_id;
  RETURN NULL;
END;
$$;

-- Existing rows predate the ticket column, so their vectors need rebuilding.
UPDATE modlogs SET search_vector = modlog_search_vector(
  title, subject_search_terms(roblox_id), tags, reason, source, body_md,
  modlog_search_refs(ticket_ref, discord_post_id)
);

-- Keep modlog_messages.image_count honest about what is actually attached.
-- Replies are not separately galleried - their attachments join the record's
-- evidence - but the count tells a reader which message brought what.
CREATE OR REPLACE FUNCTION modlogs_thread_recount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE modlogs m
     SET thread_reply_count = (
           SELECT count(*) FROM modlog_messages x
            WHERE x.modlog_id = coalesce(NEW.modlog_id, OLD.modlog_id)
              AND x.status = 'published'
         )
   WHERE m.id = coalesce(NEW.modlog_id, OLD.modlog_id)
     -- Only trust the derived count once replies have actually been stored;
     -- the scraper's own reply_count includes messages it chose not to keep.
     AND m.thread_reply_count <= (
           SELECT count(*) FROM modlog_messages x
            WHERE x.modlog_id = coalesce(NEW.modlog_id, OLD.modlog_id)
         );
  RETURN NULL;
END;
$$;

CREATE TRIGGER modlog_messages_recount
  AFTER INSERT OR DELETE OR UPDATE OF status ON modlog_messages
  FOR EACH ROW EXECUTE FUNCTION modlogs_thread_recount();
