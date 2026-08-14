/**
 * The ping-reach rings as they are drawn (`render/reach.ts`).
 *
 * Pure, so it needs no canvas: the layer is handed in, which is what makes the drawing testable
 * at all. What is worth pinning is not the look but the three things a reader relies on without
 * knowing it — a reading that does not exist is *absent* rather than drawn at zero, whose
 * transducer it is decides the colour, and the dashes stay dashes at every zoom instead of closing
 * into a solid circle at one end of the range and vanishing at the other.
 */

import type { PingReachView } from '@seg/shared';
import type { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { COLORS } from '../src/render/palette.js';
import { drawReach } from '../src/render/reach.js';

interface Arc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly from: number;
  readonly to: number;
}

/** A `Graphics` that records instead of drawing, which is all this layer needs one for. */
class Recorder {
  readonly arcs: Arc[] = [];
  readonly moves: number[] = [];
  readonly strokes: { color: number; alpha: number }[] = [];
  cleared = 0;

  clear(): this {
    this.cleared += 1;
    return this;
  }
  moveTo(x: number, y: number): this {
    this.moves.push(x, y);
    return this;
  }
  arc(x: number, y: number, radius: number, from: number, to: number): this {
    this.arcs.push({ x, y, radius, from, to });
    return this;
  }
  stroke(style: { color: number; alpha: number }): this {
    this.strokes.push({ color: style.color, alpha: style.alpha });
    return this;
  }

  /** The distinct radii drawn, in the order they first appeared. */
  get radii(): number[] {
    return [...new Set(this.arcs.map((arc) => arc.radius))];
  }
}

function draw(rings: readonly PingReachView[], scale = 0.2, viewer: 'team1' | null = 'team1') {
  const recorder = new Recorder();
  drawReach(recorder as unknown as Graphics, rings, scale, viewer);
  return recorder;
}

const BOAT: PingReachView = {
  id: 3,
  team: 'team1',
  pos: { x: 500, y: 400 },
  imaging: 300,
  heard: 2400,
};

describe('drawing the rings', () => {
  it('draws both circles for a platform that has both', () => {
    const drawn = draw([BOAT]);

    expect(drawn.cleared).toBe(1);
    expect(drawn.radii).toEqual([300, 2400]);
    // One stroke per circle: they carry different alphas, which is what tells them apart.
    expect(drawn.strokes).toHaveLength(2);
    expect(drawn.strokes[0]?.alpha).toBeGreaterThan(drawn.strokes[1]?.alpha ?? 1);
  });

  it('draws only the outer circle for a transducer that hears nothing back', () => {
    // `null` is "there is no such reading", where zero is "the reading is nothing" — a pulse whose
    // echo cannot clear its own receiver. Both draw one circle; only one of them is a measurement.
    const drawn = draw([{ ...BOAT, imaging: null }]);

    expect(drawn.radii).toEqual([2400]);
    expect(drawn.strokes).toHaveLength(1);
  });

  it('draws nothing at all for a pulse nobody would hear and nothing would show', () => {
    const drawn = draw([{ ...BOAT, imaging: 0, heard: 0 }]);

    expect(drawn.arcs).toEqual([]);
    // Still cleared, so the last frame's rings are not left on the water.
    expect(drawn.cleared).toBe(1);
  });

  it('colours a transducer by whose it is', () => {
    const rings = [BOAT, { ...BOAT, id: 8, team: 'team2' as const, imaging: null }];

    expect(draw(rings).strokes.map((stroke) => stroke.color)).toEqual([
      COLORS.own,
      COLORS.own,
      COLORS.hostile,
    ]);
    // A spectator has no side, so "whose is it" is a question these are not there to answer.
    expect(draw(rings, 0.2, null).strokes.every((stroke) => stroke.color === COLORS.ally)).toBe(
      true,
    );
  });
});

describe('the dashes', () => {
  it('leaves a gap between every pair, and opens each one’s own sub-path', () => {
    const drawn = draw([{ ...BOAT, imaging: null }]);
    const arcs = drawn.arcs;

    expect(arcs.length).toBeGreaterThan(2);
    // A `moveTo` per arc. Without it the path cursor drags a line from the previous dash and
    // quietly fills in every gap, which is the one way this could silently become a solid circle.
    expect(drawn.moves).toHaveLength(arcs.length * 2);

    const step = (2 * Math.PI) / arcs.length;
    for (const arc of arcs) expect(arc.to - arc.from).toBeLessThan(step);
  });

  it('cuts more dashes into the same circle as the scope pulls in', () => {
    // The pattern is a screen length, so a ring the player has zoomed into is cut into more, not
    // longer, dashes — otherwise it closes into a solid line at one end of the zoom range.
    const far = draw([{ ...BOAT, imaging: null }], 0.05).arcs.length;
    const near = draw([{ ...BOAT, imaging: null }], 0.4).arcs.length;

    expect(near).toBeGreaterThan(far);
  });

  it('stays between its two caps, however big or small the circle is', () => {
    const huge = draw([{ ...BOAT, imaging: null, heard: 4000 }], 2).arcs.length;
    const tiny = draw([{ ...BOAT, imaging: null, heard: 5 }], 0.01).arcs.length;

    // A cap on work at one end, and a circle that is still a circle at the other.
    expect(huge).toBeLessThanOrEqual(180);
    expect(tiny).toBeGreaterThanOrEqual(12);
  });
});
