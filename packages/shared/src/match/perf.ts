/**
 * @seg/shared/match/perf — what the simulation is costing, as a debug panel is shown it.
 *
 * The fourth debug view, and the only one that is not about the water. `field.ts`, `reach.ts` and
 * `probe.ts` all answer questions about the *model*; this one answers a question about the
 * *program*: where is a tick going, and what is it going there on. It exists because the tick
 * budget (planning/03 §10) is a design constraint with no instrument — a match that is slowly
 * eating more of its 50 ms is invisible until it is late, and "which part of it" was until now a
 * question only a profiler attached to a live server could answer.
 *
 * ## Three numbers per phase, and why none of them is enough alone
 *
 * - **`mean`** is per *occurrence*, not per tick. The acoustics solve on every second tick and the
 *   overlays on every tenth, so a mean spread over ticks that never ran the phase would quietly
 *   halve the one number a reader most wants to compare against a budget.
 * - **`peak`** is the worst single occurrence in the window. A tick is late because of a spike,
 *   never because of an average, and a phase whose mean is comfortable and whose peak is three
 *   times the budget is the one to look at.
 * - **`share`** is of the *budget* — occurrences summed, over the ticks in the window times the
 *   tick period. It is the only one of the three that is comparable between phases running at
 *   different rates, and the only one that adds up to something meaningful.
 *
 * ## The window, and what a window costs
 *
 * A fixed number of the most recent ticks, so the panel is steady enough to read while still
 * following a fight. Sampling is `performance.now()` around each phase and **it is only paid while
 * somebody is watching** (`server/match/perf.ts`) — a production match nobody has the panel open
 * on takes two dead function calls per phase and no clock reads at all.
 *
 * ## Counts are of the tick that was measured, not of the window
 *
 * Every count here is the latest, not an average: "eleven torpedoes in the water" is a fact a
 * reader can check against the scope in front of them, where "an average of 6.4 torpedoes over the
 * last two seconds" is a number about the past that matches nothing on screen.
 */

/**
 * The five steps of one acoustic solve (`sim/acoustics/solve.ts`).
 *
 * Its own type because the solver is in `@seg/shared` and knows nothing about panels or servers:
 * it takes a probe of exactly this shape and hands it these five names, which is what keeps the
 * measurement injectable and the solve a pure function of its entity list.
 *
 * They are worth splitting where the four steps a tick took before them were not, and the
 * measurements say why: an acoustic tick is two orders of magnitude more expensive than everything
 * around it, and the three big steps here are all proportional to the same `fieldCells` for three
 * different reasons — sweeping it, accumulating into it, and reading back out of it. Which of them
 * dominates is the difference between making the sweep cheaper and making the per-cell work
 * cheaper, and one merged number cannot answer that.
 */
export type SolvePhase = 'reset' | 'hulls' | 'fields' | 'heatmap' | 'look';

/**
 * What the solver hands its timings to, when it is given one.
 *
 * Deliberately not a class and deliberately optional: `AcousticSolver.solve` stays a pure function
 * of its entity list — several tests depend on that — and an object that can only be handed two
 * numbers cannot change an answer. Omitted, the solver pays one `undefined` check per step.
 */
export interface SolveProbe {
  /** The start of a measurement. Whatever this returns comes back to `record`. */
  start(): number;
  record(phase: SolvePhase, since: number): void;
}

/**
 * One measured step. The order here is the order the panel lists them in, which is the order a
 * tick runs them: the world, then the acoustic solve broken open, then the picture, then totals.
 */
export type PerfPhase =
  'world' | 'entities' | SolvePhase | 'acoustics' | 'vision' | 'tick' | 'publish';

export const PERF_PHASES: readonly PerfPhase[] = [
  'world',
  'entities',
  'reset',
  'hulls',
  'fields',
  'heatmap',
  'look',
  'acoustics',
  'vision',
  'tick',
  'publish',
];

/**
 * The steps that happen *inside* `acoustics`, in the order it runs them.
 *
 * `entities` is one of them even though it is the runtime's work rather than the solver's: it is
 * `emittedLevels` and `boatEntity` over the whole world, which is part of what an acoustic tick
 * costs and would otherwise fall into the gap between two phases.
 */
export const PERF_SOLVE_PHASES: readonly PerfPhase[] = [
  'entities',
  'reset',
  'hulls',
  'fields',
  'heatmap',
  'look',
];

/** What each phase is, for the panel's own labels. Short: it sits in a HUD column. */
export const PERF_LABELS: Readonly<Record<PerfPhase, string>> = {
  world: 'WORLD',
  entities: 'ENTITIES',
  reset: 'RESET',
  hulls: 'HULLS',
  fields: 'FIELDS',
  heatmap: 'HEATMAP',
  look: 'LOOK',
  acoustics: 'ACOUSTICS',
  vision: 'VISION',
  tick: 'TICK TOTAL',
  publish: 'PUBLISH',
};

/**
 * The rows that are not parts of the list they sit in — two sums and one outsider.
 *
 * `acoustics` is the six steps above it, measured end to end rather than added up, so the gap
 * between it and their sum is work nobody has attributed yet. `tick` is the whole of
 * `MatchRuntime.tick`, on the same terms. `publish` happens *after* the tick returns, in the
 * handler, so it is outside that total rather than inside it: telling everybody what happened is a
 * different budget from making it happen.
 *
 * None of them is ever marked as hot. A sum is over the threshold whenever one of its parts is,
 * and marking both says nothing the part did not already say.
 */
export const PERF_TOTALS: readonly PerfPhase[] = ['acoustics', 'tick', 'publish'];

/** One phase's readings over the window. All times in milliseconds. */
export interface PerfPhaseView {
  readonly phase: PerfPhase;
  /** How many times it ran in the window. Zero for a phase that is not running at all. */
  readonly runs: number;
  /** Mean milliseconds *per run*. */
  readonly mean: number;
  /** The worst single run in the window. */
  readonly peak: number;
  /** Milliseconds it took in total, as a fraction of the window's tick budget. */
  readonly share: number;
}

/** What the world was made of on the tick this was measured. */
export interface SimCounts {
  readonly boats: number;
  readonly torpedoes: number;
  readonly zones: number;
  /** Entities handed to the acoustic solve: every hull and weapon that is still in the water. */
  readonly entities: number;
  /** How many of them are radiating anything at all. */
  readonly sources: number;
  /** And how many are listening — the number the solve is really linear in. */
  readonly listeners: number;
  /** Lattice cells swept across every propagation field on the last solve. */
  readonly fieldCells: number;
  /**
   * Cells walked by the *reflection* pass, which is a smaller number than `fieldCells`.
   *
   * `look` only walks the fields belonging to listeners, and only theirs — so on a map where one
   * side has been wiped out this falls by half while `fieldCells` does not move at all.
   */
  readonly lookCells: number;
  /** Vision-grid squares every hull's silhouette covers. What `hulls` spends its time on. */
  readonly reflectorCells: number;
  /** Fields cut short by `maxFieldCells` rather than by range. Non-zero is the guardrail biting. */
  readonly clippedFields: number;
  /** Vision squares the last solve reported, across both teams. */
  readonly visionCells: number;
  /** The acoustic lattice's own size, and how much of it is water. Fixed for the match. */
  readonly latticeCells: number;
  readonly waterCells: number;
}

/**
 * One frame of the statistics panel.
 *
 * Self-describing like every other debug payload: the window and the tick period travel with it, so
 * a reader — or a recording — can tell what the shares are shares *of* without knowing the
 * server's constants.
 */
export interface SimStatsView {
  /** The tick it was taken on. */
  readonly tick: number;
  /** How many ticks the window covers. */
  readonly window: number;
  /** Milliseconds one tick is allowed, which is what `share` is measured against. */
  readonly budgetMs: number;
  readonly phases: readonly PerfPhaseView[];
  readonly counts: SimCounts;
}
