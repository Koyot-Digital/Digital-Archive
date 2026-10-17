-- ───────────────────────────────────────────────────────────────────────────
--  0003 - subjects become platform-aware
--
--  The archive's second source is a Discord forum where the subject of a
--  record is a *Discord* account, not a Roblox one. Both ids are integers, so
--  the tempting move is to keep one `roblox_id` column and put snowflakes in
--  it. That is wrong in three ways that all surface later:
--
--    * nothing guarantees the two id spaces never collide. Roblox ids are at
--      11 digits, snowflakes at 19, so they do not overlap today - but a
--      primary key is not the place to rely on "today";
--    * the subject page would link to roblox.com/users/<snowflake>, which is
--      a page about nobody;
--    * the URL would read /roblox-modlogs/<snowflake>, which is a lie the
--      archive would be telling in its own address bar.
--
--  So `subjects` gets a surrogate primary key and an explicit (platform,
--  external_id) identity. A surrogate rather than a composite key because
--  three tables reference subjects, and two-column foreign keys in every one
--  of them buys nothing over a 16-char id that already matches the shape of
--  every other identifier in the schema.
--
--  Existing rows are all Roblox, so the backfill is unambiguous. Ids are
--  derived from md5(platform:external_id) rather than drawn at random: a
--  deterministic backfill is re-runnable and produces the same ids on a
--  replica, which matters because this migration rewrites three foreign keys
--  against them. New subjects created by the application still get their ids
--  from the CSPRNG in packages/shared/src/ids.ts.
-- ───────────────────────────────────────────────────────────────────────────

-- Map an arbitrary string onto a 16-char id in the archive's alphabet
-- (Crockford base32 without i/l/o/u - see packages/shared/src/ids.ts).
CREATE OR REPLACE FUNCTION archive_id_from(p_text text) RETURNS char(16)
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(
           substr(
             '0123456789abcdefghjkmnpqrstvwxyz',
             1 + (('x' || substr(md5(p_text), 1 + (i - 1) * 2, 2))::bit(8)::int % 32),
             1
           ),
           '' ORDER BY i
         )
    FROM generate_series(1, 16) AS i;
$$;

-- A trigger's `UPDATE OF <column>` list is a hard dependency on that column,
-- so the two triggers naming roblox_id have to go before the column can. Both
-- are recreated against subject_id at the end of this file.
DROP TRIGGER IF EXISTS modlogs_recount ON modlogs;
DROP TRIGGER IF EXISTS modlogs_search ON modlogs;

-- ───────────────────────── subjects ─────────────────────────

ALTER TABLE subjects
  ADD COLUMN id char(16),
  ADD COLUMN platform varchar(16) NOT NULL DEFAULT 'roblox';

ALTER TABLE subjects
  ADD CONSTRAINT subjects_platform_check CHECK (platform IN ('roblox', 'discord'));

-- Every pre-existing subject is a Roblox account.
UPDATE subjects SET id = archive_id_from('roblox:' || roblox_id::text);

ALTER TABLE subjects ALTER COLUMN id SET NOT NULL;

-- `roblox_id` is no longer always a Roblox id.
ALTER TABLE subjects RENAME COLUMN roblox_id TO external_id;
ALTER TABLE subjects RENAME CONSTRAINT subjects_roblox_id_check TO subjects_external_id_check;

-- ───────────────────── repoint the referencing tables ─────────────────────
-- Done before the primary key is swapped, so no foreign key is ever pointing
-- at a column that is about to stop being unique.

ALTER TABLE modlogs DROP CONSTRAINT modlogs_roblox_id_fkey;
ALTER TABLE subject_relations DROP CONSTRAINT subject_relations_roblox_id_fkey;
ALTER TABLE subject_relations DROP CONSTRAINT subject_relations_related_roblox_id_fkey;

ALTER TABLE subjects DROP CONSTRAINT subjects_pkey;
ALTER TABLE subjects ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);
ALTER TABLE subjects
  ADD CONSTRAINT subjects_platform_external_key UNIQUE (platform, external_id);

CREATE INDEX subjects_platform_idx ON subjects (platform, log_count DESC);

-- ── modlogs ──
ALTER TABLE modlogs ADD COLUMN subject_id char(16);
UPDATE modlogs m SET subject_id = s.id
  FROM subjects s WHERE s.platform = 'roblox' AND s.external_id = m.roblox_id;

ALTER TABLE modlogs ALTER COLUMN subject_id SET NOT NULL;
ALTER TABLE modlogs
  ADD CONSTRAINT modlogs_subject_id_fkey
  FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS modlogs_subject_idx;
ALTER TABLE modlogs DROP COLUMN roblox_id;
CREATE INDEX modlogs_subject_idx ON modlogs (subject_id, occurred_at);

-- ── images ──
-- Denormalised so /:platform-modlogs/:subject/:log/:image validates in one
-- query. No foreign key here before and none now: the column is a cache of
-- the parent modlog's subject, kept in step by the trigger below.
ALTER TABLE images ADD COLUMN subject_id char(16);
UPDATE images i SET subject_id = m.subject_id FROM modlogs m WHERE m.id = i.modlog_id;

-- An image whose modlog vanished has nothing to belong to.
DELETE FROM images WHERE subject_id IS NULL;
ALTER TABLE images ALTER COLUMN subject_id SET NOT NULL;

DROP INDEX IF EXISTS images_subject_idx;
ALTER TABLE images DROP COLUMN roblox_id;
CREATE INDEX images_subject_idx ON images (subject_id);

-- ── subject_relations ──
ALTER TABLE subject_relations ADD COLUMN subject_id char(16);
ALTER TABLE subject_relations ADD COLUMN related_subject_id char(16);

UPDATE subject_relations r SET subject_id = s.id
  FROM subjects s WHERE s.platform = 'roblox' AND s.external_id = r.roblox_id;
UPDATE subject_relations r SET related_subject_id = s.id
  FROM subjects s WHERE s.platform = 'roblox' AND s.external_id = r.related_roblox_id;

DELETE FROM subject_relations WHERE subject_id IS NULL OR related_subject_id IS NULL;

ALTER TABLE subject_relations DROP CONSTRAINT subject_relations_pkey;
ALTER TABLE subject_relations DROP CONSTRAINT subject_relations_not_self;
DROP INDEX IF EXISTS subject_relations_related_idx;
ALTER TABLE subject_relations DROP COLUMN roblox_id;
ALTER TABLE subject_relations DROP COLUMN related_roblox_id;

ALTER TABLE subject_relations
  ALTER COLUMN subject_id SET NOT NULL,
  ALTER COLUMN related_subject_id SET NOT NULL,
  ADD CONSTRAINT subject_relations_pkey PRIMARY KEY (subject_id, related_subject_id),
  ADD CONSTRAINT subject_relations_not_self CHECK (subject_id <> related_subject_id),
  ADD CONSTRAINT subject_relations_subject_fkey
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
  ADD CONSTRAINT subject_relations_related_fkey
    FOREIGN KEY (related_subject_id) REFERENCES subjects(id) ON DELETE CASCADE;

CREATE INDEX subject_relations_related_idx ON subject_relations (related_subject_id);

-- ───────────────────────── triggers ─────────────────────────
-- Same behaviour as 0001/0002, rewritten against subject_id. The search
-- vector additionally carries the platform, so "discord" is a usable query.

CREATE OR REPLACE FUNCTION subject_search_terms(p_subject_id char(16)) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(s.username, '') || ' ' || coalesce(s.display_name, '')
         || ' ' || s.external_id::text || ' ' || s.platform
    FROM subjects s WHERE s.id = p_subject_id;
$$;

DROP FUNCTION IF EXISTS subject_search_terms(bigint);

CREATE OR REPLACE FUNCTION modlogs_search_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := modlog_search_vector(
    NEW.title, subject_search_terms(NEW.subject_id),
    NEW.tags, NEW.reason, NEW.source, NEW.body_md,
    modlog_search_refs(NEW.ticket_ref, NEW.discord_post_id)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER modlogs_search BEFORE INSERT OR UPDATE OF
  title, reason, body_md, tags, source, subject_id, ticket_ref, discord_post_id ON modlogs
  FOR EACH ROW EXECUTE FUNCTION modlogs_search_refresh();

CREATE OR REPLACE FUNCTION subjects_cascade_search() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE modlogs m
     SET search_vector = modlog_search_vector(
           m.title, subject_search_terms(NEW.id),
           m.tags, m.reason, m.source, m.body_md,
           modlog_search_refs(m.ticket_ref, m.discord_post_id)
         )
   WHERE m.subject_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION subjects_search_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', coalesce(NEW.username, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A')
   || setweight(to_tsvector('simple', NEW.external_id::text), 'A')
   || setweight(to_tsvector('simple', NEW.platform), 'B');
  RETURN NEW;
END;
$$;

DROP TRIGGER subjects_search ON subjects;
CREATE TRIGGER subjects_search BEFORE INSERT OR UPDATE OF
  username, display_name, external_id, platform ON subjects
  FOR EACH ROW EXECUTE FUNCTION subjects_search_refresh();

-- Keep subjects.log_count / first_log_at / last_log_at exact.
CREATE OR REPLACE FUNCTION subjects_recount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target char(16);
BEGIN
  FOREACH target IN ARRAY (
    CASE
      WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.subject_id]
      WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.subject_id]
      WHEN NEW.subject_id = OLD.subject_id THEN ARRAY[NEW.subject_id]
      ELSE ARRAY[NEW.subject_id, OLD.subject_id]
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
       WHERE m.subject_id = target AND m.status = 'published'
    ) sub
    WHERE s.id = target;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER modlogs_recount AFTER INSERT OR DELETE OR UPDATE OF
  subject_id, status, occurred_at ON modlogs
  FOR EACH ROW EXECUTE FUNCTION subjects_recount();

-- Keep images.subject_id in step with its parent record, so the denormalised
-- column can never disagree with the modlog it hangs off.
CREATE OR REPLACE FUNCTION images_sync_subject() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT m.subject_id INTO NEW.subject_id FROM modlogs m WHERE m.id = NEW.modlog_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER images_subject_sync BEFORE INSERT OR UPDATE OF modlog_id ON images
  FOR EACH ROW EXECUTE FUNCTION images_sync_subject();

-- Rebuild every vector: the subject terms now include the platform.
UPDATE subjects SET username = username;
UPDATE modlogs SET search_vector = modlog_search_vector(
  title, subject_search_terms(subject_id), tags, reason, source, body_md,
  modlog_search_refs(ticket_ref, discord_post_id)
);
