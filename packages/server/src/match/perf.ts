/**
 * @seg/server/match/perf — the stopwatch behind the statistics panel.
 *
 * A fixed window of the most recent ticks, one slot per tick per phase, summed on demand
 * (`@seg/shared/match/perf.ts` is what comes out and what the numbers mean). It is a ring buffer
 * rather than a running average because a decaying mean cannot answer the question the panel is
 * actually open for — *what was the worst tick in the last two seconds* — and because a window
 * with a hard edge is one a reader can reason about: everything in it happened, everything out of
 * it did not.
 *
 * ## Off costs nothing, and that is the whole design
 *
 * Instrumenting a hot path unconditionally is how a profiler becomes the thing being profiled.
 * While `enabled` is false, `start()` returns zero without reading a clock and `record()` returns
 * on its first line — so a production match pays two function calls per phase per tick and no
 * `performance.now()` at all. The numbers therefore begin at the moment somebody switches the
 * panel on, which is the honest behaviour: what is being measured is the server as it is running
 * now, not a history it was never keeping.
 *
 * ## One slot per tick, cleared on the way in
 *
 * `beginTick` zeroes the slot the tick is about to write, so a window is always exactly the last
 * `PERF_WINDOW` ticks and a phase that stopped running leaves the window on its own rather than
 * having to be told to. A phase that runs twice in one tick accumulates into the same slot, which
 * is what makes the total honest for anything that is called more than once.
 */

import {
  PERF_PHASES,
  SIM_TICK_HZ,
  type PerfPhase,
  type PerfPhaseView,
  type SimCounts,
  type SimStatsView,
} from '@seg/shared';

/**
 * How many ticks a window covers. Forty, which is two seconds at 20 Hz.
 *
 * Long enough that the means stop jittering with individual frames, short enough that switching a
 * boat to flank shows up while the developer's hand is still on the key. It is also what `peak`
 * means: the worst tick in the last two seconds, not the worst tick of the match.
 */
export const PERF_WINDOW = 40;

/** Milliseconds one tick is allowed. What every `share` is a share of. */
const BUDGET_MS = 1000 / SIM_TICK_HZ;

/** One phase's ring: milliseconds per tick slot, and whether it ran in that slot at all. */
class PhaseRing {
  private readonly times = new Float64Array(PERF_WINDOW);
  private readonly ran = new Uint8Array(PERF_WINDOW);

  clear(slot: number): void {
    this.times[slot] = 0;
    this.ran[slot] = 0;
  }

  add(slot: number, ms: number): void {
    this.times[slot] = (this.times[slot] ?? 0) + ms;
    this.ran[slot] = 1;
  }

  view(phase: PerfPhase, ticks: number): PerfPhaseView {
    let total = 0;
    let peak = 0;
    let runs = 0;
    for (let i = 0; i < PERF_WINDOW; i += 1) {
      if (this.ran[i] !== 1) continue;
      const ms = this.times[i] ?? 0;
      total += ms;
      runs += 1;
      if (ms > peak) peak = ms;
    }
    return {
      phase,
      runs,
      mean: runs === 0 ? 0 : total / runs,
      // Against the ticks that have actually happened, not against a full window — a panel opened
      // three ticks ago would otherwise read a third of the truth and climb for two seconds.
      share: ticks === 0 ? 0 : total / (ticks * BUDGET_MS),
      peak,
    };
  }
}

export class PerfTracker {
  /**
   * Whether anything is being measured at all.
   *
   * Set from the *watchers*, not from the panel being drawn: the sampling has to be running while
   * the tick runs, which is well before anybody is sent anything (`MatchRuntime.setDebugStats`).
   */
  enabled = false;

  private readonly rings = new Map<PerfPhase, PhaseRing>();
  /** The slot the current tick is writing, and how many slots hold a real tick. */
  private slot = 0;
  private ticks = 0;
  private latest = 0;

  constructor() {
    for (const phase of PERF_PHASES) this.rings.set(phase, new PhaseRing());
  }

  /**
   * A new tick is starting: take its slot and wipe whatever the tick 40 before it left there.
   *
   * Cheap enough to be unconditional if it had to be — nine array writes — but it is gated like
   * everything else here, because "unconditional and cheap" is how a hot path acquires a dozen
   * cheap things.
   */
  beginTick(tick: number): void {
    if (!this.enabled) return;
    this.slot = ((tick % PERF_WINDOW) + PERF_WINDOW) % PERF_WINDOW;
    this.latest = tick;
    if (this.ticks < PERF_WINDOW) this.ticks += 1;
    for (const ring of this.rings.values()) ring.clear(this.slot);
  }

  /** The start of a measurement, or `0` when nothing is being measured. */
  start(): number {
    return this.enabled ? performance.now() : 0;
  }

  /** And the end of one. `since` is whatever `start()` handed back. */
  record(phase: PerfPhase, since: number): void {
    if (!this.enabled) return;
    this.rings.get(phase)?.add(this.slot, performance.now() - since);
  }

  /**
   * The window as the wire carries it. Counts are the caller's — they are facts about the world
   * rather than about the clock, and this class has no view of the world at all.
   */
  snapshot(counts: SimCounts): SimStatsView {
    return {
      tick: this.latest,
      window: this.ticks,
      budgetMs: BUDGET_MS,
      phases: PERF_PHASES.map(
        (phase) => this.rings.get(phase)?.view(phase, this.ticks) ?? emptyPhase(phase),
      ),
      counts,
    };
  }

  /**
   * Forget everything measured so far.
   *
   * Called when the last watcher goes away, so the next one to open the panel does not read two
   * seconds of a window that stopped being filled some time in the last match.
   */
  reset(): void {
    this.ticks = 0;
    for (const ring of this.rings.values()) {
      for (let i = 0; i < PERF_WINDOW; i += 1) ring.clear(i);
    }
  }
}

function emptyPhase(phase: PerfPhase): PerfPhaseView {
  return { phase, runs: 0, mean: 0, peak: 0, share: 0 };
}
