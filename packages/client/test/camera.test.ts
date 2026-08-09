/**
 * The scope camera: how the core viewport is carved out of the window, how zoom is bounded,
 * and the one rule that matters — the map always covers that rectangle, so no input can steer
 * the view off the map.
 *
 * All of it is pure, so none of it needs a canvas. The numbers below are chosen so the
 * arithmetic is checkable by hand: a 600 × 400 core showing 800 m of height is 0.5 px/m, and
 * therefore 1200 m × 800 m of water.
 */
import { describe, expect, it } from 'vitest';

import {
  CORE_INSETS,
  DEFAULT_VIEW_HEIGHT_M,
  GRID_STEPS_M,
  MIN_GRID_SPACING_PX,
  MIN_VIEW_HEIGHT_M,
  PAN_SPEED_VIEWS_PER_S,
  ZOOM_PER_NOTCH,
  ZOOM_RATE_PER_S,
  type Rect,
  clampCamera,
  clampViewHeight,
  coreViewport,
  endCamera,
  gridStepFor,
  maxViewHeight,
  panByKeys,
  panByPixels,
  panDirection,
  placeWorld,
  scaleFor,
  screenToWorld,
  zoomAt,
  zoomFactorForKeys,
  zoomFactorForWheel,
} from '../src/render/camera.js';

const CORE: Rect = { x: 100, y: 50, width: 600, height: 400 };
const VIEW_HEIGHT = 800;
const SCALE = 0.5;
/** The base map: far wider than the core view, and taller than it too at this zoom. */
const MAP = { width: 5000, height: 1200 };

describe('coreViewport', () => {
  it('carves the HUD reservation out of the window', () => {
    const core = coreViewport({ width: 1600, height: 900 });

    expect(core).toEqual({
      x: CORE_INSETS.left,
      y: CORE_INSETS.top,
      width: 1600 - CORE_INSETS.left - CORE_INSETS.right,
      height: 900 - CORE_INSETS.top - CORE_INSETS.bottom,
    });
  });

  it('gives the picture back on a window too small to pay the reservation', () => {
    // The fixed insets want more horizontal room than a 200 px axis has. Rather than a core
    // of negative width — which would divide the clamp by zero — both insets shrink together
    // to a 40% share.
    const core = coreViewport({ width: 200, height: 100 });

    expect(core.width).toBeCloseTo(120);
    expect(core.height).toBeCloseTo(60);
    // Still in proportion to each other: the left edge keeps its share of the squeeze.
    expect(core.x / (core.x + (200 - core.width - core.x))).toBeCloseTo(
      CORE_INSETS.left / (CORE_INSETS.left + CORE_INSETS.right),
    );
  });

  it('survives a zero-sized element, which is what a mount measures before layout', () => {
    const core = coreViewport({ width: 0, height: 0 });

    expect(core.width).toBeGreaterThan(0);
    expect(core.height).toBeGreaterThan(0);
  });
});

describe('scaleFor', () => {
  it('shows the same world height whatever the window is', () => {
    expect(scaleFor(CORE, DEFAULT_VIEW_HEIGHT_M) * DEFAULT_VIEW_HEIGHT_M).toBeCloseTo(CORE.height);
    expect(scaleFor({ ...CORE, height: 1000 }, DEFAULT_VIEW_HEIGHT_M) * DEFAULT_VIEW_HEIGHT_M) //
      .toBeCloseTo(1000);
  });
});

describe('zoom bounds', () => {
  it('pulls back exactly far enough to hold the whole map, and no further', () => {
    const furthest = maxViewHeight(MAP, CORE);
    const scale = scaleFor(CORE, furthest);

    // Whole map inside the core viewport, with one axis touching. The map is 4:1 and the core
    // is 1.5:1, so width is what binds and the spare room is above and below (08 §3).
    expect(MAP.width * scale).toBeCloseTo(CORE.width);
    expect(MAP.height * scale).toBeLessThanOrEqual(CORE.height);
  });

  it('holds zoom between a boat filling the screen and the whole map on screen', () => {
    expect(clampViewHeight(1, MAP, CORE)).toBe(MIN_VIEW_HEIGHT_M);
    expect(clampViewHeight(999_999, MAP, CORE)).toBeCloseTo(maxViewHeight(MAP, CORE));
    expect(clampViewHeight(DEFAULT_VIEW_HEIGHT_M, MAP, CORE)).toBe(DEFAULT_VIEW_HEIGHT_M);
  });

  it('lets the map win when it is smaller than the closest zoom', () => {
    // Not reachable with today's map sizes, but the bounds must not cross over if one ever is:
    // seeing all of a tiny map beats refusing to zoom out to it.
    const tiny = { width: 200, height: 100 };

    expect(clampViewHeight(1, tiny, CORE)).toBeCloseTo(maxViewHeight(tiny, CORE));
  });

  it('keeps the zoomed-out view honest on any window, since fit is fit', () => {
    const wide = coreViewport({ width: 2560, height: 1440 });
    const scale = scaleFor(wide, maxViewHeight(MAP, wide));

    expect(MAP.width * scale).toBeLessThanOrEqual(wide.width + 1e-9);
    expect(MAP.height * scale).toBeLessThanOrEqual(wide.height + 1e-9);
  });
});

describe('clampCamera', () => {
  it('leaves a camera with slack on every side alone', () => {
    expect(clampCamera({ x: 2500, y: 600 }, MAP, CORE, SCALE)).toEqual({ x: 2500, y: 600 });
  });

  it('stops when the map edge reaches the core viewport, not the window edge', () => {
    // 600 px of core at 0.5 px/m is 1200 m wide, so the closest the centre gets to x = 0 is
    // half of that. Anything nearer would show void inside the readable rectangle.
    expect(clampCamera({ x: -9000, y: 600 }, MAP, CORE, SCALE).x).toBe(600);
    expect(clampCamera({ x: 9000, y: 600 }, MAP, CORE, SCALE).x).toBe(5000 - 600);
    expect(clampCamera({ x: 2500, y: -9000 }, MAP, CORE, SCALE).y).toBe(400);
    expect(clampCamera({ x: 2500, y: 9000 }, MAP, CORE, SCALE).y).toBe(1200 - 400);
  });

  it('centres an axis the map is too small to cover, splitting the shortfall', () => {
    // 800 m of map against 1200 m of view: no position covers the core, so the leftover is
    // shared rather than dumped on one edge.
    const small = { width: 800, height: 400 };

    expect(clampCamera({ x: 0, y: 0 }, small, CORE, SCALE)).toEqual({ x: 400, y: 200 });
    expect(clampCamera({ x: 9000, y: 9000 }, small, CORE, SCALE)).toEqual({ x: 400, y: 200 });
  });

  it('is idempotent, so passing every input through it costs nothing', () => {
    const once = clampCamera({ x: -9000, y: 9000 }, MAP, CORE, SCALE);

    expect(clampCamera(once, MAP, CORE, SCALE)).toEqual(once);
  });
});

describe('panByPixels', () => {
  it('drags the water with the pointer', () => {
    // Pointer right by 100 px: the water goes right, so the camera looks 200 m further left.
    expect(panByPixels({ x: 2500, y: 600 }, 100, 0, SCALE).x).toBe(2300);
  });

  it('flips y, because the map counts upward and the screen counts downward', () => {
    // Pointer down by 100 px pulls the water down, revealing what was above it: y grows.
    expect(panByPixels({ x: 2500, y: 600 }, 0, 100, SCALE).y).toBe(800);
  });
});

describe('panDirection', () => {
  it('reads WASD in the map frame, where w is up', () => {
    expect(panDirection(new Set(['w']))).toEqual({ x: 0, y: 1 });
    expect(panDirection(new Set(['s']))).toEqual({ x: 0, y: -1 });
    expect(panDirection(new Set(['a']))).toEqual({ x: -1, y: 0 });
    expect(panDirection(new Set(['d']))).toEqual({ x: 1, y: 0 });
  });

  it('normalizes a diagonal instead of letting it run 41% faster', () => {
    const diagonal = panDirection(new Set(['w', 'd']));

    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
  });

  it('cancels opposing keys and ignores keys it does not bind', () => {
    expect(panDirection(new Set(['a', 'd']))).toEqual({ x: 0, y: 0 });
    expect(panDirection(new Set(['q', 'shift']))).toEqual({ x: 0, y: 0 });
  });
});

describe('panByKeys', () => {
  it('pans one screenful of water per second', () => {
    // The core shows 800 m of height at this scale, so half a second is 400 m.
    const moved = panByKeys({ x: 2500, y: 600 }, new Set(['d']), 0.5, CORE, SCALE);

    expect(moved.x).toBeCloseTo(2500 + 800 * PAN_SPEED_VIEWS_PER_S * 0.5);
    expect(moved.y).toBe(600);
  });

  it('crosses the map in the same time on any window, at the same zoom', () => {
    const held = new Set(['d']);
    const big = coreViewport({ width: 2560, height: 1440 });
    const small = coreViewport({ width: 1366, height: 768 });

    const onBig = panByKeys({ x: 2500, y: 600 }, held, 1, big, scaleFor(big, VIEW_HEIGHT));
    const onSmall = panByKeys({ x: 2500, y: 600 }, held, 1, small, scaleFor(small, VIEW_HEIGHT));

    expect(onBig.x).toBeCloseTo(onSmall.x);
    expect(onBig.x - 2500).toBeCloseTo(VIEW_HEIGHT);
  });

  it('slows over the ground as the camera closes in, keeping the same speed on screen', () => {
    const close = scaleFor(CORE, VIEW_HEIGHT / 4);
    const moved = panByKeys({ x: 2500, y: 600 }, new Set(['d']), 1, CORE, close);

    expect(moved.x - 2500).toBeCloseTo(VIEW_HEIGHT / 4);
  });

  it('does nothing on an empty or cancelling key set', () => {
    const camera = { x: 2500, y: 600 };

    expect(panByKeys(camera, new Set(), 0.5, CORE, SCALE)).toEqual(camera);
    expect(panByKeys(camera, new Set(['w', 's']), 0.5, CORE, SCALE)).toEqual(camera);
  });
});

describe('endCamera', () => {
  it('jumps to the map ends, landing exactly where panning would have stopped', () => {
    const camera = { x: 2500, y: 700 };

    expect(endCamera(camera, MAP, 'left', CORE, SCALE)).toEqual({ x: 600, y: 700 });
    expect(endCamera(camera, MAP, 'right', CORE, SCALE)).toEqual({ x: 4400, y: 700 });
  });

  it('keeps the depth the player was reading', () => {
    expect(endCamera({ x: 2500, y: 450 }, MAP, 'left', CORE, SCALE).y).toBe(450);
  });
});

describe('screenToWorld', () => {
  it('inverts placeWorld, so the pixel under the cursor names a real position', () => {
    const camera = { x: 2500, y: 600 };
    const placement = placeWorld(camera, CORE, SCALE);
    const pixel = { x: 340, y: 120 };

    const world = screenToWorld(pixel, camera, CORE, SCALE);

    expect(placement.originX + world.x * SCALE).toBeCloseTo(pixel.x);
    expect(placement.originY - world.y * SCALE).toBeCloseTo(pixel.y);
  });
});

describe('zoomAt', () => {
  const VIEW = { camera: { x: 2500, y: 600 }, viewHeight: VIEW_HEIGHT };

  it('holds the water under the cursor still', () => {
    const anchor = { x: CORE.x + 40, y: CORE.y + 330 };
    const before = screenToWorld(anchor, VIEW.camera, CORE, SCALE);

    const zoomed = zoomAt(VIEW, 1.7, anchor, MAP, CORE);
    const after = screenToWorld(
      anchor,
      zoomed.camera,
      CORE,
      scaleFor(CORE, zoomed.viewHeight), //
    );

    expect(zoomed.viewHeight).toBeCloseTo(VIEW_HEIGHT / 1.7);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('zooms about the centre when there is no cursor to zoom about', () => {
    const zoomed = zoomAt(VIEW, 1.7, null, MAP, CORE);

    expect(zoomed.camera).toEqual(VIEW.camera);
    expect(zoomed.viewHeight).toBeCloseTo(VIEW_HEIGHT / 1.7);
  });

  it('is reversible: a notch in and a notch out is where you started', () => {
    const anchor = { x: CORE.x + 500, y: CORE.y + 90 };

    const there = zoomAt(VIEW, ZOOM_PER_NOTCH, anchor, MAP, CORE);
    const back = zoomAt(there, 1 / ZOOM_PER_NOTCH, anchor, MAP, CORE);

    expect(back.viewHeight).toBeCloseTo(VIEW.viewHeight);
    expect(back.camera.x).toBeCloseTo(VIEW.camera.x);
    expect(back.camera.y).toBeCloseTo(VIEW.camera.y);
  });

  it('stops at the limits, and does not drag the camera with a zoom that did not happen', () => {
    const anchor = { x: CORE.x + 10, y: CORE.y + 10 };
    const wideOpen = { camera: VIEW.camera, viewHeight: maxViewHeight(MAP, CORE) };

    // Already as far out as the map allows: another notch out is a no-op, not a sideways
    // shove toward the corner the cursor happens to be sitting in.
    expect(zoomAt(wideOpen, 1 / ZOOM_PER_NOTCH, anchor, MAP, CORE)).toEqual(wideOpen);

    const closest = zoomAt({ camera: VIEW.camera, viewHeight: MIN_VIEW_HEIGHT_M }, 4, anchor, MAP, CORE); // prettier-ignore
    expect(closest.viewHeight).toBe(MIN_VIEW_HEIGHT_M);
  });

  it('clips a partly-allowed zoom to the limit rather than overshooting it', () => {
    const nearlyOut = { camera: VIEW.camera, viewHeight: maxViewHeight(MAP, CORE) * 0.9 };

    const zoomed = zoomAt(nearlyOut, 0.1, null, MAP, CORE);

    expect(zoomed.viewHeight).toBeCloseTo(maxViewHeight(MAP, CORE));
  });
});

describe('zoom input', () => {
  it('reads the arrows as hold-to-zoom, up for closer', () => {
    expect(zoomFactorForKeys(new Set(['arrowup']), 1)).toBeCloseTo(ZOOM_RATE_PER_S);
    expect(zoomFactorForKeys(new Set(['arrowdown']), 1)).toBeCloseTo(1 / ZOOM_RATE_PER_S);
    expect(zoomFactorForKeys(new Set(['arrowup']), 0.5)).toBeCloseTo(Math.sqrt(ZOOM_RATE_PER_S));
  });

  it('does nothing for no keys, other keys, or both arrows at once', () => {
    expect(zoomFactorForKeys(new Set(), 1)).toBe(1);
    expect(zoomFactorForKeys(new Set(['w', 'd']), 1)).toBe(1);
    expect(zoomFactorForKeys(new Set(['arrowup', 'arrowdown']), 1)).toBe(1);
  });

  it('reads a wheel notch as one step, away from the player being closer in', () => {
    expect(zoomFactorForWheel(-100, 0)).toBeCloseTo(ZOOM_PER_NOTCH);
    expect(zoomFactorForWheel(100, 0)).toBeCloseTo(1 / ZOOM_PER_NOTCH);
    expect(zoomFactorForWheel(0, 0)).toBe(1);
  });

  it('normalizes the delta modes, so Firefox does not zoom in slow motion', () => {
    // Same gesture reported three ways: 100 pixels, 3 lines, 1 page.
    expect(zoomFactorForWheel(-3, 1)).toBeCloseTo(zoomFactorForWheel(-100, 0));
    expect(zoomFactorForWheel(-1, 2)).toBeCloseTo(zoomFactorForWheel(-100, 0));
  });
});

describe('placeWorld', () => {
  it('puts the camera at the centre of the core viewport, not the centre of the window', () => {
    const placement = placeWorld({ x: 1000, y: 600 }, CORE, SCALE);

    // The world container is scaled (s, -s), so screen = origin + (x·s, -y·s).
    expect(placement.originX + 1000 * SCALE).toBeCloseTo(CORE.x + CORE.width / 2);
    expect(placement.originY - 600 * SCALE).toBeCloseTo(CORE.y + CORE.height / 2);
  });

  it('places the seabed below the surface on screen', () => {
    const placement = placeWorld({ x: 1000, y: 600 }, CORE, SCALE);
    const screenY = (worldY: number) => placement.originY - worldY * placement.scale;

    // y = 0 is the seabed edge of the frame (map/sizes.ts), so it sits lower down the screen.
    expect(screenY(0)).toBeGreaterThan(screenY(MAP.height));
  });
});

describe('the distance grid', () => {
  it('offers the four intervals the scale bar can read out, in order', () => {
    expect(GRID_STEPS_M).toEqual([100, 200, 500, 1000]);
  });

  it('picks the finest interval that is still legible', () => {
    // Just over the threshold for 100 m, and just under it.
    expect(gridStepFor(MIN_GRID_SPACING_PX / 100 + 0.001)).toBe(100);
    expect(gridStepFor(MIN_GRID_SPACING_PX / 100 - 0.001)).toBe(200);
    expect(gridStepFor(MIN_GRID_SPACING_PX / 200)).toBe(200);
    expect(gridStepFor(MIN_GRID_SPACING_PX / 500)).toBe(500);
    expect(gridStepFor(MIN_GRID_SPACING_PX / 1000)).toBe(1000);
  });

  it('never draws lines closer together than the legibility floor', () => {
    // Every zoom from wide open to fully closed in, at a fine sweep. The only exception is
    // the coarse end, where there is nothing above 1000 m to escape to.
    for (let scale = 0.05; scale < 6; scale += 0.005) {
      const step = gridStepFor(scale);
      if (step === 1000) continue;
      expect(step * scale).toBeGreaterThanOrEqual(MIN_GRID_SPACING_PX);
    }
  });

  it('is monotone in the zoom, so the interval cannot flicker while the wheel turns', () => {
    // Zooming in may only ever move *down* the ladder. A non-monotone rule would step back
    // and forth across a threshold as the zoom crept over it.
    let previous = gridStepFor(0.05);
    for (let scale = 0.05; scale < 6; scale += 0.005) {
      const step = gridStepFor(scale);
      expect(step).toBeLessThanOrEqual(previous);
      previous = step;
    }
  });

  it('holds the coarsest interval it has when even that is tight', () => {
    expect(gridStepFor(0.0001)).toBe(1000);
  });

  it('opens the default zoom on the finest interval', () => {
    // A player who has touched nothing sees a 100 m grid, which is the scale a hull and a
    // passage are measured in.
    const core = coreViewport({ width: 1920, height: 1080 });
    expect(gridStepFor(scaleFor(core, DEFAULT_VIEW_HEIGHT_M))).toBe(100);
  });

  it('coarsens as the map is pulled fully into view', () => {
    const core = coreViewport({ width: 1920, height: 1080 });
    const out = gridStepFor(scaleFor(core, maxViewHeight(MAP, core)));
    const inClose = gridStepFor(scaleFor(core, MIN_VIEW_HEIGHT_M));

    expect(out).toBeGreaterThan(inClose);
    expect(inClose).toBe(100);
  });
});
