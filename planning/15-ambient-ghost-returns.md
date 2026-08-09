# 15 — Ambient Ghost Returns

**Status:** plan, not built. Numbers are first-pass placeholders in the sense of
[README](README.md) — concrete so the thing can be built, and expected to move under the balance
harness.

## 1. What it is

A boat's own machinery smears its own sonar picture. The player sees this as **ghost returns**:
single sonar-green squares that flicker into existence at random points around one of their own
boats, and fade out faster than a genuine return does. The halo reaches as far as an active pulse
does — `1000 m` — but it is **dense against the hull and thin at the rim**, so it reads as a boat
sitting in a knot of its own racket rather than as a uniform kilometre of snow.

Three properties, from the request, and everything below serves them:

- **They are individual squares.** Not clusters, not shapes. One square, one flicker. A ghost that
  drew four adjacent squares would read as a contact and be a lie the player could act on; one
  square reads as a speck of noise, which is what it is.
- **Frequency rises with noise.** All-stop and undamaged → literally none. Flank speed with the
  screw cavitating → several per second.
- **They are generated on the simulation side.** The client draws what it is sent. It does not
  roll dice about its own picture — that is the same rule that keeps the chart honest
  ([03 §5.3](03-sonar-model.md), [ADR 0002](../docs/adr/0002-uncharted-terrain.md)), and a
  client-side ghost generator is a client-side ghost *disabler* for anyone with devtools.

### Why it is worth building

The game already has a stealth/vision trade — going fast makes you loud and makes you deaf
(`selfNoiseOf`, `sim/acoustics/solve.ts`'s header on all-stop being the best listening posture).
That trade is currently invisible except as an *absence*: a fast boat sees fewer squares, which
looks like nothing happening. Ghosts turn the penalty into something on the screen. The player at
flank speed is not shown less — they are shown **more, and some of it is wrong**, which is a far
better teacher than an empty scope and is the honest reading of what a swamped array does.

It also puts a real cost on the one thing the picture currently has no counter to: sitting at
flank and reading the scope anyway.

## 2. The load-bearing decision — how the client knows to fade them faster

A ghost has to fade faster than a normal return. Fading happens on the client (`CELL_FADE_MS`,
`render/picture.ts`), so the client has to be able to tell them apart *somehow*. There are two
ways, and they are not equally good.

### Option A (recommended) — fade time is a function of strength, and ghosts are faint

No wire change at all. Generalize the client's fade so that **a faint square fades faster than a
strong one**:

```ts
// render/picture.ts
export const CELL_FADE_MS = 1_400;   // unchanged: a return at or above confirmation
export const FAINT_FADE_MS = 400;    // a return that barely cleared detection

function fadeMsFor(excess: number, confirmAt: number): number {
  const t = confirmAt <= 0 ? 1 : Math.min(1, Math.max(0, excess / confirmAt));
  return FAINT_FADE_MS + (CELL_FADE_MS - FAINT_FADE_MS) * t;
}
```

Ghosts are then emitted with a deliberately low signal excess — uniform in
`[0, 0.25 · confirmationThreshold]`, i.e. `0–2 dB` against today's table — so they fade in
`400–650 ms` against a confirmed return's `1400 ms`.

Why this is the better option:

- **The wire still never says what a square is.** `sim/acoustics/solve.ts` and `match/vision.ts`
  are both explicit that the picture must not label a square as rock, hull, or anything else, and
  that the client is "not deciding, it is simply drawing three independent things that happen to
  overlap". A `ghost: true` flag on the wire breaks that rule for the first time.
- **A cheating client gains nothing.** Ghosts arrive in the same `cells`/`strength` arrays as
  everything else and are indistinguishable from a genuine marginal return. There is nothing to
  filter out.
- **It improves the existing display on its own merits.** A square that barely cleared detection
  *should* be more ephemeral than one that cleared it by twenty decibels. Today they persist
  identically for 1.4 s, which overstates how much the sonar knows. This is a fix the picture
  wants regardless of ghosts.
- **Genuine faint returns are not hurt by it.** A real faint return off a wall is re-lit every
  solve (100 ms) and so is continuously refreshed; the shorter fade only bites on squares that
  stop being heard, which is exactly the intended behaviour.

The cost: "fades faster than a normal return" becomes "fades as fast as an equally faint return".
A ghost is not *specially* short-lived, it is short-lived *because* it is weak. That reads as the
same thing on screen and is a stronger design.

### Option B — a dedicated `ghosts` field on `VisionFrame`

`VisionFrame` gains `readonly ghosts: readonly number[]` (packed, delta-encoded, same as `cells`)
and the client draws them from a separate map with a flat `GHOST_FADE_MS ≈ 400`.

Simpler to reason about and gives an exact, independent fade knob. The price is that a modified
client drops one array and gets a clean picture at flank speed — a real competitive advantage,
and the first hole in the "the client is never told which is which" position.

If Option B is chosen anyway, the mitigation to build **at the same time** is to route a random
minority of *genuine* faint returns through the same array, so stripping it costs the cheater real
detections too. Do not ship B without that.

> **Decision needed before implementation.** The rest of this document assumes **Option A**;
> §6 marks the two places that change under B.

## 3. The rate model

### The driver

Rate is a function of one number: **how much louder a boat is than its own quietest self**.

```
excess_dB = sourceLevelOf(boat) − boat.stats.sourceLevel
```

`sourceLevelOf` (`content/acoustics.ts`) already sums flow noise, the cavitation cliff and its
slope, the damaged penalty, hull stress below test depth, and any transients still ringing. So
this one subtraction gets all of it for free, and it is **zero at all-stop for an undamaged boat
above its test depth** — which is the request's "a still, quiet ship should have none", satisfied
by construction rather than by a special case.

Deliberately *not* `selfNoiseOf`: self-noise is a pure function of speed and would miss the
cavitation cliff, damage, hull groan, and the boat's own transients, all of which should ghost.
Deliberately *not* the raw source level: a Heavy at rest is 58 dB and a Light at rest is 41 dB,
and a Heavy sitting still is not "noisy" in the sense that matters here.

### The curve

Linear in decibels above a small deadband, capped:

```
rate_per_second = ghostRateMax · clamp01((excess_dB − ghostNoiseFloor) / ghostNoiseSpan)
```

Linear in dB is already quadratic in speed, because `flowNoiseSpan · f²` is. No extra exponent is
wanted.

### Proposed tuning — new fields on `AcousticTuning`

| Field | Value | Meaning |
|---|---|---|
| `ghostRadius` | `1000` | Metres from the listening boat a ghost may appear within. |
| `ghostInnerRadius` | `0` | Metres from the boat kept clear. See the note below. |
| `ghostFalloffExponent` | `1.75` | Ghosts per square metre fall as `r^−this`. `0` is a flat disc. |
| `ghostNoiseFloor` | `1` | dB above rest before any ghost appears. The "genuinely silent" band. |
| `ghostNoiseSpan` | `45` | dB above the floor at which the rate reaches its maximum. |
| `ghostRateMax` | `7.5` | Ghosts per second per boat, at full rate. |
| `ghostExcessFraction` | `0.25` | Ghost signal excess is uniform in `[0, this × confirmationThreshold]`. |

These belong in `content/acoustics.ts` beside everything else, not in the new module — the file
header's promise is that every dB and every acoustic knob in the game is in that one table.

### What those numbers produce — a Light (`maxSpeed 15`, `cavitationSpeed 6.5` at 200 m)

| State | `excess_dB` | Rate | Reads as |
|---|---|---|---|
| All stop | 0 | **0 /s** | Clean scope. |
| 3 m/s (creep, `f = 0.2`) | 1.0 | 0 /s | Still clean — creeping is genuinely quiet. |
| 5 m/s (`f = 0.33`) | 2.8 | 0.3 /s | A speck every few seconds. |
| 6.4 m/s (just under cavitation) | 4.6 | 0.6 /s | Occasional. |
| 6.6 m/s (just over) | 22.9 | **3.6 /s** | The cliff, visible on the scope. |
| 15 m/s (flank, cavitating) | 55 → capped | **7.5 /s** | Several per second. |
| Flank + damaged | 60 → capped | 7.5 /s | Capped; damage shows below flank instead. |

Rates are per boat over the whole halo. About two thirds of them land inside the old `200 m` disc,
so the figure a player reads *against their own hull* is the `5 /s` the first cut produced — the
radius and `ghostRateMax` were raised together for exactly that reason.

The jump at the cavitation threshold is the point. A player who does not know their cavitation
speed will learn it by watching their own picture go to pieces the moment they cross it, which is
the kind of thing this game should teach without a tooltip.

### Sampling

Solves run at `ACOUSTIC_TICK_HZ = 10`, so per boat per solve:

```
λ = rate_per_second / ACOUSTIC_TICK_HZ            // ≤ 0.75 at ghostRateMax = 7.5
n = floor(λ); if (rng.chance(λ − n)) n += 1
```

At the proposed maximum this is a Bernoulli trial — at most one ghost per boat per solve — but the
general form is written so raising `ghostRateMax` past 10 does not silently clamp.

## 4. Placement

For each ghost, in the boat's frame:

```
p = 2 − ghostFalloffExponent
r = (ghostInnerRadiusᵖ + u · (ghostRadiusᵖ − ghostInnerRadiusᵖ))^(1/p)     u, v ~ U[0,1)
θ = 2π · v
```

This is the inverse CDF of an areal density falling as `r^−ghostFalloffExponent`: the fraction of
ghosts inside `r` is `(rᵖ − innerᵖ)/(radiusᵖ − innerᵖ)`. At `ghostFalloffExponent = 0` it is `p = 2`
and the whole thing collapses to `ghostRadius · sqrt(u)` — the ordinary uniform-over-area disc,
which is what the halo was while it was only `200 m` across.

The falloff is what buys the wide radius. Flat density over `1000 m` is twenty-five times the area
at the same clutter, and it would say nothing about where the noise is coming from — every range
ring equally haunted. At `1.75` the density at the rim is a seventeenth of the density against the
hull. `p` must stay positive: at `ghostFalloffExponent = 2` the density integrates logarithmically
and a zero inner radius has no answer at all, so `ghostRadiusFor` clamps `p` rather than dividing
by zero.

Then the point is converted to a packed vision-grid square with `packVisionCell` /
`visionGridFor` (`sim/acoustics/skin.ts`) and **discarded if it falls outside the grid**. Do not
clamp — clamping would pile ghosts against the map edge and draw a bright line along it for any
boat running near the boundary.

Three deliberate non-rules:

- **No terrain test.** A ghost may land inside rock, on a charted wall, or in open water. This is
  not laziness: a ghost that avoided rock would tell the player where rock *is not*, which is a
  free map reveal delivered by the noise system. A ghost is an artefact of the listener's own
  processing, not an object in the world, and it has no business knowing where the walls are.
- **No line-of-sight test**, for the same reason and at the same saving.
- **No de-duplication against other boats' ghosts.** Two boats 100 m apart both haunting the water
  between them is correct.

Squares that collide with a genuinely lit square in the same frame are dropped at merge time
(§5) — the real return wins, and `packCells` requires a strictly ascending run anyway.

> **Note on `ghostInnerRadius` and the Heavy.** The Heavy's hull is ~170 m long, and the falloff
> puts the halo's densest part right on top of it. Ghosts will freckle the player's own silhouette. That may
> well look right — it is their own noise — but if it reads as clutter on the one marker that must
> stay legible, set `ghostInnerRadius` to about `60` and the halo moves off the hull. Left at `0`
> so the first playtest sees the unadorned version.

## 5. Where the code goes

### New — `packages/shared/src/sim/acoustics/ghosts.ts`

A pure function, exported from the `sim/acoustics` barrel:

```ts
export interface GhostSource {
  readonly pos: Vec2;
  /** dB above this boat's own rest level. Zero for a silent boat. */
  readonly excess: number;
}

export interface Ghost {
  /** Packed vision square (`skin.ts#packVisionCell`). */
  readonly cell: number;
  /** Signal excess, dB. Always below `confirmationThreshold`. */
  readonly excess: number;
}

export function ghostRate(excessDb: number, tuning?: AcousticTuning): number;

export function generateGhosts(
  sources: readonly GhostSource[],
  grid: VisionGrid,
  rng: Rng,
  seconds: number,          // the solve interval, 1 / ACOUSTIC_TICK_HZ
  tuning?: AcousticTuning,
): Ghost[];
```

**Not in `solve.ts`.** The solver is a hot numeric loop with no RNG in it and no notion of a wall
clock, and it is the one file in the acoustic model that has to stay cheap. Ghosts are a handful
of squares per tick attached to a listener; they do not belong in a pass that walks tens of
thousands of cells. Keeping them out also keeps `AcousticSolver.solve` a pure function of its
entity list, which several tests depend on.

### Changed — `packages/shared/src/match/vision.ts`

`VisionSnapshot` gains `readonly ghosts: readonly Ghost[]`, and `TeamPicture` gains a way to
receive them. The critical property, and the one the tests must pin:

> **Ghosts never touch `TeamChart` and never touch `ContactBook`.**

They are folded in **after** `select()` and are not run through the confirmation pass at all. A
ghost that confirmed would put a permanent fake rock square on the team's chart for the rest of
the match, which is unrecoverable — rock does not un-confirm. Their excess is capped well below
`confirmationThreshold` as a second belt, but the structural separation is the real guarantee.

Shape:

```ts
observe(vision, tick, seconds, look, ghosts: readonly Ghost[] = []): VisionSnapshot
```

and inside, after `select`, merge into the ascending `cells`/`excess` pair:

- drop any ghost whose cell is already present in `selected.cells`;
- drop any ghost whose cell is on `this.chart` (it would draw green over known rock, which is a
  false "something moved against that wall");
- merge the rest in ascending order — both lists are already sorted, so it is a linear merge, not
  a re-sort.

Ghosts are appended *after* the `maxWireVisionCells` selection rather than competing in it. There
are at most `fleetSize` of them per frame (≤ 10, and ≤ 5 in practice), so they cannot meaningfully
inflate the frame, and making them compete would let a noisy boat evict its own real returns —
the penalty should be clutter, not blindness.

`settle()` takes ghosts too: a team with every hydrophone destroyed produces none, but a team
mid-solve-gap should not have its halo stutter.

### Changed — `packages/server/src/match/runtime.ts`

```ts
/** The stream ambient ghosts are drawn from. Pure in the map seed, independent of respawns. */
private readonly ghosts: Rng = ghostRng(state.map.seed);
```

`ghostRng` goes beside `respawnRng` / `initialLayoutRng` in `match/objectives.ts`'s pattern —
or better, a new tiny export next to them so all three salts are visible in one place.

In `solve()`, after `this.solver.solve(entities)` and before the `observe` loop, build one
`GhostSource[]` per team from that team's **alive, listening** boats:

```ts
const excessOf = (boat: BoatState): number =>
  sourceLevelOf({ stats: boat.stats, speed: boat.speed, depth: depthAt(extents, boat.pos.y),
                  damaged: isDamaged(boat), transients: levels.deafening })
  - boat.stats.sourceLevel;
```

`levels` is already computed a few lines above for `boatEntity`; hoist it into a local so the
figure is computed once and the ghost rate and the acoustic entity cannot disagree about how loud
the boat is.

Iterate **boats in id order** when drawing, so the RNG stream does not depend on array order.
A destroyed boat has no hydrophone and contributes nothing.

Then pass the result into `observe(...)` / `settle(...)`.

### Changed — `packages/client/src/render/picture.ts`

Under Option A this is the whole client change:

- add `FAINT_FADE_MS` and `fadeMsFor(excess, confirmAt)` as above;
- `cellIntensity` uses `fadeMsFor(entry.excess, confirmAt)` instead of the flat `CELL_FADE_MS`;
- `expire(now)` uses the same per-entry fade instead of the flat constant.

Nothing else moves. Ghosts arrive in `frame.cells`, land in `lit`, are drawn by the existing
banded fill in `render/sonar.ts`, and expire on their own.

The mini-map needs no change — it deliberately does not draw the transient layer
(`ui/hud/MiniMap.tsx`), which is exactly right here: a ghost must never leave a mark on the
strategic view.

### Under Option B instead

`VisionFrame` gains `ghosts: readonly number[]`, `packCells`-encoded; `SonarPicture` gains a
second map with a flat `GHOST_FADE_MS`; `sonar.ts#drawTransient` iterates both. `NO_VISION` gains
`ghosts: []`. No change to `cellIntensity`.

## 6. Determinism

The whole simulation is a pure function of `(seed, inputs)` ([04 §9](04-simulation-core.md)), and
`Math.random()` is lint-banned under `sim/`. Ghosts must not be the exception:

- one `Rng` owned by the runtime, forked from the map seed with its own salt, so adding ghosts
  does not shift the respawn or layout streams;
- drawn in a fixed order — boats sorted by `EntityId`;
- **no draws at all for a boat whose rate is zero**, which is fine: the skip condition is a
  function of state, so the same state produces the same stream.

A ghost is presentation-facing but it is *simulation state* by this definition, and a replay that
haunted different squares would not be a replay.

## 7. Tests

**`packages/shared/test/acoustics-ghosts.test.ts`** (new)

- A source at `excess = 0` produces zero ghosts over a thousand solves. This is the request's
  headline property and deserves to be the first test in the file.
- Rate is monotone non-decreasing in `excess`.
- `ghostRate` at `ghostNoiseSpan + ghostNoiseFloor` and above equals `ghostRateMax`.
- Over a thousand solves at flank, the observed count is within a few percent of
  `ghostRateMax × seconds`.
- Every ghost cell decodes to a point within `ghostRadius` of its source, and outside
  `ghostInnerRadius` when that is non-zero.
- The halo thins with range rather than filling the disc: well over half the ghosts land in the
  inner half of the radius, where a flat disc would put a quarter there.
- `ghostRadiusFor` spans exactly the annulus, is monotone in its draw, matches the closed-form
  quantiles of the `r^−exponent` density, collapses to `radius · sqrt(u)` at exponent zero, and
  stays finite at and past the singular exponent `2`.
- Every ghost's excess is `< confirmationThreshold`.
- A source near the map edge produces no out-of-grid cells and no cells that wrapped to the
  opposite edge (the row-wrap trap — see `picture.ts#chart`'s `col > 0` guard for the same bug
  class).
- Same seed, same sources → identical cells. Different salt → different cells.

**`packages/shared/test/match-vision.test.ts`** (extend)

- A frame carrying ghosts leaves `chart.size` unchanged, across many solves. **The important
  one** — a ghost on the chart is permanent corruption.
- Ghosts do not mint contacts.
- A ghost on a cell already in `selected.cells` is dropped, and the frame's packed run is still
  strictly ascending (feed it through `unpackCells` and check length and order).
- A ghost on an already-charted cell is dropped.
- Ghosts do not increase `dropped`.

**`packages/client/test/`** (extend the picture tests)

- A cell at excess `0` is gone by `FAINT_FADE_MS`; a cell at excess ≥ `confirmationThreshold`
  survives to nearly `CELL_FADE_MS`.
- A faint cell that is re-sent every 100 ms never disappears — the refresh path still works with
  a short fade.

**Scenario, for the corpus in [13](13-testing.md)**

- One boat, all stop, thirty seconds: zero ghosts in every frame.
- One boat accelerating from stop to flank: ghost count per second rises monotonically and jumps
  at the cavitation crossing.

## 8. Risks and things to watch

- **Clutter at fleet scale.** Five boats at flank is ~38 ghosts a second, though spread over a
  kilometre now rather than piled into a 200 m disc. It may
  read as static rather than as noise. `ghostRateMax` is the knob; a per-team cap is the fallback
  if per-boat tuning cannot fix it.
- **They will be mistaken for contacts, and that is the point** — but only up to a point. If
  playtesters chase them for more than a few seconds, `ghostExcessFraction` is too high and they
  are too bright. Lowering it makes them dimmer *and* shorter-lived at once under Option A, which
  is a convenient single dial.
- **Interaction with the picture cap.** Ghosts bypass `maxWireVisionCells` by design (§5). If the
  fleet size cap ever rises well past 10, revisit — the bypass is safe only because the count is
  bounded by the number of boats.
- **Bandwidth.** ≤ 1 extra square per boat per frame, delta-encoded, against a 1500-square
  budget. Below the noise floor of [ADR 0002](../docs/adr/0002-uncharted-terrain.md)'s concern.
- **Ghosts and the objective/results screens.** None: ghosts never confirm, never contact, never
  tally. Nothing downstream of `VisionSnapshot.cells` reads them.

## 9. Order of work

1. `content/acoustics.ts` — the seven tuning fields.
2. `sim/acoustics/ghosts.ts` + its test. Standalone and fully testable before anything consumes it.
3. `match/vision.ts` — the merge, and the "never confirms" tests.
4. `server/match/runtime.ts` — the RNG, the source list, the wiring.
5. `client/render/picture.ts` — the strength-linked fade and its tests.
6. Playtest, then tune `ghostRateMax`, `ghostExcessFraction`, `ghostFalloffExponent`, and
   `ghostInnerRadius` in that order.

Steps 1–4 are shippable without step 5: ghosts would appear and fade at the normal 1.4 s rate,
which is wrong but not broken, so the client change is not a blocking dependency.
