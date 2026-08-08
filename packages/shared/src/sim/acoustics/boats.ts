/**
 * Boats, as the acoustic model sees them.
 *
 * The solver deliberately knows nothing about hulls, throttles, or hit points — it takes a
 * source level, an absorption, an outline, and a hydrophone. This file is the one place that
 * translation happens, so there is exactly one answer to "how loud is that boat" and the HUD,
 * the balance harness, and the server all read it.
 */

import {
  hullMaterial,
  selfNoiseOf,
  sourceLevelOf,
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
