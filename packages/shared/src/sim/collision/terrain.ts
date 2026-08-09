/**
 * Where a boat may not be — the rock mask, and the outline test against it.
 *
 * Built once per match and then only read, exactly like the acoustic lattice (`sim/acoustics/
 * lattice.ts`) and for the same reason: rasterizing terrain is the expensive part and the terrain
 * never changes.
 *
 * ## It shares the rasterizer, deliberately
 *
 * `map/raster.ts` is the one routine that decides where rock is, and its own header explains why
 * two answers to that question is a bug that hides for a week. This is now its **third** consumer
 * — after `map/measure.ts`'s width audit and the acoustic lattice — and the one where a
 * disagreement would be most visible: a boat stopped by a wall its own team's sonar says is not
 * there. Sharing the fill is what makes that impossible.
 *
 * ## Resolution
 *
 * `COLLISION_CELL` is 5 m, finer than the 20 m acoustic lattice and matching the map ruler's
 * default. The mask samples cell *centres*, so a wall's position is quantized to ±2.5 m — about a
 * third of a hull's own height, and well inside the 1 m picture's ability to show a player where
 * the wall was. Finer would be honest and would cost four times the memory per halving for an
 * error already beneath what a player can act on.
 *
 * The generator floors passages at 200 m (`map/tuning.ts`), so nothing on the map is comparable to
 * a cell: there is no slot this mask could close and no wall it could open.
 *
 * ## Outside the map is solid
 *
 * The surface and the seabed are hard boundaries (planning/04 §6) and the left and right edges are
 * the end of the world. A point off the map therefore reads as rock, which is what gives the arena
 * a floor, a ceiling, and two ends without any of the three being a special case. Breaching the
 * surface is *supposed* to be a loud, damaging event rather than a wall — that is planning/04 §6's
 * `surface-breach`, and it is not built; until it is, the surface stops a boat like stone.
 */

import { getHull, type Hull } from '../../content/hulls.js';
import { rasterizeObstacles } from '../../map/raster.js';
import type { GeneratedMap, MapExtents, Obstacle, Vec2 } from '../../map/types.js';
import type { BoatState } from '../../match/world.js';
// The silhouette placed in the world. Shared with the acoustic model rather than re-derived:
// `content/hulls.ts` says in as many words that the authored outline is one asset with several
// jobs, and the reflection shape and the collision shape being the same polygon is the point.
import { hullOutline } from '../acoustics/boats.js';
import { outlineSamples } from './geometry.js';

/** Rock mask spacing, metres. See the header on why 5 and not less. */
export const COLLISION_CELL = 5;

export interface TerrainColliderOptions {
  /** Mask spacing, metres. Defaults to `COLLISION_CELL`; a test may want it coarse and quick. */
  readonly cellSize?: number;
}

export class TerrainCollider {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly extents: MapExtents;

  /** `1` where the cell centre is stone or off the map. Row-major, `cols × rows`. */
  private readonly rock: Uint8Array;

  constructor(
    extents: MapExtents,
    obstacles: readonly Obstacle[],
    options: TerrainColliderOptions = {},
  ) {
    this.cellSize = options.cellSize ?? COLLISION_CELL;
    this.extents = extents;
    this.cols = Math.max(1, Math.ceil(extents.width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(extents.height / this.cellSize));
    this.rock = rasterizeObstacles(obstacles, extents, this.cols, this.rows, this.cellSize);
  }

  /** A collider over a generated map's terrain — the form the runtime wants. */
  static forMap(map: GeneratedMap, options?: TerrainColliderOptions): TerrainCollider {
    return new TerrainCollider(map.extents, map.terrain.obstacles, options);
  }

  /** Whether a point is inside stone. Anything off the map is, too — see the header. */
  isRock(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x > this.extents.width || y > this.extents.height) return true;
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return true;
    return this.rock[row * this.cols + col] === 1;
  }

  /**
   * Whether a hull placed here is in contact with rock.
   *
   * The *outline*, not the centre: a boat is 73 to 170 m long and a centre test would let a
   * Heavy's bow stand thirty metres inside a wall before anything noticed. The perimeter is
   * walked at the mask's own spacing (`outlineSamples`), which is what makes the walk unable to
   * step over a wall.
   *
   * The interior is not tested and does not need to be: a hull can only come to enclose a piece
   * of rock by first putting its outline through it, and the outline is tested every tick.
   */
  hitsOutline(outline: readonly Vec2[]): boolean {
    for (const point of outlineSamples(outline, this.cellSize)) {
      if (this.isRock(point.x, point.y)) return true;
    }
    return false;
  }

  /** The same question asked about a hull at a pose. */
  hits(hull: Hull, pos: Vec2, facing: number): boolean {
    return this.hitsOutline(hullOutline(hull, pos, facing));
  }

  /** And about a boat, wherever it currently is. */
  hitsBoat(boat: BoatState): boolean {
    return this.hits(getHull(boat.hull), boat.pos, boat.facing);
  }
}
