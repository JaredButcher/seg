# syntax=docker/dockerfile:1

# Two images out of one file: `server` (the Node process) and `web` (Caddy with the client
# bundle baked in). Build context is the repo root.
#
# Why the bundle is baked into the Caddy image rather than shared through a volume: a named
# volume is populated once, on first run, and then never updated — so a deploy would ship a
# new server against last week's JavaScript, with nothing to indicate it. Baking makes the
# bundle and the image the same artifact, which is also what makes rollback mean anything.

# bookworm-slim, not alpine: better-sqlite3 and @node-rs/argon2 both ship glibc prebuilds.
# On musl they compile from source, which means a toolchain in the image and a much slower
# build for no benefit.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable pnpm
WORKDIR /app

# ── dependency install ─────────────────────────────────────────────────────────────
# Manifests only, so this layer is cached until a dependency actually changes.
FROM base AS manifests
# better-sqlite3 has a binding.gyp and is opted into building by `allowBuilds` in
# pnpm-workspace.yaml, so pnpm runs an implicit `node-gyp rebuild` — which needs Python and
# a C++ toolchain that bookworm-slim does not ship. These stages are discarded; only the
# resulting node_modules is copied into the runtime image, so nothing here reaches
# production. (The package does ship a linux-x64 prebuild, so removing that `allowBuilds`
# entry would skip this entirely — but that is a workspace-wide decision, not a deploy one.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
COPY packages/tools/package.json ./packages/tools/

FROM manifests AS deps-full
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Runtime dependencies only. `tsx` is among them — @seg/shared is consumed from source with
# no build step (planning/01 §2), so tsx is what runs the server in production, not a dev
# tool. It is in `dependencies` for exactly this reason.
FROM manifests AS deps-prod
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @seg/server...

# ── client bundle ──────────────────────────────────────────────────────────────────
FROM deps-full AS client-build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/client ./packages/client
RUN pnpm --filter @seg/client build

# ── the Caddy image: TLS, static files, and the reverse proxy ───────────────────────
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=client-build /app/packages/client/dist /srv
# Fails the build rather than the deploy if the bundle did not land where Caddy expects.
RUN test -f /srv/index.html

# ── the Node server ────────────────────────────────────────────────────────────────
FROM base AS server
ENV NODE_ENV=production

COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=deps-prod /app/packages/server/node_modules ./packages/server/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# The SQLite file and replay storage live on a mounted volume. The directory is created
# here and owned by `node` so the unprivileged process can write to it on first boot.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data

EXPOSE 8787

# Node 22 has global fetch, so this needs nothing installed. Compose restarts an unhealthy
# container; without a check a server that has wedged keeps taking traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SEG_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run from the server package, not the repo root. pnpm's isolated layout puts `tsx` in
# packages/server/node_modules, and `--import tsx` is resolved relative to the working
# directory — from /app it is simply not found.
WORKDIR /app/packages/server

# Exec form, so the process is PID 1 and receives SIGTERM directly — which is what the
# graceful shutdown in packages/server/src/index.ts is waiting for.
CMD ["node", "--import", "tsx", "src/index.ts"]
