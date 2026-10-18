-- ───────────────────────────────────────────────────────────────────────────
--  0004 - the archive becomes private, gated on a Discord guild role
--
--  Until now `users.role` was assigned once from an env allowlist of Discord
--  user ids and then kept forever: a row written at signup, trusted for the
--  life of the session. That is fine when reading is public and the role only
--  unlocks the staff tools. It is not fine once the role is the thing standing
--  between a visitor and the whole archive, because the question changes from
--  "was this person staff when they signed up" to "is this person still
--  allowed, right now".
--
--  So the guild is the source of truth and these two columns are a cache of
--  what it last said:
--
--    discord_roles    - the role snowflakes held in the gating guild at the
--                       last check. Kept so an operator can answer "why does
--                       this account have admin" from the database alone,
--                       without replaying an OAuth flow.
--    roles_checked_at - when that was. NULL means never checked under the new
--                       scheme, which is deliberately indistinguishable from
--                       "checked too long ago": both force a re-check.
--
--  Existing rows get NULL, so every session that predates this migration is
--  re-verified against Discord on its next request. Anyone who no longer
--  holds a granting role is signed out at that point rather than inheriting
--  access from the old public-read world.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS discord_roles    text[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS roles_checked_at timestamptz;

-- The re-check sweep looks for the stalest rows first.
CREATE INDEX IF NOT EXISTS users_roles_checked_idx
  ON users (roles_checked_at NULLS FIRST);

-- Sessions issued while reading was public carry no proof that their owner
-- holds a granting role. Rather than trust them, end them: the next request
-- bounces to /login, the OAuth flow runs, and the guild decides. Cheap to do
-- (everyone signs in again once) and it closes the window where a pre-gate
-- cookie outlives the gate.
DELETE FROM sessions;
