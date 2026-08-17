# 17 — Netcode Performance & the WebRTC Transition

**Status:** §3's benchmarks and §4's instrumentation are **built and measured** (2026-08-17); §5's
levers, §6's parallelism and §7's WebRTC work are proposals. Every figure below now says whether it
was measured or derived. The measurements are reproducible with `pnpm bench:netcode*` (§9).

> **The headline, and it is not what this document expected.** Publishing is **2–13% of a tick at
> every fleet size measured** — server CPU for netcode is not a constraint and Q-17.1 is answered
> in the opposite direction from the one §2.1 was worried about. **Bandwidth is catastrophically
> over budget**: 53 KB/s per player at the *design target* against an 8 KB/s budget, and 273 KB/s
> in the worst case. [02 §6](02-netcode-protocol.md) predicted 90 KB/s before its levers; the
> real figure is three times that.
>
> And the composition is inverted from what 02 §6 assumed. It expected contacts and echo returns to
> dominate a frame. **They are 1–17% of it. Own-team boat state is 66–85%.** Every lever in §5 was
> ranked against the wrong picture and the order has been rewritten.

> **The ground rule, inherited from [16](16-acoustic-performance.md).** Instrument before
> optimizing. 16 spent its effort on a plausible structural change that deleted 4% of the vision
> squares while a third of the phase sat in a loop's branch order; ten minutes of counters found
> the real cost. The netcode has *less* instrumentation than acoustics had at the equivalent point:
> one `publish` phase covering everything from view assembly to `socket.send`, and **no byte
> counter anywhere on the server**. We are currently unable to answer either of the two questions
> this document exists to answer.
>
> **Server side is the constraint.** Client resource use is explicitly low priority here: a client
> serves one player on a machine that does nothing else, while the server serves every player on
> one thread. Where a lever helps one and hurts the other, the server wins.

## Progress log

Newest first. Add an entry when something here is built, measured, reverted, or rejected — with
the number that justified it, in the style of 16's log.

| Date | Change | Result |
|---|---|---|
| 2026-08-17 | **§3 built** — five benchmarks in `packages/tools/src/bench-netcode/` (§9). | Every question in §2 now has a number. |
| 2026-08-17 | **§4.2 built** — `channelFor`, `WireMeter`, `CountingCodec` in `@seg/shared/protocol/`. Per-message-type and per-channel byte accounting, with the channel map that becomes the `Link`'s lookup table (02 §9 step 1). | Bandwidth is attributable for the first time. |
| 2026-08-17 | **`WsTransport.calcBytesPerSec` fixed** — reading `stats` reset the accumulator, so two readers got two wrong answers. | Lifetime and windowed counters separated; reading is idempotent. |
| 2026-08-17 | **Test suite built** — `netcode-budget.test.ts` (exact byte baselines + a ratchet on the 02 §6 gap) and `netcode-harness.test.ts` (pins the phase mirror byte-for-byte against `MatchHandler.publish`). 31 tests. | A netcode change that moves a byte now fails loudly and says by how much. |
| 2026-08-17 | **Q-17.1 answered.** Publish is 2–13% of a tick everywhere on the matrix. | Netcode CPU is not the constraint. §6 drops to the bottom of the work order. |
| 2026-08-17 | **§5's lever order rewritten** against the measured frame composition. | Own-team boat state, not the sonar picture, is 66–85% of a frame. |
| 2026-08-17 | **§4.1 not built** — the `PerfPhase` split stays in the bench rather than in `server/match/perf.ts`. | `encode`/`send` are not visible to the handler; threading a probe through `PlayerConnection` is its own change. Q-17.9. |
| 2026-08-17 | Document created. | — |

---

## 1. What the netcode is today

### 1.1 The outbound path, traced

One publish, on every second sim tick (`ACOUSTIC_TICK_HZ` = 10 Hz), driven from
`server/match/clock.ts` → `MatchHandler.publish` (`server/src/match/handler.ts:271`):

| Step | Where | Cost scales with | Shared? |
|---|---|---|---|
| Acoustic solve, vision picture | `runtime.tick()` (16) | entities, map cells | **per team** |
| `store.viewFor(matchId, accountId)` | `server/match/store.ts:184` | boats + torpedoes + contacts | **per recipient** |
| ↳ `runtime.visionFor` — chart slice off the watermark | `runtime.ts:1587` | chart backlog | per recipient |
| ↳ `viewFor` — assemble `MatchViewState` | `shared/match/view.ts` | own boats, torpedoes, objectives | per recipient |
| `createMatchView(...)` → `connection.send` | `handler.ts:298` | — | per recipient |
| ↳ `JsonCodec.encode` — `JSON.stringify` + `TextEncoder` | `shared/protocol/schema.ts` | **frame size** | per recipient |
| ↳ `WsTransport.send` → `ws.send` | `realtime/ws-transport.ts:77` | frame size | per recipient |
| Debug fields / reach / stats | `handler.ts` | map cells | per request, gated |

Everything from `viewFor` down is paid once per connected player, inside the serial loop that
ticks every match on the process.

### 1.2 The inbound path

`server/realtime/gateway.ts` accepts at the upgrade (cookie auth, so no unauthenticated sockets
are held), then per message: `WsTransport.handleInbound` → size check → `codec.decode`
(`JSON.parse`) → `isLobbyMessage` / `isMatchMessage` dispatch → handler. Commands mutate runtime
state directly; there is no per-tick command queue drain to measure separately.

Inbound is small — a player issues on the order of one command per second (02 §7) — but it is
**unbounded per connection today**: the token bucket in 02 §7 is specified and not built, and the
only inbound limit that exists is `MAX_MESSAGE_BYTES` = 8192.

### 1.3 What is already built, and it is more than 02 assumes

Worth stating plainly, because it changes what the benchmarks should be looking for:

- **The vision picture is computed per team, not per player** (`runtime.pictures[team]`). The
  expensive part is already amortized across a side. This is C17 / risk R3's mitigation and it is
  in the tree.
- **The chart is watermarked per recipient** (`VisionFrame.charted` / `chartSeen`,
  `runtime.ts:1590`) — terrain squares are sent once and never re-sent, with a backlog that
  catches up over subsequent frames.
- **Chart cells are gap-delta encoded** (`shared/match/vision.ts:310`).
- **Signal excess is quantized** to half-decibel steps (`quantizeExcess`, `EXCESS_STEP`).
- **The static/volatile split exists** — `MatchSetup` travels once, `MatchViewState` every frame
  (`shared/match/view.ts`). 02 §6 counts on this and it is real.
- **A per-tick perf ring buffer exists** with a `publish` phase, and it costs nothing when off
  (`server/match/perf.ts`).

### 1.4 What is not built

- **No `Link`.** `ChannelId` is a type; nothing routes by it. `WsTransport.send` ignores its
  `channel` argument (`ws-transport.ts:77`) and `handleInbound` hard-codes `'control'` for every
  inbound message (`ws-transport.ts:117`). The routing table of [01 §4.1a](01-architecture.md) does
  not exist.
- **No view sequencing on the wire in the sense 02 §3.4 means it.** `store.viewFor` advances a
  per-account `seq`, but there is no `baseSeq`, no client ack, and no keyframe policy.
- **No delta encoding of the view frame.** Every frame carries the full `MatchViewState`. 02 §6
  claims a 6–10× reduction from deltas and this is the single largest unbuilt lever.
- **No position quantization.** Excess is quantized; positions, facings and speeds are not.
- ~~**No byte accounting.**~~ **Fixed 2026-08-17** (§4.2). `WsTransport` counted
  `totalOutboundBytes` for a stats getter nobody aggregated, and *reset the window as a side effect
  of reading it*, so two readers got two wrong answers and one of them silently. The lifetime and
  windowed counters are now separate and reading is idempotent; per-type and per-channel
  attribution lives in `CountingCodec` / `WireMeter`, where the message type is still known.
- ~~**Nothing routes by channel.**~~ Still true of the send path, but `channelFor`
  (`shared/protocol/channels.ts`) now exists as a pure total function and is exhaustively tested
  against the schema. It is what makes per-channel accounting possible today and it is the `Link`'s
  lookup table on the day a second transport lands (02 §9 step 1).
- **No `BinaryCodec`, no `RtcTransport`.**

### 1.5 The unit of budget is the process, not the match

[16 §1.1](16-acoustic-performance.md) makes this point for the solve and it applies with more force
to publishing: `server/match/clock.ts` walks **every running match on the process through one
`setInterval`, serially**, and `publish` runs inside that loop. So a match's publish cost is not
"its share of 50 ms" — it is 50 ms of the whole box, spent while every other match waits.

This framing decides §6. It is also why the headline metric of §3 is not milliseconds per publish
but **process-seconds consumed per wall-clock second**, which is the only number that answers "how
many matches fit".

---

## 2. What scales with what

Four dimensions, and it matters which of them each cost tracks. Caps are from the content and
lobby tables, not invented here.

| Symbol | Meaning | Range | Source |
|---|---|---|---|
| `E` | boats in the match | 2 – 160 | `FLEET_MAX_BOATS` = 10 × `MAX_PLAYERS_MAX` = 16 |
| `P` | connected players (+ spectators) | 2 – 16 | `MAX_PLAYERS_MIN/MAX`, default 6 |
| `C` | picture size — contacts, lit cells, chart backlog | design-capped | 02 §6 caps at 48 contacts |
| `M` | running matches on the process | unknown | **the number this document is trying to find** |

And the three costs, with what each is proportional to:

| Cost | Proportional to | Per publish tick | Covered by |
|---|---|---|---|
| Sim + acoustic solve | `E`, map cells, **teams (2)** | once per match | [16](16-acoustic-performance.md) |
| View assembly + encode + send | `P × (E_own + C)` | **once per player** | this document |
| Process total | `M ×` both | — | this document, §3.4 |

### 2.1 Q-17.1, answered: publishing is never the expensive half

**Measured**, `pnpm bench:netcode:scaling`, dense/medium, medium hulls at `full`, minimum of five
runs. `pub/tick` is publish ÷ the tick that preceded it, both per publishing tick.

| players | boats ea. | fleet | tick+solve | publish | **pub/tick** | µs/player-frame | bytes/frame |
|---|---|---|---|---|---|---|---|
| 2 | 1 | 2 | 3.75 ms | 0.25 ms | **0.07** | 124 | 1 906 |
| 16 | 1 | 16 | 7.35 ms | 0.95 ms | **0.13** | 59 | 3 334 |
| 2 | 4 | 8 | 4.68 ms | 0.20 ms | **0.04** | 100 | 3 458 |
| 16 | 4 | 64 | 91.1 ms | 2.64 ms | **0.03** | 165 | 10 447 |
| 2 | 10 | 20 | 8.09 ms | 0.27 ms | **0.03** | 137 | 7 174 |
| 8 | 10 | 80 | 113.4 ms | 1.91 ms | **0.02** | 238 | 14 731 |
| 16 | 10 | 160 | 273.8 ms | 7.26 ms | **0.03** | 454 | 25 106 |

**`pub/tick` never exceeds 0.13.** The two lines §2.1 wondered about do not cross anywhere inside
the supported range — the acoustic solve is one to two orders of magnitude more expensive than
telling everybody about it, at every fleet size the lobby permits. The worry that motivated this
document was misplaced, and saying so is more useful than the table.

Two consequences, and the second is the one that reorders the work:

1. **§6's parallelism drops to the bottom of the queue.** Threading the publish path would divide
   a number that is already 3% of the problem. (The tick figures above are alarming on their own
   account — 273 ms against a 50 ms budget at 160 boats — but that is [16](16-acoustic-performance.md)'s
   subject and is explicitly out of scope here.)
2. **Publish does scale as `P × frame`, roughly.** Players 2 → 16 at ten boats each is ×8 fleet and
   **×26.5 publish**, which is ×8 recipients times ×3.5 frame size. Linear in the product, not in
   either factor — so it stays cheap only while frames stay small, which §2.3 says they do not.

**Where the publish time goes** (`pnpm bench:netcode`, 3v3 × 4 boats, minimum of five runs):

| phase | ms per publish | share | µs per player-frame |
|---|---|---|---|
| `encode` | 0.506 | **71.4%** | 84.4 |
| `assemble` | 0.082 | 11.6% | 13.7 |
| `vision` | 0.062 | 8.8% | 10.4 |
| `send` | 0.006 | 0.8% | 1.0 |

`JSON.stringify` is **71% of publishing**, at a measured **240 MB/s encode / 171 MB/s decode**
(`pnpm bench:netcode:codec`). That is the pessimistic end of the 150 MB/s–1 GB/s range §2.1 guessed
at, and it is the whole argument for `BinaryCodec` restated as a measurement: a binary codec makes
three quarters of the netcode's CPU disappear *and* cuts the bytes.

### 2.2 Q-17.2: the shared picture is real, but it is not where the bytes are

A team's `VisionFrame` differs between two teammates **only in the chart slice** — `charted` and
`chartSeen` come off a per-recipient watermark; `cells`, `strength`, `contacts`, `launches` and
`pings` are the team's picture verbatim (`runtime.ts:1587`).

That is still true, and it now matters much less than §2.2 expected, because **the picture is a
small part of a frame** (§2.3). Sharing the encode across a team (§6.3 A) would save some of the
17% that `vision.cells` reaches in the worst case and none of the 66% that own-team boat state
occupies — every boat's own snapshot is per-recipient by construction. The lever is real and it is
second-order. Quantization and deltas over boat state come first.

An incidental finding worth recording, because it caught a test out: **a crowded team is a deaf
team.** Four medium hulls in one deployment band raise each other's noise floor enough that the
team confirms *no* terrain at all on a small dense map, where two hulls chart 314 squares. A bigger
fleet has a smaller picture per boat — which is part of why `vision` is such a small share of a
big-fleet frame, and a warning about choosing fixtures (`netcode-harness.test.ts`).

### 2.3 The finding that reorders everything: a frame is mostly own-team boats

**Measured**, `pnpm bench:netcode:bandwidth`, mean bytes per part of one recipient's frame.

| part of the frame | typical (3v3 × 4) | worst (8v8 × 10) | lever |
|---|---|---|---|
| `boats` — your team's positions | 2 860 (**56.0%**) | 17 547 (**66.5%**) | quantization, deltas |
| `own` — tubes, damage, orders | 1 485 (29.1%) | 3 712 (14.1%) | deltas |
| `vision.cells` — faint returns | 69 (1.3%) | 4 481 (17.0%) | echo decimation |
| `zones` + `teams` | 610 (11.9%) | 573 (2.2%) | fixed cost |
| `vision.contacts` | 2 (0.0%) | 2 (0.0%) | contact caps |
| everything else | ~80 | ~80 | — |

**02 §6 got this backwards.** Its worst-case table gave contacts 3 600 bytes and echo returns
2 400 — together 67% of the frame it imagined — and gave own boats 1 800. The measured frame is
the mirror image: **own-team boat state is 66–85%** and contacts are two bytes, because a contact
list only fills up when a team can hear, and a team with a big fleet mostly cannot (§2.2).

The bandwidth that follows, measured at p95 over real encoded bytes:

| scenario | boats | p95 frame | per player at 10 Hz | vs. 8 KB/s budget |
|---|---|---|---|---|
| `quiet` — 1v1 × 1 boat, open water | 2 | 1 549 B | **15.1 KB/s** | **1.9× over** |
| `typical` — 3v3 × 4 boats | 24 | 5 425 B | **53.0 KB/s** | **6.6× over** |
| `worst` — 8v8 × 10 boats + 4 spectators | 160 | 28 005 B | **273.5 KB/s** | **34× over** |

The floor is already twice the budget. Two boats on an empty map, nothing happening, cost 15 KB/s
per player — so this is not a worst-case problem that goes away in normal play, and it is not
something contact caps or echo decimation can fix. §5 is rewritten accordingly.

---

## 3. The benchmarks

**Five built, one deferred.** Each is a `packages/tools/src/bench-netcode/` script in the shape of
`bench-acoustics` — env-var scenario knobs, deterministic seed, warm-up, phase probe, prints a
table (10 §1 reserves `bench-*` for this; 13 §9 already names `bench-bandwidth` and `bench-tick`).
Commands and knobs are in §9.

| # | Bench | Script | Answers | Gate |
|---|---|---|---|---|
| 1 | `bench-publish` | `bench:netcode` | Where does a publish go — vision, assemble, encode, send? | relative, >10% regression |
| 2 | `bench-bandwidth` | `bench:netcode:bandwidth` | Bytes per player-second, by type, by channel, and inside a frame | **exact baselines**, §9.1 |
| 3 | `bench-codec` | `bench:netcode:codec` | Encode/decode throughput, per codec | relative |
| 4 | `bench-concurrency` | `bench:netcode:concurrency` | How many matches fit on one process before ticks slip | relative + reported ceiling |
| 5 | `bench-inbound` | `bench:netcode:inbound` | Command decode + dispatch cost; flood resistance | relative |
| — | *(added)* `bench-scaling` | `bench:netcode:scaling` | The players × boats matrix — Q-17.1 and Q-17.2 | reported |
| 6 | `bench-rtc` | *deferred* | What a server-side data channel costs per connection | **decision gate**, §7.4 |

`bench-scaling` was not in the original plan and turned out to be the one that answered the
document's central question: neither `bench-publish` nor `bench-bandwidth` sweeps two axes, and it
is the *derivative* across the matrix, not any single cell, that showed publishing is never the
expensive half.

### 3.1 `bench-publish` — where a publish goes

The primary server-side instrument. Drives a real `MatchRuntime` through ticks and calls the real
publish path against synthetic connections whose `send` counts bytes and discards them.

**Phases**, matching the `PerfPhase` split §4 adds so the bench and the live debug panel report the
same names:

- `vision` — `runtime.visionFor`, the chart slice
- `assemble` — `shared/match/view.ts#viewFor`, building `MatchViewState`
- `encode` — `JsonCodec.encode`
- `send` — the transport call (a counting stub in the bench; `ws.send` in production)

**Knobs:** `PLAYERS` (2–16), `BOATS` (per player, 1–10), `MAP`, `SIZE`, `SEED`, `CONTACTS`,
`SPECTATORS`, `TICKS`, `CODEC`. Reuse `bench-acoustics/scenario.ts` for map and fleet construction
rather than forking it — the two benches should describe the same world.

**Prints:** ms per publish and per player-frame, the phase split, bytes per frame, and — the
headline — **µs of process time per player-frame**, which is what §3.4 multiplies up.

**The sweep that matters** is `P` at fixed `E` and `E` at fixed `P`, printed as a small matrix.
That matrix is §2.1's answer.

### 3.2 `bench-bandwidth` — real encoded bytes

13 §9 already requires this. What it must do that a naive version would not:

1. **Count real encoded bytes** — `codec.encode(msg).byteLength`, not an estimate and not
   `JSON.stringify().length` (which is UTF-16 code units, not bytes).
2. **Attribute by message type and channel.** One number for a match is useless for deciding what
   to compress. The output is a table: `match.view`, `match.state`, `chat`, `pong`, debug frames —
   count, total bytes, bytes/s, share.
3. **Report a distribution, not a mean.** 02 §6's budget is a **p95**. Per-frame p50 / p95 / max,
   over a run long enough to include a deployment burst, a chart catch-up burst, and an
   engagement.
4. **Report both directions.** Downstream against the 8 KB/s budget; upstream against the abuse
   budget of 02 §7, which is a different question with a different limit.
5. **Include the frames nobody counts** — `match.state` on join and on reconnect is the largest
   single message in the game, and a reconnect storm is the burst case.

**The budget** (02 §6): ≤ 8 KB/s down per player at p95, worst realistic case. CI fails on the
absolute number. See §9 for why this bench, alone among the six, may assert an absolute.

**Scenarios**, each a named preset rather than a knob combination, so a number can be quoted with
its scenario: `quiet` (cruise, no contacts), `typical` (3v3, 4 boats each, a few contacts),
`worst` (8v8, 10 boats each, dense map, active pulses, full contact list, torpedoes in the water),
`burst` (mass reconnect + chart catch-up).

### 3.3 `bench-codec` — throughput, and ready for the second codec

Encode and decode a corpus of captured real messages, one codec at a time, reporting MB/s and
µs/message by type. Small, but it is the bench that makes the binary migration safe: when
`BinaryCodec` lands it runs unchanged against both, and 13 §7's differential tests get a
performance counterpart for free. Build it now, with one codec, for the same reason 02 §9 step 1
builds the `Link` with one transport.

### 3.4 `bench-concurrency` — how many matches fit

The bench that answers the question §1.5 poses. Stands up `M` `MatchRuntime`s on one process,
drives them through the real `startMatchClock` step function, and measures:

- **Tick slip** — wall-clock interval between steps against the nominal 50 ms. The failure mode is
  not a slow tick, it is a *late* tick, and the clock deliberately does not catch up.
- **Process utilization** — busy time / wall time. The ceiling is the number to report.
- **The knee** — sweep `M` upward until p99 slip exceeds one tick. That value, for each of §3.2's
  scenarios, is the deployment capacity figure and it belongs in the deploy README.

This subsumes 13 §9's `bench-tick` (a single worst-case match is the `M = 1` row) and should
replace it rather than sit beside it.

### 3.5 `bench-inbound` — the command path

Decode + dispatch cost per message type, and the flood case: what does a connection sending at the
8 KB × line rate cost the process *before* the token bucket rejects it? That figure is the actual
argument for where the bucket goes — in the transport before decode, or in the handler after it.
Currently there is no bucket at all, so the answer is "everything up to dispatch", per message,
unbounded.

### 3.6 `bench-rtc` — deferred until §7.1 picks a library

Cannot be written before there is an implementation to measure. Its contents are specified in §7.4
because they are the gate criteria for the whole WebRTC decision, not merely a benchmark.

---

## 4. The instrumentation

§4.2 and §4.3's bug fix are **built**; §4.1 is deliberately not, and §4.1.1 says why.

### 4.1 Split the `publish` phase — **not built, and lower priority than it looks**

`PerfPhase` (`shared/match/perf.ts:70`) has one `publish`. Splitting it into `vision`, `assemble`,
`encode`, `send` would let the live statistics panel say what the benchmark now says — exactly the
way `SolvePhase` broke the acoustic solve into five, and for the same stated reason.

Preserve the discipline that makes the existing tracker free when off: `start()` returns `0`
without reading a clock, `record()` returns on its first line. A per-player phase measurement means
`P` more `performance.now()` pairs per frame **while the panel is open**, which is acceptable, and
zero while it is not, which is required.

#### 4.1.1 Why the split lives in the bench instead

**`encode` and `send` are not visible to the handler.** `MatchHandler.publish` calls
`connection.send(message)`; the encode happens inside the closure `realtime/gateway.ts` builds
(`transport.send('control', codec.encode(message))`), which the handler has no reference to. Making
the split real in production means threading a probe through `PlayerConnection` — a change to the
interface every handler talks to, for a number that is currently 1.4% of a tick.

So the four-phase split lives in `bench-netcode/scenario.ts#publishByPhase`, which mirrors
`MatchStore.viewFor` and is **pinned byte-for-byte against the real `MatchHandler.publish`** by
`netcode-harness.test.ts`. That test is what makes the mirror trustworthy rather than plausible: if
it drifts, every phase number in §2.1 becomes a measurement of the bench, and nothing else would
notice. Revisit when §5's levers change the shape of a frame enough that the live panel needs it —
Q-17.9.

### 4.2 Count bytes in the codec, not in the transport — **built**

Byte accounting belongs where the message type is still known. The transport sees a `Uint8Array`
and cannot attribute it; by then the only available breakdown is "bytes". A counting wrapper —
`CountingCodec implements Codec`, installed only when accounting is on — gives per-type attribution
with no change to any call site, and it is the same object `bench-bandwidth` uses.

Fix `WsTransport.calcBytesPerSec` while in there: reading it resets the window
(`ws-transport.ts:150`), so two readers get wrong answers and one of them silently.

### 4.3 The dev overlay 02 §6 asks for

"A dev overlay showing bytes/s per channel" — the debug stats panel already exists and already has
a transport for its numbers (`protocol/debug.ts`, `createDebugStats`). Adding a bandwidth block to
it is the cheapest possible way to make bandwidth visible during ordinary play, which is where the
surprises are. Bandwidth regressions are invisible until they are catastrophic.

### 4.4 Do not let the instrument become the thing measured

Every counter added here is inside the hot loop. The rule from `server/match/perf.ts`'s header
stands: gated, allocation-free, and no clock read when off. A counter that costs 2% is worse than
no counter, because it will be left on.

---

## 5. Bandwidth: the levers, in order

**Rewritten 2026-08-17 against the measured frame composition (§2.3).** The order below is not the
one this section had, and 02 §6's is further off still: two of its four levers target parts of a
frame that turn out to be 0–17% of it. Ordered by *measured* bytes addressed per unit of risk.

| # | Lever | Targets | Measured share it can reach | State | Risk |
|---|---|---|---|---|---|
| 1 | **Quantization of boat state** | `boats`, `own` | **66–85%** | unbuilt (excess only) | low — schema-local, JSON benefits too |
| 2 | **Binary codec** | everything, and 71% of publish CPU | 100% | unbuilt, 02 §9 step 3 | medium, well-tested path |
| 3 | **Delta encoding + baseline ack** | `boats`, `own` | 66–85% | unbuilt | **high** — the only one that can desync a client |
| 4 | **`permessage-deflate`** (§6.6) | everything | 100% | one line, off by default | low, but costs server CPU |
| 5 | **Per-team encode sharing** (§6.3 A) | `vision.*` only | ≤17% | unbuilt | low, and now second-order |
| 6 | **Echo decimation** | `vision.cells` | 1–17% | unbuilt | medium — changes the picture |
| 7 | **Contact caps** | `vision.contacts` | **0.0%** | design-capped, unenforced | low; keep it as a *design* win, not a bandwidth one |

**Quantization first**, unchanged from before but now for a measured reason rather than a guessed
one: it is pure schema work, it needs no protocol state, and it points at the two-thirds of a frame
that actually exists. 02 §6 notes the map extents make it cheap — 14 bits of x and 13 of y at 0.5 m
over 8 000 × 3 000 m. Do it before deltas, because a delta over a quantized field is smaller *and*
stabler: an unquantized float jitters in its low bits every tick and defeats delta encoding
entirely.

**The binary codec has been promoted to second**, from sixth. §2.1 measured `encode` at **71% of
publish** and 240 MB/s, so it is no longer only a bandwidth lever — it is simultaneously the
largest CPU saving available in the netcode and a ~6× byte saving, over the existing WebSocket,
with no transport risk and a differential test suite already specified (13 §7).

**Contact caps have been demoted to a design decision.** `vision.contacts` measures **two bytes**
in every scenario, worst case included. An unbounded contact list is still unreadable and the cap
is still right (02 §6), but it must stop being counted as a bandwidth lever.

**Deltas stay behind a measurement**, because 02 §3.4's baseline-ack scheme is the one piece here
whose failure mode is a client rendering a world that does not exist. It also cannot be tested
honestly until there is a transport that drops packets — which is WebRTC, which is §7. Build the
scheme now, keep it verifiable under induced loss, and do not enable unreliable delivery until
13 §7's loss tests pass (02 §9 step 6).

### 5.1 The egress number, now measured rather than derived

This section previously derived a figure from the *budget*. Here is the same arithmetic on what is
actually on the wire, from `pnpm bench:netcode:bandwidth`:

| | at the 02 §6 budget | **measured, `typical`** | **measured, `worst`** |
|---|---|---|---|
| per player | 8 KB/s | 53 KB/s | 273 KB/s |
| one full match | 128 KB/s | 315 KB/s (6 players) | 3.3 MB/s (20 connections) |
| ten concurrent | 10.2 Mbit/s | 25.8 Mbit/s | 274 Mbit/s |
| sustained a month | 3.3 TB | 8.4 TB | 88.9 TB |

Single VM, Caddy in front (`deploy/`). The budget's 10 Mbit/s was never a problem for the link;
**274 Mbit/s is**, and 88.9 TB/month is past the included allowance on essentially every provider.
Neither figure will be sustained around the clock — but the worst case is no longer a number that
merely has to *fit*, it is a number that would cost real money if ten of those matches ever ran at
once. This is the first argument for the binary codec that is about the bill rather than about
latency, and in §7.3 it is the reason self-hosted TURN needs a budget of its own.

---

## 6. Parallelization

### 6.1 The seam already exists

[01 §1](01-architecture.md) puts the match host behind two narrow interfaces — `inbound:
PlayerCommand`, `outbound: PlayerView` — precisely so that moving it to a worker is a transport
swap. That claim has never been exercised. The first thing any threading work should do is
*verify* it, by counting what actually crosses the seam today: `MatchHandler.publish` reaches into
`store`, `runtime`, and `connections`, and the debug paths reach further still.

### 6.2 Publishing parallelizes better than the solve does

16 §5.1 could only offer half a solve to threads, because the heatmap accumulation sums floats into
shared cells and float addition is not associative — a different order is a different match
(04 §9). **The publish path has no equivalent constraint.** Once a tick has finished, the state is
frozen; each recipient's frame is a pure function of that state plus that recipient's watermark.
There is no accumulation, no shared mutable target, and no ordering requirement between recipients.

Two caveats, both real:

1. **The watermark is a mutation.** `runtime.visionFor` reads and writes `chartSeen` for the
   account (`runtime.ts:1590–1591`), and `store.viewFor` advances `viewSeq` — both documented as
   "not a pure read". Hoist both out of the parallel region: compute every recipient's slice
   boundaries serially and cheaply on the main thread, hand the workers pure inputs.
2. **The send must come back.** `ws.send` is not thread-safe and the socket lives on the main
   thread. Workers return `Uint8Array`s, which are **transferable** — the return leg is a pointer
   move, not a copy. The outbound leg is the expensive one: workers need the state, and structured
   cloning a `MatchState` per frame would cost more than the encode it saves.

### 6.3 Three structures, increasing disruption

**A. Share the encode across a team — not parallel at all, and do it first.**
If §2.2 holds, the team-shared portion of a frame can be assembled and encoded **once per team per
frame**, with a per-recipient prefix/suffix carrying the chart slice and own-boat state. Saves up
to `P/2 - 1` assembles and encodes per team with no threads, no determinism question, and no new
failure mode. In the JSON era this means composing a frame from pre-encoded fragments, which is
ugly; with a binary codec it is natural, which is a reason to sequence the codec ahead of this.
**Measure §2.2 before building either.**

**B. Shard matches across worker threads** — [01 §1](01-architecture.md)'s scaling step 1.
A worker owns a set of matches, ticks them, and posts finished frames back to the gateway thread.
This is the structure that matches the deployment: `M` independent matches on an `N`-core box is
embarrassingly parallel at the *match* granularity, and it needs none of §6.2's care because
nothing is shared. 16 §5.3 reaches the same conclusion from the solve side. **This is the default
answer** and everything else should have to argue against it.

**C. A publish fan-out pool** — workers encode frames for one match's recipients in parallel.
Only worth it in the "few large matches, latency-bound" regime, and only if §6.2's outbound leg can
be made cheap — which realistically means the match state lives in a `SharedArrayBuffer` the
workers read, which is a much larger change than it sounds. Do not build this without a
measurement that says B is insufficient.

### 6.4 What must be settled by measurement, before any of it

> **Measured 2026-08-17, and it demotes this whole section.** Q-17.1 says publishing is **2–13% of
> a tick** everywhere on the matrix (§2.1). Structures A and C divide a number that is already
> almost nothing, so **none of §6.3 A or C is worth building against the numbers as they stand.**
> Structure B — sharding *matches* across workers — is untouched by this: it parallelizes the
> acoustic solve too, which is where 87–98% of a tick goes, and it remains the right answer for a
> box hosting many matches. That makes B a [16](16-acoustic-performance.md) decision rather than a
> netcode one, and this section's contribution to it is §6.5's list of what it must not break.

Same question 16 §5.3 poses, and the same answer applies: **which regime is the deployment in?**

- **Many concurrent matches** (a public server browser, lots of small lobbies) → **B**, and A as a
  free multiplier. C is worthless: the cores are already busy, and splitting one match's publish
  steals from the next match rather than finding capacity.
- **Few large matches** (16-player lobbies, latency-bound) → A, then C.

`bench-concurrency` (§3.4) is what tells us which, and it can be run before a line of threading
code is written. **Do not start on threads until it has been.**

### 6.5 What parallelism must not break

- **Determinism.** 04 §9 and the replay system depend on tick-order reproducibility. Structure B
  preserves it trivially (matches never interact). A and C must not reorder any float accumulation
  — neither does today, but neither has a test saying so.
- **The single-writer rule on watermarks.** Two frames for one recipient in one tick is already
  documented as a bug (`store.ts:180`); threading makes it a race rather than a mistake.
- **The tick clock's deliberate refusal to catch up** (`clock.ts` header). A worker pool must not
  quietly reintroduce catch-up by queueing frames without bound.

### 6.6 Node-specific traps to check for in the bench

- **GC pressure.** Every frame allocates a fresh `MatchViewState` and every array in it. At
  `P × 10 Hz × M` this may well be the largest single netcode cost and it would show up as *tick
  slip variance*, not as time in any phase. `bench-concurrency` must report a slip **distribution**
  and not a mean, or it will miss exactly this.
- **`ws.send` back-pressure.** `bufferedAmount` is already exposed via `TransportStats.queuedBytes`
  and nothing reads it. A slow client silently grows a server-side buffer; that is a memory leak
  with a player attached to it.
- **`permessage-deflate`.** The `ws` default is off, and it should stay off until measured — it can
  cost more CPU per connection than the JSON it compresses, which is the wrong trade on a
  server-bound budget. But it is a one-line experiment that might make the JSON era comfortable,
  and `bench-bandwidth` + `bench-publish` together can settle it in an afternoon. **Cheapest
  possible bandwidth win; measure it early.**

---

## 7. WebRTC: the part 02 does not cost out

[02 §9](02-netcode-protocol.md) sequences the transition and [ADR 0001](../docs/adr/0001-simultaneous-transports.md)
settles that both transports live at once. Neither says what a server-side data channel **costs**,
and on a single-VM deployment that is the deciding question. This section is that gap.

### 7.1 The server needs a real ICE / DTLS / SCTP stack

A browser gets WebRTC for free. Node does not. The options, all of which need verification against
current releases before anything is committed:

| Option | Shape | Trade-off to verify |
|---|---|---|
| `node-datachannel` | Native binding to libdatachannel | Small, data-channel-focused (no media stack to carry). Native threads it manages itself — see §7.2. Prebuilt binaries per platform, which matters for the Docker image. |
| `werift` | Pure TypeScript | No native build, trivially portable, debuggable. Almost certainly the slowest per packet — DTLS and SCTP in JS on the event loop, competing with the tick. |
| `@roamhq/wrtc` (or successors) | Native binding to libwebrtc | Full browser stack including media we do not want. Heaviest, and historically the one with maintenance risk. |

**Bias, stated up front and to be overturned by measurement:** `node-datachannel`, because the
workload is data channels only and a media stack is pure liability. The pure-TS option is the
interesting dark horse *only if* §7.2's per-packet cost turns out to be negligible, and the whole
point of §7.4 is that we do not currently know that it is.

### 7.2 The new costs, and none of them are on the wire

This is what makes WebRTC different from every other optimization in this document: **it trades
bandwidth for CPU.** Every item below is server CPU or memory that the WebSocket path does not pay.

- **DTLS record encryption, per packet, per connection.** The WebSocket path is TLS-terminated at
  Caddy and the Node process handles plaintext. With WebRTC the *game process* encrypts every view
  frame for every player. At `P × M × 10 Hz` that is a new per-frame cost inside — or beside — the
  tick loop.
- **SCTP association bookkeeping** per connection: streams, sequencing, retransmit timers,
  congestion control. Non-trivial even when configured `maxRetransmits: 0`.
- **ICE agents and STUN keepalives** per connection, continuously, whether or not the player is
  doing anything.
- **Per-peer memory.** Multiply by `P × M` and this becomes a deployment ceiling of its own.
- **Native threads the event loop does not control.** A native library that runs its own thread
  pool changes §6's core arithmetic: threads spent on DTLS are threads not available to structure
  B's match shards. This interaction is the one most likely to be discovered late, and it is the
  reason §6.4's measurement should happen *before* the WebRTC work rather than after.
- **Connection establishment cost**, which is bursty and lands exactly at match start when the
  process is already doing map generation and deployment.

### 7.3 TURN is a server bandwidth item

If a peer cannot be reached directly, traffic relays through a TURN server. Two consequences that
belong in a performance document rather than a networking one:

1. **Self-hosted TURN on the same VM relays game traffic through our own link, in both
   directions** — a relayed player costs roughly *twice* their §5.1 egress figure, once inbound to
   the relay and once outbound. A meaningful relayed fraction turns §5.1's 3.3 TB/month into
   something materially larger.
2. **Hosted TURN moves that to a bill** with per-GB pricing.

What fraction of players need a relay is a real-world number we do not have and should not guess;
industry figures vary widely with the player population's network mix. **The design consequence is
independent of the number:** because `control` is pinned to the WebSocket permanently (02 §3.1),
a player who cannot establish a data channel keeps a fully working game. That means **shipping
without TURN at all is a legitimate first position** — the failure mode is "some players stay on
the WebSocket", which is exactly today's product. Add TURN only if measurement shows the
non-relayed success rate is low enough to matter, and budget it explicitly when we do.

### 7.4 The gate: what must be true before we commit

`bench-rtc` (§3.6), run against a candidate library with `N` synthetic peers on one process:

| Measurement | Why it gates | Threshold |
|---|---|---|
| CPU per connection at idle | ICE/STUN keepalive floor × `P × M` | must be a small fraction of a core at 160 connections |
| µs per 1 KB data-channel send | The per-frame cost §7.2 introduces | must not exceed the `encode` phase it sits beside |
| Memory per peer connection | Deployment ceiling | reported; sets the `M` ceiling alongside §3.4 |
| Tick slip with `N` peers live | **The one that decides it** | p99 slip must not degrade vs. the WebSocket baseline |
| Native thread count and affinity | Interaction with §6 | reported; changes structure B's arithmetic |
| Establishment time and burst cost | Lands at match start | reported |

**The decision this gate can return is "no".** If a server-side data channel costs more CPU than
the bandwidth it saves is worth, the correct outcome is: ship `BinaryCodec` over the WebSocket
(02 §9 step 3, which is independent of all of this and captures most of the bandwidth win), keep
`RtcTransport` unbuilt, and revisit. 02 §9 is deliberately structured so that step 3 stands alone —
this document's job is to make sure that option stays open rather than being sequenced away.

### 7.5 Sequencing, with a measurement gate on each step

Mirrors 02 §9, adding what must be measured before each step is allowed to proceed. Every step is
independently revertable, which is the whole design.

| Step | Work | Gate before starting | Gate before keeping |
|---|---|---|---|
| 0 | §3 benchmarks + §4 instrumentation — **done 2026-08-17** | — | ✅ Numbers exist for `quiet`/`typical`/`worst`, and `netcode-budget.test.ts` holds them |
| 1 | `Link` with one transport registered; real channel tagging in `WsTransport` (`channelFor` is built and is its lookup table) | 0 | `bench:netcode` unchanged within noise; byte baselines unmoved |
| 2 | Quantization (§5 lever 1) | 0 | `bench:netcode:bandwidth` down ~2×; no picture diff |
| 3 | `BinaryCodec` + negotiation; ship over WebSocket | 0, 1 | `bench:netcode:codec` faster and bandwidth ~6× down; 13 §7 differential tests pass |
| 4 | Baseline-ack delta encoding | 3 | Bandwidth down 6–10×; desync tests pass on a *lossless* transport |
| 5 | `RtcTransport`, registered alongside; `bench-rtc` | §7.4 gate | §7.4 thresholds met; `bench-concurrency` `M` ceiling not reduced |
| 6 | Move `commands` to WebRTC (low volume, reliable both sides) | 5 | Handover correct under forced transport failure |
| 7 | Move `view` to WebRTC, still reliable-ordered | 6 | `bench-concurrency` holds; latency improves or is neutral |
| 8 | Enable unreliable delivery on `view` | 4, 7 | 13 §7 induced-loss tests pass; no desync over a long run |

Note steps 2–4 deliver most of the bandwidth win and **none of them need WebRTC**. That ordering is
deliberate: it front-loads the cheap, low-risk, revertable wins, and it means that if §7.4 returns
"no", we have already banked the bandwidth.

---

## 8. Order of work

**Steps 1–4 are done** (2026-08-17). Rewritten below with what the numbers changed.

1. ~~**Instrument** (§4)~~ — counting codec, channel map, bytes-per-sec bug. §4.1's `PerfPhase`
   split was deliberately skipped; §4.1.1 says why.
2. ~~**`bench-publish` + `bench-bandwidth`**~~ — built, plus `bench-codec`, `bench-concurrency`,
   `bench-inbound` and the `P × E` matrix. Six scripts, §9.
3. ~~**Answer §2.1 and §2.2**~~ — answered, and both answers moved work: publishing is 2–13% of a
   tick, and the frame is own-team boat state rather than the sonar picture.
4. ~~**`bench-concurrency`**~~ — built. The `M` ceiling on the target box is still Q-17.4; the dev
   box is not the deployment box and its number should not be quoted.

What is left, re-ordered against §5's rewritten table:

5. **Quantization of boat state** (§5 lever 1). The two-thirds of a frame that actually exists.
6. **`permessage-deflate` on/off** (§6.6). One line, and the fastest possible read on how much of
   the gap is compressible at all. Run it before committing to the codec work, not after.
7. **`BinaryCodec`** (§5 lever 2, 02 §9 step 3). Now the *second* priority rather than the sixth:
   it is simultaneously 71% of publish CPU and ~6× of the bytes, over the existing transport.
8. **Deltas + baseline ack** (§5 lever 3), verified without loss first.
9. **WebRTC**, from §7.5 step 5, behind the §7.4 gate.
10. **Threading** (§6), last and probably never — see §6.4's note.

**Re-run `pnpm bench:netcode:bandwidth` and update `netcode-budget.test.ts` after every one of
5–8.** The test suite is the instrument for exactly this: a change that does not move a byte
baseline did nothing, and one that moves it says by how much.

---

## 9. Methodology, and one thing that differs from 16

Benchmarks live in `packages/tools/src/bench-netcode/`, deterministic by fixed seed and
index-placed boats. They drive **real production code** — a real `MatchStore`, `MatchRuntime`,
`MatchHandler` and `JsonCodec`; the only fake is the socket, and it encodes exactly as
`realtime/gateway.ts` does before dropping the buffer.

```
pnpm --filter @seg/tools bench:netcode              # §2.1: where a publish goes, four phases
pnpm --filter @seg/tools bench:netcode:bandwidth    # §2.3: bytes by type, by channel, inside a frame
pnpm --filter @seg/tools bench:netcode:scaling      # §2.1: the players × boats matrix (Q-17.1)
pnpm --filter @seg/tools bench:netcode:codec        # encode/decode throughput, ready for BinaryCodec
pnpm --filter @seg/tools bench:netcode:concurrency  # §3.4: matches per process, tick slip (Q-17.3/4)
pnpm --filter @seg/tools bench:netcode:inbound      # §3.5: the command path and the flood case
```

**Scenario presets**, so a number can be quoted with its scenario attached:
`SCENARIO=quiet|typical|worst|burst`. Individual knobs override the preset — `PLAYERS`, `BOATS`,
`SPECTATORS`, `HULL`, `THROTTLE`, `MAP`, `SIZE`, `MODE`, `SEED`, `TICKS`, `WARMUP`, `RUNS`, plus
`MATCHES_AXIS`/`SECONDS` for concurrency and `PLAYERS_AXIS`/`BOATS_AXIS` for scaling.

**`WARMUP` is not optional reading.** The first frame after deployment carries the whole chart and
is more than twice the steady-state size; a bench measuring from tick zero reports the reconnect
burst as the normal case. `SCENARIO=burst` is how to measure that case deliberately, via
`MatchRuntime.forget` — the same call a real reconnect makes (Q21).

**`THROTTLE` decides the picture, not the speed.** `full` is the fastest notch below the cavitation
line by construction; `flank` is over it and is what makes a worst case worst. A quiet fleet lights
almost nothing and measures an empty frame.

### 9.1 The test suite

Two files, and they are the instrument for measuring a change rather than a check that it compiles:

- **`packages/tools/test/netcode-budget.test.ts`** — exact byte baselines for four scenarios, plus
  a **ratchet**: bytes per player-second may fall and may not rise. A failure is the measurement,
  delivered: it prints what moved and by how much, and the baseline is updated in the same commit.
  It deliberately does **not** assert 02 §6's 8 KB/s budget, because the budget is not met (§2.3)
  and a test that fails on every run teaches people to ignore the suite.
- **`packages/tools/test/netcode-harness.test.ts`** — pins the bench's four-phase mirror
  **byte-for-byte against `MatchHandler.publish`** (§4.1.1), plus determinism, the warm-up's effect,
  and that the fake socket really is the gateway's send path.

Byte assertions are against a **fixed match id**: `matchId` travels in every `match.view`, so a
longer id is a bigger frame, one byte per character per frame. That is the smallest possible
illustration that a byte baseline is a baseline *of a scenario*, and there is a test for it.

**Everything in [16 §6](16-acoustic-performance.md) about timing applies here unchanged**, and it
is not optional reading: take **minimums over five or more runs**, never compare a timing across
sessions, and quote every claim that matters as a **ratio between variants measured in one
process**. The dev box is unpinned WSL2 with run-to-run variance around ±20% and two distinct
performance regimes it drifts between.

**The one thing that differs, and it is a gift: bytes are exact.** 16's cross-session honest check
was cell counts; ours is byte counts. `codec.encode(msg).byteLength` for a fixed scenario and seed
is deterministic, machine-independent, and comparable to a number taken six months ago on different
hardware. Which means:

- **`bench-bandwidth` may assert an absolute budget in CI** (13 §9 already asks it to), and a
  regression in it is a fact rather than a symptom of the runner being busy.
- **Every other bench asserts relative regression only** (>10%, per 13 §9), because its numbers are
  timings.
- **A change that moves a byte count has changed the protocol**, whether or not it meant to. That
  makes byte counts the right thing to snapshot-test, and the right thing to print in every bench
  including the timing ones.

Two further rules taken directly from 16's scar tissue:

1. **Instrument the loop body before restructuring it.** A third of 16's reflection pass was in
   branch ordering and no timing harness could have pointed at it. The publish loop's equivalent is
   allocation: count allocations before assuming the cost is encoding.
2. **Diff the picture.** Any change to view assembly or encoding must be checked by building the
   same frame twice, with the change on and off, and comparing the decoded result as data. 16 §3.4
   passed every timing harness while deleting 4% of the vision squares. The netcode equivalent —
   a delta encoder that drops a field — would be *harder* to see, because it shows up as a client
   drawing a stale world rather than as a missing square.

---

## 10. Open questions

| # | Question | Decides | Status |
|---|---|---|---|
| Q-17.1 | Is publish or the acoustic solve the larger per-tick cost at 16 players? (§2.1) | Whether netcode CPU optimization is urgent at all | **Answered 2026-08-17: the solve, by 8–50×. `pub/tick` never exceeds 0.13.** §6 demoted. |
| Q-17.2 | Does the team-shared portion dominate a frame's bytes and encode time? (§2.2) | Whether §6.3 A is the big win | **Answered: no.** The picture is 1–17% of a frame; own-team boat state is 66–85%. §6.3 A is second-order. |
| Q-17.3 | Which concurrency regime is the deployment in — many small matches or few large? (§6.4) | Structure B vs. C; also settles 16 §5.3 | Instrument built (`bench:netcode:concurrency`). Needs real lobbies to answer. |
| Q-17.4 | What is the `M` ceiling on the target VM? (§3.4) | Deploy sizing; goes in `deploy/README.md` | Instrument built. **Run it on the deployment box** — the dev box's number is not it. |
| Q-17.5 | Does `permessage-deflate` pay for itself on a server-bound budget? (§6.6) | Possibly closes much of the §2.3 gap for one line | Open; now step 6 of §8 and cheap. |
| Q-17.6 | Which Node WebRTC library, and does it clear §7.4? | Whether steps 5–8 happen at all | Open; unchanged. |
| Q-17.7 | Do we ship TURN? At what relayed fraction does it become necessary? (§7.3) | Hosting budget; not a blocker for step 5 | Open. §5.1's measured egress makes it more expensive than it looked. |
| Q-17.8 | Does the 01 §1 match-host seam actually hold, or has `publish` grown through it? (§6.1) | Cost of structure B | Open, and much less urgent after Q-17.1. |
| Q-17.9 | Should the `publish` phase split be threaded into `PlayerConnection` so the live panel sees it? (§4.1.1) | Whether the dev overlay can show what the bench shows | Open. Deferred: the number is 1.4% of a tick and the change touches every handler. |
| Q-17.10 | Why is `quiet` — two boats, empty map, nothing happening — already 1.9× over budget? (§2.3) | Whether there is a fixed per-frame cost nobody has looked at | **Open, and the most interesting one.** `zones` + `teams` alone is ~600 B of a 1 549 B frame. Start there. |
