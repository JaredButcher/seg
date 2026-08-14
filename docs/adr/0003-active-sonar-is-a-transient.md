# ADR 0003 — Active sonar is a transient, not a wavefront

- **Status:** Accepted
- **Date:** 2026-08-08
- **Amends:** `planning/03 §3` (Active ping) and `§6` (Ping resolution), which described a
  different implementation of the same feature
- **Builds on:** ADR 0002, whose uncharted map is the thing a ping is *for*
- **Amended 2026-08-09:** the sentence below that "nothing in the solver knows what a ping is"
  is no longer the whole truth. The solver now knows exactly one thing about a pulse — that it
  is *filterable* — through `filterableNoiseFraction` (`content/acoustics.ts`): a ping still
  lights the water and is heard as a return at full strength, but contributes only a quarter of
  its power to anyone's noise floor, because a coherent tone can be notched out of a noise
  estimate where a bang cannot. The split lives on the emit side
  (`sim/acoustics/boats.ts#EmittedLevels`, `deafening` vs `filterable`) and is read once, in
  the solve, as a weighting on the background heatmap. It is deliberately the *narrowest*
  special case: it changes one weight in the noise floor, not the detection rule and not the
  imaging field, so the transient machinery the rest of this ADR defends is untouched. What
  follows is the 2026-08-08 decision, with the affected claims marked.
- **Amended 2026-08-14:** the two channels named above are gone, and nothing about the model
  they carried changed. `deafening` and `filterable` were buckets meaning "fraction 1" and
  "fraction `filterableNoiseFraction`"; the fraction now rides on each sound instead
  (`sim/acoustics/boats.ts#EmittedSound.noiseFraction`), and every transient kind can name its
  own through `TransientDef.noiseFraction`. **All nine take the default of 1**
  (`TRANSIENT_NOISE_FRACTION`) — a bang is broadband and there is nothing to notch out of one,
  which is this ADR's own argument — so a pulse remains the only sound in the game below full
  weight and every level in the game is what it was. What the generalisation buys is the lever
  being one number in the transient table rather than a channel to be sorted into. It costs the
  solve nothing: the fractions are folded once, on the emit side, into a single per-entity
  `deafeningLevel` (`AcousticEntity`), so the heatmap loop that used to weight a ping per cell
  now does one multiply per cell regardless of how many fractions are in play.

## Context

`planning/03 §6` has always specified active sonar in detail, and the specification is a
simulation of a real one:

1. emit an expanding wavefront, `r(t) = c · (t − t_ping)` at 1500 m/s;
2. each tick, find every entity the wavefront is currently sweeping over;
3. cast 6–16 rays across that entity's angular extent, keep only front-facing hits;
4. score each hit with aspect-dependent target strength;
5. queue the survivors to arrive back at the emitter at `t_ping + 2·range/c`;
6. draw them as points and arc segments that persist and decay.

It is a good design and it is the source of the game's intended signature visual. It is also a
second solver. Steps 2–5 share nothing with the passive path built in `sim/acoustics/`: they
need per-entity wavefront tracking, an angular ray cast against a silhouette, an aspect model
(explicitly cut from the material model — see `content/acoustics.ts#Material`), and a delayed
event queue that survives the emitter dying before its own echo comes home.

Meanwhile the thing that made active sonar *urgent* was not the visual. It was `03 §9.1`: a
stopped boat images 89–179 m, a boat with a teammate 500 m away images about 55 m, and a match
therefore opens on a screen with nothing on it. §9.1 closes by naming the fix — "the active ping
(§6) is the designed answer to wanting more."

So there were two things wanted from one feature, and only one of them needed the second solver.

## Decision

**A pulse is a very loud transient. The solver knows exactly one thing about it — that it is
filterable — and nothing else.**

- `pingLevel` is a stat (108 / 116 / 124 dB by hull), fitted like any other, raised by one
  module. It is sixty to seventy decibels above the boat that carries it.
- `activePingLevel` rings a pulse down linearly over `pingSeconds` (0.4 s), exactly the way
  `transientLevel` rings down a torpedo launch, and the result is handed to the solve through
  `EmittedLevels.filterable` — the channel for sounds a listener can notch out of its noise
  estimate. A bang arrives through `deafening` instead, and power-sums onto the source level
  exactly as `EmitState.transients` did before.
- Everything else falls out. The pulse lights the rock around its own boat because *any* loud
  thing lights the rock around it. It hands every listener within a couple of kilometres a
  strong direct arrival because a source level is a source level. Neither behaviour is coded.
  The one addition is that the pulse contributes less to a listener's noise *floor* than a bang
  of the same level — `filterableNoiseFraction`, 0.25 — so a pinging boat is still the easiest
  thing in the game to find, without being a floodlight that hides everything else.
- Active sonar is a **posture** — `activeSonar` on `BoatState`, flipped by
  `match.setActiveSonar` — pulsing every `pingIntervalMs` (**2000 ms**) until switched off. The
  interval is measured from the last pulse, so toggling cannot outrun it.
- The client draws an expanding ring and plays a panned tone on each friendly pulse. **Both are
  presentation.** The ring is not the wavefront and nothing is resolved against it.

### What this buys, measured

`03 §9.2`, taken after it landed:

| Hull | Images a hull to | Heard by the enemy at |
|---|---|---|
| Light | 400 m | 2200 m |
| Medium | 400 m | 2400 m |
| Heavy | 600 m | 2600 m |

And against rock — the number that mattered — a stopped boat charting **zero** squares in two
seconds charts **2100–2700** with the switch on.

## Consequences

**Good.**

- **The opening screen has an answer.** ADR 0002 accepted "the opening screen is dark" as a
  cost and `9.1` found it darker than expected. A player who wants to see something before they
  get under way now has a control that does it, at a price they choose to pay.
- **The trade the design always wanted is arithmetic rather than a rule.** "Powerful Active
  Sonar trades a bigger detection radius for a bigger self-broadcast radius" (`03 §3`) is one
  `+8 dB` modifier on one stat, and both halves of the sentence come out of it.
- The asymmetry is severe in the right direction: you are heard four to six times further than
  you can see. Pinging is genuinely dangerous, which is what makes the switch a decision.
- It cost no new solver phase, no aspect model, and no delayed-event queue — so the wavefront
  design in `§6` is still available, undamaged, and now has a working feature to be an upgrade
  *to* rather than a prerequisite *for*.
- It is the project's first **command**, and it settled the shape of one cheaply: names a
  target, idempotent, no acknowledgement, answered by the view frame the player is already
  receiving. Whatever the second command is, it inherits that.

**Costs, accepted.**

- **The signature visual is not built.** No traced near-side outline, no arc segments, no
  accumulating picture from repeated pulses. What a ping produces is the ordinary vision-square
  picture, brighter and further out. `03 §6` is unamended about what it wants; this is a
  different, cheaper thing standing where it will go.
- **There is no round trip, so there is no wait, so there is no drama.** `§6` says "the wait is
  the drama. Do not shorten it" — and this shortens it to zero: the returns are in the same
  solve as the pulse. The drawn ring is a deliberate attempt to buy back some of the *feel* of
  a wait that is not happening, and it should be understood as compensation rather than as the
  thing itself.
- **`03 §9`'s 2500 m active detection range is out by a factor of four** against hulls. See
  `§9.2` finding 1. The lever is `hullAbsorption`, which nothing else reads, and it is deferred
  to the balance harness (`§11`) along with everything else in that file.
- **A pulse is the most expensive thing one boat can ask of the server.** Its field sweeps to
  `maxRange` because it genuinely is audible that far, so a ping tick costs roughly four times
  a quiet one in swept lattice cells. `pingSeconds` is 0.4 rather than a rounder number
  partly for this: four solves lit, six dark. `maxFieldCells` remains the hard guardrail and
  `SolveStats.clippedFields` remains how anyone would find out it was binding.
- **The client's fleet-row indicator hard-codes the pulse period in CSS.** A two-second
  animation matching `pingIntervalMs`, kept in step by hand. It is the same class of duplication
  as the CSS colour tokens mirroring `render/palette.ts`, and it is called out in both places.

**Neutral.**

- An enemy pulse draws no ring. It does not need one: a pinging boat is the easiest thing in the
  game to detect, and it arrives through `VisionFrame` like everything else. Drawing hostile
  rings would mean the client being told about an event it had not earned.

## Alternatives considered

**Build `§6` as specified.** The honest option, and the one to come back to. Rejected for
sequencing rather than on merit: it is a second solver, and the problem that made active sonar
urgent (`§9.1`) is solved entirely by the loud-transient half. Building the expensive half first
would have delayed the cheap fix behind it.

**Make the ping a one-shot rather than a posture.** Closer to `§6`'s framing, where a ping is an
event at tick `t`. Rejected because it makes the interesting decision uninteresting: a player
who can fire a single pulse takes the picture at the moment of least risk and pays almost
nothing. A switch that keeps announcing you until you throw it back is a commitment, and a
commitment is a decision.

**Give the pulse its own detection threshold or its own imaging cap**, so it could out-range the
passive picture by fiat. Rejected on principle — the whole value of the transient approach is
that a ping is not special-cased anywhere — and on arithmetic: at 22 dB/km the round trip is
44 dB/km, so a longer imaging field would sweep thousands of lattice cells that could never
clear a threshold. If active sonar should see further, the answer is a material constant, not
an exception. The 2026-08-09 amendment stands this rejection on its wording: the one special
case that *was* added is a weighting on the noise floor rather than a detection rule, and it is
kept as narrow as that — a listener knows a ping is easy to hear through, and nothing else about
it.
