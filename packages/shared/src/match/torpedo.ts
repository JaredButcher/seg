/**
 * @seg/shared/match/torpedo — what a weapon in the water *is*, as the server holds it.
 *
 * The data model only, exactly as `world.ts` is for boats: nothing here integrates, seeks, or
 * fuzes. That is `sim/weapons`. What this settles is the vocabulary — which is the expensive
 * part to change later, because the wire, the HUD, and the replay all quote it.
 *
 * ## It is a boat with fewer opinions
 *
 * Same frame (metres, x right, y up from the seabed), same `facing` convention (degrees, `0`
 * along `+x`, positive counter-clockwise), same `transients` list decaying by the same rule.
 * That sameness is load-bearing rather than tidy: planning/04 §4 wants one entity model so that
 * a torpedo and a submarine share the acoustic path, and `sim/acoustics/boats.ts#emittedLevels`
 * is the function they share. Nothing downstream of the solver knows a weapon from a hull.
 *
 * ## The three phases, and what they actually mean
 *
 * ```
 * running  → still steering toward the aim point
 * enabled  → reached it; a weapon with a seeker wakes up here, one without runs straight on
 * spent    → the warhead has gone off, and the weapon is a corpse ringing down
 * ```
 *
 * `enabled` is planning/04 §7 step 2's *enable point* and it is deliberately about **geometry,
 * not about the seeker**: it says the weapon has arrived, and what happens next is the load's
 * business. A standard torpedo starts pinging and hunting. A super-cavitating one does nothing
 * whatsoever — it stops steering and holds the course it is on until it hits something or its
 * clock runs out, which is exactly the weapon planning/05 §4 describes. Two behaviours, one
 * phase, because the *transition* is the same fact in both cases and giving each load its own
 * phase name would be inventing a difference the simulation does not have.
 *
 * `spent` is the other one worth explaining. A weapon that detonated does **not** leave the
 * world at the moment of impact: the bang is a four-second transient (`torpedo-detonation`) and
 * it has to come from where the bang was, so a spent weapon lingers, silent apart from that,
 * until it has rung down. Removing it earlier would delete the loudest event in the game from
 * the ocean it happened in.
 */

import { TORPEDO_LENGTH, getWeapon, type WeaponId } from '../content/weapons.js';
import type { Vec2 } from '../map/types.js';
import type { AccountId } from '../lobby/state.js';
import type { BoatTransient, EntityId, TeamId } from './world.js';

/**
 * Where a weapon is in its life. See the header on why `spent` exists at all.
 *
 * A plain union rather than a tagged one carrying per-phase data: every field a phase would want
 * is wanted by at least one other phase too — `aim` is drawn for a running weapon and is the
 * fallback course for a seeking one, `target` is null until acquisition and null again on a
 * lost track — so a discriminated union would be three shapes with the same fields in it.
 */
export type TorpedoPhase = 'running' | 'enabled' | 'spent';

/**
 * One weapon in the water.
 *
 * The static half is everything above `pos` and never changes; the volatile half is everything
 * from `pos` down. Unlike a boat there is no `MatchSetup` to carry the static half once, because
 * a torpedo is born mid-match and dies inside a minute — the whole record travels in view frames
 * and it is small enough that this costs nothing.
 */
export interface TorpedoState {
  readonly id: EntityId;
  readonly weapon: WeaponId;
  readonly team: TeamId;
  /** The account that fired it. Friendly fire is on (Q7), so this is for blame, not for safety. */
  readonly owner: AccountId;
  /** The boat that fired it, for the launch report and for the wire once guidance exists (Q5). */
  readonly firedBy: EntityId;
  /** The sim tick it left the tube on. Its age, and what `lifetimeSeconds` is measured from. */
  readonly firedTick: number;
  /**
   * Where the player clicked.
   *
   * Two different things depending on the load, and that difference is the whole of the
   * per-shot decision (`content/weapons.ts`): for a standard torpedo it is the **enable point**,
   * where the seeker wakes up, and for a super-cavitating one it is simply the point it is
   * aimed at, past which it keeps going in a straight line.
   */
  readonly aim: Vec2;

  readonly pos: Vec2;
  /** Degrees, `0` along `+x`, positive counter-clockwise. Clamped to the weapon's pitch band. */
  readonly facing: number;
  /** m/s along `facing`. Accelerates out of the tube at `TORPEDO_ACCELERATION`. */
  readonly speed: number;
  /** Metres of water covered so far. Fuel, and the other half of the expiry rule. */
  readonly travelled: number;
  readonly phase: TorpedoPhase;

  /**
   * Where its seeker last heard something, or `null`.
   *
   * A **position**, not an entity: the seeker is the same short-sighted listener the acoustic
   * model gives everything else, and what it produces is "something loud, over there". A weapon
   * that held an entity id would be a weapon that cannot be decoyed, cannot lose a track, and
   * cannot be talked into a teammate — all three of which the design wants (planning/04 §7).
   */
  readonly track: Vec2 | null;
  /** The sim tick `track` was measured at. `SEEKER_HOLD_SECONDS` past it, the track is dropped. */
  readonly trackTick: number;
  /** The sim tick of its last seeker pulse, or `0`. The same rhythm rule boats use. */
  readonly lastPingTick: number;

  /** The noise events still ringing on it — launch, and eventually the detonation. */
  readonly transients: readonly BoatTransient[];
}

/**
 * A weapon's outline, for the acoustic model to reflect off.
 *
 * A flat sliver rather than a real shape: at `VISION_CELL_SIZE` of 2 m a seven-metre torpedo is
 * three squares long and one high, so any polygon more detailed than this rasterizes to exactly
 * the same three squares. What it buys over a point is that a weapon coming at you bow-on
 * presents *less* than one crossing your beam, which is correct and free.
 */
export function torpedoOutline(pos: Vec2, facing: number): Vec2[] {
  const radians = (facing * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const half = TORPEDO_LENGTH / 2;
  const beam = 0.6;

  return [
    { x: pos.x + half * cos - beam * sin, y: pos.y + half * sin + beam * cos },
    { x: pos.x - half * cos - beam * sin, y: pos.y - half * sin + beam * cos },
    { x: pos.x - half * cos + beam * sin, y: pos.y - half * sin - beam * cos },
    { x: pos.x + half * cos + beam * sin, y: pos.y + half * sin - beam * cos },
  ];
}

/** Seconds since it left the tube. */
export function torpedoAge(torpedo: TorpedoState, tick: number, tickHz: number): number {
  return (tick - torpedo.firedTick) / tickHz;
}

/**
 * The tightest circle this weapon can fly at its cruising speed, metres: `r = v / ω`.
 *
 * It is the number the whole feel of the pair hangs off. A standard torpedo at 22 m/s and 25 °/s
 * turns inside 50 m and can genuinely chase; a super-cavitating one at 55 m/s and 10 °/s needs
 * 315 m, which is most of its useful range — it cannot be talked out of the line it left the
 * tube on, and that is its designed weakness in the horizontal to go with its pitch band's in
 * the vertical.
 *
 * It also decides when a weapon counts as having *arrived*: a point inside the turning circle
 * can never be touched however long the weapon circles, which is the same geometry
 * `match/movement.ts#maxApproachSpeed` deals with at the other end. A boat slows down for it; a
 * torpedo cannot slow down, so it settles for being that close.
 */
export function turningRadius(weapon: WeaponId): number {
  const def = getWeapon(weapon);
  const omega = (def.turnRate * Math.PI) / 180;
  return omega <= 0 ? Infinity : def.speed / omega;
}

/**
 * Whether a weapon's clock or its fuel has run out.
 *
 * Either one ends it, and the two are separate on purpose: a weapon that spends its life turning
 * covers less water than one that runs straight, and `lifetimeSeconds` is what stops a circling
 * torpedo outliving the engagement it was fired into. Both end in a detonation rather than a
 * fizzle — see `lifetimeSeconds` on why.
 */
export function torpedoExpired(torpedo: TorpedoState, tick: number, tickHz: number): boolean {
  const def = getWeapon(torpedo.weapon);
  return torpedoAge(torpedo, tick, tickHz) >= def.lifetimeSeconds || torpedo.travelled >= def.range;
}

/**
 * Damage a hull `distance` metres from the burst takes.
 *
 * Linear falloff to nothing at `damageRadius` — planning/04 §8 asks for "a flat value with
 * falloff from detonation distance" and gives no curve, so this is the one that is easiest for a
 * player to predict. A near miss hurts, which is what makes a proximity fuze worth having.
 */
export function detonationDamage(weapon: WeaponId, distance: number): number {
  const def = getWeapon(weapon);
  if (def.damageRadius <= 0) return distance <= 0 ? def.damage : 0;
  const falloff = 1 - distance / def.damageRadius;
  return falloff <= 0 ? 0 : def.damage * falloff;
}
