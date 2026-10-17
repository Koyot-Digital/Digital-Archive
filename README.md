# Digital Archive

A self-hosted archive of Roblox moderation records. A scraper posts JSON at
one end; a fast, Wikipedia-shaped web interface comes out the other, with
every record carrying its source, its evidence and the full history of every
edit ever made to it.

Runs entirely on one homeserver behind Cloudflare tunnels. No external
services beyond Discord OAuth, which can be switched off for development.

```
                 Cloudflare                        homeserver
                 ──────────                        ──────────
  archive.domain.com  ───── tunnel ─────▶  caddy:8080 ──▶ web          Next.js 15
  api.domain.com      ───── tunnel ─────▶  caddy:8081 ──▶ api-text     JSON · search · ingress · auth
  api.domain.com/…/images/*  ─ tunnel ─▶  caddy:8082 ──▶ api-images   WebP bytes · uploads
                                                           │
                                             postgres 17 ──┴── redis 7
```

**Three tunnels, on purpose.** Image traffic is large, bursty and highly
cacheable; archive reads are small and latency-sensitive. Separating them
means a thousand-screenshot ingest cannot add a millisecond to a page load,
and each surface gets its own edge cache rules and its own failure domain.

---

## URLs

Public web interface:

```
archive.domain.com/roblox-modlogs/<robloxId>                        all records for an account
archive.domain.com/roblox-modlogs/<robloxId>/<16-char id>           one record
archive.domain.com/roblox-modlogs/<robloxId>/<16-char id>/<img id>  one piece of evidence
```

```
archive.domain.com/moderators                                       who files records here
```

API:

```
api.domain.com/digitalarchive/v1/ingress               POST   archive records
api.domain.com/digitalarchive/v1/ingress/discord-forum POST   raw forum threads
api.domain.com/digitalarchive/v1/images/<id>.webp      GET    image bytes
api.domain.com/digitalarchive/v1/images                POST   upload
```

Full endpoint list: [`docs/API.md`](docs/API.md), or `/api-docs` on the running
site.

---

## Quick start

Prerequisites: Node 22+, pnpm 9+, Docker, and Postgres + Redis (either your own
or the ones in the compose file).

```sh
cp .env.example .env
make secrets          # prints three fresh secrets to paste into .env
make setup            # install deps, build the shared package
make migrate          # create the schema
make seed             # sample records so the UI is not empty
make dev              # api-text :4001 · api-images :4002 · web :3000
```

`AUTH_ENABLED=false` in `.env.example`, so every request is treated as an
administrator and you can click around immediately. The web UI shows a warning
banner the whole time this is true, and the API **refuses to boot** with
`AUTH_ENABLED=false` when `NODE_ENV=production`.

### On the homeserver

```sh
cp .env.example .env    # fill in the real values, set AUTH_ENABLED=true
make up                 # build and start everything except the tunnels
make apikey NAME="nightly scraper" SCOPES=ingress:write,images:write
make up-tunnels         # add the three cloudflared containers
```

Migrations run automatically at boot, behind a Postgres advisory lock, so two
containers starting together cannot race.

Tunnel and edge-cache setup: [`infra/cloudflared/README.md`](infra/cloudflared/README.md).

---

## Sending data in

```sh
curl -X POST https://api.domain.com/digitalarchive/v1/ingress \
  -H "Authorization: Bearer da_…" \
  -H "Content-Type: application/json" \
  -d '{
    "batchId": "nightly-2026-10-17",
    "onConflict": "merge",
    "records": [{
      "robloxId": 156,
      "username": "builderman",
      "title": "7-day suspension — harassment in experience chat",
      "body": "Markdown. Any link in here becomes an embed card.",
      "action": "temp_ban",
      "severity": "high",
      "reason": "Harassment after prior warning",
      "occurredAt": "2026-03-02T10:30:00Z",
      "source": "my-scraper",
      "sourceId": "case-88213",
      "tags": ["harassment", "chat"],
      "evidence": { "reportCount": 3, "priorWarnings": 1 },
      "imageUrls": ["https://example.com/evidence.png"]
    }]
  }'
```

What the endpoint guarantees:

- **Idempotent.** Replaying a `batchId` within 24h returns the original result
  instead of writing again. Guarded in Redis *and* in a Postgres table, so a
  cache flush cannot cause a double-ingest.
- **Partial success.** A bad record in a batch of 500 fails alone and is
  reported by index; the rest still land.
- **Deduplicated** on `source` + `sourceId`. Omit `sourceId` and the server
  derives one from the content, so a re-scrape still matches.
- **Non-destructive by default.** `onConflict: "merge"` updates a record
  *unless a human has edited it* — a nightly re-scrape can never silently
  revert a moderator's correction.
- **Fast to call.** Image fetching and link unfurling happen after the
  response is sent.

Check a credential without writing anything:
`GET /digitalarchive/v1/ingress/whoami`.

A worked example scraper client is in [`docs/SCRAPER.md`](docs/SCRAPER.md).

### Discord forum scrapes

The archive's first real source is a Discord forum channel, where one thread
is one moderation event. Those threads go in **unchanged**:

```sh
curl -X POST https://api.domain.com/digitalarchive/v1/ingress/discord-forum \
  -H "Authorization: Bearer da_…" -H "Content-Type: application/json" \
  --data-binary @scrape-batch.json
```

…or, for a file already on disk, skipping HTTP entirely:

```sh
pnpm import:forum ./roblox-modlogs-….jsonl --images
```

**The mapping happens server-side, on purpose.** Reading one of these threads
means knowing that the subject is the first Roblox id in the title, that
`;tban Name 3d reason` is a three-day suspension, that a `~~struck-through~~`
command followed by a `;pban` is an *escalation* rather than two sanctions,
and that `A (1) --> B (2)` names one account that moved rather than two that
offended. Those rules are the archive's reading of its own source and they
change; keeping them in the API means a re-parse is one deploy, and the
scraper can never hold a second, quietly different interpretation.

What comes out of one thread:

| From the thread | Becomes |
| --- | --- |
| `wojtek3441 (2555684412) (#6066)` | subject `2555684412`, ticket `#6066` |
| `;tban wojtek3441 2d Intentional disruption…` | `temp_ban`, `medium`, 2 days, that reason |
| `MRLAZY295 (…) mrlazy296 (…) All Alts` | one record + three grouped accounts |
| the 21 replies | the record's thread, with avatars and names |
| the attachments | WebP evidence, as with any other image |

A thread whose title names no Roblox id has no subject to be filed under, so
it comes back under `unmapped` with a reason rather than failing the batch or
being silently dropped.

Everything on the thread is attributed. `DISCORD_BOT_TOKEN` is optional —
without it the archive shows the usernames and avatars the scrape captured and
labels them *as scraped*; with it, identities are refreshed from
`GET /users/{id}` after the response is sent, cached for
`DISCORD_USER_TTL_HOURS`, and re-resolvable on demand with
`POST /discord-users/refresh`. Either way a record always renders, and the UI
never passes off a months-old scraped name as current.

---

## Images

Everything that enters the archive is re-encoded. A typical 4MB screenshot PNG
lands around 150–350KB.

- **Magic-byte sniffed**, not trusted by declared content type.
- **Re-encoded through sharp** to WebP — which also discards EXIF (screenshots
  routinely carry device and GPS data), strips ICC payloads, and guarantees the
  stored bytes are an image rather than a polyglot file with something stapled
  on.
- **Three variants**: full (capped at 2400px, q72), thumb (480px, q58), and a
  16px inline data-URI used as a blur placeholder so first paint is never
  blank.
- **Decompression-bomb guarded** at 100M decoded pixels, independent of file
  size.
- **Content-addressed and deduplicated** per record on SHA-256, sharded two
  levels deep on disk.
- **Served `immutable`** with a one-year TTL. An id never changes what it
  points at, so Cloudflare serves nearly all image traffic without touching
  the homeserver.

`GET /digitalarchive/v1/images/stats` reports the aggregate saving.

---

## Who can do what

Reading is public. Writing is not.

| | Read published | Read hidden/removed | Create | Edit | Change roles |
| --- | --- | --- | --- | --- | --- |
| Anonymous | ✅ | | | | |
| `viewer` | ✅ | | | | |
| `moderator` | ✅ | ✅ | ✅ | ✅ | |
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ |
| API key | ✅ | only with `moderation:read` | with `ingress:write` | | |

Roles come from `ADMIN_DISCORD_IDS` / `MODERATOR_DISCORD_IDS` in `.env` —
there is no in-app path to grant yourself privileges. An existing user keeps a
hand-set role unless the allowlist grants a higher one, so promotion is a
config change and demotion is an explicit admin action that also kills the
target's sessions immediately.

API keys deliberately sit outside the role system: an ingest token can write
records but can never read the audit trail or touch a role.

### Hardening notes

- Session tokens are stored as SHA-256 only — a database dump yields no
  replayable logins. Cookies are HMAC-signed, `httpOnly`, `SameSite=Lax`,
  `Secure` in production.
- The audit log is append-only by a Postgres `RULE`: rewriting history is
  impossible even for the table owner. `DELETE` is left available for
  retention pruning — withhold it from the app role (see below).
- `/ingress` optionally requires `X-Archive-Signature: sha256=<hex>` over the
  raw request body, verified against the exact bytes sent.
- Outbound fetches (link unfurling, remote image fetch) resolve DNS and reject
  private, loopback, link-local and CGNAT ranges, follow redirects by hand
  re-checking every hop, and cap the response body.
- Scraped markdown is sanitised server-side on write (markdown-it →
  sanitize-html), with no inline styles and every outbound link forced to
  `noopener noreferrer nofollow ugc`.
- Rate limits are keyed per API key when one is present, so one scraper cannot
  consume another's budget. The limiter fails *open* if Redis dies — the
  archive stays readable.

To take `DELETE` on the audit trail away from the application:

```sql
-- as the database owner
REVOKE DELETE ON audit_log FROM archive;
```

---

## Layout

```
apps/api/            one codebase, two entrypoints
  src/app/text.ts      → api-text    archive, search, auth, ingress
  src/app/images.ts    → api-images  WebP serving and uploads
  src/db/migrations/   hand-written SQL (triggers, partial indexes, the rule)
  src/services/        modlogs · images · links · audit · render
                       threads · discord-users
  src/scripts/         migrate · seed · apikey · import-forum-scrape
apps/web/            Next.js 15 App Router, server components
packages/shared/     ids, zod schemas, link classification — used by both
                     discord.ts      forum title + command parsing
                     forum-record.ts forum thread → archive record
infra/caddy/         internal reverse proxy, one listener per tunnel
infra/cloudflared/   tunnel + edge cache setup
```

Parsing lives in `packages/shared` rather than in the API because the web app
renders the same vocabulary the parser produces — relations, thread roles,
severity from ban length — and two copies of that vocabulary would drift.

Both API services run from the same image with different commands. They share
the schema, the services layer and the security stack; what differs is which
routes they mount and which tunnel reaches them.

### Why hand-written SQL migrations

The schema leans on things a generator does not express cleanly: trigger-
maintained `tsvector` columns with per-field weights, exact counter columns
that cannot drift, a partial index for the public feed, and the append-only
rule on `audit_log`. Each file runs once inside a transaction, and editing an
applied migration is refused by checksum.

---

## Operations

```sh
make logs                     # tail everything
make ps                       # container status
make psql                     # shell on the archive database
make backup                   # pg_dump to ./backups/
make restart-api              # rebuild just the two API services
```

Health: `/health` on both API services (outside the versioned prefix), and
Postgres is the only hard dependency — Redis being down degrades caching and
rate limiting but does not take the archive offline.

Backups cover two things: the Postgres dump above, and the
`archive-storage` volume, which holds the image bytes. The database alone is
not a complete backup.

---

## Known gaps

- The web UI is read-only. Creating and editing records goes through the API
  (`POST /modlogs`, `PATCH /modlogs/:id`); there is no editor form yet.
- Image uploads from the browser are not wired to a UI either — the endpoint
  exists and takes multipart, but you will be using `curl` or the scraper.
- No automated tests. The type system and the database constraints carry more
  weight than usual as a result.
