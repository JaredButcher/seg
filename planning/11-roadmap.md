# 11 — Roadmap

Milestones are defined by **exit criteria**, not by duration. Durations are rough estimates for
a small team and should be re-estimated after M1, when the first real velocity data exists.

The sequencing principle: **prove the fun before building the product.** The sonar mechanic is
the whole risk (R1), so it comes first, ugly and un-networked.

---

## M0 — Foundations *(~1 week)*

Scaffolding only. Resist the urge to build game systems here.

- pnpm workspace, four packages (`@seg/shared`, `@seg/server`, `@seg/client`, `@seg/tools`),
  TypeScript config, project references
- `LICENSE` (MIT) and a `README` pointing at `planning/`
- Lint, format, boundary enforcement (10 §3), CI pipeline skeleton
- **Vitest wired up across all packages; one trivial test each to prove the harness**
- **The lint rules that protect determinism** (no `Math.random()`/`Date.now()` in `sim/`) and
  package purity — these are cheap now and unenforceable later
- `CLAUDE.md` pointing at `planning/`
- Vector/angle math and the seeded PRNG, fully tested
- Entity store and spatial hash
- Delete or repoint the stray top-level `src/`

**Exit:** `pnpm test` and `pnpm build` are green in CI. Boundary checks reject a deliberate
`import 'fs'` in `shared`, and the determinism lint rejects a deliberate `Math.random()` in
`sim/`.

---

## M1 — Terrain & The Mechanic *(~5 weeks)* ⚠️ **the gate**

Headless simulation plus a throwaway visual harness. No networking, no accounts, no lobby.

> **Status.** The map generator, the water-lattice acoustic model, and their test suites are
> built (`@seg/shared/map`, `@seg/shared/sim/acoustics`). The bullets below are re-marked
> against reality: the sector/portal decomposition and navmesh were **not** built (14 §5) —
> the lattice removed acoustics' dependency on them, and navigation still awaits its own work.
> The region-archetype model was replaced by the level-stack tuning (14 §4), active ping, the
> tracker, layers, and baffles are still not built (03 §6–7, §4), and there is no tick loop
> wiring the solve into a match yet (04 §1).

**Map generation moved into M1 and is the reason this milestone grew.** It cannot be deferred:
the acoustic model's propagation lookup consumes the generator's terrain (the water lattice
rasterizes its contours — 03 §5.2, 14 §6), and the whole feel of the game depends on terrain
that is dense in the intended way. Building acoustics against open water and retrofitting caves
later would mean rewriting the expensive half of the simulation. A rough generator early beats a
polished one late.

- **The map generator** (14): levels + connections skeleton with invariants by construction,
  carve, contours, validation. *(The planned convex sector decomposition, portals, navmesh,
  all-pairs propagation precompute, and placement were not built — 14 §5.)*
- **The generator property suite** (13 §4.1) — floor guarantees, determinism, scale sweep; the
  seed gallery is still pending
- The 20 Hz tick loop with the 10 Hz acoustic phase (04 §1) — **built**
  (`@seg/server/src/match/runtime.ts` and `clock.ts`): one process-wide timer walks every
  running match, the runtime advances the clock at `SIM_TICK_HZ`, steps every boat along its
  orders each tick (`stepBoat`, 04 §5), and solves acoustics on every second tick, with a view
  frame going out per recipient per solve. It never self-schedules (01 §4.3), so the suite
  drives it by calling `tick()`.
- **Basic movement** (04 §5) — built: a boat is selected by clicking its hull, clicking its fleet
  row, or pressing its number key; left-click on the water then orders it to a point, shift-click
  queues a route, right-click cancels; the server owns the route; the throttle notch (SLOW / FULL
  / FLANK) is set per boat from the fleet list (08 §5). *Navigation — pathfinding, terrain collision, the
  "no route" refusal — is not built* (below).
- **The fog of war** (C21, ADR 0002) — built: per-team chart, confirmation thresholds, the
  contact book, the wire encoding (`@seg/shared/src/match/vision.ts`), and the client layers
  that draw them (`@seg/client/src/render/sonar.ts`)
- **Vertical-slice kinematics**: pitch-band movement, `descentRate = speed·sin(pitch)`, ballast,
  surface as a hard boundary (04 §5) — not built (a straight-line, depth-as-target `stepBoat`
  transit is; the mechanics above it are not)
- **Navigation**: per-hull navmesh filtering, A\*, string-pulling, pitch validation, "no route"
  as a first-class result (04 §5.1) — not built (no navmesh)
- Terrain collision with a grazing threshold (Q39) — not built
- Full acoustic model — **emission, geodesic propagation, and the vision-square picture are
  built** (03 §3–5); **layers and baffles are not built**
- **Propagation**: superseded — the water lattice + 1 m skin replaced portal propagation, and
  there is no apparent bearing (03 §4–5, §5.1). The waveguide/diffraction layers are not built.
- **Active sonar** (C22, ADR 0003) — built *as a loud transient*: a `pingLevel` stat, a pulse
  every 1000 ms while the switch is on, a `Powerful Active Sonar` module, and the first client
  command in the game (`match.setActiveSonar`, hotkey `Q`). It is what a player has instead of
  an empty opening screen — a stopped boat charts nothing passively and thousands of squares
  with the switch on (03 §9.2).
- Active ping **wavefronts** and echo silhouette sampling against side profiles and cave walls
  (03 §6) — **not built**, and deliberately not a prerequisite for the above. No travelling
  front, no `2·range/c` return delay, no traced near-side outline; the ring the client draws is
  an animation.
- Contact tracker with association, quality, staleness, split/merge (03 §7) — **not built**
- **The scenario DSL and the initial corpus** (13 §5) — this is a headline M1 deliverable, not
  a side task; pending (the per-module Vitest suites are green, including `acoustics-*` and
  `map-*`)
- Unit tests for math, movement, terrain, acoustics, tracker (13 §3), including the
  vertical-slice invariants — acoustics, map, math, movement, fleet, protocol, lobby, match are
  built; navigation and tracker are pending
- Balance matrix (03 §11), `bench-acoustics` on a dense seed, and `bench-mapgen` (13 §9) —
  pending
- `ScriptedController` (04 §10), used by the scenario harness from day one — pending
- A crude local-only visual harness: a canvas, a generated cave system, two boats, keyboard
  control, contacts drawn as raw wedges and points. **Deliberately ugly.**

**Exit — and this is a real go/no-go:**
- A developer can play the harness solo against a scripted opponent and *feel* the tension.
- Detection ranges are sane per archetype and match design intent.
- Generated maps satisfy every invariant over 500 seeds, and the gallery looks *varied and
  interesting* to a human.
- The scenario corpus from 13 §5 is green and its assertions match the design docs.
- At least three people outside the core team play the harness and describe a *deduction* they
  made (the pillar-1 acceptance test, 00 §8).
- **Depth reads as a place, not a number** (pillar P6), and **terrain reads as tactical rather
  than as obstacle**. Together these retire risk R9 — or reveal that it is real while it is still
  cheap to respond to.
- **Portal bearings read as a puzzle, not as broken sensors.** ~~If harness players
  consistently experience relayed bearings as a bug, that is a presentation problem to solve
  now, before the UI is built on top of it (08 §4).~~ **Moot for now — the bearing output is
  not built** (03 §5.1); the vision picture is positional, so there is no relayed bearing to
  misread. This criterion returns with the bearing layer.

**If M1 fails, stop and redesign the acoustic model.** Everything downstream assumes this
works. This is the cheapest possible moment to discover it does not.

---

## M2 — Networking *(~3 weeks)*

- `Transport` / `Codec` abstractions; `WsTransport` + `JsonCodec` (02 §2)
- Channel separation, view sequencing, baseline-ack delta encoding, quantization (02 §3, §6)
- `MatchHost` with the scheduler at 20 Hz; per-player view generation at 10 Hz
- **The ground-truth test** (13 §8) — decode every byte sent to a client and assert no enemy
  true position appears anywhere. Written the moment view generation exists, not later.
- Client net layer, view store, interpolation (including pitch)
- A real (still ugly) client scope rendering the cross-section: **the cave system from a static
  geometry buffer**, surface, layers, own boats, contacts, echoes
- **Prototype the relayed-bearing UI** (08 §4) against the ugly renderer. It is the highest-risk
  interface in the project and it must not wait for M5. *(Held: bearings are not built — 03 §5.1.
  If the bearing layer is still absent at M2, this slips until it exists.)*
- Command flow with `cmdAck` and optimistic order markers
- Protocol property and fuzz tests (13 §7), written against `JsonCodec` so the binary migration
  is safe later
- Scripted test clients (`pnpm dev:bots`) and the integration harness
- Bandwidth and tick-time dev overlays; `bench-bandwidth`

**Exit:** two browsers on different machines play a scripted engagement end to end. The
ground-truth test passes. Worst-case bandwidth measured and inside the 02 §6 budget. p95
command-to-ack under 120 ms locally. `bench-tick` inside the 50 ms budget at worst case.

---

## M3 — Content & Combat *(~3 weeks)*

- Content tables: 5 hulls, ~22 modules, 6 torpedo variants (05)
- Modifier resolver, fleet cost calculation and validation
- Torpedoes end to end: launch, run-out, enable point, seeker, terminal, expiry (04 §7),
  **including per-variant pitch limits** and **terrain collision** — rock is cover from weapons
- Wire guidance
- Drones, mines, decoys — as entities sharing the acoustic path
- Damage, destruction, sinking wrecks, the damaged-boat noise penalty (04 §8)
- Crush depth and hull stress (04 §6)
- Reload and tube management
- Stats accumulation (04 §11)
- Side-profile silhouette polygons for all 5 hulls
- Content validation tests (13 §4); weapons and damage scenarios; the replay corpus and the
  determinism check in CI

**Exit:** a full engagement — detect, track, solve, fire, evade, kill — works and is fun.
Vertical evasion against a super-cavitating torpedo works as designed. Content freeze for 1.0
(00 §3). Balance matrix committed as the baseline.

---

## M4 — Match Structure *(~2.5 weeks)*

- Match lifecycle: deployment (with depth and route placement), active, resolution (06 §1)
- Deathmatch with the timer, point scoring, tiebreak
- Objective Capture with depth- and terrain-differentiated zones, capture logic, scoring, beacons
- **Generator tuning pass**: archetype mix, difficulty of chokes, objective placement quality,
  mirror-symmetry stitching. The generator exists from M1; this is where it becomes *good*.
- Map extents as a generation parameter, scaling with fleet size (14 §9)
- **Lobby map preview** (14 §8) — needed before fleets can be chosen meaningfully
- Standing orders including **Hug Layer** and **Follow Bottom** (04 §5)
- Win conditions, `MatchResult`, stat finalization
- Reconnection: snapshot, restore, the 90 s window
- Mode scenarios and reconnection integration tests (13 §15)
- **Three playtests** (13 §12): fleet size at 1/4/10 boats, vertical play (risk R9), and general
  match feel

**Exit:** complete matches in both modes, start to finish, with real win conditions. The
fleet-size question has an answer at both extremes. Depth and terrain are being used tactically,
or we know they aren't and why. Generated maps are consistently good enough to play competitively
— judged by playing a dozen random seeds, not by looking at them.

---

## M5 — Meta *(~3 weeks)*

- ~~Accounts: login, sessions, rate limiting (07 §2)~~ — **delivered early**, see below
- ~~Database: `SqlDialect` shim, SQLite implementation, portable migrations, repositories~~ —
  **delivered early**
- Signup's no-recovery warning flow and confirmation step (client-side; the API exists)
- Account deletion and the recovery-code flow (Q16) — the `recovery_hash` column is already in
  migration `001_auth.sql`
- **The Postgres implementation and the dual-engine CI suite** (13 §8). Build while the schema
  is small — not later, when portability has quietly rotted.

> **Pulled forward from M5.** The auth API and its SQL backend were implemented immediately
> after M0, because they depend on nothing in the simulation and were already flagged as
> parallelizable (see "Critical path" below). Delivered: the dialect shim, SQLite `Db`, the
> migration runner, account and session repositories, argon2id hashing with a timing-equalized
> unknown-user path, opaque session tokens stored as SHA-256, sliding "keep me logged in"
> sessions, per-username and per-IP rate limiting, and the six HTTP endpoints — with 61 tests
> covering them.
- Fleet builder: full UI, save/load, presets at 3/4/5 boats, import/export codes, live stat,
  detection-range, and depth-envelope previews (07 §3, 09 §10)
- Lobby: creation, join codes, host settings, team assignment, ready, chat
- Server browser with the "most likely to start" sort (07 §4)
- Spectator mode with vision policies (07 §5)
- Results screen: statistics panels, awards, the depth-trace chart, and the Reveal player
  (06 §5, 08 §8)
- Guest accounts implemented
- Auth and security tests; fleet persistence and content-drift tests; the first E2E flows

**Exit:** a stranger can sign up, find or create a lobby, build a fleet, play a full match, and
see their results — without help.

---

## M6 — Art & Audio *(~3 weeks)*

- Full visual pass on the scope: depth scale, surface band, layer lines, seabed rendering,
  fixed markings, line language, palette, panels (09)
- Shader chain: the vertical depth gradient, bloom, phosphor persistence, grain, scanlines,
  vignette
- All screens styled to the art direction
- Icon set, typography, layout polish, and the fleet builder's elevation-drawing treatment
- Audio: informative passive bed, transients, the active ping and its returns, UI sounds
- Accessibility: high-contrast mode, colourblind palettes, motion toggles, keyboard access,
  UI scale (08 §7)
- Quality settings and auto-detection

**Exit:** the game looks and sounds like the thing described in 09. Accessibility modes are
implemented and verified, not merely planned.

---

## M7 — Onboarding, Tuning & Hardening *(~3 weeks)*

- Practice Range: 6–8 **authored scenarios** using the scenario DSL and static/scripted targets
  (06 §7). Not a bot — deliberately, and it is cheaper this way.
- Contextual hints, preset fleets, first-run flow
- Sustained balance passes driven by playtest data and the balance matrix
- Load testing to target concurrency; tick-time profiling under worst case
- Security review: auth, rate limits, input validation, command authorization
- Error handling, reconnection edge cases, network-condition testing
- Deployment: Docker, Caddy, backups, health endpoint, drain-on-deploy
- Bug burn-down

**Exit:** an external playtest of ~20 people runs a full evening without a blocking bug.
Balance is defensible. Performance targets (00 §8) are met on the target VM.

---

## M8 — Launch *(~1 week)*

- Landing page, player-facing docs, keybind reference, a short trailer clip
- Community channel and a bug-report path
- Production deploy, monitoring, on-call rota for the first week
- A day-one patch branch ready to go

**Exit:** it is live and people are playing it.

---

## Post-launch, in priority order

1. **Bots.** Explicitly out of scope for 1.0, and the top of the post-launch list. Risk R4
   (cold start) is the most likely cause of failure and playable-versus-AI is its strongest
   mitigation. The `Controller` seam (04 §10) and the lobby's generic occupant slot (07 §4)
   mean this is additive work rather than a refactor — which is the entire reason those two
   things exist now.
2. Binary codec, then WebRTC **alongside** the WebSocket (02 §9). Four independently
   revertable steps: binary over the existing socket, then `commands` onto a data channel,
   then `view`, then unreliable `view`. The WebSocket keeps `control` — and therefore the
   whole lobby — permanently (02 §3.1).
3. Narrowband/tonal passive detection (03 §12).
4. More maps; **convergence zones and surface ducts** — considerably more attractive than they
   were in a top-down design, because in a cross-section the ray paths are directly drawable.
5. Replay sharing and a spectator/tournament mode with delayed god view.
6. Additional hulls, modules, and torpedo variants from the M3 deferred list (05 §6).
7. Matchmaking — **only** once concurrent player counts make it better than a server browser.
   Below a few hundred concurrents, matchmaking is worse.

## Critical path and parallelism

M1 → M2 → M3 → M4 are strictly sequential; each depends on the last.

**Within M1**, the generator is on the critical path — as built, the acoustic model consumes
its contours (the lattice rasterizes them), so terrain still precedes acoustics. The planned
internal sequence "skeleton and carve → sectors and portals → navigation → acoustics" did not
survive contact with the lattice: acoustics no longer depends on sectors or portals (03 §4–5),
and the navmesh is deferred. Sequence now: skeleton and carve → contours → the acoustic lattice
→ the vision picture, with navigation arriving with the navmesh it needs.

Work that can proceed in parallel once M1 exits:
- Art direction exploration and shader prototyping (feeds M6) — particularly the depth gradient
  and the **rock fill treatment**, which is now the largest area of the screen and the most likely
  point of visual failure (08 §3)
- Auth, database, and account UI (feeds M5) — depends on nothing in the sim
- Fleet builder UI against the M3 content tables

The single largest schedule risk after M1 is **M6 art**, because the aesthetic is the product's
identity and "make neon lines look expensive" is hard to timebox. Start shader prototyping
during M2–M3 rather than waiting for M6.

The second largest is now **M1 itself**, which absorbed map generation and grew from ~3 weeks to
~5. That is the correct place to spend it — the generator is upstream of acoustics, navigation,
rendering, and balance — but it does push the whole schedule right by roughly two weeks. Re-plan
after M1 with real velocity data rather than trusting these estimates.

The third is **M4 balance**, which now has three coupled dimensions rather than two: pitch limits
versus torpedo evasion, crush depth versus map depth, and **clearance radius versus passage width
distribution**. That last one couples the content table to the generator's tuning, so a change to
either can invalidate the other. The per-archetype balance matrix (03 §11) exists specifically to
make that coupling visible; budget real tuning time rather than assuming the first numbers hold.
