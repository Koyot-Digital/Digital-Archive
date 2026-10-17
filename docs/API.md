# API reference

Two services, one version prefix.

```
text    https://api.domain.com/digitalarchive/v1
images  https://api.domain.com/digitalarchive/v1/images
```

Reads are public. Writes need either a Discord session carrying a role, or an
API key carrying the matching scope.

**Authentication** — one of:

```
Cookie: archive_session=…          browser, set by the OAuth flow
Authorization: Bearer da_…         scraper
X-API-Key: da_…                    scraper, equivalent
```

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

### `GET /roblox-modlogs/:robloxId`

One account's records, with the subject object inlined. Same filters as
`/modlogs`. Mirrors the public web URL.

### `GET /roblox-modlogs/:robloxId/:logId`

One record, with `body.markdown`, `body.html` (pre-sanitised), `images`,
`linkEmbeds`, `evidence` and `subject`.

The `robloxId` is verified against the record, so the route cannot be used to
render a log under the wrong subject. A `removed` record returns its shell —
id, title, status, history — with the body, evidence and images withheld.

### `GET /roblox-modlogs/:robloxId/:logId/:imageId`

Metadata for one image plus its siblings, so a viewer can page through the
evidence without another round trip. The bytes come from the images service.

### `GET /modlogs/:id`

Flat lookup when only the record id is known.

### `GET /modlogs/:id/revisions`

Edit history, newest revision first. Each entry is the state *before* that
edit, plus the reason the editor gave.

---

## Writes

### `POST /ingress`

The scraper entry point. Scope `ingress:write`. See
[`SCRAPER.md`](SCRAPER.md) for the full contract.

### `GET /ingress/whoami`

Confirms a credential, its scopes and its rate budget without writing. Point
cron monitoring here.

### `POST /modlogs`

Create one record by hand. Role `moderator`, or scope `ingress:write`.

### `PATCH /modlogs/:id`

Role `moderator`. `changeReason` (≥ 3 chars) is **required** alongside at
least one changed field — the revision history is meant to read as an
explanation, not a diff.

### `POST /modlogs/:id/status`

Role `moderator`. `{ "status": "published|hidden|removed", "changeReason": "…" }`.

A separate endpoint from `PATCH` deliberately: a takedown is an action with a
reason, and giving it its own URL makes it unmistakable in the audit trail.

### `DELETE /modlogs/:id`

Role `admin`. A **soft** delete — status moves to `removed`, the row and its
history stay. Purging outright would break the trail the archive exists to
keep.

---

## Images

### `GET /images/:id` · `GET /images/:id.webp`

WebP bytes. `?v=thumb` for the 480px variant. `Cache-Control: immutable`,
one-year TTL, ETag and `If-None-Match` supported — an id never changes what it
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

`{ "modlogId": "…", "urls": [...], "captions": [...] }` — the server downloads
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
exist — only its SHA-256 is stored. A key cannot revoke itself.

---

## Auth

| | |
| --- | --- |
| `GET /auth/me` | Viewer identity and role. `no-store`. |
| `GET /auth/discord?return_to=` | Starts OAuth. `return_to` must be on the web origin. |
| `GET /auth/discord/callback` | Exchanges the code, sets the session cookie. |
| `POST /auth/logout` | Destroys the session. |
| `GET /auth/verify` | Lightweight validity + role check. |

With `AUTH_ENABLED=false`, `/auth/me` reports a synthetic dev administrator and
every authorisation check passes. The API refuses to start in that state when
`NODE_ENV=production`.

---

## Rate limits

Per minute, keyed by API key when present, then by user, then by IP:

| | Default |
| --- | --- |
| Public reads | 240 |
| Ingress | 120 (overridden per key) |
| Uploads | 60 |

Each key carries its own budget, so one scraper cannot consume another's.
Responses include `x-ratelimit-limit` and `x-ratelimit-remaining`. If Redis is
unavailable the limiter fails open — the archive stays readable.

## Caching

Public reads are `s-maxage` 30–300s with `stale-while-revalidate` and
`Vary: Cookie, Authorization, Origin`. Anything a moderator can see is
`private, no-store`, because the same URL returns different bodies per role.
Image bytes are `immutable` for a year.
