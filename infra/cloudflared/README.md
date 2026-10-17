# Tunnels

Three tunnels, one per surface. Each gets its own token, its own container and
its own failure domain, so saturating the image tunnel cannot slow archive
reads.

| Tunnel          | Public hostname      | Path                              | Origin              |
| --------------- | -------------------- | --------------------------------- | ------------------- |
| `archive-web`   | `archive.domain.com` | *(none - all paths)*              | `http://caddy:8080` |
| `archive-text`  | `api.domain.com`     | *(none - all paths)*              | `http://caddy:8081` |
| `archive-images`| `api.domain.com`     | `digitalarchive/v1/images/.*`     | `http://caddy:8082` |

Cloudflare matches the **most specific path first**, so the images rule wins
for `api.domain.com/digitalarchive/v1/images/...` and everything else on that
hostname falls through to the text tunnel.

## Setting them up (dashboard)

For each of the three, in **Zero Trust → Networks → Tunnels**:

1. **Create a tunnel**, name it as in the table, choose **Cloudflared**.
2. Copy the token out of the install command - just the long string after
   `--token`. Put it in `.env` as `TUNNEL_TOKEN_WEB`, `TUNNEL_TOKEN_TEXT` or
   `TUNNEL_TOKEN_IMAGES`.
3. Add a **public hostname** with the hostname, path and origin from the table.
   Service type is **HTTP** (TLS terminates at Cloudflare; Caddy speaks plain
   HTTP on the compose network).
4. Under **Additional application settings → HTTP Settings**, leave
   `No TLS Verify` off - there is no TLS on the origin leg at all.

Then:

```sh
make up-tunnels
```

The `tunnels` compose profile keeps the three cloudflared containers out of a
plain `make up`, which is what you want while developing locally.

## Edge cache rules

The origin already sends correct `Cache-Control`, so the useful thing to add
at the edge is a cache rule that lets Cloudflare honour it:

- **`api.domain.com/digitalarchive/v1/images/*`** - Cache Level: Cache
  Everything, Edge TTL: *Respect origin*. Image bytes are immutable per id, so
  this is where almost all of the traffic should stop.
- **`api.domain.com/digitalarchive/v1/*`** - Cache Level: Standard, and
  **bypass cache on cookie** `archive_session`. Archive reads vary by role;
  the origin sets `Vary: Cookie` and `private` for moderators, but an explicit
  bypass rule means a misconfiguration cannot leak a hidden record into a
  shared cache.
- **`api.domain.com/digitalarchive/v1/ingress*`** and `/auth/*` - Cache Level:
  Bypass.

## WAF

Two rules worth having:

- Rate limit `POST /digitalarchive/v1/ingress` per IP. The API rate-limits per
  API key already; this is about unauthenticated flood traffic never reaching
  the homeserver.
- Block `/digitalarchive/v1/internal/*` at the edge. Caddy already 404s it and
  the endpoint is not bound on a public listener, but it costs nothing to stop
  it three layers out.

## Alternative: a separate hostname

If path-based tunnel splitting feels fragile, give the images API its own
hostname instead:

- `images.domain.com` → `http://caddy:8082`

Then set `API_ORIGIN` for image URLs accordingly. The only code change is
`config.imageUrl()` in `apps/api/src/config.ts`; nothing else constructs image
URLs.
