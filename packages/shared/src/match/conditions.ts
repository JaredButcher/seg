/**
 * @seg/shared/match/conditions — what a `Modifier`'s `condition` checks, live.
 *
 * `content/stats.ts#Condition` is the closed vocabulary a module can speak; this is the one file
 * that reads it against an actual boat. Teaching the game a new condition — depth, damage, active
 * sonar, whatever comes up — is a variant on `Condition` plus a field on `ConditionContext` plus a
 * case in `conditionMet`. Nowhere else needs to change: `liveStatsOf` folds every condition the
 * same way, and every module-fitting module keeps working exactly as it does today by simply not
 * setting `condition` at all.
 *
 * ## Why this is not `applyModifiers` with an extra argument
 *
 * `content/stats.ts#applyModifiers` is deliberately unconditional — it is what the fleet editor
 * calls, and the editor has no boat under way to check a condition against, so it shows a
 * module's full effect and leaves the "when" to the module's own `description`. `liveStatsOf`
 * here is the *other* caller: the one the running match uses, which does have a boat, and which
 * filters to what is actually true of it before handing the rest to the same `applyModifiers`. One
 * resolver underneath both, so the two can never compute the stacking rules differently — only
 * whether a given modifier is in play at all.
 */

import {
  applyModifiers,
  activeModifiers,
  type Condition,
  type Modifier,
  type Stats,
} from '../content/stats.js';
import { getHull } from '../content/hulls.js';
import type { BoatState, ThrottleNotch } from './world.js';

/**
 * Whichever live facts about a boat a `Condition` might need. Grows as conditions do — today just
 * the throttle notch, because that is the only fact anything checks.
 */
export interface ConditionContext {
  readonly throttle: ThrottleNotch;
}

/** Whether `condition` holds right now, for a boat described by `context`. */
export function conditionMet(condition: Condition, context: ConditionContext): boolean {
  switch (condition.kind) {
    case 'throttle':
      return condition.notch === context.throttle;
  }
}

/**
 * A boat's stats, right now — every unconditional modifier applied, and every conditional one
 * folded in only where `context` says its condition holds.
 *
 * Pure over primitives rather than over a `BoatState`, so it can be called before one fully
 * exists (`match/deploy.ts`, which has a hull's base stats and a resolved modifier list before it
 * has anywhere to put them) as well as after (`refreshStats`, below).
 */
export function liveStatsOf(
  base: Stats,
  modifiers: readonly Modifier[],
  context: ConditionContext,
): Stats {
  return applyModifiers(
    base,
    activeModifiers(modifiers, (condition) => conditionMet(condition, context)),
  );
}

/**
 * A boat with `stats` recomputed off its own hull, its own fitted modules, and whatever it is
 * doing right now.
 *
 * Called every tick (`server/match/runtime.ts#tick`, right after `stepBoat`) rather than only
 * when `throttle` changes, on purpose: a future condition might key off something that drifts on
 * its own, like depth, and a boat that changed the fact a condition reads without anyone touching
 * the throttle would otherwise keep the stats it had before. A fold over a handful of modifiers,
 * once per boat per tick, costs nothing next to the acoustic solve it feeds.
 */
export function refreshStats(boat: BoatState): BoatState {
  return {
    ...boat,
    stats: liveStatsOf(getHull(boat.hull).stats, boat.moduleModifiers, { throttle: boat.throttle }),
  };
}
