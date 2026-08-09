/**
 * Which boat a click on the scope picks (`render/pick.ts`).
 *
 * Pure, so none of it needs a canvas: the hit test is arithmetic over the same silhouette the
 * renderer draws, and the point of putting it in its own file was to be able to check it here
 * rather than by eye against a live match.
 *
 * The Light's outline is about 70 m long and 10 m tall, centred on the boat's position
 * (`content/hulls.ts`), which is where the offsets below come from.
 */
import { describe, expect, it } from 'vitest';

import { boatAt, type PickableBoat } from '../src/render/pick.js';
import { silhouetteHit } from '../src/render/silhouette.js';

const AT = { x: 1000, y: 500 };

function boat(overrides: Partial<PickableBoat> = {}): PickableBoat {
  return {
    id: 1,
    hull: 'light',
    pos: AT,
    facing: 0,
    status: 'active',
    mine: true,
    ...overrides,
  };
}

/** A point offset from the boat under test, in metres. */
function near(dx: number, dy: number) {
  return { x: AT.x + dx, y: AT.y + dy };
}

describe('silhouetteHit', () => {
  it('takes a click on the hull itself', () => {
    expect(silhouetteHit('light', AT, 0, AT, 0)).toBe(true);
    // Along the hull but inside it: 20 m forward of the middle is still boat.
    expect(silhouetteHit('light', AT, 0, near(20, 0), 0)).toBe(true);
  });

  it('takes one within the tolerance of the outline, and no further', () => {
    // 8 m above a hull whose deck is 4.9 m up: about 3 m of water between click and steel.
    expect(silhouetteHit('light', AT, 0, near(0, 8), 0)).toBe(false);
    expect(silhouetteHit('light', AT, 0, near(0, 8), 8)).toBe(true);
    expect(silhouetteHit('light', AT, 0, near(0, 40), 8)).toBe(false);
  });

  it('turns with the boat, because it is the drawn outline', () => {
    // 30 m ahead is hull while the boat is level, and open water once it is nose-up: the bow
    // has swung ten metres off that line and taken the pick target with it.
    expect(silhouetteHit('light', AT, 0, near(30, 0), 1)).toBe(true);
    expect(silhouetteHit('light', AT, 20, near(30, 0), 1)).toBe(false);
  });
});

describe('boatAt', () => {
  it('finds the boat under the point, and nothing over open water', () => {
    const fleet = [boat()];
    expect(boatAt(fleet, AT, 8)?.id).toBe(1);
    expect(boatAt(fleet, near(0, 300), 8)).toBeNull();
  });

  it('leaves a teammate’s boat and a wreck alone', () => {
    expect(boatAt([boat({ mine: false })], AT, 8)).toBeNull();
    expect(boatAt([boat({ status: 'destroyed' })], AT, 8)).toBeNull();
  });

  it('picks the nearest of two boats sharing the water', () => {
    // Twenty metres apart is well inside a seventy-metre hull, so the click is on both.
    const fleet = [boat({ id: 1 }), boat({ id: 2, pos: near(20, 0) })];
    expect(boatAt(fleet, near(2, 0), 8)?.id).toBe(1);
    expect(boatAt(fleet, near(15, 0), 8)?.id).toBe(2);
  });

  it('picks nothing out of an empty fleet', () => {
    expect(boatAt([], AT, 8)).toBeNull();
  });
});
