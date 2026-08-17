# 16 — Acoustic Performance

**Status:** §3.1 (the field cache), §3.2 (the traversability mask), §3.6 (the reflection pass's
skin test), §3.8 (its derived stopping range) and §3.9 (the sparse heatmap) are **built**; §3.3 is
withdrawn; §3.4 was built, measured and **reverted**; §3.7 was measured and **rejected**; §3.5 and
§5 remain proposals. The measurements in §1–2 are real and reproducible
(§6); every estimate says whether it was measured or derived.

> **Built 2026-08-14 — §3.1, the field cache.** Measured **~5× on the fields phase** at a 16-boat
> fleet moving at 12.5 m/s, against the 5–10× §3.1 estimated. The projection in §4 held in shape as
> well as in size: **the sweep is no longer the expensive part** — `heatmap` and `look` are, exactly
> as predicted. Details in §3.1.5.
>
> **Built 2026-08-14 — §3.2, the traversability mask.** Re-measured at **~1.4× on the sweep**
> against the 2.1–3.0× recorded here, and worth low single-digit percent end to end now that the
> cache means only ~9% of fields are swept at all. **§3.3 is withdrawn** — dropping the `??`
> fallbacks from the sweep now measures nothing. Both corrections, and the one that *did* pay, are
> in §3.2.1.
>
> **Tried and reverted 2026-08-14 — §3.4, the radius split.** Built, measured, and taken back out;
> the code is not in the tree. The emission half was free and worth 1.33× on `heatmap`; the imaging
> half was worth 2.2× on `look` but **deleted ~4% of the vision squares**. What the exercise turned
> up is worth more than the speed was: **`maxImagingRange` does not do what its own doc comment
> says**, and that is now Q-16.3. See §3.4 for what was learned.
>
> **Built 2026-08-14 — §3.6, asking whether a cell holds anything before computing its return.**
> **1.33× on `look`**, exact, about ten lines. Found by instrumenting the pass rather than
> reasoning about it: **98% of the water a listener sweeps carries no rock and no hull**, and every
> one of those cells was being charged a `factorAt` and a scattered heatmap read before the loop
> discovered there was nothing there. This is most of what §3.4's imaging half offered, without
> touching the picture. §3.6.
>
> **Built 2026-08-14 — §3.8, stopping the reflection walk where nothing can still light.**
> **1.66× on `look`**, exact, and it cuts half to three quarters of the cells in every scenario
> tried. This is what §3.4 was reaching for, derived from the tick's own numbers instead of
> asserted by a constant — so unlike §3.4 it provably cannot drop a square, and does not.
>
> **Anyone resuming this work should instrument before optimizing.** §3.4 spent its effort on a
> plausible-sounding structural change that turned out to delete detections, while a third of the
> phase was sitting in the loop's branch order. Ten minutes of counters found it.
>
> **Built 2026-08-14 — §3.9, writing the heatmap only where something reads it.** **1.8× on
> `heatmap`**, ~1.2× on a whole solve. Since §3.6 the reflection pass reads the heatmap only at
> cells carrying skin, so 98.5% of it was being computed for nobody. This is the first change here
> that alters what the solver *offers*: the heatmap is sparse, `NoiseHeatmap.complete` says so, and
> the debug overlays and the probe now declare what they need — §3.9.1 is the part to argue with.
>
> **A 16-boat solve is 5.1 ms, from 30.5.** No phase dominates any more: `fields`, `look` and
> `heatmap` are within a whisker of each other at every fleet size. Whatever comes next should
> start by re-running `pnpm bench:acoustics`, because everything in §4 below is now stale.

This document exists because the profiling answered "which phase" and stopped there. The field
sweep is **61–70% of an acoustic solve**, and that number is stable across fleet sizes, which means
it is structural rather than a spike worth chasing. What follows is why it costs what it does, what
can be done about it in what order, and the one invariant the largest of those changes rests on.

> Read [03 §5, §10](03-sonar-model.md) first for the model itself. This is a document about the
> *program*, in the sense [`match/perf.ts`](../packages/shared/src/match/perf.ts) means it — the
> field segment is `sim/acoustics/field.ts`, and nothing here proposes changing what it computes.

## 1. What a tick costs today

Measured on `dense`/`medium` (a 500×200 lattice, 100 000 cells, 90 596 of them water), seed 11,
medium hulls at `45 dB` with one of them mid-pulse at `90 dB`. Reproduce with
`pnpm bench:acoustics` (§6).

| fleet | solve | fields | look | heatmap | hulls | reset |
|---|---|---|---|---|---|---|
| 8 | 14.1 ms | **8.6 (61%)** | 2.3 | 2.3 | 0.7 | 0.1 |
| 16 | 30.5 ms | **19.4 (64%)** | 5.4 | 4.5 | 0.9 | 0.1 |
| 32 | 38.5 ms | **26.8 (70%)** | 6.0 | 4.6 | 0.9 | 0.2 |

### 1.1 The budget is smaller than it looks

The solve runs at `ACOUSTIC_TICK_HZ` — every second sim tick — but it runs *inside* one tick's slot
when it runs, so the figure it has to fit is `1000 / SIM_TICK_HZ` = **50 ms**, which is what
`server/match/perf.ts` already compares it against.

And that 50 ms is not this match's. `server/match/clock.ts` ticks **every running match on the
process through one `setInterval`, serially**, deliberately (its header explains why it does not
catch up). So a 16-boat match at 30 ms is not "60% of its budget" — it is 60% of the budget for
every match on the box. This is the single most important framing in this document and §5 turns on
it.

## 2. Why the sweep is expensive

Four contributors, in the order they matter.

### 2.1 Cells go as the square of the radius, and the radius is set by a floor

`reachOf` (`sim/acoustics/solve.ts`) sizes a field as
`min(maxRange, max(emissionReach, maxImagingRange))`. For a boat that is not pinging, the emission
term loses:

| source level | reach on the ambient tail | field radius after the floor |
|---|---|---|
| 45 dB (cruising) | 870 m | **1200 m** — the floor |
| 60 dB | 1409 m | 1409 m |
| 90 dB (pulse) | 2592 m | 2592 m |

Measured, 16 boats, `PINGERS=0`: 137 414 field cells, **8 589 per entity, all of it the imaging
floor**. On a quiet map the acoustics are not deciding what the sweep costs — `maxImagingRange` is,
on its own, for every listener. Because cells go as `r²`, that constant is a quadratic lever and
`content/acoustics.ts` already says so in as many words.

### 2.2 A pulse is the most expensive object in the game

| reach | cells in one sweep |
|---|---|
| 1200 m (imaging floor) | 3 751 |
| 4000 m (`maxRange`) | 29 403 |

One boat at `maxRange` is roughly **eight times a quiet boat's entire field**. Measured on the
16-boat fleet, each pinger added 10 000–24 000 cells. `pingSeconds` is already tuned partly as a
cost decision; this is the number behind that comment.

### 2.3 Per-cell cost is 120–140 ns, and most of it is not the algorithm

Every cell popped visits eight neighbours, and each neighbour pays:

- two bounds compares on the row, two on the column;
- a `water[]` read;
- on the four diagonals, the no-corner-cutting rule — **two further `water[]` reads**;
- a `?? ` fallback on every typed-array read, which `noUncheckedIndexedAccess` requires and V8
  compiles into a real `undefined` check. `field.ts` has eleven of them inside the sweep.

None of that changes between ticks, or between matches: the lattice is built once and never touched
again. It is fixed geometry being re-derived ten times a second.

### 2.4 Nothing is reused, between entities or between ticks

`FieldArena.reset()` drops every field at the start of each solve. Two boats 30 m apart sweep
near-identical fields; a boat that moved 1.5 m since the last solve gets a complete re-sweep. §3.1
is entirely about this.

### 2.5 What is *not* the problem

The bucket queue. Measured **1.07–1.11 pushes per stored cell**, so stale-entry churn is
negligible and the O(1) pop is doing its job. Replacing it with a heap, or adding decrease-key,
would cost more than it recovers. This is written down so nobody re-derives it: the queue looks
like the suspicious part and it is not.

## 3. Proposals

Ranked by payoff *as first written*, and left in that order so the estimates can be read against
what they turned out to be worth. §3.1 and §3.2 are built; §3.3 is withdrawn. The live proposal is
§3.4.

### 3.1 Cache fields by start cell

**BUILT 2026-08-14. Measured 7.0× on the fields phase** (estimate was 5–10×, derived from a
measured hit rate). `sim/acoustics/field.ts`; results and surprises in §3.1.5.

#### 3.1.1 The invariant

Checked over **1 338 821 cell-ranges**, five start cells, five sub-cell offsets including a near
corner (`pnpm bench:acoustics:invariant`):

> A field's ranges are exactly `seed + graphDistance(startCell, cell)`, and the graph distance
> depends only on *which cell* the source is in — not where inside it the source sits.
>
> Worst observed deviation: **9.1 × 10⁻¹³ m.**

This follows from the sweep's own structure: the seed is added to the start node and Dijkstra is
additive, so a different seed shifts every distance by the same constant and leaves the
shortest-path tree alone. `field.ts` seeds with the true sub-cell distance precisely so the
quantization is an offset rather than a bias — that design choice is what makes the field cacheable.

Combined with the lattice being immutable after match start (`lattice.ts`), a field is a pure
function of `(startCell, radius)`, plus one scalar applied at read time.

#### 3.1.2 The load-bearing detail — the seed must be added on *both* paths

The 9.1 × 10⁻¹³ m is not zero. Accumulating the seed through the sweep's additions and adding it
afterwards are not bit-identical, and `factorAt` floors range into a 1 m table where that difference
is invisible — until a range lands within 10⁻¹² of an integer, which is rare and not impossible.

The danger is not the size of the error, it is what it would be *correlated with*. If a cache hit
returned `seed + graphDistance` and a miss returned the accumulated value, then which one a solve
got would depend on where the boat had been on previous ticks, and the cache's hit/miss pattern —
a fact about history — would leak into the heatmap. That is exactly the class of bug
`solve.ts` sorts its entity list to avoid.

So: **store seed-0 graph distances, and add the seed at read time on the hit path and the miss path
alike.** The two paths then produce identical numbers and the cache is unobservable. Anything else
is not worth building.

#### 3.1.3 Hit rates

Measured dwell time against real content speeds (`content/hulls.ts`, `content/weapons.ts`) at
`ACOUSTIC_TICK_HZ`:

| entity | speed | crosses a 20 m cell every | hit rate |
|---|---|---|---|
| Heavy hull | 12.5 m/s | 16 solves | 94% |
| Light hull (flank) | 15 m/s | 13 solves | 93% |
| Standard torpedo | 22 m/s | 9 solves | 89% |
| Fast torpedo | 55 m/s | 4 solves | 73% |

Even the fastest thing in the water misses only one solve in four.

#### 3.1.4 Shape

- Key on `(startCell, radiusBucket)`. A larger radius than cached is a miss; a smaller one reads a
  prefix (see §3.4).
- Co-located entities share an entry within a single tick for free — the dedup falls out.
- Invalidate on: the entity changing lattice cell, or needing a larger radius than is cached.
- Memory: a 1200 m field is ≈ 8 600 cells × 12 B ≈ **103 KB**; a 16-boat match ≈ 1.6 MB.
  `Float32Array` ranges halve it, and 1 m is the resolution `factorAt` keeps anyway.

#### 3.1.5 What it actually did

Built in `sim/acoustics/field.ts`. The sweep now runs in **graph distance** — zero at the start
cell — and the seed rides on `FieldHandle`, added by `rangeAt` on every read. Entries are keyed on
start cell, own their arrays, and are evicted least-recently-used against a cell budget. A field
the `maxCells` guardrail cut short is **not** cached: a clipped field is a prefix in bucket order,
so it cannot answer a shorter request without being short of cells a tighter sweep would have had
room for. Turn the whole thing off with `{ fields: { cache: false } }` on `AcousticSolver`.

Measured on the §1 scenario, 16 boats, fleet drifting at 12.5 m/s, cache off against cache on —
same map, same track, one policy apart, and **taken before §3.2 landed**. Read the ratio, not the
absolute numbers: re-measured after the mask and the `emit` fix the same pair reads 6.5 → 1.35 ms,
which is the same ~5× on a box that had moved to its faster regime (§6).

| | fields | look | heatmap | solve |
|---|---|---|---|---|
| no cache | 17.07 | 4.05 | 4.73 | **27.00 ms** |
| cached | 2.45 | 3.39 | 4.26 | **11.12 ms** |
| ratio | **7.0×** | 1.2× | 1.1× | **2.4×** |

Hit rate against speed, at 16 boats — the thing §3.1.3 predicted:

| fleet speed | hit rate | predicted | fields, as a share of the solve |
|---|---|---|---|
| 0 m/s (ceiling) | 100% | — | 9% |
| 12.5 m/s (Heavy) | 91% | 94% | 18% |
| 55 m/s (fast torpedo) | 68% | 73% | 31% |

The hit rate is a property of the content's speeds and the lattice, not of the box, so it is the
one figure here that reproduces exactly between sessions.

**Three things worth knowing before building on this.**

1. **§3.1.3's hit rates are a few points optimistic.** They model straight-line travel across one
   cell; a fleet drifting diagonally crosses boundaries on both axes and measures 91% where the
   table says 94%. The shape is right and the conclusion is unchanged.
2. **The miss path got ~10% slower.** A sweep now writes into scratch and is copied into the arena
   rather than written straight there — `bench:acoustics:sweep`'s baseline moved from ≈ 80 to
   ≈ 88–94 ns/cell. At a 91% hit rate that is bought back many times over, but it is why the
   uncached column above is worse than §1's table rather than equal to it.
3. **§3.1.1's invariant is now enforced rather than observed.** With the seed added at read time,
   `bench:acoustics:invariant` reports a deviation of exactly **zero** instead of 9.1 × 10⁻¹³ m.
   The harness has become a regression guard rather than evidence — it runs with caching off, and
   it will catch anyone putting the seed back into the sweep, which is the change that would make
   the cache quietly unsound.

The claim that the cache is *unobservable* is checked rather than argued, in
`shared/test/acoustics-field-cache.test.ts`: the same fleet solved through a caching arena and a
non-caching one, over nine ticks of drift that cross cell boundaries, must agree on every field
cell, every range, and every vision square — exact equality, not tolerance.

### 3.2 A precomputed traversability mask

**BUILT 2026-08-14. Re-measured at ~1.4× on the sweep, against the 2.1–3.0× first recorded here.**
`WaterLattice.steps`; see §3.2.1 for why the number came down and what it is worth after §3.1.

One `Uint8Array`, one byte per cell, bit `n` set when neighbour `n` is a legal step — bounds, water,
and the corner rule all resolved once in the `WaterLattice` constructor. The inner loop becomes:
read the byte, iterate its set bits (`bits & -bits`, `Math.clz32`), add a precomputed cell offset
and a precomputed step length. Every test named in §2.3 disappears from the hot path.

| reach | baseline | masked |
|---|---|---|
| 1200 m | 118–138 ns/cell | 55–61 ns/cell |
| 4000 m | 118–138 ns/cell | 40–56 ns/cell |

Cost: **100 KB and 12 ms, once per match**, against a lattice that lives for the whole match.

The bench checks the masked sweep against the shipped arena at `maxRange`, uncapped, over 24 start
points — cell for cell and range for range, exact equality — and refuses to report a timing if they
disagree. A faster sweep that moves one range by a metre is a different game, not an optimization.

#### 3.2.1 What it actually did, and where the estimate was wrong

The mask lives on `WaterLattice.steps`, built in the constructor beside `nearestWater`, with
`neighbourOffsets()` / `neighbourSteps()` as the tables a bit index reads into. `FieldArena.sweep`
iterates set bits (`bits & -bits`, `Math.clz32`) and the eight inline tests are gone. 100 KB and
~10 ms once per match, against a lattice that never changes after match start.

**The 2.1–3.0× did not reproduce. It is ~1.4×.** Taken as minimums over six runs at imaging range,
in one process, which is the only defensible way to read this box (see §6 — the machine carries
background load and swings between two performance regimes):

| variant | ns/cell | against `inline` |
|---|---|---|
| `inline` — the pre-mask loop | 54.5 | — |
| `unguarded` — `inline` without the `??` fallbacks | 56.4 | **1.0×** |
| `masked` — what now ships | 38.5 | **1.42×** |

Two corrections to this document fall out of that table, and both matter more than the headline:

- **§3.3 does not exist as a separate win.** Dropping the `??` fallbacks from the sweep measures
  *nothing* now, against the 1.4–2.2× recorded here. Either V8 got better at eliding the
  `noUncheckedIndexedAccess` checks or the original figure was noise. Do not spend time on it.
- **Where the fallbacks *did* cost was `emit`, and for a different reason.** The copy out of the
  sweep scratch into the arena — the step §3.1 introduced — was calling `ensureStore` once per
  cell. Hoisting that growth check out of the loop took the shipped path from 87.7 to 48.6 ns/cell
  at imaging range, a bigger win than the mask itself. A per-cell call guarding a two-word write
  is the lesson, not the fallbacks.

**What it is worth end to end: very little, and that is §3.1's fault rather than this change's.**
The mask only makes *sweeps* cheaper, and after the field cache only ~9% of fields are swept. At
the default 12.5 m/s the fields phase is ~18% of a solve, so ~1.4× on 9% of 18% is low
single-digit percent. It earns more as the fleet speeds up — at 55 m/s the hit rate falls to 68% and `fields`
climbs back to 31% of a solve — and it costs nothing per tick, so it stays. But anyone hoping to
find another 2× should read §4 again rather than optimizing the sweep further.

One consequence to know about: the shipped arena pays the mask's gain straight back out in the
`emit` copy, so on a **miss** it is no faster than the pre-mask arena was. The cache is what cut
the phase; the mask makes the misses that remain cheaper than they would otherwise have been.

### 3.3 Drop the `??` fallbacks inside `solve` — **WITHDRAWN**

**Re-measured at 1.0×: no effect. Do not build this.** The original 1.4–2.2× did not reproduce
once §3.2 landed and the variants were re-timed in one process (§3.2.1). Either V8 improved at
eliding the `noUncheckedIndexedAccess` checks or the first measurement was noise on a loaded box.
The fallbacks were removed from the sweep anyway as part of §3.2, and they cost nothing there.

What this section was *right* about is that a per-cell cost hides in bookkeeping rather than in the
algorithm — it just named the wrong bookkeeping. See §3.2.1 on `ensureStore`, which was being called
once per cell and was worth more than the mask.

The original text follows.

Hoist the typed arrays into locals and index them without fallbacks inside `FieldArena.solve` only.
Worth listing separately because it is a ten-line diff with no new data structure, and because it
isolates what the fallbacks cost from what the neighbour tests cost — if §3.2 is judged too large a
change, this is most of the win for none of the surface area. `field.ts` is the one function in the
codebase where `noUncheckedIndexedAccess` is measurably expensive; that is an argument for a local
exception, not a global one.

### 3.4 Split the two radii at the consumer — **TRIED AND REVERTED**

**Built 2026-08-14, measured, and taken back out. The code is not in the tree.** Kept here because
what it found is worth more than what it saved: half of it was free and small, and the other half
was fast because it was deleting detections. §3.4.1 has the numbers and Q-16.3 has what to do next.

One field serves outbound propagation and the return leg (`field.ts`), and is sized to the larger of
the two. But `heatmap` only needs cells inside emission reach, and `look` only needs cells inside
imaging reach. Storage is bucket-ordered — ascending in range to within one cell — so recording a
prefix length per consumer lets each stop early instead of walking the union.

This does not make the sweep cheaper. It matters *after* §3.1 and §3.2, when the sweep is no longer
what a solve is made of (§4).

#### 3.4.1 What it measured, before it was reverted

The build gave `reachOf` both radii, put a per-consumer prefix (`emitCount`, `lookCount`) on the
field handle, and had each pass walk its own span. Roughly forty lines. It worked, and it was
reverted anyway: the free half bought about a tenth of a solve, and the half that bought a third of
one was not an optimization at all.

**The sentence above — "`look` only needs cells inside imaging reach" — is wrong, and that is the
finding.** `maxImagingRange` reads like a cap and is documented as one ("how far a listener images
reflections"), but `reachOf` applies it as a *floor*: the field is `max(emission, imaging)`. For a
quiet boat the imaging term wins and the cap is real. For a **loud** one it does not — a pinging
boat's field runs to ~2600 m and the reflection pass walks all of it, so active sonar charts rock
far outside the documented cap and always has. Truncating `look` at 1200 m does not remove
redundant work; it removes detections the player currently gets.

Measured with `pnpm bench:acoustics:picture`, 16 boats, 8 of them mid-pulse, 12 ticks:

| half | squares lost | squares gained | brightness moved | `lookCells` |
|---|---|---|---|---|
| `emission` | **0** | 0 | ≤ 0.005 dB | 100% |
| `imaging` | **2 382 (4.4%)** | 0 | up to 22.8 dB | 43.7% |

The two halves are therefore different animals:

- **The emission half was exact enough.** Past its emission reach an entity is under every gate in
  the match *and* under the ambient tail, so what the heatmap drops there cannot light a square or
  clear a threshold. Not *nothing* — brightness moves — but no square entered or left any picture
  at any fleet size tested, and the worst drift measured was 0.005 dB against a picture drawn in
  whole decibels. It was worth ~1.11× on a whole solve.
- **The imaging half was a balance change wearing an optimization's clothes.** Enabling it decides
  what active sonar is worth, and ADR 0003 measured that feature with the cap *not* applied
  ("charts 2100–2700 squares with the switch on"). If the cap is meant to bind, the honest route is
  to say so in ADR 0003 and re-tune `maxImagingRange` against the balance harness — not to enable
  it quietly for the 2.2× it buys on `look`.

**What each is worth**, minimums over five to six runs, 16 boats (§6 on why minimums):

| | `heatmap` | `look` | solve |
|---|---|---|---|
| neither | 3.15 | 2.76 | 8.65 ms |
| `emission` | **2.37** | 2.67 | **7.78 ms** |

and with 8 of 16 boats pulsing, where the imaging half actually bites:

| | `heatmap` | `look` | solve |
|---|---|---|---|
| neither | 5.70 | 5.85 | 15.93 ms |
| `imaging` | 4.98 | **2.64** | 12.01 ms |

The emission half is ~1.33× on `heatmap` and ~1.11× on a whole solve, for free. The imaging half is
~2.2× on `look` in a ping-heavy fight, for 4% of the picture.

**Why it was reverted rather than kept at half strength.** The emission half on its own is ~10% of
a solve for a permanent split in how the two passes read a field, plus a solver option, plus a
regression test to hold the picture still — carried indefinitely against a phase that is no longer
the bottleneck. That is a poor trade while `look` is the largest phase and the thing that would
actually move it (Q-16.3) is unresolved. If `maxImagingRange` is ever settled, rebuild both halves
together and take the whole win; the shape is known and it is forty lines.

### 3.5 Lower `maxImagingRange`

**Tuning, not code. −31% of every field for 1200 → 1000 m, by §2.1's `r²`.**

Belongs to the balance harness rather than to this document, and is listed only so the quadratic is
on the record next to the code changes. It costs scenery, not detection: a boat is found on the
direct path, which needs no field at all.

### 3.6 Ask whether a cell holds anything before computing its return

**BUILT 2026-08-14. Measured 1.33× on `look`, exact, ten lines.** `sim/acoustics/solve.ts#look`.

This section was not in the original analysis, and the reason it was missed is worth more than the
speedup. §1–2 profiled *which phase* and then went looking for structural changes; nobody counted
what the reflection loop was actually doing with its cells. Counters answered it in ten minutes:

| per solve, 16 boats, of the cells the reflection pass walks | |
|---|---|
| carry rock skin | 1.5% |
| carry hull skin | 0.5% |
| **carry either — i.e. *can* light** | **~2%** |
| actually light something | 0.01–0.04% |

**98% of the walk was computing a return for water with nothing in it to reflect.** Each of those
cells paid a `factorAt` and a scattered read into the 800 KB heatmap, then reached a rock branch
that needs `rockTo > rockFrom` and a hull branch that needs `from !== to`, and failed both.

The fix is to read the two skin spans — which the loop was reading anyway, a few lines further
down — *before* the arithmetic instead of after it, and skip the cell when both are empty. It is
**exact by inspection**: a cell with neither span could not reach either branch, so this is the
same nothing arrived at sooner. No cell counts change and no square moves.

Measured by interleaving the two builds, minimums over four to five rounds each (§6):

| fleet | | `look` | solve |
|---|---|---|---|
| 16 | before | 2.69 | 7.60 ms |
| 16 | after | **2.02** | **6.98 ms** |
| 32 | before | 5.26 | 13.17 ms |
| 32 | after | **4.00** | **10.84 ms** |

`shared/test/acoustics-vision.test.ts` locks the invariant the skip rests on: every rock square in
a picture comes from a lattice cell whose terrain span is non-empty.

**What else the counters turned up, and did not get built.** The furthest cell that lit anything
was **143 m** for a quiet fleet, 696 m with one pinger and 1689 m with eight — against 1200–2616 m
walked. That is the honest version of what §3.4's imaging half was reaching for, and unlike §3.4 it
can be made exact: stop when `maxIncident × back < minGate`, where `maxIncident` is a running max
costing one compare per accumulate in pass 1 and `minGate` falls out of the `softestAbsorption` the
solve already computes. Because the bound is derived from the tick's own data rather than asserted
by a constant, no square can be lost. Storage is bucket-ordered, so it can be a real `break` rather
than a per-cell skip. **This is the next thing to build**, and it should still be checked by
diffing the picture (§6).

### 3.8 Stop the reflection walk where nothing can still light

**BUILT 2026-08-14. Measured 1.66× on `look`, exact.** `sim/acoustics/solve.ts#reflectionCutoff`.
This is the idea §3.4 was reaching for, done as a derivation instead of an assertion.

Every return is `incident × back` against a gate of `thresholdPower × absorption`. Bound `incident`
by what the water is actually holding and the gate by the most reflective thing actually in the
match, and there is a range past which no cell of any kind can clear any gate. Both halves are
measurements taken while the tick was computed — the loudest cell tracked as the heatmap is
accumulated, the softest absorption tracked as the entities are read — so the bound cannot cut a
square. `{ reflectionBound: false }` must produce the identical picture, and
`shared/test/acoustics-field-cache.test.ts` holds it to that.

#### 3.8.1 The global bound is useless, and why

The first version bounded `incident` by the loudest cell anywhere. It is valid, it is one line, and
it is worthless:

| | cells walked, against unbounded |
|---|---|
| 0 pingers | 23% |
| **1 pinger** | **98%** |
| 8 pingers | 44% |

**One boat mid-pulse sets the maximum for the entire map**, and the cutoff lands past every field
in it. A quiet fleet gets a 77% cut; add a single pulse and the whole thing evaporates — which is
the worst possible shape, since a pulse is also when fields are largest.

The fix is to make the bound a fact about *this listener* rather than about the map. A cell `r`
away is at least `d(s) − r` from every source `s`, so what it can be holding is
`Σ P(s) · factor(d(s) − r)` — correctly large for a listener sitting beside the pulse, correctly
small for one three kilometres away. `d(s)` comes from the pair table, which already had the
factor and now keeps the range beside it; a source whose sound never reached the listener must be
further off than its own field went, which is what `reach` is for.

| | cells walked, against unbounded |
|---|---|
| 0 pingers | 24% |
| **1 pinger** | **38%** |
| 8 pingers | 43% |
| 6 boats | 51% |
| 32 boats | 36% |
| `large` map | 39% |
| `empty` map | 41% |

Half to three quarters of the walk, in every scenario tried, and **identical pictures in all of
them** — no square lost, gained, or re-lit.

#### 3.8.2 It has to be scanned, not solved

`incident × back` is **not monotonic in `r`**. `incident` rises as a cell approaches a source while
`back` falls as it leaves the listener, and the two cross, so there is no single inversion to
solve and a bisection would cut at the first dip. `reflectionCutoff` therefore walks outwards a
cell at a time, keeping the furthest interval that still clears, and takes each interval's worst
case — `incident` at its far edge, `back` at its near one — so no cell inside it can be
underestimated. It stops once it is past every source, where the product is falling on both sides.
Two hundred steps against a walk of tens of thousands of cells.

Two details that are load-bearing rather than defensive:

- **The distances must be *under*-estimates.** Over-estimating `incident` is always safe;
  over-estimating a distance shrinks the bound and can cut a real square. Ranges from the pair
  table lose two cell widths to cover the sub-cell seed at each end.
- **A clipped field invalidates the `reach` half.** "Its sound did not reach me, so it is further
  away than its field went" assumes the field stopped where the *range* bound put it. If the cell
  guardrail bit instead, it did not, so a solve with any `clippedFields` falls back to the global
  bound.

Measured by interleaving the two builds, minimums over five rounds each (§6):

| fleet | | `look` | solve |
|---|---|---|---|
| 16 | off | 2.09 | 6.81 ms |
| 16 | on | **1.26** | **6.07 ms** |
| 32 | off | 4.04 | 11.67 ms |
| 32 | on | **3.02** | **10.66 ms** |

The time saved is less than the cells removed, because the cells it removes are the cheap far ones
— the near cells it keeps are the ones carrying skin — and because the scan itself is not free.

### 3.9 Write the heatmap only where something reads it

**BUILT 2026-08-14. Measured 1.8× on `heatmap`, and ~1.2× on a whole solve.**
`sim/acoustics/solve.ts#needMask`.

Counters again, and the same shape of answer as §3.6. Of the cells a solve writes the heatmap into:

| per solve, 16 boats | |
|---|---|
| carry rock skin | 1.5% |
| are a listener's own cell | 0.05% |
| land on the **next cell in memory** | 2.2% |

Since §3.6 the reflection pass reads `incident` **only** at cells carrying skin, and the only other
reader is a listener at its own cell. So **98.5% of the heatmap was being computed for nobody** —
and computed the expensive way, since the writes are almost perfectly scattered: two read-modify
-writes into megabyte-sized `Float64Array`s plus two more scattered reads for the pair table.

A one-byte mask per cell answers "will anything read this?" before the range is even resolved. Bit
0 is the static half — every cell fronting a rock face, settled once at match start because
terrain does not move. Bit 1 is this tick's: hull skin, listeners, and anything a debug reader
asked for, stamped and cleared over a couple of thousand cells against the hundred and fifty
thousand the stamp saves.

| fleet | | `heatmap` | solve |
|---|---|---|---|
| 16 | before | 2.34 | 6.19 ms |
| 16 | after | **1.32** | **5.00 ms** |
| 32 | before | 4.00 | 10.88 ms |
| 32 | after | **2.20** | **8.89 ms** |

#### 3.9.1 The heatmap is no longer a map

This is the first change in this document that alters what the solver *offers* rather than how it
computes it, and the cost lands on the debug instruments. **A sparse heatmap reads as the ambient
ocean wherever it was not filled** — a plausible number and a wrong one — so `NoiseHeatmap.complete`
says which kind you are holding, and everything that reads a point of its own choosing has to
declare itself through `HeatmapDemand`:

- **`noise` and `imaging` overlays ask for `everywhere`.** They are the two that read the map away
  from anything reflective — one draws all of it, the other reads it across a boat's whole field.
  `fieldMap` returns `null` for them until a solve has seen the request, so switching an overlay on
  costs one blank frame rather than showing an ocean of ambient. `range` and `detect` are geometry
  and a gate; both were already covered.
- **A probe registers its cell and reads it on the next solve.** `ProbeReading.settled` says
  whether the reading is real yet, and `listener.imaging` — the one figure under `listener` that
  reads the heatmap rather than a sweep taken on the spot — comes back `null` until it is. The
  client re-asks once. **This is the design decision to argue with if any of it is wrong**: a probe
  is the instrument you reach for to find a disagreement, so it is the last thing allowed to invent
  one, and a flag the caller must check is the honest way to be one tick behind.

The alternative was to have the probe compute its own answer on demand from the fields still in the
arena. Rejected on `match/probe.ts`'s own grounds — a probe with its own arithmetic eventually
disagrees with the game, and the disagreement would be invisible precisely because this is the
instrument you would use to look for it.

#### 3.9.2 What was tried and was not worth it

Two other shapes were measured on the same loop and are recorded so they are not re-derived:

- **Interleaving `noisePower` and `noiseBackground`** into one array so both live in a cache line:
  1.19× in a micro-benchmark, and it only helps when something filterable is in the water, which
  is when §3.9's own aliasing does not apply. Not built.
- **Sorting each field's cells by lattice index** so the writes run forward through memory: the
  obvious fix given only 2.2% of them do, and worth **1.09×**. The accessed region is a bounded
  disc that mostly stays in cache, so the scatter costs far less than it looks. It also conflicts
  with §3.8, which needs the cells in ascending *range* to stop early. Not built, and not worth
  revisiting.

### 3.7 Share a team's reflection walk between its listeners — **REJECTED, measured**

**The duplication is not there.** At the fleet sizes this game is designed around, teammates barely
overlap, and the pruning would cost more than it recovers. Written down so nobody re-derives it,
the way §2.5 is.

The reasoning that motivates it is sound, and one part of it is worth keeping whatever happens to
the rest. For a cell `C` and listener `L`, both branches of the reflection pass come out as

```
excess = (incident term) - loss(range_L(C)) - threshold_L - absorption
```

— the terrain branch and the hull branch differ only in the incident term and which absorption they
pay. **The incident term does not depend on the listener, so it cancels between two of them.**
Which teammate sees a cell best is therefore pure geometry plus that listener's own threshold:
minimise `cost_L(C) = loss(range_L(C)) + threshold_L`, and the noise field never enters. Since the
picture keeps only the best view per cell (`terrainBest`, `hullBest` are max-reductions), every
visit by a listener that is not the winner is wasted.

So: how many visits are those? Counted per team per solve, `dense`/`medium`:

| fleet | listeners per team | cell-visits | distinct cells | **visits a teammate already beat** |
|---|---|---|---|---|
| 6 | 3 | 58 498 | 97.4% | **0.0%** |
| 8 | 4 | 77 239 | 74.2% | **13.2%** |
| 10 | 5 | 83 700 | 76.6% | **8.9%** |
| 12 | 6 | 102 100 | 81.2% | **6.2%** |
| 16 | 8 | 145 618 | 63.8% | 18.1% |
| 32 | 16 | 274 027 | 44.1% | 28.1% |
| 16, `large` map | 8 | 142 598 | 87.3% | 6.2% |

**Fleets are 3-5 boats a side in practice** (planning/README §6), and across that range the answer
is 0-13% — and not even monotonic in fleet size, because how far apart the boats happen to be
matters more than how many there are. Three a side on a medium map share *nothing*: 97.4% of the
cell-visits are to cells no teammate touched at all. The number only becomes interesting at sixteen
a side, which is not a game anyone is going to play.

**And the ceiling is not the saving.** A prune needs `cost_L(C)` to decide anything, which is a
loss-table lookup, an add and a compare — plus a scattered write when the listener *is* the new
best. That is paid on **every** visit, while the work it avoids is paid on the dominated fraction
only. After §3.6 the thing being avoided is four `Int32Array` reads. At five a side that is roughly
9% of visits saving four reads against 100% of visits paying a lookup, a compare and a write, and
the write is exactly the cache-hostile pattern the phase already has too much of. It does not pay.

**The stronger form does not work either, and it is worth knowing why.** Rather than pruning, one
could seed a *single* sweep per team from every crew member at once — each seeded at its own
`threshold_L` — so the team walks the union once instead of once per listener. That is the 36-56%
in the "distinct cells" column, and it is the shape the idea really wants. It is not sound:
Dijkstra needs a node's winner to stay the winner as the path extends, and `loss` is a logarithm
plus a line, so the increment `loss(r + d) - loss(r)` *shrinks* as `r` grows. A listener that is
behind at a node but closer to it can overtake further out. The fused sweep would therefore pick
the wrong winner sometimes and shade the excess — inexact, in the same category as §3.4, for a
phase where §3.6 has already taken a third out for free.

## 4. What the phases look like afterwards

Projected for the 16-boat row of §1, applying the measured factors:

| | today | +§3.2 | +§3.1 | +§3.4 |
|---|---|---|---|---|
| fields | 19.4 | ~8.8 | ~1.2 | ~1.2 |
| look | 5.4 | 5.4 | 5.4 | ~3 |
| heatmap | 4.5 | 4.5 | 4.5 | ~2.5 |
| other | 1.2 | 1.2 | 1.2 | 1.2 |
| **solve** | **30.5** | **~19.9** | **~12.3** | **~7.9** |

The shape of the answer matters more than the arithmetic: **after §3.1 and §3.2 the field sweep is
no longer the expensive part.** `look` and `heatmap` are, and they are expensive for a different
reason — they walk every field cell every tick and caching cannot help them, because what they
accumulate changes every tick even when the field does not. Anyone resuming this work should re-run
`pnpm bench:acoustics` before reaching for §5, because §5 may not be needed.

**Measured with §3.1 and §3.2 both in** (16 boats at 12.5 m/s), against the projection above:

| | projected +§3.2 +§3.1 | measured |
|---|---|---|
| fields | ~1.2 | 2.2–2.5 |
| look | 5.4 | 4.3–4.6 |
| heatmap | 4.5 | 5.0 |
| **solve** | **~12.3** | **12.7–13.4 ms** |

The total landed close to where §4 put it, by a different split: the sweep is dearer than projected
(the cache is 91% rather than the ~100% the ~1.2 ms implied) and `look` cheaper. **The prediction
that mattered came true** — `fields` is now the *third*-largest phase of a solve, behind `heatmap`
and `look`, and at 32 boats `look` alone is ~40%.

Phase shares after both changes, which is the number to plan against:

| fleet | solve | fields | look | heatmap |
|---|---|---|---|---|
| 8 | 8.1 ms | 15% | 26% | 42% |
| 16 | 13.4 ms | 18% | 34% | 38% |
| 32 | 14.2 ms | 17% | 40% | 35% |

Nothing further is worth spending on the sweep: it has had both of its cheap wins, and a third
would be optimizing a phase that is already 91% cache hits.

**Where it stands after §3.9** (minimums over four runs, 12.5 m/s, one pinger):

| fleet | solve | fields | look | heatmap |
|---|---|---|---|---|
| 8 | 3.7 ms | 21% | 19% | 32% |
| 16 | 5.1 ms | 27% | 28% | 27% |
| 32 | 9.2 ms | 26% | 33% | 23% |

A 16-boat solve has gone from **30.5 ms to 5.1 ms** across §3.1, §3.2, §3.6, §3.8 and §3.9 —
though see §6 before reading much into a cross-session comparison; the ratios inside each change
are the defensible part.

**Nothing dominates any more.** `fields`, `look` and `heatmap` are within a few points of each
other at every fleet size, which is the shape you get when the easy structural wins are gone. Each
of the three has now been instrumented and had its cheap answer taken. What is left is either
tuning (§3.5, Q-16.3), a design change (planning/03 §10's tiered re-evaluation), or parallelism
(§5) — and §5's own question, which regime a deployment is in, is still unanswered.

## 5. Parallelization

### 5.1 The split the code already has

- **Pass 0 (fields) is embarrassingly parallel.** Each sweep reads the immutable lattice and one
  position, and writes only its own scratch. There is no cross-entity dependency at all.
- **Pass 1 (heatmap) must stay serial.** It sums floats into shared cells, and `solve.ts` is
  explicit that float addition is not associative and that a different order is a different match
  ([04 §9](04-simulation-core.md)).

So the design is: **N workers sweep, one thread accumulates, in sorted-id order.** Determinism
survives because each field is computed independently of the others and the only order-sensitive
step never leaves the main thread.

### 5.2 Mechanics

- `WaterLattice.water` and the §3.2 mask go in a `SharedArrayBuffer`, written once at match start,
  read-only thereafter. No locking, because there are no writers.
- One `FieldArena` per worker — it is already per-instance scratch, so this is a constructor call
  rather than a redesign.
- Each worker writes into its own preallocated slab bounded by `maxFieldCells` and reports
  `(offset, count)` per entity. `clippedFields` sums across workers.

### 5.3 The question to settle first

**Which parallelism, though?** §1.1 is the reason this is not obvious. Because every match on the
process is ticked serially on one thread, a box hosting many concurrent matches has its cores busy
already, and splitting one solve across threads steals from the next match rather than finding new
capacity.

- **Many concurrent matches** → sharding *matches* across worker threads (a worker owns a set of
  matches, ticks them, posts frames back) is the better structure, and §5.1's split is not needed.
- **Few large matches, latency-bound** → per-solve parallelism is right.

The statistics panel already carries the instrument to tell which regime a deployment is in — the
`tick` total against `acoustics` across the running set. Settle this with a measurement, not an
argument; it decides whether §5.1 is worth building at all.

> That measurement is now specified as `bench-concurrency` in
> [17 §3.4](17-netcode-performance.md), and the regime question is Q-17.3 — the same question,
> asked from the publish side, where it also decides how frames get built. Settle it once.

## 6. Reproducing all of this

Benchmarks live in `packages/tools/src/bench-acoustics/` (`@seg/tools` reserved `bench-*` for
exactly this in [10 §1](10-repo-structure-tooling.md)). All three are deterministic — fixed seed,
entities placed by index — so a number from today can be compared against one from six months ago.

```
pnpm --filter @seg/tools bench:acoustics             # §1: the phase table
pnpm --filter @seg/tools bench:acoustics:sweep       # §2.3, §2.5, §3.2, §3.3: inner-loop variants
pnpm --filter @seg/tools bench:acoustics:invariant   # §3.1.1: the cache invariant + hit rates
```

**None of these three counts what a phase is doing with its cells**, and §3.6 is what that cost:
a third of the reflection pass was sitting in the loop's branch order for the whole life of this
document, and no timing harness could have pointed at it. Ten minutes of temporary counters in the
loop body found it. Instrument before optimizing, and delete the counters afterwards.

**Nor do they answer "is it still the same game".** §3.4 is the warning: an optimization that looked obviously safe deleted 4% of the vision squares, and every
timing harness here reported it as a clean win. It was caught by diffing the picture — solving one
fleet twice, with the change on and off, and comparing vision squares as sets. That took about
sixty lines against a temporary solver option, and it is the first thing to write for any change to
`sim/acoustics/` that cannot be argued exact on paper (as §3.1 and §3.2 both can, and both have
tests for).

Environment knobs, shared by all three: `MAP` (`empty`/`dense`/`caves`), `SIZE`, `SEED`, `FLEET`,
`PINGERS`, `RUNS`, and — since §3.1 — `SPEED` and `CACHE`. The scenario is in `scenario.ts`;
changing it changes every figure above, so prefer adding a knob to editing the defaults.

**`SPEED` is not optional reading.** The fleet moves, at 12.5 m/s by default, because a stationary
one never leaves its lattice cells and every solve after the first would be a pure cache hit — the
fields phase would be measuring a memcpy. `SPEED=0` is the cache's ceiling and is worth printing as
one; it is not a number to quote. `CACHE=0` turns the cache off for a like-for-like before and
after, which is how §3.1.5's table was taken.

The two sweep-level harnesses (`:sweep`, `:invariant`) build their arenas with caching **off** on
purpose. One of them is the justification for the cache and the other measures what a sweep costs;
both would answer themselves with it on.

**On the numbers.** Timings were taken on an unpinned WSL2 machine and run-to-run variance is
roughly ±20%, which is why §3.2 and §3.3 are quoted as ranges and why every claim that matters is
stated as a *ratio* between variants measured in the same process. Cell counts, push ratios, and
the §3.1.1 deviation are exact and do not vary between runs.

**That warning was understated, and §3.3 was withdrawn because of it.** Re-running these in
2026-08 on the same box at a load average of ~1.7, identical configurations varied by **1.6×** and
the machine sat in two distinct performance regimes, drifting between them mid-session — an
uncached 16-boat `fields` phase read 11.2 ms and 6.5 ms an hour apart with no code change. Two
rules follow, and the second is the one §3.3 broke:

1. Take **minimums over five or more runs**, not means. Under contention the minimum is the only
   robust estimator of how fast the code can go.
2. **Never compare a timing across sessions.** Every number in §3.1.5 and §3.2.1 is a ratio between
   variants measured in one process, minutes apart, or it is not quoted. The end-to-end tables are
   given as ranges for the same reason.

Cell counts remain the honest cross-session check: they are exact, and if a change moves one it has
changed the game rather than the program.

## 7. Open questions

- **Q-16.1** — Which parallelism (§5.3)? Needs a measurement of a realistic multi-match box before
  either structure is built.
- **Q-16.2** — *Partly settled.* §3.1 shipped with a cell budget (350 000 cells, ≈ 4 MB) and
  least-recently-used eviction, which is enough: a 16-boat fleet at cruise sits at ≈ 350 K held
  cells, so it is already evicting the stale entries a moving boat leaves behind rather than
  growing. What is **not** established is the right budget for a `large` map with ten a side, or
  whether LRU is the right policy when a fleet is spread out enough that no two boats share
  neighbouring cells. Measure before tuning the constant.
- **Q-16.3** — Should `maxImagingRange` move (§3.5)? Belongs to the balance harness
  ([03 §11](03-sonar-model.md)), which does not exist yet. **§3.4 sharpened this into the most
  valuable open question in this document**: the constant does not currently do what its own doc
  comment says, because `reachOf` applies it as a floor rather than a cap, so a pinging boat images
  rock well past it. Deciding what it *should* mean settles §3.4 and §3.5 together and is worth
  ~2.2× on the largest phase of a solve. It needs ADR 0003's owner, not a profiler.
- **Q-16.4** — *Settled by §3.9.* `heatmap` was a third of a solve because it was computing the
  ocean for nobody; it is now the smallest of the three big phases. The successor question is
  Q-16.6.
- **Q-16.6** — With no phase dominating and a 16-boat solve at 5 ms against a 50 ms budget, **is
  any of this still worth doing?** §1.1 is the reason it might be: the budget belongs to every
  match on the box, not to one. That is a measurement of a realistic multi-match deployment
  (Q-16.1), and it should be taken before anyone opens this document again.
- **Q-16.5** — *Settled.* §3.8 built the derived range bound: 1.66× on `look`, exact, half to three
  quarters of the cells gone. The global form of the bound was worthless and the per-listener form
  was not; §3.8.1 is the difference and is the more useful half of the section.
