/**
 * The statistics panel's stopwatch (`match/perf.ts`) and the numbers it hands the wire.
 *
 * Timings are the one thing in this project that cannot be asserted exactly — a phase takes what
 * the machine gives it — so what is pinned here is everything *around* the timings: that nothing
 * is measured until somebody asks, that the window is a window and forgets, that the counts are
 * the world's own, and that the arithmetic relating the four columns holds. A test that asserted
 * "acoustics take under 3 ms" would fail on somebody's laptop and teach them to ignore it.
 */

import {
  deployMatch,
  generateMap,
  PERF_PHASES,
  PERF_SOLVE_PHASES,
  SIM_TICK_HZ,
  type BoatTemplate,
  type DeployingPlayer,
  type MatchState,
  type PerfPhase,
} from '@seg/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { PerfTracker, PERF_WINDOW } from '../src/match/perf.js';
import { MatchRuntime } from '../src/match/runtime.js';

const BOAT: BoatTemplate = { name: 'S-01', hull: 'medium', modules: [] };

function seat(accountId: string, position: DeployingPlayer['position']): DeployingPlayer {
  return { accountId, username: accountId, position, boats: [BOAT] };
}

function match(): MatchState {
  return deployMatch({
    matchId: 'm1',
    mode: 'objective-capture',
    map: generateMap('empty', { seed: 11, mapSize: 'small' }),
    startedAt: 0,
    debugMode: true,
    players: [seat('host', 'team1'), seat('foe', 'team2')],
  });
}

/** Busy-wait, because a phase that took no measurable time proves nothing about a stopwatch. */
function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* deliberately nothing */
  }
}

describe('the stopwatch', () => {
  let perf: PerfTracker;

  beforeEach(() => {
    perf = new PerfTracker();
  });

  it('measures nothing at all until it is switched on', () => {
    // The whole design: instrumenting a hot path unconditionally is how a profiler becomes the
    // thing being profiled. `start` does not even read the clock while this is off.
    expect(perf.start()).toBe(0);

    perf.beginTick(1);
    perf.record('acoustics', 0);

    const view = perf.snapshot(counts());
    expect(view.window).toBe(0);
    expect(view.phases.every((phase) => phase.runs === 0)).toBe(true);
  });

  it('records a phase against the tick it happened on', () => {
    perf.enabled = true;
    perf.beginTick(1);
    const started = perf.start();
    spin(2);
    perf.record('acoustics', started);

    const acoustics = phaseOf(perf.snapshot(counts()).phases, 'acoustics');
    expect(acoustics.runs).toBe(1);
    expect(acoustics.mean).toBeGreaterThan(0);
    expect(acoustics.peak).toBeGreaterThanOrEqual(acoustics.mean);
  });

  it('means per run and shares against the budget, which are different questions', () => {
    // The distinction the panel lives or dies on: a phase that runs every other tick has a mean
    // per *run*, and a share of the ticks that have gone past. Conflating them is how a phase
    // eating a third of the server reads as comfortable.
    perf.enabled = true;
    for (let tick = 1; tick <= 4; tick += 1) {
      perf.beginTick(tick);
      if (tick % 2 !== 0) continue;
      const started = perf.start();
      spin(1);
      perf.record('acoustics', started);
    }

    const view = perf.snapshot(counts());
    const acoustics = phaseOf(view.phases, 'acoustics');
    expect(view.window).toBe(4);
    expect(acoustics.runs).toBe(2);
    // Two runs of about a millisecond over four ticks of the budget.
    expect(acoustics.share).toBeCloseTo(
      (acoustics.mean * acoustics.runs) / (view.window * view.budgetMs),
      6,
    );
    expect(view.budgetMs).toBeCloseTo(1000 / SIM_TICK_HZ, 6);
  });

  it('forgets a tick once the window has rolled past it', () => {
    perf.enabled = true;
    perf.beginTick(1);
    const started = perf.start();
    spin(1);
    perf.record('acoustics', started);
    expect(phaseOf(perf.snapshot(counts()).phases, 'acoustics').runs).toBe(1);

    // Exactly one full window later, the same slot is taken and wiped.
    for (let tick = 2; tick <= 1 + PERF_WINDOW; tick += 1) perf.beginTick(tick);

    const rolled = perf.snapshot(counts());
    expect(rolled.window).toBe(PERF_WINDOW);
    expect(phaseOf(rolled.phases, 'acoustics').runs).toBe(0);
  });

  it('adds two measurements on one tick together rather than replacing one', () => {
    perf.enabled = true;
    perf.beginTick(1);
    for (let i = 0; i < 2; i += 1) {
      const started = perf.start();
      spin(1);
      perf.record('vision', started);
    }

    const vision = phaseOf(perf.snapshot(counts()).phases, 'vision');
    // One run — a tick — whose total is both halves of it.
    expect(vision.runs).toBe(1);
    expect(vision.mean).toBeGreaterThan(1.5);
  });

  it('reports every phase, whether or not it ran', () => {
    perf.enabled = true;
    perf.beginTick(1);

    expect(perf.snapshot(counts()).phases.map((phase) => phase.phase)).toEqual(PERF_PHASES);
  });
});

describe('a running match', () => {
  let runtime: MatchRuntime;

  beforeEach(() => {
    runtime = new MatchRuntime(match(), { cellSize: 80, collisionCell: 40 });
  });

  it('says nothing until somebody opens the panel', () => {
    for (let i = 0; i < 4; i += 1) runtime.tick();
    expect(runtime.anyDebugStats).toBe(false);

    const idle = runtime.simStats();
    // The counts are there — they are read off the world, not off the stopwatch — and the window
    // is empty, because nothing was being measured.
    expect(idle?.window).toBe(0);
    expect(idle?.phases.every((phase) => phase.runs === 0)).toBe(true);
  });

  it('measures the tick once it is open, and every phase a tick runs', () => {
    runtime.setDebugStats('host', true);
    expect(runtime.anyDebugStats).toBe(true);
    // Four ticks: two of them acoustic, which is what puts the solve phases in the window.
    for (let i = 0; i < 4; i += 1) runtime.tick();

    const stats = runtime.simStats();
    if (stats == null) throw new Error('no stats');
    expect(stats.window).toBe(4);

    const ran = new Set(stats.phases.filter((phase) => phase.runs > 0).map((phase) => phase.phase));
    // The 20 Hz half, and the acoustic half broken into its steps on the ticks that solve.
    expect(ran).toContain('world');
    expect(ran).toContain('tick');
    for (const phase of PERF_SOLVE_PHASES) expect(ran).toContain(phase);
    expect(ran).toContain('acoustics');
    expect(ran).toContain('vision');
    // The acoustics run at half the tick rate, and the window says so rather than hiding it in a
    // mean spread over ticks that never ran them. Every step inside one runs exactly as often.
    expect(phaseOf(stats.phases, 'acoustics').runs).toBe(2);
    for (const phase of PERF_SOLVE_PHASES) expect(phaseOf(stats.phases, phase).runs).toBe(2);
    expect(phaseOf(stats.phases, 'tick').runs).toBe(4);

    // And the steps account for the phase that contains them, near enough that the gap is
    // unattributed work rather than a step nobody is measuring.
    const inner = PERF_SOLVE_PHASES.reduce(
      (sum, phase) => sum + phaseOf(stats.phases, phase).mean,
      0,
    );
    const whole = phaseOf(stats.phases, 'acoustics').mean;
    expect(inner).toBeLessThanOrEqual(whole * 1.05);
    expect(inner).toBeGreaterThan(whole * 0.8);
    // Publish is the handler's, so a runtime ticking on its own never records one.
    expect(phaseOf(stats.phases, 'publish').runs).toBe(0);
  });

  it('counts the world it is spending the time on', () => {
    runtime.setDebugStats('host', true);
    for (let i = 0; i < 4; i += 1) runtime.tick();
    runtime.spawnTorpedo('host', 'standard', 'team1', { x: 900, y: 900 });
    for (let i = 0; i < 2; i += 1) runtime.tick();

    const counts = runtime.simStats()?.counts;
    expect(counts?.boats).toBe(runtime.state.boats.length);
    expect(counts?.torpedoes).toBe(1);
    expect(counts?.zones).toBe(runtime.state.zones.length);
    // The acoustic entities are the hulls and the weapons together — the uniform entity model,
    // counted (planning/04 §4).
    expect(counts?.entities).toBe(runtime.state.boats.length + 1);
    expect(counts?.listeners).toBeGreaterThan(0);
    expect(counts?.fieldCells).toBeGreaterThan(0);
    // The lattice is the map's own, and most of an empty map is water.
    expect(counts?.waterCells ?? 0).toBeGreaterThan(0);
    expect(counts?.waterCells ?? 0).toBeLessThanOrEqual(counts?.latticeCells ?? 0);
  });

  it('throws the window away when the last watcher closes the panel', () => {
    // Otherwise the next developer to open it reads two seconds that ended some time ago as
    // though they were now.
    runtime.setDebugStats('host', true);
    for (let i = 0; i < 4; i += 1) runtime.tick();
    expect(runtime.simStats()?.window).toBe(4);

    runtime.setDebugStats('host', false);
    expect(runtime.anyDebugStats).toBe(false);
    expect(runtime.simStats()?.window).toBe(0);
    expect(runtime.simStats()?.phases.every((phase) => phase.runs === 0)).toBe(true);
  });

  it('keeps measuring while one of two watchers is left', () => {
    runtime.setDebugStats('host', true);
    runtime.setDebugStats('foe', true);
    runtime.setDebugStats('host', false);

    for (let i = 0; i < 4; i += 1) runtime.tick();

    expect(runtime.hasDebugStats('host')).toBe(false);
    expect(runtime.hasDebugStats('foe')).toBe(true);
    expect(runtime.simStats()?.window).toBe(4);
  });
});

function counts() {
  return {
    boats: 0,
    torpedoes: 0,
    zones: 0,
    entities: 0,
    sources: 0,
    listeners: 0,
    fieldCells: 0,
    lookCells: 0,
    reflectorCells: 0,
    clippedFields: 0,
    visionCells: 0,
    latticeCells: 0,
    waterCells: 0,
  };
}

function phaseOf(phases: readonly { phase: PerfPhase }[], want: PerfPhase) {
  const found = phases.find((phase) => phase.phase === want);
  if (found === undefined) throw new Error(`no ${want} phase`);
  return found as (typeof phases)[number] & {
    runs: number;
    mean: number;
    peak: number;
    share: number;
  };
}
