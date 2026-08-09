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
 * ## The four phases, and what they actually mean
 *
 * ```
 * launch   → slow, getting round onto the bearing of the point it was sent to
 * running  → up to speed and still steering toward that point
 * enabled  → reached it; what happens next is the load's business
 * spent    → the warhead has gone off, and the weapon is a corpse ringing down
 * ```
 *
 * `launch` is the manoeuvre every load makes and nothing else in the water can: it creeps at
 * `TORPEDO_LAUNCH_SPEED` until it is pointing where it is going — and then for
 * `TORPEDO_LAUNCH_SETTLE_SECONDS` longer, still steering, so that it leaves on a bearing that
 * has stopped moving rather than on one it has just touched. A point *behind* it is reached by
 * braking to a stop and mirroring rather than by turning — the same reversal a submarine makes,
 * for the same reason (`match/movement.ts`). A weapon that turned instead would sweep a
 * three-hundred-metre circle through the water its own fleet is sitting in.
 *
 * `enabled` is planning/04 §7 step 2's *enable point* and it is deliberately about **geometry,
 * not about the seeker**: it says the weapon has arrived, and what happens next is the load's
 * business (`content/weapons.ts#WeaponBehaviour`). A standard torpedo starts pinging and
 * hunting. A super-cavitating one does nothing whatsoever — it stops steering and holds the
 * course it is on until it hits something or its clock runs out. A drone does the same, with its
 * sonar running: an enable point for a weapon with no warhead is where the imaging starts. One
 * phase, several behaviours, because the *transition* is the same fact in every case and giving
 * each load its own phase name would be inventing a difference the simulation does not have.
 *
 * `spent` is the other one worth explaining. A weapon that detonated does **not** leave the
 * world at the moment of impact: the bang is a four-second transient (`torpedo-detonation`) and
 * it has to come from where the bang was, so a spent weapon lingers, silent apart from that,
 * until it has rung down. Removing it earlier would delete the loudest event in the game from
 * the ocean it happened in.
 */

import {
  TORPEDO_LAUNCH_SPEED,
  TORPEDO_LENGTH,
  getWeapon,
  type WeaponId,
} from '../content/weapons.js';
import type { HullId } from '../content/hulls.js';
import type { Stats } from '../content/stats.js';
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
export type TorpedoPhase = 'launch' | 'running' | 'enabled' | 'spent';

/**
 * The boat an active decoy is pretending to be. `null` on every other load.
 *
 * A **copy taken at launch**, not a reference to the boat, and that is the whole of the
 * mechanic's honesty: the decoy goes on sounding like the submarine that fired it after that
 * submarine has slowed down, been damaged, or been sunk. A player who dives away from their own
 * decoy leaves a version of themselves behind — which is the point of firing one.
 *
 * It carries the hull class for the silhouette and the resolved stat block for the noise,
 * because those are exactly the two things `sim/acoustics/boats.ts#boatEntity` reads. The decoy
 * reaches the solver through the same door with the same numbers, so nothing downstream has to
 * be told that one of the two submarines in the picture is seven metres long.
 */
export interface DecoyMimic {
  readonly hull: HullId;
  /** The launching boat's *resolved* stats — its modules are part of how it sounds. */
  readonly stats: Stats;
}

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

  /**
   * The boat this weapon is imitating, for an active decoy — `null` for everything else.
   *
   * Static like everything above it: taken once at launch and never refreshed. See `DecoyMimic`.
   */
  readonly mimic: DecoyMimic | null;

  readonly pos: Vec2;
  /** Degrees, `0` along `+x`, positive counter-clockwise. Clamped to the weapon's pitch band. */
  readonly facing: number;
  /** m/s along `facing`. Chases `cruiseSpeed` at `TORPEDO_ACCELERATION`, up or down. */
  readonly speed: number;
  /**
   * The tick this weapon came onto its launch bearing, or `0` — for either "not yet" or "no
   * longer".
   *
   * The launch phase ends `TORPEDO_LAUNCH_SETTLE_SECONDS` after this, so what it measures is time
   * spent **settled**, not time spent since first touching the mark: a weapon knocked off its
   * heading — by a reversal begun late, or by a bearing that swings past it — has this cleared
   * and starts the hold again. A single tick rather than a countdown, like `lastPingTick` and
   * `trackTick` and for the same reason: the simulation's only clock is the tick count, and a
   * timer counting down would be a second one to keep in step with it (planning/02 §5).
   *
   * Meaningless once the weapon is past `launch`, and not cleared there — nothing reads it, and
   * clearing it would cost a copy of every weapon in the water on the tick it stops mattering.
   */
  readonly alignedTick: number;
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
 * The fastest this particular weapon goes, m/s.
 *
 * The table's number for everything except a decoy, which runs at the **flank speed of the boat
 * that fired it** — a false contact that could be outrun by the thing it is imitating would be a
 * false contact for about ten seconds. A decoy with no mimic falls back to the table, which only
 * a hand-built fixture can produce (`sim/weapons/launch.ts` always fills it in).
 */
export function topSpeed(torpedo: TorpedoState): number {
  if (torpedo.mimic !== null) return torpedo.mimic.stats.maxSpeed;
  return getWeapon(torpedo.weapon).speed;
}

/**
 * The speed this weapon is trying to be doing right now, m/s — which is the launch phase, and
 * nothing else.
 *
 * **Launching**: creeping, so it can get round (`TORPEDO_LAUNCH_SPEED`), and never faster than
 * the weapon's own cruise — a load slower than the creep does not speed *up* to manoeuvre.
 * **Afterwards**: flat out, for every load there is. Nothing in the water stops, holds station,
 * or throttles back; a weapon has one speed and the only question the simulation asks is whether
 * it has got there yet.
 */
export function cruiseSpeed(torpedo: TorpedoState): number {
  const top = topSpeed(torpedo);
  return torpedo.phase === 'launch' ? Math.min(TORPEDO_LAUNCH_SPEED, top) : top;
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
  return radiusAt(def.speed, def.turnRate);
}

/**
 * The circle this weapon is flying *now*, metres — `turningRadius` against the speed it is
 * actually making rather than the one on its data sheet.
 *
 * The launch phase is the reason it exists. A weapon creeping at `TORPEDO_LAUNCH_SPEED` turns
 * inside sixteen metres where the same weapon at cruise needs fifty, and the "has it arrived"
 * test is a statement about the circle (`sim/weapons/kinematics.ts#hasArrived`) — asking it
 * against the data sheet would have a weapon still getting round declare a point three hundred
 * metres away already reached.
 */
export function turningRadiusOf(torpedo: TorpedoState): number {
  return radiusAt(cruiseSpeed(torpedo), getWeapon(torpedo.weapon).turnRate);
}

/** `r = v / ω`, with the degrees-per-second the table quotes turn rates in. */
function radiusAt(speed: number, turnRate: number): number {
  const omega = (turnRate * Math.PI) / 180;
  return omega <= 0 ? Infinity : speed / omega;
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
