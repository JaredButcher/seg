# 14 — Map Generation & Terrain

Maps are **procedurally generated cave systems**, not authored levels. Terrain is dense: caves,
chambers, and passages stacked through the full depth of the map. This document defines what the
generator produces, the invariants it guarantees, and how it produces them.

Terrain is now the **dominant system in the game**. It drives navigation, acoustic propagation,
fleet composition, and most of what is on screen. Three subsystems consume its output and all
three have hard requirements on it (§2).

## 1. What a map looks like

The map is a vertical slice, 8000 m × 3000 m at base scale, with a fixed 1000 m game depth
(03 §9, `map/sizes.ts`). Rather than open water with
a seabed and a few seamounts, it is mostly **rock**, hollowed out by a connected network of:

- **Chambers** — large open volumes. Some span most of the map's depth as **open columns**,
  giving line-of-sight from surface to seabed and no cover whatsoever.
- **Passages** — corridors connecting chambers, varying from wide enough for any hull down to
  slots only a Scout can thread.
- **Chokes** — regions where the entire map narrows to exactly three passages, all of them tight.

The intended rhythm across the map's width is an alternation: exposed open regions where speed
and range matter, and constricted regions where size and silence matter. A fleet crossing the map
passes through both, and the composition that thrives in one struggles in the other.

**Why this matters beyond flavour:** it is the direct answer to risk R9 (the worry that a vertical
slice makes positioning one-dimensional). With dense terrain there is no "line" to push along —
there are three-plus simultaneous routes at every point, each with different width, exposure, and
acoustic character. Positional play returns in full, and it returns in a form unique to this
geometry. R9 should be downgraded from High/Medium once the M1 harness confirms it.

### 1.1 Map type

The terrain above is the **dense** variant, the base game. It is one of three **map types**
exposed as a lobby setting (06 §3):

| Type | Character |
|---|---|
| **Dense** | The cave system this document describes. Default. |
| **Sparse** | Fewer, larger chambers and wider passages; the archetype mix shifts toward Columns and Cathedrals. More sightlines, less cover. |
| **Empty** | No procedural terrain at all — open water with only the seabed, surface, and deployed objectives. Speed and range dominate; sonar is the only way to hide. |

All three are the same world at different clutter levels, not different biomes: the generator is
shared, and a map type selects how much rock there is to hollow out (§5 step 1). The invariants of
§3 apply to **Sparse** as written; **Empty** trivially satisfies I1–I6 with no terrain, and the
acoustic model (§6) degenerates to pure line-of-sight — the water lattice has no rock to route
around.

> **Status.** The `empty` and `sparse`/`dense` generators are built in `@seg/shared/map` and
> shipped behind `GENERATOR_VERSION = 2`; §5 steps 7–9 are not (§5). §4's region-archetype model
> was replaced during implementation by the level-stack model in `map/tuning.ts` (see §4).

### 1.2 Map size

**Small / Medium / Large** is a second lobby setting (06 §3). **Medium is the base scale**
(8000 m × 3000 m). Exact dimensions for Small and Large are deliberately **not pinned down here** —
they are recorded as a relative scale against the base map (0.7× and 1.5×), so the milestone can
adjust them without a protocol change.

**X/Y and depth are different things.** The map is 2D and everything in the game runs on X/Y —
rendering, size, movement. A sub that dives moves at the same speed on every map size, visibly and
in simulation. Depth is a *derived* value: `depth = (height − y) · depthScale`, where `depthScale`
normalizes the map's physical height to a **fixed game depth** shared by all sizes (1000 m, deep
enough to sit below the deepest hull crush depth). So height scales with map size — a Large map has
substantially more Y field to play in — while every map still reaches the same full depth range,
and diving the same Δy costs more depth on a Small map where the scale is steeper. The frame is
y-up with the seabed at `y = 0` and the surface at `y = height`; the UI shows a position as X/Y(D).

**The concrete numbers live in code as the tuning point**: `@seg/shared/map/sizes.ts` holds the
base extents, the per-size scales, the fixed game depth (`MAP_DEPTH`), and the `depthScale` /
`depthAt` conversions, and `resolveExtents` turns a map size into `width × height`
(currently 5600×2100 / 8000×3000 / 12000×4500). Changing a map size is a diff in that one file.

## 2. The three consumers and what they need

The generator's output format is dictated by these, and they are the reason the pipeline is
structured the way it is (§5).

| Consumer | Needs | Why it is hard |
|---|---|---|
| **Collision & navigation** (04) | Solid/free geometry; a navmesh; per-hull clearance | Boats must path through caves, and a Heavy must not path into a slot it cannot fit |
| **Acoustics** (03) | Occlusion and a propagation structure | Raycasting every listener/source pair against thousands of wall edges every acoustic tick is not affordable |
| **Rendering** (08, 09) | Polygon contours; a static geometry buffer | Terrain is most of the screen and must not be re-tessellated per frame |

The critical realization: **all three want the same underlying structure**, a decomposition of
free space into convex regions with known connections. Build that once, at generation time, and
every consumer reads from it. That is what makes dense terrain affordable rather than ruinous.

## 3. Guaranteed invariants

These are contracts. The generator does not "usually" satisfy them — it either satisfies them or
the map is rejected and regenerated. Every one is asserted by a property test over hundreds of
seeds (13 §4).

### I1 — Three paths at every X
**At every vertical line `x`, at least three distinct traversable channels cross it**, each
belonging to a route that connects the left edge to the right edge.

Formally: let `F(x)` be the set of connected free-space intervals on the line at `x`. At least
three members of `F(x)` must belong to connected components of free space that touch both the
left and right map boundaries. Three *holes* in a wall do not count if two of them are dead ends.

This is the anti-stalemate guarantee, the anti-camping guarantee, and the reason a defender can
never fully cover an approach. It is achieved **by construction** (§5), not by generate-and-check.

### I2 — At least one large-hull route at every X
At every `x`, **at least one** of the three channels admits the largest hull's clearance.

Not specified in the original brief, and added deliberately: without it a random seed can strand
a Heavy fleet behind a wall it physically cannot pass, which is an unfair loss decided before the
match starts. The guarantee permits that large-hull route to be a long detour — a Heavy should
often be forced the slow way around, just never *stopped*.

### I3 — Both teams' deployment zones are equivalently connected
Each deployment zone touches at least three distinct routes, and the route-length distribution
from each zone to each objective is within a tolerance of its mirror. See §7 on symmetry.

### I4 — No unreachable pockets on a route
Free space that is not reachable from a deployment zone is either filled in or explicitly marked
as dead volume. A boat must never be able to enter a region it cannot leave.

### I5 — Minimum clearance is never violated by detail
Wall detail and noise are applied *before* a final clearance re-check that re-erodes any passage
narrowed below its declared width class. Detail must never break navigability (§5 step 5).

### I6 — Objectives are placed in valid, contestable locations
Every objective sits in free space with clearance for at least a mid-size hull, is reachable by
at least two distinct routes, and is not inside a choke so tight that holding it is trivial.

## 4. Region archetypes

**Superseded during implementation.** The built generator (`@seg/shared/map/tuning.ts`) does not
lay out a region sequence across X. It builds a stack of **levels** — broad horizontal galleries
running the map's length, 200–1000 m tall — joined by **connections**, vertical halls 300–1200 m
across, on a base map 3000 m from seabed to surface. Three or four galleries with a handful of
cathedral-sized shafts, not a warren of tunnels. The two guarantees are floors, not classes:
`minPassageWidth` (200 m — no opening anywhere is narrower) and `trunkPassageWidth` (400 m — at
least one level crosses the whole map). The archetype table below is the earlier plan and is kept
for the vocabulary it supplies; the deliberate departure is documented in `tuning.ts`.

The earlier plan: the generator lays out a sequence of **regions** across the map's width, each
with its own character. This is what produces deliberate rhythm rather than uniform noise.

| Archetype | Width | Character | Plays like |
|---|---|---|---|
| **Open Column** | 400–900 m | One or two very large chambers spanning most of the depth. Few walls, long sightlines, sound travels freely. | Open water. Speed, range, and passive detection dominate. Nowhere to hide; the layer is your only cover. |
| **Braid** | 600–1200 m | Five to eight medium passages weaving and cross-connecting. Many routes, medium clearance. | The default. Positional, lots of choices, moderate cover. |
| **Choke** | 200–400 m | Exactly three passages, all narrow. One admits a large hull (I2) but is long and indirect. | The tense one. Size and silence decide who gets through. Ambush country. |
| **Cathedral** | 500–900 m | One enormous chamber with scattered pillars and a broken floor. | Open, but with cover. Good objective sites. |
| **Warren** | 400–800 m | Dense small chambers, many tiny connections, low clearance throughout. | Scout and Special Ops territory. A Heavy simply routes around it. |

A generated map is a sequence like `Column → Braid → Choke → Cathedral → Choke → Braid → Column`,
with the sequence itself seeded and constrained: no two Chokes adjacent, at least one Cathedral or
Column for objective placement, deployment zones always in a Column or Braid so nobody starts
trapped.

**Passage width classes** map onto the hull roster, which is what makes composition matter:

| Class | Clearance | Admits |
|---|---|---|
| Open | > 200 m | Anything, plus room to manoeuvre |
| Wide | 90–200 m | Any hull comfortably |
| Standard | 50–90 m | Any hull, but a Heavy must slow down and cannot turn |
| Narrow | 28–50 m | Scout, Special Ops, Attack |
| Slot | 16–28 m | Scout and Special Ops only |

The built floors make every "class" below Open vanish: the tightest opening anywhere is 200 m, a
dozen lattice cells wide, because at the scale the scope actually reads a 30 m gap is a hairline
and a fleet cannot manoeuvre in it (`tuning.ts`, "A note on scale"). Variety comes from the *shape*
of a small number of large spaces — level heights differing by a factor of three, connections by a
factor of four — rather than from their number.

## 5. The generation pipeline

**Skeleton first, geometry second.** This ordering is the single most important decision here.
The naive approach — generate noise, then check the invariants — has no bound on retries and
produces maps whose structure is accidental. Building from a route skeleton makes I1 and I2 true
*by construction*.

```
built today (map/caves.ts):
  seed → skeleton   levels + connections, laid out against the height budget (map/skeleton.ts)
      → carve       the routes become discs, and the discs a signed field (map/carve.ts)
      → contour     the field's zero crossing becomes rock polygons (map/contours.ts)
      → measure     the polygons are read back and the guarantees checked (map/measure.ts)

not built:
  → decomposition   (free space → convex sectors + portals)            [§5 steps 7–9]
  → navmesh         (per-hull filtered; from the sector decomposition)
  → acoustic precompute (all-pairs sector propagation — superseded by the lattice, §6)
  → placement       (deployment zones, objectives, layer depths — I3, I6)
```

Notes on the steps that carry risk:

**Built steps.** The skeleton is a graph of **levels** (routes across the map, each guaranteed a
height class) joined by **connections** (vertical halls between neighbouring levels); carving
only ever *removes* rock, so no later step can break the width floors — which is also why the
plan's detail-and-re-erode pass (step 5) does not exist: detail here is widening-only roughness
and undulation, never rock put back (`caves.ts`, `tuning.ts`). Contour extraction simplifies the
marching-squares zero crossing (Douglas–Peucker). Validation is the last built step and it is a
**safety net, not the mechanism**: `measure.ts` asserts `hasOpeningAtLeast(minPassageWidth)` and
`hasRouteAtLeast(trunkPassageWidth)` and **throws** with the seed — a generator bug, never a retry
to tune.

**Absent steps.** The convex sector decomposition, the portal graph, the per-hull navmesh, and the
all-pairs propagation precompute are not built (`caves.ts`, "What is not here yet"). They are what
navigation and the *old* acoustic model would consume, and they belong with the simulation that
will consume them; nothing downstream can use them today. The contours the generator emits are the
input those steps would take, so adding them is additive rather than a rewrite. Acoustics today
does not need them at all: the water lattice (§6) rasterizes those same contours.

### Determinism
The generator is a pure function of `(seed, generatorVersion, params)`. It must be, because:
- Replays store the seed, not the geometry (04 §9). A map is a few hundred KB of polygons; a seed
  is 8 bytes.
- The server generates once and ships the map to clients; a client mismatch is a desync.
- Property tests over hundreds of seeds require reproducibility.

`generatorVersion` is bumped on any change to generation logic and is part of the replay
compatibility check alongside `contentHash`. **A map is content**, and changing the generator is
a content change with the same review requirements (05 §5).

## 6. Acoustics in caves — the water lattice

Dense terrain breaks the naive acoustic model in both directions: straight-line occlusion tests
are too expensive at this geometric complexity, and pure line-of-sight blocking would make
detection binary and most of the map acoustically dead.

**Solution: a water lattice.** The plan's sector/portal table (below) was replaced during
implementation by `sim/acoustics/lattice.ts`: at match start the terrain polygons are rasterized
onto a 20 m grid once, every rock cell remembers its nearest water cell, and each entity runs one
bounded Dijkstra sweep over that grid every acoustic tick — the shortest *geodesic through water*
around the rock, serving as the outbound path and, read the other way, the return leg of anything
it hears. The 1 m reflector skin (`sim/acoustics/skin.ts`) bins every surface square under the
lattice cell that can hear it, so the same rasterization answers "what do I draw." Cost is linear
in entities, bounded by `maxRange` (the honest stop) and `maxFieldCells` (the guardrail). Full
model in [03 §4–5](03-sonar-model.md).

Transmission loss over that geodesic (03 §4):

```
TL(r) = spreadingExponent · log10(r / referenceRange) + absorptionPerKm · (r − referenceRange) / 1000
     = 15 · log10(r / 10) + 22 · (r − 10) / 1000
```

### Three consequences, and their status

**1. Bearings point at cave mouths, not at boats — superseded.** This depended on the portal
model; the lattice reports square positions, so there is no bearing to point (03 §5.1). What it
buys instead: a boat around a corner is simply *not seen through the rock*, which is honest and
simple. The misdirection mechanic is kept as a future layer, not built.

**2. Passages are waveguides — not built.** Sound down a corridor spreading cylindrically rather
than spherically is not in the model; the lattice attenuates by geodesic length regardless of
passage shape. It is a candidate layer, not a promise.

**3. Open columns are terrifying — true today.** No occlusion and no rock reflections mean a loud
boat in a column is audible to the whole open region, bounded only by `maxRange`. The contrast
between open gallery and tight warren is the map's primary tactical texture, and it is already
what the built model produces.

### Active sonar in caves — not built
Active ping does not exist yet (03 §6). When it lands, ping wavefronts reflect off walls, so an
active ping in a cave system returns a great deal of terrain and comparatively little boat. Two
design consequences:
- **Pinging is much less useful in tight terrain** and much more useful in open columns —
  a nice self-balancing property that needs no rules.
- The returns trace **cave walls**, which is visually spectacular and is the single best moment
  the renderer will produce. Budget effort for it (09 §8).
- Echo return caps (03 §10) must be enforced per-frame or a ping in a warren will flood the
  channel. Prefer returns that are novel over ones re-confirming known geometry.

## 7. Fairness and symmetry

Procedural generation plus competitive play is a known hazard: a seed that favours one side is a
match decided before deployment.

**Recommendation: mirror the map about the vertical centreline** for both launch modes. Generate
the left half, reflect it, then stitch the seam with a Braid or Cathedral region so the join is
not visually obvious. Guarantees I3 exactly rather than statistically, and it is the standard,
boring, correct answer.

The cost is that mirrored maps are recognizably symmetric, which some players dislike and which
reduces the sense of a natural cave system. Mitigations: vary detail noise independently on each
half (structure mirrors, texture does not), and place layer depths asymmetrically since they
affect both sides equally.

[Q36: whether to offer an asymmetric option for casual lobbies. Recommend yes, off by default,
labelled clearly. Some players will prefer the character.]

## 8. Host controls

The lobby exposes generation controls, which replaces "pick a map from a list" (06 §3):

| Setting | Default | Notes |
|---|---|---|
| Map type | Dense | Empty / Sparse / Dense (§1.1). Dense is the base game. |
| Map size | Medium | Small / Medium / Large (§1.2). Medium is the base scale; fleet scaling (§9) applies on top. |
| Map seed | Random | Editable; shareable. Re-rolling regenerates the preview. |
| Symmetry | Mirrored | Mirrored / Asymmetric |
| Layer count | 2 | 1–3 |

**A map preview in the lobby is mandatory, not a nice-to-have.** Players must be able to see the
terrain they are about to fight in before locking a fleet, because fleet composition depends on
passage widths (05 §2). A Warren-heavy seed makes a Heavy fleet a bad choice, and the player
deserves to know that at build time. The preview is a small render of the generated map using the
same terrain renderer as the scope.

This makes the **fleet selection loop** in the lobby genuinely interactive: see the map, pick a
fleet suited to it, ready up. That is a better lobby experience than picking from three authored
maps and it comes free with generation.

## 9. Scaling with fleet size

Replaces the scale-factor approach in 06 §4, and resolves Q9. Rather than stretching a fixed map,
the generator takes **extents as a parameter**:

```
width  = baseWidth · mapSizeScale · clamp( sqrt(totalBoats / 24), 0.7, 1.8 )
height = baseHeight · mapSizeScale · clamp( sqrt(totalBoats / 24), 0.7, 1.8 )
regionCount = round(width / averageRegionWidth)
```

`mapSizeScale` is the lobby's Small/Medium/Large setting (§1.2); the boat-count term is the
fleet-scaling term this section describes. The two multiply, so a Large 24-boat match is a *longer*
cave system than a Medium 24-boat match, and a Large empty map is simply a larger arena.

Height scales with width: the old reason to mute it — hull crush depths and layer positions do not
scale — is gone, because **depth is no longer the map's height**. Depth is fixed at `MAP_DEPTH`
(§1.2) on every map and reached through `depthScale`, so a bigger map is a *bigger* cave system on
both axes without ever changing what a given depth means for a hull.
Because regions are generated to fill the width rather than stretched, there is **no distortion**
— a Choke in a 10-boat map is the same physical size as a Choke in a 2-boat map, there are simply
more regions between the deployment zones. This is strictly better than the scale-factor approach
and it removes the concern that made Q9 uncomfortable.

## 10. Navigation

Boats path through caves, which the previous open-water design did not require.

- **Navmesh** from the sector decomposition, with per-hull clearance filtering: a Heavy's navmesh
  is the subgraph of sectors and portals meeting its clearance.
- **A\*** over the filtered graph, then string-pulling for a smooth route, then the pitch-band
  constraint (04 §5) applied — a route requiring a 60° climb is invalid for a boat limited to 30°
  and must be re-planned or refused.
- **Orders that must handle "no route"**: the UI must clearly refuse a transit order to a point
  the selected hull cannot reach, and say why ("no route: passages too narrow for this hull").
  Silent failure here would be maddening.
- **"Follow the bottom"** (04 §5) is re-specified for caves: follow the floor of the current
  passage at a fixed offset. Still the quiet, masked, dangerous transit order.
- **Collision avoidance between boats** in narrow passages: [Q37] boats currently pass through
  each other. In a slot barely wider than one hull, that will look wrong. Recommend soft
  separation forces rather than hard collision, to avoid boats deadlocking in a corridor.

Pathfinding runs on order issue and on replan, **not every tick** — it is not in the tick budget.

## 11. Rendering implications

Terrain is now most of the screen (09 §2 needs revisiting for this).

- Terrain polygons go in a **static geometry buffer** built once at match start. Never
  re-tessellated.
- Charted-versus-sensed distinction (Q12) is a **per-vertex or per-edge attribute** modulating
  brightness, so revealing terrain is a cheap uniform/attribute update rather than new geometry.
- **Terrain is charted from match start.** Q12 resolves to "known." With cave navigation, route
  planning is impossible without knowing the geometry, and a match spent bumping into walls is
  not the game we are making. Charts are drawn dim; sonar returns make local geometry crisp and
  bright. What is *unknown* is what is in the caves, which is the part that matters.
- The visual density is a real risk: a warren rendered in glowing lines could be unreadable
  noise. Terrain must sit clearly *behind* the acoustic layer in the visual hierarchy — dimmer,
  cooler, thinner, and non-glowing (09 §4 `terrain` tokens exist for this). Validate legibility
  early; this is the most likely place the art direction fails.

## 12. Testing

Detail in 13. Generator-specific requirements, which are unusually important because a generator
bug is a *broken match*, not a visual glitch:

- **Property tests over ≥500 seeds** asserting every invariant in §3. This is the single most
  valuable test suite in the project after the ground-truth test, and it is cheap — the generator
  is pure and headless.
- **I1 verified by sampling** every `x` at 5 m intervals and running connected-component analysis.
- **I2 verified** by running the large-hull navmesh filter and confirming left-to-right
  connectivity.
- **Determinism test**: same seed and version → byte-identical output, across two runs in one
  process and across processes.
- **Performance test**: generation completes within budget (target < 2 s for a base-scale map,
  since it blocks match start), and acoustic precompute within its own budget.
- **A visual seed-gallery tool** (`pnpm map:gallery`) rendering a grid of generated maps for a
  range of seeds. Human review of a hundred maps at a glance catches "these are all boring" and
  "this archetype never appears," which no assertion will.

## 13. Open questions

Tracked in [12-open-questions.md](12-open-questions.md).

- **Q36** — asymmetric map option for casual lobbies.
- **Q37** — boat-versus-boat collision in narrow passages.
- **Q38** — do mines become oppressive in Chokes? A vertical curtain across a three-passage choke
  may be unbeatable. Likely needs a cost increase or a per-fleet mine cap.
- **Q39** — does terrain *damage* on collision stay, given that boats now routinely operate near
  walls? Recommend yes but with a grazing threshold, so brushing a wall at creep is harmless and
  hitting one at flank is not.
- **Q40** — should the generator guarantee a minimum number of Open Column regions? Without one,
  a seed could be entirely tight terrain, which would invalidate long-range hulls. Recommend at
  least one Column or Cathedral per map half.
