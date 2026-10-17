-- ════════════════════════════════════════════════════════════════════════════
--  Digital Archive — initial schema
--
--  Design notes:
--   * Public ids are fixed-width char(16) so the URL space is predictable and
--     comparisons stay index-friendly.
--   * search_vector is maintained by triggers rather than declared GENERATED:
--     array_to_string() is only STABLE, which Postgres refuses in a generated
--     column, and the trigger lets us weight fields.
--   * Counter columns (subjects.log_count, modlogs.image_count) are recomputed
--     from the source rows on every change. Slightly more work per write, but
--     they can never drift, which matters for an archive that is edited by
--     hand as well as by scrapers.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────────── identity ─────────────────────────────

CREATE TABLE users (
  id            char(16) PRIMARY KEY,
  discord_id    varchar(32)  NOT NULL,
  username      varchar(64)  NOT NULL,
  global_name   varchar(64),
  avatar        varchar(128),
  role          varchar(16)  NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer', 'moderator', 'admin')),
  disabled      boolean      NOT NULL DEFAULT false,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_discord_id_key ON users (discord_id);
CREATE INDEX users_role_idx ON users (role);

CREATE TABLE sessions (
  token_hash   char(64) PRIMARY KEY,
  user_id      char(16)    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           varchar(64),
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE api_keys (
  id                 char(16) PRIMARY KEY,
  name               varchar(64) NOT NULL,
  key_hash           char(64)    NOT NULL,
  prefix             varchar(12) NOT NULL,
  scopes             text[]      NOT NULL,
  rate_limit_per_min integer     NOT NULL DEFAULT 120 CHECK (rate_limit_per_min > 0),
  created_by         char(16)    REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz
);
CREATE UNIQUE INDEX api_keys_key_hash_key ON api_keys (key_hash);

-- ───────────────────────────── archive ─────────────────────────────

CREATE TABLE subjects (
  roblox_id     bigint PRIMARY KEY CHECK (roblox_id > 0),
  username      varchar(64),
  display_name  varchar(64),
  avatar_url    varchar(2048),
  log_count     integer     NOT NULL DEFAULT 0,
  first_log_at  timestamptz,
  last_log_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector
);
CREATE INDEX subjects_username_idx ON subjects (lower(username));
CREATE INDEX subjects_username_trgm_idx ON subjects USING gin (username gin_trgm_ops);
CREATE INDEX subjects_last_log_idx ON subjects (last_log_at DESC NULLS LAST);
CREATE INDEX subjects_log_count_idx ON subjects (log_count DESC);
CREATE INDEX subjects_search_idx ON subjects USING gin (search_vector);

CREATE TABLE modlogs (
  id            char(16) PRIMARY KEY,
  roblox_id     bigint       NOT NULL REFERENCES subjects (roblox_id) ON DELETE CASCADE,

  title         varchar(300) NOT NULL,
  body_md       text         NOT NULL DEFAULT '',
  body_html     text         NOT NULL DEFAULT '',
  action        varchar(32)  NOT NULL DEFAULT 'other'
                  CHECK (action IN ('ban','temp_ban','kick','warning','mute',
                                    'content_deletion','account_deletion',
                                    'termination','note','other')),
  severity      varchar(16)  NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','low','medium','high','critical')),
  reason        text,

  occurred_at   timestamptz,
  source        varchar(64)  NOT NULL,
  source_id     varchar(200) NOT NULL,
  source_url    varchar(2048),

  tags          text[]       NOT NULL DEFAULT '{}'::text[],
  evidence      jsonb        NOT NULL DEFAULT '{}'::jsonb,

  status        varchar(16)  NOT NULL DEFAULT 'published'
                  CHECK (status IN ('published','hidden','removed')),
  revision      integer      NOT NULL DEFAULT 1,
  image_count   smallint     NOT NULL DEFAULT 0,

  created_by    char(16) REFERENCES users (id) ON DELETE SET NULL,
  updated_by    char(16) REFERENCES users (id) ON DELETE SET NULL,
  ingested_by   char(16) REFERENCES api_keys (id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector
);
CREATE UNIQUE INDEX modlogs_source_key   ON modlogs (source, source_id);
CREATE INDEX modlogs_subject_idx         ON modlogs (roblox_id, occurred_at DESC NULLS LAST);
CREATE INDEX modlogs_subject_created_idx ON modlogs (roblox_id, created_at DESC);
CREATE INDEX modlogs_created_idx         ON modlogs (created_at DESC);
CREATE INDEX modlogs_occurred_idx        ON modlogs (occurred_at DESC NULLS LAST);
CREATE INDEX modlogs_action_idx          ON modlogs (action);
CREATE INDEX modlogs_severity_idx        ON modlogs (severity);
CREATE INDEX modlogs_status_idx          ON modlogs (status);
CREATE INDEX modlogs_source_idx          ON modlogs (source);
CREATE INDEX modlogs_tags_idx            ON modlogs USING gin (tags);
CREATE INDEX modlogs_search_idx          ON modlogs USING gin (search_vector);
-- The public list query is always "published, newest first".
CREATE INDEX modlogs_public_feed_idx ON modlogs (created_at DESC)
  WHERE status = 'published';

CREATE TABLE modlog_revisions (
  id              bigserial PRIMARY KEY,
  modlog_id       char(16)    NOT NULL REFERENCES modlogs (id) ON DELETE CASCADE,
  revision        integer     NOT NULL,
  snapshot        jsonb       NOT NULL,
  change_reason   text,
  changed_by      char(16) REFERENCES users (id) ON DELETE SET NULL,
  changed_by_key  char(16) REFERENCES api_keys (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX modlog_revisions_key ON modlog_revisions (modlog_id, revision);
CREATE INDEX modlog_revisions_modlog_idx ON modlog_revisions (modlog_id, revision DESC);

CREATE TABLE images (
  id              char(16) PRIMARY KEY,
  modlog_id       char(16)    NOT NULL REFERENCES modlogs (id) ON DELETE CASCADE,
  roblox_id       bigint      NOT NULL,

  position        smallint    NOT NULL DEFAULT 0,
  caption         text,

  sha256          char(64)    NOT NULL,
  width           integer     NOT NULL CHECK (width > 0),
  height          integer     NOT NULL CHECK (height > 0),
  bytes           integer     NOT NULL CHECK (bytes > 0),
  thumb_bytes     integer     NOT NULL DEFAULT 0,
  original_bytes  integer     NOT NULL,
  original_format varchar(16) NOT NULL,
  blur_data_url   text,

  status          varchar(16) NOT NULL DEFAULT 'published'
                    CHECK (status IN ('published','hidden','removed')),
  uploaded_by     char(16) REFERENCES users (id) ON DELETE SET NULL,
  uploaded_by_key char(16) REFERENCES api_keys (id) ON DELETE SET NULL,
  source_url      varchar(2048),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX images_modlog_sha_key ON images (modlog_id, sha256);
CREATE INDEX images_modlog_idx  ON images (modlog_id, position, created_at);
CREATE INDEX images_subject_idx ON images (roblox_id);

CREATE TABLE links (
  id            bigserial PRIMARY KEY,
  modlog_id     char(16)      NOT NULL REFERENCES modlogs (id) ON DELETE CASCADE,
  position      smallint      NOT NULL DEFAULT 0,
  url           varchar(2048) NOT NULL,
  domain        varchar(253)  NOT NULL,
  kind          varchar(32)   NOT NULL DEFAULT 'generic',
  ref           varchar(128),
  title         text,
  description   text,
  image_url     varchar(2048),
  site_name     varchar(128),
  unfurled_at   timestamptz,
  unfurl_failed boolean       NOT NULL DEFAULT false,
  created_at    timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX links_modlog_url_key ON links (modlog_id, url);
CREATE INDEX links_modlog_idx ON links (modlog_id, position);
CREATE INDEX links_domain_idx ON links (domain);

-- ───────────────────────────── oversight ─────────────────────────────

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_type  varchar(16) NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  actor_id    varchar(32),
  actor_label varchar(128),
  action      varchar(64) NOT NULL,
  target_type varchar(32),
  target_id   varchar(64),
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip          varchar(64),
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_action_idx  ON audit_log (action);
CREATE INDEX audit_log_target_idx  ON audit_log (target_type, target_id);
CREATE INDEX audit_log_actor_idx   ON audit_log (actor_type, actor_id);

-- The audit trail is append-only. The rule makes rewriting history impossible
-- even for the table owner; DELETE is left alone so retention pruning stays
-- possible, and is instead withheld from the app role (see 0002_grants.sql).
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;

CREATE TABLE ingress_batches (
  batch_id     varchar(64) PRIMARY KEY,
  api_key_id   char(16) REFERENCES api_keys (id) ON DELETE SET NULL,
  result       jsonb       NOT NULL,
  record_count integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingress_batches_created_idx ON ingress_batches (created_at DESC);

-- ───────────────────────────── triggers ─────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER subjects_touch BEFORE UPDATE ON subjects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER modlogs_touch BEFORE UPDATE ON modlogs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Weighted search vector: title and the subject's names outrank body text, so
-- a username query does not get buried under logs that merely mention it.
-- STABLE rather than IMMUTABLE because array_to_string() is only STABLE.
CREATE OR REPLACE FUNCTION modlog_search_vector(
  p_title text, p_subject_terms text, p_tags text[],
  p_reason text, p_source text, p_body text
) RETURNS tsvector
LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('english', coalesce(p_title, '')), 'A')
      || setweight(to_tsvector('simple',  coalesce(p_subject_terms, '')), 'A')
      || setweight(to_tsvector('simple',  array_to_string(coalesce(p_tags, '{}'), ' ')), 'B')
      || setweight(to_tsvector('english', coalesce(p_reason, '')), 'B')
      || setweight(to_tsvector('simple',  coalesce(p_source, '')), 'C')
      || setweight(to_tsvector('english', left(coalesce(p_body, ''), 40000)), 'D');
$$;

CREATE OR REPLACE FUNCTION subject_search_terms(p_roblox_id bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(s.username, '') || ' ' || coalesce(s.display_name, '')
         || ' ' || s.roblox_id::text
    FROM subjects s WHERE s.roblox_id = p_roblox_id;
$$;

CREATE OR REPLACE FUNCTION modlogs_search_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := modlog_search_vector(
    NEW.title, subject_search_terms(NEW.roblox_id),
    NEW.tags, NEW.reason, NEW.source, NEW.body_md
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER modlogs_search BEFORE INSERT OR UPDATE OF
  title, reason, body_md, tags, source, roblox_id ON modlogs
  FOR EACH ROW EXECUTE FUNCTION modlogs_search_refresh();

-- A renamed subject must not become unsearchable through its own logs.
CREATE OR REPLACE FUNCTION subjects_cascade_search() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE modlogs m
     SET search_vector = modlog_search_vector(
           m.title, subject_search_terms(NEW.roblox_id),
           m.tags, m.reason, m.source, m.body_md
         )
   WHERE m.roblox_id = NEW.roblox_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER subjects_cascade_search AFTER UPDATE OF username, display_name ON subjects
  FOR EACH ROW
  WHEN (OLD.username IS DISTINCT FROM NEW.username
     OR OLD.display_name IS DISTINCT FROM NEW.display_name)
  EXECUTE FUNCTION subjects_cascade_search();

CREATE OR REPLACE FUNCTION subjects_search_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.username, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A')
   || setweight(to_tsvector('simple', NEW.roblox_id::text), 'A');
  RETURN NEW;
END;
$$;

CREATE TRIGGER subjects_search BEFORE INSERT OR UPDATE OF username, display_name ON subjects
  FOR EACH ROW EXECUTE FUNCTION subjects_search_refresh();

-- Keep subjects.log_count / first_log_at / last_log_at exact.
CREATE OR REPLACE FUNCTION subjects_recount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target bigint;
BEGIN
  FOREACH target IN ARRAY (
    CASE
      WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.roblox_id]
      WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.roblox_id]
      WHEN NEW.roblox_id = OLD.roblox_id THEN ARRAY[NEW.roblox_id]
      ELSE ARRAY[NEW.roblox_id, OLD.roblox_id]
    END
  )
  LOOP
    UPDATE subjects s SET
      log_count    = sub.cnt,
      first_log_at = sub.first_at,
      last_log_at  = sub.last_at
    FROM (
      SELECT count(*)::int AS cnt,
             min(coalesce(m.occurred_at, m.created_at)) AS first_at,
             max(coalesce(m.occurred_at, m.created_at)) AS last_at
        FROM modlogs m
       WHERE m.roblox_id = target AND m.status = 'published'
    ) sub
    WHERE s.roblox_id = target;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER modlogs_recount AFTER INSERT OR DELETE OR UPDATE OF
  roblox_id, status, occurred_at ON modlogs
  FOR EACH ROW EXECUTE FUNCTION subjects_recount();

-- Keep modlogs.image_count exact.
CREATE OR REPLACE FUNCTION modlogs_image_recount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target char(16);
BEGIN
  -- A re-parented image changes the count on both sides, so recount each
  -- modlog the row touched.
  FOREACH target IN ARRAY (
    CASE
      WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.modlog_id]
      WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.modlog_id]
      WHEN NEW.modlog_id = OLD.modlog_id THEN ARRAY[NEW.modlog_id]
      ELSE ARRAY[NEW.modlog_id, OLD.modlog_id]
    END
  )
  LOOP
    UPDATE modlogs m
       SET image_count = (
             SELECT count(*) FROM images i
              WHERE i.modlog_id = target AND i.status = 'published'
           )
     WHERE m.id = target;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER images_recount AFTER INSERT OR DELETE OR UPDATE OF status, modlog_id ON images
  FOR EACH ROW EXECUTE FUNCTION modlogs_image_recount();
