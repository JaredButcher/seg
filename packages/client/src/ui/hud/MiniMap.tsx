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
import { scopeBoats } from './rows.js';

/**
 * Backing width in CSS pixels; the height follows the map's aspect, so the mini-map never
 * distorts a bearing. Sized to the right-hand column, which `CORE_INSETS.right` reserves —
 * the two have to move together or the panel starts covering water the camera thinks is free.
 */
const MINIMAP_WIDTH = 296;

const COLORS = {
  water: hex('water'),
  rock: hex('rockFill'),
  rockEdge: hex('rockCharted'),
  charted: hex('rockEdge'),
  frame: hex('frame'),
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
      // At map scale a 1 m square is a fraction of a pixel, so squares are painted as single
      // pixels and the picture builds up density rather than shape. That is honest: the
      // strategic view's job is "where have we been", not "what is the wall like".
      chartCtx.fillStyle = COLORS.charted;
      let index = 0;
      for (const cell of picture.chartedCells()) {
        index += 1;
        if (index <= painted.current) continue;
        const at = place(picture.centreOf(cell));
        chartCtx.fillRect(Math.floor(at.x), Math.floor(at.y), 1, 1);
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

    // Contacts. A live one is a filled mark, a slipped one is hollow — the same distinction the
    // scope makes with a silhouette, made here with the only two shapes a 3 px mark affords.
    if (picture !== null) {
      for (const contact of picture.contacts.values()) {
        const at = place(contact.pos);
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
      ctx.beginPath();
      ctx.arc(at.x, at.y, boat.mine ? 3 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle =
        boat.status === 'destroyed' ? COLORS.lost : boat.mine ? COLORS.own : COLORS.ally;
      ctx.fill();
    }

    ctx.strokeStyle = COLORS.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, MINIMAP_WIDTH - 1, height - 1);
  }, [base, charted, picture, setup, view, fit, height]);

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
