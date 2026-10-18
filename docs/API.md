# API reference

Two services, one version prefix.

```
text    https://api.domain.com/digitalarchive/v1
images  https://api.domain.com/digitalarchive/v1/images
```

Nothing is public. Every endpoint below needs a credential; an unauthenticated
request gets `401` everywhere except `/health` and `/auth/*`.

Reads need a Discord session whose account holds an access role in the
archive's guild, or an API key carrying `archive:read`. Writes need a
moderator session or a key carrying the matching write scope.

**Authentication** - one of:

```
Cookie: archive_session=…          browser, set by the OAuth flow
Authorization: Bearer da_…         scraper
X-API-Key: da_…                    scraper, equivalent
```

The cookie is scoped to the parent domain of the web and API origins, so a
browser signed in on the site sends it here too. Note that `archive:read` is a
separate scope from `ingress:write`: a key minted for a scraper cannot read
the archive back out unless it was granted both.

**Errors** are always this shape. Branch on `code`; quote `requestId` when
reporting a failure, it matches the server log.

```jsonc
{
  "error": {
    "code": "validation_failed",
    "message": "Request failed validation",
    "details": [{ "path": "records.0.title", "message": "Required" }],
    "requestId": "9a3f…"
  }
}
```

| Code | Status | |
| --- | --- | --- |
| `bad_request` | 400 | Malformed input that is not a schema failure |
| `unauthorized` | 401 | Missing, invalid or revoked credential |
| `forbidden` | 403 | Authenticated, but lacks the role or scope |
| `not_found` | 404 | Also returned for records a viewer may not see |
| `conflict` | 409 | Duplicate `source` + `sourceId`, or image cap reached |
| `payload_too_large` | 413 | Body or file over the limit |
| `unsupported_media_type` | 415 | Not an image type we accept |
| `validation_failed` | 422 | Schema failure, with `details` |
| `rate_limited` | 429 | Includes `retryAfterMs` |
| `service_unavailable` | 503 | Shed under load, or Postgres unreachable |

---

## Reads

### `GET /stats`

Counts, per-source and per-action breakdowns, and the image compression
report. Cached 5 minutes.

### `GET /subjects`

Accounts with at least one published record.

`q` substring or Roblox id · `sort=recent|most_logs|username` ·
`page` · `limit` (≤ 100)

### `GET /modlogs`

Every published record, newest first.

`action` · `severity` · `tag` · `source` · `from` · `to` ·
`sort=newest|oldest|severity` · `page` · `limit`

`status` is accepted but honoured only for moderators; the public view is
pinned to `published` regardless of what the query string says.

### `GET /search`

Postgres full-text over title, subject names, tags, reason, source and body,
weighted in that order.

`q` (≥ 2 chars, required) · `action` · `severity` · `tag` · `page` · `limit`

Accepts quoted phrases and `-exclusions`; malformed queries return no results
rather than an error.

### `GET /roblox-modlogs/:accountId` · `GET /discord-modlogs/:accountId`

One account's records, with the subject object inlined. Same filters as
`/modlogs`. Mirrors the public web URL.

The platform is in the path, not a query parameter, because it is part of the
account's identity. `(platform, externalId)` is the real key; the same digits
on the other platform are a different subject and 404 here. Each subject also
carries a 16-char surrogate `id`, which is what every other row references
and what survives a username change on the platform itself.

```json
"subject": {
  "id": "7pp5gnw6d930hvks",
  "platform": "roblox",
  "externalId": "2352644898",
  "username": "Roveen80",
  "logCount": 5,
  "profileUrl": "https://www.roblox.com/users/2352644898/profile",
  "archiveUrl": "/roblox-modlogs/2352644898"
}
```

`profileUrl` is null for a Discord subject: Discord has no public page for a
bare user id, and the client-only `discord://` deep link is not something to
put in an href.

Also returns `relatedAccounts`: alts and renames named on this account's
records, in both directions. Read this before concluding that an empty list
means an unsanctioned account - one sanction announced against four alts is
stored as **one** record, filed under the first account named, so the other
three legitimately show zero records of their own.

```json
"relatedAccounts": [
  { "subjectId": "q7m2…", "platform": "roblox", "externalId": "7511229161",
    "username": "mrlazy296", "relation": "alt", "logCount": 0,
    "archiveUrl": "/roblox-modlogs/7511229161",
    "assertedBy": "q4m7x2b9ktp0rsvw" }
]
```

`relation` is one of `alt`, `successor` (this account moved to that one),
`predecessor` (the reverse) or `related` (named together, relationship not
stated). `assertedBy` is the record that made the claim, so it can be checked.

Groupings **cross platforms**: the Discord forum routinely names a Discord
account and the Roblox account behind it in one title. Those are stored as
`related` rather than `alt` - "the same person elsewhere" is a different claim
from "the same person again", and the title does not support the stronger one.

### `GET /<platform>-modlogs/:accountId/:logId`

One record, with `body.markdown`, `body.html` (pre-sanitised), `images`,
`linkEmbeds`, `evidence`, `subject`, `relatedAccounts` and `thread`.

The account *and its platform* are verified against the record, so the route
cannot be used to render a log under the wrong subject - or under the right
number on the wrong platform. A `removed` record returns its shell -
id, title, status, history - with the body, evidence, images **and thread**
withheld.

`thread` is non-null only for records scraped from a Discord forum. It
carries the discussion that followed the log, which on these sources is where
the appeal, the correction and the decision to escalate actually live:

```json
"thread": {
  "postId": "1533545415213846760",
  "forumName": "🔑｜roblox-modlogs",
  "url": "https://discord.com/channels/…",
  "replyCount": 21, "archived": true, "locked": false,
  "author":       { "id": "749042365448323113", "username": "surup9670",
                    "displayName": "kahve", "avatarUrl": "https://cdn.discordapp.com/…",
                    "bot": false, "resolvedFrom": "scrape", "fetchedAt": null },
  "participants": [ { "…": "…", "role": "author", "messageCount": 4 } ],
  "messages":     [ { "messageId": "…", "position": 0, "html": "…",
                      "postedAt": "…", "editedAt": null, "imageCount": 0,
                      "author": { "…": "…" } } ]
}
```

`avatarUrl` is never null - Discord's own default avatar is substituted - so
a client never has to decide what to draw in a gap. `resolvedFrom` says where
the name and avatar came from: `discord_api` is authoritative as of
`fetchedAt`, `scrape` is what the thread looked like when it was captured and
has not been confirmed since.

### `GET /<platform>-modlogs/:accountId/:logId/:imageId`

Metadata for one image plus its siblings, so a viewer can page through the
evidence without another round trip. The bytes come from the images service.

### `GET /modlogs/:id`

Flat lookup when only the record id is known.

### `GET /modlogs/:id/revisions`

Edit history, newest revision first. Each entry is the state *before* that
edit, plus the reason the editor gave.

### `GET /moderators`

Everyone who has filed a record, with how many they filed and when they last
did. Derived from the records rather than from a configured list, so it cannot
drift out of step with the archive's contents.

`identityRefresh` reports whether `DISCORD_BOT_TOKEN` is set. When it is
false, every identity in the response is `resolvedFrom: "scrape"` and will
stay that way.

### `GET /discord-users/:discordId`

One Discord identity as the archive currently holds it. 404 if the archive has
never seen that account - this is a cache of accounts that appear on records,
not a proxy for Discord's API.

---

## Writes

### `POST /ingress`

The scraper entry point, for a client that already builds archive records.
Scope `ingress:write`. See [`SCRAPER.md`](SCRAPER.md) for the full contract.

### `POST /ingress/discord-forum`

Discord forum threads **verbatim**, exactly as the scraper emits them. Scope
`ingress:write`. Body limit 64MB, because a batch of threads carries their
whole reply history.

```json
{
  "batchId": "forum-2026-10-17",
  "onConflict": "merge",
  "posts": [ { "post_id": "…", "title": "wojtek3441 (2555684412) (#6066)", "…": "…" } ]
}
```

Takes either forum. The mapper reads `forum_name` and picks the dialect:
`roblox-modlogs` threads are Roblox subjects with bot-command bodies,
`discord-modlogs` threads are Discord subjects with prose bodies, and they
get different `source` values so the two can never dedupe into each other.
The subject's platform comes from the id's own shape - a Discord snowflake is
17+ digits, a Roblox id is 11 - which is why a Roblox id appearing in a
Discord thread title is still filed as a Roblox subject.

The mapping happens server-side: which account the thread is about (the first
id in the title), what sanction the body records, which other accounts it
groups, and who took part. Those rules are the
archive's interpretation of its own source and they change - keeping them here
means a re-parse is a deploy of one service, and the scraper can never hold a
second, divergent reading of the same title.

Everything `POST /ingress` guarantees applies: idempotent per `batchId`,
partial success, deduplicated on `source` + `sourceId` (here, the post id).
One addition - a thread the mapper cannot place does **not** fail the batch:

```json
"unmapped": [
  { "index": 19, "sourceId": "1536…", "title": "dap123francais (all alt accounts) (Appeal-#6098)",
    "reason": "no Roblox id in the thread title - the subject cannot be identified, …" }
]
```

A batch where *nothing* mapped returns `422 nothing_mappable` rather than a
200 reporting no work.

For a file on disk, skip HTTP entirely:

```sh
pnpm import:forum /path/to/scrape.jsonl [--conflict merge] [--limit n] [--dry-run] [--images]
```

Same parsing, mapping and persistence code as the endpoint. `--images` is off
by default because Discord attachment URLs are signed and expire, so a stale
scrape mostly 404s.

### `GET /ingress/whoami`

Confirms a credential, its scopes and its rate budget without writing. Point
cron monitoring here. Also reports `discord.identityRefresh` - whether a bot
token is configured - and both ingress body limits.

### `POST /discord-users/refresh`

Re-resolves the stalest Discord identities against the Discord API. Role
`admin`. `?limit=` (1–200, default 50). Returns `503
discord_token_missing` when no bot token is configured.

Manual on purpose: avatars and display names drift whether or not anything is
being ingested, and the archive should be able to catch up without
re-importing a scrape.

### `POST /modlogs`

Create one record by hand. Role `moderator`, or scope `ingress:write`.

### `PATCH /modlogs/:id`

Role `moderator`. `changeReason` (≥ 3 chars) is **required** alongside at
least one changed field - the revision history is meant to read as an
explanation, not a diff.

### `POST /modlogs/:id/status`

Role `moderator`. `{ "status": "published|hidden|removed", "changeReason": "…" }`.

A separate endpoint from `PATCH` deliberately: a takedown is an action with a
reason, and giving it its own URL makes it unmistakable in the audit trail.

### `DELETE /modlogs/:id`

Role `admin`. A **soft** delete - status moves to `removed`, the row and its
history stay. Purging outright would break the trail the archive exists to
keep.

---

## Images

### `GET /images/:id` · `GET /images/:id.webp`

WebP bytes. `?v=thumb` for the 480px variant. `Cache-Control: immutable`,
one-year TTL, ETag and `If-None-Match` supported - an id never changes what it
points at.

Hidden and removed images 404 for everyone but moderators.

### `GET /images/:id/meta`

Dimensions, stored and original byte sizes, compression ratio, blur
placeholder.

### `POST /images`

`multipart/form-data`. Scope `images:write` or role `moderator`.

Fields: `modlogId` (required, **send before the files**), `caption`,
`position`. Then one or more file parts. Returns every stored image plus a
per-file `errors` array, so a mixed batch is not all-or-nothing.

### `POST /images/fetch`

`{ "modlogId": "…", "urls": [...], "captions": [...] }` - the server downloads
each URL (DNS-checked against private ranges, redirects re-checked per hop,
body capped) and converts it.

### `PATCH /images/:id` · `DELETE /images/:id`

Role `moderator`. Delete is a tombstone: the row survives so revision history
stays coherent, the bytes leave the disk. `?purge=true` with role `admin`
removes the row too.

### `GET /images/stats`

Role `moderator`. Aggregate compression saving across the archive.

---

## Moderation

### `GET /moderation/audit`

Role `moderator`, or scope `moderation:read` so the trail can be shipped to an
external log sink.

`action` · `actorId` · `targetId` · `page` · `limit`

Append-only at the database level. Entries cannot be edited, including by an
administrator.

### `GET /moderation/queue`

Role `moderator`. Everything `hidden` or `removed`, newest change first.

### `GET /moderation/users` · `POST /moderation/users/:id/role`

Role `admin`. `{ "role": "viewer|moderator|admin", "reason": "…" }`.

An admin cannot remove their own admin role. Demoting to `viewer` destroys
that user's sessions immediately rather than waiting for the cookie to expire.

### `GET /moderation/api-keys` · `POST` · `DELETE /:id`

Role `admin`. The secret in a create response is the only copy that will ever
exist - only its SHA-256 is stored. A key cannot revoke itself.

---

## Auth

| | |
| --- | --- |
| `GET /auth/me` | Viewer identity and role. `no-store`. |
| `GET /auth/discord?return_to=` | Starts OAuth. `return_to` must be on the web origin. |
| `GET /auth/discord/callback` | Exchanges the code, sets the session cookie. |
| `POST /auth/logout` | Destroys the session. |
| `GET /auth/verify` | Lightweight validity + role check. |

These five, plus `/health`, are the only paths that answer without a
credential - you cannot require a session in order to obtain one. `/auth/me`
and `/auth/verify` report `authenticated: false` to an anonymous caller rather
than refusing, which is what lets the web app render a login page.

The OAuth flow requests two scopes: `identify`, and `guilds.members.read` to
read which roles the account holds in `DISCORD_REQUIRED_GUILD_ID`. A sign-in
by an account that is not in that guild, or is in it without a granting role,
creates no user row and no session; the callback redirects to
`/login?denied=not_member` or `/login?denied=no_role` on the web origin rather
than returning a bare 403 on this one.

A live session's roles are re-checked against the guild every
`ROLE_RECHECK_MINUTES` with the bot token, de-duplicated through Redis so a
page load costs one lookup rather than one per request. A role removed in
Discord ends the session - all of that account's sessions - within that
window. An unreachable Discord keeps the cached role and retries on the next
request.

With `AUTH_ENABLED=false`, `/auth/me` reports a synthetic dev administrator and
every authorisation check passes, including the read gate. The API refuses to
start in that state when `NODE_ENV=production`.

---

## Rate limits

Per minute, keyed by API key when present, then by user, then by IP:

| | Default |
| --- | --- |
| Reads | 240 |
| Ingress | 120 (overridden per key) |
| Uploads | 60 |

Each key carries its own budget, so one scraper cannot consume another's.
Responses include `x-ratelimit-limit` and `x-ratelimit-remaining`. If Redis is
unavailable the limiter fails open - the archive stays readable.

## Caching

Everything is `private`. There is no `s-maxage` and no shared-cache tier: a
CDN keys on URL, so a stored copy of a record could be handed to a caller with
no session at all, and `Vary: Cookie` is advisory - an intermediary that
ignores it fails silently and in the wrong direction. The `Vary` header is
still sent, but nothing depends on it being honoured.

Reads are `private, max-age` up to 60s; anything a moderator can see is
`private, no-store`, because the same URL returns different bodies per role.
Image bytes stay `immutable` for a year but are `private` too, so they are
cached in the viewer's own browser and nowhere else - which means evidence
images now reach the homeserver instead of being served from Cloudflare's
edge. That is the cost of the bytes being gated at all.

If you front this with Cloudflare, make sure no "Cache Everything" rule
overrides the origin's `private` - that would reintroduce exactly the shared
cache these headers exist to prevent.
