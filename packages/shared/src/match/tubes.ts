/**
 * @seg/shared/match/tubes — the loading gear, as a set of pure transitions.
 *
 * A tube is a tiny state machine and it is the only part of the weapons system a player operates
 * *between* shots, so it is worth having on its own away from the ballistics. Everything here is
 * a pure function of one tube and returns a new one; the runtime maps them over a boat.
 *
 * ```
 *          fire ──────────────┐          the weapon leaves; reload starts at once
 *   loaded ──── choose next ──┤          a decision about the future, no state change
 *          └─── swap (shift) ─┼──► unloading ──► reloading ──► loaded
 *                             └──────────────────► reloading ──► loaded
 * ```
 *
 * ## Reloading begins immediately, and that is the whole of the tempo
 *
 * A tube starts refilling on the tick it fires. Nothing is spent, nothing is chosen, and the
 * player is not asked a question at the worst possible moment — which is what makes `next` a
 * decision made *before* the shot rather than after it. A boat with three tubes and a 32 s reload
 * therefore has a rhythm the player learns rather than a resource they manage.
 *
 * ## Unloading is the price of changing your mind
 *
 * Swapping a load the tube already holds is not free, because a free swap would make `next`
 * pointless: a player could keep every tube on the cheap load and switch the instant a target
 * appeared. So the weapon has to come out first (`UNLOAD_SECONDS`), and only then does the
 * ordinary reload run. Together that is a tube out of action for longer than a shot would have
 * cost — the swap is a real commitment, and the shot you did not take is part of its price.
 *
 * ## What is not here
 *
 * No ammunition count, because torpedoes are unlimited (planning/05 §4). No per-tube weapon
 * choice at fleet-build time either — the editor cannot express it yet (Q6), so every tube
 * deploys holding `DEFAULT_WEAPON` and the in-battle picker is the only way to change one.
 */

import { getWeapon, isDeployableWeapon, type WeaponId } from '../content/weapons.js';
import type { Stats } from '../content/stats.js';
import type { TubeState } from './world.js';

/**
 * Seconds to get an unwanted weapon back out of a tube.
 *
 * A fraction of a reload rather than another one: the design says "emptied over a short time
 * period", and the punishment that matters is the reload that follows. Not scaled by
 * `reloadSeconds`, because a Heavy's faster loading gear is about pushing weapons *in*, and
 * because one number is easier for a player to hold than a per-hull table.
 */
export const UNLOAD_SECONDS = 8;

/** Whether this tube can put a weapon in the water right now. */
export function canFire(tube: TubeState): boolean {
  return tube.status === 'loaded' && isDeployableWeapon(tube.weapon);
}

/**
 * A tube's state one tick after firing: empty of the weapon that just left, and already filling
 * with whatever `next` says.
 *
 * `weapon` becomes `next` immediately rather than when the reload finishes, which is what lets
 * the fleet list draw the incoming load dimmed — a player watching a tube refill can see what is
 * arriving, and that is the readout the `next` decision is made against.
 */
export function fired(tube: TubeState, stats: Stats): TubeState {
  return {
    ...tube,
    weapon: tube.next,
    status: 'reloading',
    readyInSeconds: reloadSecondsFor(stats),
  };
}

/**
 * Choose what goes in next time. Legal in every status — it is a note about the future, except
 * for a tube already *reloading*.
 *
 * A reloading tube has nothing in it yet, so there is no "next cycle" to defer to — `weapon` is
 * only ever the label on a timer. Retargeting that timer costs nothing extra (`reloadSecondsFor`
 * does not vary by weapon), so a change of mind lands in the tube that is already spinning up
 * instead of waiting for the one after it, which is the load a player watching the countdown is
 * actually asking for.
 */
export function chooseNext(tube: TubeState, weapon: WeaponId): TubeState {
  if (tube.next === weapon) return tube;
  if (tube.status === 'reloading') return { ...tube, next: weapon, weapon };
  return { ...tube, next: weapon };
}

/**
 * Throw away what is in the tube and put `weapon` in instead — shift-clicking the picker.
 *
 * Only from `loaded`: a tube that is already cycling has nothing to eject, and the honest
 * answer for one that is is `chooseNext`, which the caller has already done. Returns the tube
 * unchanged when there is nothing to swap, so a caller can always call both.
 */
export function swapTo(tube: TubeState, weapon: WeaponId): TubeState {
  if (tube.status !== 'loaded') return tube;
  return { ...tube, next: weapon, status: 'unloading', readyInSeconds: UNLOAD_SECONDS };
}

/**
 * Advance a tube by `dt` seconds.
 *
 * `unloading` runs into `reloading` rather than into `loaded`, and the overshoot is carried
 * across: a tick that finishes an unload with 10 ms to spare puts that 10 ms into the reload,
 * so the total is the same however the tick boundaries fall. Without that, a swap would take a
 * variable extra fraction of a tick and two identical matches could disagree.
 */
export function stepTube(tube: TubeState, stats: Stats, dt: number): TubeState {
  if (tube.status !== 'reloading' && tube.status !== 'unloading') return tube;

  const remaining = tube.readyInSeconds - dt;
  if (remaining > 0) return { ...tube, readyInSeconds: remaining };

  if (tube.status === 'unloading') {
    // `remaining` is negative or zero here — the leftover of this tick, spent on the reload.
    return {
      ...tube,
      weapon: tube.next,
      status: 'reloading',
      readyInSeconds: Math.max(0, reloadSecondsFor(stats) + remaining),
    };
  }

  return { ...tube, status: 'loaded', readyInSeconds: 0 };
}

/**
 * How long a reload takes on this boat.
 *
 * Off the resolved stat block, so Rapid Loader's −25% is already in it. Floored at a tenth of a
 * second so that a hypothetical stack of loaders can never produce a tube that reloads inside
 * one tick, which would be a boat firing at 20 Hz.
 */
export function reloadSecondsFor(stats: Stats): number {
  return Math.max(0.1, stats.reloadSeconds);
}

/** A fresh tube, loaded and with the same variant queued behind it. */
export function newTube(index: number, weapon: WeaponId): TubeState {
  return { index, weapon, next: weapon, status: 'loaded', readyInSeconds: 0 };
}

/**
 * Why a tube cannot fire, for the HUD to say out loud. `null` when it can.
 *
 * Text rather than a code because there is exactly one consumer and the strings are the whole
 * of the information — a `TubeProblem` union would be a second vocabulary to keep in step with
 * this one for no gain. Kept beside the rule it describes so the two cannot drift.
 */
export function describeTubeProblem(tube: TubeState): string | null {
  if (tube.status === 'loaded' && isDeployableWeapon(tube.weapon)) return null;
  switch (tube.status) {
    case 'reloading':
      return `Tube ${String(tube.index + 1)} is reloading.`;
    case 'unloading':
      return `Tube ${String(tube.index + 1)} is being emptied.`;
    case 'empty':
      return `Tube ${String(tube.index + 1)} is out of action.`;
    default:
      return `${getWeapon(tube.weapon).name} cannot be fired yet.`;
  }
}
