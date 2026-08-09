/**
 * Boats, as the acoustic model sees them.
 *
 * The solver deliberately knows nothing about hulls, throttles, or hit points — it takes a
 * source level, an absorption, an outline, and a hydrophone. This file is the one place that
 * translation happens, so there is exactly one answer to "how loud is that boat" and the HUD,
 * the balance harness, and the server all read it.
 */

import {
  activePingLevel,
  hullMaterial,
  selfNoiseOf,
  sourceLevelOf,
  ticksPerPing,
  transientLevel,
  type AcousticTuning,
} from '../../content/acoustics.js';
import { getHull, type Hull } from '../../content/hulls.js';
import { depthAt } from '../../map/sizes.js';
import type { MapExtents, Vec2 } from '../../map/types.js';
import { addDecibels, sumDecibels } from '../../math/decibels.js';
import { isDamaged, type BoatState } from '../../match/world.js';
import type { AcousticEntity } from './solve.js';

/**
 * A hull's silhouette, placed and pointed — the polygon a reflection is drawn from.
 *
 * The silhouettes in `content/hulls.ts` are authored **+y down**, matching the simulation
 * frame planning/04 §2 describes, while positions and `facing` live in the y-up map frame
 * (`match/world.ts`). The flip happens here, once. Getting it wrong would draw every boat's
 * sail underneath it, which is the sort of thing that looks like a renderer bug for a week.
 */
export function hullOutline(hull: Hull, pos: Vec2, facing: number): Vec2[] {
  const radians = (facing * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return hull.silhouette.map(([sx, sy]) => {
    const ly = -sy;
    return { x: pos.x + sx * cos - ly * sin, y: pos.y + sx * sin + ly * cos };
  });
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
 * Everything one boat is radiating on top of its own machinery, split into the two things a
 * listener does with it.
 *
 * `deafening` is broadband racket — the boat's own transients, a wall it hit, a hull it hit.
 * It is power-summed onto the source level and it raises everyone's noise floor, because there
 * is nothing to filter out of a bang.
 *
 * `filterable` is what a hydrophone can notch: the coherent pulse of an active sonar
 * (`pingLevelOf`). It still joins the source level at full strength, so the pinger is heard
 * loud and its pulse still lights the walls — the split only softens how much that pulse deafens
 * anyone listening (see `filterableNoiseFraction`).
 *
 * Two sources, two buckets, and the point of the split is exactly that the solver *can* tell
 * them apart, on purpose: a bang announces you, a ping announces you *and* stays easy to hear
 * through. `boatEntity` keeps `sourceLevel` as the power-sum of both, so nothing that reads
 * "how loud is this boat" changes.
 *
 * A destroyed boat radiates nothing at all — not its own noise, not a ping, and not the bang it
 * made on the way down. `boatEntity` silences the first, `pingLevelOf` the second, and the third
 * is here: a wreck reflects, and does not speak (planning/04 §8).
 */
export interface EmittedLevels {
  /** Levels that raise listeners' noise floors, dB. Power-summed onto the source level. */
  readonly deafening: readonly number[];
  /** Levels that are easy to filter out of a noise floor, dB. Also part of the source level. */
  readonly filterable: readonly number[];
}

export function emittedLevels(
  boat: BoatState,
  tick: number,
  tickHz: number,
  tuning?: AcousticTuning,
): EmittedLevels {
  if (boat.status === 'destroyed') return { deafening: [], filterable: [] };

  const deafening: number[] = [];
  for (const transient of boat.transients) {
    const level = transientLevel(transient.kind, (tick - transient.tick) / tickHz);
    if (level > -Infinity) deafening.push(level);
  }

  const filterable: number[] = [];
  const ping = pingLevelOf(boat, tick, tickHz, tuning);
  if (ping > -Infinity) filterable.push(ping);

  return { deafening, filterable };
}

/**
 * One boat, ready for the solve.
 *
 * A destroyed boat is not dropped. It goes silent and stops listening, but it keeps its
 * outline and its absorption: a wreck on the seabed is a persistent reflector and a permanent
 * false contact at a known place (planning/04 §8), and it gets that for free by being the same
 * shape as everything else.
 *
 * `levels` are what the boat is radiating on top of its own machinery, already split into
 * deafening and filterable (`emittedLevels`). `sourceLevel` is the power-sum of *both*, so the
 * boat is as loud as ever; `filterableLevel` tells the solver which part of that is the easy-to-
 * notch portion, so a ping can be heard through without being lost.
 */
export function boatEntity(
  boat: BoatState,
  extents: MapExtents,
  levels: EmittedLevels = { deafening: [], filterable: [] },
  tuning?: AcousticTuning,
): AcousticEntity {
  const hull = getHull(boat.hull);
  const alive = boat.status !== 'destroyed';
  const depth = depthAt(extents, boat.pos.y);

  const deafening = alive
    ? sourceLevelOf(
        {
          stats: boat.stats,
          speed: boat.speed,
          depth,
          damaged: isDamaged(boat),
          transients: levels.deafening,
        },
        tuning,
      )
    : -Infinity;
  const filterable = alive ? sumDecibels(levels.filterable) : -Infinity;

  return {
    id: boat.id,
    team: boat.team,
    pos: boat.pos,
    // The full level — a pinging boat is as loud as it ever was, whatever a listener filters.
    sourceLevel: addDecibels(deafening, filterable),
    filterableLevel: filterable,
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
