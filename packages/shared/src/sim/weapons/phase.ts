/**
 * The weapons phase — step 5 of planning/04 §1's tick, in pure form.
 *
 * Movement has run and collision has settled the fleet; this is what the weapons in the water do
 * about it. Every torpedo advances, arms, hunts, hits, or dies, and the tubes on every boat turn
 * over. One phase for both because they are the same subsystem seen at two ends, and because the
 * runtime should call one function per step of the loop rather than three.
 *
 * It runs at the full **20 Hz**, and that is the reason 20 Hz exists: planning/04 §1 says so in
 * as many words — a 55 m/s weapon covers 5.5 m per tick here and 11 m at the acoustic rate, which
 * is comparable to a hull's own beam and would make proximity fuzing coarse and tunnelling real.
 *
 * ## The order inside a tick, and why it is that order
 *
 * ```
 * 1. spent weapons        ring down and leave                    the bang outlives the weapon
 * 2. expiry               a clock or a fuel gauge → detonation   checked before it moves
 * 3. steer and integrate  kinematics.ts                          one step, no map
 * 4. arrival              running → enabled                      geometry, not the seeker
 * 5. terrain              a wall is a detonation                 before hulls: rock is cover
 * 6. hulls                proximity fuze → detonation
 * 7. seeker               a pulse, and maybe a track             only if it survived the tick
 * ```
 *
 * Five before six is planning/04 §7's "rock is cover from torpedoes, not just from sonar": a
 * weapon that would have reached a hull *through* a wall hits the wall. Seven last because a
 * weapon that has already gone off has nothing to look for.
 *
 * ## Detonation is a fact about the world, not about a target
 *
 * A warhead going off damages **everything** inside `damageRadius`, both teams and the firer
 * included (Q7). There is no "the boat it was aimed at" anywhere in this file — the fuze finds a
 * hull, the burst finds hulls, and whose they are never comes up. That is what makes a torpedo
 * fired down a passage your own boat is in a genuinely bad idea rather than a warning message.
 *
 * ## What is refused rather than half-built
 *
 * No wire guidance (Q5) — a weapon is committed the moment it leaves the tube. No decoys and no
 * countermeasures, because the loads that produce them are not deployable yet
 * (`content/weapons.ts`). No wreck sinking: a boat destroyed here stops where it died, exactly
 * as it does after a collision, and the wreck entity planning/04 §8 wants lands with the wreck.
 */

import { type AcousticTuning } from '../../content/acoustics.js';
import { getHull } from '../../content/hulls.js';
import {
  SEEKER_HOLD_SECONDS,
  SEEKER_INTERVAL_MS,
  TORPEDO_PROXIMITY_FUZE,
  getWeapon,
} from '../../content/weapons.js';
import type { Vec2 } from '../../map/types.js';
import {
  detonationDamage,
  torpedoExpired,
  torpedoOutline,
  type TorpedoState,
} from '../../match/torpedo.js';
import { stepTube } from '../../match/tubes.js';
import {
  pruneTransients,
  withTransient,
  type BoatState,
  type EntityId,
} from '../../match/world.js';
import { hullOutline } from '../acoustics/boats.js';
import { distanceToPolygon } from '../collision/geometry.js';
import type { TerrainCollider } from '../collision/terrain.js';
import { hasArrived, stepTorpedo } from './kinematics.js';
import { seekerLook } from './seeker.js';

/**
 * Seconds after launch before the fuze is live.
 *
 * A real safety interlock, and here it does a real job: a weapon leaves the tube a few metres
 * ahead of a hull that can be 170 m long, and without this a Heavy firing while turning could
 * plausibly find its own flank inside the proximity radius. It also stops a four-tube salvo
 * fuzing on the boat that launched it while the boat is still moving forward through it.
 */
export const FUZE_ARM_SECONDS = 1.5;

export interface WeaponsPhase {
  /** The fleet as collision left it. Tubes are stepped and damage is applied to this. */
  readonly boats: readonly BoatState[];
  readonly torpedoes: readonly TorpedoState[];
  /** The map's rock, or `null` on a map with nothing to hit. */
  readonly terrain: TerrainCollider | null;
  readonly tick: number;
  readonly tickHz: number;
  readonly tuning?: AcousticTuning;
}

/** One warhead going off, for whatever wants to report it. */
export interface Detonation {
  /** The weapon that went off. It is `spent` in the returned list, not gone. */
  readonly torpedo: EntityId;
  readonly at: Vec2;
  /** Hulls that took damage, and how much. Empty for a weapon that hit rock or timed out. */
  readonly hits: readonly { readonly boat: EntityId; readonly damage: number }[];
}

export interface WeaponsOutcome {
  readonly boats: readonly BoatState[];
  readonly torpedoes: readonly TorpedoState[];
  /** Every warhead that went off this tick. Empty on almost every tick. */
  readonly detonations: readonly Detonation[];
  /**
   * Whether any boat's hit points or status moved.
   *
   * The standings are derived from the fleet (`match/state.ts#standingFor`), and recomputing them
   * every tick would be a scan of both fleets at 20 Hz for an answer that changes a handful of
   * times a match. The same bargain `resolveCollisions` makes with its identity return.
   */
  readonly damaged: boolean;
}

/**
 * Advance every weapon and every tube by one tick.
 *
 * Returns the same arrays it was given when nothing at all happened — no weapons in the water
 * and no tube mid-cycle — which is most of a match, and which is what keeps a quiet tick free.
 */
export function stepWeapons(phase: WeaponsPhase): WeaponsOutcome {
  const { boats, torpedoes, terrain, tick, tickHz, tuning } = phase;
  const dt = 1 / tickHz;

  const tubes = stepTubes(boats, dt);
  if (torpedoes.length === 0) {
    return { boats: tubes, torpedoes, detonations: [], damaged: false };
  }

  // Damage is accumulated and applied once at the end, so a boat caught by two warheads in one
  // tick takes both — and so a hull destroyed by the first is still a legal target for the
  // second, which is the only reading that does not make the iteration order matter.
  const harm = new Map<EntityId, number>();
  const detonations: Detonation[] = [];
  const next: TorpedoState[] = [];

  /** Fire the warhead here, note what it caught, and hand back the corpse. */
  const detonate = (torpedo: TorpedoState, at: Vec2): TorpedoState => {
    const hits: { boat: EntityId; damage: number }[] = [];
    const radius = getWeapon(torpedo.weapon).damageRadius;

    for (const boat of tubes) {
      if (boat.status === 'destroyed') continue;
      // Cheap rejection first: nothing outside the burst plus half a hull can be touched by it.
      const hull = getHull(boat.hull);
      if (Math.hypot(boat.pos.x - at.x, boat.pos.y - at.y) > radius + hull.length) continue;

      const distance = distanceToPolygon(at, hullOutline(hull, boat.pos, boat.facing));
      const damage = detonationDamage(torpedo.weapon, distance);
      if (damage <= 0) continue;
      harm.set(boat.id, (harm.get(boat.id) ?? 0) + damage);
      hits.push({ boat: boat.id, damage });
    }

    detonations.push({ torpedo: torpedo.id, at, hits });
    return withTransient(
      { ...torpedo, pos: at, phase: 'spent', speed: 0, track: null },
      'torpedo-detonation',
      tick,
      tickHz,
    );
  };

  for (const torpedo of torpedoes) {
    // ── 1. A corpse, ringing down ───────────────────────────────────────────────
    if (torpedo.phase === 'spent') {
      const rung = pruneTransients(torpedo, tick, tickHz);
      // Only when the last of the bang has gone. Dropping it at the moment of impact would take
      // the detonation out of the ocean before anybody could hear it.
      if (rung.transients.length > 0) next.push(rung);
      continue;
    }

    const live = pruneTransients(torpedo, tick, tickHz);

    // ── 2. Out of time or out of fuel ───────────────────────────────────────────
    if (torpedoExpired(live, tick, tickHz)) {
      next.push(detonate(live, live.pos));
      continue;
    }

    // ── 3. Steer and integrate ──────────────────────────────────────────────────
    const step = live.speed * dt;
    let moved = stepTorpedo(live, steerTarget(live, tick, tickHz), dt);

    // ── 4. Arrival at the aim point ─────────────────────────────────────────────
    if (moved.phase === 'running' && hasArrived(moved, moved.aim, step)) {
      moved = { ...moved, phase: 'enabled' };
    }

    // ── 5. Rock ─────────────────────────────────────────────────────────────────
    if (terrain !== null && terrain.hitsOutline(torpedoOutline(moved.pos, moved.facing))) {
      next.push(detonate(moved, moved.pos));
      continue;
    }

    // ── 6. The fuze ─────────────────────────────────────────────────────────────
    const armed = (tick - moved.firedTick) / tickHz >= FUZE_ARM_SECONDS;
    if (armed && touchingHull(moved.pos, tubes)) {
      next.push(detonate(moved, moved.pos));
      continue;
    }

    // ── 7. The seeker ───────────────────────────────────────────────────────────
    next.push(look(moved, tubes, terrain, tick, tickHz, tuning));
  }

  if (harm.size === 0) {
    return { boats: tubes, torpedoes: next, detonations, damaged: false };
  }

  return {
    boats: tubes.map((boat) => hurt(boat, harm.get(boat.id) ?? 0, tick, tickHz)),
    torpedoes: next,
    detonations,
    damaged: true,
  };
}

// ── internals ───────────────────────────────────────────────────────────────────────

/**
 * Where a weapon is steering this tick, or `null` to hold its course.
 *
 * The three cases are the three the design has. **Running**: at the aim point, always — this is
 * the run-out and nothing diverts it. **Enabled with a live track**: at the last place the seeker
 * heard something, which is a position rather than a boat, so the weapon chases where the target
 * *was* and a target that has moved since is a target it will miss (`match/torpedo.ts#track`).
 * **Enabled with nothing**: straight ahead, which is both what an unguided weapon does forever
 * and what a homing one does between contacts.
 */
function steerTarget(torpedo: TorpedoState, tick: number, tickHz: number): Vec2 | null {
  if (torpedo.phase === 'running') return torpedo.aim;
  if (torpedo.track === null) return null;
  const age = (tick - torpedo.trackTick) / tickHz;
  return age <= SEEKER_HOLD_SECONDS ? torpedo.track : null;
}

/** Whether a live warhead is close enough to a hull to fire. */
function touchingHull(at: Vec2, boats: readonly BoatState[]): boolean {
  for (const boat of boats) {
    if (boat.status === 'destroyed') continue;
    const hull = getHull(boat.hull);
    if (Math.hypot(boat.pos.x - at.x, boat.pos.y - at.y) > hull.length) continue;
    if (distanceToPolygon(at, hullOutline(hull, boat.pos, boat.facing)) <= TORPEDO_PROXIMITY_FUZE) {
      return true;
    }
  }
  return false;
}

/**
 * One seeker pulse, if one is due, and whatever it heard.
 *
 * The pulse fires on its own rhythm measured from the last one, exactly like a boat's active
 * sonar (`sim/acoustics/boats.ts#pingDue`) and for the same reason: the interval is a property of
 * the transducer, not of when the weapon happened to arm.
 *
 * A pulse that hears nothing still counts. `lastPingTick` moves, the ocean gets the noise, and
 * the enemy gets a second free bearing on the weapon coming at them — which is the trade the
 * seeker makes and the reason an enable point set too early is a bad shot as well as a wasteful
 * one.
 */
function look(
  torpedo: TorpedoState,
  boats: readonly BoatState[],
  terrain: TerrainCollider | null,
  tick: number,
  tickHz: number,
  tuning: AcousticTuning | undefined,
): TorpedoState {
  if (torpedo.phase !== 'enabled') return torpedo;
  if (getWeapon(torpedo.weapon).seekerPingLevel <= 0) return torpedo;

  const interval = Math.max(1, Math.round((tickHz * SEEKER_INTERVAL_MS) / 1000));
  if (torpedo.lastPingTick > 0 && tick - torpedo.lastPingTick < interval) return torpedo;

  const heard = seekerLook(torpedo, boats, terrain, tuning);
  const pinged = { ...torpedo, lastPingTick: tick };
  if (heard === null) return pinged;

  // The heading is not snapped to the contact — steering does that next tick, at the weapon's
  // own turn rate. A seeker that could point the warhead instantly would make the turn rate,
  // and with it the whole difference between the two loads, mean nothing.
  return { ...pinged, track: heard.at, trackTick: tick };
}

/** Every boat's tubes, one tick on. Returns the same array when no tube is mid-cycle. */
function stepTubes(boats: readonly BoatState[], dt: number): readonly BoatState[] {
  let cycling = false;
  for (const boat of boats) {
    if (boat.tubes.some((tube) => tube.status === 'reloading' || tube.status === 'unloading')) {
      cycling = true;
      break;
    }
  }
  if (!cycling) return boats;

  return boats.map((boat) => {
    if (!boat.tubes.some((tube) => tube.status === 'reloading' || tube.status === 'unloading')) {
      return boat;
    }
    return { ...boat, tubes: boat.tubes.map((tube) => stepTube(tube, boat.stats, dt)) };
  });
}

/**
 * Take hit points off a boat, sound the hit, and destroy it if that was the last of them.
 *
 * The `hull-damage` transient is the same one collision would sound, and it is deliberately not
 * the detonation: the bang belongs to the weapon and the groan belongs to the hull, so a
 * listener a long way off hears one event and a listener close enough hears two. planning/04 §8's
 * rule holds — zero hit points is destroyed, and there is no repair.
 */
function hurt(boat: BoatState, amount: number, tick: number, tickHz: number): BoatState {
  if (amount <= 0 || boat.status === 'destroyed') return boat;
  const hp = Math.max(0, boat.hp - amount);
  return withTransient(
    { ...boat, hp, status: hp <= 0 ? 'destroyed' : boat.status },
    'hull-damage',
    tick,
    tickHz,
  );
}
