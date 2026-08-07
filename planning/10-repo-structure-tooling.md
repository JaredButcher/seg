# 10 — Repo Structure & Tooling

## 1. Directory layout

```
seg/
├─ planning/                    # these documents
├─ packages/
│  ├─ shared/                   # @seg/shared — no I/O, runs in browser and Node
│  │  ├─ src/
│  │  │  ├─ math/               # vec2, angles, seeded PRNG, interpolation
│  │  │  ├─ content/            # hulls, modules, torpedoes, acoustics; content hash
│  │  │  ├─ mapgen/             # the generator (14) — pure, deterministic, versioned
│  │  │  │  ├─ skeleton.ts      # region sequence, route graph — invariants by construction
│  │  │  │  ├─ carve.ts         # rasterize, detail, clearance repair
│  │  │  │  ├─ contours.ts      # marching squares, simplification
│  │  │  │  ├─ sectors.ts       # convex decomposition + portals (the shared structure)
│  │  │  │  ├─ propagation.ts   # all-pairs acoustic precompute (03 §5.2)
│  │  │  │  ├─ placement.ts     # deployment zones, objectives, layers
│  │  │  │  └─ validate.ts      # the invariant assertions (14 §3)
│  │  │  ├─ sim/
│  │  │  │  ├─ world.ts         # entity store, spatial hash
│  │  │  │  ├─ tick.ts          # the 20 Hz loop, 10 Hz acoustic phase (04 §1)
│  │  │  │  ├─ movement.ts      # pitch-band kinematics, ballast
│  │  │  │  ├─ terrain.ts       # contours, sectors, portals, segment queries
│  │  │  │  ├─ navigation.ts    # per-hull navmesh filtering, A*, string-pulling
│  │  │  │  ├─ controller.ts    # Controller interface (01 §4.5, 04 §10)
│  │  │  │  ├─ acoustics/       # emit, propagate, detect, echo wavefronts
│  │  │  │  ├─ tracker.ts       # detections → contacts
│  │  │  │  ├─ weapons.ts
│  │  │  │  ├─ damage.ts
│  │  │  │  ├─ objectives.ts
│  │  │  │  └─ stats.ts
│  │  │  ├─ view/               # per-player view generation + delta encoding
│  │  │  ├─ protocol/           # schema.ts, codecs (json, binary), field descriptors
│  │  │  └─ fleet/              # fleet validation, cost resolution, modifier resolver
│  │  └─ test/
│  ├─ server/                   # @seg/server
│  │  ├─ src/
│  │  │  ├─ http/               # static, auth routes, health
│  │  │  ├─ auth/               # argon2, sessions, rate limiting
│  │  │  ├─ db/
│  │  │  │  ├─ dialect.ts       # SqlDialect: placeholders, DDL types (01 §3.1)
│  │  │  │  ├─ sqlite.ts        # Db impl — better-sqlite3, WAL, busy timeout
│  │  │  │  ├─ postgres.ts      # Db impl — pool. Exists from M5 for CI parity.
│  │  │  │  ├─ migrations/      # numbered .sql, portable subset
│  │  │  │  └─ repos/           # written once, run against both engines
│  │  │  ├─ realtime/           # ws gateway, WsTransport, connection registry
│  │  │  ├─ lobby/              # lobby service, server browser
│  │  │  ├─ match/              # MatchHost, scheduler, view dispatch, replay writer
│  │  │  └─ index.ts
│  │  └─ test/
│  ├─ client/                   # @seg/client
│  │  ├─ src/
│  │  │  ├─ net/                # transport, codec negotiation, view store
│  │  │  ├─ scope/              # renderer, layers, shaders, camera
│  │  │  ├─ ui/                 # React: screens, panels, HUD, fleet builder
│  │  │  ├─ audio/
│  │  │  ├─ input/              # keybinds, selection, order issuing
│  │  │  └─ main.tsx
│  │  └─ test/
│  └─ tools/                    # @seg/tools
│     ├─ src/
│     │  ├─ scenario/           # the scenario DSL — tests, balance, practice range (13 §13)
│     │  ├─ balance-matrix.ts   # detection range matrices (03 §11)
│     │  ├─ replay.ts           # headless replay + determinism check
│     │  ├─ loadtest.ts         # synthetic clients against a running server
│     │  ├─ map-gallery.ts      # render a grid of seeds for human review (14 §12)
│     │  ├─ map-inspect.ts      # single seed: sectors, portals, navmesh, invariant report
│     │  ├─ bench-acoustics.ts  # the perf guardrail (03 §10)
│     │  ├─ bench-mapgen.ts     # generation + precompute inside the match-start budget
│     │  └─ bench-tick.ts       # full 20 Hz tick budget
│     └─ fixtures/              # recorded replay corpus, scenario fixtures
├─ deploy/                      # Dockerfile, compose, Caddyfile
├─ docs/                        # player-facing docs, generated content reference
├─ src/                         # (existing empty dir — remove or repoint at packages/)
├─ package.json                 # workspace root
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ CLAUDE.md                    # written at M0, points at planning/
```

Note the existing top-level `src/` from the initial scaffold. Recommend deleting it in favour
of `packages/` — a monorepo with both is confusing.

## 2. TypeScript configuration

`tsconfig.base.json` with, non-negotiably:

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "isolatedModules": true,
  "moduleResolution": "bundler",
  "target": "ES2022"
}
```

`noUncheckedIndexedAccess` will be irritating in the sim's array-heavy hot paths and is worth
it — entity lookups by id are exactly where an undefined slips through and becomes a `NaN`
position two ticks later.

Project references between packages so `pnpm build` is incremental and `shared` type errors
surface immediately in both dependants.

## 3. Enforced boundaries

`@seg/shared` purity is the constraint that makes the whole architecture work, so it is
enforced mechanically rather than by convention:

- ESLint `no-restricted-imports` in `packages/shared`: bans `node:*`, `fs`, `ws`, `react`, and
  any DOM global usage (via `eslint-plugin-no-restricted-globals` for `window`, `document`,
  `performance`, `localStorage`).
- A CI step that builds `shared` for a browser target and fails on any Node polyfill.
- ESLint rule banning `Math.random()` and `Date.now()` in `packages/shared/src/sim/**` — the
  determinism guarantee (01 §6) is worth a custom rule.
- Dependency-cruiser check: `client` and `server` may depend on `shared`; `shared` depends on
  nothing internal; `client` and `server` never depend on each other.

## 4. Testing

**[13-testing.md](13-testing.md) is the authority.** Summary of the tooling side:

| Level | Tool | Runs |
|---|---|---|
| Unit | Vitest | Every PR |
| Simulation scenario | Vitest + the scenario DSL | Every PR |
| Content validation | `content:validate` | Every PR |
| Determinism | `tools/replay` over the fixture corpus | Every PR |
| Balance | `tools/balance-matrix` | Every PR, diff posted |
| Protocol property/fuzz | Vitest + `fast-check` | Every PR |
| Authority / ground-truth | Vitest + in-process server | Every PR |
| Performance | `bench-acoustics`, `bench-tick`, `bench-bandwidth` | Every PR, fail on >10% regression |
| Integration | Vitest + in-process server + synthetic clients | Every PR |
| E2E | Playwright, two browser contexts | Main and release branches only |

Testing is set up in **M0** and carries real weight in **M1** — the scenario harness and its
initial corpus are M1 deliverables, not later polish (13 §15). Coverage targets are in 13 §14
and are deliberately uneven: 95% on `sim/acoustics`, none on client code.

## 5. Local development

```bash
pnpm i
pnpm dev          # server (tsx watch) + client (vite) concurrently
pnpm dev:bots     # server + N scripted clients, for solo testing of multiplayer flows
pnpm test         # vitest
pnpm test:e2e     # playwright
pnpm content:validate
pnpm balance:matrix
pnpm map:gallery      # grid of generated maps for a seed range — human review
pnpm map:inspect <seed>
pnpm replay <file>
pnpm replay:corpus
pnpm bench
```

`pnpm map:gallery` is worth calling out. Property tests prove the generator is *correct*; only a
human looking at a hundred maps at once catches "these are all boring," "this archetype never
appears," or "every seed has the same shape in the middle." Run it on every generator change and
put the image in the PR.

`pnpm dev:bots` deserves emphasis, and a clarification. It runs **scripted test clients**, not
game bots — `ScriptedController` instances (04 §10) that join a lobby, deploy a fleet, and
execute canned behaviour. A multiplayer game that needs two humans to test any change is a game
that gets tested rarely, so this exists by **M2**. The same fixtures then serve three consumers:
integration tests (13 §10), the balance harness, and the Practice Range's authored scenarios
(06 §7). None of that is a bot, and none of it ships as an opponent in the lobby.

### Developer affordances in dev builds only
- Truth overlay (03 §10) — server-side flag, data not sent at all in production.
- Tick-step and pause controls.
- Network condition simulator: injected latency, jitter, and packet loss, so the reconnection
  and interpolation paths are exercised routinely rather than discovered in production.
- Bandwidth and tick-time overlays, always on in dev.

## 6. CI

On every PR:
1. Install, typecheck all packages
2. Lint + boundary checks (§3)
3. Unit + scenario tests
4. Content validation
5. Determinism replay over the fixture corpus
6. Protocol property and fuzz tests
7. Authority tests, including the ground-truth test (13 §8)
8. Balance matrix → diff posted to the PR
9. Benchmarks (`bench-acoustics`, `bench-tick`, `bench-bandwidth`) → fail on > 10% regression
10. Snapshot-churn check → flag PRs updating more than N snapshots (13 §13)
11. Build client + server
12. E2E smoke (main and release branches only — too slow for every PR)

On merge to main: build and push a Docker image tagged with the commit.

## 7. Deployment

Single VM. Docker Compose: the Node process, Caddy for TLS termination and static file serving,
a volume for the SQLite file and replay storage. No database container at launch — that is the
main operational dividend of starting on SQLite, and swapping in Postgres later is a compose
service plus a connection string, because the repository layer already runs against both
(01 §3.1).

- Client is a static bundle served by Caddy with long-lived hashed asset caching and a
  no-cache `index.html`.
- WebSocket upgrade proxied through Caddy to Node.
- Health endpoint reporting process uptime, active matches, connected players, and p95 tick
  time against the 50 ms budget. Tick time is the metric that predicts trouble.
- Backups: nightly SQLite `.backup` (the online API — never a file copy of a live WAL database)
  to object storage. Small data, cheap insurance.
- Deploys drain: stop accepting new lobbies, wait for active matches to finish (cap ~25 min),
  then swap. In-progress matches are not migrated — see 01 §7.

## 8. Conventions

- **Formatting:** Prettier, default config, no debate.
- **Commits:** Conventional Commits, scoped by package (`feat(sim): …`).
- **Branches:** short-lived off `main`; PR required; squash merge.
- **ADRs** in `docs/adr/` for decisions that reverse an earlier one — particularly the ones
  in [12-open-questions.md](12-open-questions.md) as they resolve. A one-page ADR when a TBD
  closes is how these planning docs stay true over time.
- **Planning docs are living.** When implementation diverges from a plan, update the plan in
  the same PR. A stale plan is worse than no plan.
