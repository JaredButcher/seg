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
  type AcousticTuning,
} from '../../content/acoustics.js';
import { getHull, type Hull } from '../../content/hulls.js';
import { depthAt } from '../../map/sizes.js';
import type { MapExtents, Vec2 } from '../../map/types.js';
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
 * One boat, ready for the solve.
 *
 * A destroyed boat is not dropped. It goes silent and stops listening, but it keeps its
 * outline and its absorption: a wreck on the seabed is a persistent reflector and a permanent
 * false contact at a known place (planning/04 §8), and it gets that for free by being the same
 * shape as everything else.
 *
 * `transients` are the levels of whatever is still ringing — `transientLevel(kind, elapsed)`
 * for each. The sim owns their timing; this only sums them in.
 */
export function boatEntity(
  boat: BoatState,
  extents: MapExtents,
  transients: readonly number[] = [],
  tuning?: AcousticTuning,
): AcousticEntity {
  const hull = getHull(boat.hull);
  const alive = boat.status !== 'destroyed';
  const depth = depthAt(extents, boat.pos.y);

  return {
    id: boat.id,
    team: boat.team,
    pos: boat.pos,
    sourceLevel: alive
      ? sourceLevelOf(
          {
            stats: boat.stats,
            speed: boat.speed,
            depth,
            damaged: isDamaged(boat),
            transients,
          },
          tuning,
        )
      : -Infinity,
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
