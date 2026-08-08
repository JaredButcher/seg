/**
 * @seg/client/render/ScopeHost — the PixiJS scope canvas.
 *
 * One full-window canvas per match, owned by Pixi and driven by Pixi's ticker: React renders
 * the HUD that floats over it, and never touches the render loop (planning/08 §11). The map's
 * geometry is built once per match into a static container and never re-tessellated; moving
 * the camera is a transform on that container, which is the whole point of building it that
 * way (08 §3, performance budget).
 *
 * The map is drawn in its own coordinate frame — x right, y up, metres — through a flipped
 * `world` container, so everything downstream of here is written in the game's unit of record
 * (map/types.ts) and never in pixels. Where the container lands is `camera.ts`'s answer.
 *
 * This is the render-and-controls slice: terrain, and a camera to look at it with. Sonar, fog
 * of war, and everything that has to be *sensed* rather than known arrive with the sim.
 */

import { MAP_DEPTH, type GeneratedMap } from '@seg/shared';
import { Application, Container, Graphics } from 'pixi.js';
import { useEffect, useRef } from 'react';

import {
  DEFAULT_VIEW_HEIGHT_M,
  PAN_KEYS,
  ZOOM_KEYS,
  type Camera,
  type Rect,
  type View,
  clampCamera,
  clampViewHeight,
  coreViewport,
  endCamera,
  panByKeys,
  panByPixels,
  placeWorld,
  scaleFor,
  zoomAt,
  zoomFactorForKeys,
  zoomFactorForWheel,
} from './camera.js';

/** Depth-grid line spacing, metres of game depth. */
const DEPTH_LINE_STEP = 200;
/** Length of the core viewport's corner ticks, CSS pixels. */
const CORNER_TICK = 18;

/** The 09 §4 palette, as Pixi numbers — mirrors the CSS tokens in styles.css. */
const COLORS = {
  background: 0x04070a,
  water: 0x0a1a22,
  frame: 0x164a55,
  depthLine: 0x0e2a33,
  rockFill: 0x0a1418,
  // `terrain`, the sonar-sensed edge. There is no sensing yet, so every wall is drawn at full
  // crispness; once contacts and returns exist this splits against `terrain-charted` (09 §4).
  rockEdge: 0x1b4650,
} as const;

interface ScopeHostProps {
  readonly map: GeneratedMap;
  /**
   * Whether the camera answers to the keyboard and the mouse. False while a modal owns the
   * screen: the Esc window is not a pause, but panning the scope from behind it is not what
   * a player pressing `S` for "settings" meant.
   */
  readonly inputEnabled?: boolean;
}

export function ScopeHost({ map, inputEnabled = true }: ScopeHostProps) {
  const mount = useRef<HTMLDivElement | null>(null);
  // Held keys and the input gate live outside the Pixi effect: they change far more often than
  // the map does, and rebuilding the scene to learn that a menu opened would be absurd.
  const held = useRef<Set<string>>(new Set());
  const enabled = useRef(inputEnabled);

  useEffect(() => {
    enabled.current = inputEnabled;
    // A key still down when the menu opened would otherwise pan forever: its keyup lands on a
    // gate that ignores it, and nothing else ever clears it.
    if (!inputEnabled) held.current.clear();
  }, [inputEnabled]);

  useEffect(() => {
    const host = mount.current;
    if (host === null) return;
    const el: HTMLElement = host;

    let disposed = false;
    let app: Application | null = null;
    let world: Container | null = null;
    let frame: Graphics | null = null;

    let core: Rect = coreViewport({ width: el.clientWidth, height: el.clientHeight });
    // Zoom is held as a world height and pixels-per-metre is derived, so a resize changes how
    // big the picture is and never how much ocean is in it.
    let viewHeight = clampViewHeight(DEFAULT_VIEW_HEIGHT_M, map.extents, core);
    let scale = scaleFor(core, viewHeight);
    // Open on the middle of the map. With no fleet to follow yet there is no better anchor,
    // and the centre is the one position from which every part of the map is a pan away.
    let camera: Camera = clampCamera(
      { x: map.extents.width / 2, y: map.extents.height / 2 },
      map.extents,
      core,
      scale,
    );

    /** Push the current view onto the world container. The y flip is the scale's sign. */
    function apply(): void {
      if (world === null) return;
      const placement = placeWorld(camera, core, scale);
      world.scale.set(placement.scale, -placement.scale);
      world.position.set(placement.originX, placement.originY);
    }

    /**
     * The one road to a new view. Every input goes through here, so the "map always covers the
     * core viewport" invariant holds for all of them at once rather than being re-argued per
     * handler — and zoom is clamped before the camera, since how far out the camera may sit
     * depends on how much it can see.
     */
    function show(next: View): void {
      viewHeight = clampViewHeight(next.viewHeight, map.extents, core);
      scale = scaleFor(core, viewHeight);
      camera = clampCamera(next.camera, map.extents, core, scale);
      apply();
    }

    /** Move the camera, keeping the zoom. */
    function moveTo(next: Camera): void {
      show({ camera: next, viewHeight });
    }

    /** Recompute everything that depends on the window size, then re-clamp: a window that
     * grows can reveal void past a map edge, and the camera has to give ground for it. */
    function layout(): void {
      core = coreViewport({ width: el.clientWidth, height: el.clientHeight });
      if (frame !== null) drawFrame(frame, core);
      show({ camera, viewHeight });
    }

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

      // The core viewport's frame is drawn in screen space, on top of the water — it is part
      // of the instrument housing, not part of the world (08 §3).
      frame = new Graphics();
      fresh.stage.addChild(frame);

      fresh.ticker.add((ticker) => {
        if (!enabled.current || held.current.size === 0) return;
        // `deltaMS` is wall time since the last frame, so a held key pans and zooms at the
        // same rate whatever the frame rate is doing.
        const seconds = ticker.deltaMS / 1000;

        // Zoom first: panning a screenful per second means something different afterwards,
        // and the player pressing both expects the pan they can see, not the one they had.
        const zoomFactor = zoomFactorForKeys(held.current, seconds);
        const zoomed =
          zoomFactor === 1
            ? { camera, viewHeight }
            : zoomAt({ camera, viewHeight }, zoomFactor, null, map.extents, core);

        show({
          camera: panByKeys(
            zoomed.camera,
            held.current,
            seconds,
            core,
            scaleFor(core, zoomed.viewHeight),
          ),
          viewHeight: zoomed.viewHeight,
        });
      });

      layout();
    }
    void boot();

    // ── pointer: drag to pan ────────────────────────────────────────────────────
    // Bound to the host rather than the canvas because the canvas does not exist until init
    // resolves, and because pointer capture on the host survives the pointer crossing a HUD
    // panel mid-drag — a drag that dies when the cursor clips the fleet list feels broken.
    let dragging: number | null = null;
    let lastX = 0;
    let lastY = 0;

    function onPointerDown(event: PointerEvent): void {
      if (!enabled.current || event.button !== 0 || dragging !== null) return;
      dragging = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      el.setPointerCapture(event.pointerId);
      el.classList.add('scope-host--dragging');
    }

    function onPointerMove(event: PointerEvent): void {
      if (dragging !== event.pointerId) return;
      moveTo(panByPixels(camera, event.clientX - lastX, event.clientY - lastY, scale));
      lastX = event.clientX;
      lastY = event.clientY;
    }

    function onPointerUp(event: PointerEvent): void {
      if (dragging !== event.pointerId) return;
      dragging = null;
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      el.classList.remove('scope-host--dragging');
    }

    /**
     * Wheel to zoom, about the cursor: the water under the pointer stays under the pointer,
     * so zooming doubles as pointing at the thing you want to look at.
     */
    function onWheel(event: WheelEvent): void {
      if (!enabled.current) return;
      // The gesture is ours, not the browser's. Without this the page scrolls under the fixed
      // match screen, and a trackpad pinch — which arrives as ctrl+wheel — zooms the whole UI.
      event.preventDefault();

      const bounds = el.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const factor = zoomFactorForWheel(event.deltaY, event.deltaMode);

      show(zoomAt({ camera, viewHeight }, factor, anchor, map.extents, core));
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    // ── keyboard: WASD to pan, arrows to zoom, Home/End to the ends ─────────────
    // On the window, not the canvas: the scope is never the focused element, and a camera you
    // have to click into first is a camera that ignores you at the worst moment.
    function onKeyDown(event: KeyboardEvent): void {
      if (!enabled.current || event.ctrlKey || event.metaKey || event.altKey) return;

      // Pan and zoom are held rather than fired: the ticker reads the set each frame, which
      // is what makes a diagonal one gesture instead of two competing repeat streams.
      const key = event.key.toLowerCase();
      if (PAN_KEYS[key] !== undefined || ZOOM_KEYS[key] !== undefined) {
        held.current.add(key);
        // The arrows would otherwise scroll the page out from under the match.
        if (ZOOM_KEYS[key] !== undefined) event.preventDefault();
        return;
      }

      if (event.key !== 'Home' && event.key !== 'End') return;
      // Otherwise the browser scrolls the page under the fixed match screen.
      event.preventDefault();
      moveTo(endCamera(camera, map.extents, event.key === 'Home' ? 'left' : 'right', core, scale));
    }

    /** Releases are unconditional: a key that went down before the gate closed still comes up. */
    function onKeyUp(event: KeyboardEvent): void {
      held.current.delete(event.key.toLowerCase());
    }

    /** Alt-tabbing away eats the keyup, so the window losing focus counts as letting go. */
    function onBlur(): void {
      held.current.clear();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    const observer = new ResizeObserver(() => {
      if (app === null) return;
      app.renderer.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio);
      layout();
    });
    observer.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      held.current.clear();
      if (app !== null) app.destroy(true);
    };
  }, [map]);

  return <div ref={mount} className="scope-host" aria-hidden="true" />;
}

/** The static world: water, rock, and the depth grid — built once, shared by every frame. */
function buildWorld(map: GeneratedMap): Container {
  const world = new Container();
  const { width, height } = map.extents;

  // Opaque, not tinted: at 40% over the void the water composited *darker* than `rock-fill`,
  // which inverts 09 §2 — rock has to sit slightly warmer than the water for the eye to parse
  // open space as figure against ground.
  const water = new Graphics();
  water.rect(0, 0, width, height);
  water.fill({ color: COLORS.water });
  water.stroke({ color: COLORS.frame, width: 4, alpha: 0.9 });

  // Rock as a filled silhouette with a thin stroked edge, not glowing contours (09 §2): the
  // water reads as figure against ground, and glow stays reserved for sensor readings. Each
  // obstacle is one closed ring in map metres, so it goes straight into the y-up world frame.
  const rock = new Graphics();
  for (const obstacle of map.terrain.obstacles) {
    const [first, ...rest] = obstacle.vertices;
    if (first === undefined) continue;
    rock.moveTo(first.x, first.y);
    for (const vertex of rest) rock.lineTo(vertex.x, vertex.y);
    rock.closePath();
  }
  rock.fill({ color: COLORS.rockFill });
  rock.stroke({ color: COLORS.rockEdge, width: 3, alpha: 0.9 });

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

  world.addChild(water);
  world.addChild(rock);
  world.addChild(lines);
  return world;
}

/**
 * The core viewport, drawn as instrument housing: a hairline box with brighter corner ticks.
 *
 * It earns its place twice. It is the frame the fixed markings will hang off, and it makes the
 * camera limit legible — when panning stops, the player can see the map edge resting against
 * this line rather than wondering whether the controls dropped an input.
 */
function drawFrame(graphics: Graphics, core: Rect): void {
  const { x, y, width, height } = core;

  graphics.clear();
  graphics.rect(x, y, width, height);
  graphics.stroke({ color: COLORS.frame, width: 1, alpha: 0.4 });

  for (const [cx, cy, sx, sy] of [
    [x, y, 1, 1],
    [x + width, y, -1, 1],
    [x, y + height, 1, -1],
    [x + width, y + height, -1, -1],
  ] as const) {
    graphics.moveTo(cx + CORNER_TICK * sx, cy);
    graphics.lineTo(cx, cy);
    graphics.lineTo(cx, cy + CORNER_TICK * sy);
  }
  graphics.stroke({ color: COLORS.frame, width: 2, alpha: 0.9 });
}
