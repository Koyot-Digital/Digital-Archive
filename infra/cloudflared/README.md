# Tunnels

Two tunnels, one per zone. Each gets its own token and its own cloudflared
container, so the web UI and the API have separate ingress paths and separate
failure domains.

| Tunnel        | Zone           | Public hostname        | Path                                 | Origin              |
| ------------- | -------------- | ---------------------- | ------------------------------------ | ------------------- |
| `archive-web` | `chrisrelf.cc` | `archive.chrisrelf.cc` | *(none - all paths)*                 | `http://caddy:8080` |
| `archive-web` | `chrisrelf.cc` | `api.chrisrelf.cc`     | `^/?digitalarchive/v1/images(/.*)?$` | `http://caddy:8082` |
| `archive-web` | `chrisrelf.cc` | `api.chrisrelf.cc`     | *(none - all paths)*                 | `http://caddy:8081` |
| `archive-api` | `relf.cc`      | `api.relf.cc`          | `^/?digitalarchive/v1/images(/.*)?$` | `http://caddy:8082` |
| `archive-api` | `relf.cc`      | `api.relf.cc`          | *(none - all paths)*                 | `http://caddy:8081` |

**Why the API appears twice, on two domains.** `api.chrisrelf.cc` is the host
browsers are sent to, and it has to sit under `ROOT_DOMAIN` because that is
what scopes the session and OAuth-state cookies: a browser discards a
`Set-Cookie` whose `Domain` is not a suffix of the responding host, so an API
on an unrelated domain cannot sign anyone in - it fails with "OAuth state
mismatch" before the session is ever created.

`api.relf.cc` stays as the machine-facing endpoint for scrapers and uploads.
Those authenticate with an API key and never read a cookie, so a second domain
costs them nothing. Both map to the same two Caddy listeners.

**Rows sharing a hostname share a tunnel.** A public hostname is a CNAME to one
tunnel's `<uuid>.cfargotunnel.com`, and a DNS name holds exactly one CNAME, so
one hostname cannot be split across two tunnels. The text/images split is a
path rule *within* a tunnel.

## Setting them up (dashboard)

For each tunnel, in **Zero Trust → Networks → Tunnels**:

1. **Create a tunnel**, name it as in the table, choose **Cloudflared**.
2. Copy the token out of the install command - just the long string after
   `--token`. Put it in `.env` as `TUNNEL_TOKEN_WEB` or `TUNNEL_TOKEN_API`.
3. Add the **public hostname** rows from the table. Service type is **HTTP**
   (TLS terminates at Cloudflare; Caddy speaks plain HTTP on the compose
   network, and the origin leg has no TLS at all - so leave `No TLS Verify`
   off under **Additional application settings → HTTP Settings**).

Wherever a hostname has two rows, **add the images row first.** Rules are evaluated top to
bottom, so a catch-all sitting above the images rule swallows every image
request and sends it to the text listener, whose body limit is 2MB rather than
32MB - large uploads would fail with a 413 and nothing in the API logs.

### Why that path regex

The **Path** field is a Go-syntax regular expression, not a glob:

```
^/?digitalarchive/v1/images(/.*)?$
```

- `/?` - the dashboard shows a leading `/` next to the field and reports differ
  on whether the value is matched with or without it. Making the slash optional
  is correct either way.
- `(/.*)?$` - matches both `/digitalarchive/v1/images/<id>.webp` (the GET) and
  the bare `/digitalarchive/v1/images` (the upload POST). A pattern like
  `images/.*` matches only the first, which quietly routes uploads to the 2MB
  text listener.

Then:

```sh
make up-tunnels
```

The `tunnels` compose profile keeps the two cloudflared containers out of a
plain `make up`, which is what you want while developing locally.

## Edge cache rules

The origin already sends correct `Cache-Control`, so the useful thing to add
at the edge is a cache rule that lets Cloudflare honour it:

- **`api.chrisrelf.cc/digitalarchive/v1/images/*`** - Cache Level: Cache
  Everything, Edge TTL: *Respect origin*. Image bytes are immutable per id, so
  this is where almost all of the traffic should stop.
- **`api.chrisrelf.cc/digitalarchive/v1/*`** - Cache Level: Standard, and
  **bypass cache on cookie** `archive_session`. Archive reads vary by role;
  the origin sets `Vary: Cookie` and `private` for moderators, but an explicit
  bypass rule means a misconfiguration cannot leak a hidden record into a
  shared cache.
- **`api.relf.cc/digitalarchive/v1/ingress*`** and `/auth/*` - Cache Level:
  Bypass.

## WAF

Two rules worth having:

- Rate limit `POST /digitalarchive/v1/ingress` per IP. The API rate-limits per
  API key already; this is about unauthenticated flood traffic never reaching
  the homeserver.
- Block `/digitalarchive/v1/internal/*` at the edge. Caddy already 404s it and
  the endpoint is not bound on a public listener, but it costs nothing to stop
  it three layers out.

## If you later want images on their own tunnel

A third tunnel only becomes possible by giving images their own hostname, since
the constraint is one hostname per tunnel:

- `img.relf.cc` → `http://caddy:8082`

That needs a code change as well as a DNS record, in two places, because image
URLs are built independently on each side:

- `config.imageUrl()` in `apps/api/src/config.ts` composes them from
  `API_ORIGIN` + `API_PREFIX` - this is what ingress and upload responses hand
  back, and what gets persisted.
- `PUBLIC_API_BASE` in `apps/web/lib/api.ts` composes them for the browser.

Both would need an images base of their own, and `web` rebuilt - its copy is
baked in at build time as a `NEXT_PUBLIC_*` arg.
