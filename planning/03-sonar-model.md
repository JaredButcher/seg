# 03 — Sonar Model

This is the core mechanic and the primary product risk. It is modelled for **legibility and
tension**, not accuracy. Where a real-acoustics behaviour would be unreadable on screen, it
gets simplified or cut.

**The world is a vertical slice** (see 04 §2): `x` is horizontal distance, `y` is depth. Every
acoustic quantity below is computed in that plane, and every acoustic quantity is directly
drawable on the player's display. That equivalence — *the sim plane is the screen plane* — is
the biggest single advantage of the vertical-slice choice and this document leans on it
throughout.

> **Status — what is built.** The acoustic model is implemented in
> `@seg/shared/src/sim/acoustics/` (`lattice.ts`, `skin.ts`, `field.ts`, `solve.ts`,
> `boats.ts`) on top of the tuning table `@seg/shared/src/content/acoustics.ts`, and its
> behaviour is pinned by three test suites (`acoustics-levels`, `acoustics-propagation`,
> `acoustics-vision`). The layer above it — confirmation, the per-team chart, and the contact
> book (§5.3) — is in `@seg/shared/src/match/vision.ts`, and the solve is now driven by a real
> tick loop in `@seg/server/src/match/runtime.ts`. Sections marked **Implemented** describe the code as it is; everything
> else is design intent that has not been built yet, and each such section says so. Where the
> implementation departs from an earlier plan (notably the propagation structure and the
> detection output), the departure is called out inline.
>
> The map frame and its depth model are in `@seg/shared/src/map/sizes.ts` (14 §1.2); the cave
> generators in `@seg/shared/src/map/`.

## 1. The one-sentence model

Every entity emits sound; sound weakens with the distance it has to swim through water;
a listener sees the square metres of surface — rock, hull, or wreck — whose return beats what
it is already hearing (the ocean, its own machinery, and everyone else's racket). **The picture
is positional, not directional**: a list of 1 m squares and how far each cleared the threshold,
pooled per team, and it never says whether a square is rock or a submarine. Passive detection is
built. Active ping, bearings, and contact tracking are design that has not been built yet (§6,
§7).

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Source Level (SL)** | How loud an entity is, dB-arb. Sum of machinery, flow, cavitation, transients. |
| **Transmission Loss (TL)** | dB lost between source and receiver. A function of the **geodesic path length** through water only (§4). No layer, diffraction, or aperture terms in the current tuning. |
| **Noise Floor (NF)** | Ambient ocean noise + the listener's own self-noise (which rises with the listener's own speed) + everything else making noise where it sits — read off the noise heatmap (§5). |
| **Array Gain (AG)** | Listener's sensor quality bonus, from hull class + sensor modules. |
| **Detection Threshold (DT)** | Signal excess required to call a square a detection. |
| **Signal Excess (SE)** | `echo − NF + AG`. If `SE ≥ DT`, the square is shown; `SE` drives brightness. |
| **Target Strength (TS)** | How well a hull reflects a sound. Implemented as the **absorption** side of the same stat: `absorption = hullAbsorption − targetStrength`, so Anechoic Coating's −5 dB of TS is +5 dB of absorption (§5). |
| **Vision cell** | A 1 m square of surface that cleared the threshold. The unit the player's picture is made of — the implemented replacement for echo returns and bearings. |
| **Confirmation** | The second threshold (§5.3). Below it a square is a faint return that fades to nothing; at or above it the server commits — rock joins the team's chart permanently, a hull is revealed whole. |
| **Chart** | A team's accumulated confirmed terrain. Append-only, pooled per team, and **the only rock a player ever sees** (C21). |
| **Heatmap** | The summed sound power at every point in the water, which is both what lights the walls and what raises the bar for everyone listening in it (§5). |
| **Contact** | A listener's persistent *belief* about a source. **Not yet built** (§7). |
| **Baffles** | The blind arc astern. The `baffleArc` stat and module exist, but the solver does not use it yet — **not yet built**. |
| **Layer** | A thermocline: a horizontal band in the slice. **Not yet built** — the model has no layers (§4). |
| **Bearing** | An angle in the vertical plane. **Not yet built** — the model reports positions, not angles (§5). |

### A note on "bearing" in a vertical slice
In a top-down game, bearing is a compass direction. Here it is an angle in the x/depth plane,
which means **a bearing line carries depth information implicitly**. The current build does not
emit bearings — it sends square positions — so this paragraph describes a future layer, not the
present one. When bearings are added (with active sonar and the contact tracker), the
depth-in-bearing gain described here becomes real; for now the depth information is already in
the picture, because the squares are placed in the slice.

## 3. Noise generation (the emit side)

Every entity computes a **source level** each sim tick. **Implemented** in
`content/acoustics.ts#sourceLevelOf`:

```
SL = SL_base
   + flowNoiseSpan · (speed / hullMaxSpeed)²
   + cavitationPenalty + cavitationSpan · over      (only past the cavitation threshold, below)
   + damagedPenalty                                 (if below DAMAGED_HP_FRACTION, 04 §8)
   + hullStressPenalty                              (if deeper than testDepth)
   ⊕ Σ transients                                   (power-summed, not added)
```

`over` is how far past the cavitation threshold the boat is, scaled to its remaining speed
headroom. The transients are power-summed (`math/decibels.ts`) because a bang and a hum heard
together are not their decibels added. Active ping and "running silent" postures (§3.1) are not
in this formula yet; quieting today comes from the `silent-running-gear` module, which lowers
`SL_base` by 6 dB.

### Speed contribution
The dominant term and the main lever the player pulls. Quadratic in the speed fraction, so
"creep" is genuinely stealthy and "flank" is genuinely suicidal:

```
f_speed = flowNoiseSpan · (speed / hullMaxSpeed)²        // flowNoiseSpan = 25 dB
```

### Cavitation — the cliff
Below a depth-dependent speed threshold, propellers do not cavitate. Above it, they do, and you
become extremely loud. This is the single most important number a player tracks.

```
cavitationSpeed(depth) = base_cavSpeed · (1 + (depth − cavitationReferenceDepth) / cavitationDepthScale)
```

The hull stat is quoted at `cavitationReferenceDepth` (200 m). Shallower than that the boat
cavitates *sooner* than its stat block suggests; deeper it can go faster before screaming — that
sign is the difference between depth being a refuge and depth being a trap.

Deeper water = higher pressure = you can go faster before cavitating. In a vertical slice this
is no longer an abstract stat relationship — it is a **visible curve on the display**. The
cavitation-limited speed can be drawn as a shaded region, so a player literally sees that going
faster requires going lower on the screen.

Crossing the threshold adds a flat `cavitationPenalty` (+18 dB) plus a rising term up to
`cavitationSpan` (+12 dB at full speed). It is a cliff, not a slope, and the UI shows the
threshold explicitly on the speed control (08 §5).

**The core geometric trade this creates:** the fast, quiet water is deep — and the deep water
is also where the seabed and crush depth are (04 §6). Speed, stealth, and survival pull the
player down; the objectives, the surface, and safety pull them up. The player is squeezed
between two lines on screen, and that squeeze is the game.

### Transients
One-shot noise events, decaying over a few seconds. Loud, brief, and *identifiable* — a
transient tells a listener something happened, not merely that something exists. **Implemented**
in `content/acoustics.ts#TRANSIENTS`; a transient decays linearly from its peak to silence over
its listed seconds, and a listening boat power-sums whatever is still ringing into its source
level.

| Event | Level | Notes |
|---|---|---|
| Torpedo launch | +25 dB, 2 s | Classifiable as a launch with the right module |
| Rapid depth change (emergency blow) | +12 dB, 4 s | Fast depth changes are loud; slow ones are not |
| Hard turn (reversal) | +10 dB, 4 s | The "knuckle" — see §8 |
| Hull damage | +20 dB, 5 s | Getting hit gives away that you were hit |
| Bottom contact | +30 dB, 6 s | Punishment for careless piloting |
| Surface breach | +22 dB, 4 s | Broaching is a catastrophe, not a tactic |

Below test depth, the hull adds a **continuous** +6 dB groan (`hullStressPenalty`) — loud enough to
reveal you, but not an event. It is part of `sourceLevelOf`, not a transient.

### Active ping
**Built, as a transient.** A boat with active sonar switched on emits a pulse every
`pingIntervalMs` — **2000 ms**, a magic number — which rings down over `pingSeconds` (0.4 s) and
reaches the model through exactly the same door a torpedo launch does:
`content/acoustics.ts#activePingLevel` produces a level, `boatEntity` power-sums it into the
boat's source level as a transient, and **nothing downstream knows a ping from any other loud
noise**. See ADR 0003 for why it was built that way and what was left out.

Strength is the `pingLevel` stat — 108 / 116 / 124 dB by hull — which is sixty to seventy
decibels above the boat radiating it. For the four tenths of a second it rings, the pulse is by
a wide margin the loudest thing in the game, so two things happen at once and neither needed a
rule: the boat's own reflection field fills out to the imaging cap, and every listener within a
couple of kilometres gets an unambiguous direct arrival. The tactical grammar §9.2 measures is
the one this section always claimed — you ping when you already know you are detected, when you
need the picture *right now*, or when you are deliberately baiting.

It is a **posture, not an action**: a switch (`match.setActiveSonar`, hotkey `Q`) rather than a
fire-once button, because the interesting decision is whether to be pinging at all, and a
single-shot would let a player take the picture and pay almost nothing for it. The interval is
measured from the last pulse, so flicking the switch cannot outrun it.

"Powerful Active Sonar" trades a bigger detection radius for a bigger self-broadcast radius, and
the trade needs no rule because **one number produces both**: `+8 dB` of `pingLevel` is 8 dB
further out and 8 dB further heard. Ray count is not modifiable, because there are no rays —
see §6.

**Not built:** the travelling wavefront, the `2·range/c` return delay, and the near-side outline
trace. §6 describes all three and they remain the target.

## 4. Propagation (the transmission side)

**Implemented** in `sim/acoustics/field.ts` (the sweep), `sim/acoustics/lattice.ts` (the grid),
and `content/acoustics.ts#transmissionLoss`.

### Transmission loss

```
TL(r) = spreadingExponent · log10(r / referenceRange) + absorptionPerKm · (r − referenceRange) / 1000
```

Two terms, and only two. `spreadingExponent` is 15 dB per decade of range (between spherical and
cylindrical), and `absorptionPerKm` is 22 dB per kilometre of water. Inside the reference range
(10 m) the loss is zero — a source level *is* the level at the reference range, so nothing is
louder than its own source level. There is no layer penalty, no diffraction term, and no
aperture loss; the confinement (waveguide) term of the earlier plan is not in the model.

**Why absorption is so large.** Real seawater absorbs a fraction of a dB per kilometre at the
frequencies a submarine radiates. Twenty-two is not a unit error: it is the term that makes the
detection ranges in §9 *ratios* come out right. Spreading alone is a logarithm, so the sixty-
decibel spread between a creeping scout and a cavitating heavy would be a ten-thousand-fold
spread in range rather than the ten-fold the design asks for. A linear term compresses the loud
end without touching the quiet end. Tune the ranges, not the physics.

### Path length — a geodesic through water, on a lattice

**`pathLength` is the shortest path *through water*, not the straight-line distance.** Maps are
dense cave systems (14), so sound travels through chambers and passages rather than through rock.
Where there is unobstructed water the path *is* the straight line (to within the lattice's
octagon error, below); elsewhere it bends around the rock.

The plan originally resolved occlusion with a precomputed sector/portal table (§5.2, C11). **The
implementation replaced that with a water lattice.** `sim/acoustics/lattice.ts` rasterizes the
terrain polygons onto a coarse grid (20 m) once at match start; `sim/acoustics/field.ts` then
runs one bounded Dijkstra sweep per entity over that grid, bucket-queued so the priority queue
pops in O(1) instead of a heap. What comes back is the geodesic path length to every cell the
sound can reach — which serves as the entity's **outbound** propagation and, because path length
is symmetric, as the **return leg** of anything it hears. That is why the solve is linear in
entities rather than quadratic in pairs (60 boats = 60 fields, not 1800).

Why a grid instead of the sector table: the system's real question is "which square metres of
rock are lit right now", which is four orders of magnitude more answers than the table has rows
for, and a per-pair table has no place to hang a per-square answer. A grid answers both
questions with one structure. The lattice decides *whether* something is lit; the 1 m reflector
skin (§5.2) decides *what shape the light has*. Eight-connected Dijkstra overestimates a
straight diagonal by up to 5.7% (the octagon error) — at the model's spreading exponent that is
under half a decibel, and it is deliberately not corrected. Sound never cuts a diagonal corner
where it would squeeze through a sealed wall. A field is cut off by `maxRange` (the honest
bound) and by `maxFieldCells` (the guardrail), so a tick's cost does not depend on how the dice
fell during map generation.

### Layers — not built
**Not yet built.** The plan's thermoclines do not exist in the implementation: a sound pays the
same per-metre loss whether or not it crosses a fixed depth. This is the biggest omission from
the built model, and the design below is the target.

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

What is implemented and tested: **rock breaks the path outright.** `acoustics-vision` asserts
that a wall between two boats kills the picture, that a door leaks a weaker signal than the
straight line would, and that the noise heatmap does not go through rock. The 1 m reflector
skin (`sim/acoustics/skin.ts`) is the other half of the story: every square metre of rock face —
plus the seabed and the surface, which are hard boundaries (04 §6) — can send a return, and a
boat that makes enough noise literally lights up the walls around it (§5).

Two behaviours from the earlier design are **not** in the model yet:

**Passages are waveguides.** Inside a corridor narrower than a clearance threshold, sound spreads
cylindrically rather than spherically — the `confinement` term in `spreading()`. It carries far
along the passage while being blocked laterally. **A boat in a slot is invisible to everything
off-axis and loud to anything at either end.** The passage does not hide you; it aims you. This
is why only small, quiet hulls can use tight terrain safely. *(Not built — the lattice is
isotropic; there is no reduced spreading coefficient in passages.)*

**Open columns are terrifying.** No bends, no aperture loss, no occlusion — a cavitating boat in
an open column is audible across the entire region. The contrast between column and warren is the
primary reason to care where you are on the map. *(Implemented, and it falls out of the geodesic
model: nothing in a column attenuates a loud boat, so `maxRange` is what stops it.)*

**Bearings point at cave mouths.** The plan's most consequential mechanic — a contact heard
around a corner appearing to sit in the opening — depended on the portal model, which the lattice
replaced. It is not in the build (§5.1).

Deliberately omitted (as in the plan): convergence zones, bottom bounce, surface ducts,
frequency-dependent absorption, full ray tracing.

## 5. Detection (the receive side)

**Implemented** in `sim/acoustics/solve.ts`. The built rule is a power-domain comparison over a
three-pass solve; the bearing-based formula below is the earlier plan and is kept as context.

### The rule that is built

A listener's picture is assembled in three passes over one solve:

```
pass 0   every entity     → one bounded geodesic field (§4)
pass 1   every field      → accumulate the noise heatmap; record entity→listener path lengths
pass 2   every listener   → direct returns from the pair table, reflections from its own field
```

Two ways a square lights up, and keeping them apart is the difference between a model that works
and one that detects nothing at all:

**Direct.** A boat's hull squares are lit by its own radiated noise at `SL − TL`. No absorption:
you are hearing the boat, not an echo of it. This is classical passive detection.

**Reflected.** Any surface — rock, or somebody's hull — is lit by the total sound arriving at it,
minus what that material swallows, minus the loss on the way back: `incident − absorption − TL`.
This is what draws cave walls, and it is what finds a boat making no noise at all, because your
own machinery is lighting it up.

Treating a boat as reflecting its own noise would put the direct arrival into the listener's
noise floor and the echo of it into the signal — and the echo is quieter than the direct sound by
exactly the absorption, so the signal would always be under its own interference and nothing
would ever be seen. Two consequences fall out, and they are the game:

- **Absorption is a defence against being illuminated, not against being heard.** Anechoic
  Coating does nothing about the racket you make yourself, and everything about being lit by an
  enemy (asserted in `acoustics-vision`).
- **You light up what you are looking at.** Your own noise illuminates the walls around you, so
  going quiet makes you blind as well as hidden. All-stop is the best listening posture and the
  worst seeing one.

Detection is per 1 m square, per **team**, pooled across the team's boats (C17): a square is
reported once, with the best excess of whichever boat sees it best. Each reported square carries
its signal excess, which drives brightness and nothing else. What is **not** in the output:
bearings, contacts, classification, or any tag saying whether a square is rock or hull — the
player reads the shape, and that is the game (§6).

```
SE = echo − noiseFloor − DT + arrayGain        (compared as powers, not decibels)
```

The noise floor a square is tested against is `ambient ⊕ selfNoise ⊕ background`, where
`background` is everything else making noise at the listener's position, read off the heatmap —
and the listener's own contribution is excluded there, because its own noise at its own position
would otherwise be a division by zero. `DT` and `arrayGain` are folded into a single
`returnThreshold` per listener, so the solver compares once per cell instead of once per square.

### 5.3 Confirmation — the second threshold

**Implemented** in `match/vision.ts`, on top of the solve above (C21,
[ADR 0002](../docs/adr/0002-uncharted-terrain.md)).

`SE ≥ DT` decides whether a square is *shown*. A second threshold —
`confirmationThreshold`, +8 dB of excess on top — decides whether the server is willing to
**commit** to it. The gap between them is deliberate and it is the mechanic:

- Between `DT` and confirmation, a square is a **faint return**. It is drawn, dimly, and it
  fades to nothing. The server records nothing.
- At or above confirmation, the square is a **fact**. Rock joins the team's chart for the rest
  of the match; a hull square reveals the boat it sits on.

**A skilled player acts on the faint band before the game agrees with them.** That is the whole
reason for two numbers rather than one — a single threshold makes the display a readout, and a
readout has nothing to read. Widening the band rewards inference; narrowing it rewards nothing.

Two asymmetries fall out of what the two kinds of surface *are*:

- **Rock does not move**, so a confirmation is permanent and there is nothing for a second look
  to correct. The chart is append-only, and each square crosses the wire exactly once.
- **Boats do**, so a confirmed hull is a belief with an age. It is revealed whole — silhouette,
  position, pitch — and stays a live reading for `contactFadeSeconds`. After that it has
  slipped detection and what remains is a **hollow outline at the pose that was measured**,
  never moved and never extrapolated (§7's staleness rule, arriving early).

**Confirmation is server-side and uncapped.** It runs over every square the solve produced,
while the set transmitted to the client is capped (`maxWireVisionCells`). A team's chart
therefore does not depend on how much of its picture fitted in a packet — which it absolutely
would if the client were deciding — and a client cannot be made to forget a square it was never
sent.

### 5.1 Apparent bearing — superseded
**Not built.** The plan's "bearings point at cave mouths" mechanic depended on the sector/portal
model, which the lattice replaced (§4), and the implementation reports square positions rather
than bearings, so there is no bearing line to point anywhere.

What replaces it, and what is lost: with square positions, a boat around a corner is simply
*not seen through the rock* — there is no ghost contact to chase, but there is also no honest
misdirection to learn to read. The mechanic below is kept as a future layer, to return if the
contact/tracker layer lands and the model grows a bearing output.

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

Implementation (future): the propagation lookup returns `firstPortal` alongside `pathLength`; the
detection records the bearing to that portal's centre, with bearing uncertainty widened by the
portal's angular size. A wide opening gives a vague direction; a narrow slot gives a precise
bearing to a place the target is not.

### 5.2 The propagation structure — the water lattice
Occlusion is resolved by a **water lattice**, not by the sector table the plan proposed.

`sim/acoustics/lattice.ts` rasterizes the terrain polygons onto a coarse grid (20 m) once at
match start and, for every rock cell, remembers the nearest water cell. The 1 m reflector skin
(`sim/acoustics/skin.ts`) walks every obstacle outline — plus the seabed and the surface, which
are hard boundaries — at half-metre steps, and bins each square under the lattice cell that can
hear it, laid out CSR so a listener sweeping its own field finds every surface it can see exactly
once, with no neighbour search in the inner loop. Hull outlines run through the same routine every
tick, which is what lets a boat be drawn by its own reflection with no separate target-detection
path.

This is why the solve is affordable on dense terrain: the geometry is paid once, at match start,
in the rasterize; the per-tick cost is `entities × water cells in reach`, bounded by the field
caps (§10). The trade against the plan's O(1) sector-pair lookup is that the grid is coarse —
20 m — so what is quantized is brightness, never shape (the lattice decides whether, the skin
decides what the light looks like).

### Self-noise — why you slow down to listen
```
NF = ambient ⊕ selfNoise(ownSpeed) ⊕ background        (power-summed)
```
Your own speed deafens you. A boat at flank is both maximally loud and maximally deaf. This is
the second half of the speed trade and it is what makes "all stop and listen" a real move.

### The baffles — not built
**Not yet built.** `arrayFactor(relativeBearing)` is not in the solver. The `baffleArc` stat and
the Towed Array module exist, but nothing consumes them yet.

When it lands, `arrayFactor` is a large negative value in a rear arc (default ±30° off the stern,
hull- and module-modifiable). In a vertical slice the baffle cone is drawn behind the boat and
points along its actual facing — a diving boat's blind arc points up and behind it, which is
visible and exploitable. Consequences:

- Approaching from astern is genuinely stealthy → tailing gameplay works.
- A single boat cannot cover everything; fleets must be arranged so boats cover each other's
  baffles. **This is the primary reason to command more than one boat**, and it is now
  *visually obvious* — the player can see the dead cones on screen and see the gaps between
  them. Teaching this is dramatically easier than it would have been top-down.
- "Clearing baffles" — a periodic turn to sweep the blind arc — becomes a habit good players
  form on their own. Reward it; do not automate it.

### Detection thresholds and contact quality — not built
`SE ≥ DT` is built; everything downstream is not. Signal excess is reported per square and drives
brightness only. There is no contact layer yet (§7), so there is no quality, no classification,
and no bearing error to stabilise.

The target, when the tracker lands:

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

**Active ping: switched on, but not resolved the way this section describes.** A boat can ping
(§3, ADR 0003) and it transforms the picture — but it does so by being *loud*, not by emitting a
wavefront. Nothing traces an outline, nothing casts rays across a target's angular extent, and
no echo is queued to arrive later. What a pulse produces is the same vision-square picture §5
already draws, four times brighter and much further out, in the four tenths of a second it
rings. The ping resolution steps below are still the target; the ring the client draws around a
pulsing boat is an animation, not a simulated wavefront (`client/render/pings.ts`).

### What is built instead — the vision picture
The passive solve already delivers the game's core visual: a pooled, per-team picture of 1 m
squares, lit where `SE` clears the listener's threshold, with brightness equal to signal excess
(§5). Cave walls show up because they are lit by whatever is making noise near them; a hull shows
up because it is either making noise itself or being lit by your own machinery. That picture,
read as shape rather than as classified contacts, is the silhouette mechanic this section was
aiming at — it just does not need a ping to happen, and it does not get connected into outline
segments.

### Hull geometry — now a side profile
Every hull has a **2D side-profile silhouette polygon** defined in the content tables alongside
its stats (`hullOutline` in `sim/acoustics/boats.ts`). It is the shape that reflects sound onto
the vision picture, and it is the shape drawn in the fleet builder's technical-drawing view
(09 §9). The collision shape is separate.

A submarine seen from the side is **far more recognizable than one seen from above** — sail
position and height, hull taper, bow shape, stern planes. Silhouette recognition is a real skill
the game rewards, and the vertical slice makes it a much better skill than it would have been.
Today the player reads that silhouette from the density of the vision squares; the active echo
trace below would trace it directly.

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
**Built today:** three layers, stacked, none of them labelled (§5.3, 08 §3).

1. **The chart** — squares of rock this team has confirmed. Solid, permanent, in the `terrain`
   tone. It begins **empty**: a player is never sent the map (C21).
2. **The vision picture** — every square lit this solve that is not already charted, drawn in
   the `sonar` accent with brightness from signal excess, fading over about a second and a
   half. Pooled per team, so the whole fleet sees the best of what any boat sees.
3. **Confirmed contacts** — a hostile boat's full silhouette while it is still being heard, a
   hollow outline at its last measured pose once it is not.

The illusion is in the stacking rather than in any per-square tag. A square that confirms gets
its chart rectangle in the same frame as its green flash, so the green fades and reveals a wall
underneath; a square that was a fluke fades onto water; a square on a hull gets a silhouette
over it. **Nothing on the wire says which of the three a square is** — the picture still does
not distinguish rock from hull, and the player still reads the shape.

**Built today, with the ping switched on:** a fourth thing, and it is not a layer — the ring
`client/render/pings.ts` draws around a friendly boat on each pulse, expanding at 1500 m/s and
fading over 1.8 s, with a stereo-panned tone placed from where it sits in the viewport. It
carries no information the other three layers do not; what it carries is the *beat*, so a player
can see and hear which of their boats is shouting without reading a word. Hostile pulses get no
ring — an enemy pinging arrives the way every other sound does, as a very loud return.

**When echo resolution lands:** bright points and short arc segments where the ping struck a
hull, at true-ish positions, tracing the near side of a recognizable submarine profile.

- They **persist and decay** over ~8–20 s, hot → cold → gone.
- Multiple pings accumulate a fuller outline, so a boat that pings repeatedly gets a genuinely
  good picture — and has by then told everyone exactly where it is.
- The outward-travelling ping ring is drawn on the emitter's own scope, expanding through the
  water, **visibly reflecting off the seabed and terrain**. The wait is the drama. Do not
  shorten it.

### Passive rendering, by contrast
**Not built — there are no bearings.** The plan's passive wedge depended on a bearing output the
implementation does not produce; what replaced it is the positional vision picture (§5), so there
is no wedge and no triangulation to make. The design still wants the wedge someday (see §5.1 and
08 §4):

A passive contact draws as a **bearing wedge** from the detecting boat: an angular sector whose
width is the bearing uncertainty, extending to maximum plausible range, fading with distance.
Two boats detecting the same source draw two wedges whose intersection is the solution. Three is
a fix. Making that triangulation visually obvious is the highest-value UI job in the game
(08 §4).

In the vertical slice a wedge sweeps across depth bands, so even a single wedge tells you
something about how deep the contact might be — and the wedge visibly clips against terrain and
layers, which is both correct and beautiful.

### Sonar drones
**Not built.** Deployed via torpedo tube; they transit to a point and loiter at a **chosen
depth**, which is now a point on screen the player clicks rather than an abstract parameter.
- **Passive drone** — silent listener. Feeds your picture from a position you do not occupy.
  The core tool for watching a flank or listening *below the layer while you stay above it*.
- **Active drone** — pings on a timer. Enormously informative and a screaming beacon — but the
  beacon is not where your boat is. Bait, or objective illumination.

Drones are the answer to "how do I see without being seen," and they are why the acoustic model
treats listeners as generic entities rather than as boats.

## 7. Contact tracking and staleness

**Not yet built.** The solver emits per-square excess (§5) and nothing has a `trackId`; the layer
below is the plan for when the picture gains a belief layer. Detection is a per-tick fact.
Contacts are persistent beliefs, and the belief layer is where the game feel lives.

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

**Status: game-logic layer, not yet wired into a live match.** Of the rows below, only the
module-backed ones exist in content today (`silent-running-gear` in `content/modules.ts`), and
"duck into a side passage" is the one that is already true of the built model. The rest are the
design for the countermeasure layer.

| Tool | Effect |
|---|---|
| **Decoy torpedo** | Swims out and emits a loud, boat-like broadband signature. Creates a plausible false track; seduces torpedo seekers. Duration-limited. |
| **Knuckle** | A hard turn at speed leaves a turbulent mass that reflects and masks. Free, immediate, brief. Classic "knuckle and run": turn hard, drop a decoy, go quiet, change depth. |
| **Crossing a layer** | The strongest break-contact action, and now a visible, committed movement. [Layers are not yet built — §4 — so this row awaits them.] |
| **Terrain** | Putting rock between you and a hunter. **The most reliable escape in the game**, and the one that rewards map knowledge most. In a cave system there is almost always a wall available — the question is whether you can reach it before the solution is made. |
| **Ducking into a side passage** | Breaks the direct path: with the lattice model, sound does not bend around corners — a wall between you and a hunter simply ends the geodesic, so you are not seen through the rock. **Already how the built model behaves.** Cheap, fast, and the bread-and-butter evasion of cave fighting. |
| **All stop** | Minimum source level, best possible listening, zero mobility. A real commitment — and note that a stopped boat also loses most of its ability to change depth (04 §5). |
| **Running silent** | Partially built: the `silent-running-gear` module applies `−6 dB` to `SL_base` (03 §3) — the current quieting path. The planned posture — a distinct running state with a speed cap and extra machinery-secured dB — is not yet built. |
| **Bottoming** | Settling on the seabed at zero speed: near-zero source level and a target strength merged into the bottom clutter, at the cost of total immobility and grounding damage risk. A vertical-slice-only tactic, and a very flavourful one. [TBD: include at launch — recommend yes, it is nearly free given terrain already exists.] |

## 9. Scale

The vertical-slice geometry forces a smaller world than a top-down design would use. If the map
were 16 km wide and 1 km deep, depth would be a 6% sliver of the play space and the whole point
of the change would be lost. The map must be within a small factor of square-ish to make both
axes matter.

The table below now matches the implemented constants in `map/sizes.ts` (base map, medium scale).

| Parameter | Value | Rationale |
|---|---|---|
| Base map width | **8000 m** | `BASE_MAP_WIDTH`. Crossed in ~9 min at cruise, ~45 min at creep. Creeping means holding position, not repositioning — a good tactical statement. |
| Base map height (Y) | **3000 m** | `BASE_MAP_HEIGHT`. Aspect ~2.7:1; the Y axis is a full play axis, not a sliver. |
| Map depth | **1200 m** | `MAP_DEPTH`, fixed on every map size. `depthScale = MAP_DEPTH / height` maps Y to game depth, so the seabed is exactly 1200 m deep on small, medium, and large maps alike, and a larger map has more Y field to play in (14 §1). |
| Layer depth(s) | ~400 m (single-layer maps); ~300 m and ~800 m (two-layer map) | Meaningful volume above *and* below. [Layers are not yet built — §4.] |
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

### 9.1 Measured against the built model

First measurement, taken when the chart landed (C21). Open water, no interference, depth 300 m.
**Passive** is the direct path — one boat hearing another. **Imaging** is the reflection path —
how far a boat lights the rock around it, which is the range at which the map gets charted.

| Hull | Notch | SL | Passive on a peer | Images rock to | Confirms rock to |
|---|---|---|---|---|---|
| Light | stop | 41 dB | 611 m | 89 m | 54 m |
| Light | standard | 70 dB | 1455 m | 290 m | 207 m |
| Medium | stop | 48 dB | 770 m | 118 m | 74 m |
| Medium | standard | 78 dB | 1679 m | 360 m | 266 m |
| Heavy | stop | 58 dB | 1043 m | 179 m | 118 m |
| Heavy | flank | 113 dB | 2266 m | 565 m | 450 m |

**The passive column is in good shape** — 611 m creeping to 2266 m cavitating is close to §9's
intended 350 / 600 / 1500 / 3500 spread, and the *ratios* are right. Nothing needs doing there.

**Three findings about the imaging column, which is new and is what charts the map:**

1. **`maxImagingRange` (1200 m) is unreachable and is therefore not the binding constraint.** A
   reflection pays transmission loss twice plus 8 dB of `terrainAbsorption`, so at 22 dB/km the
   round trip costs 44 dB/km. Nothing in the content table is loud enough to clear a threshold
   at a kilometre. The cap is a guardrail on *cost*, not on range, and it should be described
   that way rather than read as a design target.
2. **A boat at rest is very nearly blind** — 89 m to 179 m, confirming at 54 m to 118 m. That is
   the model working as designed (§5: all-stop is the best listening posture and the worst
   seeing one), and it is fine as a *tactic*. It is a problem as a *starting state*: deployment
   berths boats stopped, so a match opens on an empty screen.
3. **A fleet is worse at mapping than a lone boat, and the magnitude is severe.** A teammate
   500 m away raises your noise floor to ~22 dB, which collapses imaging to **~55 m for every
   hull at every speed** — going faster stops helping, because your own extra noise cancels the
   gain. Spreading the fleet out is meant to be a decision (08 §6, formations); at this
   magnitude it is closer to a requirement. Verified in a live match: two Heavies berthed a few
   hundred metres apart in an open chamber charted *nothing* over a minute.

None of this is retuned yet, deliberately: the levers that would move it (`absorptionPerKm`,
`terrainAbsorption`) also move the passive column, which is currently right, and the balance
harness that would show the trade does not exist (§11). The honest reading is that **charting
is a thing you do by swimming through the map**, at a 300–500 m swathe under way, and that the
active ping (§6) is the designed answer to wanting more. Decide it with the harness, not here.

### 9.2 Measured with active sonar

Second measurement, taken when the ping landed. Open water, both boats stopped, medium map.
**Images a hull** is the reflected path — how far the pinger confirms an enemy *boat*. **Heard
by the enemy** is the direct path — how far away a passive boat of the same class confirms the
*pinger*. Sampled at 200 m granularity.

| Hull | Ping | Images a hull to | With Powerful Active Sonar | Heard by the enemy at |
|---|---|---|---|---|
| Light | 108 dB | 400 m | 400 m | 2200 m |
| Medium | 116 dB | 400 m | 600 m | 2400 m |
| Heavy | 124 dB | 600 m | 600 m | 2600 m |

And against **rock**, which is the thing the ping is actually good at: a stopped boat that
charted **zero** squares in two seconds charts **2100–2700** of them with the switch on. That is
not a ratio, it is a difference in kind — §9.1's finding 2 was that a match opens on an empty
screen, and this is the answer to it. A player who wants to see anything at all before they get
under way now has a control that does it.

**Three findings:**

1. **You are heard four to six times further than you can see.** 2200–2600 m out, against
   400–600 m in. §9's "active ping *audibility* > map width" is essentially met (2600 m against
   a 7000 m small map is not the whole map, but it is most of a fight); §9's "active ping
   detection range ~2500 m" is **not** met and is out by a factor of four. The asymmetry is not
   a bug — a return pays the path twice plus the hull's absorption, while the pulse itself pays
   it once — and it is a *good* asymmetry, because it makes the switch genuinely dangerous. But
   the number in §9 should be read as aspiration, not as spec.
2. **The ping is a terrain instrument that happens to find boats, not the reverse.** Which is
   what §6's "Active sonar in caves" predicted in as many words: "a ping in a cave system
   returns a great deal of rock and comparatively little boat". Pleasing to have the prediction
   land, and it means the mechanic's main use is mapping and its main risk is being mapped.
3. **Powerful Active Sonar is worth 0–200 m of hull range at this granularity**, which is inside
   the measurement noise and is *not* where its value is. Eight decibels is a doubling of the
   range at which terrain squares clear `confirmationThreshold` and join the chart forever, and
   that is the effect worth describing to a player. The module's blurb currently says "maps
   twice as far", which is true of rock and overstated for boats.

Retuning is again deferred to the harness (§11). The lever that would raise finding 1's inner
number without touching the passive column is `hullAbsorption`, which is used by nothing else —
that is the first thing to try when there is something to measure the result against.

## 10. Performance and scaling

The naive acoustic solve is `O(listeners × sources)` per acoustic tick, and every boat, drone,
and torpedo is both. Realistic worst case: 6 players × 10 boats = 60 boats plus ~40 torpedoes
and drones = **~100 entities → ~10,000 pair evaluations**.

**Rates:** the simulation runs at **20 Hz** (`SIM_TICK_HZ` in `@seg/shared`) and the **acoustic
solve runs at 10 Hz** (`ACOUSTIC_TICK_HZ`) — every second sim tick. Acoustics is by far the most
expensive phase and it does not benefit from 20 Hz: detection state simply does not change
meaningfully in 50 ms. Movement, weapons, and collision get the 20 Hz precision they need;
acoustics does not pay for it. The 10 Hz acoustic tick also aligns exactly with the 10 Hz network
rate (02 §5), so each view frame carries exactly one fresh acoustic solve — no waste in either
direction. *The constants exist in `@seg/shared`; the solve is not yet wired into a live match
loop.*

Guardrails. The load-bearing ones are the ones the implementation actually built; the rest are
what to reach for if profiling says so:

- **The water lattice (§5.2) replaces the planned sector/portal table as the load-bearing
  structure.** It converts occlusion from a per-pair raycast against thousands of wall edges into
  a bounded Dijkstra over a coarse grid, run once per entity per acoustic tick. With it, terrain
  complexity is paid once at match start and the per-tick cost is linear in entities — the
  property the plan's O(1) table was buying, at the price of a quantized brightness frontier
  (§5.2) instead of a quantized path.
- **`maxRange` bounds the field honestly** — the propagation stops where the math says the sound
  is gone, so pairs beyond reach never do any work at all. **`maxFieldCells` is the hard
  guardrail behind it**: if the honest bound would blow the budget, the sweep stops early and the
  field is marked cut-short (simulation keeps running; the picture is incomplete for that tick).
  These two together replace the plan's range gate *and* its tiered 2 Hz re-evaluation (see
  `solve.ts`).
- **Precompute per source per tick.** `SL` is computed once per entity, not per listener
  (`sourceLevelOf`), and reused across every direct pair and every reflection.
- **Solve per team, not per player** (decided — C17, implemented). Teammates share their entire
  sensory picture, so the acoustic solve runs **once per team** and its result is pooled. With
  3–8 players per team this is the largest single constant-factor saving available, and it is
  only free because the decision was made before the solve was written.

No longer needed, because the lattice is the acceleration structure: a separate uniform spatial
hash, and per-pair culling. Not applicable until active sonar exists: bounded echo work (pings in
flight, rays per target, echo returns per frame) — the caps still apply the day the ping lands.

**Budget: the acoustic solve must fit in < 8 ms of a 100 ms acoustic period**, leaving the 20 Hz
movement/weapons phases a comfortable slice of their own 50 ms budgets. `bench-acoustics` —
120 entities in CI, failing the build on a >10% regression (13 §6) — is **not built yet**; the
bench harness is pending.

## 11. Tuning and validation

Every number lives in a tuning table (`@seg/shared/content/acoustics.ts`), not in code. That
part is built and asserted: `acoustics-levels`, `acoustics-propagation`, and `acoustics-vision`
pin the levels, the geodesics, and the reflection picture, at ~95% coverage over
`sim/acoustics` (13 §5). The harnesses below are the balance layer, still to build.

- A **balance harness** answering, for any pair of configurations: "at what range does A detect
  B, given both speeds and depths, on both sides of the layer?" Output as a matrix, regenerated
  and diffed on every content change (05 §5).
- **Sanity assertions in CI** (13 §4): a creeping Special Ops is not detectable beyond 500 m by
  anything; a cavitating Heavy is detectable at 3 km by everything in an open column; crossing a
  layer at least halves effective detection range in every pairing; no configuration is detectable
  across the full map width while creeping; **a boat one bend away is materially harder to detect
  than one in line of sight at the same path length** (this is the assertion that proves the
  lattice is actually doing something — the built equivalent of the portal assertion, and already
  exercised by the propagation suite).
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
