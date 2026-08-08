/**
 * @seg/client/render/ScopeHost — the PixiJS scope canvas.
 *
 * One full-window canvas per match, owned by Pixi and driven by Pixi's ticker: React renders
 * the HUD that floats over it, and never touches the render loop (planning/08 §11). The
 * scene is built once per map; only the sonar sweep animates, which is what proves the RAF
 * loop, DPR sizing, and resize handling are all live.
 *
 * The map is drawn in its own coordinate frame — x right, y up, metres — through a flipped
 * `world` container. The sonar sweep lives inside that frame too, so its rings scale with the
 * map size and the whole scene reads as "positions in metres", which is the game's unit of
 * record (map/types.ts).
 */

import { MAP_DEPTH, type GeneratedMap } from '@seg/shared';
import { Application, Container, Graphics } from 'pixi.js';
import { useEffect, useRef } from 'react';

import { fitMap } from './fit.js';

/** Depth-grid line spacing, metres of game depth. */
const DEPTH_LINE_STEP = 200;
/** Seconds per sonar ping cycle. */
const PING_PERIOD = 2.4;

/** The 09 §4 palette, as Pixi numbers — mirrors the CSS tokens in styles.css. */
const COLORS = {
  background: 0x04070a,
  water: 0x0a1a22,
  frame: 0x164a55,
  depthLine: 0x0e2a33,
  sonar: 0x3bf0c4,
} as const;

export function ScopeHost({ map }: { map: GeneratedMap }) {
  const mount = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = mount.current;
    if (host === null) return;
    const el: HTMLElement = host;

    let disposed = false;
    let app: Application | null = null;
    let world: Container | null = null;
    let sonar: Graphics | null = null;

    // Pixi's resize plugin only defines `_cancelResize` once `init()` has resolved, so
    // `destroy()` on an Application whose init is still pending throws. Boot keeps the app
    // reference private until init settles, and cleanup only destroys a settled app — every
    // interleaving ends in exactly one destroy, after init.
    async function boot(): Promise<void> {
      const fresh = new Application();
      await fresh.init({
        background: COLORS.background,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio,
        width: el.clientWidth,
        height: el.clientHeight,
      });
      if (disposed) {
        fresh.destroy(true);
        return;
      }
      app = fresh;
      el.appendChild(fresh.canvas);

      world = buildWorld(map);
      fresh.stage.addChild(world);

      const center = new Container();
      center.position.set(map.extents.width / 2, map.extents.height / 2);
      sonar = new Graphics();
      center.addChild(sonar);
      world.addChild(center);

      let elapsed = 0;
      fresh.ticker.add((ticker) => {
        // `ticker.elapsedMS` is the raw wall time since the last frame; accumulated it is
        // seconds since the scope opened, which the sweep phases are pure functions of.
        elapsed += ticker.elapsedMS / 1000;
        if (sonar !== null) drawSonar(sonar, map, elapsed);
      });

      place(world, map, el.clientWidth, el.clientHeight);
    }
    void boot();

    const observer = new ResizeObserver(() => {
      if (app === null || world === null) return;
      app.renderer.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio);
      place(world, map, el.clientWidth, el.clientHeight);
    });
    observer.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      if (app !== null) app.destroy(true);
    };
  }, [map]);

  return <div ref={mount} className="scope-host" aria-hidden="true" />;
}

/** Fit the world into the current viewport. The frame is y-up; y-down on screen is the flip. */
function place(world: Container, map: GeneratedMap, width: number, height: number): void {
  const fit = fitMap(map.extents, { width, height });
  world.scale.set(fit.scale, -fit.scale);
  world.position.set(fit.offsetX, fit.offsetY + map.extents.height * fit.scale);
}

/** The static water and the depth grid — built once, shared by every frame. */
function buildWorld(map: GeneratedMap): Container {
  const world = new Container();
  const { width, height } = map.extents;

  const terrain = new Graphics();
  terrain.rect(0, 0, width, height);
  terrain.fill({ color: COLORS.water, alpha: 0.4 });
  terrain.stroke({ color: COLORS.frame, width: 4, alpha: 0.9 });

  // Horizontal lines every DEPTH_LINE_STEP of *game depth*. `y = depth / depthScale`, so the
  // same game depths sit at different Y on different map sizes — the depth model in pixels.
  const lines = new Graphics();
  for (let depth = DEPTH_LINE_STEP; depth < MAP_DEPTH; depth += DEPTH_LINE_STEP) {
    const y = depth / map.depthScale;
    if (y >= height) break;
    lines.moveTo(0, y);
    lines.lineTo(width, y);
  }
  lines.stroke({ color: COLORS.depthLine, width: 1.5, alpha: 0.9 });

  world.addChild(terrain);
  world.addChild(lines);
  return world;
}

/**
 * The animated sonar: a rotating beam plus expanding ping rings.
 *
 * Drawn fresh every tick from the accumulated elapsed-seconds clock, in world metres around the
 * map's centre. The rotation and ring phases are pure functions of time, so the sweep is smooth
 * and the ping cadence is constant regardless of frame rate.
 */
function drawSonar(graphics: Graphics, map: GeneratedMap, t: number): void {
  const maxRadius = Math.min(map.extents.width, map.extents.height) * 0.42;

  graphics.clear();

  // Expanding ping rings — the same cadence on every map size, in seconds.
  const phase = t / PING_PERIOD;
  for (let i = 0; i < 4; i += 1) {
    const p = (phase + i / 4) % 1;
    graphics.circle(0, 0, maxRadius * p);
    graphics.stroke({ color: COLORS.sonar, width: 3, alpha: (1 - p) * 0.5 });
  }

  // The rotating beam: a wedge swept out of the map centre.
  const sweep = 0.5;
  const start = -Math.PI / 2 + ((t * 0.9) % (Math.PI * 2));
  graphics.moveTo(0, 0);
  graphics.arc(0, 0, maxRadius, start, start + sweep);
  graphics.closePath();
  graphics.fill({ color: COLORS.sonar, alpha: 0.08 });
  graphics.arc(0, 0, maxRadius, start, start + sweep);
  graphics.stroke({ color: COLORS.sonar, width: 6, alpha: 0.3 });

  // The centre reticle.
  graphics.circle(0, 0, 14);
  graphics.moveTo(-30, 0);
  graphics.lineTo(30, 0);
  graphics.moveTo(0, -30);
  graphics.lineTo(0, 30);
  graphics.stroke({ color: COLORS.sonar, width: 2, alpha: 0.5 });
}
