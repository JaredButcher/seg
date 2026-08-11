/**
 * The track a weapon leaves behind it (`render/trails.ts`), and the icon it is drawn as
 * (`render/silhouette.ts#placeWeaponIcon`).
 *
 * Both are pure arithmetic over view-frame data, which is the reason they live where they do:
 * a trail is the one thing on the scope that accumulates state across frames, and state that can
 * only be checked by watching a match go past is state nobody checks.
 *
 * The `Graphics` a drawing call wants is stubbed. Nothing here is about Pixi — what is worth
 * asserting is which segments were queued, not what they were tessellated into.
 */
import type { TorpedoSnapshot } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import {
  contactMarkLength,
  friendlyWeaponLength,
  placeWeaponIcon,
} from '../src/render/silhouette.js';
import { drawTrails, TorpedoTrails, TRAIL_SAMPLE_M } from '../src/render/trails.js';

/** The subset of `Graphics` the trail layer touches, recording what it was told to draw. */
function recorder() {
  const segments: { from: [number, number]; to: [number, number] }[] = [];
  let pen: [number, number] = [0, 0];
  let strokes = 0;

  return {
    segments,
    get strokes() {
      return strokes;
    },
    clear() {
      segments.length = 0;
    },
    moveTo(x: number, y: number) {
      pen = [x, y];
    },
    lineTo(x: number, y: number) {
      segments.push({ from: pen, to: [x, y] });
      pen = [x, y];
    },
    stroke() {
      strokes += 1;
    },
  };
}

/** Only `id` and `pos` are read; the rest is here because the wire shape demands it. */
function shot(id: number, x: number, y = 0): TorpedoSnapshot {
  return {
    id,
    weapon: 'standard',
    firedBy: 1,
    pos: { x, y },
    facing: 0,
    speed: 22,
    phase: 'running',
    aim: { x: x + 500, y },
    lastPingTick: 0,
    transients: [],
  };
}

describe('TorpedoTrails', () => {
  it('opens a track the first time it sees a weapon', () => {
    const trails = new TorpedoTrails();
    trails.observe([shot(1, 0)]);
    expect(trails.size).toBe(1);
  });

  it('samples by distance, not by frame', () => {
    // A frame in which nothing moved far enough is a frame that costs nothing. Without this a
    // stationary weapon — or a fast one at a coarse zoom — would grow its array at 10 Hz forever.
    const trails = new TorpedoTrails();
    trails.observe([shot(1, 0)]);
    trails.observe([shot(1, TRAIL_SAMPLE_M - 1)]);
    expect([...trails.paths()]).toHaveLength(0);

    trails.observe([shot(1, TRAIL_SAMPLE_M + 1)]);
    expect([...trails.paths()][0]).toHaveLength(2);
  });

  it('forgets a weapon that has left the frames', () => {
    // Absence, not `spent`: a detonated weapon stays in the frames while its bang rings down, and
    // its track is the most informative thing on the screen for exactly those few seconds.
    const trails = new TorpedoTrails();
    trails.observe([shot(1, 0), shot(2, 0)]);
    trails.observe([shot(1, 100)]);

    expect(trails.size).toBe(1);
  });

  it('keeps a spent weapon’s track while it is still being reported', () => {
    const trails = new TorpedoTrails();
    trails.observe([shot(1, 0)]);
    trails.observe([{ ...shot(1, 100), phase: 'spent' }]);

    expect(trails.size).toBe(1);
    expect([...trails.paths()][0]).toHaveLength(2);
  });

  it('bumps its revision only when something changed', () => {
    // The renderer polls this to decide whether to rebuild a few hundred segments. A counter that
    // moved on every frame would make the guard useless.
    const trails = new TorpedoTrails();
    trails.observe([shot(1, 0)]);
    const settled = trails.revision;

    trails.observe([shot(1, 1)]);
    expect(trails.revision).toBe(settled);

    trails.observe([shot(1, 100)]);
    expect(trails.revision).toBeGreaterThan(settled);
  });

  it('drops everything on clear', () => {
    const trails = new TorpedoTrails();
    trails.observe([shot(1, 0)]);
    trails.clear();
    expect(trails.size).toBe(0);
  });
});

describe('drawTrails', () => {
  /** A straight run of `metres`, sampled the way a real weapon would produce it. */
  function run(trails: TorpedoTrails, metres: number): void {
    for (let x = 0; x <= metres; x += TRAIL_SAMPLE_M) trails.observe([shot(1, x)]);
  }

  it('draws nothing at all when there is nothing to draw', () => {
    const graphics = recorder();
    drawTrails(graphics as never, new TorpedoTrails(), 1);
    expect(graphics.segments).toHaveLength(0);
    expect(graphics.strokes).toBe(0);
  });

  it('draws nothing for a weapon that has not moved yet', () => {
    // One point is a position, not a path.
    const trails = new TorpedoTrails();
    trails.observe([shot(1, 0)]);

    const graphics = recorder();
    drawTrails(graphics as never, trails, 1);
    expect(graphics.strokes).toBe(0);
  });

  it('cuts the line into dashes rather than stroking it whole', () => {
    const trails = new TorpedoTrails();
    run(trails, 400);

    const graphics = recorder();
    drawTrails(graphics as never, trails, 1);

    expect(graphics.segments.length).toBeGreaterThan(10);
    // Every dash is shorter than the run it was cut out of, which is the whole claim.
    for (const { from, to } of graphics.segments) {
      expect(Math.abs(to[0] - from[0])).toBeLessThan(400);
    }
  });

  it('leaves gaps — the dashes do not add up to the whole path', () => {
    const trails = new TorpedoTrails();
    run(trails, 400);

    const graphics = recorder();
    drawTrails(graphics as never, trails, 1);

    const inked = graphics.segments.reduce(
      (sum, { from, to }) => sum + Math.abs(to[0] - from[0]),
      0,
    );
    expect(inked).toBeGreaterThan(0);
    expect(inked).toBeLessThan(400);
  });

  it('holds the dash count down as the camera pulls out', () => {
    // The dashes are sized in screen pixels, so a zoomed-out view cuts the same path into fewer,
    // longer pieces — which is what keeps a long match's worth of trails affordable.
    const trails = new TorpedoTrails();
    run(trails, 2000);

    const near = recorder();
    drawTrails(near as never, trails, 1);
    const far = recorder();
    drawTrails(far as never, trails, 0.05);

    expect(far.segments.length).toBeLessThan(near.segments.length);
  });

  it('never emits an unbounded number of segments for one track', () => {
    // The backstop for a very long run at the finest zoom, where the period would otherwise cut a
    // three-kilometre track into thousands of pieces almost all of which are off screen.
    //
    // The ceiling is `MAX_DASHES` plus one per sample point, not `MAX_DASHES` flat: a dash that
    // straddles a vertex is two lines, because a single one would cut the corner. 3 km at
    // `TRAIL_SAMPLE_M` is 375 points, so 400 + 375 is the honest bound.
    const trails = new TorpedoTrails();
    run(trails, 3000);

    const graphics = recorder();
    drawTrails(graphics as never, trails, 4);
    expect(graphics.segments.length).toBeLessThanOrEqual(775);
    // And well under what an unstretched period would have produced at this zoom.
    expect(graphics.segments.length).toBeLessThan(3000 / (9 / 4) / 2);
  });
});

describe('placeWeaponIcon', () => {
  const AT = { x: 1000, y: 500 };

  it('scales the unit outline to the length it is asked for', () => {
    // The polygon is authored at length 1 precisely so the caller picks the size. A change that
    // dropped the multiply would draw every weapon one metre long and nobody would see it.
    const small = placeWeaponIcon('standard', AT, 0, 10) ?? [];
    const large = placeWeaponIcon('standard', AT, 0, 40) ?? [];

    expect(small[0]?.x).toBeCloseTo(AT.x + 5);
    expect(large[0]?.x).toBeCloseTo(AT.x + 20);
  });

  it('mirrors a weapon running left instead of rolling it over', () => {
    // The drone's dome is on its back and has to stay there. Rotating through 180° would put it
    // on the keel, which is the bug this rule exists to prevent for hulls (`silhouette.ts`).
    const rightward = placeWeaponIcon('drone', AT, 0, 40) ?? [];
    const leftward = placeWeaponIcon('drone', AT, 180, 40) ?? [];

    const highest = (outline: readonly { x: number; y: number }[]) =>
      Math.max(...outline.map((point) => point.y));

    // World space is y-up, so the dome is the greatest y in both — nose pointing the other way.
    expect(highest(rightward)).toBeGreaterThan(AT.y);
    expect(highest(leftward)).toBeCloseTo(highest(rightward));
    expect(leftward[0]?.x).toBeCloseTo(AT.x - 20);
  });

  it('gives every deployable load an outline to draw', () => {
    for (const weapon of ['standard', 'super-cavitating', 'active-decoy', 'drone'] as const) {
      expect(placeWeaponIcon(weapon, AT, 0, 40)).not.toBeNull();
    }
  });
});

describe('how big a weapon is drawn', () => {
  /*
   * The zoom range in pixels per metre, from "a boat fills the screen" out to "the whole of a
   * large map is on screen" — about 3 px/m down to 0.03. The far end is the one that matters:
   * both lengths have a floor in screen pixels, so that is where a wrong constant inverts them.
   */
  const SCALES = [3, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.03, 0.01];

  it('always draws a hostile weapon larger than one of your own', () => {
    // The whole reason the two rules share a file. Only one of the two objects on screen can kill
    // the player, and it must never be the smaller mark.
    for (const scale of SCALES) {
      expect(contactMarkLength(scale)).toBeGreaterThan(friendlyWeaponLength(scale));
    }
  });

  it('holds a hostile mark at a fixed size in the water until the floor bites', () => {
    // A contact is a measurement. Growing it with the camera would claim precision the sonar does
    // not have, so the metre size is what it holds for as long as it can.
    expect(contactMarkLength(3)).toBe(40);
    expect(contactMarkLength(1)).toBe(40);
    expect(contactMarkLength(0.01)).toBeGreaterThan(40);
  });

  it('never lets a friendly weapon shrink below its true length', () => {
    // Honest about its size up close, a symbol as the camera pulls out.
    expect(friendlyWeaponLength(100)).toBe(7);
    expect(friendlyWeaponLength(0.1)).toBeGreaterThan(7);
  });
});
