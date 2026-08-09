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
 *   `seekerPingLevel`. A homing weapon that has armed is announcing itself once a second.
 * - **The detonation.** An ordinary transient on the weapon (`content/acoustics.ts`), which is
 *   why a spent weapon stays in the world until it has rung down.
 *
 * ## It hears nothing
 *
 * `hydrophone` is always `null`, and that is not an oversight — it is the decision `seeker.ts`
 * explains at length. A torpedo with a hydrophone here would be a listener in the solve, and the
 * solve pools vision per team (C17), so the firing side would see everything its weapon saw. The
 * seeker is its own short-sighted thing precisely so that this can stay `null`.
 */

import { activePingLevel, transientLevel, type AcousticTuning } from '../../content/acoustics.js';
import { SEEKER_INTERVAL_MS, TORPEDO_ABSORPTION, getWeapon } from '../../content/weapons.js';
import { toDecibels, toPower } from '../../math/decibels.js';
import { torpedoOutline, type TorpedoState } from '../../match/torpedo.js';
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

/** Sim ticks between seeker pulses, at a given tick rate. */
export function ticksPerSeekerPing(tickHz: number): number {
  return Math.max(1, Math.round((tickHz * SEEKER_INTERVAL_MS) / 1000));
}

/**
 * Everything one weapon is radiating on top of its motor, in dB — its seeker's pulse and
 * whatever it has banged.
 *
 * The exact counterpart of `emittedLevels`, and a spent weapon is the counterpart of a wreck: it
 * radiates its own detonation and nothing else, because a warhead that has gone off has no motor
 * left to turn.
 */
export function torpedoEmittedLevels(
  torpedo: TorpedoState,
  tick: number,
  tickHz: number,
  tuning?: AcousticTuning,
): readonly number[] {
  const levels: number[] = [];
  for (const transient of torpedo.transients) {
    const level = transientLevel(transient.kind, (tick - transient.tick) / tickHz);
    if (level > -Infinity) levels.push(level);
  }

  const pulse = seekerPulseLevel(torpedo, tick, tickHz, tuning);
  if (pulse > -Infinity) levels.push(pulse);

  return levels;
}

/**
 * One weapon, ready for the solve.
 *
 * The motor's level scales with how fast it is actually going, so a weapon still winding up out
 * of the tube is quieter than one at cruise. Linear rather than the quadratic curve boats use for
 * flow noise: a torpedo has one speed and spends two seconds reaching it, so the shape of the
 * curve in between is a detail nobody can hear, and linear does not need explaining.
 */
export function torpedoEntity(
  torpedo: TorpedoState,
  transients: readonly number[] = [],
): AcousticEntity {
  const def = getWeapon(torpedo.weapon);
  const running = torpedo.phase !== 'spent';
  const fraction = def.speed > 0 ? Math.min(1, Math.max(0, torpedo.speed / def.speed)) : 0;

  // The motor, with whatever is ringing power-summed on top. Not `sourceLevelOf`, because
  // sharing it would mean handing it a fake `Stats` block — a torpedo has no cavitation speed,
  // no test depth, and no damage state, and inventing three numbers to satisfy a signature is
  // how a weapon ends up quietly obeying a rule about hulls.
  const motor = running ? def.sourceLevel * fraction : -Infinity;
  let power = toPower(motor);
  for (const transient of transients) power += toPower(transient);

  return {
    id: torpedo.id,
    team: torpedo.team,
    pos: torpedo.pos,
    sourceLevel: toDecibels(power),
    absorption: TORPEDO_ABSORPTION,
    outline: torpedoOutline(torpedo.pos, torpedo.facing),
    // Deaf, always. See the file header.
    hydrophone: null,
  };
}
