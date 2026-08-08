/**
 * The mini-map (planning/08 §11, element 2). Bottom-right, always visible, not toggleable.
 *
 * **Side-on, same orientation as the scope** — a tiny whole-map camera, not a plan view. It
 * draws the *charted* world (terrain, surface and seabed, objective zones) plus own boats. It
 * will draw the tracker's contact picture when there is one, and it will never draw raw
 * sensing products: a wedge or an echo on the mini-map would leak a position the player has
 * not earned.
 *
 * A click jumps the main camera to that point, which is what makes it an orientation anchor
 * rather than decoration.
 *
 * Terrain is rendered once into an offscreen canvas and composited from there, the same
 * static-buffer discipline the scope uses (08 §3): a dense map is several thousand edges and
 * re-tessellating them ten times a second for a 240 px picture would be absurd.
 */

import type { MatchSetup, MatchViewState, Vec2 } from '@seg/shared';
import { useEffect, useMemo, useRef } from 'react';

import { fitMap } from '../../render/fit.js';
import { scopeBoats } from './rows.js';

/**
 * Backing width in CSS pixels; the height follows the map's aspect, so the mini-map never
 * distorts a bearing. Sized to the right-hand column, which `CORE_INSETS.right` reserves —
 * the two have to move together or the panel starts covering water the camera thinks is free.
 */
const MINIMAP_WIDTH = 296;

const COLORS = {
  water: '#0a1a22',
  rock: '#111f24',
  rockEdge: '#1b4650',
  frame: '#164a55',
  zone: '#ffc24b',
  own: '#3bf0c4',
  ally: '#2b8f95',
  lost: '#40474a',
} as const;

interface MiniMapProps {
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
  readonly onJump: (point: Vec2) => void;
}

export function MiniMap({ setup, view, onJump }: MiniMapProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { extents } = setup.map;
  const height = Math.max(48, Math.round((MINIMAP_WIDTH * extents.height) / extents.width));

  /** The static layer: water, rock, and the frame. Rebuilt only when the map changes. */
  const terrain = useMemo(() => {
    const layer = document.createElement('canvas');
    layer.width = MINIMAP_WIDTH;
    layer.height = height;
    const ctx = layer.getContext('2d');
    if (ctx === null) return layer;

    const fit = fitMap(extents, { width: MINIMAP_WIDTH, height });
    ctx.fillStyle = COLORS.water;
    ctx.fillRect(0, 0, MINIMAP_WIDTH, height);

    ctx.beginPath();
    for (const obstacle of setup.map.terrain.obstacles) {
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

    return layer;
  }, [setup.map, extents, height]);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d') ?? null;
    if (element === null || ctx === null) return;

    const fit = fitMap(extents, { width: MINIMAP_WIDTH, height });
    const place = (point: Vec2) => ({
      x: fit.offsetX + point.x * fit.scale,
      y: height - (fit.offsetY + point.y * fit.scale),
    });

    ctx.clearRect(0, 0, MINIMAP_WIDTH, height);
    ctx.drawImage(terrain, 0, 0);

    // Objective zones: charted, so they are drawn whether or not anyone is in them.
    for (const zone of setup.zones) {
      const at = place(zone.centre);
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(2, zone.radius * fit.scale), 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.zone;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
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
  }, [terrain, setup, view, extents, height]);

  function jump(event: React.MouseEvent<HTMLCanvasElement>): void {
    const element = canvas.current;
    if (element === null) return;
    const bounds = element.getBoundingClientRect();
    const fit = fitMap(extents, { width: MINIMAP_WIDTH, height });
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
