<<<<<<< HEAD
# 04 — Simulation Core

## 1. The loop

The simulation runs at **20 Hz** (`dt = 0.05 s`). The acoustic and view phases run at **10 Hz**
— every second tick — because detection state does not change meaningfully in 50 ms and
acoustics is the expensive phase (03 §10). Movement, collision, and weapons get the full 20 Hz.

```
tick(dt = 0.05s):                                   [every tick — 20 Hz]
  1. drain command queue          → apply orders to controllers (validated, authorized)
  2. controller step              → standing orders → throttle/pitch/depth demands
  3. kinematics integrate         → position, facing, speed
  4. terrain & collision          → seabed, terrain polygons, surface, crush
  5. weapons kinematics           → torpedo movement, fuzing, detonation, damage

  if (tick % 2 === 0):                              [every other tick — 10 Hz]
  6. acoustics: emit              → sourceLevelOf per entity (03 §3)
  7. acoustics: propagate/detect  → per-team vision solve (03 §4–5); wavefronts not built yet
  8. tracker update               → detections → contacts, association, staleness
  9. seeker update                → torpedo seekers consume the same detection output
 10. objectives & scoring         → capture progress, win conditions
 11. view generation              → per-player ViewDelta from that player's picture
 12. stats accumulation
```

Order matters. Acoustics run **after** movement so contacts reflect this tick's positions, and
seekers run **after** the tracker so torpedo guidance uses the same detection machinery as
boats — one code path, consistent rules.

**Status of the loop.** The `SIM_TICK_HZ = 20` / `ACOUSTIC_TICK_HZ = 10` constants exist in
`@seg/shared`, the acoustic phase is implemented and tested (`sim/acoustics`), and the loop itself
runs: the runtime's `tick()` advances the clock, maps `stepBoat(boat, SIM_TICK_SECONDS)` over the
boats every tick (§5, `match/movement.ts`), and solves acoustics on every second tick
(`packages/server/src/match/runtime.ts`). Steps 8–10 (tracker, seeker, objectives) are design
until their layers land (03 §7).

Fixed `dt`, always. If a tick overruns, log and continue; never accumulate and double-step
(01 §7).

**Why 20 Hz and not 10.** Torpedo terminal geometry is the binding constraint. A 55 m/s
super-cavitating torpedo covers 5.5 m per tick at 20 Hz but 11 m at 10 Hz — comparable to a
hull's own width, which risks tunnelling and makes proximity fuzing coarse. 20 Hz also makes
close-quarters collision and terrain contact behave properly. The cost is bounded because the
expensive phase stays at 10 Hz.

## 2. The world is a vertical slice

**`x` is horizontal distance. `y` is depth, positive downward.** There is no third dimension —
not a hidden one, not a scalar one. The simulation plane and the display plane are the same
plane, at the same scale, in the same orientation.

Everything that follows depends on this, and it is worth stating what it buys:

- **Depth is a spatial axis, so depth mechanics are geometry.** The thermocline is a line
  segment. Crush depth is a line. A shadow zone behind a seamount is a polygon. All three are
  drawable, clickable, and immediately legible (03 §4).
- **Diving is movement, not a separate system.** There is no `depthRate` stat and no parallel
  depth-change integrator — a boat descends by pointing down and moving. This removes an entire
  subsystem and makes the speed/stealth/depth trade emergent rather than authored (§5).
- **Acoustic range is geodesic, not straight-line.** Propagation follows the water lattice, so
  "range" is the shortest path *through water* around rock, not `√(dx² + dy²)` (03 §4).
- **Terrain masking is the water lattice**, not raycasts: every water cell knows whether sound can
  reach it, and every surface square bins under the cell that can hear it (03 §5.2).
- **Silhouettes are side profiles**, which are far more recognizable than plan views and serve
  as the reflection geometry for the vision picture and as fleet-builder artwork. The collision
  shape is separate (03 §6).

Camera and boats translate in `x` and `y` only. The camera never rotates (Q13).

### What it costs
There is no lateral dimension, so there is no flanking *around* an enemy — only above, below,
ahead, and behind. Encirclement is replaced by **vertical envelopment**, and the tactical
vocabulary is closer to a 2D fighting game's spacing than to an RTS's map control.

This was the plan's biggest open worry (risk R9). **Dense cave terrain (14) is the answer.** With
three or more traversable routes guaranteed at every `x`, each with different clearance, exposure,
and acoustic character, there is no single line to push along — flanking becomes "take the lower
warren while he watches the column," which is real positional play in a form specific to this
geometry. Confirm in the M1 harness, then downgrade R9.

## 3. World and terrain

| Property | Value |
|---|---|
| Map width (base) | 8000 m, scaled by map size — small/medium/large 0.7×/1×/1.5× (14 §1) |
| Map height (base) | 3000 m, scaled the same way |
| Map depth | 1200 m on every map size; `depthScale = 1200 / height` maps Y to game depth |
| Coordinate origin | Seabed at `y = 0`; surface at `y = height`; frame is y-up (depth counts down from the surface) |
| Surface | `y = height`. A hard boundary; breaching is loud and damaging. |
| Terrain | A dense procedurally-generated cave system filling the volume (14) |
| Layer(s) | One to three horizontal thermoclines (03 §4) — **not yet built** |

**Maps are procedurally generated cave systems, not authored levels.** Terrain is dense: chambers,
passages, and open columns stacked through the full depth, with a guarantee of at least three
traversable routes at every `x`. Full specification in [14-map-generation.md](14-map-generation.md).

**Terrain representation** — the generator emits one structure that four consumers share:

| Artifact | Consumed by |
|---|---|
| Simplified contour polygons | Rendering (static geometry buffer), collision |
| **Water lattice** + 1 m reflector **skin** | Acoustics (03 §5.2) |
| Per-hull filtered **navmesh** | Pathfinding (§5.1) |

The sharing is deliberate and it is what makes dense terrain affordable. The water lattice — the
rasterized terrain plus a *nearest-water* index for every rock cell — is computed once at match
start and answers "can sound get here" for every entity per tick at linear cost; the skin binds
each surface square to the lattice cell that can hear it, so the same data answers "what do I
draw" without any per-frame geometry search. The convex-decomposition/portal structure the plan
called for (03 §5.2) was replaced by this during implementation.

**Terrain is the dominant system in the game now.** It decides most detections (03 §4), constrains
which hulls can go where (§5.1, 05 §2), and occupies most of the screen (08 §3). It is no longer a
modifier on open-water play — open water is the special case.

## 4. Entities

One entity model, discriminated by kind. Everything that can move, make noise, or be detected is
an entity — this uniformity is what lets torpedoes, drones, and boats share the acoustic and
tracker code.

```ts
interface Entity {
  id: EntityId;
  kind: 'submarine' | 'torpedo' | 'drone' | 'mine' | 'decoy' | 'objective' | 'wreck';
  team: TeamId | null;
  owner: PlayerId | null;
  pos: Vec2;               // x = horizontal, y = depth (positive down)
  facing: number;          // degrees in the slice; 0 = +x, positive = up-and-right
  speed: number;           // m/s along `facing`, always ≥ 0
  // kind-specific state in a tagged union
}
```

`facing` replaces the top-down design's `heading`, and `depth` is simply `pos.y`. There is no
separate depth state.

**No reverse.** Minimum speed is 0; boats cannot back up.

## 5. Submarine movement

Order-driven, not directly piloted. The player sets *demands*; the boat obeys them within its
physical limits.

### Facing is pitch-constrained
A boat's `facing` is confined to a band around horizontal, on whichever side it is travelling:

```
facing ∈ [−maxPitch, +maxPitch]  (travelling right)
   or  [180−maxPitch, 180+maxPitch]  (travelling left)
```

`maxPitch` is a hull stat, roughly **25–35°**. Submarines do not point straight down, and the
constraint keeps boats reading as submarines rather than as aircraft. Reversing direction
(right ↔ left) is a **turn**, executed at the hull's turn rate through the vertical — a slow,
committed, noisy manoeuvre exactly as a course reversal should be.

### Integration
```
speed  += clamp(targetSpeed − speed, −decel·dt, accel·dt)
turnRate = maxTurnRate · turnEfficiency(speed)
facing  += clamp(angleTo(targetFacing), −turnRate·dt, turnRate·dt)   // clamped to the pitch band
pos     += facingVector(facing) · speed · dt
pos.y   += ballastRate · dt                                          // slow, low-speed only
```

**Descent rate is `speed · sin(pitch)` and nothing else.** At 15 m/s with 30° of down-angle a
boat descends at 7.5 m/s; at creep it descends at 1.5 m/s. This single line generates the
game's central trade with no additional design:

> **Changing depth quickly requires going fast. Going fast makes you loud. So depth changes
> are expensive exactly when you most want one — while breaking contact.**

`turnEfficiency` peaks at moderate speed: a stopped boat cannot pitch, a flank-speed boat turns
wide.

**Ballast** provides a slow vertical rate (±0.5 m/s) available at low or zero speed, so an
all-stopped boat is not frozen in depth and can hover or settle. Using it aggressively
("emergency blow") is a loud transient (03 §3).

### Turn rates are slow
A direction reversal should take 30–60 s. This is the primary control on pacing and the reason
the game reads as an RTS rather than a shooter. In cave terrain this has a sharp consequence:
**a boat committed to a passage cannot simply turn around inside it.** Entering a corridor is a
decision you live with until it opens out, which makes route choice weighty and makes ambushes in
passages genuinely deadly.

### What exists today — a straight-line transit

The base movement order is built and runs every tick, and it is deliberately the simplest thing
that could work: `stepBoat` (`@seg/shared/match/movement.ts`) accelerates a boat toward its
throttle notch's speed (08 §5), steers toward the first waypoint at the hull's constant
`turnRate` — so a boat curves toward its heading rather than snapping about — pops a waypoint when
it gets there, and drops to `hold` with speed 0 when the queue empties.

Slow turn rates have one consequence the transit does handle. A boat that reaches a waypoint fast
and off-bearing has that waypoint *inside* its turning circle (`r = v/ω`, half a kilometre for a
Heavy at flank), so it sweeps past, comes round, and misses again — it orbits. `maxApproachSpeed`
is the geometric answer: the point is inside the circle exactly when `distance < 2·r·sin θ`, and
inverting for `v` gives the fastest speed that still reaches it. The **last** waypoint caps the
throttle notch at that speed — the boat slows into the turn and winds back up as it steadies on —
while an **intermediate** one is counted as made good the moment it falls inside the circle, the
next leg taking over: a route hint is not worth crawling for. The design above is what remains:

- **No depth kinematics.** A waypoint is an `(x, depth)` position and arrival lands on both, but
  the run between them is a straight shot along `facing` — there is no pitch band, no
  `descentRate = speed·sin(pitch)`, and no ballast. A diagonal order is a diagonal run, not a
  dive; "diving is movement" (§2) stays the design, not the build.
- **No `turnEfficiency` curve.** Turn rate is a constant; a stopped boat and a flank-speed boat
  steer identically.
- **No terrain.** Routes are straight lines through whatever geometry they cross — boats do not
  collide with rock yet (Q39) and nothing stops them being ordered across a wall (§5.1).
- **Acceleration is a game number, not a physics one** (`MOVEMENT_ACCELERATION = 10 m/s²`): a
  boat reaches flank from a standstill in about two seconds. The real physics — minutes to gain a
  couple of knots — is traded here for gameplay pacing.

### 5.1 Navigation through caves

Boats path through a cave system, which open water did not require.

**Status: not built.** There is no navmesh (14 §5) and no pathfinding — an order is a straight
line of waypoints through whatever geometry it crosses, "no route" cannot be refused because
routes are never evaluated against terrain, and boats do not yet collide with rock (Q39).
Pathfinding, per-hull clearance, the no-route refusal, and the grazing threshold land together,
once collision exists to fail against.

- **Clearance.** Every hull has a `clearanceRadius` derived from its silhouette. The navmesh is
  filtered per hull: a Heavy's traversable graph is the subgraph of sectors and portals that admit
  it. A Scout's is nearly the whole map. This is what turns hull size into a **strategic**
  property rather than just a stealth and durability stat (05 §2).
- **Pathfinding** is A\* over the filtered graph, then string-pulled into a smooth route, then
  validated against the pitch band — a route demanding a 60° climb is invalid for a boat limited
  to 30° and must be re-planned or refused.
- **Runs on order issue and replan, never per tick.** Pathfinding is not in the tick budget.
- **"No route" must be a first-class, visible outcome.** If a selected hull cannot reach the
  ordered point, the UI refuses the order and says why — "no route: passages too narrow for this
  hull" (08 §5). Silent failure or a boat that swims into a wall and stops would be maddening,
  and with per-hull clearance this case is common, not exotic.
- **"Follow the bottom"** is re-specified for caves: follow the floor of the current passage at a
  fixed offset. Still the quiet, masked, dangerous transit order.
- **Terrain collision** is now a routine hazard rather than a rare punishment, so it needs a
  grazing threshold: brushing a wall at creep should be harmless, hitting one at flank should not
  (Q39).

### Standing orders
Per boat, persisting until changed. These are what let a player command a large fleet without
drowning, and in the vertical slice several of them become far more useful:

| Order | Effect |
|---|---|
| Transit to point | Move to an `(x, depth)` point; queue multiple as a route |
| Hold depth | Maintain a depth while transiting — the default for most movement |
| **Hug the layer** | Maintain a fixed offset below (or above) the nearest layer. Extremely common, tedious by hand, and a strong tactical position. |
| **Follow the bottom** | Maintain a fixed height above the floor of the current passage or chamber. Terrain-hugging transit — quiet, masked, and dangerous. |
| Station-keep on boat X | Hold a relative offset from another boat — the tool for building a screen that covers baffles |
| Patrol between A and B | With optional automatic baffle-clearing reversals |
| Weapons posture | Hold / Fire on my order / Fire at will on a designated track |
| Sonar posture | Passive only / Active on my order / Active every N seconds |
| Emergency | Break contact: quiet speed, dive or run for terrain, turn away, drop decoy |

"Hug the layer" and "Follow the bottom" are the two orders that make the vertical slice
manageable at scale. Both should exist from M4.

## 6. Depth, pressure, crush

- Each hull has `testDepth` (safe) and `crushDepth` (destroyed) — both **horizontal lines the
  player can see** on the display, drawn for the selected boat.
- Between them: escalating hull stress, damage over time, a clear warning, and a continuous
  noise penalty (03 §3). Going too deep to hide is what reveals you.
- Titanium Hull raises both, and on a map whose seabed sits at 1200 m it is what lets a boat
  operate in the deepest, quietest, fastest water. That makes it a genuinely strategic module
  rather than an insurance policy.
- The **surface** is a hard ceiling. Breaching is loud, damaging, and visible at long range.
  No periscope or air mechanics for 1.0.

The map's usable band is therefore bounded by two lines — crush depth below, surface above —
that differ per hull. A titanium-hulled boat has a larger board to play on than its enemy, and
that is legible at a glance.

## 7. Torpedoes

Torpedoes are entities with a guidance controller. They share the acoustic path with everything
else: a seeker is a listener/pinger, so it is detected, decoyed, and blocked by exactly the
rules the boats obey. One code path.

### Lifecycle
1. **Launch** — a loud transient. Tube goes into reload.
2. **Run-out** — travels on a preset course and depth at a preset speed, seeker off. The player
   sets the **enable point**: distance or time before the seeker activates. Enabling early finds
   targets sooner but pings sooner and warns the target; enabling late is stealthier and can
   miss entirely. A genuinely interesting per-shot decision.
3. **Search** — seeker active, snaking within a search cone. In the slice the cone is drawn, so
   "will this cover the depth band he might be in?" is a visible question.
4. **Acquire** — seeker converts a detection into a target and pursues.
5. **Terminal** — closes; proximity or contact fuze.
6. **Expire** — fuel or time exhausted; sinks and is removed. Torpedoes always expire.

Torpedoes have their own `maxPitch`, generally wider than a boat's, so a torpedo can dive at a
target more steeply than a submarine can flee. Super-cavitating torpedoes have a *narrow* pitch
limit and a wide turn radius — extremely fast in a straight line, poor at chasing something that
changes depth. That is their designed counter.

### What exists today — the run-out, the fuze, and a very deaf seeker

`sim/weapons` is built and runs at the full 20 Hz, which is the reason 20 Hz exists (§1). The
lifecycle above collapses to three phases (`match/torpedo.ts`): **running** toward the point the
player clicked, **enabled** past it, and **spent** — a corpse that stays in the world for the four
seconds its detonation rings, because the bang has to come from where the bang was.

The pitch band is implemented here rather than in boat movement, and it is the balance dimension
§5 promises: the clamp is applied to the *demanded* heading rather than to the facing, so a weapon
picks the reachable heading nearest what it wants and reverses through the vertical when it has to,
and a ±12° weapon asked to follow a diving target simply passes underneath it.

What is **not** built, and why:

- **Wire guidance (Q5).** A weapon is committed the moment it leaves the tube.
- **The search cone.** An enabled seeker looks along a ±60° arc and takes the loudest hull it
  hears; there is no snake and no drawn cone.
- **Seekers do not consume the tracker's output**, which step 9 above calls for. Two things stand
  in the way and both are load-bearing: the solve pools vision *per team* (C17), so a torpedo added
  as a listener would hand its whole picture to the side that fired it and delete the sonar drone's
  reason to exist; and fuzing runs at 20 Hz while the solve runs at 10, so a seeker reading a solve
  would act on a picture a tick and a half old at 55 m/s. The seeker is therefore its own thing —
  but built out of the *same acoustic primitives* (`transmissionLoss`, `hullMaterial`,
  `noiseFloorOf`, `returnThreshold`), so a tuning pass on the acoustic table moves it with
  everything else. What it gives up is geodesic range, and it buys that back with an explicit
  line-of-sight test against the rock mask: a weapon cannot hear round a corner, only along one.
- **Decoys and countermeasures**, because the loads that produce them are not deployable (05 §4).

Everything else in this section holds. Rock *is* cover — terrain is tested before hulls, so a
weapon that would have reached a boat through a wall hits the wall. Friendly fire *is* on (Q7),
in the phase rather than in a check a caller could forget: the seeker never asks whose hull it is
hearing, and a burst damages every hull inside its radius including the firer's own.

### Wire guidance
Between launch and enable the torpedo remains under player control: steer it, change its enable
point, shut down its seeker. The wire severs on hard manoeuvres by the firing boat, on excess
range, or on command. This is the answer to "firing on a bearing feels like a coin flip," and
in the slice the wire is drawn as a literal line back to the firing boat (Q5).

### Seeker logic
Reuses the acoustics solve. A passive seeker detects loud things — including your own boats,
including decoys, including a knuckle. **Friendly fire is on** (Q7). A torpedo that reacquires on
a teammate is the player's fault and a memorable, fair way to lose a boat. Mitigated by a clear
warning when a friendly sits inside a torpedo's likely search cone.

### Torpedoes in caves
Torpedoes collide with terrain, which changes weapon play substantially:

- **Rock is cover from torpedoes**, not just from sonar. Getting a wall between you and an
  incoming weapon defeats it outright.
- **Firing down a passage** is a real skill — a waveguide is also a shooting gallery, and a
  torpedo launched along a corridor has nowhere to miss.
- **Wire guidance (Q5) becomes considerably more valuable**, since steering a weapon through a
  bend is otherwise impossible. This strengthens the case for including it at launch.
- Seeker search cones clip against geometry, so a weapon enabled in a chamber searches that
  chamber and not the rock around it.

### Mines in caves
Mines hold a set depth and wait. In a Choke region (14 §4) a handful of mines across the three
passages is a near-total seal — which is powerful, thematically perfect, and a **balance concern
flagged as Q38**. Likely mitigations if it proves oppressive: raise mine cost, cap mines per
fleet, or make them detectable at longer range by active sonar. Do not remove the tactic; it is
one of the best things dense terrain enables.

Stats and costs in [05-content-subs-modules-weapons.md](05-content-subs-modules-weapons.md) §4.

## 8. Damage

**Hit points, not component damage.** Component damage is thematically wonderful and is a large
amount of UI, balance surface, and player confusion. Losing a *boat* is already a big enough
event at this fleet scale.

- Each hull has `maxHp`; Armor raises it.
- Torpedo damage is a flat value with falloff from detonation distance.
- Damage past `hpDamagedThreshold` applies a permanent **noise penalty** and a speed penalty for
  the rest of the match. A damaged boat is a loud boat — easier to hunt, and less able to reach
  the deep water where it would be quiet. Excellent for pacing the back half of a match.
- 0 HP → destroyed. Loud transient; the hull **sinks under gravity** and comes to rest on the
  seabed as a **wreck** entity: a persistent passive reflector and a permanent false-contact
  source at a known location. Battlefields accumulate confusion, and in a side view a sinking
  hull is a genuinely dramatic thing to watch on the scope.
- No repair, no healing. Fixed resources means damage is permanent, which makes every engagement
  consequential.

## 9. Determinism and replays

Per 01 §6. Concretely:

```ts
interface Replay {
  version: number;
  contentHash: string;        // must match to replay
  generatorVersion: number;   // map generation is content — 14 §5
  mapSeed: number;            // the map is regenerated, never stored as geometry
  seed: number;
  setup: MatchSetup;          // map, mode, teams, fleets
  commands: Array<{ tick: Tick; playerId: PlayerId; cmd: PlayerCommand }>;
  resultHash: string;         // checked after replay to detect nondeterminism
}
```

`@seg/tools/replay` runs a replay headlessly and compares `resultHash`. **This runs in CI over a
corpus of recorded matches** (13 §5) and is the primary regression detector for the whole
simulation. A nondeterminism bug caught here is cheap; caught in production it is a mystery.

Replay also feeds the results-screen Reveal (06 §5) and debugging: seek to a tick, dump ground
truth, dump any player's contact picture at that moment.

## 10. Controller interface — designing for future bots

Bots are **out of scope for 1.0** but the seam that makes them possible costs nothing now and is
expensive to retrofit. Step 2 of the loop consumes commands from a `Controller`:

```ts
interface Controller {
  readonly kind: 'remote' | 'scripted' | 'bot';
  /** Called each tick with the player's own view — never ground truth. */
  update(view: PlayerView, tick: Tick): PlayerCommand[];
}
```

The rules that keep this seam honest:
- A `RemoteController` simply drains the network command queue; it is the only one shipping in
  1.0 as a player-facing option.
- A `ScriptedController` exists from M1 for testing (13 §5) and drives `pnpm dev:bots`. It is a
  **test fixture, not a game feature** — it does not ship in the client and is not exposed in
  the lobby.
- **Any controller receives `PlayerView`, not world state.** A future bot must play the same
  half-blind game the humans do. If bots are ever allowed to see ground truth, the entire
  acoustic design becomes untestable against them and they will not be fun to play against. This
  is the constraint worth enforcing now, by making the signature literally unable to express it.
- The lobby's player-slot model reserves room for a non-human occupant (07 §4) so adding bot
  slots later is a UI change, not a data-model change.

Nothing else about bots is designed here. The point is only that adding them later should not
require touching the simulation.

## 11. Stats collection

Accumulated in step 12 and emitted with `MatchResult`. Per boat and per player:

- Distance travelled; time at each throttle notch; time spent cavitating
- Time above/below each layer; max depth reached; time spent below test depth
- Torpedoes fired, hit, missed, expired, decoyed; wire corrections made
- Damage dealt, damage taken, kills, assists, deaths
- Active pings emitted; total time emitting
- **Time spent detected by the enemy** — the server knows this and no client could compute it
- Time spent holding a firing solution
- Contacts held; peak simultaneous tracks
- Objective capture time contributed

"Time spent detected by the enemy" is the standout stat for this game — it is the numeric
expression of pillar P1 and gets the headline treatment on the results screen (06 §5).
=======
# 04 — Simulation Core

## 1. The loop

The simulation runs at **20 Hz** (`dt = 0.05 s`). The acoustic and view phases run at **10 Hz**
— every second tick — because detection state does not change meaningfully in 50 ms and
acoustics is the expensive phase (03 §10). Movement, collision, and weapons get the full 20 Hz.

```
tick(dt = 0.05s):                                   [every tick — 20 Hz]
  1. drain command queue          → apply orders to controllers (validated, authorized)
  2. controller step              → standing orders → throttle/pitch/depth demands
  3. kinematics integrate         → position, facing, speed
  4. terrain & collision          → seabed, terrain polygons, surface, crush
  5. weapons kinematics           → torpedo movement, fuzing, detonation, damage

  if (tick % 2 === 0):                              [every other tick — 10 Hz]
  6. acoustics: emit              → sourceLevelOf per entity (03 §3)
  7. acoustics: propagate/detect  → per-team vision solve (03 §4–5); wavefronts not built yet
  8. tracker update               → detections → contacts, association, staleness
  9. seeker update                → torpedo seekers consume the same detection output
 10. objectives & scoring         → capture progress, win conditions
 11. view generation              → per-player ViewDelta from that player's picture
 12. stats accumulation
```

Order matters. Acoustics run **after** movement so contacts reflect this tick's positions, and
seekers run **after** the tracker so torpedo guidance uses the same detection machinery as
boats — one code path, consistent rules.

**Status of the loop.** The `SIM_TICK_HZ = 20` / `ACOUSTIC_TICK_HZ = 10` constants exist in
`@seg/shared`, the acoustic phase is implemented and tested (`sim/acoustics`), and the loop itself
runs: the runtime's `tick()` advances the clock, maps `stepBoat(boat, SIM_TICK_SECONDS)` over the
boats every tick (§5, `match/movement.ts`), and solves acoustics on every second tick
(`packages/server/src/match/runtime.ts`). Steps 8–10 (tracker, seeker, objectives) are design
until their layers land (03 §7).

Fixed `dt`, always. If a tick overruns, log and continue; never accumulate and double-step
(01 §7).

**Why 20 Hz and not 10.** Torpedo terminal geometry is the binding constraint. A 55 m/s
super-cavitating torpedo covers 5.5 m per tick at 20 Hz but 11 m at 10 Hz — comparable to a
hull's own width, which risks tunnelling and makes proximity fuzing coarse. 20 Hz also makes
close-quarters collision and terrain contact behave properly. The cost is bounded because the
expensive phase stays at 10 Hz.

## 2. The world is a vertical slice

**`x` is horizontal distance. `y` is depth, positive downward.** There is no third dimension —
not a hidden one, not a scalar one. The simulation plane and the display plane are the same
plane, at the same scale, in the same orientation.

Everything that follows depends on this, and it is worth stating what it buys:

- **Depth is a spatial axis, so depth mechanics are geometry.** The thermocline is a line
  segment. Crush depth is a line. A shadow zone behind a seamount is a polygon. All three are
  drawable, clickable, and immediately legible (03 §4).
- **Diving is movement, not a separate system.** There is no `depthRate` stat and no parallel
  depth-change integrator — a boat descends by pointing down and moving. This removes an entire
  subsystem and makes the speed/stealth/depth trade emergent rather than authored (§5).
- **Acoustic range is geodesic, not straight-line.** Propagation follows the water lattice, so
  "range" is the shortest path *through water* around rock, not `√(dx² + dy²)` (03 §4).
- **Terrain masking is the water lattice**, not raycasts: every water cell knows whether sound can
  reach it, and every surface square bins under the cell that can hear it (03 §5.2).
- **Silhouettes are side profiles**, which are far more recognizable than plan views and serve
  as the reflection geometry for the vision picture and as fleet-builder artwork. The collision
  shape is separate (03 §6).

Camera and boats translate in `x` and `y` only. The camera never rotates (Q13).

### What it costs
There is no lateral dimension, so there is no flanking *around* an enemy — only above, below,
ahead, and behind. Encirclement is replaced by **vertical envelopment**, and the tactical
vocabulary is closer to a 2D fighting game's spacing than to an RTS's map control.

This was the plan's biggest open worry (risk R9). **Dense cave terrain (14) is the answer.** With
three or more traversable routes guaranteed at every `x`, each with different clearance, exposure,
and acoustic character, there is no single line to push along — flanking becomes "take the lower
warren while he watches the column," which is real positional play in a form specific to this
geometry. Confirm in the M1 harness, then downgrade R9.

## 3. World and terrain

| Property | Value |
|---|---|
| Map width (base) | 8000 m, scaled by map size — small/medium/large 0.7×/1×/1.5× (14 §1) |
| Map height (base) | 3000 m, scaled the same way |
| Map depth | 1000 m on every map size; `depthScale = 1000 / height` maps Y to game depth |
| Coordinate origin | Seabed at `y = 0`; surface at `y = height`; frame is y-up (depth counts down from the surface) |
| Surface | `y = height`. A hard boundary; breaching is loud and damaging. |
| Terrain | A dense procedurally-generated cave system filling the volume (14) |
| Layer(s) | One to three horizontal thermoclines (03 §4) — **not yet built** |

**Maps are procedurally generated cave systems, not authored levels.** Terrain is dense: chambers,
passages, and open columns stacked through the full depth, with a guarantee of at least three
traversable routes at every `x`. Full specification in [14-map-generation.md](14-map-generation.md).

**Terrain representation** — the generator emits one structure that four consumers share:

| Artifact | Consumed by |
|---|---|
| Simplified contour polygons | Rendering (static geometry buffer), collision |
| **Water lattice** + 1 m reflector **skin** | Acoustics (03 §5.2) |
| Per-hull filtered **navmesh** | Pathfinding (§5.1) |

The sharing is deliberate and it is what makes dense terrain affordable. The water lattice — the
rasterized terrain plus a *nearest-water* index for every rock cell — is computed once at match
start and answers "can sound get here" for every entity per tick at linear cost; the skin binds
each surface square to the lattice cell that can hear it, so the same data answers "what do I
draw" without any per-frame geometry search. The convex-decomposition/portal structure the plan
called for (03 §5.2) was replaced by this during implementation.

**Terrain is the dominant system in the game now.** It decides most detections (03 §4), constrains
which hulls can go where (§5.1, 05 §2), and occupies most of the screen (08 §3). It is no longer a
modifier on open-water play — open water is the special case.

## 4. Entities

One entity model, discriminated by kind. Everything that can move, make noise, or be detected is
an entity — this uniformity is what lets torpedoes, drones, and boats share the acoustic and
tracker code.

```ts
interface Entity {
  id: EntityId;
  kind: 'submarine' | 'torpedo' | 'drone' | 'mine' | 'decoy' | 'objective' | 'wreck';
  team: TeamId | null;
  owner: PlayerId | null;
  pos: Vec2;               // x = horizontal, y = depth (positive down)
  facing: number;          // degrees in the slice; 0 = +x, positive = up-and-right
  speed: number;           // m/s along `facing`, always ≥ 0
  // kind-specific state in a tagged union
}
```

`facing` replaces the top-down design's `heading`, and `depth` is simply `pos.y`. There is no
separate depth state.

**No reverse.** Minimum speed is 0; boats cannot back up. A boat that has to go back the way it
came stops and flips (§5), then drives forward.

## 5. Submarine movement

Order-driven, not directly piloted. The player sets *demands*; the boat obeys them within its
physical limits.

### Facing is pitch-constrained
A boat's `facing` is confined to a band around horizontal, on whichever side it is travelling:

```
facing ∈ [−maxPitch, +maxPitch]  (travelling right)
   or  [180−maxPitch, 180+maxPitch]  (travelling left)
```

`maxPitch` is a hull stat, roughly **25–35°**. Submarines do not point straight down, and the
constraint keeps boats reading as submarines rather than as aircraft. Reversing direction
(right ↔ left) is not a turn through that band's far side — it is a **flip**, taken at a stop.
See "Reversing is a flip" below.

### Integration
```
speed  += clamp(targetSpeed − speed, −decel·dt, accel·dt)
turnRate = maxTurnRate · turnEfficiency(speed)
facing  += clamp(angleTo(targetFacing), −turnRate·dt, turnRate·dt)   // clamped to the pitch band
pos     += facingVector(facing) · speed · dt
pos.y   += ballastRate · dt                                          // slow, low-speed only
```

**Descent rate is `speed · sin(pitch)` and nothing else.** At 15 m/s with 30° of down-angle a
boat descends at 7.5 m/s; at creep it descends at 1.5 m/s. This single line generates the
game's central trade with no additional design:

> **Changing depth quickly requires going fast. Going fast makes you loud. So depth changes
> are expensive exactly when you most want one — while breaking contact.**

`turnEfficiency` peaks at moderate speed: a stopped boat cannot pitch, a flank-speed boat turns
wide.

**Ballast** provides a slow vertical rate (±0.5 m/s) available at low or zero speed, so an
all-stopped boat is not frozen in depth and can hover or settle. Using it aggressively
("emergency blow") is a loud transient (03 §3).

### Turn rates are slow
Turn rate governs *pitching* — how fast a boat gets a down-angle on, and how wide it swings onto
a new bearing — and it is deliberately slow (1.7–3.8°/s). That slowness is a primary control on
pacing and much of why the game reads as an RTS rather than a shooter. It no longer governs
reversals; those are the flip.

### Reversing is a flip, not a turn
**Built** (`stepBoat`). Rotating right ↔ left means passing through the vertical, and at these
turn rates that is the better part of a minute spent pointing at the seabed. So a boat asked to
make a bearing that is **abaft the beam** *and* **on the other side of it horizontally** does not
rotate. It brakes, and mirrors the instant speed reaches zero: `facing → 180 − facing`, the same
pitch on the other side. While the way comes off it pitches onto the *mirror* of the bearing it
wants, so the flip lands on that bearing rather than beside it.

Both halves of the trigger are load-bearing. Abaft the beam alone would flip a boat doubling back
*on its own side* — down and behind — where the mirrored bearing points across the water instead
of at the point. The other side alone would flip a steeply pitched boat that only has to nose
across the vertical, a few degrees of turn it can make without giving up a knot.

The picture already worked this way: a left-travelling boat is drawn as the mirror of a
right-travelling one, never rotated through upside-down (09 §11). This is the model agreeing with
the drawing. Two consequences to be deliberate about:

- **A boat can turn around inside a passage.** It needs no room to swing, only the time to stop.
  Entering a corridor is no longer a decision you live with until it opens out — route choice and
  passage ambushes lose some of the weight the slow-reversal design gave them. That is the price
  paid for a direction change that is readable and cheap to order.
- **The reversal is not yet noisy.** Braking to a stop and flipping currently costs nothing
  acoustically, so it is a free way out of a bad bearing. The price is already written down and
  unclaimed — the `hard-turn` knuckle, +10 dB over 4 s (03 §3, `content/acoustics.ts#TRANSIENTS`)
  — and nothing fires it. Firing it on the flip is the obvious next move, and the one that keeps
  a reversal a decision rather than a reflex.

### What exists today — a straight-line transit

The base movement order is built and runs every tick, and it is deliberately the simplest thing
that could work: `stepBoat` (`@seg/shared/match/movement.ts`) accelerates a boat toward its
throttle notch's speed (08 §5), steers toward the first waypoint at the hull's constant
`turnRate` — so a boat curves toward its heading rather than snapping about — pops a waypoint when
it gets there, and drops to `hold` with speed 0 when the queue empties. A waypoint that would need
a reversal is the one exception to "steers toward": the boat brakes and flips instead (above), on
every leg, including an intermediate one.

Slow turn rates have one consequence the transit does handle. A boat that reaches a waypoint fast
and off-bearing has that waypoint *inside* its turning circle (`r = v/ω`, half a kilometre for a
Heavy at flank), so it sweeps past, comes round, and misses again — it orbits. `maxApproachSpeed`
is the geometric answer: the point is inside the circle exactly when `distance < 2·r·sin θ`, and
inverting for `v` gives the fastest speed that still reaches it. The **last** waypoint caps the
throttle notch at that speed — the boat slows into the turn and winds back up as it steadies on —
while an **intermediate** one is counted as made good the moment it falls inside the circle, the
next leg taking over: a route hint is not worth crawling for. The design above is what remains:

- **No depth kinematics.** A waypoint is an `(x, depth)` position and arrival lands on both, but
  the run between them is a straight shot along `facing` — there is no pitch band, no
  `descentRate = speed·sin(pitch)`, and no ballast. A diagonal order is a diagonal run, not a
  dive; "diving is movement" (§2) stays the design, not the build.
- **No `turnEfficiency` curve.** Turn rate is a constant; a stopped boat and a flank-speed boat
  steer identically.
- **No terrain.** Routes are straight lines through whatever geometry they cross — boats do not
  collide with rock yet (Q39) and nothing stops them being ordered across a wall (§5.1).
- **Acceleration is a game number, not a physics one** (`MOVEMENT_ACCELERATION = 10 m/s²`): a
  boat reaches flank from a standstill in about two seconds. The real physics — minutes to gain a
  couple of knots — is traded here for gameplay pacing.

### 5.1 Navigation through caves

Boats path through a cave system, which open water did not require.

**Status: not built.** There is no navmesh (14 §5) and no pathfinding — an order is a straight
line of waypoints through whatever geometry it crosses, "no route" cannot be refused because
routes are never evaluated against terrain, and boats do not yet collide with rock (Q39).
Pathfinding, per-hull clearance, the no-route refusal, and the grazing threshold land together,
once collision exists to fail against.

- **Clearance.** Every hull has a `clearanceRadius` derived from its silhouette. The navmesh is
  filtered per hull: a Heavy's traversable graph is the subgraph of sectors and portals that admit
  it. A Scout's is nearly the whole map. This is what turns hull size into a **strategic**
  property rather than just a stealth and durability stat (05 §2).
- **Pathfinding** is A\* over the filtered graph, then string-pulled into a smooth route, then
  validated against the pitch band — a route demanding a 60° climb is invalid for a boat limited
  to 30° and must be re-planned or refused.
- **Runs on order issue and replan, never per tick.** Pathfinding is not in the tick budget.
- **"No route" must be a first-class, visible outcome.** If a selected hull cannot reach the
  ordered point, the UI refuses the order and says why — "no route: passages too narrow for this
  hull" (08 §5). Silent failure or a boat that swims into a wall and stops would be maddening,
  and with per-hull clearance this case is common, not exotic.
- **"Follow the bottom"** is re-specified for caves: follow the floor of the current passage at a
  fixed offset. Still the quiet, masked, dangerous transit order.
- **Terrain collision** is now a routine hazard rather than a rare punishment, so it needs a
  grazing threshold: brushing a wall at creep should be harmless, hitting one at flank should not
  (Q39).

### Standing orders
Per boat, persisting until changed. These are what let a player command a large fleet without
drowning, and in the vertical slice several of them become far more useful:

| Order | Effect |
|---|---|
| Transit to point | Move to an `(x, depth)` point; queue multiple as a route |
| Hold depth | Maintain a depth while transiting — the default for most movement |
| **Hug the layer** | Maintain a fixed offset below (or above) the nearest layer. Extremely common, tedious by hand, and a strong tactical position. |
| **Follow the bottom** | Maintain a fixed height above the floor of the current passage or chamber. Terrain-hugging transit — quiet, masked, and dangerous. |
| Station-keep on boat X | Hold a relative offset from another boat — the tool for building a screen that covers baffles |
| Patrol between A and B | With optional automatic baffle-clearing reversals |
| Weapons posture | Hold / Fire on my order / Fire at will on a designated track |
| Sonar posture | Passive only / Active on my order / Active every N seconds |
| Emergency | Break contact: quiet speed, dive or run for terrain, turn away, drop decoy |

"Hug the layer" and "Follow the bottom" are the two orders that make the vertical slice
manageable at scale. Both should exist from M4.

## 6. Depth, pressure, crush

- Each hull has `testDepth` (safe) and `crushDepth` (destroyed) — both **horizontal lines the
  player can see** on the display, drawn for the selected boat.
- Between them: escalating hull stress, damage over time, a clear warning, and a continuous
  noise penalty (03 §3). Going too deep to hide is what reveals you.
- Titanium Hull raises both, and on a map whose seabed sits at 1000 m it is what lets a boat
  operate in the deepest, quietest, fastest water. That makes it a genuinely strategic module
  rather than an insurance policy.
- The **surface** is a hard ceiling. Breaching is loud, damaging, and visible at long range.
  No periscope or air mechanics for 1.0.

The map's usable band is therefore bounded by two lines — crush depth below, surface above —
that differ per hull. A titanium-hulled boat has a larger board to play on than its enemy, and
that is legible at a glance.

## 7. Torpedoes

Torpedoes are entities with a guidance controller. They share the acoustic path with everything
else: a seeker is a listener/pinger, so it is detected, decoyed, and blocked by exactly the
rules the boats obey. One code path.

### Lifecycle
1. **Launch** — a loud transient. Tube goes into reload.
2. **Run-out** — travels on a preset course and depth at a preset speed, seeker off. The player
   sets the **enable point**: distance or time before the seeker activates. Enabling early finds
   targets sooner but pings sooner and warns the target; enabling late is stealthier and can
   miss entirely. A genuinely interesting per-shot decision.
3. **Search** — seeker active, snaking within a search cone. In the slice the cone is drawn, so
   "will this cover the depth band he might be in?" is a visible question.
4. **Acquire** — seeker converts a detection into a target and pursues.
5. **Terminal** — closes; proximity or contact fuze.
6. **Expire** — fuel or time exhausted; sinks and is removed. Torpedoes always expire.

Torpedoes have their own `maxPitch`, generally wider than a boat's, so a torpedo can dive at a
target more steeply than a submarine can flee. Super-cavitating torpedoes have a *narrow* pitch
limit and a wide turn radius — extremely fast in a straight line, poor at chasing something that
changes depth. That is their designed counter.

### Wire guidance
Between launch and enable the torpedo remains under player control: steer it, change its enable
point, shut down its seeker. The wire severs on hard manoeuvres by the firing boat, on excess
range, or on command. This is the answer to "firing on a bearing feels like a coin flip," and
in the slice the wire is drawn as a literal line back to the firing boat (Q5).

### Seeker logic
Reuses the acoustics solve. A passive seeker detects loud things — including your own boats,
including decoys, including a knuckle. **Friendly fire is on** (Q7). A torpedo that reacquires on
a teammate is the player's fault and a memorable, fair way to lose a boat. Mitigated by a clear
warning when a friendly sits inside a torpedo's likely search cone.

### Torpedoes in caves
Torpedoes collide with terrain, which changes weapon play substantially:

- **Rock is cover from torpedoes**, not just from sonar. Getting a wall between you and an
  incoming weapon defeats it outright.
- **Firing down a passage** is a real skill — a waveguide is also a shooting gallery, and a
  torpedo launched along a corridor has nowhere to miss.
- **Wire guidance (Q5) becomes considerably more valuable**, since steering a weapon through a
  bend is otherwise impossible. This strengthens the case for including it at launch.
- Seeker search cones clip against geometry, so a weapon enabled in a chamber searches that
  chamber and not the rock around it.

### Mines in caves
Mines hold a set depth and wait. In a Choke region (14 §4) a handful of mines across the three
passages is a near-total seal — which is powerful, thematically perfect, and a **balance concern
flagged as Q38**. Likely mitigations if it proves oppressive: raise mine cost, cap mines per
fleet, or make them detectable at longer range by active sonar. Do not remove the tactic; it is
one of the best things dense terrain enables.

Stats and costs in [05-content-subs-modules-weapons.md](05-content-subs-modules-weapons.md) §4.

## 8. Damage

**Hit points, not component damage.** Component damage is thematically wonderful and is a large
amount of UI, balance surface, and player confusion. Losing a *boat* is already a big enough
event at this fleet scale.

- Each hull has `maxHp`; Armor raises it.
- Torpedo damage is a flat value with falloff from detonation distance.
- Damage past `hpDamagedThreshold` applies a permanent **noise penalty** and a speed penalty for
  the rest of the match. A damaged boat is a loud boat — easier to hunt, and less able to reach
  the deep water where it would be quiet. Excellent for pacing the back half of a match.
- 0 HP → destroyed. Loud transient; the hull **sinks under gravity** and comes to rest on the
  seabed as a **wreck** entity: a persistent passive reflector and a permanent false-contact
  source at a known location. Battlefields accumulate confusion, and in a side view a sinking
  hull is a genuinely dramatic thing to watch on the scope.
- No repair, no healing. Fixed resources means damage is permanent, which makes every engagement
  consequential.

## 9. Determinism and replays

Per 01 §6. Concretely:

```ts
interface Replay {
  version: number;
  contentHash: string;        // must match to replay
  generatorVersion: number;   // map generation is content — 14 §5
  mapSeed: number;            // the map is regenerated, never stored as geometry
  seed: number;
  setup: MatchSetup;          // map, mode, teams, fleets
  commands: Array<{ tick: Tick; playerId: PlayerId; cmd: PlayerCommand }>;
  resultHash: string;         // checked after replay to detect nondeterminism
}
```

`@seg/tools/replay` runs a replay headlessly and compares `resultHash`. **This runs in CI over a
corpus of recorded matches** (13 §5) and is the primary regression detector for the whole
simulation. A nondeterminism bug caught here is cheap; caught in production it is a mystery.

Replay also feeds the results-screen Reveal (06 §5) and debugging: seek to a tick, dump ground
truth, dump any player's contact picture at that moment.

## 10. Controller interface — designing for future bots

Bots are **out of scope for 1.0** but the seam that makes them possible costs nothing now and is
expensive to retrofit. Step 2 of the loop consumes commands from a `Controller`:

```ts
interface Controller {
  readonly kind: 'remote' | 'scripted' | 'bot';
  /** Called each tick with the player's own view — never ground truth. */
  update(view: PlayerView, tick: Tick): PlayerCommand[];
}
```

The rules that keep this seam honest:
- A `RemoteController` simply drains the network command queue; it is the only one shipping in
  1.0 as a player-facing option.
- A `ScriptedController` exists from M1 for testing (13 §5) and drives `pnpm dev:bots`. It is a
  **test fixture, not a game feature** — it does not ship in the client and is not exposed in
  the lobby.
- **Any controller receives `PlayerView`, not world state.** A future bot must play the same
  half-blind game the humans do. If bots are ever allowed to see ground truth, the entire
  acoustic design becomes untestable against them and they will not be fun to play against. This
  is the constraint worth enforcing now, by making the signature literally unable to express it.
- The lobby's player-slot model reserves room for a non-human occupant (07 §4) so adding bot
  slots later is a UI change, not a data-model change.

Nothing else about bots is designed here. The point is only that adding them later should not
require touching the simulation.

## 11. Stats collection

Accumulated in step 12 and emitted with `MatchResult`. Per boat and per player:

- Distance travelled; time at each throttle notch; time spent cavitating
- Time above/below each layer; max depth reached; time spent below test depth
- Torpedoes fired, hit, missed, expired, decoyed; wire corrections made
- Damage dealt, damage taken, kills, assists, deaths
- Active pings emitted; total time emitting
- **Time spent detected by the enemy** — the server knows this and no client could compute it
- Time spent holding a firing solution
- Contacts held; peak simultaneous tracks
- Objective capture time contributed

"Time spent detected by the enemy" is the standout stat for this game — it is the numeric
expression of pillar P1 and gets the headline treatment on the results screen (06 §5).
>>>>>>> f163c1b5fa7ecce8254a6c2e092e9f56109427be
