/**
 * @seg/client/render/trails — the track a weapon has left behind it.
 *
 * A faint dotted line from where a torpedo entered the water to where it is now, drawn for the
 * team that owns it and for spectators. It is the counterpart to the run-out line
 * (`ScopeHost.tsx#drawWeapons`), and the pair divide the shot cleanly in two: the run-out line is
 * the **plan** and disappears the moment the weapon arrives, this is the **history** and only
 * ever grows.
 *
 * ## Why the client accumulates it rather than being sent it
 *
 * The server has the whole track and could send it, and that would be the wrong trade twice
 * over. A weapon's path is tens of samples that never change once taken, re-sent at 10 Hz
 * forever — the single most compressible thing on the wire and the least worth spending it on
 * (planning/02 §6). And the client already receives every position the track is made of; it
 * simply threw them away. Keeping them costs a few hundred `{x, y}` per weapon in the water,
 * which is nothing beside the thousands of lit squares the picture holds.
 *
 * The cost of that choice is honest and worth stating: **a player who joins mid-flight sees the
 * trail start where they joined**, not where the tube was. Same for a reconnect. That is the
 * correct failure for a line that is decoration — nobody makes a decision on the first hundred
 * metres of a torpedo's track — and the alternative is putting a growing array on every frame.
 *
 * ## The two things that keep it cheap
 *
 * **Distance sampling.** A point is kept only once the weapon has moved `TRAIL_SAMPLE_M` from
 * the last one, so a fast weapon and a slow one cost the same per metre rather than the same per
 * second. It also bounds the array by the weapon's *range* — a load with 3 km of fuel cannot
 * produce more than 3000/`TRAIL_SAMPLE_M` points however long it circles.
 *
 * **Dashes sized in screen pixels.** The gaps are a constant size to the eye at every zoom,
 * which means the number of dashes falls as the camera pulls out — exactly when the trails are
 * longest and there are most of them on screen. The whole layer is rebuilt when a frame lands or
 * the zoom changes, and never between.
 */

import type { EntityId, TorpedoSnapshot, Vec2 } from '@seg/shared';
import type { Graphics } from 'pixi.js';

import { COLORS } from './palette.js';

/**
 * Metres a weapon must travel before its track gains a point.
 *
 * Eight metres is a little over one torpedo length and about a third of a second at cruise, so a
 * turn reads as a curve rather than as a polygon. It is also the knob that decides the memory:
 * the longest-legged load in the table carries 3.6 km of fuel, which is 450 points.
 */
export const TRAIL_SAMPLE_M = 8;

/**
 * The most points one weapon's track may hold.
 *
 * A backstop rather than a budget — `TRAIL_SAMPLE_M` against the longest range in the weapon
 * table already lands under this. It exists so that a tuning pass that lengthens a weapon's range
 * cannot quietly turn this into an unbounded array, and it drops from the *front* so what is
 * discarded is the oldest and least interesting end of the run.
 */
const MAX_TRAIL_POINTS = 600;

/** Dash and gap, CSS pixels. Fine enough to read as dotted rather than as a broken line. */
const DASH_PX = 4;
const GAP_PX = 5;

/**
 * The most dashes one trail may be cut into.
 *
 * Zoomed all the way in, a three-kilometre track against a nine-pixel dash period is thousands of
 * segments, almost all of them off screen. Past this the period is stretched instead, which
 * coarsens a line nobody is reading closely and leaves the ones they are alone.
 *
 * The *segment* count it bounds is this plus at most one per sample point, because a dash that
 * straddles a vertex is drawn as two lines — it has to be, or it would cut the corner. So the
 * real ceiling is `MAX_DASHES + range / TRAIL_SAMPLE_M`, which for the longest-legged load in the
 * table is under a thousand and still an order of magnitude below the unstretched count.
 */
const MAX_DASHES = 400;

/**
 * Every weapon's track, keyed by the entity it belongs to.
 *
 * Mutable and polled, exactly like `SonarPicture` and for the same reason (planning/08 §1): it is
 * written on the view frame and read at display refresh, and neither rate may reach React.
 */
export class TorpedoTrails {
  private readonly tracks = new Map<EntityId, Vec2[]>();

  /** Bumped whenever a track gained a point or a weapon left. The renderer polls it. */
  revision = 0;

  get size(): number {
    return this.tracks.size;
  }

  /**
   * Fold one view frame's weapons in: extend the tracks that moved, and forget the weapons that
   * are no longer in the frames at all.
   *
   * **Forgotten on absence, not on `spent`.** A weapon that detonates stays in the view frames
   * for the few seconds its bang rings down (`match/torpedo.ts`), and its dart stops being drawn
   * immediately — but the track it left is the most informative thing on the screen in exactly
   * that moment, because it is the record of a shot that has just finished. So the line outlives
   * the mark by those few seconds and then goes with the weapon, which is what "disappears when
   * the torpedo does" means for an object that leaves in two stages.
   */
  observe(torpedoes: readonly TorpedoSnapshot[]): void {
    const present = new Set<EntityId>();
    let changed = false;

    for (const torpedo of torpedoes) {
      present.add(torpedo.id);
      const track = this.tracks.get(torpedo.id);
      if (track === undefined) {
        this.tracks.set(torpedo.id, [torpedo.pos]);
        changed = true;
        continue;
      }

      const last = track[track.length - 1];
      if (
        last !== undefined &&
        Math.hypot(torpedo.pos.x - last.x, torpedo.pos.y - last.y) < TRAIL_SAMPLE_M
      ) {
        continue;
      }
      track.push(torpedo.pos);
      if (track.length > MAX_TRAIL_POINTS) track.shift();
      changed = true;
    }

    for (const id of [...this.tracks.keys()]) {
      if (present.has(id)) continue;
      this.tracks.delete(id);
      changed = true;
    }

    if (changed) this.revision += 1;
  }

  /** Every track worth drawing — a single point is a weapon that has not moved yet. */
  *paths(): Generator<readonly Vec2[]> {
    for (const track of this.tracks.values()) {
      if (track.length >= 2) yield track;
    }
  }

  /** Forget everything. For a match ending, or a picture being replaced. */
  clear(): void {
    if (this.tracks.size === 0) return;
    this.tracks.clear();
    this.revision += 1;
  }
}

/**
 * Draw every track as a faint dotted line.
 *
 * Faint on purpose, and fainter than the run-out line: a trail is the only mark on the scope that
 * says nothing about the present. Everything else there — the weapon, its aim point, a contact —
 * is a thing the player may still act on, and a history drawn at the same weight as those would
 * compete with them for attention at the moment it matters least.
 *
 * Dotted rather than solid for the same reason, and because it is the one line on the display
 * that crosses everything: a solid stroke over the sonar picture would read as a wall the team
 * had charted. Pixi has no dash support, so the polyline is cut by hand — which is also what
 * makes sizing the dashes in screen pixels possible.
 */
export function drawTrails(graphics: Graphics, trails: TorpedoTrails, scale: number): void {
  graphics.clear();
  if (trails.size === 0) return;

  const dash = DASH_PX / scale;
  const gap = GAP_PX / scale;
  let drew = false;

  for (const path of trails.paths()) {
    // Stretch the period rather than emit thousands of off-screen segments. Measured per track,
    // so one very long run does not coarsen the short one beside it.
    const total = pathLength(path);
    const stretch = Math.max(1, total / (MAX_DASHES * (dash + gap)));
    if (dashPath(graphics, path, dash * stretch, gap * stretch)) drew = true;
  }

  // A `stroke` with nothing queued is a wasted call, and on an empty context Pixi would still
  // rebuild the geometry for it.
  if (drew) graphics.stroke({ color: COLORS.own, width: 1 / scale, alpha: 0.28 });
}

function pathLength(path: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Vec2;
    const b = path[i] as Vec2;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * Queue a polyline into `graphics` as alternating `on`/`off` runs, in world metres.
 *
 * The dash state carries **across** vertices rather than restarting at each one. Restarting would
 * be a line and a half shorter to write and would put a dash at every sample point, which at
 * `TRAIL_SAMPLE_M` is a regular pattern the eye reads as data — a tick per something — when it is
 * really an artefact of how often the client bothered to write the position down.
 */
function dashPath(graphics: Graphics, path: readonly Vec2[], on: number, off: number): boolean {
  if (on <= 0 || off <= 0) return false;

  let inking = true;
  let left = on;
  let queued = false;

  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Vec2;
    const b = path[i] as Vec2;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 0) continue;

    let walked = 0;
    while (length - walked > 1e-6) {
      const step = Math.min(left, length - walked);
      if (inking) {
        const from = walked / length;
        const to = (walked + step) / length;
        graphics.moveTo(a.x + (b.x - a.x) * from, a.y + (b.y - a.y) * from);
        graphics.lineTo(a.x + (b.x - a.x) * to, a.y + (b.y - a.y) * to);
        queued = true;
      }
      walked += step;
      left -= step;
      if (left <= 1e-6) {
        inking = !inking;
        left = inking ? on : off;
      }
    }
  }

  return queued;
}
