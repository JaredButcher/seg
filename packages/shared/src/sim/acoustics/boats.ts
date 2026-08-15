/**
 * Boats, as the acoustic model sees them.
 *
 * The solver deliberately knows nothing about hulls, throttles, or hit points — it takes a
 * source level, an absorption, an outline, and a hydrophone. This file is the one place that
 * translation happens, so there is exactly one answer to "how loud is that boat" and the HUD,
 * the balance harness, and the server all read it.
 */

import {
  ACOUSTICS,
  activePingLevel,
  hullMaterial,
  selfNoiseOf,
  sourceLevelOf,
  ticksPerPing,
  transientLevel,
  transientNoiseFraction,
  wreckSourceLevel,
  type AcousticTuning,
} from '../../content/acoustics.js';
import { getHull, type Hull } from '../../content/hulls.js';
import { depthAt } from '../../map/sizes.js';
import type { MapExtents, Vec2 } from '../../map/types.js';
import { toDecibels, toPower } from '../../math/decibels.js';
import {
  isDamaged,
  wreckHasLeftMap,
  type BoatState,
  type BoatTransient,
} from '../../match/world.js';
import { placeOutline } from '../collision/geometry.js';
import type { AcousticEntity } from './solve.js';

/**
 * A hull's silhouette, placed and pointed — the polygon a reflection is drawn from.
 *
 * `placeOutline` is the placement, and it is shared with the renderer on purpose
 * (`sim/collision/geometry.ts`): the authored `+y` down flip and the mirror that keeps a
 * left-travelling boat's sail on top are both easy to get backwards, and a hull that reflected
 * sound off one shape while being drawn as another would be two different submarines. This is
 * the acoustic model's name for it, because "the polygon sound comes off" is what the callers
 * here mean.
 */
export function hullOutline(hull: Hull, pos: Vec2, facing: number): Vec2[] {
  return placeOutline(hull.silhouette, pos, facing);
}

/**
 * The level of a boat's active pulse at `tick`, or `-Infinity` if it is not ringing.
 *
 * Separate from `boatEntity` rather than folded into it because the sim owns transient timing
 * and this is a transient (`activePingLevel`). Passing it in keeps `boatEntity` a pure
 * translation of a boat into an acoustic entity, with no notion of what tick it is.
 *
 * A destroyed boat is silent, including this: a wreck reflects, and does not shout.
 */
export function pingLevelOf(
  boat: BoatState,
  tick: number,
  tickHz: number,
  tuning?: AcousticTuning,
): number {
  if (!boat.activeSonar || boat.status === 'destroyed') return -Infinity;
  // Zero is *never pinged*, not "pinged at tick zero". Without this line a boat whose sonar is
  // on at the start of a match radiates a pulse it never fired, for as long as one would have
  // rung — which nothing in a real match can produce, and every fixture can.
  if (boat.lastPingTick <= 0) return -Infinity;
  return activePingLevel(boat.stats.pingLevel, (tick - boat.lastPingTick) / tickHz, tuning);
}

/**
 * Whether a boat is due to pulse on this tick.
 *
 * The interval is measured from the **last pulse**, not from when the switch was thrown, which
 * is what stops a player toggling active sonar off and on to ping faster than `pingIntervalMs`.
 * A boat that has never pinged is due at once, so throwing the switch is answered on the next
 * tick rather than up to a second later — the wait is for the *second* pulse, which is where a
 * player would expect to find it.
 */
export function pingDue(
  boat: BoatState,
  tick: number,
  tickHz: number,
  tuning?: AcousticTuning,
): boolean {
  if (!boat.activeSonar || boat.status === 'destroyed') return false;
  if (boat.lastPingTick <= 0) return true;
  return tick - boat.lastPingTick >= ticksPerPing(tickHz, tuning);
}

/**
 * One thing an entity is radiating on top of its own machinery, and how much of it deafens.
 *
 * Every sound joins the source level at full strength — a bang and a pulse both announce you, and
 * both light the rock around you. What differs is how much of that power a listener has to *hear
 * through*, and it is a property of the sound rather than of a channel it was sorted into:
 * `noiseFraction` is 1 for broadband racket, because there is nothing to notch out of a bang, and
 * `filterableNoiseFraction` for a coherent pulse, because a hydrophone can lock one out of its
 * noise estimate.
 *
 * The fraction rides on the sound rather than being decided downstream so that the solver is never
 * told what kind of noise anything is. It reads one number per entity — `AcousticEntity`'s
 * `deafeningLevel`, folded here by `deafeningLevelOf` — and a table of fifty different fractions
 * would cost it exactly what one does.
 */
export interface EmittedSound {
  /** Level, dB at the reference range, as it stands right now. */
  readonly level: number;
  /** How much of it reaches a listener's noise floor, as a fraction of its power. */
  readonly noiseFraction: number;
}

/** Everything an entity is radiating on top of its own machinery. */
export type EmittedLevels = readonly EmittedSound[];

/**
 * Whatever of a list of transients is still ringing at `tick`, each with its kind's own
 * `noiseFraction` (`content/acoustics.ts#transientNoiseFraction`).
 *
 * Shared by boats and torpedoes because a bang is a bang: the two entities are loud for entirely
 * different reasons (`torpedoes.ts`) but neither of those reasons is a transient.
 */
export function ringingSounds(
  transients: readonly BoatTransient[],
  tick: number,
  tickHz: number,
): EmittedSound[] {
  const sounds: EmittedSound[] = [];
  for (const transient of transients) {
    const level = transientLevel(transient.kind, (tick - transient.tick) / tickHz);
    if (level > -Infinity) {
      sounds.push({ level, noiseFraction: transientNoiseFraction(transient.kind) });
    }
  }
  return sounds;
}

/**
 * One active pulse as an emitted sound — a boat's (`pingLevelOf`) or a seeker's
 * (`torpedoes.ts#seekerPulseLevel`).
 *
 * The one place `filterableNoiseFraction` is read on the emit side, so no caller assembling a
 * pulse by hand — the ping-reach overlay does, for a pulse that is not due yet — can weight it
 * differently from the one the solver will really see.
 */
export function pulseSound(level: number, tuning: AcousticTuning = ACOUSTICS): EmittedSound {
  return { level, noiseFraction: tuning.filterableNoiseFraction };
}

/** Just the levels, for the helpers that power-sum them onto a source level. */
export function radiatedLevels(sounds: EmittedLevels): number[] {
  return sounds.map((sound) => sound.level);
}

/**
 * `sourceLevel` with each ringing sound scaled to the fraction of its power that deafens — the
 * number the solve uses for noise floors, against the full one it uses for everything else.
 *
 * Written as what is *skimmed off* the total rather than as a second sum from scratch, so a boat's
 * loudness is computed in exactly one place and the two figures cannot drift apart. When nothing
 * is filterable — every transient in the table today, so every tick nobody is pinging — the loop
 * finds nothing to skim and returns `sourceLevel` itself, bit for bit.
 */
export function deafeningLevelOf(sourceLevel: number, sounds: EmittedLevels): number {
  if (sourceLevel === -Infinity) return -Infinity;

  let skimmed = 0;
  for (const sound of sounds) {
    if (sound.noiseFraction >= 1 || sound.level === -Infinity) continue;
    skimmed += toPower(sound.level) * (1 - sound.noiseFraction);
  }
  if (skimmed <= 0) return sourceLevel;

  return toDecibels(Math.max(0, toPower(sourceLevel) - skimmed));
}

/**
 * Everything one boat is radiating on top of its own machinery.
 *
 * A destroyed boat radiates no ping, ever (`pingLevelOf`) — there is nobody left to throw the
 * switch. It does keep ringing whatever transients were on it, the same as a live boat: the
 * `hull-destroyed` bang that killed it rings down exactly like any other transient, which is
 * what lets `boatEntity` add the continuous groan of a wreck (`wreckSourceLevel`) underneath it
 * rather than have the two be two different systems. That stops once it has sunk out of the map
 * (`wreckHasLeftMap`) — the caller stops asking, because there is nothing left to ask about.
 */
export function emittedLevels(
  boat: BoatState,
  tick: number,
  tickHz: number,
  tuning?: AcousticTuning,
): EmittedLevels {
  if (wreckHasLeftMap(boat)) return [];

  const sounds = ringingSounds(boat.transients, tick, tickHz);
  const ping = pingLevelOf(boat, tick, tickHz, tuning);
  if (ping > -Infinity) sounds.push(pulseSound(ping, tuning));

  return sounds;
}

/**
 * One boat, ready for the solve.
 *
 * A destroyed boat is not dropped, and it is not silent (planning/04 §8, revised): it stops
 * running its own machinery — no flow noise, no cavitation, nobody to hear a ping through — but
 * it keeps its outline, its absorption, and now a continuous voice of its own
 * (`wreckSourceLevel`), so a wreck on the seabed is a persistent reflector, a permanent false
 * contact, *and* a legitimate one: something a passive listener can find and a torpedo's seeker
 * can lock onto (`sim/weapons/seeker.ts`), for as long as it is still on the map.
 *
 * `levels` are what the boat is radiating on top of its own machinery (`emittedLevels`). Every one
 * of them is power-summed into `sourceLevel`, so the boat is as loud as it ever was; the fractions
 * they carry are folded into `deafeningLevel`, which is the part a listener actually has to hear
 * through — and so is the boat's own flow noise, weighted by `tuning.flowNoiseFraction`
 * (`sourceLevelOf`'s `flowWeight`) for the same reason a ping is: a screw is a tone, not a bang.
 */
export function boatEntity(
  boat: BoatState,
  extents: MapExtents,
  levels: EmittedLevels = [],
  tuning: AcousticTuning = ACOUSTICS,
): AcousticEntity {
  const hull = getHull(boat.hull);
  const alive = boat.status !== 'destroyed';
  const depth = depthAt(extents, boat.pos.y);
  const ringing = radiatedLevels(levels);
  const emitState = {
    stats: boat.stats,
    speed: boat.speed,
    depth,
    damaged: isDamaged(boat),
    transients: ringing,
  };

  // The full level — a pinging boat is as loud as it ever was, whatever a listener filters.
  const sourceLevel = alive ? sourceLevelOf(emitState, tuning) : wreckSourceLevel(ringing, tuning);

  // The same level with flow noise weighted down before deafeningLevelOf skims the transients and
  // the ping off it — a wreck has no screw turning, so it has nothing of its own to weight here.
  const deafeningBase = alive
    ? sourceLevelOf(emitState, tuning, tuning.flowNoiseFraction)
    : sourceLevel;

  return {
    id: boat.id,
    team: boat.team,
    pos: boat.pos,
    sourceLevel,
    deafeningLevel: deafeningLevelOf(deafeningBase, levels),
    absorption: hullMaterial(boat.stats, tuning).absorption,
    outline: hullOutline(hull, boat.pos, boat.facing),
    hydrophone: alive
      ? {
          gain: boat.stats.arrayGain,
          selfNoise: selfNoiseOf(boat.stats, boat.speed, tuning),
        }
      : null,
  };
}
