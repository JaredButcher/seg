/**
 * @seg/client/render/camera — where the scope is looking, and how far it is allowed to look.
 *
 * Pure and framework-free, the same as `fit.ts`: the camera rule is the kind of thing that is
 * miserable to debug through a canvas and trivial to pin down in a unit test.
 *
 * Two ideas carry the whole file.
 *
 * **The core viewport.** The scope is a full-window canvas and the HUD floats over it
 * (planning/08 §11), so the window and the *usable* picture are not the same rectangle. The
 * core viewport is the sub-rectangle no HUD element covers — the part of the water the player
 * can actually read. Everything about framing is expressed against it, not against the window.
 *
 * **The camera cannot see past the map.** The clamp is stated as a property of the core
 * viewport: the map always covers it completely, so a map edge can reach the core boundary but
 * never cross into it. Under fog of war a camera that can wander off the map is a camera that
 * shows the player nothing but void with no cue about which way is back — so the invariant is
 * enforced here rather than left to the input handlers, and every way of moving the camera
 * (drag, keys, jumps) ends in the same `clampCamera` call.
 *
 * The camera position is the world point sitting at the **centre of the core viewport**, in
 * metres. That is the anchor the clamp is easiest to reason about, and it is what "jump to
 * this contact" will mean later.
 */

import type { MapExtents } from '@seg/shared';

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

/** The world point at the centre of the core viewport, in map metres. */
export interface Camera {
  readonly x: number;
  readonly y: number;
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
  top: 64,
  /** The fleet list and the mini-map, which share the right column. */
  right: 260,
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
 * How much world height the core viewport shows, metres.
 *
 * Fixed in world units rather than derived from the window, so every player sees the same
 * slice of ocean whatever their monitor is — the same reason RTS cameras are specified this
 * way. Three quarters of the base map's 1200 m column: enough to read the depth picture at a
 * glance, short enough that there is always somewhere to pan. Zoom will make this a variable;
 * until then it is the one framing constant.
 */
export const CORE_VIEW_HEIGHT_M = 900;

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

/** WASD, by `KeyboardEvent.key` lowercased, as a direction in the map's y-up frame. */
export const PAN_KEYS: Readonly<Record<string, Camera>> = {
  w: { x: 0, y: 1 },
  a: { x: -1, y: 0 },
  s: { x: 0, y: -1 },
  d: { x: 1, y: 0 },
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

/** Pixels per metre, from the fixed world height the core viewport is defined to show. */
export function scaleFor(core: Rect): number {
  return core.height / CORE_VIEW_HEIGHT_M;
}

/**
 * Pull a camera back inside the map.
 *
 * On each axis independently: if the map is larger than the core viewport there is slack, and
 * the camera is held between the two extremes where the map edge sits exactly on the core
 * boundary. If the map is *smaller* than the core viewport on that axis it cannot cover it at
 * all — no position satisfies the invariant, so the camera centres on the map and the miss is
 * split evenly between both edges instead of piling up on one.
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
  // The visible world height, which is `CORE_VIEW_HEIGHT_M` until zoom makes it a variable.
  const metres = (core.height / scale) * PAN_SPEED_VIEWS_PER_S * seconds;
  return { x: camera.x + direction.x * metres, y: camera.y + direction.y * metres };
}

/**
 * The unit direction a set of held keys asks for. Opposite keys cancel, and a diagonal is
 * normalized — otherwise holding two keys pans 41% faster than holding one, which reads as
 * the camera speeding up for no reason the player can name.
 */
export function panDirection(held: ReadonlySet<string>): Camera {
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
