/**
 * The mini-map (planning/08 §11, element 2). Bottom-right, always visible, not toggleable.
 *
 * **Side-on, same orientation as the scope** — a tiny whole-map camera, not a plan view. What
 * it draws is what the team has *proved*: the charted squares, its own boats, the objective
 * zones, and hollow marks where a hostile boat was last confirmed before it slipped detection.
 *
 * It deliberately does **not** draw the transient green picture. A faint return is a maybe, and
 * a maybe rendered at thirty metres per pixel is a lie — it would put a definite-looking speck
 * on the strategic view for something the server has not committed to. The scope is where you
 * read the shimmer; the mini-map is where you read what is settled (08 §11: raw sensing
 * products never appear here).
 *
 * A click jumps the main camera to that point, which is what makes it an orientation anchor
 * rather than decoration.
 *
 * Two canvases, and the split is the same static-buffer discipline the scope uses (08 §3). The
 * **chart layer** is painted a square at a time and never cleared — over a match it accumulates
 * exactly like the team's knowledge does, which costs one `fillRect` per newly confirmed
 * square and nothing at all per frame. The **live layer** is boats and markers, cleared and
 * redrawn on every view frame, and there are a few dozen of those.
 */

import type { MatchSetup, MatchViewState, Vec2 } from '@seg/shared';
import { useEffect, useMemo, useRef } from 'react';

import { fitMap } from '../../render/fit.js';
import { hex } from '../../render/palette.js';
import type { SonarPicture } from '../../render/picture.js';
import { LaunchAlerts } from '../../render/pings.js';
import { scopeBoats, scopeTorpedoes } from './rows.js';

/**
 * Backing width in CSS pixels; the height follows the map's aspect, so the mini-map never
 * distorts a bearing. Sized to the right-hand column, which `CORE_INSETS.right` reserves —
 * the two have to move together or the panel starts covering water the camera thinks is free.
 */
const MINIMAP_WIDTH = 296;

/**
 * The side of a charted square's mark, in CSS pixels.
 *
 * A vision square is 2 m and the mini-map runs at roughly 30 m per pixel, so the honest
 * footprint of one is a hundredth of a pixel — every size here is a legibility choice, not a
 * measurement. Three keeps a single confirmed square visible at arm's length and lets a traced
 * wall fuse into a continuous ridge, which is what the strategic view is actually read for.
 * Larger starts closing the gaps between separate walls and inventing a cave that isn't there.
 */
const CHART_MARK = 3;

const COLORS = {
  water: hex('water'),
  rock: hex('rockFill'),
  rockEdge: hex('rockCharted'),
  /**
   * Lifted a stop off the scope's `rockEdge`, and deliberately not a palette token: the scope
   * draws terrain at reading distance where a dim shade is atmosphere, and the mini-map draws it
   * at a glance underneath red contact marks, where the same shade is invisible. Same hue, so
   * the two still read as the same substance.
   */
  charted: '#2f7d8c',
  frame: hex('frame'),
  /** The backing a boat mark is punched out of, so it never sits directly on charted rock. */
  void: hex('background'),
  zone: '#ffc24b',
  own: hex('own'),
  ally: hex('ally'),
  hostile: hex('hostile'),
  lost: hex('lost'),
} as const;

interface MiniMapProps {
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
  /** The team's accumulated picture, or `null` before `match.state` lands. */
  readonly picture: SonarPicture | null;
  readonly onJump: (point: Vec2) => void;
}

export function MiniMap({ setup, view, picture, onJump }: MiniMapProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  /** How many charted squares have been painted onto the chart layer already. */
  const painted = useRef(0);
  /**
   * The mini-map's own launch-alarm tracker, separate from the scope's.
   *
   * Two trackers for one event, deliberately. The tracker's job is to decide which repetition of
   * a heard launch is the one *this surface* has already flashed (`render/pings.ts`), and the two
   * surfaces animate independently — the scope on Pixi's ticker, this on the view frame. Sharing
   * one would mean whichever drew first consumed the alert and the other never saw it.
   *
   * This is the panel where the alarm matters most: the scope shows a screenful of ocean and the
   * shot will often be fired outside it, which is exactly the case where the player needs to be
   * told to look somewhere else.
   */
  const alerts = useRef(new LaunchAlerts());
  const { extents } = setup.map;
  const height = Math.max(48, Math.round((MINIMAP_WIDTH * extents.height) / extents.width));
  const fit = useMemo(() => fitMap(extents, { width: MINIMAP_WIDTH, height }), [extents, height]);

  /**
   * The base layer: water, and — for a spectator only — ground truth rock.
   *
   * A player's version is a bare box, which is the point. Rebuilt only when the map changes.
   */
  const base = useMemo(() => {
    const layer = document.createElement('canvas');
    layer.width = MINIMAP_WIDTH;
    layer.height = height;
    const ctx = layer.getContext('2d');
    if (ctx === null) return layer;

    ctx.fillStyle = COLORS.water;
    ctx.fillRect(0, 0, MINIMAP_WIDTH, height);

    const terrain = setup.map.terrain;
    if (terrain !== null) {
      ctx.beginPath();
      for (const obstacle of terrain.obstacles) {
        obstacle.vertices.forEach((vertex, index) => {
          // The y flip: the map frame is y-up, a canvas is y-down.
          const x = fit.offsetX + vertex.x * fit.scale;
          const y = height - (fit.offsetY + vertex.y * fit.scale);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.fillStyle = COLORS.rock;
      ctx.fill();
      ctx.strokeStyle = COLORS.rockEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    return layer;
  }, [setup.map, fit, height]);

  /** The chart layer: one transparent canvas, painted into and never cleared. */
  const charted = useMemo(() => {
    const layer = document.createElement('canvas');
    layer.width = MINIMAP_WIDTH;
    layer.height = height;
    painted.current = 0;
    return layer;
  }, [height, picture]);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d') ?? null;
    if (element === null || ctx === null) return;

    const place = (point: Vec2) => ({
      x: fit.offsetX + point.x * fit.scale,
      y: height - (fit.offsetY + point.y * fit.scale),
    });

    // ── Paint whatever the chart has gained since last time ───────────────────
    // Incremental, and the counter is why: a chart of a hundred thousand squares repainted ten
    // times a second would be the most expensive thing on the page, and every square in it
    // would be identical to the one drawn before.
    const chartCtx = charted.getContext('2d');
    if (picture !== null && chartCtx !== null) {
      // At map scale a vision square is a fraction of a pixel, so each one is painted as a
      // `CHART_MARK` block centred on where it falls and the picture builds up density rather
      // than shape. That is honest: the strategic view's job is "where have we been", not "what
      // is the wall like". Blocks from neighbouring squares overlap heavily, which is the point
      // — a confirmed wall wants to read as one mass, not as a dotted line.
      chartCtx.fillStyle = COLORS.charted;
      const offset = (CHART_MARK - 1) / 2;
      let index = 0;
      for (const cell of picture.chartedCells()) {
        index += 1;
        if (index <= painted.current) continue;
        const at = place(picture.centreOf(cell));
        chartCtx.fillRect(
          Math.round(at.x - offset),
          Math.round(at.y - offset),
          CHART_MARK,
          CHART_MARK,
        );
      }
      painted.current = index;
    }

    ctx.clearRect(0, 0, MINIMAP_WIDTH, height);
    ctx.drawImage(base, 0, 0);
    ctx.drawImage(charted, 0, 0);

    // Objective zones: known from the start, so they are drawn whether or not anyone is in them.
    for (const zone of setup.zones) {
      const at = place(zone.centre);
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(2, zone.radius * fit.scale), 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.zone;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /**
     * The dark rim every boat mark is drawn on.
     *
     * Boats sit on top of the chart, and now that the chart is a bright mass a 3 px mark laid
     * straight onto it loses its edge — worst of all `ally`, which is within a shade of the
     * charted teal. One ring of background colour under the mark restores the separation
     * without changing what any of the colours mean.
     */
    const rim = (at: Vec2, radius: number) => {
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius + 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.void;
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    // Contacts. A live one is a filled mark, a slipped one is hollow — the same distinction the
    // scope makes with a silhouette, made here with the only two shapes a 3 px mark affords.
    if (picture !== null) {
      for (const contact of picture.contacts.values()) {
        const at = place(contact.pos);
        rim(at, 3);
        ctx.beginPath();
        ctx.arc(at.x, at.y, 3, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.hostile;
        ctx.lineWidth = 1;
        if (contact.live) {
          ctx.fillStyle = COLORS.hostile;
          ctx.fill();
        }
        ctx.stroke();
      }
    }

    // Own forces as marks rather than silhouettes: at this size a hull profile is one pixel
    // of noise, and what the panel is for is "where is my fleet", not "which way is it facing".
    for (const boat of scopeBoats(setup, view)) {
      const at = place(boat.pos);
      const radius = boat.mine ? 3 : 2.5;
      rim(at, radius);
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.fillStyle =
        boat.status === 'destroyed' ? COLORS.lost : boat.mine ? COLORS.own : COLORS.ally;
      ctx.fill();
    }

    // The team's own weapons, as smaller marks. Worth the two pixels: a torpedo in the water is
    // the one friendly object whose position changes what everyone else on the team should do,
    // and it is very often off the edge of the scope's viewport.
    for (const torpedo of scopeTorpedoes(view)) {
      if (torpedo.phase === 'spent') continue;
      const at = place(torpedo.pos);
      rim(at, 2);
      ctx.beginPath();
      ctx.arc(at.x, at.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.own;
      ctx.fill();
    }

    /*
     * The alarm, last and over everything — see `alerts` on why this panel is where it matters
     * most.
     *
     * Drawn at the world's scale like every other mark here, so a 600 m ring is about twenty
     * pixels across and sits honestly over the piece of map it happened on. Animated at the view
     * frame rate rather than at display refresh, because this effect *is* the view frame: 10 Hz
     * is coarse for a two-and-a-half-second animation and entirely enough for a flashing circle.
     */
    alerts.current.observe(picture?.launches ?? [], now());
    for (const ring of alerts.current.rings(now())) {
      const at = place({ x: ring.x, y: ring.y });
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(2, ring.radius * fit.scale), 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.hostile;
      ctx.globalAlpha = ring.alpha;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = COLORS.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, MINIMAP_WIDTH - 1, height - 1);
  }, [base, charted, picture, setup, view, fit, height]);

  /**
   * A monotonic millisecond clock for the alarm's animation.
   *
   * The same fallback `state/match.ts` uses and for the same reason — jsdom has both, but a test
   * environment without a performance timeline should still be able to paint a panel. Neither is
   * authoritative for anything: this drives a fading circle, and everything the *game* measures
   * is measured in simulation ticks (planning/02 §5).
   */
  function now(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
  }

  function jump(event: React.MouseEvent<HTMLCanvasElement>): void {
    const element = canvas.current;
    if (element === null) return;
    const bounds = element.getBoundingClientRect();
    // Back through the same transform, including the flip, and in the panel's own CSS pixels
    // rather than the canvas's — the two differ the moment the column is narrower than 236.
    const px = ((event.clientX - bounds.left) / bounds.width) * MINIMAP_WIDTH;
    const py = ((event.clientY - bounds.top) / bounds.height) * height;
    onJump({
      x: (px - fit.offsetX) / fit.scale,
      y: (height - py - fit.offsetY) / fit.scale,
    });
  }

  return (
    <section className="hud-minimap" aria-label="Mini-map">
      <canvas
        ref={canvas}
        className="hud-minimap__canvas"
        width={MINIMAP_WIDTH}
        height={height}
        onClick={jump}
        role="button"
        tabIndex={0}
        aria-label="Whole map. Click to move the scope there."
      />
    </section>
  );
}
