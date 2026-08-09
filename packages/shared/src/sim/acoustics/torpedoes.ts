/**
 * Torpedoes, as the acoustic model sees them — the counterpart of `boats.ts`.
 *
 * Same job and, deliberately, the same shape: a source level, an absorption, an outline, and a
 * hydrophone. planning/04 §4's uniform entity model says a torpedo and a submarine reach the
 * solver identically, and this is the second half of making that true. Nothing downstream knows
 * a weapon from a hull, so a torpedo lights cave walls, raises noise floors, and appears in the
 * enemy's vision picture without a single line of the solver mentioning it.
 *
 * ## Three noises, and the design asks for all three
 *
 * **Launch** is not here — it rings on the *boat* that fired, which is where a listener needs it
 * (`sim/weapons/launch.ts`). What is here is the other three:
 *
 * - **Running.** A continuous source level while the motor turns: 62 dB for a standard torpedo
 *   and 92 for a super-cavitating one, which is the loudest continuous thing in the game. That
 *   thirty-decibel gap is the price of the speed, and it is why a super-cavitating shot is heard
 *   from about twice as far and gives a target a chance to be somewhere else.
 * - **The seeker's pulse.** A transient on the same rhythm rule a boat's active sonar obeys, at
 *   `seekerPingLevel`. A homing weapon that has armed is announcing itself once a second — and an
 *   awake drone is announcing itself harder than a Heavy every two. Like a boat's own ping it
 *   rides the `filterable` channel, so it lights the water and is heard loud without deafening
 *   anyone to everything else.
 * - **The detonation.** An ordinary transient on the weapon (`content/acoustics.ts`), which is
 *   why a spent weapon stays in the world until it has rung down.
 *
 * ## One load hears, and exactly one
 *
 * `hydrophone` is `null` for every weapon with a `WeaponHydrophone` of `null`, which is all of
 * them except the drone — and that is the decision `seeker.ts` explains at length rather than an
 * oversight. A torpedo that listened here would be a listener in the solve, and the solve pools
 * vision per team (C17), so the firing side would see everything its weapon saw. A standard
 * torpedo's seeker is its own short-sighted thing precisely so that this can stay `null`.
 *
 * The drone is the exception the argument always pointed at: `seeker.ts` says in as many words
 * that a listening weapon "quietly deletes the reason to carry the sonar drone the content table
 * already has". So the drone is that reason, made explicit and paid for — twenty points, a tube,
 * five minutes, and a pulse that tells everyone within four kilometres where it is.
 *
 * Its ears are taken straight off the weapon table, **flat**, with no speed term. That is not a
 * simplification skipped: a drone is never not under way (`content/weapons.ts` — it does not
 * stop, and it cannot be steered), so a self-noise curve in its speed would be a curve evaluated
 * at one point forever. What the table's single number says is the thing worth saying — good
 * filters, and therefore a listener that hears while moving about as well as a submarine hears
 * stopped.
 *
 * ## And one load lies
 *
 * An active decoy reaches the solver as the **boat that fired it**: that hull's silhouette, that
 * hull's absorption, and `sourceLevelOf` over that boat's stat block at the decoy's own speed and
 * depth (`match/torpedo.ts#DecoyMimic`). Not "a torpedo with a boat-shaped flag on it" — there is
 * no flag, and nothing downstream is told. A listener confirms a submarine because at the level
 * of squares and decibels there is a submarine there, which is why the deception survives contact
 * with a solver that has never heard of decoys.
 *
 * Its *physical* outline stays seven metres long. Rock still collides with the torpedo it really
 * is (`sim/weapons/phase.ts`), and the two outlines never meet.
 */

import {
  activePingLevel,
  hullMaterial,
  sourceLevelOf,
  transientLevel,
  type AcousticTuning,
} from '../../content/acoustics.js';
import { getHull } from '../../content/hulls.js';
import { TORPEDO_ABSORPTION, getWeapon } from '../../content/weapons.js';
import { depthAt } from '../../map/sizes.js';
import type { MapExtents } from '../../map/types.js';
import { sumDecibels, toDecibels, toPower } from '../../math/decibels.js';
import { topSpeed, torpedoOutline, type TorpedoState } from '../../match/torpedo.js';
import { hullOutline, type EmittedLevels } from './boats.js';
import type { AcousticEntity } from './solve.js';

/**
 * The level of a weapon's seeker pulse at `tick`, or `-Infinity` if it is not ringing.
 *
 * `activePingLevel` is shared with boats rather than reimplemented, so a seeker pulse rings down
 * over the same `pingSeconds` a submarine's does and a tuning pass moves both. What differs is
 * only the level and the interval, which is the honest difference between the two transducers.
 */
export function seekerPulseLevel(
  torpedo: TorpedoState,
  tick: number,
  tickHz: number,
  tuning?: AcousticTuning,
): number {
  const level = getWeapon(torpedo.weapon).seekerPingLevel;
  if (level <= 0 || torpedo.phase !== 'enabled' || torpedo.lastPingTick <= 0) return -Infinity;
  return activePingLevel(level, (tick - torpedo.lastPingTick) / tickHz, tuning);
}

/** Sim ticks between this weapon's pulses, at a given tick rate. `0` for one that never pings. */
export function ticksPerSeekerPing(torpedo: TorpedoState, tickHz: number): number {
  const interval = getWeapon(torpedo.weapon).pingIntervalMs;
  return interval <= 0 ? 0 : Math.max(1, Math.round((tickHz * interval) / 1000));
}

/**
 * Everything one weapon is radiating on top of its motor, split like a boat's (`EmittedLevels`).
 *
 * The exact counterpart of `emittedLevels`, and a spent weapon is the counterpart of a wreck: it
 * radiates its own detonation and nothing else, because a warhead that has gone off has no motor
 * left to turn. The detonation is `deafening` — nothing to filter out of a bang — while the
 * seeker's pulse rides `filterable`, the same coherent-tone argument that makes a boat's own
 * ping easy to hear through.
 */
export function torpedoEmittedLevels(
  torpedo: TorpedoState,
  tick: number,
  tickHz: number,
  tuning?: AcousticTuning,
): EmittedLevels {
  const deafening: number[] = [];
  for (const transient of torpedo.transients) {
    const level = transientLevel(transient.kind, (tick - transient.tick) / tickHz);
    if (level > -Infinity) deafening.push(level);
  }

  const filterable: number[] = [];
  const pulse = seekerPulseLevel(torpedo, tick, tickHz, tuning);
  if (pulse > -Infinity) filterable.push(pulse);

  return { deafening, filterable };
}

/**
 * One weapon, ready for the solve — the exact counterpart of `boatEntity`, and deliberately the
 * same argument order.
 *
 * The motor's level scales with how fast it is actually going, so a weapon still winding up out
 * of the tube, or creeping through its launch phase, is quieter than one at cruise. Linear rather
 * than the quadratic curve boats use for flow noise: a torpedo has one speed and spends two
 * seconds reaching it, so the shape of the curve in between is a detail nobody can hear, and
 * linear does not need explaining.
 *
 * `extents` is only read for a decoy, whose noise depends on its depth the way a boat's does. It
 * is required rather than optional because a caller that forgot it would get a decoy that
 * quietly stopped cavitating, which is a bug that would take a week to see.
 */
export function torpedoEntity(
  torpedo: TorpedoState,
  extents: MapExtents,
  levels: EmittedLevels = { deafening: [], filterable: [] },
  tuning?: AcousticTuning,
): AcousticEntity {
  const def = getWeapon(torpedo.weapon);
  const running = torpedo.phase !== 'spent';
  const top = topSpeed(torpedo);
  const fraction = top > 0 ? Math.min(1, Math.max(0, torpedo.speed / top)) : 0;

  // A decoy is not a torpedo to anything downstream of here. See the file header.
  if (torpedo.mimic !== null && running) {
    const { hull, stats } = torpedo.mimic;
    return {
      id: torpedo.id,
      team: torpedo.team,
      pos: torpedo.pos,
      sourceLevel: sourceLevelOf(
        {
          stats,
          speed: torpedo.speed,
          depth: depthAt(extents, torpedo.pos.y),
          transients: levels.deafening,
        },
        tuning,
      ),
      absorption: hullMaterial(stats, tuning).absorption,
      outline: hullOutline(getHull(hull), torpedo.pos, torpedo.facing),
      filterableLevel: sumDecibels(levels.filterable),
      // It radiates a submarine; it does not hear like one. A decoy that listened would hand its
      // team a forward sensor they did not pay for, which is the drone's job and the drone's cost.
      hydrophone: null,
    };
  }

  // The motor, with whatever is ringing power-summed on top. Not `sourceLevelOf`, because
  // sharing it would mean handing it a fake `Stats` block — a torpedo has no cavitation speed,
  // no test depth, and no damage state, and inventing three numbers to satisfy a signature is
  // how a weapon ends up quietly obeying a rule about hulls.
  let deafening = toPower(running ? def.sourceLevel * fraction : -Infinity);
  for (const transient of levels.deafening) deafening += toPower(transient);
  const filterable = sumDecibels(levels.filterable);

  return {
    id: torpedo.id,
    team: torpedo.team,
    pos: torpedo.pos,
    sourceLevel: toDecibels(deafening + toPower(filterable)),
    filterableLevel: filterable,
    absorption: TORPEDO_ABSORPTION,
    outline: torpedoOutline(torpedo.pos, torpedo.facing),
    hydrophone: running ? getWeapon(torpedo.weapon).hydrophone : null,
  };
}
