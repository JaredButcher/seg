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
 * 4. alignment            launch → running                       it is pointing where it is going
 * 5. arrival              running → enabled                      geometry, not the seeker
 * 6. terrain              a wall is a detonation                 before hulls: rock is cover
 * 7. hulls                proximity fuze → detonation
 * 8. the active sensor    a pulse, and maybe a track             only if it survived the tick
 * ```
 *
 * Four and five in that order and in the same tick, so a weapon fired at something close in
 * front of it does not spend a tick creeping between the two — the launch manoeuvre is a tax on
 * a shot over the shoulder, not on every shot.
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
 * ## A load with no warhead ends quietly
 *
 * A drone or a decoy that runs out of clock, or swims into a wall, is `spent` like anything else
 * — but there is no bang, no `torpedo-detonation`, and no `Detonation` reported, because none of
 * those happened. It scuttles, and with nothing ringing on it, it leaves the world on the same
 * tick. The one place that reads as a rule rather than as an absence is a decoy at the end of its
 * two minutes: the false contact does not go out with a bang that would have told the listener
 * they were had. It simply stops being there, exactly as a boat that slipped detection does.
 *
 * ## What is refused rather than half-built
 *
 * No wire guidance (Q5) — a weapon is committed the moment it leaves the tube. No mines, because
 * a fuze that waits ten minutes without arming on its own layer does not exist
 * (`content/weapons.ts`). No wreck sinking: a boat destroyed here stops where it died, exactly
 * as it does after a collision, and the wreck entity planning/04 §8 wants lands with the wreck.
 */

import { type AcousticTuning } from '../../content/acoustics.js';
import { getHull } from '../../content/hulls.js';
import { SEEKER_HOLD_SECONDS, TORPEDO_PROXIMITY_FUZE, getWeapon } from '../../content/weapons.js';
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
import { alignedWith, hasArrived, stepTorpedo } from './kinematics.js';
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

/**
 * Seconds before the fuze will look at **the boat that fired the weapon**. Much longer, and the
 * reason is the launch phase.
 *
 * A weapon spends its first seconds slow, and a weapon reversing spends some of them *stopped* —
 * directly ahead of a bow that may be closing at flank speed (`kinematics.ts`). A clock short
 * enough to arm a weapon against an enemy it was fired at point-blank is nowhere near long
 * enough to get it clear of its own launcher, so the two interlocks are two numbers. Ten seconds
 * is a standard torpedo's length of water twice over, and a reversing weapon and the boat that
 * fired it separate at the sum of their speeds.
 *
 * It buys safety from the *contact* fuze only. The burst does not care whose hull it is looking
 * at (see the header), so a weapon that goes off nearby — on rock, on a hull, or on its own
 * clock — still catches its firer, and planning/04 §7's bargain survives: a torpedo that expires
 * beside your own boat is still your own fault.
 */
export const FUZE_SELF_SAFE_SECONDS = 10;

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

  // Read off the tick's *incoming* weapons rather than off `next`, so every seeker in the water
  // is fooled by exactly the same set of decoys however the iteration happens to be ordered.
  // Almost always empty, and a `filter` over a list that is almost always empty costs nothing.
  const decoys = torpedoes.filter((weapon) => weapon.mimic !== null && weapon.phase !== 'spent');

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

  /**
   * The end of one weapon's run, whichever kind of end it has.
   *
   * The whole of the difference between a warhead and a utility load, in one predicate, so that
   * the four places a weapon can end — its clock, its fuel, a wall, a hull — cannot disagree
   * about which of the two it is. A load with nothing to detonate scuttles: no burst, no bang,
   * and nothing reported to anyone who was not watching it (see the file header).
   */
  const finish = (torpedo: TorpedoState, at: Vec2): TorpedoState =>
    getWeapon(torpedo.weapon).damage > 0
      ? detonate(torpedo, at)
      : { ...torpedo, pos: at, phase: 'spent', speed: 0, track: null };

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
      next.push(finish(live, live.pos));
      continue;
    }

    // ── 3. Steer and integrate ──────────────────────────────────────────────────
    const step = live.speed * dt;
    let moved = stepTorpedo(live, steerTarget(live, tick, tickHz), dt);

    // ── 4. Round onto the bearing ───────────────────────────────────────────────
    // A weapon that has arrived while still getting round has nothing left to get round for:
    // the point it was manoeuvring onto is under it. Both readings end the launch phase, and
    // the arrival test below then runs against the same tick rather than the next one.
    if (
      moved.phase === 'launch' &&
      (alignedWith(moved, moved.aim) || hasArrived(moved, moved.aim, step))
    ) {
      moved = { ...moved, phase: 'running' };
    }

    // ── 5. Arrival at the aim point ─────────────────────────────────────────────
    if (moved.phase === 'running' && hasArrived(moved, moved.aim, step)) {
      moved = { ...moved, phase: 'enabled' };
    }

    // ── 6. Rock ─────────────────────────────────────────────────────────────────
    if (terrain !== null && terrain.hitsOutline(torpedoOutline(moved.pos, moved.facing))) {
      next.push(finish(moved, moved.pos));
      continue;
    }

    // ── 7. The fuze ─────────────────────────────────────────────────────────────
    const age = (tick - moved.firedTick) / tickHz;
    const ignoring = age < FUZE_SELF_SAFE_SECONDS ? moved.firedBy : null;
    if (age >= FUZE_ARM_SECONDS && touchingHull(moved.pos, tubes, ignoring)) {
      next.push(finish(moved, moved.pos));
      continue;
    }

    // ── 8. The active sensor ────────────────────────────────────────────────────
    next.push(look(moved, tubes, decoys, terrain, tick, tickHz, tuning));
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
 * The cases are the ones the design has. **Launching or running**: at the aim point, always —
 * this is the run-out and nothing diverts it, the only difference between the two being how fast
 * it is going while it does (`match/torpedo.ts#cruiseSpeed`). **Enabled with a live track**: at
 * the last place the seeker heard something, which is a position rather than a boat, so the
 * weapon chases where the target *was* and a target that has moved since is a target it will
 * miss (`match/torpedo.ts#track`). **Enabled with nothing**: straight ahead, which is what an
 * unguided weapon does forever, what a homing one does between contacts, and — since a load on
 * station is doing nought knots — what a drone does at its post.
 */
function steerTarget(torpedo: TorpedoState, tick: number, tickHz: number): Vec2 | null {
  if (torpedo.phase === 'launch' || torpedo.phase === 'running') return torpedo.aim;
  if (torpedo.track === null) return null;
  const age = (tick - torpedo.trackTick) / tickHz;
  return age <= SEEKER_HOLD_SECONDS ? torpedo.track : null;
}

/**
 * Whether a live warhead is close enough to a hull to fire, ignoring `exempt` — the boat that
 * launched it, while its own interlock is still in (`FUZE_SELF_SAFE_SECONDS`).
 */
function touchingHull(at: Vec2, boats: readonly BoatState[], exempt: EntityId | null): boolean {
  for (const boat of boats) {
    if (boat.status === 'destroyed' || boat.id === exempt) continue;
    const hull = getHull(boat.hull);
    if (Math.hypot(boat.pos.x - at.x, boat.pos.y - at.y) > hull.length) continue;
    if (distanceToPolygon(at, hullOutline(hull, boat.pos, boat.facing)) <= TORPEDO_PROXIMITY_FUZE) {
      return true;
    }
  }
  return false;
}

/**
 * One pulse from whatever active transducer this weapon carries, if one is due, and whatever it
 * heard.
 *
 * The pulse fires on its own rhythm measured from the last one, exactly like a boat's active
 * sonar (`sim/acoustics/boats.ts#pingDue`) and for the same reason: the interval is a property of
 * the transducer, not of when the weapon happened to arm.
 *
 * A pulse that hears nothing still counts. `lastPingTick` moves, the ocean gets the noise, and
 * the enemy gets a second free bearing on the weapon coming at them — which is the trade the
 * seeker makes and the reason an enable point set too early is a bad shot as well as a wasteful
 * one.
 *
 * **Only a `seeker` load does anything with what came back.** A drone's pulse is far louder and
 * reaches much further, and it still leaves `track` alone: what a drone's ping is *for* is the
 * ocean it lights up for its team's listeners in the solve, which happens because the pulse is a
 * transient in the water and not because anything here looked at it (ADR 0003). A drone that
 * chased what it heard would be a weapon, and it has no warhead to chase with.
 */
function look(
  torpedo: TorpedoState,
  boats: readonly BoatState[],
  decoys: readonly TorpedoState[],
  terrain: TerrainCollider | null,
  tick: number,
  tickHz: number,
  tuning: AcousticTuning | undefined,
): TorpedoState {
  if (torpedo.phase !== 'enabled') return torpedo;
  const def = getWeapon(torpedo.weapon);
  if (def.seekerPingLevel <= 0 || def.pingIntervalMs <= 0) return torpedo;

  const interval = Math.max(1, Math.round((tickHz * def.pingIntervalMs) / 1000));
  if (torpedo.lastPingTick > 0 && tick - torpedo.lastPingTick < interval) return torpedo;

  const pinged = { ...torpedo, lastPingTick: tick };
  if (def.behaviour !== 'seeker') return pinged;

  const heard = seekerLook(torpedo, boats, decoys, terrain, tuning);
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
