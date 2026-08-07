# 03 — Sonar Model

This is the core mechanic and the primary product risk. It is modelled for **legibility and
tension**, not accuracy. Where a real-acoustics behaviour would be unreadable on screen, it
gets simplified or cut.

**The world is a vertical slice** (see 04 §2): `x` is horizontal distance, `y` is depth. Every
acoustic quantity below is computed in that plane, and every acoustic quantity is directly
drawable on the player's display. That equivalence — *the sim plane is the screen plane* — is
the biggest single advantage of the vertical-slice choice and this document leans on it
throughout.

## 1. The one-sentence model

Every entity emits sound; sound weakens with distance and with crossing a thermocline;
a listener detects a source when the received level beats the listener's noise floor by its
detection threshold; passive detection yields **bearing only**, active detection yields
**bearing and range** at the cost of announcing yourself to the entire ocean.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Source Level (SL)** | How loud an entity is, dB-arb. Sum of machinery, flow, cavitation, transients. |
| **Transmission Loss (TL)** | dB lost between source and receiver. Function of range, layer crossings, terrain. |
| **Noise Floor (NF)** | Ambient ocean noise + the listener's own self-noise (which rises with the listener's own speed). |
| **Array Gain (AG)** | Listener's sensor quality bonus, from hull class + sensor modules. |
| **Detection Threshold (DT)** | Signal excess required to call it a detection. |
| **Signal Excess (SE)** | `SL − TL − NF + AG`. If `SE ≥ DT`, detected. `SE` above threshold drives *quality*. |
| **Target Strength (TS)** | How well a hull reflects an active ping. Function of size and aspect angle. |
| **Contact** | A listener's *belief* about a source. Has a track id, bearing history, quality, staleness. Not the same object as the entity. |
| **Echo return** | A single active-sonar reflection point with a position and a timestamp. What draws the outlines. |
| **Baffles** | The blind arc astern of a boat, masked by its own propulsion. |
| **Layer** | A thermocline: a horizontal band in the slice. Crossing it costs a large TL penalty. |
| **Bearing** | An angle **in the vertical plane**, 0° = due right (+x), measured counter-clockwise. A contact at 30° is up and to the right; at −30°, down and to the right. |

### A note on "bearing" in a vertical slice
In a top-down game, bearing is a compass direction. Here it is an angle in the x/depth plane,
which means **a bearing line carries depth information implicitly**. A contact at −40° from a
boat at 200 m is deep. This is a genuine gain over the top-down design, where contact depth was
an open problem (there is no longer a Q4 — depth falls out of the bearing for free).

Player-facing terminology should avoid "bearing 040" naval phrasing, which implies compass
directions. Use **relative angle plus a depth sense**: "contact up-right, 30 degrees" or simply
the visual wedge with no numbers at all. The display does this better than words can.

## 3. Noise generation (the emit side)

Every entity computes a **source level** each sim tick.

```
SL = SL_base
   + f_speed(speed, hullMaxSpeed)
   + f_cavitation(speed, depth)
   + Σ transients
   + activePingLevel (if pinging this tick)
   − Σ silencingModifiers
```

### Speed contribution
The dominant term and the main lever the player pulls. Non-linear so that "creep" is genuinely
stealthy and "flank" is genuinely suicidal:

```
f_speed = k_flow · (speed / hullMaxSpeed)^2 · SL_speedSpan
```

### Cavitation — the cliff
Below a depth-dependent speed threshold, propellers do not cavitate. Above it, they do, and you
become extremely loud. This is the single most important number a player tracks.

```
cavitationSpeed(depth) = base_cavSpeed · (1 + depth / cavDepthScale)
```

Deeper water = higher pressure = you can go faster before cavitating. In a vertical slice this
is no longer an abstract stat relationship — it is a **visible curve on the display**. The
cavitation-limited speed can be drawn as a shaded region, so a player literally sees that going
faster requires going lower on the screen.

Crossing the threshold adds a flat `+18 dB` [placeholder] plus a rising term. It is a cliff,
not a slope, and the UI shows the threshold explicitly on the speed control (08 §5).

**The core geometric trade this creates:** the fast, quiet water is deep — and the deep water
is also where the seabed and crush depth are (04 §6). Speed, stealth, and survival pull the
player down; the objectives, the surface, and safety pull them up. The player is squeezed
between two lines on screen, and that squeeze is the game.

### Transients
One-shot noise events, decaying over a few seconds. Loud, brief, and *identifiable* — a
transient tells a listener something happened, not merely that something exists.

| Event | Level | Notes |
|---|---|---|
| Torpedo launch | +25 dB, 2 s | Classifiable as a launch with the right module |
| Hard pitch change / emergency blow | +12 dB, 4 s | Fast depth changes are loud; slow ones are not |
| Hard turn (reversal) | +10 dB, 4 s | "Knuckle" — see §8 |
| Hull damage | +20 dB, 5 s | Getting hit gives away that you were hit |
| Hull stress below test depth | +6 dB, continuous | Groaning hull — going too deep to hide is what reveals you |
| Bottoming / terrain collision | +30 dB, 6 s | Punishment for careless piloting |
| Surface breach | +22 dB, 4 s | Broaching is a catastrophe, not a tactic |

### Active ping
An omnidirectional, very loud pulse. Everything that can hear gets a strong bearing on you, at
long range, immediately. The tactical grammar: you ping when you already know you are detected,
when you need range *right now* for a firing solution, or when you are deliberately baiting.

Ping strength, rate, and ray count are module-modifiable. "Powerful Active Sonar" trades a
bigger detection radius for a bigger self-broadcast radius — at map scale (§9) a strong ping is
audible across the **entire map**, so pinging is always a map-wide announcement.

## 4. Propagation (the transmission side)

### Transmission loss
```
TL = spreading(pathLength, confinement)          // 15·log10 open, ~10·log10 inside a passage
   + absorptionCoefficient · pathLength
   + Σ layerPenalty(each layer crossed by the path)
   + diffractionPenalty · bends                  // ~4–6 dB per portal transition [placeholder]
   + apertureLoss(minClearance along the path)
```

**`pathLength` is the shortest free-space path, not the straight-line distance.** Maps are dense
cave systems (14), so sound travels through chambers and passages rather than through rock. Where
there is unobstructed line of sight the path *is* the straight line and this reduces to the simple
case; elsewhere it bends through openings.

This is computed by lookup, not by raycasting — see §5.1. Getting this right is what makes dense
terrain affordable, and it is the single most important performance decision in the project.

Deliberately omitted: convergence zones, bottom bounce, surface ducts, frequency-dependent
absorption, full ray tracing. **Note that a vertical slice makes ray paths drawable**, so these
become far more tractable than they would have been top-down. Convergence zones and surface
ducts are the most attractive post-1.0 additions in the whole design — but they are post-1.0.

### Layers — the horizontal lines that structure the map
Each map defines one or two **thermoclines** at fixed depths. A segment between source and
receiver that crosses a layer takes `+20 dB` [placeholder]. That is enormous — it typically
converts "clearly detected" into "nothing at all."

In a vertical slice this is transformed from an abstract rule into **map geometry**:

- The layer is a horizontal line drawn across the display. Its meaning is obvious on sight.
- Whether you are above or below it is a glance, not a calculation.
- Crossing it is a visible, committed movement — the enemy who is watching a bearing sees you
  cross, and you know they might.
- A boat sitting *just* below the layer is hidden from everything above, and the display makes
  that position — hugging a line — immediately legible as a tactic.
- With **two** layers, the map has three acoustic strata and a boat can be hidden from both the
  surface layer and the deep. Recommend one layer for the launch maps and one two-layer map as
  the "advanced" map.

The penalty is smoothed over a ±20 m band so the boundary is not knife-edged, and the layer
depth is **known** to everyone and permanently drawn.

### Terrain — the dominant acoustic factor

Maps are dense procedurally-generated cave systems (14), so terrain is not a modifier on open-
water acoustics; it is the thing that decides most detections. Hiding behind rock is literally
hiding behind a shape on screen, and "get a wall between us" is the most reliable escape in the
game.

Three behaviours fall out of the model above, and together they are the map's tactical texture:

**Passages are waveguides.** Inside a corridor narrower than a clearance threshold, sound spreads
cylindrically rather than spherically — the `confinement` term in `spreading()`. It carries far
along the passage while being blocked laterally. **A boat in a slot is invisible to everything
off-axis and loud to anything at either end.** The passage does not hide you; it aims you. This
is why only small, quiet hulls can use tight terrain safely.

**Open columns are terrifying.** No bends, no aperture loss, no occlusion — a cavitating boat in
an open column is audible across the entire region. The contrast between column and warren is the
primary reason to care where you are on the map.

**Bearings point at cave mouths.** See §5.1 — the most consequential single mechanic in this
document.

## 5. Detection (the receive side)

Per listening entity, per candidate source, per acoustic tick:

```
SE = SL − TL − NF_total + AG + arrayFactor(relativeBearing)
```

### 5.1 Apparent bearing — sound arrives through openings

When the path from source to listener bends through a passage, **the listener's bearing is toward
the opening the sound came through, not toward the source.** A boat two chambers away appears to
be sitting in a passage mouth.

This is not a simplification or a fudge — it is what the sensor genuinely measures, and it is the
richest mechanic the cave terrain produces:

- **Terrain knowledge becomes a skill.** A good player reads "bearing to that aperture" and infers
  "therefore it is somewhere in the volume beyond it." A new player chases a ghost sitting in a
  hole in the wall.
- **Triangulation gets harder and more interesting.** Two boats hearing the same source through
  *different* portals produce wedges that cross at a point where nothing is. The player must
  recognize the situation and reason about it rather than trusting the crossing. The TMA tool has
  to surface this honestly (08 §4) — showing which portal each bearing came through is the
  difference between a fair puzzle and a bug report.
- **It gives tight terrain a defensive value beyond attenuation.** Being heard is survivable when
  what they hear is a doorway forty degrees off your actual position.

Implementation: the propagation lookup returns `firstPortal` alongside `pathLength`; the detection
records the bearing to that portal's centre, with bearing uncertainty widened by the portal's
angular size. A wide opening gives a vague direction; a narrow slot gives a precise bearing to a
place the target is not.

### 5.2 The propagation lookup

Occlusion is resolved by a **precomputed sector/portal table**, not by raycasting. At match start
the generator's convex sector decomposition (14 §5) is used to run Dijkstra from every sector,
producing for each ordered pair: `pathLength`, `bends`, `firstPortal`, and `minClearance`.

With 200–600 sectors this costs well under a second once, and makes every subsequent acoustic
query an **O(1) table lookup**. Dense cave terrain therefore ends up *cheaper* than raycasting
against a handful of seamounts would have been — the complexity is paid once, at generation, and
never in the tick loop.

Within a sector, and between sectors sharing direct line of sight, the true straight-line distance
is used so short-range engagements stay exact. The table is an approximation only across bends,
which is where precision matters least and legibility matters most.

### Self-noise — why you slow down to listen
```
NF_total = 10·log10( 10^(ambient/10) + 10^(selfNoise(ownSpeed)/10) )
```
Your own speed deafens you. A boat at flank is both maximally loud and maximally deaf. This is
the second half of the speed trade and it is what makes "all stop and listen" a real move.

### The baffles
`arrayFactor` is a large negative value in a rear arc (default ±30° off the stern, hull- and
module-modifiable). In a vertical slice the baffle cone is drawn behind the boat and points
along its actual facing — a diving boat's blind arc points up and behind it, which is visible
and exploitable. Consequences:

- Approaching from astern is genuinely stealthy → tailing gameplay works.
- A single boat cannot cover everything; fleets must be arranged so boats cover each other's
  baffles. **This is the primary reason to command more than one boat**, and it is now
  *visually obvious* — the player can see the dead cones on screen and see the gaps between
  them. Teaching this is dramatically easier than it would have been top-down.
- "Clearing baffles" — a periodic turn to sweep the blind arc — becomes a habit good players
  form on their own. Reward it; do not automate it.

### Detection thresholds and contact quality
`SE ≥ DT` → detected. Quality is a normalized function of the margin:

```
quality = clamp01( (SE − DT) / qualitySpan )
```

Quality drives everything the player is told:

| Quality | Bearing error (σ) | What the player learns |
|---|---|---|
| 0.0 – 0.2 | ±8° | "Something is out there, roughly that way." Unclassified. |
| 0.2 – 0.5 | ±3° | Stable bearing. Rough size class (small/medium/large). |
| 0.5 – 0.8 | ±1.2° | Hull class guess. Speed estimate from noise character. Cavitating y/n. |
| 0.8 – 1.0 | ±0.4° | Confident classification. Estimated speed and aspect. |

Bearing error is **stable per contact over a short window**, not re-rolled every tick.
Re-rolling produces a jittering wedge that reads as UI noise; a slowly wandering error reads as
a real sensor. Implementation: per-track smoothed noise seeded from the track id, so it is
deterministic and replayable.

Classification is deliberately fallible. A quiet large hull at creep can be misclassified as a
small hull. **The lie must be consistent** — the same wrong answer every tick, resolving only
as quality improves. Inconsistent lies read as a bug; consistent lies read as a hard problem.

## 6. Active sonar and echo outlines — the signature visual

This is the mechanic that produces the game's look, so it is specified concretely.

### Hull geometry — now a side profile
Every hull has a **2D side-profile silhouette polygon** (10–20 vertices) defined in the content
tables alongside its stats. This polygon is simultaneously:
- the shape the sonar returns trace on the scope,
- the shape drawn in the fleet builder's technical-drawing view (09 §9),
- the collision shape.

A submarine seen from the side is **far more recognizable than one seen from above** — sail
position and height, hull taper, bow shape, stern planes. Silhouette recognition is a real skill
the game rewards, and the vertical slice makes it a much better skill than it would have been.

### Ping resolution
When entity `A` pings at tick `t`:

1. Emit an expanding wavefront: radius `r(t) = c · (t − t_ping)`, `c = 1500 m/s`.
   At the map scale in §9, a return from across the map arrives in ~4 s. The wait is real but
   not tedious — better paced than the 8 s round trips of the earlier larger-map design.
2. Each tick, for each entity `B` whose range from `A` falls in
   `[r(t) − c·Δt/2, r(t) + c·Δt/2]`, the wavefront is arriving at `B` this tick.
3. Sample `B`'s silhouette: cast `N` rays from `A` across `B`'s angular extent
   (`N = 6–16`, scaled by angular size and `A`'s sonar resolution). Keep only hits on
   **front-facing edges** — the near side of the hull. This is what makes returns show partial
   outlines rather than whole ships, and it is the entire visual identity.
4. Each hit yields a candidate echo with strength:
   ```
   echoSE = SL_ping − TL(A→B) + TS(B, aspect) − TL(B→A) − NF_A + AG_A
   ```
   `TS` depends on aspect: **beam-on reflects far better than bow-on**. Turning your bow toward
   a pinging enemy substantially reduces your return. Because the game is a side view, this now
   also means a **steeply diving or climbing boat presents a smaller return to a horizontally
   distant pinger** — pitch is a defensive tool, which is a new and pleasing consequence of the
   geometry change. Feature this in the tutorial.
5. Surviving echoes are queued to arrive back at `A` at `t_return = t_ping + 2·range/c`, with a
   position error scaled by `echoSE`.
6. On arrival, `A`'s client receives echo points. **The client draws them, fades them, and never
   connects them across a gap it did not measure.**

### Active sonar in caves
A ping in a cave system returns a great deal of **rock** and comparatively little boat. Three
consequences, all of which the design should embrace rather than fight:

- **Pinging is much less useful in tight terrain and much more useful in open columns.** A
  self-balancing property that needs no rules: the places where you most want range are the
  places where a ping works.
- **Returns trace cave walls**, which is visually the best thing this renderer will ever produce
  — a pulse expanding through a warren, lighting up geometry as it goes. Budget effort for it.
- **Echo caps must be enforced per frame** (§10) or a ping in a warren floods the view channel.
  Prefer returns that reveal *novel* geometry over ones re-confirming charted walls, and prefer
  hull returns over terrain returns when the budget is tight.

### What the player sees
- Bright points and short arc segments where the ping struck a hull, at true-ish positions,
  tracing the near side of a recognizable submarine profile.
- They **persist and decay** over ~8–20 s, hot → cold → gone.
- Multiple pings accumulate a fuller outline, so a boat that pings repeatedly gets a genuinely
  good picture — and has by then told everyone exactly where it is.
- The outward-travelling ping ring is drawn on the emitter's own scope, expanding through the
  water, **visibly reflecting off the seabed and terrain**. The wait is the drama. Do not
  shorten it.

### Passive rendering, by contrast
A passive contact draws as a **bearing wedge** from the detecting boat: an angular sector whose
width is the bearing uncertainty, extending to maximum plausible range, fading with distance.
Two boats detecting the same source draw two wedges whose intersection is the solution. Three is
a fix. Making that triangulation visually obvious is the highest-value UI job in the game
(08 §4).

In the vertical slice a wedge sweeps across depth bands, so even a single wedge tells you
something about how deep the contact might be — and the wedge visibly clips against terrain and
layers, which is both correct and beautiful.

### Sonar drones
Deployed via torpedo tube; they transit to a point and loiter at a **chosen depth**, which is
now a point on screen the player clicks rather than an abstract parameter.
- **Passive drone** — silent listener. Feeds your picture from a position you do not occupy.
  The core tool for watching a flank or listening *below the layer while you stay above it*.
- **Active drone** — pings on a timer. Enormously informative and a screaming beacon — but the
  beacon is not where your boat is. Bait, or objective illumination.

Drones are the answer to "how do I see without being seen," and they are why the acoustic model
treats listeners as generic entities rather than as boats.

## 7. Contact tracking and staleness

Detections are per-tick facts. Contacts are persistent beliefs, and the belief layer is where
the game feel lives.

```ts
interface Contact {
  trackId: TrackId;              // stable; assigned by the tracker, NOT the entity id
  source: 'passive' | 'active' | 'drone' | 'torpedo-seeker';
  bearing: number;               // degrees in the slice, error already applied
  bearingRate: number;           // deg/s — the key TMA input
  range?: number;                // only from active returns
  rangeError?: number;
  classification: ClassGuess;    // { hullClass?, sizeBand, confidence }
  quality: number;               // 0..1
  firstSeenTick: Tick;
  lastSeenTick: Tick;
  designation: string;           // "S-01" — player-visible, renamable
  merged?: TrackId[];
}
```

**The tracker never sees entity identity.** Track ids come from association logic, not from
looking at what the entity actually is. That means the tracker can be *wrong*, which is
essential:

- **Track splitting** — a contact that manoeuvres through a low-quality patch comes back as a
  new track. The player decides whether it is the same boat.
- **Track merging** — two boats in close formation present as one and separate later.
- **Ghost tracks** — a decoy is indistinguishable from a real contact until its behaviour
  betrays it.

These are the mechanic, not bugs to minimize. But they need an escape valve: players can
manually merge, split, and rename tracks, and that annotation is real skill expression (08 §4).

**Staleness:** after `lastSeenTick` a contact remains on the scope, fading, for a
quality-dependent hold time (~30–90 s). It shows the last known bearing and is visually
unmistakable as stale. **It is never extrapolated by the client.** If the player wants a
projection, they draw it with the TMA tool — the game does not do their thinking.

## 8. Countermeasures

| Tool | Effect |
|---|---|
| **Decoy torpedo** | Swims out and emits a loud, boat-like broadband signature. Creates a plausible false track; seduces torpedo seekers. Duration-limited. |
| **Knuckle** | A hard turn at speed leaves a turbulent mass that reflects and masks. Free, immediate, brief. Classic "knuckle and run": turn hard, drop a decoy, go quiet, change depth. |
| **Crossing a layer** | The strongest break-contact action, and now a visible, committed movement. |
| **Terrain** | Putting rock between you and a hunter. **The most reliable escape in the game**, and the one that rewards map knowledge most. In a cave system there is almost always a wall available — the question is whether you can reach it before the solution is made. |
| **Ducking into a side passage** | Breaks the direct path and forces the hunter's bearing onto a portal instead of onto you. Cheap, fast, and the bread-and-butter evasion of cave fighting. |
| **All stop** | Minimum source level, best possible listening, zero mobility. A real commitment — and note that a stopped boat also loses most of its ability to change depth (04 §5). |
| **Running silent** | Distinct posture with a speed cap and an extra `−N dB` from securing non-essential machinery. |
| **Bottoming** | Settling on the seabed at zero speed: near-zero source level and a target strength merged into the bottom clutter, at the cost of total immobility and grounding damage risk. A vertical-slice-only tactic, and a very flavourful one. [TBD: include at launch — recommend yes, it is nearly free given terrain already exists.] |

## 9. Scale

The vertical-slice geometry forces a smaller world than a top-down design would use. If the map
were 16 km wide and 1 km deep, depth would be a 6% sliver of the play space and the whole point
of the change would be lost. The map must be within a small factor of square-ish to make both
axes matter.

| Parameter | Value | Rationale |
|---|---|---|
| Base map width | **5000 m** | Crossed in ~5.5 min at cruise, ~28 min at creep. Creeping means holding position, not repositioning — a good tactical statement. |
| Base map depth | **1200 m** | Aspect ~4:1. Depth is a genuine axis, not a sliver. |
| Layer depth(s) | ~400 m (single-layer maps); ~300 m and ~800 m (two-layer map) | Meaningful volume above *and* below |
| Detect: creeping Special Ops | ~350 m | You can be genuinely invisible |
| Detect: creeping Attack | ~600 m | |
| Detect: cruising Attack | ~1500 m | |
| Detect: cavitating Heavy | ~3500 m | Most of the map. Cavitation is a disaster. |
| Active ping detection range | ~2500 m | |
| Active ping *audibility* | > map width | Pinging is always a map-wide announcement |
| Ping round trip at 2500 m | 3.3 s (66 ticks at 20 Hz) | Enough wait to be dramatic, not tedious |

All of these are placeholders, but their **ratios** are the design intent and should be
preserved through tuning. Map extents scale with fleet size (06 §4) — width scales more than
depth, since the ocean does not get deeper because more players joined.

## 10. Performance and scaling

The naive acoustic solve is `O(listeners × sources)` per acoustic tick, and every boat, drone,
and torpedo is both. Realistic worst case: 6 players × 10 boats = 60 boats plus ~40 torpedoes
and drones = **~100 entities → ~10,000 pair evaluations**.

**Rates:** the simulation runs at **20 Hz** (04 §1) but the **acoustic solve runs at 10 Hz** —
every second sim tick. Acoustics is by far the most expensive phase and it does not benefit from
20 Hz: detection state simply does not change meaningfully in 50 ms. Movement, weapons, and
collision get the 20 Hz precision they need; acoustics does not pay for it. The 10 Hz acoustic
tick also aligns exactly with the 10 Hz network rate (02 §5), so each view frame carries exactly
one fresh acoustic solve — no waste in either direction.

Guardrails, all built from M1:
0. **The sector/portal table (§5.2) is the load-bearing one.** It converts occlusion from a
   per-pair raycast against thousands of wall edges into a table lookup, and it is precomputed
   once at match start. Without it, dense terrain is unaffordable; with it, terrain complexity is
   very nearly free at runtime. Everything below is secondary.
1. **Uniform spatial hash** over the slice. Cell size ~ typical max detection range. Rebuilt each
   acoustic tick.
2. **Range gate before math.** Squared-distance cull against a per-source maximum plausible
   detection range before touching a `log`. In caves this culls aggressively, since occluded pairs
   are usually also distant.
3. **Tiered rates.** Full solve at 10 Hz only for pairs in contact or near threshold; pairs far
   from threshold re-evaluated at 2 Hz round-robin, with hysteresis so tiers do not flicker.
4. **Precompute per source per tick.** `SL` once per entity, not per listener.
5. **Bounded echo work.** Caps on pings in flight, rays per target, and echo returns per player
   per frame.
6. **Solve per team, not per player** (decided — C17). Teammates share their entire sensory
   picture, so the acoustic solve, the tracker, and the echo queues all run **once per team**.
   With 3–8 players per team this is the largest single constant-factor saving available, and it
   is only free because the decision was made before the solve was written.

**Budget: the acoustic solve must fit in < 8 ms of a 100 ms acoustic period**, leaving the 20 Hz
movement/weapons phases a comfortable slice of their own 50 ms budgets. `bench-acoustics` runs
120 entities in CI and fails the build on a >10% regression (13 §6).

## 11. Tuning and validation

Every number here lives in a tuning table (`@seg/shared/content/acoustics.ts`), not in code.

- A **balance harness** answering, for any pair of configurations: "at what range does A detect
  B, given both speeds and depths, on both sides of the layer?" Output as a matrix, regenerated
  and diffed on every content change (05 §5).
- **Sanity assertions in CI** (13 §4): a creeping Special Ops is not detectable beyond 500 m by
  anything; a cavitating Heavy is detectable at 3 km by everything in an open column; crossing a
  layer at least halves effective detection range in every pairing; no configuration is detectable
  across the full map width while creeping; **a boat one bend away is materially harder to detect
  than one in line of sight at the same path length** (this is the assertion that proves the
  portal model is actually doing something).
- Because terrain now dominates, the balance matrix must be computed **per region archetype**
  (14 §4), not once. "Detection range" is a different number in an Open Column than in a Warren,
  and a single figure would be meaningless.
- A **dev truth overlay** rendering ground truth beside the player's picture, so developers can
  see how wrong the picture is. Server-side flag; ground truth is **not sent at all** in
  production builds rather than sent-and-hidden.

## 12. Open design questions

Tracked in [12-open-questions.md](12-open-questions.md).

- Passive **narrowband/tonal** detection (identifying a specific hull by its tonals) — the
  natural first post-launch depth addition, out of scope for 1.0.
- Whether **convergence zones and surface ducts** should arrive sooner than planned, given that
  the vertical slice makes ray paths directly drawable and they would be visually spectacular.
  Still post-1.0, but the case is stronger than it was.
- Whether **bottoming** ships at launch (§8).
- Whether a second layer appears on any launch map or is held for a post-launch map.
