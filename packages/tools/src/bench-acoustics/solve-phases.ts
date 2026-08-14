/**
 * Where one acoustic tick goes, broken into the five phases the solver already reports.
 *
 * This is the measurement planning/16 §1 is built on, and the one to re-run after any change to
 * `sim/acoustics/`. It drives `AcousticSolver.solve` through the same `SolveProbe` the debug
 * statistics panel uses (`match/perf.ts`), so what it prints is what the panel would show — minus
 * the phases that belong to the runtime rather than the solver.
 *
 *   pnpm bench:acoustics                       # 8 boats, one of them pinging, dense/medium
 *   FLEET=16 PINGERS=0 pnpm bench:acoustics    # what a quiet fleet alone costs
 *   SIZE=large FLEET=32 pnpm bench:acoustics
 *   SPEED=0 pnpm bench:acoustics               # the field cache's ceiling — see below
 *   CACHE=0 pnpm bench:acoustics               # and what it costs without one
 *   BOUND=0 pnpm bench:acoustics               # §3.8's reflection cutoff off
 *
 * The fleet **moves**, at `SPEED` m/s (default 12.5, a Heavy at full). That matters since the
 * field cache landed (planning/16 §3.1): a stationary fleet never leaves its lattice cells, so
 * every solve after the first would be a pure cache hit and the fields phase would measure a
 * memcpy rather than a sweep. `SPEED=0` still does that, and is worth printing as a ceiling, but
 * it is not the number to quote.
 *
 * The budget it compares against is one *sim* tick — `1000 / SIM_TICK_HZ` — and not one acoustic
 * period, because that is the number the phase has to fit inside: the solve runs on every second
 * tick, but it runs inside one tick's slot when it does. Worse, `server/match/clock.ts` ticks
 * every match on the process through one `setInterval`, so this figure is a share of a budget the
 * whole box shares rather than one this match owns.
 */

import { AcousticSolver, SIM_TICK_HZ, type SolvePhase, type SolveStats } from '@seg/shared';

import { benchFleet, benchMap, describe, fleetAt, optionsFromEnv } from './scenario.js';

const BUDGET_MS = 1000 / SIM_TICK_HZ;

const options = optionsFromEnv();
const map = benchMap(options);
const solver = new AcousticSolver(map, {
  fields: { cache: options.cache },
  reflectionBound: options.bound,
});
const entities = benchFleet(solver.lattice, options);

console.log(describe(map, solver.lattice, options));

const totals = new Map<SolvePhase, number>();
const probe = {
  start: () => performance.now(),
  record: (phase: SolvePhase, since: number) => {
    totals.set(phase, (totals.get(phase) ?? 0) + (performance.now() - since));
  },
};

// Warm up, so what is timed is the optimized code rather than the interpreter reaching it. The
// warm-up walks the same track the timed runs will, so the cache is in the state a match would
// have it in rather than empty.
for (let i = 0; i < 5; i += 1) solver.solve(fleetAt(entities, i, options, map.extents));

const before = solver.fieldCache;
let stats: SolveStats | undefined;
const started = performance.now();
for (let i = 0; i < options.runs; i += 1) {
  stats = solver.solve(fleetAt(entities, 5 + i, options, map.extents), probe).stats;
}
const wall = performance.now() - started;
const cache = solver.fieldCache;
const hits = cache.hits - before.hits;
const misses = cache.misses - before.misses;
const per = wall / options.runs;

console.log(
  `\n${options.runs} solves — ${per.toFixed(2)} ms each, ` +
    `${((100 * per) / BUDGET_MS).toFixed(0)}% of one ${BUDGET_MS} ms tick\n`,
);

const ranked = [...totals].sort((a, b) => b[1] - a[1]);
for (const [phase, ms] of ranked) {
  console.log(
    `  ${phase.padEnd(9)} ${(ms / options.runs).toFixed(2).padStart(7)} ms  ` +
      `${((100 * ms) / wall).toFixed(1).padStart(5)}%`,
  );
}

if (stats !== undefined) {
  console.log(
    `\n  entities=${stats.entities} sources=${stats.sources} listeners=${stats.listeners}` +
      `\n  fieldCells=${stats.fieldCells} (${Math.round(stats.fieldCells / Math.max(1, stats.entities))} per entity)` +
      `\n  lookCells=${stats.lookCells} reflectorCells=${stats.reflectorCells}` +
      `\n  visionCells=${stats.visionCells} clippedFields=${stats.clippedFields}`,
  );
}

console.log(
  `\n  fleet at ${options.speed} m/s — field cache ${options.cache ? '' : 'OFF, '}` +
    `${((100 * hits) / Math.max(1, hits + misses)).toFixed(0)}% hit ` +
    `(${hits} hits, ${misses} sweeps), holding ${cache.cells} cells`,
);
