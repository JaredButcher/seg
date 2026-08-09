# Deployment

Single VM, Docker Compose, Caddy for TLS and static files, SQLite on a volume. No database
container — that is the operational dividend of starting on SQLite (planning/10 §7).

```
              :80  ── everything redirected ──▶ :443
                                                 │
      ┌──────────────────────────────────────────▼─────┐
      │ caddy          TLS, static bundle, reverse proxy│
      │                                                 │
      │   SEG_SITE_ADDRESS  →  Let's Encrypt cert       │  external, via public DNS
      │   SEG_LAN_ADDRESS   →  Caddy's own CA           │  internal, via LAN IP/name
      │                                                 │
      │  /srv  ─────────────── the client bundle, baked into the image
      └───────┬─────────────────────────────────────────┘
              │  /api/*, /health, /ws  →  server:8787
      ┌───────▼────────┐
      │ server         │  Node, not published to the host
      │  /data ────────┼── seg-data volume: SQLite + replays
      └────────────────┘
```

## Run it

```bash
cp deploy/.env.example deploy/.env   # then edit SEG_SITE_ADDRESS and SEG_LAN_ADDRESS
cd deploy
docker compose up -d --build
```

With `SEG_SITE_ADDRESS` set to a hostname whose DNS points at the box, Caddy provisions a
Let's Encrypt certificate on first request. The defaults (`localhost` + `127.0.0.1`) need no
DNS at all, which is what a local smoke test wants — note that it is https now, and `-k`
because the certificate is signed by Caddy's own CA rather than a public one:

```bash
SEG_HTTP_PORT=8080 SEG_HTTPS_PORT=8443 docker compose up -d --build
curl -k https://localhost:8443/health
```

Plain http answers with a 308 to https. That redirect always points at port 443, so with the
ports remapped as above the redirect itself lands nowhere — request https directly.

Other useful commands:

```bash
docker compose logs -f server
docker compose ps                    # health status
docker compose down                  # stop, keep data
docker compose down -v               # stop and DELETE the database
```

## Two certificates: external and LAN

The site is served over two certificates, because one cannot cover both cases. A public CA
will not issue for `192.168.1.50` or `seg.lan` — it cannot validate ownership of an address
that means something different on every network — so a Let's Encrypt certificate is only
ever valid for the public DNS name, and LAN clients hitting the box directly got a name
mismatch.

| | address | issuer | trusted by |
|---|---|---|---|
| external | `SEG_SITE_ADDRESS` | Let's Encrypt, automatic | everyone |
| LAN | `SEG_LAN_ADDRESS` | Caddy's built-in CA (`tls internal`) | only clients that install the root |

Both site blocks `import seg-app`, so routing, caching, and proxying are the same on both —
the blocks differ only in the issuer and in HSTS.

### Trusting the LAN certificate

Until a LAN client trusts Caddy's root, it gets the browser warning. Export the root once
and install it on the machines that need LAN access:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./seg-lan-root.crt
```

The root lives in the `caddy-data` volume and is generated on first start. **Do not delete
that volume** — a new root means every client has to install the certificate again (it is
also what holds the Let's Encrypt account key and issued certificates).

Distributing a root certificate is not free: anything signed by it is trusted by that
machine for every site, so keep the private key in the volume and hand out only `root.crt`.
If the LAN has internal DNS, pointing a name like `seg.lan` at the box and using that as
`SEG_LAN_ADDRESS` is the tidier option.

### Why HSTS is only on the external block

`Strict-Transport-Security` is sent from the external site block and deliberately not from
the LAN one. HSTS makes a certificate warning **unbypassable** — no click-through. Sending
it from the LAN block would lock out every LAN client that has not installed the root, and
because the header is remembered per host, it would keep doing so after the config was
fixed.

### Ports

Everything arriving on :80 is redirected to https with a 308, including hosts that are not
`SEG_SITE_ADDRESS` or `SEG_LAN_ADDRESS` — someone typing the box's other IP still gets
upgraded rather than a 404. This does not interfere with certificate issuance: Caddy answers
ACME HTTP challenges before request routing, so `/.well-known/acme-challenge/*` is served
even though the redirect block claims every path.

The redirect targets port 443. Remapping `SEG_HTTPS_PORT` does not change it, so on a box
with the ports moved, clients have to be given the real port.

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
stored, and the symptom is "login appears to work and then does nothing". It is also why the
LAN address gets a real certificate rather than being left on plain http — over http, login
on the LAN would fail in exactly that silent way.

**`default_sni` in the Caddyfile.** A browser opening `https://192.168.1.50` sends no SNI —
the TLS spec forbids an IP literal there — so Caddy has no name with which to pick a
certificate. Its fallback is the IP the connection came in on, which inside a container is
the docker bridge address, never the LAN IP the certificate is for. Without `default_sni`
the handshake fails outright, with no warning the user can click through. Clients that use a
DNS name send SNI and never reach this path.

**Cache headers.** `/assets/*` is content-hashed by Vite and served `immutable` for a year;
everything else is `no-cache`. The second rule is written as "not `/assets/*`" rather than as
a match on `/index.html`, because header matchers see the *request* path — a request for `/`
is served index.html but never matches `/index.html`, so the obvious spelling silently misses
the most common request on the site and pins returning players to the previous deploy's
JavaScript.

**Volumes.** `seg-data` holds the SQLite file (plus `-wal` and `-shm`); `caddy-data` holds
certificates, the ACME account key, and the LAN CA's root and private key. Losing
`caddy-data` means re-issuing certificates on every restart, which will hit Let's Encrypt's
rate limits — and it regenerates the LAN root, so every LAN client has to install the new
one.

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

The two-certificate setup was checked against a real Caddy 2.11.4 running this Caddyfile,
with the proxy pointed at a stub backend — not against the compose stack, which needs a
docker daemon:

- The adapted config issues `SEG_SITE_ADDRESS` from ACME and `SEG_LAN_ADDRESS` from the
  `internal` issuer — two separate automation policies, as intended.
- The LAN address really is served a `Caddy Local Authority` certificate, with the LAN IP in
  the SAN; the external name is served its own certificate and is unaffected.
- HSTS is present on the external block and absent on the LAN block.
- Caching, proxying, SPA fallback, and the security headers behave identically through both
  blocks — the shared snippet is not silently diverging.
- http→https returns 308 for the external host, the LAN host, and an unrelated host that
  matches neither (the catch-all).
- A no-SNI handshake arriving on an IP the certificate does not cover — the docker case —
  fails without `default_sni` and succeeds with it.

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
