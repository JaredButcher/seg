# 16 — Acoustic Performance

**Status:** analysis complete, nothing built. The measurements in §1–2 are real and reproducible
(§6); everything in §3–5 is a proposal with an estimated payoff, and each estimate says whether it
was measured or derived.

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

Ranked by payoff. §3.2 and §3.3 are mechanical and provably behaviour-preserving; §3.1 is the big
one and needs the care §3.1.2 describes.

### 3.1 Cache fields by start cell

**Estimated 5–10× on the fields phase. Derived from a measured hit rate; not yet prototyped.**

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

### 3.2 A precomputed traversability mask

**Measured ~2× (2.1–2.4× at imaging range, 2.4–3.0× at `maxRange`). Verified exactly equivalent.**

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

### 3.3 Drop the `??` fallbacks inside `solve`

**Measured 1.4–2.2×. A strict subset of §3.2.**

Hoist the typed arrays into locals and index them without fallbacks inside `FieldArena.solve` only.
Worth listing separately because it is a ten-line diff with no new data structure, and because it
isolates what the fallbacks cost from what the neighbour tests cost — if §3.2 is judged too large a
change, this is most of the win for none of the surface area. `field.ts` is the one function in the
codebase where `noUncheckedIndexedAccess` is measurably expensive; that is an argument for a local
exception, not a global one.

### 3.4 Split the two radii at the consumer

**Not yet measured. Targets `heatmap` + `look`, together 26–30% of a solve.**

One field serves outbound propagation and the return leg (`field.ts`), and is sized to the larger of
the two. But `heatmap` only needs cells inside emission reach, and `look` only needs cells inside
imaging reach. Storage is bucket-ordered — ascending in range to within one cell — so recording a
prefix length per consumer lets each stop early instead of walking the union.

This does not make the sweep cheaper. It matters *after* §3.1 and §3.2, when the sweep is no longer
what a solve is made of (§4).

### 3.5 Lower `maxImagingRange`

**Tuning, not code. −31% of every field for 1200 → 1000 m, by §2.1's `r²`.**

Belongs to the balance harness rather than to this document, and is listed only so the quadratic is
on the record next to the code changes. It costs scenery, not detection: a boat is found on the
direct path, which needs no field at all.

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

## 6. Reproducing all of this

Benchmarks live in `packages/tools/src/bench-acoustics/` (`@seg/tools` reserved `bench-*` for
exactly this in [10 §1](10-repo-structure-tooling.md)). All three are deterministic — fixed seed,
entities placed by index — so a number from today can be compared against one from six months ago.

```
pnpm --filter @seg/tools bench:acoustics             # §1: the phase table
pnpm --filter @seg/tools bench:acoustics:sweep       # §2.3, §2.5, §3.2, §3.3: inner-loop variants
pnpm --filter @seg/tools bench:acoustics:invariant   # §3.1.1: the cache invariant + hit rates
```

Environment knobs, shared by all three: `MAP` (`empty`/`dense`/`caves`), `SIZE`, `SEED`, `FLEET`,
`PINGERS`, `RUNS`. The scenario is in `scenario.ts`; changing it changes every figure above, so
prefer adding a knob to editing the defaults.

**On the numbers.** Timings were taken on an unpinned WSL2 machine and run-to-run variance is
roughly ±20%, which is why §3.2 and §3.3 are quoted as ranges and why every claim that matters is
stated as a *ratio* between variants measured in the same process. Cell counts, push ratios, and
the §3.1.1 deviation are exact and do not vary between runs.

## 7. Open questions

- **Q-16.1** — Which parallelism (§5.3)? Needs a measurement of a realistic multi-match box before
  either structure is built.
- **Q-16.2** — Does §3.1's cache want a per-match memory cap, and what does it evict when a fleet is
  large and spread out? 1.6 MB for 16 boats is fine; the shape of the answer for a 10-boat-a-side
  lobby on a `large` map is not established.
- **Q-16.3** — Should `maxImagingRange` move (§3.5)? Belongs to the balance harness
  ([03 §11](03-sonar-model.md)), which does not exist yet.
