# 13 — Testing Strategy

Testing is planned as a first-class part of the project rather than a phase at the end. This
document is the authority on what gets tested and how; [10-repo-structure-tooling.md](10-repo-structure-tooling.md)
covers the tooling that runs it.

## 1. Why this game is unusually testable — and unusually in need of it

Two properties make automated testing pay off here far more than in a typical game:

**The simulation is pure and deterministic.** Given `(seed, initial state, ordered command
stream)` the outcome is fixed (01 §6, 04 §9). That means a test can assert on an entire
20-minute match, not just on a function. Very few games can do this; the discipline required to
keep it true is the price, and it is worth paying.

**The failure modes are silent.** A bug in transmission loss does not crash — it quietly makes
one hull class undetectable, and nobody notices for three weeks. A bug in the tracker does not
throw — it merges two contacts that should have split, and the game gets slightly worse in a way
no one can articulate. **These are exactly the bugs automated tests catch and manual playtesting
does not.** The acoustic model is both the core mechanic and the least observable subsystem,
which is the strongest possible argument for investing in tests around it.

Non-goal: chasing a coverage number. Coverage on React components produces tests nobody trusts.
The targets in §8 are deliberately uneven.

## 2. The test pyramid, as it applies here

```
                  ╱ E2E ╲                     few, slow, high confidence
                ╱ integration ╲               synthetic clients, full server
              ╱   scenario tests   ╲          ★ the load-bearing layer
            ╱      unit tests        ╲        fast, many
          ╱  property & invariant      ╲      codec, math, modifiers
```

The unusual shape: **scenario tests are the widest valuable layer**, not unit tests. A scenario
test runs the real simulation for hundreds of ticks and asserts on emergent behaviour. They are
the only thing that catches "a change to `f_speed` made the Scout undetectable," and they double
as executable documentation of design intent.

## 3. Unit tests

Fast, isolated, run on every save. Vitest. *Rows below without a "not built" tag exist today in
`@seg/shared/test`; the rest are the plan for when their layer lands.*

| Area | What is asserted |
|---|---|
| `math/` | Vector ops, angle wrapping and shortest-arc, pitch-band clamping, interpolation, seeded PRNG reproducibility |
| `content/` | Modifier resolution order (`set` → `add` → `mul` → clamp), stacking, stat derivation for every hull × module combination that is legal |
| `fleet/` | Cost calculation, budget validation, slot-count validation, tube assignment, content-drift repair (07 §3) |
| `sim/movement` | Acceleration and deceleration clamps, turn-rate curve, **pitch-band enforcement**, `descentRate = speed·sin(pitch)`, ballast at low speed, no-reverse invariant *(not built — no `sim/movement` yet)* |
| `sim/terrain` | Contour polygons are closed and simplified; obstacle-free-space classification; clearance measurement across passages *(built as `map/measure.ts`, see §4.1)* |
| `sim/navigation` | Per-hull navmesh filtering, A\* correctness, string-pulling, pitch-band route validation, **"no route" returned rather than a bad route** *(not built — no navmesh yet)* |
| `map/` | See §4.1 — the generator gets its own suite |
| `sim/acoustics` | Levels (`acoustics-levels`): power-domain addition; `TL` zero at the reference range, monotonic, inverts, compresses the loud end; cavitation is a cliff at the threshold and is deeper for the same speed; damaged/test-depth and transient penalties; flow-noise square-of-speed; self-noise; array gain lowers the bar; absorption derived from target strength (anechoic swallows more). Propagation (`acoustics-propagation`): straight line in open water within the lattice's own error (octagon error ≤6%); routes around walls and through doors, never through rock or sealed chambers; stops at `maxRange` and `maxFieldCells`; the skin traces every obstacle face at one metre, includes the seabed and surface, and reports each square once. Vision (`acoustics-vision`): hulls draw as squares of surface, never a boat's own hull, fading with range; terrain breaks contact; rock lights up around a loud boat and a quiet boat sees nothing; per-team pooling; budget drops the dimmest squares; a wreck stays a reflector |
| `sim/tracker` | Association within gate, split on quality loss, merge on convergence, staleness expiry, designation stability *(not built — 03 §7)* |
| `sim/weapons` | Enable-point logic, seeker acquisition gate, fuze distance, expiry, **torpedo pitch limits** *(not built)* |
| `protocol/` | See §7 |
| `view/` | Delta encoding correctness, baseline-ack behaviour, keyframe on missing ack *(not built)* |

**The vertical-slice invariants deserve dedicated unit tests** because they are new and easy to
break: a boat must never exceed its pitch band, must never have a `depthRate` independent of
`speed·sin(pitch)`, must never pass through the surface or the seabed, and `pos.y` must never go
negative.

## 4. Content validation tests

Run as tests *and* as a CLI (`pnpm content:validate`) so bad data fails the build, not the match.

- Every module references a valid slot type; every hull's module count ≤ its slot count.
- All costs positive; no hull is strictly dominated by another at equal cost (a soft warning, not
  a failure — but a designer should have to acknowledge it).
- `crushDepth > testDepth` for every hull, and every hull's crush depth is reachable on at least
  one launch map (a hull that can never be crushed has a dead stat).
- Silhouette polygons are closed, non-self-intersecting, correctly wound, and within plausible
  length bounds for the declared hull length.
- Content hash is stable across a rebuild with no source change.
- Every hull's `clearanceRadius` admits at least one passage width class, and the largest hull's
  clearance is compatible with invariant I2 (14 §3) — a hull the generator cannot accommodate is
  a content bug, not a map bug.

## 4.1 Map generator tests

**The most valuable test suite in the project after the ground-truth test**, because a generator
bug is not a visual glitch — it is a broken match, discovered by players, unfixable in flight.
The generator is pure and headless, so these are also among the cheapest tests to run.

**Property tests over ≥500 seeds**, asserting every invariant in 14 §3. *(Status: the floor
guarantees are built and measured by `map/measure.ts`; rows needing the absent navmesh or
placement steps are pending.)*

| Invariant | How it is checked |
|---|---|
| I1 — three paths at every `x` | Sample `x` at 5 m intervals; connected-component analysis of free-space intervals; count components belonging to left-to-right-connected regions. Must be ≥ 3 everywhere. *(built form: the generator guarantees `routeCount` levels and the suites assert one trunk plus a full-height range of levels)* |
| I2 — one large-hull route at every `x` | Filter the navmesh to the largest hull's clearance; assert left-to-right connectivity survives *(built form: `trunkPassageWidth` — `hasRouteAtLeast` measures a level crossing the whole map at ≥ 400 m, which admits the largest hull)* |
| I3 — equivalent deployment connectivity | Each zone touches ≥3 routes; route-length distributions to each objective within tolerance of the mirror *(pending — placement not built)* |
| I4 — no unreachable pockets | Flood-fill from both deployment zones; any free space not reached is filled or explicitly marked dead |
| I5 — detail never breaks clearance | After the detail pass, re-measure clearance along every skeleton segment against its declared width class *(not applicable as written — detail is widening-only, never rock put back, so no floor can be broken by it)* |
| I6 — objectives valid and contestable | Clearance for a mid-size hull, reachable by ≥2 distinct routes, not inside a maximally tight choke *(pending — placement not built)* |

Plus:
- **Determinism**: same `(seed, generatorVersion, params)` → byte-identical output, both twice in
  one process and across processes.
- **Floor coverage**: over many seeds every Sparse and Dense map clears
  `hasOpeningAtLeast(minPassageWidth)` and `hasRouteAtLeast(trunkPassageWidth)` — the built
  safety net in `measure.ts` throws with the seed rather than retrying. Catches a generator that
  has quietly started pinching passages below the floor.
- **Scale sweep**: invariants hold at every supported map extent (14 §1.2), not just the base
  size. Small maps are the likely failure case — there is less room to fit three levels.
- **Performance** (§9): generation inside the match-start budget. The sector decomposition and
  all-pairs propagation precompute are not built (14 §5), so there is nothing of theirs to time.

**The seed gallery is part of the protocol, not a nice-to-have.** Property tests prove
correctness; only human review of `pnpm map:gallery` output catches "correct and boring." Required
on every generator change.

## 5. Scenario tests — the load-bearing layer

A scenario is a small declarative fixture: a map, a set of boats with loadouts and initial
states, and a command script. The test runs the real simulation headlessly for N ticks and
asserts on outcomes.

```ts
scenario('a creeping Special Ops is not detected by a cruising Attack at 800m', {
  map: 'empty',
  entities: [
    { team: 0, hull: 'special-ops', pos: [0, 500],    facing: 0,   speed: 2.0 },
    { team: 1, hull: 'attack',      pos: [800, 500],  facing: 180, speed: 8.0 },
  ],
  ticks: 600,
  expect: (r) => {
    expect(r.detections(team1, of: team0)).toBe(0);
    expect(r.detections(team0, of: team1)).toBeGreaterThan(0);  // the loud one is heard
  },
});
```

### The scenario corpus to build at M1
Each of these encodes a design intent from 03–05, and a failure in any of them is a real bug:

| Scenario | Intent |
|---|---|---|
| Creep versus cruise at range | Speed is the dominant stealth lever |
| Cavitation onset | Crossing the threshold produces a large, immediate detection-range jump |
| Cavitation versus depth | The same speed is safe deep and fatal shallow |
| Across the layer | Layer crossing at least halves effective detection range in every hull pairing *(pending — layers not built)* |
| Hugging the layer | A boat just below the layer is undetected by one just above at close range *(pending — layers not built)* |
| Terrain shadow | Rock between two boats blocks detection; clearing it restores contact |
| Geodesic path | A boat around a corner is seen only via the geodesic around the rock, at a weaker level than the straight line (03 §5.2) |
| Diffraction penalty | A boat one bend away is materially harder to detect than one in line of sight at the same path length — proves the lattice does something |
| Waveguide | A boat in a Slot passage is undetectable off-axis and clearly detectable from either end of the passage *(pending — waveguide layer not built)* |
| Open column exposure | A cavitating Heavy in an Open Column is detected across the whole region |
| Clearance routing | A Heavy is refused a route through a Warren; a Scout is granted one on the same map *(pending — navmesh not built)* |
| Torpedo terrain collision | A torpedo fired at a target behind rock strikes the rock |
| Baffle approach | A trailing boat in the baffles is undetected while a beam-on boat at the same range is detected |
| Towed array | The module closes the baffle hole, and degrades above creep as specified |
| Active ping return | A ping produces echo points on the near-side silhouette only, arriving at `2r/c` |
| Aspect and target strength | Bow-on returns are materially weaker than beam-on |
| Pitch and target strength | A steeply diving boat returns less to a horizontally distant pinger |
| Torpedo evasion by depth | A boat that dives hard defeats a super-cavitating torpedo (pitch limit) but not a Standard |
| Decoy seduction | A seeker prefers a decoy under specified conditions |
| Friendly fire | A seeker will acquire a friendly — the behaviour is intended, so it is asserted |
| Crush depth | Descending past crush depth destroys the boat; a Titanium hull survives where a base hull does not |
| Track split and merge | Two boats in formation present as one track and separate correctly |
| Objective capture rate | Diminishing returns curve behaves as specified |

Each scenario is a **golden file**: the assertion is on named outcomes, and a rich trace is
snapshotted alongside. When a change shifts the trace, the diff is reviewed by a human who
decides whether the change was intended. That review step is the point — these tests are not
there to be green, they are there to make change visible.

## 6. Determinism and replay tests

- A recorded replay corpus lives in `@seg/tools/fixtures` — a handful of full matches captured
  from real play, plus synthetic ones from the bot harness.
- `pnpm replay:corpus` replays each headlessly and compares `resultHash` (04 §9). Runs in CI.
- A dedicated test replays the same input **twice in one process** and asserts identical output,
  catching state leaking between runs.
- A lint rule bans `Math.random()` and `Date.now()` under `packages/shared/src/sim/**` (10 §3).
  The rule is the primary defence; the test is the backstop.

## 7. Protocol tests

- **Round-trip property tests**: for every message type, generate arbitrary valid instances and
  assert `decode(encode(m))` deep-equals `m`. Uses `fast-check`.
- **Differential tests**: `JsonCodec` and `BinaryCodec` must produce equivalent decoded results
  from equivalent inputs. Written at M2 against `JsonCodec` alone (asserting it against a
  reference), then activated for real when `BinaryCodec` lands — this is what makes that
  migration safe (02 §9).
- **Quantization tests**: a quantized round trip stays within its declared tolerance, and
  quantization is idempotent.
- **Schema stability test**: message type ids are never reused after removal, and field order is
  declared for every message. A snapshot of the schema is committed; changing it requires
  updating the snapshot, which surfaces protocol changes in review.
- **Fuzzing**: malformed and truncated frames fed to the decoder must throw cleanly, never hang,
  never allocate unboundedly, and never produce a partially-valid object.

### 7.1 Transport routing tests

Written at M2 against the single-transport Link, and the reason adding WebRTC later is a
policy change rather than an adventure. All of these run with a scripted fake transport pair;
none needs a real data channel.

- **Channel policy**: `control` resolves to `ws` under every combination of registered and
  healthy transports, including "rtc is up and faster". A test that asserts `control` *cannot*
  be routed elsewhere is the executable form of the decision in 02 §3.1.
- **Handover**: with a channel moved at `fromSeq`, no message is delivered twice and none is
  lost across the boundary, in both directions.
- **Fallback**: killing the WebRTC transport mid-match moves `commands` and `view` back to the
  WebSocket and the match continues. Killing the WebSocket is fatal to the session — assert
  that too, because it is the consequence of pinning `control`.
- **Cross-channel reordering** (02 §3.3): deliver `control` and `view` in the *wrong* relative
  order and assert the client neither desyncs nor renders a frame for a match it has not been
  told started. This is the test that would have caught the bug the rule exists to prevent, and
  it is worth running as a property test over shuffled interleavings rather than one case.
- **Every integration and scenario test runs under both routings** — all-WebSocket, and split.
  Cheap, because the routing is one line of fixture setup, and it is what stops the split
  configuration from being the untested one.

## 8. Security and authority tests

These assert on the properties from 01 §5, and they are the ones that matter most because a
failure is a cheating vector rather than a bug.

- **The ground-truth test.** Run a match with two connected synthetic clients, capture every byte
  sent to client A, decode it, and assert that **no enemy entity's true position appears
  anywhere in the stream** — including inside contact records, echo returns, and stats. This is
  the single most important test in the project and it should be written at M2, the moment view
  generation exists.

  **Tap the `Link`, not a transport.** Once a session spans two transports (02 §3), a capture
  wired to the WebSocket keeps passing while covering none of the `view` traffic — which is
  precisely where enemy positions would leak. The test must assert against every byte the Link
  emits on every channel, and it should **fail if the routing table contains a channel it did
  not capture**. Writing it against the Link at M2, while there is only one transport, costs
  nothing and is what keeps it honest later.
- **Command authorization**: a client commanding an entity it does not own is rejected and logged.
- **Fleet validation**: a client submitting an over-budget or malformed fleet is rejected at
  Fleet Lock (06 §1).
- **Rate limiting**: command floods are throttled and then disconnected per 02 §7.
- **Auth**: argon2 verification runs even for unknown usernames; failure messages are identical
  for unknown-user and wrong-password; lockout triggers as specified.
- **Database portability**: the **entire repository suite runs twice** — once against a real
  SQLite file, once against a Postgres container — with the same repository code and the same
  assertions. This is the whole "generic SQL" guarantee (01 §3.1); a portability claim that is
  never executed is false. Runs in CI from M5. Also asserts that migrations apply cleanly from
  empty on both engines, since DDL is where dialects diverge most.
- **Spectator vision**: a team-limited spectator's stream contains no more than that team's
  picture — same test harness as the ground-truth test, different vision source.

## 9. Performance tests

Run in CI, failing on regression rather than on an absolute threshold, so they stay useful as
hardware changes.

| Benchmark | Asserts |
|---|---|
| `bench-acoustics` | 120 entities on a **dense generated map**, full solve < 8 ms per acoustic tick; fails on >10% regression (03 §10). Must run against a Warren seed, not open water — the sparse case proves nothing. *(Not built yet — 03 §10.)* |
| `bench-mapgen` | Generation < 2 s at base scale, < 4 s at max scale. This blocks match start, so it is player-visible latency. *(The sector decomposition and all-pairs propagation are not built — 14 §5.)* |
| `bench-navigation` | Worst-case A\* over the largest map's navmesh, well under a frame; asserts pathfinding stays out of the tick budget *(not built — no navmesh yet)* |
| `bench-tick` | Full 20 Hz tick with a worst-case match < 25 ms; fails on >10% regression |
| `bench-bandwidth` | Worst-case view frame within the 02 §6 budget, measured on real encoded bytes |
| `bench-render` | Client frame time with 800 segments + 400 echo points + several thousand terrain edges; **run manually on real hardware, never in CI** |

**On `bench-render` specifically.** Headless browsers in CI — and in WSL, which is the primary dev
environment — have no GPU and fall back to SwiftShader software rendering (verified: WebGL 2.0
via `ANGLE (SwiftShader)`, max texture 8192). That is entirely adequate for asserting a render is
*correct* — geometry in the right place, colours right, no WebGL errors — and it is worthless for
frame-rate numbers, which will be off by orders of magnitude.

The consequence for the plan: **automated browser tests may assert correctness but must never
assert performance.** The 60 fps budget in 08 §3 and the Q43 PixiJS validation both require a real
GPU and a human. Schedule them as manual checkpoints at M2 and M6 rather than expecting CI to
catch a rendering regression.

## 10. Integration tests

In-process server plus synthetic clients driven by `ScriptedController` (04 §10). No browser.

- Two clients complete a full match: connect, auth, lobby, fleet select, deploy, play, results.
- Reconnection: a client drops mid-match, reconnects within the window, and its restored view
  matches what a continuously-connected client would have.
- Host migration pre-match; host departure mid-match changes nothing.
- Lobby lifecycle: create, join by code, kick, team switch, settings propagation, start gating on
  fleet validity.

## 11. E2E tests

Playwright, two browser contexts, main branch and release branches only (too slow per PR).

- Signup → main menu → create lobby → build fleet → second player joins → match → results.
- The signup no-recovery confirmation flow.
- Fleet builder: create, save, reload the page, load, verify persistence.
- A smoke test that the scope canvas renders without WebGL errors.

## 12. Manual playtest protocol

Automated tests cannot answer "is this fun," and this game's central risks (R1, R2) are exactly
that question. Playtests are scheduled work with a defined protocol, not ad-hoc sessions.

- **M1 gate playtest** (00 §8, 11): at least three people outside the core team play the harness.
  The pass condition is that a player, unprompted, describes a *deduction* they made.
- **M4 fleet-size playtest**: sessions at 1, 4, and 10 boats. Specifically watching whether the
  10-boat case is manageable (08 §6) and whether the 4-boat case feels like the intended game.
- **M4 vertical-play playtest**: the specific risk from 04 §2 — does positioning feel
  one-dimensional without a lateral axis? Watch whether players use depth tactically or treat it
  as a number to set once.
- **M7 balance playtests**: recurring, with the balance matrix diffed between sessions.
- Every playtest records replays. A replay from a session where something felt wrong becomes a
  scenario test.

## 13. Test infrastructure

- **Fixtures over factories.** Scenario fixtures are declarative data files, reviewable by a
  designer who does not read TypeScript.
- **A scenario DSL** (`@seg/tools/scenario`) shared by tests, the balance harness, and the
  Practice Range's authored scenarios (06 §7). One format, three consumers — which is what makes
  each of them cheap.
- **Snapshot hygiene**: snapshots are reviewed, never blanket-updated. A CI job flags a PR that
  updates more than a threshold number of snapshots for extra scrutiny.
- **Seeded randomness in tests**, always, with the seed printed on failure.
- **No sleeps, no wall-clock**, anywhere. The sim's tick is the only clock, and the integration
  harness drives it manually rather than in real time — a "20-minute match" runs in under a
  second.

## 14. Coverage targets

| Package / area | Target | Rationale |
|---|---|---|
| `shared/sim/acoustics` | **95%** | The core mechanic and the least observable subsystem |
| `shared/map` | **95%** | A generator bug is a broken match, not a glitch; pure and headless, so coverage is cheap |
| `shared/sim` (rest) | 85% | Deterministic, pure, high value |
| `shared/fleet`, `shared/content` | 90% | Cheap to test, expensive to get wrong |
| `shared/protocol` | 90% | Property tests do most of this for free |
| `server/auth`, `server/match` | 80% | Security and authority boundaries |
| `server/db/repos` | 85% | Cheap to test, and the coverage is doubled for free by running against both engines |
| `server` (rest) | none | Covered by integration tests |
| `client` | none | Covered by E2E and manual testing |

## 15. When tests are written

Testing is integrated per milestone rather than deferred (11):

- **M0** — Vitest configured; the lint rules that protect determinism and package purity; CI
  running tests on every PR. One trivial test per package so the harness is proven.
- **M1** — Unit tests for math, movement, terrain, navigation, acoustics, tracker. **The map
  generator property suite (§4.1)** and **the scenario harness and initial corpus (§5)**. The
  balance matrix, `bench-acoustics` on a dense seed, and `bench-mapgen`. This is the milestone
  where testing effort is heaviest, and deliberately so — everything downstream trusts it, and the
  generator's invariants are load-bearing for the entire game.
- **M2** — Protocol property tests. **The ground-truth test (§8).** `bench-bandwidth`. The
  integration harness with synthetic clients.
- **M3** — Weapons and damage scenarios; content validation; the replay corpus and determinism
  check in CI.
- **M4** — Mode and objective scenarios; reconnection integration tests.
- **M5** — Auth and security tests; **the dual-engine repository suite (§8)**; fleet persistence
  and content-drift tests; the first E2E flows.
- **M6** — Accessibility checks (contrast ratios asserted against the palette in code, keyboard
  navigation E2E).
- **M7** — Load tests at target concurrency; the security review pass.

**A feature is not done until its tests exist.** For the simulation specifically, the scenario
that encodes the design intent is written *with* the feature, because the scenario is how the
intent gets recorded at all.
