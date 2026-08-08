/**
 * The reflectors — every square metre of surface that can send a sound back.
 *
 * This is the half of the model the player actually sees. The propagation lattice decides
 * *whether* something is lit; this decides *what shape the light has*, and it works at one
 * metre because that is the resolution the picture is reported at.
 *
 * ## Why a skin and not a fill
 *
 * Only the surface reflects. The inside of a hundred-metre wall of rock is never reached by
 * anything and never returns anything, so rasterizing solid terrain at 1 m — fifty-four
 * million cells on a large map — would spend all of it on stone nobody can hear. The boundary
 * is what matters, and the boundary is already available exactly: the generator emits contour
 * polygons, so the skin is those polygons walked at half-metre steps. A large map's whole rock
 * face is a few hundred thousand cells, about a megabyte, built once.
 *
 * Hull outlines go through the same routine each tick. A submarine is a closed polygon too,
 * and the reason it can be seen at all is that it reflects — which means **the same pass that
 * lights a cave wall draws the enemy's silhouette**, with no separate target-detection path.
 * A boat's absorption decides how brightly, so an anechoic coating is not a modifier bolted
 * onto a detection formula; it literally makes fewer of its squares clear the threshold.
 *
 * ## Grouping
 *
 * A reflector is rock, so it is never in any propagation field — fields cover water. Each 1 m
 * square is therefore bound to the water lattice cell nearest it (`WaterLattice.nearestWater`)
 * and the whole set is laid out CSR: `starts[cell]` to `starts[cell + 1]` is everything that
 * cell can hear. A listener sweeping its own field then finds every surface it can see exactly
 * once, with no neighbour search in the inner loop.
 */

import type { MapExtents, Obstacle, Vec2 } from '../../map/types.js';
import type { WaterLattice } from './lattice.js';

/** The reported resolution, metres. planning: the picture is sent as 1 × 1 m squares. */
export const VISION_CELL_SIZE = 1;

/** Half a cell per step, so a diagonal edge leaves an unbroken chain rather than a dotted one. */
const TRACE_STEP = 0.5;

/** The 1 m grid a map's squares are numbered on. Packed row-major: `row * cols + col`. */
export interface VisionGrid {
  readonly cols: number;
  readonly rows: number;
}

export function visionGridFor(extents: MapExtents): VisionGrid {
  return {
    cols: Math.max(1, Math.ceil(extents.width / VISION_CELL_SIZE)),
    rows: Math.max(1, Math.ceil(extents.height / VISION_CELL_SIZE)),
  };
}

export function packVisionCell(grid: VisionGrid, col: number, row: number): number {
  return row * grid.cols + col;
}

/** The centre of a packed square, in map metres. The point the client draws it at. */
export function visionCellCentre(grid: VisionGrid, packed: number): Vec2 {
  const col = packed % grid.cols;
  return {
    x: (col + 0.5) * VISION_CELL_SIZE,
    y: ((packed - col) / grid.cols + 0.5) * VISION_CELL_SIZE,
  };
}

/**
 * Walks a closed outline onto the 1 m grid, appending packed squares to `out`.
 *
 * Consecutive repeats are dropped as they are produced — at half-metre steps most samples land
 * in the square the last one did, and filtering here is what keeps a per-tick hull trace from
 * needing a sort afterwards. Squares off the map are dropped: an outline is allowed to hang
 * over the edge, and the part that hangs over is not a place a return can come from.
 */
export function traceOutline(grid: VisionGrid, outline: readonly Vec2[], out: number[]): void {
  if (outline.length < 2) return;
  let last = -1;

  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (a === undefined || b === undefined) continue;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / TRACE_STEP));

    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const col = Math.floor((a.x + dx * t) / VISION_CELL_SIZE);
      const row = Math.floor((a.y + dy * t) / VISION_CELL_SIZE);
      if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) continue;
      const packed = row * grid.cols + col;
      if (packed === last) continue;
      out.push(packed);
      last = packed;
    }
  }
}

/**
 * Every square metre of reflective surface on a map: the obstacle outlines, plus the seabed
 * and the surface.
 *
 * Those last two are not obstacles — nothing in the terrain list draws them — but they are
 * hard boundaries (planning/04 §6) and a ping that reaches the bottom comes back off it. A
 * boat hugging the floor is imaged against the floor, which is the whole flavour of bottoming
 * (planning/03 §8).
 *
 * Sorted and deduplicated, because obstacles share edges where the generator's discs
 * overlapped and a doubled square would be reported twice for the rest of the match.
 */
export function terrainReflectors(
  grid: VisionGrid,
  extents: MapExtents,
  obstacles: readonly Obstacle[],
): Int32Array {
  const cells: number[] = [];

  for (const obstacle of obstacles) traceOutline(grid, obstacle.vertices, cells);

  const seabed = 0;
  const surface = (grid.rows - 1) * grid.cols;
  const edge = Math.min(grid.cols, Math.ceil(extents.width / VISION_CELL_SIZE));
  for (let col = 0; col < edge; col += 1) {
    cells.push(seabed + col);
    if (grid.rows > 1) cells.push(surface + col);
  }

  const sorted = Int32Array.from(cells).sort();
  let unique = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] === sorted[i - 1]) continue;
    sorted[unique++] = sorted[i] ?? 0;
  }
  return sorted.subarray(0, unique);
}

/**
 * 1 m reflectors, grouped by the water lattice cell that can hear them.
 *
 * `owners` runs parallel to `cells`: an index into whatever list the caller built this from,
 * or `-1` for terrain. That is what lets one sweep light a cave wall and an enemy hull with
 * different absorptions without splitting the loop.
 */
export interface ReflectorSet {
  readonly cells: Int32Array;
  readonly owners: Int32Array;
  /** CSR offsets, length `lattice.cellCount + 1`. */
  readonly starts: Int32Array;
  /** Squares with no water cell anywhere on the map to hear them. Zero on any real map. */
  readonly orphaned: number;
}

/**
 * Bins packed 1 m squares by their nearest water cell, CSR.
 *
 * A counting sort rather than a comparison sort: the key is already a small dense integer, and
 * this runs once per tick over every hull outline in the match.
 */
export function groupByLattice(
  lattice: WaterLattice,
  grid: VisionGrid,
  cells: Int32Array | readonly number[],
  owners: Int32Array | readonly number[] | null,
): ReflectorSet {
  const count = cells.length;
  const bucket = new Int32Array(count);
  const starts = new Int32Array(lattice.cellCount + 1);
  let kept = 0;

  for (let i = 0; i < count; i += 1) {
    const packed = cells[i] ?? 0;
    const col = packed % grid.cols;
    const row = (packed - col) / grid.cols;
    const water = lattice.waterIndexAt(
      (col + 0.5) * VISION_CELL_SIZE,
      (row + 0.5) * VISION_CELL_SIZE,
    );
    bucket[i] = water;
    if (water < 0) continue;
    starts[water + 1] = (starts[water + 1] ?? 0) + 1;
    kept += 1;
  }

  for (let i = 0; i < lattice.cellCount; i += 1) {
    starts[i + 1] = (starts[i + 1] ?? 0) + (starts[i] ?? 0);
  }

  const grouped = new Int32Array(kept);
  const groupedOwners = new Int32Array(kept);
  const cursor = starts.slice(0, lattice.cellCount);

  for (let i = 0; i < count; i += 1) {
    const water = bucket[i] ?? -1;
    if (water < 0) continue;
    const at = cursor[water] ?? 0;
    cursor[water] = at + 1;
    grouped[at] = cells[i] ?? 0;
    groupedOwners[at] = owners === null ? -1 : (owners[i] ?? -1);
  }

  return { cells: grouped, owners: groupedOwners, starts, orphaned: count - kept };
}

/** The static half: every rock face on the map, bound to the water beside it. Built once. */
export function buildTerrainSkin(
  lattice: WaterLattice,
  extents: MapExtents,
  obstacles: readonly Obstacle[],
): ReflectorSet {
  const grid = visionGridFor(extents);
  return groupByLattice(lattice, grid, terrainReflectors(grid, extents, obstacles), null);
}
