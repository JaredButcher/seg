# 01 — Architecture

## 1. Topology

```
                       ┌──────────────────────────────┐
   Browser             │  Node.js process             │
  ┌──────────────┐     │                              │
  │ React shell  │     │  ┌────────────────────────┐  │
  │  menus/lobby │◄───►│  │ HTTP: static + auth    │  │
  │  fleet build │     │  └────────────────────────┘  │
  │  results     │     │  ┌────────────────────────┐  │      ┌──────────┐
  ├──────────────┤     │  │ Realtime gateway (ws)  │  │◄────►│ Database │
  │ Scope canvas │◄───►│  ├────────────────────────┤  │      └──────────┘
  │  WebGL       │     │  │ Lobby service          │  │
  └──────────────┘     │  ├────────────────────────┤  │
                       │  │ Match host             │  │
                       │  │  ├ sim (shared pkg)    │  │
                       │  │  ├ acoustics solver    │  │
                       │  │  └ per-player view gen │  │
                       │  └────────────────────────┘  │
                       └──────────────────────────────┘
```

**Single process for 1.0.** Lobby service and match hosts live in the same Node process as the
HTTP server. This is a deliberate simplification: it removes service discovery, cross-process
state sync, and a message bus from the launch critical path.

**The seam that keeps this from being a mistake:** a match host communicates with the outside
world only through two narrow interfaces — `inbound: PlayerCommand` and
`outbound: PlayerView`. It never touches the database, never touches a socket, and never
reads global state. Moving a match host into a worker thread or a separate process later is
a transport swap at that seam, not a rewrite. See §5.

### Scaling path (post-1.0, do not build now)
1. Match hosts → `worker_threads` in the same process. Buys CPU parallelism across matches.
   A single sim tick is single-threaded and must stay under budget regardless.
2. Match hosts → separate processes / containers, with the gateway proxying by match id.
3. Gateway → horizontal, sticky-by-match, Redis for lobby registry.

**Note the tick budget this has to fit in:** the simulation runs at 20 Hz (50 ms per tick), with
the expensive acoustic and view phases on every second tick (04 §1). A single match's worst-case
tick must stay well inside 50 ms, and multiple concurrent matches share one thread until step 1
above happens. `bench-tick` guards this in CI (13 §9).

## 2. Package layout

pnpm workspace monorepo. Full directory tree in [10-repo-structure-tooling.md](10-repo-structure-tooling.md).

| Package | Depends on | Responsibility |
|---|---|---|
| `@seg/shared` | — | Simulation, acoustics, content tables, wire schema, math. **Zero I/O, zero Node APIs, zero DOM APIs.** Runs identically in browser and Node. |
| `@seg/server` | shared | HTTP, auth, persistence, lobby service, match host, per-player view generation |
| `@seg/client` | shared | React shell, scope renderer, input, audio |
| `@seg/tools` | shared | Balance-table validation, replay CLI, headless bot harness, load generator |

### Why the simulation is shared rather than server-only

The client does not run the authoritative simulation. It *does* need:
- Content tables, for the fleet builder to compute point costs and preview stats.
- Wire schema types, so encode/decode cannot drift.
- Vector/geometry math, for interpolation and for projecting contact solutions.
- Torpedo and hull kinematics, for drawing predicted-course lines the player has *earned* the
  information to see — including the projected-run preview on a firing solution (08 §5), which
  needs the same turning-circle arithmetic the server uses. A hull's own predicted course also
  needs the `speed·sin(pitch)` model, because boats are pitch-limited even though weapons are
  not (04 §7).
- Silhouette polygons, which are simultaneously sim geometry, scope sprites, and fleet-builder
  artwork (03 §6).

Sharing the module removes an entire class of "the builder said 340 points but the server said
355" bug. The cost is discipline: `@seg/shared` must never import `fs`, `ws`, `window`, or
anything from `node:`. Enforced by ESLint `no-restricted-imports` and a CI check.

## 3. Tech stack

### Decided

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, strict, `noUncheckedIndexedAccess` | Shared code across runtimes; the content tables benefit enormously from types |
| Runtime | Node.js 22 LTS | Stable `worker_threads`, native test runner available if needed, modern V8 |
| Package manager | pnpm workspaces | Fast, strict about phantom deps, good monorepo story |
| Bundler / dev server | Vite 6 | Fast HMR, first-class TS, trivial to add GLSL loader |
| Client UI framework | React 19 | Shell only — menus, lobby, fleet builder, results. Not on the render hot path. |
| Client state | Zustand | Small, no ceremony, easy to keep the scope renderer *out* of React's lifecycle |
| **Scope rendering** | **PixiJS v8** (WebGL, WebGPU where available) | Batched line rendering plus a filter pipeline for the bloom/persistence/scanline look (09), with an escape hatch to custom shaders where it matters. Alternatives rejected: Canvas2D is too slow for hundreds of glowing segments with per-segment alpha; Three.js is 3D machinery we do not need; hand-rolled WebGL is the best possible result and the worst schedule. |
| **Database** | **Generic SQL, SQLite first** — `better-sqlite3` at launch, Postgres as the growth path | Write volume is trivial (accounts, fleets, match results) and SQLite removes an entire service from the deployment. Portability is designed in from day one rather than promised — see §3.1 and 07 §6.1. |
| WS server | `ws` | Boring, fast, no framework opinions to fight later |
| Password hashing | argon2id (`@node-rs/argon2`) | Correct default for 2026; native bindings, no build pain |
| Session tokens | Opaque random token in DB, `HttpOnly; Secure; SameSite=Lax` cookie | Simpler than JWT for a system with server-side session state anyway; instant revocation |
| Unit/integration tests | Vitest | Shares the Vite pipeline; fast; good snapshot support for sim regression |
| E2E | Playwright | Needed for signup→lobby→match smoke; can drive two browsers for a real 1v1 test |
| Logging | pino | Structured JSON, cheap enough to leave on in the tick loop at `info` |

### Still open

| Concern | Recommendation | Alternatives considered |
|---|---|---|
| Schema migrations | Numbered `.sql` files + a tiny runner, written to the portable subset (§3.1) | Fine at this size; no migration framework earns its weight against six tables |
| Deployment | Single VM, Docker Compose, Caddy for TLS + static | Managed platforms fight persistent WebSocket connections and in-memory match state |

### Deliberately deferred to post-1.0
WebRTC data channels, binary codec, Redis, horizontal scaling, CDN for assets, observability
stack beyond pino + a health endpoint.

## 3.1 Generic SQL — what that actually requires

"SQLite now, Postgres later" is only true if portability is enforced continuously. A repository
interface alone is not enough: it hides *where* queries live, not *what dialect they are written
in*. Three rules, all mechanically checkable:

**1. No ORM, and no query builder.** Hand-written SQL against six tables is less code than an
ORM's configuration, and it keeps the dialect surface visible in review rather than buried in a
library's codegen. This is a deliberate choice, not an omission.

**2. Write to the portable subset.** Everything below is supported by both SQLite (3.35+) and
Postgres (12+), which is a comfortable amount of SQL to build on:

| Use | Avoid |
|---|---|
| `INSERT … ON CONFLICT … DO UPDATE` | SQLite `INSERT OR REPLACE`, PG-only `MERGE` |
| `RETURNING` | Dialect-specific last-insert-id |
| Application-generated UUIDs as `TEXT` | `AUTOINCREMENT` / `SERIAL` / `IDENTITY` |
| Epoch-millisecond `INTEGER` timestamps | `TIMESTAMP` / `TIMESTAMPTZ`, whose semantics differ |
| `INTEGER` 0/1 for booleans | `BOOLEAN` — SQLite has no such type |
| A `username_lower` column + plain unique index | `COLLATE NOCASE` (SQLite) / `CITEXT` (PG) |
| `TEXT` for JSON blobs nothing queries into | `JSONB` operators, `json_extract` |
| Plain `CREATE INDEX` | Partial, expression, and covering indexes |

**3. Isolate the two things that genuinely differ.** A thin `SqlDialect` shim, not an abstraction
layer:
- **Placeholders** — SQLite `?`, Postgres `$1`. The only pervasive syntactic difference, and the
  reason to run every query through one small helper.
- **Column types in DDL** — a type-name mapping applied when migrations are executed.
- **Connection semantics** — SQLite needs WAL mode, a busy timeout, and `BEGIN IMMEDIATE` for
  write transactions; Postgres needs a pool. Both sit behind the same `Db` handle.

**Prove it rather than assume it.** The repository test suite runs against **both** a real SQLite
file and a Postgres instance in CI from M5 (13 §8). A portability claim that is never executed is
a portability claim that is false — this is the whole reason to decide "generic SQL" now instead
of discovering the coupling during a migration under load.

## 4. Key internal interfaces

These four seams are the ones worth designing now, because everything else is arranged
around them.

### 4.1 `Transport` — one network path, with an identity
```ts
interface Transport {
  readonly id: TransportId;                        // 'ws' | 'rtc'
  readonly guarantees: ReadonlySet<Delivery>;      // what this path can actually promise
  send(channel: ChannelId, payload: Uint8Array): void;
  onMessage(handler: (channel: ChannelId, payload: Uint8Array) => void): Unsubscribe;
  onClose(handler: (reason: CloseReason) => void): Unsubscribe;
  close(reason?: string): void;
  readonly stats: { rttMs: number; outboundBytesPerSec: number; queuedBytes: number };
}
type ChannelId = 'control' | 'commands' | 'view';
type Delivery = 'reliable-ordered' | 'reliable-unordered' | 'unreliable-sequenced';
```
Note the payload is `Uint8Array` even in the JSON era — JSON is UTF-8 encoded at the codec
layer, not at the transport layer. This is what keeps adding WebRTC from rippling.

### 4.1a `Link` — two transports at once, one per channel
```ts
type TransportPolicy =
  | { kind: 'pinned';    transport: TransportId }
  | { kind: 'preferred'; order: TransportId[] };   // first healthy one wins

interface Link {
  send(channel: ChannelId, payload: Uint8Array): void;
  onMessage(handler: (channel: ChannelId, payload: Uint8Array) => void): Unsubscribe;
  register(transport: Transport): void;
  /** Where each channel is actually going right now. Drives the dev overlay and the tests. */
  readonly routing: ReadonlyMap<ChannelId, TransportId>;
}
```

**WebRTC is an addition, not a replacement.** Once it exists both transports are live for the
whole session: `control` is pinned to the WebSocket permanently — all lobby traffic, all
signalling, all route changes — while `commands` and `view` prefer WebRTC and fall back to the
WebSocket whenever it is unavailable or unhealthy.

The seam that matters is that **game code addresses a channel and never a transport**. Routing
is data the Link owns, so moving `view` onto a data channel is a policy change rather than a
code change, and reverting it under fire is the same. Rationale for pinning `control`, the
handover protocol, and the cross-channel ordering constraint that two transports introduce are
all in [02-netcode-protocol.md](02-netcode-protocol.md) §3.

### 4.2 `Codec` — swap JSON for binary
```ts
interface Codec {
  encode<T extends Message>(msg: T): Uint8Array;
  decode(bytes: Uint8Array): Message;
}
```
Both sides negotiate the codec during the handshake. `JsonCodec` ships at launch;
`BinaryCodec` is generated from the same schema later.

### 4.3 `MatchHost` — the isolation boundary that makes scaling possible
```ts
interface MatchHost {
  submit(playerId: PlayerId, cmd: PlayerCommand, receivedAtTick: Tick): void;
  onView(handler: (playerId: PlayerId, view: PlayerView) => void): Unsubscribe;
  onEnded(handler: (result: MatchResult) => void): Unsubscribe;
  tick(): void;              // driven by the scheduler at 20 Hz, never self-scheduling
  snapshot(): MatchSnapshot; // for reconnect
}
```
A match host is a pure function of its inputs plus its seed. It does not know what a socket is.
`onView` fires on every second tick (10 Hz), not every tick — see 04 §1.

### 4.5 `Controller` — the seam that keeps bots possible
Bots are out of scope for 1.0, but the interface that would accept one costs nothing now:

```ts
interface Controller {
  readonly kind: 'remote' | 'scripted' | 'bot';
  update(view: PlayerView, tick: Tick): PlayerCommand[];
}
```

The signature is the design: a controller receives `PlayerView` — the same lossy, stale,
sensor-derived picture a human gets — and never world state. A future bot is structurally
incapable of cheating, and the `ScriptedController` used for testing is held to the same
standard, which means tests exercise the real information path. Detail in 04 §10.

### 4.4 `Repository` and `Db` — swap SQLite for Postgres
```ts
interface Repositories {
  accounts: AccountRepo;
  fleets: FleetRepo;
  matches: MatchResultRepo;
  sessions: SessionRepo;
}

/** The only thing repositories talk to. One implementation per engine. */
interface Db {
  query<T>(sql: SqlFragment, params: unknown[]): Promise<T[]>;
  exec(sql: SqlFragment, params: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  readonly dialect: SqlDialect;
}
```

Two seams rather than one, deliberately. `Repositories` is what game code sees and is where the
domain lives; `Db` is where the dialect lives (§3.1). Repositories are written **once** and run
against both engines — they are not reimplemented per database, which is the mistake that makes
"we can swap it later" untrue.

Concrete schema in [07-lobby-accounts-persistence.md](07-lobby-accounts-persistence.md) §6.

## 5. The authority model

**Rule 1 — The server owns all state.** The client is a renderer and an input device. There
is no client-side simulation of anything that affects outcomes.

**Rule 2 — The server never sends a playing client information that client's boats have not
sensed.** Not "the client hides it" — the bytes never leave the server. Enemy ground-truth
position is not on the wire, so it cannot be extracted from the wire. This closes maphack
cheating structurally rather than by obfuscation.

This property is asserted by an automated test, not merely by convention: the **ground-truth
test** (13 §8) decodes every byte sent to a client during a real match and fails if any enemy
entity's true position appears anywhere in the stream. It is the most important test in the
project and it is written at M2, the moment view generation exists.

Consequences to accept up front:
- Bandwidth is per-player, not per-match. Ten players = ten independently generated view
  streams. This is a real CPU and memory cost (see 03 §10), paid deliberately.
- Client-side prediction of *other* entities is impossible and unnecessary. The design's slow
  pace means order latency is invisible; a 150 ms delay on a course change does not matter when
  the turn takes 40 seconds.
- What the client *does* interpolate: its own boats (smooth motion between the 10 Hz view
  frames, even though the server simulates at 20 Hz) and contact marker positions (smoothing,
  never extrapolating past what was sensed).

**Rule 3 — Vision is a property of the team, not the player.** Teammates share their complete
sensory picture: contacts, tracks, echo returns, and revealed terrain. There is no per-player fog
of war within a team, and no mechanic for withholding or selectively sharing information from a
teammate.

This is a design decision (C17) with a large architectural dividend, which is why it was settled
before any of the solve was written:

```
per team   →  acoustic solve, tracker, echo queues, terrain reveal   (the expensive work)
per player →  own boat states, orders, tube status, alerts, camera   (cheap, small)
```

A `PlayerView` is therefore `TeamView + PlayerPrivateView`. The team half is computed **once** and
referenced by every player on that team; only the small private half is per-player. With 3–8
players a side this is the biggest constant-factor saving in the server, and it makes the
spectator implementation nearly free (below).

Note what it does *not* change: bandwidth. Each player still receives the team stream over their
own connection, so the per-player budget in 02 §6 stands. The saving is CPU and memory, not bytes.

**Rule 4 — Spectators are a vision policy, not a special player.** A team-limited spectator simply
receives an existing `TeamView` with an empty private half — no second code path, no separate
generation. "God view" spectators are an explicit host setting, off by default, because a
spectator on voice comms is a maphack with extra steps.

## 6. Determinism

The simulation is deterministic given `(seed, initial state, ordered command stream)`. This
is not for lockstep networking — we are server-authoritative — it is for:

- **Replays.** Record commands, not state. A 20-minute match is a few hundred KB.
- **Regression tests.** Golden-file a 500-tick scenario; any acoustics change that shifts the
  outcome shows up as a diff, and a human decides whether the diff was intended.
- **Bug reproduction.** "Attach your replay" turns an unreproducible report into a unit test.

Testing detail in [13-testing.md](13-testing.md) §6. Rules that make it hold, enforced by lint
and code review:
- All randomness from an injected seeded PRNG (xoshiro128\*\*), never `Math.random()`.
- No wall-clock time inside the sim. `tick` is the only clock.
- No iteration over unordered collections where order affects results — entity iteration is
  over a stable, insertion-ordered array of ids.
- Floating point is acceptable **because we do not cross-validate between machines.** Only
  the server runs the sim; replays are replayed on the same architecture. If cross-platform
  replay determinism is ever needed, that is the moment to consider fixed-point, not before.

## 7. Failure and reconnection

| Failure | Behaviour |
|---|---|
| Client socket drops mid-match | Boats continue executing standing orders. Player has a 90 s [TBD] reconnect window; `snapshot()` restores their view. Team is notified. |
| Player never returns | Boats hold last orders and remain targetable. Not removed — removing them would be a griefing lever. [TBD: whether a teammate can adopt them.] |
| Host leaves the lobby (pre-match) | Host migrates to the longest-connected remaining player. |
| Host leaves mid-match | Nothing happens. The server owns the match; "host" is a lobby-configuration role only. This is worth stating because it is a common wrong assumption. |
| Server process crashes | Match is lost. Accepted for 1.0 — matches are short. Snapshots exist for reconnect, not for crash recovery. |
| Sim tick overruns budget | Log, emit metric, continue. Never drop a tick silently; never try to catch up by running two ticks back to back (that makes the pathology worse). |

## 8. Security posture

- **Input validation at the codec boundary.** Every inbound message is schema-validated before
  it reaches game code. Malformed → close the connection, do not attempt recovery.
- **Command authorization in the match host.** Every command carries the entity it targets; the
  host verifies that entity belongs to that player. A client asking a boat it does not own to
  turn is a protocol violation, logged and dropped.
- **Rate limiting** per connection on commands (see 02 §7) and per IP on auth endpoints.
- **Passwords:** argon2id, per-user salt, sane parameters, minimum length 10, no composition
  rules, checked against a small list of the most common passwords.
- **No email, no recovery.** Stated at signup with a confirmation step. See 07 §2.
- **No user-generated content** at launch beyond username and fleet names — both length-capped
  and character-restricted. This dodges the entire moderation problem for 1.0.
