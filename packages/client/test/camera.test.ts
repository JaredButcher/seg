/**
 * The scope camera: how the core viewport is carved out of the window, and the one rule that
 * matters — the map always covers that rectangle, so no input can steer the view off the map.
 *
 * All of it is pure, so none of it needs a canvas. The numbers below are chosen so the
 * arithmetic is checkable by hand: a 600 × 400 core at 0.5 px/m shows 1200 m × 800 m of water.
 */
import { describe, expect, it } from 'vitest';

import {
  CORE_INSETS,
  CORE_VIEW_HEIGHT_M,
  PAN_SPEED_VIEWS_PER_S,
  type Rect,
  clampCamera,
  coreViewport,
  endCamera,
  panByKeys,
  panByPixels,
  panDirection,
  placeWorld,
  scaleFor,
} from '../src/render/camera.js';

const CORE: Rect = { x: 100, y: 50, width: 600, height: 400 };
const SCALE = 0.5;
/** The base map: far wider than the core view, and taller than it too at this scale. */
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
    // The fixed insets want 332 px of a 200 px axis. Rather than a core of negative width —
    // which would divide the clamp by zero — both insets shrink together to a 40% share.
    const core = coreViewport({ width: 200, height: 100 });

    expect(core.width).toBeCloseTo(120);
    expect(core.height).toBeCloseTo(60);
    // Still in proportion to each other: the left edge keeps its 72:260 share of the squeeze.
    expect(core.x / (core.x + (200 - core.width - core.x))).toBeCloseTo(72 / 332);
  });

  it('survives a zero-sized element, which is what a mount measures before layout', () => {
    const core = coreViewport({ width: 0, height: 0 });

    expect(core.width).toBeGreaterThan(0);
    expect(core.height).toBeGreaterThan(0);
  });
});

describe('scaleFor', () => {
  it('shows the same world height whatever the window is', () => {
    expect(scaleFor(CORE) * CORE_VIEW_HEIGHT_M).toBeCloseTo(CORE.height);
    expect(scaleFor({ ...CORE, height: 1000 }) * CORE_VIEW_HEIGHT_M).toBeCloseTo(1000);
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

  it('crosses the map in the same time on any window, since the world span is fixed', () => {
    const held = new Set(['d']);
    const big = coreViewport({ width: 2560, height: 1440 });
    const small = coreViewport({ width: 1366, height: 768 });

    const onBig = panByKeys({ x: 2500, y: 600 }, held, 1, big, scaleFor(big));
    const onSmall = panByKeys({ x: 2500, y: 600 }, held, 1, small, scaleFor(small));

    expect(onBig.x).toBeCloseTo(onSmall.x);
    expect(onBig.x - 2500).toBeCloseTo(CORE_VIEW_HEIGHT_M);
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
