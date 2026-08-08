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

import {
  getHull,
  type BoatStatus,
  type GeneratedMap,
  type HullId,
  type MapExtents,
  type Vec2,
} from '@seg/shared';
import { Application, Container, Graphics, Text } from 'pixi.js';
import { useEffect, useRef, type MutableRefObject } from 'react';

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
  gridStepFor,
  panByKeys,
  panByPixels,
  placeWorld,
  scaleFor,
  zoomAt,
  zoomFactorForKeys,
  zoomFactorForWheel,
} from './camera.js';

/** Length of the core viewport's corner ticks, CSS pixels. */
const CORNER_TICK = 18;
/** How far the scale bar sits in from the core viewport's bottom-right corner, CSS pixels. */
const SCALE_BAR_MARGIN = 28;
/** Height of the scale bar's end ticks, CSS pixels. */
const SCALE_BAR_TICK = 7;

/** The 09 §4 palette, as Pixi numbers — mirrors the CSS tokens in styles.css. */
const COLORS = {
  background: 0x04070a,
  water: 0x0a1a22,
  frame: 0x164a55,
  grid: 0x0e2a33,
  label: 0x4e8a94,
  rockFill: 0x0a1418,
  // `terrain`, the sonar-sensed edge. There is no sensing yet, so every wall is drawn at full
  // crispness; once contacts and returns exist this splits against `terrain-charted` (09 §4).
  rockEdge: 0x1b4650,
  // Own forces (09 §4). Yours reads at full strength; a teammate's is present but quieter,
  // so a glance at the scope answers "which of these am I steering" without a legend.
  own: 0x3bf0c4,
  ally: 0x2b8f95,
  lost: 0x40474a,
} as const;

/** One friendly boat as the scope needs it: where it is, which way, and whose it is. */
export interface ScopeBoat {
  readonly id: number;
  readonly hull: HullId;
  readonly pos: Vec2;
  readonly facing: number;
  readonly status: BoatStatus;
  /** Commanded by this player, rather than by a teammate. */
  readonly mine: boolean;
}

/**
 * How the scope reads the fleet.
 *
 * A pair of getters rather than a prop, because a view frame must not trigger a React render
 * of anything on the hot path (planning/08 §1). The renderer polls `revision` from its own
 * ticker and only rebuilds the boat layer when it moves.
 */
export interface ScopeFleet {
  revision(): number;
  boats(): readonly ScopeBoat[];
}

/** What the HUD can ask of the camera. Populated while the scope is mounted. */
export interface ScopeControls {
  /** Centre on a world point, clamped like any other camera move. */
  lookAt(point: Vec2): void;
}

interface ScopeHostProps {
  readonly map: GeneratedMap;
  /**
   * Whether the camera answers to the keyboard and the mouse. False while a modal owns the
   * screen: the Esc window is not a pause, but panning the scope from behind it is not what
   * a player pressing `S` for "settings" meant.
   */
  readonly inputEnabled?: boolean;
  readonly fleet?: ScopeFleet;
  /** Filled with the camera handle on mount, cleared on unmount. */
  readonly controls?: MutableRefObject<ScopeControls | null>;
}

export function ScopeHost({ map, inputEnabled = true, fleet, controls }: ScopeHostProps) {
  const mount = useRef<HTMLDivElement | null>(null);
  // Held keys, the input gate, and the fleet source live outside the Pixi effect: they change
  // far more often than the map does, and rebuilding the scene to learn that a menu opened —
  // or that a boat moved — would be absurd.
  const held = useRef<Set<string>>(new Set());
  const enabled = useRef(inputEnabled);
  const source = useRef<ScopeFleet | undefined>(fleet);

  useEffect(() => {
    enabled.current = inputEnabled;
    // A key still down when the menu opened would otherwise pan forever: its keyup lands on a
    // gate that ignores it, and nothing else ever clears it.
    if (!inputEnabled) held.current.clear();
  }, [inputEnabled]);

  useEffect(() => {
    source.current = fleet;
  }, [fleet]);

  useEffect(() => {
    const host = mount.current;
    if (host === null) return;
    const el: HTMLElement = host;

    let disposed = false;
    let app: Application | null = null;
    let world: Container | null = null;
    let frame: Graphics | null = null;
    let grid: Graphics | null = null;
    let bar: Graphics | null = null;
    let barLabel: Text | null = null;
    let boats: Graphics | null = null;
    /** The fleet revision the boat layer was last drawn at. `-1` forces a first draw. */
    let drawnAt = -1;
    /** The zoom the grid was last drawn at. Its line width is in metres, so it is zoom-bound. */
    let gridScale = 0;

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
     * Redraw the distance grid and its scale bar for the current zoom.
     *
     * The grid itself is in world space, so panning moves it with the water for free and this
     * is only needed when the *zoom* changes — but it is needed on every zoom frame, not only
     * when the interval steps, because the line width is in metres and has to be divided back
     * out to stay a hairline on screen. The bar is screen space and cheap, so it is simply
     * redrawn alongside.
     */
    function refreshGrid(): void {
      const step = gridStepFor(scale);
      if (grid !== null && scale !== gridScale) {
        gridScale = scale;
        drawGrid(grid, map.extents, step, scale);
      }
      if (bar !== null && barLabel !== null) drawScaleBar(bar, barLabel, core, step, scale);
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
      refreshGrid();
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
      // The distance grid sits over the terrain rather than under it. Under would be tidier —
      // rock is meant to read as a solid silhouette (09 §2) — but on a dense map most of the
      // picture is rock, and a grid that broke into fragments wherever it met a wall would be
      // useless for the one thing it is for: tracing a distance across the picture.
      grid = new Graphics();
      world.addChild(grid);
      // Own forces on top of both, still in the world container so they pan and zoom with the
      // terrain rather than being re-placed every frame (08 §3, layer 4).
      boats = new Graphics();
      world.addChild(boats);
      fresh.stage.addChild(world);

      // The core viewport's frame and the scale bar are drawn in screen space, on top of the
      // water — they are the instrument housing, not part of the world (08 §3).
      frame = new Graphics();
      bar = new Graphics();
      barLabel = new Text({
        text: '',
        style: {
          // The CSS stack from styles.css, so the instrument and the HUD are set in one face.
          fontFamily: 'ui-monospace, "JetBrains Mono", "IBM Plex Mono", monospace',
          fontSize: 11,
          fill: COLORS.label,
          letterSpacing: 1.6,
        },
      });
      fresh.stage.addChild(frame);
      fresh.stage.addChild(bar);
      fresh.stage.addChild(barLabel);

      fresh.ticker.add((ticker) => {
        // Polled, not subscribed: a 10 Hz view frame must not re-render React on the hot
        // path (08 §1), so the store bumps a counter and the renderer reads it from here.
        const revision = source.current?.revision() ?? 0;
        if (revision !== drawnAt && boats !== null) {
          drawnAt = revision;
          drawFleet(boats, source.current?.boats() ?? []);
        }

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

    // The camera handle the HUD steers with: a mini-map click and a fleet-list row both mean
    // "look here" (08 §11). Exposed as a ref rather than a prop callback so pressing it
    // cannot re-render the tree that owns the canvas.
    if (controls !== undefined) {
      controls.current = {
        lookAt: (point) => moveTo(point),
      };
    }

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
      if (controls !== undefined) controls.current = null;
      if (app !== null) app.destroy(true);
    };
  }, [map, controls]);

  return <div ref={mount} className="scope-host" aria-hidden="true" />;
}

/** The static world: water and rock — built once, shared by every frame. */
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

  world.addChild(water);
  world.addChild(rock);
  return world;
}

/**
 * The distance grid: a square mesh in map metres, redrawn per zoom.
 *
 * It replaces the fixed 200 m depth rules that were here. They were the same family of lines
 * measured differently — depth is linear in `y`, so a horizontal line every 100 m of `y` is
 * also one every `100 · depthScale` of depth — and having two overlapping horizontal families
 * at slightly different spacings on every map size but medium was noise. **The interval this
 * draws and the number on the scale bar are distances, not depths**; labelled depths belong to
 * the depth scale up the left edge, which is still to come (planning/08 §3, layer 2).
 *
 * Drawn across the whole map rather than only the visible part: even 100 m on a large map is
 * about 93 segments, which is cheaper to emit than it would be to cull, and it means panning
 * needs no redraw at all.
 */
function drawGrid(graphics: Graphics, extents: MapExtents, step: number, scale: number): void {
  graphics.clear();

  for (let x = step; x < extents.width; x += step) {
    graphics.moveTo(x, 0);
    graphics.lineTo(x, extents.height);
  }
  for (let y = step; y < extents.height; y += step) {
    graphics.moveTo(0, y);
    graphics.lineTo(extents.width, y);
  }

  // The container is scaled by `scale`, so a one-pixel line on screen is `1 / scale` metres
  // wide here. Without this the grid would thicken by 17× across the zoom range.
  graphics.stroke({ color: COLORS.grid, width: 1 / scale, alpha: 0.7 });
}

/**
 * The scale bar, in the core viewport's bottom-right corner: one grid interval wide, labelled.
 *
 * A bar rather than a bare "1 px = 4 m" figure, because the question a player actually asks is
 * "how far apart are those two things", and a bar exactly one square wide answers it by being
 * held up against the grid. Its length therefore varies — between about 96 and 240 px as the
 * zoom moves within an interval, and wider than that only at maximum zoom-in, where 100 m is
 * the finest the ladder goes.
 */
function drawScaleBar(
  graphics: Graphics,
  label: Text,
  core: Rect,
  step: number,
  scale: number,
): void {
  const right = core.x + core.width - SCALE_BAR_MARGIN;
  const left = right - step * scale;
  const y = core.y + core.height - SCALE_BAR_MARGIN;

  graphics.clear();
  graphics.moveTo(left, y - SCALE_BAR_TICK);
  graphics.lineTo(left, y);
  graphics.lineTo(right, y);
  graphics.lineTo(right, y - SCALE_BAR_TICK);
  graphics.stroke({ color: COLORS.frame, width: 2, alpha: 0.9 });

  // Only on change: assigning to `text` re-rasterizes the glyphs, and this runs on every
  // camera move.
  const next = `${String(step)} M`;
  if (label.text !== next) label.text = next;
  label.anchor.set(1, 1);
  label.position.set(right, y - SCALE_BAR_TICK - 2);
}

/**
 * Own forces: each boat as its authored side profile, at true position and true pitch.
 *
 * The silhouette is the same polygon the fleet editor draws and the collision shape and
 * active-sonar ray target will be (planning/09 §11) — one asset, four jobs — so it is read
 * from the hull table rather than redrawn here. Two conversions are needed to place it:
 *
 * - **The y flip.** Silhouettes are authored in simulation coordinates with `+y` down
 *   (`content/hulls.ts`); the world container is y-up. Drawing one unflipped puts every
 *   conning tower on the keel.
 * - **A boat travelling left is mirrored, not rotated.** Its facing is in a band around 180°
 *   (planning/04 §5), and rotating the profile through that band would roll the boat upside
 *   down. Mirroring in x and then applying the pitch keeps the sail up, which is what a
 *   submarine does.
 */
function drawFleet(graphics: Graphics, boats: readonly ScopeBoat[]): void {
  graphics.clear();

  for (const boat of boats) {
    const { silhouette } = getHull(boat.hull);
    const [first, ...rest] = silhouette;
    if (first === undefined) continue;

    // `cos(facing) < 0` is the left-travelling band. Exactly ±90° cannot happen — the pitch
    // band is far narrower than that — so the boundary needs no special case.
    const rightward = Math.cos((boat.facing * Math.PI) / 180) >= 0;
    const radians = ((rightward ? boat.facing : boat.facing - 180) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const mirror = rightward ? 1 : -1;

    const place = ([vx, vy]: readonly [number, number]) => {
      const lx = vx * mirror;
      const ly = -vy;
      return { x: boat.pos.x + lx * cos - ly * sin, y: boat.pos.y + lx * sin + ly * cos };
    };

    const start = place(first);
    graphics.moveTo(start.x, start.y);
    for (const vertex of rest) {
      const point = place(vertex);
      graphics.lineTo(point.x, point.y);
    }
    graphics.closePath();

    const colour = boat.status === 'destroyed' ? COLORS.lost : boat.mine ? COLORS.own : COLORS.ally;
    // Filled at low alpha with a bright edge: a hull reads as a solid object without
    // out-glowing the sensor products that will sit on top of it (09 §2).
    graphics.fill({ color: colour, alpha: boat.status === 'destroyed' ? 0.25 : 0.35 });
    graphics.stroke({ color: colour, width: 2, alpha: boat.status === 'destroyed' ? 0.5 : 1 });
  }
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
