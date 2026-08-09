/**
 * @seg/client/render/camera — where the scope is looking, how close, and how far it is allowed
 * to look.
 *
 * Pure and framework-free, the same as `fit.ts`: the camera rule is the kind of thing that is
 * miserable to debug through a canvas and trivial to pin down in a unit test.
 *
 * Three ideas carry the whole file.
 *
 * **The core viewport.** The scope is a full-window canvas and the HUD floats over it
 * (planning/08 §11), so the window and the *usable* picture are not the same rectangle. The
 * core viewport is the sub-rectangle no HUD element covers — the part of the water the player
 * can actually read. Everything about framing is expressed against it, not against the window.
 *
 * **Zoom is a world span, not a pixel scale.** The view is stored as the height of water the
 * core viewport shows, in metres, and pixels per metre is derived from it. Storing the
 * derived number instead would hand a player with a larger monitor a wider picture, which in a
 * game about who can see what is not a cosmetic difference. This way every player at the same
 * zoom sees the same ocean, and a window resize keeps the framing rather than the pixel size.
 *
 * **The camera cannot see past the map.** The clamp is stated as a property of the core
 * viewport: the map always covers it completely, so a map edge can reach the core boundary but
 * never cross into it. Under fog of war a camera that can wander off the map is a camera that
 * shows the player nothing but void with no cue about which way is back — so the invariant is
 * enforced here rather than left to the input handlers, and every way of moving the camera
 * (drag, keys, jumps, zoom) ends in the same `clampCamera` call.
 *
 * The camera position is the world point sitting at the **centre of the core viewport**, in
 * metres. That is the anchor the clamp is easiest to reason about, and it is what "jump to
 * this contact" will mean later.
 */

import type { MapExtents } from '@seg/shared';

import { fitMap } from './fit.js';

/** A point in whichever frame the parameter names — world metres, or canvas CSS pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The world point at the centre of the core viewport, in map metres. */
export type Camera = Point;

/** A screen-space rectangle in CSS pixels, measured from the canvas's top-left corner. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How much of each window edge the HUD reserves, CSS pixels. */
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Everything about where the scope is pointed: the centre, and how much water fits around it. */
export interface View {
  readonly camera: Camera;
  /** Metres of world height the core viewport shows. Smaller is closer in. */
  readonly viewHeight: number;
}

/**
 * The HUD's claim on the window (planning/08 §11).
 *
 * Each number names the elements it holds space for, including ones not built yet — the
 * reservation has to be in place before the panels are, or every panel added later would
 * silently shrink the readable picture and move the camera limits with it. `ScopeHost` draws
 * the resulting rectangle as a thin frame, so what is reserved is visible rather than implied.
 */
export const CORE_INSETS: Insets = {
  /** Score, timer, and the range scale across the top. */
  top: 96,
  /**
   * The fleet list and the mini-map, which share the right column.
   *
   * Wide enough for a boat row to be read rather than decoded: a name, a class, a depth, a pitch,
   * four tube pips and three throttle notches per boat, at HUD type sizes. `.match__right` and
   * `MINIMAP_WIDTH` are the same number seen from the other two sides.
   */
  right: 384,
  /** Chat and the permanent control strip. */
  bottom: 96,
  /** The depth scale up the left edge. */
  left: 72,
};

/**
 * The most of one axis the HUD may eat. On a small window the fixed insets can add up to more
 * than the window itself; rather than collapse the core to nothing (and with it the clamp,
 * which divides by its size), the insets are scaled down together to fit this share. The HUD
 * will overlap the picture on a tiny window — that is the lesser failure.
 */
const MAX_INSET_SHARE = 0.4;

/**
 * The world height the scope opens on, **metres of Y** — about a quarter of the base map's
 * 4000 m field, which is a shade over 200 m of game depth on a medium map (`map/sizes.ts`).
 * Enough to read the depth picture at a glance, close enough that there is somewhere to pan.
 *
 * Y rather than depth, and the distinction is the whole reason this note exists: it used to
 * describe itself as three quarters of a "1200 m column", which was the game depth of the day
 * standing in for a Y extent it never equalled. The two are related by `depthScale` and by
 * nothing else, so a view height is not a depth and does not move when `MAP_DEPTH` does.
 */
export const DEFAULT_VIEW_HEIGHT_M = 900;

/**
 * Closest the camera may come, metres of world height.
 *
 * A hull is on the order of 100 m, so this is a boat filling something like a third of the
 * picture — past that the scope has stopped being a tactical display and become a diorama, and
 * the player has lost the context that makes the depth read useful.
 */
export const MIN_VIEW_HEIGHT_M = 250;

/**
 * Keyboard pan rate, **core viewports per second** — one screenful of water every second.
 *
 * Relative to what is on screen rather than to pixels or to metres, which is the only one of
 * the three that is both monitor-independent *and* survives zoom. In pixels per second, a
 * player on a larger monitor would cross the map slower (the world span is fixed, so their
 * pixels are worth fewer metres); in metres per second, a zoomed-in camera would feel like it
 * was sprinting. A fraction of the view per second is the same gesture at every size.
 */
export const PAN_SPEED_VIEWS_PER_S = 1;

/** Magnification per wheel notch. Multiplicative, so zooming is symmetric in and out. */
export const ZOOM_PER_NOTCH = 1.15;

/** Magnification per second with an arrow key held — a notch and a half a second. */
export const ZOOM_RATE_PER_S = 1.8;

/**
 * The intervals the distance grid steps between, metres.
 *
 * Round numbers a player can multiply in their head, and only four of them: a grid whose
 * spacing crept continuously with the zoom would be a ruler with no marks on it, because the
 * one thing it has to do is let you count squares between two things and get a distance.
 */
export const GRID_STEPS_M: readonly number[] = [100, 200, 500, 1000];

/**
 * How close two grid lines may sit on screen before the next interval up is used, CSS pixels.
 *
 * This is what makes the step change at all. Below roughly this spacing the grid stops being
 * legible and starts being hatching — and the ratios in the ladder are 2, 2.5, 2, so the
 * spacing after a change lands between 96 and 240 px rather than anywhere.
 */
export const MIN_GRID_SPACING_PX = 96;

/** WASD, by `KeyboardEvent.key` lowercased, as a direction in the map's y-up frame. */
export const PAN_KEYS: Readonly<Record<string, Point>> = {
  w: { x: 0, y: 1 },
  a: { x: -1, y: 0 },
  s: { x: 0, y: -1 },
  d: { x: 1, y: 0 },
};

/** The arrow keys that zoom, by `KeyboardEvent.key` lowercased. Up is closer in. */
export const ZOOM_KEYS: Readonly<Record<string, number>> = {
  arrowup: 1,
  arrowdown: -1,
};

/** The rectangle no HUD element covers, in canvas CSS pixels. */
export function coreViewport(
  viewport: { width: number; height: number },
  insets: Insets = CORE_INSETS,
): Rect {
  const width = Math.max(viewport.width, 1);
  const height = Math.max(viewport.height, 1);

  const [left, right] = fitInsets(width, insets.left, insets.right);
  const [top, bottom] = fitInsets(height, insets.top, insets.bottom);

  return { x: left, y: top, width: width - left - right, height: height - top - bottom };
}

/** Shrink a pair of opposing insets, in proportion, until they fit the axis budget. */
function fitInsets(size: number, near: number, far: number): readonly [number, number] {
  const total = near + far;
  const budget = size * MAX_INSET_SHARE;
  if (total <= budget) return [near, far];
  const shrink = budget / total;
  return [near * shrink, far * shrink];
}

/** Pixels per metre for a given zoom. The only place the two units are allowed to meet. */
export function scaleFor(core: Rect, viewHeight: number): number {
  return core.height / viewHeight;
}

/**
 * The grid interval to draw at a given zoom: the finest one that is still readable.
 *
 * Monotone in `scale` by construction — zooming in can only ever move down the ladder — which
 * is what stops the grid flickering between two intervals while the wheel is turning. At the
 * far end there is nothing coarser than the last entry, so a very wide window on a large map
 * simply keeps 1000 m and accepts the tighter spacing.
 */
export function gridStepFor(scale: number): number {
  for (const step of GRID_STEPS_M) {
    if (step * scale >= MIN_GRID_SPACING_PX) return step;
  }
  return GRID_STEPS_M.at(-1) ?? 1000;
}

/**
 * Furthest the camera may pull back: the zoom at which the whole map is inside the core
 * viewport, which is exactly `fitMap`'s question asked of the core rather than the window.
 *
 * The map is roughly 4:1 and the core is nearer 16:9, so on most windows this binds on width
 * and leaves dead space above the surface and below the seabed. That is the intended strategic
 * view (planning/08 §3): the alternative is vertical exaggeration, which would distort every
 * bearing on screen, and the instrument is supposed to fill that space anyway.
 */
export function maxViewHeight(extents: MapExtents, core: Rect): number {
  return core.height / fitMap(extents, core).scale;
}

/** Hold a zoom between "a boat fills the screen" and "the whole map is on screen". */
export function clampViewHeight(viewHeight: number, extents: MapExtents, core: Rect): number {
  const furthest = maxViewHeight(extents, core);
  // A map smaller than the closest zoom would invert the bounds; the map wins, since showing
  // all of it is the more useful of the two guarantees.
  const closest = Math.min(MIN_VIEW_HEIGHT_M, furthest);
  return Math.min(Math.max(viewHeight, closest), furthest);
}

/**
 * Pull a camera back inside the map.
 *
 * On each axis independently: if the map is larger than the core viewport there is slack, and
 * the camera is held between the two extremes where the map edge sits exactly on the core
 * boundary. If the map is *smaller* than the core viewport on that axis it cannot cover it at
 * all — no position satisfies the invariant, so the camera centres on the map and the miss is
 * split evenly between both edges instead of piling up on one. Zoomed fully out, that is both
 * axes at once, and the map sits centred in the frame.
 */
export function clampCamera(
  camera: Camera,
  extents: MapExtents,
  core: Rect,
  scale: number,
): Camera {
  return {
    x: clampAxis(camera.x, extents.width, core.width / scale),
    y: clampAxis(camera.y, extents.height, core.height / scale),
  };
}

function clampAxis(value: number, extent: number, visible: number): number {
  if (visible >= extent) return extent / 2;
  const half = visible / 2;
  return Math.min(Math.max(value, half), extent - half);
}

/** The world point under a canvas pixel. The y flip is the map's y-up frame meeting the screen. */
export function screenToWorld(point: Point, camera: Camera, core: Rect, scale: number): Point {
  return {
    x: camera.x + (point.x - (core.x + core.width / 2)) / scale,
    y: camera.y - (point.y - (core.y + core.height / 2)) / scale,
  };
}

/**
 * Drag: the world follows the pointer, so the camera moves against it. `dx`/`dy` are the
 * pointer's movement in screen pixels, and the y flip is where the map's y-up frame meets the
 * screen's y-down one — dragging the water downward looks further up the water column.
 */
export function panByPixels(camera: Camera, dx: number, dy: number, scale: number): Camera {
  return { x: camera.x - dx / scale, y: camera.y + dy / scale };
}

/**
 * Held keys: the camera moves, so the world slides the other way — the opposite sense to a
 * drag, and the one every game with a WASD camera uses.
 */
export function panByKeys(
  camera: Camera,
  held: ReadonlySet<string>,
  seconds: number,
  core: Rect,
  scale: number,
): Camera {
  const direction = panDirection(held);
  if (direction.x === 0 && direction.y === 0) return camera;
  const metres = (core.height / scale) * PAN_SPEED_VIEWS_PER_S * seconds;
  return { x: camera.x + direction.x * metres, y: camera.y + direction.y * metres };
}

/**
 * The unit direction a set of held keys asks for. Opposite keys cancel, and a diagonal is
 * normalized — otherwise holding two keys pans 41% faster than holding one, which reads as
 * the camera speeding up for no reason the player can name.
 */
export function panDirection(held: ReadonlySet<string>): Point {
  let x = 0;
  let y = 0;
  for (const key of held) {
    const direction = PAN_KEYS[key];
    if (direction === undefined) continue;
    x += direction.x;
    y += direction.y;
  }
  const length = Math.hypot(x, y);
  return length > 1 ? { x: x / length, y: y / length } : { x, y };
}

/**
 * Home and End: jump to one end of the map horizontally, keeping the depth you were reading.
 * Expressed as "aim past the end and let the clamp stop you", so the ends are by construction
 * the same positions panning can reach and the jump can never overshoot into the void.
 */
export function endCamera(
  camera: Camera,
  extents: MapExtents,
  side: 'left' | 'right',
  core: Rect,
  scale: number,
): Camera {
  return clampCamera({ x: side === 'left' ? 0 : extents.width, y: camera.y }, extents, core, scale);
}

/**
 * Change zoom by a magnification factor — above 1 moves closer in.
 *
 * `anchor` is the canvas pixel to keep still. Given one, the world point under it does not
 * move, which is what makes wheel zoom feel like the picture is being pulled toward the cursor
 * rather than jumping to the middle; the keyboard passes `null` and zooms about the centre of
 * the core viewport, because there is no cursor involved in pressing an arrow key.
 *
 * The zoom is clamped *before* the camera is solved, so a wheel notch that runs into a zoom
 * limit holds its anchor instead of drifting by the part of the zoom that never happened.
 * The returned camera is unclamped — the caller owns that, so there is one clamp, not two.
 */
export function zoomAt(
  view: View,
  factor: number,
  anchor: Point | null,
  extents: MapExtents,
  core: Rect,
): View {
  const viewHeight = clampViewHeight(view.viewHeight / factor, extents, core);
  if (viewHeight === view.viewHeight) return view;
  if (anchor === null) return { camera: view.camera, viewHeight };

  const before = scaleFor(core, view.viewHeight);
  const after = scaleFor(core, viewHeight);
  const world = screenToWorld(anchor, view.camera, core, before);

  return {
    camera: {
      x: world.x - (anchor.x - (core.x + core.width / 2)) / after,
      y: world.y + (anchor.y - (core.y + core.height / 2)) / after,
    },
    viewHeight,
  };
}

/** Held arrow keys, as a magnification factor for the time they were held. */
export function zoomFactorForKeys(held: ReadonlySet<string>, seconds: number): number {
  let direction = 0;
  for (const key of held) direction += ZOOM_KEYS[key] ?? 0;
  if (direction === 0) return 1;
  return ZOOM_RATE_PER_S ** (Math.sign(direction) * seconds);
}

/**
 * A wheel event, as a magnification factor. Scrolling away from you zooms in, the way every
 * map does it.
 *
 * `deltaMode` matters more than it looks: Firefox reports whole lines and some setups report
 * pages, so taking `deltaY` at face value makes one browser zoom in slow motion and another
 * jump the whole range in a notch.
 */
export function zoomFactorForWheel(deltaY: number, deltaMode: number): number {
  const perNotch = deltaMode === 1 ? 3 : deltaMode === 2 ? 1 : 100;
  return ZOOM_PER_NOTCH ** (-deltaY / perNotch);
}

/** Where a camera puts the map's origin on screen, and at what scale. */
export interface Placement {
  readonly scale: number;
  /** Screen x of the map's left edge (world x = 0). */
  readonly originX: number;
  /** Screen y of the map's seabed (world y = 0) — the y-up frame's zero, low on the screen. */
  readonly originY: number;
}

/**
 * Resolve a camera to a placement for the world container. The container is scaled
 * `(scale, -scale)` to flip y-up into screen space, so `originY` is where world y = 0 lands
 * and world y grows upward from it.
 */
export function placeWorld(camera: Camera, core: Rect, scale: number): Placement {
  return {
    scale,
    originX: core.x + core.width / 2 - camera.x * scale,
    originY: core.y + core.height / 2 + camera.y * scale,
  };
}
