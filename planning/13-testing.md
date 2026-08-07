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

Fast, isolated, run on every save. Vitest.

| Area | What is asserted |
|---|---|
| `math/` | Vector ops, angle wrapping and shortest-arc, pitch-band clamping, interpolation, seeded PRNG reproducibility |
| `content/` | Modifier resolution order (`set` → `add` → `mul` → clamp), stacking, stat derivation for every hull × module combination that is legal |
| `fleet/` | Cost calculation, budget validation, slot-count validation, tube assignment, content-drift repair (07 §3) |
| `sim/movement` | Acceleration and deceleration clamps, turn-rate curve, **pitch-band enforcement**, `descentRate = speed·sin(pitch)`, ballast at low speed, no-reverse invariant |
| `sim/terrain` | Segment-versus-polygon intersection, sector lookup, portal traversal, grounding detection |
| `sim/navigation` | Per-hull navmesh filtering, A\* correctness, string-pulling, pitch-band route validation, **"no route" returned rather than a bad route** |
| `mapgen/` | See §4.1 — the generator gets its own suite |
| `sim/acoustics` | `TL` monotonic in range; layer penalty applied exactly once per crossing; self-noise curve; baffle arc geometry; `SE` composition |
| `sim/tracker` | Association within gate, split on quality loss, merge on convergence, staleness expiry, designation stability |
| `sim/weapons` | Enable-point logic, seeker acquisition gate, fuze distance, expiry, **torpedo pitch limits** |
| `protocol/` | See §7 |
| `view/` | Delta encoding correctness, baseline-ack behaviour, keyframe on missing ack |

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

**Property tests over ≥500 seeds**, asserting every invariant in 14 §3:

| Invariant | How it is checked |
|---|---|
| I1 — three paths at every `x` | Sample `x` at 5 m intervals; connected-component analysis of free-space intervals; count components belonging to left-to-right-connected regions. Must be ≥ 3 everywhere. |
| I2 — one large-hull route at every `x` | Filter the navmesh to the largest hull's clearance; assert left-to-right connectivity survives |
| I3 — equivalent deployment connectivity | Each zone touches ≥3 routes; route-length distributions to each objective within tolerance of the mirror |
| I4 — no unreachable pockets | Flood-fill from both deployment zones; any free space not reached is filled or explicitly marked dead |
| I5 — detail never breaks clearance | After the detail pass, re-measure clearance along every skeleton segment against its declared width class |
| I6 — objectives valid and contestable | Clearance for a mid-size hull, reachable by ≥2 distinct routes, not inside a maximally tight choke |

Plus:
- **Determinism**: same `(seed, generatorVersion, params)` → byte-identical output, both twice in
  one process and across processes.
- **Archetype coverage**: over 500 seeds every region archetype appears, and no archetype
  dominates beyond its intended frequency. Catches a generator that has quietly stopped emitting
  Chokes.
- **Scale sweep**: invariants hold at every supported map extent (14 §9), not just the base size.
  Small maps are the likely failure case — there is less room to fit three routes.
- **Sector/portal integrity**: sectors are convex, tile the free space without gaps or overlaps,
  and every portal is shared by exactly two sectors. The acoustics and navigation both trust this.
- **Propagation table sanity**: `pathLength` ≥ straight-line distance for every pair; the table is
  symmetric in length; `firstPortal` is always adjacent to the source sector.
- **Performance** (§9): generation plus acoustic precompute inside the match-start budget.

**The seed gallery is part of the protocol, not a nice-to-have.** Property tests prove
correctness; only human review of `pnpm map:gallery` output catches "correct and boring." Required
on every generator change.

## 5. Scenario tests — the load-bearing layer

A scenario is a small declarative fixture: a map, a set of boats with loadouts and initial
states, and a command script. The test runs the real simulation headlessly for N ticks and
asserts on outcomes.

```ts
scenario('a creeping Special Ops is not detected by a cruising Attack at 800m', {
  map: 'open-water',
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
|---|---|
| Creep versus cruise at range | Speed is the dominant stealth lever |
| Cavitation onset | Crossing the threshold produces a large, immediate detection-range jump |
| Cavitation versus depth | The same speed is safe deep and fatal shallow |
| Across the layer | Layer crossing at least halves effective detection range in every hull pairing |
| Hugging the layer | A boat just below the layer is undetected by one just above at close range |
| Terrain shadow | Rock between two boats blocks detection; clearing it restores contact |
| Portal relay | A contact heard through an opening yields a bearing to the **portal**, not the boat, with uncertainty scaled by the portal's angular size (03 §5.1) |
| Diffraction penalty | A boat one bend away is materially harder to detect than one in line of sight at the same path length — proves the portal model does something |
| Waveguide | A boat in a Slot passage is undetectable off-axis and clearly detectable from either end of the passage |
| Open column exposure | A cavitating Heavy in an Open Column is detected across the whole region |
| Clearance routing | A Heavy is refused a route through a Warren; a Scout is granted one on the same map |
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

## 8. Security and authority tests

These assert on the properties from 01 §5, and they are the ones that matter most because a
failure is a cheating vector rather than a bug.

- **The ground-truth test.** Run a match with two connected synthetic clients, capture every byte
  sent to client A, decode it, and assert that **no enemy entity's true position appears
  anywhere in the stream** — including inside contact records, echo returns, and stats. This is
  the single most important test in the project and it should be written at M2, the moment view
  generation exists.
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
| `bench-acoustics` | 120 entities on a **dense generated map**, full solve < 8 ms per acoustic tick; fails on >10% regression (03 §10). Must run against a Warren seed, not open water — the sparse case proves nothing. |
| `bench-mapgen` | Generation + sector decomposition + all-pairs propagation precompute < 2 s at base scale, < 4 s at max scale. This blocks match start, so it is player-visible latency. |
| `bench-navigation` | Worst-case A\* over the largest map's navmesh, well under a frame; asserts pathfinding stays out of the tick budget |
| `bench-tick` | Full 20 Hz tick with a worst-case match < 25 ms; fails on >10% regression |
| `bench-bandwidth` | Worst-case view frame within the 02 §6 budget, measured on real encoded bytes |
| `bench-render` | Client frame time with 800 segments + 400 echo points; run manually, not in CI |

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
| `shared/mapgen` | **95%** | A generator bug is a broken match, not a glitch; pure and headless, so coverage is cheap |
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
