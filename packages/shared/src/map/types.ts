/**
 * The output of a map generator and the types it shares between the server (which generates
 * and ships the map), the client (which renders it and shows the lobby preview), and the
 * tooling (which prints galleries of seeds). planning/14 §2 lists the consumers; every one
 * reads from this same structure.
 *
 * Units are metres throughout, and the coordinate frame is the vertical slice the game is
 * drawn in (planning/14 §1): the origin is the map's lower-left corner, +x runs rightward
 * across the width, +y runs upward from the seabed (y = 0) to the surface (y = height).
 *
 * Positions on the map are X/Y — that is what rendering, movement, and everything else in
 * the game uses. **Depth is a derived value, not a position**: `depth = y · depthScale`,
 * where `depthScale` normalizes a map's physical height to the game's fixed depth
 * (`map/sizes.ts`). The two are only compared against test and crush depths; a sub that
 * dives the same Δy on a small and a large map changes depth by different amounts, which is
 * exactly the point (planning/14 §1.2). The UI shows a position as X/Y(D).
 */

import type { MapSize, MapType } from '../lobby/settings.js';
import type { CaveTuning } from './tuning.js';

/** A point in map space, metres. `x` is the horizontal position, `y` the vertical. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * The arena's bounding box. `width` is the x extent, `height` the y extent — both physical
 * X/Y. A map's game depth range (0..`MAP_DEPTH`) is the same for every size; it is reached
 * through `depthScale`, never through these numbers directly.
 */
export interface MapExtents {
  readonly width: number;
  readonly height: number;
}

/**
 * Everything a generator is fed. `seed` and `mapSize` make generation a pure function of its
 * inputs, which is what replays (planning/04 §9) and property tests rely on.
 *
 * The fleet-scaling term from planning/14 §9 (the `sqrt(totalBoats / 24)` factor) is not here
 * yet: it belongs to match start, not to the lobby map settings, and it threads through
 * `resolveExtents` rather than changing this shape.
 */
export interface MapParams {
  readonly seed: number;
  readonly mapSize: MapSize;
  /**
   * Overrides the shipped cave tuning. **Development only** — see `resolveTuning`.
   *
   * The tuning is content: a replay reproduces a map from its seed and `generatorVersion`
   * and nothing else, so a map generated with an override cannot be reproduced from a
   * replay. Nothing reachable from the wire may set this; it exists for tests, the seed
   * gallery, and tuning experiments.
   */
  readonly tuning?: Partial<CaveTuning>;
}

/** A solid obstacle: a closed ring of vertices in map space, metres. */
export interface Obstacle {
  readonly vertices: readonly Vec2[];
}

/**
 * The terrain a match is fought over. The Empty generator produces open water — an empty
 * obstacle list; Sparse and Dense fill this with the cave-system contours that planning/14 §5
 * step 6 extracts. Rendering and the sector decomposition both consume the same polygons.
 */
export interface Terrain {
  readonly obstacles: readonly Obstacle[];
}

/** The complete, immutable result of generating a map. */
export interface GeneratedMap {
  /**
   * Which generation logic produced this map. Replay compatibility checks it alongside
   * `contentHash` (planning/04 §9); bumped on any change to generation logic, since a map is
   * content (planning/14 §5).
   */
  readonly generatorVersion: number;
  readonly seed: number;
  readonly mapType: MapType;
  readonly mapSize: MapSize;
  /** The physical X/Y arena. */
  readonly extents: MapExtents;
  /**
   * How much game depth one Y metre is worth: `depth = y · depthScale`. Stamped into the
   * map because the whole point of the depth scale is that it is the same for every player
   * and every tick, so consumers read it once instead of recomputing it.
   */
  readonly depthScale: number;
  readonly terrain: Terrain;
}
