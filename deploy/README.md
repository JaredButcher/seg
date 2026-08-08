# Deployment

Single VM, Docker Compose, Caddy for TLS and static files, SQLite on a volume. No database
container — that is the operational dividend of starting on SQLite (planning/10 §7).

```
          :80 / :443
              │
      ┌───────▼────────┐
      │ caddy          │  TLS, static bundle, reverse proxy
      │  /srv  ────────┼── the client bundle, baked into the image
      └───────┬────────┘
              │  /api/*, /health, /ws  →  server:8787
      ┌───────▼────────┐
      │ server         │  Node, not published to the host
      │  /data ────────┼── seg-data volume: SQLite + replays
      └────────────────┘
```

## Run it

```bash
cp deploy/.env.example deploy/.env   # then edit SEG_SITE_ADDRESS
cd deploy
docker compose up -d --build
```

With `SEG_SITE_ADDRESS` set to a hostname whose DNS points at the box, Caddy provisions a
certificate on first request. With the default `:80` it serves plain http, which is what a
local smoke test wants:

```bash
SEG_HTTP_PORT=8080 SEG_HTTPS_PORT=8443 docker compose up -d --build
curl localhost:8080/health
```

Other useful commands:

```bash
docker compose logs -f server
docker compose ps                    # health status
docker compose down                  # stop, keep data
docker compose down -v               # stop and DELETE the database
```

## What the two images are

One `Dockerfile`, two targets.

- **`server`** — Node 22 on bookworm-slim, runtime dependencies only, running as `node`.
  No build step: `@seg/shared` is consumed from source and `tsx` loads it (planning/01 §2),
  which is why `tsx` is a production dependency of `@seg/server` rather than a dev one.
- **`web`** — Caddy with the client bundle copied to `/srv` at build time.

The bundle is **baked into the image, not shared through a volume**. A named volume is
populated once on first run and never updated, so a deploy would ship a new server against
last week's JavaScript with nothing to indicate it. Baking makes the bundle and the image
one artifact, which is also what makes a rollback mean anything.

## Things that are load-bearing

**The server is not published to the host.** It has no `ports:` — only Caddy can reach it,
across the compose network. This is what makes `SEG_TRUST_PROXY=true` safe: the server
believes `X-Forwarded-For`, and per-IP auth rate limiting (planning/02 §7) depends on that
header being truthful. **If the server is ever published directly, `SEG_TRUST_PROXY` must go
back to `false`**, or anyone can spoof their way around the rate limiter.

**`SEG_SECURE_COOKIES=true`.** Sessions are `HttpOnly; Secure; SameSite=Lax`. This is why the
site must be behind TLS in production: a `Secure` cookie over plain http is silently never
stored, and the symptom is "login appears to work and then does nothing".

**Cache headers.** `/assets/*` is content-hashed by Vite and served `immutable` for a year;
everything else is `no-cache`. The second rule is written as "not `/assets/*`" rather than as
a match on `/index.html`, because header matchers see the *request* path — a request for `/`
is served index.html but never matches `/index.html`, so the obvious spelling silently misses
the most common request on the site and pins returning players to the previous deploy's
JavaScript.

**Volumes.** `seg-data` holds the SQLite file (plus `-wal` and `-shm`); `caddy-data` holds
certificates and the ACME account key. Losing `caddy-data` means re-issuing certificates on
every restart, which will hit Let's Encrypt's rate limits.

## Verified

Checked against a running stack, not just built:

- Both containers reach `healthy`; Caddy waits on the server's health check.
- `/` and `/index.html` and SPA-fallback paths → `no-cache`; `/assets/*.js` → `immutable`.
- `/health` and the five auth endpoints proxy correctly; signup → cookie → `/me` round-trips
  with `Secure; HttpOnly; SameSite=Lax` set.
- An unknown path returns index.html with 200 (SPA fallback).
- `docker compose stop` exits 0 immediately — SIGTERM reaches PID 1 and the graceful
  shutdown in `packages/server/src/index.ts` runs, rather than waiting out the 30 s kill.
- Data survives a container restart on the volume; SQLite is in WAL mode.
- The runtime image has no compiler toolchain and runs as uid 1000.

## Not built yet

- **Backups.** planning/10 §7 wants a nightly SQLite `.backup` — the online API, never a file
  copy of a live WAL database — pushed to object storage. There is no backup service here.
- **Drain on deploy.** `stop_grace_period` is 30 s, enough for in-flight requests. planning
  wants new lobbies refused and active matches allowed to finish, capped around 25 minutes.
  There is nothing to drain until matches exist.
- **A richer health endpoint.** `/health` reports uptime, protocol version, and tick rate.
  planning/10 §7 also wants active matches, connected players, and p95 tick time against the
  50 ms budget — tick time being the metric that predicts trouble.
- **CI publishing.** planning/10 §6 wants an image built and pushed on merge to main, tagged
  with the commit. Compose builds locally today.
- **`/ws`** is proxied, but the realtime gateway is not mounted on the HTTP server yet, so it
  returns 502 until that lands.
