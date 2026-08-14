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
 * 4. settling             launch → running                       on its bearing, and staying there
 * 5. arrival              running → enabled                      geometry, not the sensor
 * 6. terrain              a wall is a detonation                 before hulls: rock is cover
 * 7. hulls                proximity fuze → detonation
 * 8. the sensor           a pulse or a listen, and maybe a track  only if it survived the tick
 * ```
 *
 * Four and five in that order and in the same tick, so a weapon that reaches its aim point while
 * still settling is not held at creep speed for a tick beside the point it was sent to.
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
 * ## A noisemaker passes through this loop without touching most of it
 *
 * A countermeasure is a `TorpedoState` like everything else — the acoustic model, the scope and the
 * seekers all read one, and giving it a second entity type would have meant a second copy of each
 * — but it is born `enabled` and pointed straight down (`launch.ts#dropCountermeasure`), so steps
 * 4, 5 and 8 have nothing to do to it and step 3 holds its course because `steerTarget` gives an
 * enabled weapon with no track nothing to steer at. What is left is the two ends it does have: the
 * seabed (step 6, and sinking into it is how most of them finish) and its clock (step 2). It
 * scuttles silently by the same `finish` rule the drone and the decoy use.
 *
 * What it *does* to this loop is the reverse, and it is why the tick builds two source lists rather
 * than one: it is a candidate a passive seeker can be pulled onto, and a noise floor an active one
 * has to shout over. Both are `sim/weapons/seeker.ts`'s business; this file only resolves the
 * levels once and hands them round.
 *
 * ## What is refused rather than half-built
 *
 * No wire guidance (Q5) — a weapon is committed the moment it leaves the tube. No mines, because
 * a fuze that waits ten minutes without arming on its own layer does not exist
 * (`content/weapons.ts`).
 */

import { type AcousticTuning } from '../../content/acoustics.js';
import { getHull } from '../../content/hulls.js';
import {
  SEEKER_HOLD_SECONDS,
  TORPEDO_LAUNCH_SETTLE_SECONDS,
  TORPEDO_PROXIMITY_FUZE,
  getWeapon,
} from '../../content/weapons.js';
import type { MapExtents, Vec2 } from '../../map/types.js';
import {
  detonationDamage,
  torpedoExpired,
  torpedoOutline,
  type TorpedoState,
} from '../../match/torpedo.js';
import { stepLauncher, stepTube } from '../../match/tubes.js';
import {
  pruneTransients,
  withTransient,
  wreckHasLeftMap,
  type BoatState,
  type EntityId,
} from '../../match/world.js';
import { boatEntity, emittedLevels, hullOutline } from '../acoustics/boats.js';
import { torpedoEmittedLevels, torpedoEntity } from '../acoustics/torpedoes.js';
import { distanceToPolygon } from '../collision/geometry.js';
import type { TerrainCollider } from '../collision/terrain.js';
import { alignedWith, hasArrived, stepTorpedo } from './kinematics.js';
import { jammingAt, seekerListen, seekerLook, type SeekerSource } from './seeker.js';

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
 * A weapon spends its first seconds slow, and a weapon fired over the shoulder spends most of
 * them coming about at a crawl — a few tens of metres ahead of a bow that may be closing at flank
 * speed (`kinematics.ts`). A clock short enough to arm a weapon against an enemy it was fired at
 * point-blank is nowhere near long enough to get it clear of its own launcher, so the two
 * interlocks are two numbers. Ten seconds is a homing torpedo's length of water twice over,
 * which is the margin a weapon still turning in front of its own launcher needs.
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
  /**
   * The map's vertical extents, for the one thing in this phase that needs a depth: a passive
   * seeker asks how loud its candidates are, and how loud a submarine is depends on how deep it is
   * (`content/acoustics.ts#cavitationSpeedAt`).
   *
   * Required rather than optional, for the reason `torpedoEntity` gives about the same argument: a
   * caller that forgot it would get passive seekers quietly deaf to cavitation, which is the half
   * of the mechanic that makes going fast dangerous — a bug that would take a week to see.
   */
  readonly extents: MapExtents;
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
  const { boats, torpedoes, terrain, extents, tick, tickHz, tuning } = phase;
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

  /**
   * The noisemakers still shouting, on the same terms and for the same reason as `decoys` above:
   * every seeker in the water is jammed by exactly the same set however the loop is ordered.
   *
   * Both teams' — a countermeasure is a loud object in the ocean, not a flag on a side, and a
   * noisemaker that only blinded the enemy would be a countermeasure a player could drop into their
   * own salvo for free (Q7 again: friendly fire is on, and it is on here too).
   */
  const jammers = torpedoes.filter(
    (weapon) => getWeapon(weapon.weapon).behaviour === 'noisemaker' && weapon.phase !== 'spent',
  );

  /**
   * What those noisemakers are radiating, resolved once and shared by every seeker.
   *
   * Lazily, and separately from `audible` below, because the two are wanted by different weapons on
   * different ticks: an active seeker asks for this without ever asking for the fleet, and a
   * passive one asks for the fleet and gets these folded into it. Resolved through `torpedoEntity`
   * rather than read off the weapon table, so the level a torpedo is jammed by is the same level
   * the solve puts in the water and a spent or half-speed one is quieter by the same rule.
   */
  let jamming: readonly SeekerSource[] | null = null;
  const shouting = (): readonly SeekerSource[] => {
    if (jamming !== null) return jamming;
    jamming = jammers.map((noisemaker) => {
      const entity = torpedoEntity(
        noisemaker,
        extents,
        torpedoEmittedLevels(noisemaker, tick, tickHz, tuning),
        tuning,
      );
      return { at: entity.pos, sourceLevel: entity.sourceLevel };
    });
    return jamming;
  };

  /**
   * Everything a passive seeker could hear this tick, resolved once and shared by all of them.
   *
   * Built lazily, and that is the whole reason it is a closure rather than a `const`: resolving it
   * runs `sourceLevelOf` over the fleet, and on the overwhelming majority of ticks there is no
   * passive seeker enabled to ask. A tick with no passive weapon in the water pays nothing, and a
   * tick with four of them pays once.
   *
   * The candidate set is **exactly `seekerLook`'s** — every boat still on the map, wrecks
   * included, plus every live decoy — because the two seekers being fooled by the same things is
   * the promise the decoy is bought against. What differs is only what is read off each candidate:
   * the active one wants a hull's absorption, this one wants its voice.
   *
   * Plus the noisemakers, which is the one place the two candidate sets legitimately differ, and
   * the whole of how a countermeasure beats a passive weapon: a drum of racket is a *source* and
   * not a reflector, so it is something to be heard and hunted here and nothing at all to a pulse.
   * The active seeker's answer to it is `jammingAt` instead (`sim/weapons/seeker.ts`).
   */
  let sources: readonly SeekerSource[] | null = null;
  const audible = (): readonly SeekerSource[] => {
    if (sources !== null) return sources;
    const heard: SeekerSource[] = [...shouting()];

    for (const boat of tubes) {
      // A wreck is still a contact and still a legitimate target — the same rule, and the same
      // one-line justification, `seekerLook` applies. It radiates `wreckSourceLevel`, which is
      // quiet but not nothing, so a passive weapon will close on one from a short distance.
      if (wreckHasLeftMap(boat)) continue;
      const entity = boatEntity(boat, extents, emittedLevels(boat, tick, tickHz, tuning), tuning);
      heard.push({ at: entity.pos, sourceLevel: entity.sourceLevel });
    }

    for (const decoy of decoys) {
      const entity = torpedoEntity(
        decoy,
        extents,
        torpedoEmittedLevels(decoy, tick, tickHz, tuning),
        tuning,
      );
      heard.push({ at: entity.pos, sourceLevel: entity.sourceLevel });
    }

    sources = heard;
    return heard;
  };

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

    // ── 4. Round onto the bearing, and settle on it ─────────────────────────────
    if (moved.phase === 'launch') moved = settle(moved, step, tick, tickHz);

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

    // ── 8. The sensor ───────────────────────────────────────────────────────────
    next.push(look(moved, tubes, decoys, audible, shouting, terrain, tick, tickHz, tuning));
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
 * unguided weapon does forever, what a homing one does between contacts, and what a drone does
 * for the whole of its watch — it images the line it was sent down and cannot be talked off it.
 */
function steerTarget(torpedo: TorpedoState, tick: number, tickHz: number): Vec2 | null {
  if (torpedo.phase === 'launch' || torpedo.phase === 'running') return torpedo.aim;
  if (torpedo.track === null) return null;
  const age = (tick - torpedo.trackTick) / tickHz;
  return age <= SEEKER_HOLD_SECONDS ? torpedo.track : null;
}

/**
 * One tick of the launch phase's own bookkeeping: is it on its bearing, has it been on it long
 * enough, and is there anything left to get round for.
 *
 * Three answers in one place because they are one decision — *may this weapon open the throttle*
 * — and splitting them across the tick loop is how a weapon ends up promoted by one rule while
 * another still thinks it is manoeuvring.
 *
 * - **On the bearing** starts the hold (`match/torpedo.ts#alignedTick`), and coming *off* it
 *   clears the tick and starts the hold again. Time spent settled, not time since first touching
 *   the mark.
 * - **Held for `TORPEDO_LAUNCH_SETTLE_SECONDS`** ends the phase. That is the knob
 *   (`content/weapons.ts`); at zero the weapon leaves on the tick it aligns, which is what it did
 *   before the knob existed.
 * - **Arrived ends it too, and at once — once it is also on the bearing.** A weapon whose aim
 *   point is already under it and that is pointing at that point has nothing left to settle *for*,
 *   and holding it at creep speed beside the point it was sent to would be the launch phase
 *   refusing to end; the arrival test in the next step then runs against this same tick rather
 *   than the next one. But a weapon that is merely *near* its aim point while still turning has
 *   not finished manoeuvring, and letting it open the throttle mid-turn would commit it to a
 *   heading it has not reached — an inert load can never correct it, so "arrived" requires
 *   pointed here.
 * - **...unless it has had its chance to point.** An aim point *inside* the weapon's own turn
 *   circle can never be turned onto: the demand keeps swinging as the weapon circles it, so the
 *   bearing hold never lands and "pointed" never comes. A weapon that has reached such a point
 *   and has been launching for longer than the settling window is orbiting, not running out, and
 *   holding it at creep speed beside the point it will never point at is the launch phase
 *   refusing to end for the opposite reason. Arrival is then the exit, off-heading or not.
 */
function settle(torpedo: TorpedoState, step: number, tick: number, tickHz: number): TorpedoState {
  const since = alignedWith(torpedo, torpedo.aim)
    ? torpedo.alignedTick === 0
      ? tick
      : torpedo.alignedTick
    : 0;
  const marked = since === torpedo.alignedTick ? torpedo : { ...torpedo, alignedTick: since };

  const held = since > 0 && (tick - since) / tickHz >= TORPEDO_LAUNCH_SETTLE_SECONDS;
  const arrived = alignedWith(marked, marked.aim) && hasArrived(marked, marked.aim, step);
  const orbiting =
    hasArrived(marked, marked.aim, step) &&
    (tick - marked.firedTick) / tickHz >= TORPEDO_LAUNCH_SETTLE_SECONDS;
  if (!held && !arrived && !orbiting) return marked;
  return { ...marked, phase: 'running' };
}

/**
 * Whether a live warhead is close enough to a hull to fire, ignoring `exempt` — the boat that
 * launched it, while its own interlock is still in (`FUZE_SELF_SAFE_SECONDS`).
 *
 * A wreck still on the map counts (planning/04 §8, revised): it is a legitimate sonar contact
 * and a legitimate seeker target now (`seekerLook`), and a weapon that could home onto one but
 * never detonate on arrival would just fly through it forever, which reads as broken rather than
 * as a rule. Once it has sunk out of the map (`wreckHasLeftMap`) there is nothing left to hit.
 */
function touchingHull(at: Vec2, boats: readonly BoatState[], exempt: EntityId | null): boolean {
  for (const boat of boats) {
    if (boat.id === exempt || wreckHasLeftMap(boat)) continue;
    const hull = getHull(boat.hull);
    if (Math.hypot(boat.pos.x - at.x, boat.pos.y - at.y) > hull.length) continue;
    if (distanceToPolygon(at, hullOutline(hull, boat.pos, boat.facing)) <= TORPEDO_PROXIMITY_FUZE) {
      return true;
    }
  }
  return false;
}

/**
 * Whatever sensor this weapon carries, run for one tick, and whatever it heard.
 *
 * Two receivers behind one call, split on `seeker` (`content/weapons.ts#WeaponSeeker`) rather than
 * on the presence of a ping level, so that "it is silent" and "it is deaf" stay two separate
 * claims about a load — a passive torpedo is the first and not the second.
 *
 * ## The active branch: a pulse, on a rhythm
 *
 * The pulse fires on its own rhythm measured from the last one, exactly like a boat's active
 * sonar (`sim/acoustics/boats.ts#pingDue`) and for the same reason: the interval is a property of
 * the transducer, not of when the weapon happened to arm.
 *
 * A pulse that hears nothing still counts. `lastPingTick` moves, the ocean gets the noise, and
 * the enemy gets a second free bearing on the weapon coming at them — which is the trade the
 * active seeker makes and the reason an enable point set too early is a bad shot as well as a
 * wasteful one.
 *
 * **Only a `seeker` load does anything with what came back.** A drone's pulse is far louder and
 * reaches much further, and it still leaves `track` alone: what a drone's ping is *for* is the
 * ocean it lights up for its team's listeners in the solve, which happens because the pulse is a
 * transient in the water and not because anything here looked at it (ADR 0003). A drone that
 * chased what it heard would be a weapon, and it has no warhead to chase with.
 *
 * ## The passive branch: every tick, and nothing in the water
 *
 * No rhythm and no `lastPingTick`, because there is no pulse to time — the weapon is simply
 * listening, and it is listening on every tick it is enabled. That is the cheaper of the two
 * branches despite running twenty times as often: `audible` resolves the fleet once per tick for
 * all of them, and what is left per weapon is a distance and a subtraction per candidate.
 *
 * `lastPingTick` staying at zero is load-bearing rather than incidental. It is what
 * `sim/acoustics/pings.ts#seekerPulse` and `#seekerPulseLevel` read to decide whether a weapon is
 * ringing, so leaving it alone is what keeps a passive torpedo out of the ocean's transient
 * channel, out of the enemy's ping alerts, and off the debug overlay's list of pingers. A silent
 * weapon has to be silent in all four places, and this is the one line that makes it so.
 */
function look(
  torpedo: TorpedoState,
  boats: readonly BoatState[],
  decoys: readonly TorpedoState[],
  audible: () => readonly SeekerSource[],
  shouting: () => readonly SeekerSource[],
  terrain: TerrainCollider | null,
  tick: number,
  tickHz: number,
  tuning: AcousticTuning | undefined,
): TorpedoState {
  if (torpedo.phase !== 'enabled') return torpedo;
  const def = getWeapon(torpedo.weapon);

  if (def.seeker === 'passive') {
    // Nothing is emitted and nothing is stamped, so a passive seeker that hears nothing leaves the
    // weapon byte-for-byte as it was — which is what keeps a quiet tick free for it too.
    if (def.behaviour !== 'seeker') return torpedo;
    const heard = seekerListen(torpedo, audible(), terrain, tuning);
    if (heard === null) return torpedo;
    return { ...torpedo, track: heard.at, trackTick: tick };
  }

  if (def.seekerPingLevel <= 0 || def.pingIntervalMs <= 0) return torpedo;

  const interval = Math.max(1, Math.round((tickHz * def.pingIntervalMs) / 1000));
  if (torpedo.lastPingTick > 0 && tick - torpedo.lastPingTick < interval) return torpedo;

  const pinged = { ...torpedo, lastPingTick: tick };
  if (def.behaviour !== 'seeker') return pinged;

  // The pulse went out either way — that is the line above, and it is why a jammed weapon still
  // announces itself once a second to everyone listening. What the noisemakers take away is only
  // what comes *back*: they raise the floor the echo has to clear, and a weapon that cannot clear
  // it hears nothing and runs on (`sim/weapons/seeker.ts`).
  const heard = seekerLook(
    torpedo,
    boats,
    decoys,
    terrain,
    tuning,
    jammingAt(torpedo, shouting(), terrain, tuning),
  );
  if (heard === null) return pinged;

  // The heading is not snapped to the contact — steering does that next tick, at the weapon's
  // own turn rate. A seeker that could point the warhead instantly would make the turn rate,
  // and with it the whole difference between the loads, mean nothing.
  return { ...pinged, track: heard.at, trackTick: tick };
}

/**
 * Every boat's loading gear, one tick on — its tubes and its countermeasure launcher.
 *
 * Returns the same array when nothing at all is mid-cycle, and the same *boat* for every boat that
 * is not, which is the whole reason for the two-pass shape: a fleet with no tube reloading and no
 * countermeasure refilling allocates nothing, and that is most ticks of most matches.
 *
 * The launcher is stepped here rather than anywhere else because it is loading gear on the same
 * clock (`match/tubes.ts`), and a second place that advanced it would be a second place to forget.
 */
function stepTubes(boats: readonly BoatState[], dt: number): readonly BoatState[] {
  const cycling = (boat: BoatState): boolean =>
    boat.countermeasure.status === 'reloading' ||
    boat.tubes.some((tube) => tube.status === 'reloading' || tube.status === 'unloading');

  if (!boats.some(cycling)) return boats;

  return boats.map((boat) =>
    cycling(boat)
      ? {
          ...boat,
          tubes: boat.tubes.map((tube) => stepTube(tube, boat.stats, dt)),
          countermeasure: stepLauncher(boat.countermeasure, dt),
        }
      : boat,
  );
}

/**
 * Take hit points off a boat, sound the hit, and destroy it if that was the last of them.
 *
 * The `hull-damage` transient is the same one collision would sound, and it is deliberately not
 * the detonation: the bang belongs to the weapon and the groan belongs to the hull, so a
 * listener a long way off hears one event and a listener close enough hears two. planning/04 §8's
 * rule holds — zero hit points is destroyed, and there is no repair.
 *
 * A hit that finishes the boat off sounds `hull-destroyed` instead of `hull-damage` — a bigger,
 * longer event, and the louder noise planning/04 §8 (revised) asks a destruction make (`content/
 * acoustics.ts`). It replaces the ordinary bang rather than adding to it: the two describe the
 * same impact, and power-summing a hull failing outright onto the sound of the hit that failed
 * it would be counting the one event twice.
 */
function hurt(boat: BoatState, amount: number, tick: number, tickHz: number): BoatState {
  if (amount <= 0 || boat.status === 'destroyed') return boat;
  const hp = Math.max(0, boat.hp - amount);
  const destroyed = hp <= 0;
  return withTransient(
    { ...boat, hp, status: destroyed ? 'destroyed' : boat.status },
    destroyed ? 'hull-destroyed' : 'hull-damage',
    tick,
    tickHz,
  );
}
