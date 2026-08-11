/**
 * @seg/client/render/sonar — the acoustic layers of the scope (planning/08 §3, layer 6).
 *
 * Three layers, stacked in the order the fiction requires and, conveniently, in the order their
 * costs demand:
 *
 * 1. **The chart.** Confirmed rock, drawn once and never redrawn. Append-only.
 * 2. **Transient returns.** Sonar-green squares, redrawn on a throttle as they fade.
 * 3. **Contacts.** Confirmed hostile silhouettes, filled while live and hollow once they slip.
 *
 * The stacking is what makes the mechanic legible without a single label. A square that is
 * about to become a wall gets its chart rectangle in the same frame as its green flash, so the
 * green fades and reveals rock underneath. A square that was a fluke has nothing under it and
 * fades to water. A square on a hull gets a silhouette over it. **The wire never says which of
 * the three a square is** — the client is not deciding, it is simply drawing three independent
 * things that happen to overlap (planning/03 §6, ADR 0002).
 *
 * ## Why the chart is chunked
 *
 * A charted map is tens of thousands of vision squares and it only ever grows. Pixi
 * re-tessellates a `Graphics` when its context changes, so one graphics object holding the
 * whole chart would re-tessellate the entire map every time a new square arrived — ten times a
 * second, forever. Instead the chart is a run of graphics objects: new runs go into the open
 * one, and when it is full it is sealed and never touched again. The per-frame cost is bounded
 * by the chunk size rather than by how long the match has been going.
 */

import { ACOUSTICS, SIM_TICK_HZ, type Vec2 } from '@seg/shared';
import { Container, Graphics } from 'pixi.js';

import { COLORS } from './palette.js';
import { cellIntensity, CELL_SIZE, type SonarPicture } from './picture.js';
import { contactMarkLength, traceSilhouette, traceWeaponIcon } from './silhouette.js';

/**
 * Runs per chart chunk before it is sealed.
 *
 * The trade is re-tessellation cost against draw-call count: small chunks mean cheap appends
 * and many draws, large ones the reverse. Two thousand rectangles is a few hundred microseconds
 * to rebuild and a whole map is a few dozen chunks.
 */
const RUNS_PER_CHUNK = 2_000;

/**
 * How often the transient layer is rebuilt, milliseconds.
 *
 * Not every frame: the only thing that changes between view frames is opacity, and a fade of
 * about a second and a half at 20 Hz is smooth to the eye while costing a third of what
 * redrawing at 60 fps would. The layer is thousands of rectangles and it is the one part of
 * this file with a real per-frame budget.
 */
const TRANSIENT_INTERVAL_MS = 50;

export class SonarLayers {
  /** Add this to the world container. Everything inside is in map metres. */
  readonly container = new Container();

  private readonly chart = new Container();
  private readonly transient = new Graphics();
  private readonly hulls = new Graphics();

  private open: Graphics | null = null;
  private openRuns = 0;

  private transientAt = 0;
  /** The picture revision the contact layer was last drawn at. */
  private contactsAt = -1;
  private contactTick = -1;
  /** And the zoom, which moves a weapon's mark once the camera is far enough out. */
  private contactScale = 0;

  constructor(private readonly picture: SonarPicture) {
    this.container.addChild(this.chart);
    this.container.addChild(this.transient);
    this.container.addChild(this.hulls);
  }

  /**
   * Bring every layer up to date.
   *
   * `now` is a monotonic millisecond clock for the fades; `tick` is the simulation tick of the
   * latest view frame, which is what a contact's age is measured in — the server stamps
   * `seenTick`, so ageing a contact against the sim clock rather than the wall clock means a
   * lagging connection sees a contact of the right age rather than one that has aged during the
   * flight of the packet. `scale` is pixels per metre, and only a weapon's mark reads it — see
   * `silhouette.ts#contactMarkLength`.
   */
  update(now: number, tick: number, scale: number): void {
    this.appendChart();

    if (now - this.transientAt >= TRANSIENT_INTERVAL_MS) {
      this.transientAt = now;
      this.drawTransient(now);
    }

    // Contacts change only when a frame lands, the sim clock moves, or the camera zooms, and
    // there are at most a few dozen. Redrawing them at display refresh would be free and
    // pointless.
    if (
      this.picture.revision !== this.contactsAt ||
      tick !== this.contactTick ||
      scale !== this.contactScale
    ) {
      this.contactsAt = this.picture.revision;
      this.contactTick = tick;
      this.contactScale = scale;
      this.drawContacts(tick, scale);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  // ── The chart ─────────────────────────────────────────────────────────────────

  private appendChart(): void {
    const runs = this.picture.drainChart();
    if (runs.length === 0) return;

    let target = this.open;
    let pending = 0;

    /**
     * Commit whatever rectangles are queued on the current chunk.
     *
     * Filled, not stroked. A charted square is a *fact*, and planning/09 §2 wants rock to read
     * as solid mass rather than as line art — but in the `terrain` tone rather than `rock-fill`,
     * because unlike a spectator's ground truth this is a sonar reading and should look like one.
     *
     * It has to happen per chunk rather than once at the end: a `fill` only claims the path
     * queued on the context it is called on, so rectangles left uncommitted on a chunk we
     * moved off would never be drawn at all.
     */
    const commit = (): void => {
      if (target === null || pending === 0) return;
      target.fill({ color: COLORS.rockEdge, alpha: 0.85 });
      pending = 0;
    };

    for (const run of runs) {
      if (target === null || this.openRuns >= RUNS_PER_CHUNK) {
        commit();
        // The chunk we are leaving is sealed by being left alone: it keeps its geometry and is
        // never written to again, so Pixi has no reason to rebuild it.
        target = new Graphics();
        this.openRuns = 0;
        this.chart.addChild(target);
      }
      // Grid coordinates, scaled into map metres — the container is in world space, and a run's
      // `length` counts squares rather than metres.
      target.rect(run.col * CELL_SIZE, run.row * CELL_SIZE, run.length * CELL_SIZE, CELL_SIZE);
      this.openRuns += 1;
      pending += 1;
    }

    commit();
    this.open = target;
  }

  // ── Transient returns ─────────────────────────────────────────────────────────

  private drawTransient(now: number): void {
    this.picture.expire(now);
    this.transient.clear();
    if (this.picture.litCells.size === 0) return;

    const confirmAt = ACOUSTICS.confirmationThreshold;
    // Banded rather than per-square alpha: a `Graphics` batches by fill, so one fill per band is
    // a handful of draw calls where one fill per square would be thousands. Eight bands is more
    // gradient than the eye resolves on a mark this small anyway.
    const bands: number[][] = Array.from({ length: 8 }, () => []);

    for (const entry of this.picture.litCells.values()) {
      const intensity = cellIntensity(entry, now, confirmAt);
      if (intensity <= 0) continue;
      const band = Math.min(bands.length - 1, Math.floor(intensity * bands.length));
      bands[band]?.push(entry.cell);
    }

    const { cols } = this.picture.grid;
    for (let band = 0; band < bands.length; band += 1) {
      const cells = bands[band];
      if (cells === undefined || cells.length === 0) continue;
      for (const cell of cells) {
        const col = cell % cols;
        this.transient.rect(
          col * CELL_SIZE,
          ((cell - col) / cols) * CELL_SIZE,
          CELL_SIZE,
          CELL_SIZE,
        );
      }
      this.transient.fill({ color: COLORS.sonar, alpha: ((band + 1) / bands.length) * 0.9 });
    }
  }

  // ── Contacts ──────────────────────────────────────────────────────────────────

  /**
   * Confirmed hostiles, boats as their silhouettes and weapons as darts.
   *
   * The two are drawn differently because they *are* different, and confirmation reveals which
   * (`match/vision.ts#ContactKind`). A boat gets its authored side profile, which is the whole of
   * planning/03 §6's recognition skill; a torpedo gets a dart pointing where it is going, because
   * a seven-metre object has no profile worth recognizing and the only question about it is
   * whether it is pointed at you.
   *
   * **Unless the team heard it well enough to say more.** A weapon that cleared
   * `identificationThreshold` carries its load in `RevealedContact.weapon`, and then the generic
   * dart is replaced by that load's own icon — sharp-nosed for the two that go bang, round for
   * the two that do not (`content/weapons.ts`). It is the same mark in the same place at the same
   * size; only its shape changes, so the transition reads as the picture sharpening rather than
   * as a second contact appearing.
   *
   * Both weapon marks are drawn at `contactMarkLength`, which is where the size rule lives —
   * including the guarantee that they are always larger than the player's own weapons.
   */
  private drawContacts(tick: number, scale: number): void {
    this.hulls.clear();
    const mark = contactMarkLength(scale);

    for (const contact of this.picture.contacts.values()) {
      const traced =
        contact.kind === 'torpedo' || contact.hull === null
          ? contact.weapon === null
            ? traceContactDart(this.hulls, contact.pos, contact.facing, mark)
            : traceWeaponIcon(this.hulls, contact.weapon, contact.pos, contact.facing, mark)
          : traceSilhouette(this.hulls, contact.hull, contact.pos, contact.facing);
      if (!traced) continue;

      if (contact.live) {
        // Still being confirmed: a solid reading, dimming with the age of the last measurement
        // so the player can see it going cold before it goes hollow.
        const age = ageOf(tick, contact.seenTick);
        const alpha = 1 - 0.5 * Math.min(1, age / ACOUSTICS.contactFadeSeconds);
        this.hulls.fill({ color: COLORS.hostile, alpha: 0.3 * alpha });
        this.hulls.stroke({ color: COLORS.hostile, width: 2, alpha });
      } else {
        // Slipped detection. Hollow, and it stays exactly where it was last heard — the boat is
        // long gone and the marker is a memory, which is what the empty middle says.
        this.hulls.stroke({ color: COLORS.hostile, width: 1.5, alpha: 0.45 });
      }
    }
  }
}

/**
 * An **unidentified** hostile weapon's mark: a dart pointing along its measured heading.
 *
 * Drawn here rather than taken from `content/weapons.ts` precisely because it is the shape that
 * belongs to no load. A team below `identificationThreshold` knows a weapon is in the water and
 * nothing else, and the mark has to say exactly that much — borrowing any of the four authored
 * icons for the purpose would put a claim on the screen the sonar has not made. Its plain
 * isoceles nose is deliberately between the sharp and rounded tips the real icons use, so it does
 * not accidentally answer the one question the player most wants answered.
 */
function traceContactDart(graphics: Graphics, pos: Vec2, facing: number, length: number): boolean {
  const radians = (facing * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const half = length / 2;
  const beam = length / 5;

  graphics.moveTo(pos.x + cos * half, pos.y + sin * half);
  graphics.lineTo(pos.x - cos * half - sin * beam, pos.y - sin * half + cos * beam);
  graphics.lineTo(pos.x - cos * half + sin * beam, pos.y - sin * half - cos * beam);
  graphics.closePath();
  return true;
}

/** Seconds between the frame's tick and the tick a contact was measured at. Never negative. */
function ageOf(tick: number, seenTick: number): number {
  return Math.max(0, (tick - seenTick) / SIM_TICK_HZ);
}
