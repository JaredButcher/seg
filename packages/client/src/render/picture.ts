/**
 * @seg/client/render/picture — everything the player has heard, accumulated.
 *
 * A view frame is a *difference*: the squares confirmed since the last one, the squares lit
 * right now, the contacts held. What the scope draws is the running total, and this is where
 * the running total lives.
 *
 * ## Why it is not in the Zustand store
 *
 * It is mutated ten times a second and read at display refresh, and planning/08 §1 is
 * categorical that a view frame must not trigger a React render on the hot path. So it is a
 * plain mutable object that the store *holds* and the renderer *polls*, exactly like the fleet
 * getters. Nothing here is immutable, nothing here is copied, and nothing here notifies.
 *
 * ## The three fades, and what each one means
 *
 * **Charted squares never fade.** Rock does not move; a confirmed square is confirmed for the
 * match. The renderer only ever appends them, which is what makes a chart of a hundred thousand
 * squares affordable to draw (`sonar.ts`).
 *
 * **Transient squares fade to nothing.** They are what the sonar heard this instant and did not
 * commit to. A square that keeps being heard keeps being refreshed and so never fades; one that
 * was a fluke dims out over a fade that shortens with its strength — barely audible at
 * `FAINT_FADE_MS`, full strength at `CELL_FADE_MS` (planning/15 §2). Where it *was* a wall, the
 * chart append arrives in the same frame and the green fades onto a solid square instead of onto
 * water — which is the whole illusion, and it costs nothing because the two layers are simply
 * stacked.
 *
 * **Contacts fade toward hollow.** A live contact is a filled silhouette dimming with the age
 * of its last confirmation; once the server stops calling it live, what is left is an outline
 * at the pose that was measured. The client never moves it. Extrapolating a contact would be
 * the renderer inventing information (planning/02 §5).
 */

import {
  ACOUSTICS,
  dequantizeExcess,
  unpackCells,
  visionCellCentre,
  visionGridFor,
  VISION_CELL_SIZE,
  type ContactId,
  type HeardLaunch,
  type MapExtents,
  type RevealedContact,
  type Vec2,
  type VisionFrame,
  type VisionGrid,
} from '@seg/shared';

/**
 * How long a transient square takes to go from full strength to nothing, milliseconds.
 *
 * This is the fade at **or above** the confirmation threshold. A fainter square fades faster —
 * `fadeMsFor` interpolates down to `FAINT_FADE_MS` at zero excess. That is what makes an
 * ambient ghost (planning/15) fade in 400–650 ms rather than persisting like a real return: it
 * is sent at a deliberately low excess, and the picture never has to know it was anything but
 * faint (planning/15 §2, Option A).
 */
export const CELL_FADE_MS = 1_400;

/**
 * How long a transient square that *barely* cleared detection takes to fade, milliseconds.
 *
 * A return at zero excess is the dimmest the wire can express, and it is also the most likely
 * to be nothing — the sonar heard a flicker and committed to nothing, so it should evaporate
 * quickly. See `fadeMsFor`.
 */
export const FAINT_FADE_MS = 400;

/**
 * How long a transient square of a given strength takes to fade, milliseconds.
 *
 * Linear between `FAINT_FADE_MS` at zero excess and `CELL_FADE_MS` at the confirmation
 * threshold and above. A square that is being re-sent every 100 ms is refreshed before its fade
 * can bite, so this only affects squares that stop being heard — which is exactly when a short
 * fade is the honest reading (planning/15 §2).
 */
export function fadeMsFor(excess: number, confirmAt: number): number {
  const t = confirmAt <= 0 ? 1 : Math.min(1, Math.max(0, excess / confirmAt));
  return FAINT_FADE_MS + (CELL_FADE_MS - FAINT_FADE_MS) * t;
}

/**
 * The most transient squares kept at once.
 *
 * The server caps a frame at `maxWireVisionCells`, but a fade window spans several frames and a
 * boat sweeping past a wall lights fresh squares in every one of them. Without a ceiling here a
 * long match would accumulate a fade backlog nobody can see. Oldest goes first, which is also
 * dimmest, so the cut is invisible.
 */
export const MAX_LIVE_CELLS = 8_000;

/** A square lit by sonar, waiting to fade. */
export interface LitCell {
  readonly cell: number;
  /** Signal excess, dB. Drives brightness and nothing else (planning/03 §5). */
  excess: number;
  /** Milliseconds when it was last heard. */
  heardAt: number;
}

/** A hostile boat as the scope draws it: the frame's reading, plus when it arrived. */
export interface HeldContact extends RevealedContact {
  /** Milliseconds when this pose landed. What the fade is measured from. */
  heardAt: number;
}

/** A run of consecutive charted squares in one row — the unit the chart layer draws. */
export interface ChartRun {
  readonly col: number;
  readonly row: number;
  readonly length: number;
}

export class SonarPicture {
  readonly grid: VisionGrid;

  /**
   * The confirmation threshold, from the shipped table.
   *
   * Both the fade and the brightness read it, and they must read the same number the server
   * selected on — the client never computes this, it just needs the reference point
   * `cellIntensity` and `fadeMsFor` scale against.
   */
  private readonly confirmAt = ACOUSTICS.confirmationThreshold;

  private readonly charted = new Set<number>();
  /** Runs the renderer has not drawn yet. Drained, not read — see `drainChart`. */
  private pendingRuns: ChartRun[] = [];

  private readonly lit = new Map<number, LitCell>();
  private readonly held = new Map<ContactId, HeldContact>();
  /**
   * The hostile launches the latest frame carried.
   *
   * Kept rather than consumed, and *not* deduped here: the frame repeats each one for a few
   * seconds on purpose (`match/vision.ts#HeardLaunch`), and deciding which repetition is the
   * event belongs to whichever surface is animating it — the scope and the mini-map both watch
   * these and each keeps its own record of what it has already flashed. Two consumers, and a
   * picture that consumed the list would starve the second one.
   */
  private launched: readonly HeardLaunch[] = [];

  /** Bumped whenever anything changed. The renderer polls it; React never reads it. */
  revision = 0;

  constructor(extents: MapExtents) {
    this.grid = visionGridFor(extents);
  }

  /** How much of the map this team has confirmed. The one honest "progress" number available. */
  get chartSize(): number {
    return this.charted.size;
  }

  get litCells(): ReadonlyMap<number, LitCell> {
    return this.lit;
  }

  get contacts(): ReadonlyMap<ContactId, HeldContact> {
    return this.held;
  }

  /** Hostile launches still being reported. Empty almost always. */
  get launches(): readonly HeardLaunch[] {
    return this.launched;
  }

  /** The centre of a packed square, in map metres. */
  centreOf(cell: number): Vec2 {
    return visionCellCentre(this.grid, cell);
  }

  /** Fold one frame in. `now` is a monotonic millisecond clock — presentation only. */
  apply(frame: VisionFrame, now: number): void {
    for (const cell of unpackCells(frame.charted)) this.chart(cell);

    const cells = unpackCells(frame.cells);
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (cell === undefined) continue;
      const excess = dequantizeExcess(frame.strength[i] ?? 0);
      const existing = this.lit.get(cell);
      if (existing === undefined) {
        this.lit.set(cell, { cell, excess, heardAt: now });
      } else {
        existing.excess = excess;
        existing.heardAt = now;
      }
    }

    // A contact the frame does not mention has been dropped by the server's own hold rule, so
    // it goes here too. Rebuilding rather than merging is what keeps the two from disagreeing.
    const seen = new Set<ContactId>();
    for (const contact of frame.contacts) {
      seen.add(contact.id);
      const existing = this.held.get(contact.id);
      // Only a *fresh* measurement restarts the fade. A frame that repeats a stale contact
      // unchanged must not make it look newly heard.
      const heardAt =
        existing !== undefined && existing.seenTick === contact.seenTick ? existing.heardAt : now;
      this.held.set(contact.id, { ...contact, heardAt });
    }
    for (const id of [...this.held.keys()]) {
      if (!seen.has(id)) this.held.delete(id);
    }

    this.launched = frame.launches;

    this.expire(now);
    this.revision += 1;
  }

  /** Drop transient squares that have finished fading, and trim the backlog. */
  expire(now: number): void {
    for (const [cell, entry] of this.lit) {
      // Per-square fade: a faint square dies at `FAINT_FADE_MS`, a strong one rides out the
      // full `CELL_FADE_MS` (planning/15 §2).
      if (now - entry.heardAt >= fadeMsFor(entry.excess, this.confirmAt)) this.lit.delete(cell);
    }
    // `Map` iterates in insertion order and a refreshed entry keeps its original place, so the
    // front of the map is the least recently *first* heard. Close enough to oldest-first for a
    // backstop nobody should ever reach.
    if (this.lit.size <= MAX_LIVE_CELLS) return;
    let excess = this.lit.size - MAX_LIVE_CELLS;
    for (const cell of this.lit.keys()) {
      if (excess-- <= 0) break;
      this.lit.delete(cell);
    }
  }

  /**
   * The chart runs the renderer has not drawn yet, handed over and forgotten.
   *
   * Drained rather than read because the chart layer is append-only: once a run has been
   * tessellated into a sealed geometry buffer it is never touched again, so keeping it here
   * would be a second copy of the whole map with nobody to read it.
   */
  drainChart(): readonly ChartRun[] {
    const runs = this.pendingRuns;
    this.pendingRuns = [];
    return runs;
  }

  /** Whether a square is confirmed rock. */
  isCharted(cell: number): boolean {
    return this.charted.has(cell);
  }

  /**
   * Every confirmed square, in confirmation order.
   *
   * The order is the contract, not an accident of `Set`: the mini-map paints squares one at a
   * time into a canvas it never clears, and it tracks how many it has painted by counting. A
   * stable prefix is what makes "skip the first N" the same as "skip the ones already drawn".
   */
  chartedCells(): Iterable<number> {
    return this.charted;
  }

  /**
   * Record a confirmed square, extending the run in progress where it can.
   *
   * Frames arrive with their squares ascending (`match/vision.ts` sorts before encoding), so a
   * wall traced left to right collapses into one rectangle per row per frame instead of one per
   * square. On a dense map that is the difference between a few hundred rectangles a second and
   * a few thousand.
   */
  private chart(cell: number): void {
    if (this.charted.has(cell)) return;
    this.charted.add(cell);

    const col = cell % this.grid.cols;
    const row = (cell - col) / this.grid.cols;
    const last = this.pendingRuns[this.pendingRuns.length - 1];

    // `col > 0` guards the row wrap: id + 1 at the right-hand edge is the *next row's* first
    // square, which is nowhere near it on screen.
    if (last !== undefined && last.row === row && last.col + last.length === col && col > 0) {
      this.pendingRuns[this.pendingRuns.length - 1] = { ...last, length: last.length + 1 };
      return;
    }
    this.pendingRuns.push({ col, row, length: 1 });
  }
}

/**
 * How bright a transient square is right now, 0..1.
 *
 * Two terms multiplied, because they say different things and the player has to be able to read
 * both. **Strength** is how far the return cleared the threshold — a faint square is dim from
 * the instant it appears, which is the tell that the server is not going to confirm it.
 * **Age** is the fade. A square that is both faint and old is nearly gone; one that is strong
 * and fresh is the brightest thing on the screen.
 */
export function cellIntensity(entry: LitCell, now: number, confirmAt: number): number {
  const age = (now - entry.heardAt) / fadeMsFor(entry.excess, confirmAt);
  if (age >= 1) return 0;
  // Floored well above zero so a faint return is still *visible* — the whole point of the band
  // below the confirmation threshold is that a player can act on it (planning/03 §5.3).
  const strength = confirmAt <= 0 ? 1 : Math.min(1, 0.35 + (0.65 * entry.excess) / confirmAt);
  return strength * (1 - age * age);
}

/**
 * The size of a vision square in map metres — the renderer's name for `VISION_CELL_SIZE`.
 *
 * Re-exported rather than re-declared: the grid the server packs squares on and the grid this
 * draws them on have to be the same one, so there is exactly one place the number lives
 * (`sim/acoustics/skin.ts`).
 */
export const CELL_SIZE = VISION_CELL_SIZE;
