/**
 * The accumulator behind the scope's acoustic layers.
 *
 * Pure, so it is tested without a canvas — which is most of why it is a separate file from the
 * Pixi layers that draw it. What matters here is the arithmetic that decides what the player
 * sees: that a chart only grows, that runs merge without wrapping a row, that a faint square
 * is dimmer than a strong one from the instant it appears, and that a stale contact does not
 * quietly look fresh again.
 */

import {
  packCells,
  quantizeExcess,
  VISION_CELL_SIZE,
  type MapExtents,
  type RevealedContact,
  type VisionFrame,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

import { cellIntensity, CELL_FADE_MS, SonarPicture } from '../src/render/picture.js';

/**
 * Small enough that a cell id is readable: 100 columns, so `row * 100 + col`.
 *
 * Sized in cells rather than metres on purpose. What is under test is the packing arithmetic,
 * which is about the grid and not about how wide a square happens to be, so retuning
 * `VISION_CELL_SIZE` must not turn these ids into a different picture.
 */
const EXTENTS: MapExtents = { width: 100 * VISION_CELL_SIZE, height: 50 * VISION_CELL_SIZE };

function frame(parts: Partial<VisionFrame> = {}): VisionFrame {
  return {
    charted: [],
    chartSeen: 0,
    cells: [],
    strength: [],
    dropped: 0,
    contacts: [],
    ...parts,
  };
}

function contact(parts: Partial<RevealedContact> = {}): RevealedContact {
  return {
    id: 1,
    hull: 'light',
    pos: { x: 10, y: 10 },
    facing: 0,
    seenTick: 20,
    live: true,
    ...parts,
  };
}

describe('SonarPicture', () => {
  it('merges consecutive charted squares in a row into one run', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ charted: packCells([200, 201, 202, 205]) }), 0);

    expect(picture.drainChart()).toEqual([
      { col: 0, row: 2, length: 3 },
      { col: 5, row: 2, length: 1 },
    ]);
    expect(picture.chartSize).toBe(4);
  });

  it('never merges across a row boundary, however consecutive the ids look', () => {
    // 99 is the last column of row 0 and 100 is the first of row 1. Their ids differ by one and
    // they are at opposite ends of the map; a run across them would draw a stripe through it.
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ charted: packCells([99, 100]) }), 0);

    expect(picture.drainChart()).toEqual([
      { col: 99, row: 0, length: 1 },
      { col: 0, row: 1, length: 1 },
    ]);
  });

  it('hands each charted run over exactly once', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ charted: packCells([10, 11]) }), 0);

    expect(picture.drainChart()).toHaveLength(1);
    // The chart layer is append-only: a run handed over twice would be tessellated twice and
    // stay on screen forever, which is invisible until the frame budget is gone.
    expect(picture.drainChart()).toEqual([]);
    expect(picture.isCharted(10)).toBe(true);
  });

  it('ignores a square it has already charted', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ charted: packCells([10]) }), 0);
    picture.drainChart();
    picture.apply(frame({ charted: packCells([10]) }), 100);

    expect(picture.drainChart()).toEqual([]);
    expect(picture.chartSize).toBe(1);
  });

  it('refreshes a square that is heard again rather than stacking a second one', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ cells: packCells([50]), strength: [quantizeExcess(4)] }), 0);
    picture.apply(frame({ cells: packCells([50]), strength: [quantizeExcess(9)] }), 500);

    expect(picture.litCells.size).toBe(1);
    expect(picture.litCells.get(50)?.excess).toBe(9);
    expect(picture.litCells.get(50)?.heardAt).toBe(500);
  });

  it('drops a transient square once it has finished fading', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ cells: packCells([50]), strength: [quantizeExcess(9)] }), 0);
    expect(picture.litCells.size).toBe(1);

    picture.expire(CELL_FADE_MS);
    expect(picture.litCells.size).toBe(0);
  });

  it('draws a faint return dimmer than a strong one at the same age', () => {
    // The band below the confirmation threshold is the skill window (planning/03 §5.3): the
    // player has to be able to see that a return is weak, or there is nothing to read.
    const faint = { cell: 1, excess: 1, heardAt: 0 };
    const strong = { cell: 2, excess: 8, heardAt: 0 };

    expect(cellIntensity(faint, 0, 8)).toBeLessThan(cellIntensity(strong, 0, 8));
    expect(cellIntensity(faint, 0, 8)).toBeGreaterThan(0);
    expect(cellIntensity(strong, CELL_FADE_MS, 8)).toBe(0);
  });

  it('restarts a contact’s fade only on a fresh measurement', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ contacts: [contact({ seenTick: 20 })] }), 0);
    expect(picture.contacts.get(1)?.heardAt).toBe(0);

    // Same measurement, later frame: the contact has not been heard again, so it must keep
    // ageing. Resetting here would make a stale contact look permanently fresh.
    picture.apply(frame({ contacts: [contact({ seenTick: 20 })] }), 900);
    expect(picture.contacts.get(1)?.heardAt).toBe(0);

    picture.apply(frame({ contacts: [contact({ seenTick: 40 })] }), 1_800);
    expect(picture.contacts.get(1)?.heardAt).toBe(1_800);
  });

  it('forgets a contact the server has stopped sending', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ contacts: [contact()] }), 0);
    picture.apply(frame(), 100);

    expect(picture.contacts.size).toBe(0);
  });

  it('keeps a slipped contact at the pose it was measured at', () => {
    const picture = new SonarPicture(EXTENTS);
    picture.apply(frame({ contacts: [contact({ pos: { x: 30, y: 20 } })] }), 0);
    picture.apply(frame({ contacts: [contact({ pos: { x: 30, y: 20 }, live: false })] }), 9_000);

    const held = picture.contacts.get(1);
    expect(held?.live).toBe(false);
    expect(held?.pos).toEqual({ x: 30, y: 20 });
  });
});
