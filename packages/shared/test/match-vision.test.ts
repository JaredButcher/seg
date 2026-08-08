/**
 * The team picture: the chart, the contacts, and the encoding that gets them onto the wire.
 *
 * The solver is tested elsewhere (`acoustics-vision`); what is tested here is everything that
 * happens to its output afterwards. That split matters because the two have opposite failure
 * modes — a bug in the solver draws the wrong walls, and a bug here hands a player a wall they
 * never heard, or quietly loses one they did.
 *
 * `TeamVision` is built by hand rather than solved for. A fixture that ran the acoustics would
 * be testing the acoustics again, and would make every assertion here hostage to a tuning
 * change in a table that is explicitly still being tuned.
 */

import {
  ACOUSTICS,
  ContactBook,
  chartOf,
  dequantizeExcess,
  packCells,
  quantizeExcess,
  TeamChart,
  TeamPicture,
  unpackCells,
  type AcousticTuning,
  type ContactSighting,
  type EntityId,
  type GeneratedMap,
  type TeamVision,
} from '@seg/shared';
import { generateMap } from '@seg/shared';
import { describe, expect, it } from 'vitest';

/** One team's solve, assembled by hand. `owners` is `-1` for rock. */
function vision(
  entries: readonly { readonly cell: number; readonly excess: number; readonly owner?: EntityId }[],
  dropped = 0,
): TeamVision {
  return {
    team: 'team1',
    cells: Int32Array.from(entries.map((e) => e.cell)),
    excess: Float32Array.from(entries.map((e) => e.excess)),
    owners: Int32Array.from(entries.map((e) => e.owner ?? -1)),
    dropped,
  };
}

const FOE: ContactSighting = { id: 7, hull: 'heavy', pos: { x: 12, y: 34 }, facing: 180 };

/** `look` that admits exactly one hostile boat and nothing else. */
const lookForFoe = (entity: EntityId): ContactSighting | undefined =>
  entity === FOE.id ? FOE : undefined;

function tuned(patch: Partial<AcousticTuning>): AcousticTuning {
  return { ...ACOUSTICS, ...patch };
}

describe('chartOf', () => {
  const map: GeneratedMap = generateMap('sparse', { seed: 4, mapSize: 'small' });

  it('keeps the frame and drops the rock for a player', () => {
    const chart = chartOf(map, false);

    expect(chart.terrain).toBeNull();
    expect(chart.extents).toEqual(map.extents);
    expect(chart.depthScale).toBe(map.depthScale);
    expect(chart.mapSize).toBe(map.mapSize);
  });

  it('carries ground truth to a spectator', () => {
    expect(chartOf(map, true).terrain).toEqual(map.terrain);
  });

  it('has no seed field at all, in either form', () => {
    // Not "the seed is undefined" — the key must not exist, because generation is pure and the
    // client bundles it, so a seed is the whole map (ADR 0002).
    for (const reveal of [true, false]) {
      expect('seed' in chartOf(map, reveal)).toBe(false);
    }
  });
});

describe('cell packing', () => {
  it('round-trips an ascending run', () => {
    const cells = [3, 4, 5, 900, 40_000_000];
    expect(unpackCells(packCells(cells))).toEqual(cells);
  });

  it('turns a wall into single-digit gaps', () => {
    // The whole reason the encoding exists: consecutive squares on a wall differ by one, and
    // ids run to forty million on a large map.
    expect(packCells([1_000_000, 1_000_001, 1_000_002])).toEqual([1_000_000, 1, 1]);
  });

  it('drops repeats rather than encoding a zero gap', () => {
    expect(unpackCells(packCells([7, 7, 8]))).toEqual([7, 8]);
  });

  it('stops at a malformed gap instead of inventing squares', () => {
    expect(unpackCells([10, 5, -1, 4])).toEqual([10, 15]);
  });
});

describe('excess quantization', () => {
  it('round-trips to half a decibel', () => {
    expect(dequantizeExcess(quantizeExcess(7.4))).toBeCloseTo(7.5);
    expect(dequantizeExcess(quantizeExcess(0))).toBe(0);
  });

  it('clamps rather than wrapping', () => {
    expect(quantizeExcess(-5)).toBe(0);
    expect(dequantizeExcess(quantizeExcess(10_000))).toBeLessThanOrEqual(127);
  });
});

describe('TeamChart', () => {
  it('records a square once and remembers the order', () => {
    const chart = new TeamChart();

    expect(chart.add(5)).toBe(true);
    expect(chart.add(5)).toBe(false);
    chart.add(2);

    expect(chart.size).toBe(2);
    expect(chart.since(0, 10)).toEqual([5, 2]);
  });

  it('hands a recipient only what they are still owed, capped', () => {
    const chart = new TeamChart();
    for (const cell of [1, 2, 3, 4, 5]) chart.add(cell);

    expect(chart.since(2, 2)).toEqual([3, 4]);
    expect(chart.since(5, 10)).toEqual([]);
    // A watermark past the end is a bug elsewhere, and clamping is the only safe reading of it.
    expect(chart.since(99, 10)).toEqual([]);
  });
});

describe('ContactBook', () => {
  it('mints an id and keeps it while the same boat is re-confirmed', () => {
    const book = new ContactBook();
    const first = book.confirm(FOE, 20, 1);
    const again = book.confirm({ ...FOE, pos: { x: 90, y: 90 } }, 40, 2);

    expect(again).toBe(first);
    expect(book.snapshot(2)).toHaveLength(1);
    expect(book.snapshot(2)[0]?.pos).toEqual({ x: 90, y: 90 });
  });

  it('stops being live once the fade window has passed, without being deleted', () => {
    const book = new ContactBook();
    book.confirm(FOE, 20, 1);

    expect(book.snapshot(1 + ACOUSTICS.contactFadeSeconds - 0.1)[0]?.live).toBe(true);
    const stale = book.snapshot(1 + ACOUSTICS.contactFadeSeconds + 0.1)[0];
    expect(stale?.live).toBe(false);
    // Frozen at the measurement. A marker that crept would be the client being told a lie.
    expect(stale?.pos).toEqual(FOE.pos);
    expect(stale?.seenTick).toBe(20);
  });

  it('mints a new id when a boat is re-acquired after its marker expired', () => {
    // Track splitting (planning/03 §7). The book does not know it is the same boat, and the
    // player deciding whether it is is the mechanic.
    const book = new ContactBook(tuned({ contactFadeSeconds: 1, contactHoldSeconds: 1 }));
    const first = book.confirm(FOE, 20, 0);

    expect(book.snapshot(10)).toEqual([]);
    expect(book.confirm(FOE, 400, 10)).not.toBe(first);
  });

  it('orders its snapshot by contact id, not by map iteration', () => {
    const book = new ContactBook();
    book.confirm({ ...FOE, id: 9 }, 20, 1);
    book.confirm({ ...FOE, id: 3 }, 20, 1);
    book.confirm({ ...FOE, id: 5 }, 20, 1);

    const ids = book.snapshot(1).map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('TeamPicture', () => {
  const confirm = ACOUSTICS.confirmationThreshold;

  it('charts a square that clears confirmation and not one that does not', () => {
    const picture = new TeamPicture();
    picture.observe(
      vision([
        { cell: 10, excess: confirm + 1 },
        { cell: 20, excess: confirm - 1 },
      ]),
      2,
      0.1,
      lookForFoe,
    );

    expect(picture.chart.has(10)).toBe(true);
    expect(picture.chart.has(20)).toBe(false);
  });

  it('still sends a square as a transient on the frame it confirms', () => {
    // This is what makes a square appear to flash green and settle onto the wall arriving
    // underneath it. Suppressing it here would make confirmed rock pop in with no transition.
    const picture = new TeamPicture();
    picture.observe(vision([{ cell: 10, excess: confirm + 1 }]), 2, 0.1, lookForFoe);

    expect(unpackCells(picture.frameFor(0).cells)).toEqual([10]);
  });

  it('stops sending it on the frames after', () => {
    const picture = new TeamPicture();
    picture.observe(vision([{ cell: 10, excess: confirm + 1 }]), 2, 0.1, lookForFoe);
    picture.observe(vision([{ cell: 10, excess: confirm + 1 }]), 4, 0.2, lookForFoe);

    expect(unpackCells(picture.frameFor(1).cells)).toEqual([]);
  });

  it('never charts a square that sits on a hull, however loud', () => {
    // Boats move. A confirmed hull square charted as terrain would leave a permanent wall in
    // the shape of a submarine at the place it happened to be standing.
    const picture = new TeamPicture();
    picture.observe(vision([{ cell: 10, excess: 90, owner: FOE.id }]), 2, 0.1, lookForFoe);

    expect(picture.chart.size).toBe(0);
    expect(picture.contacts.size).toBe(1);
  });

  it('drops squares on a hull the team may not learn from', () => {
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([
        { cell: 10, excess: 90, owner: 99 },
        { cell: 11, excess: 1 },
      ]),
      2,
      0.1,
      lookForFoe,
    );

    // Own and allied hulls come back from `look` as nothing at all, so their squares neither
    // confirm nor transmit — a shimmer over your own fleet would be noise, not information.
    expect(snapshot.cells).toEqual([11]);
    expect(snapshot.contacts).toEqual([]);
  });

  it('keeps the brightest squares when there are more than the wire allows', () => {
    const picture = new TeamPicture(tuned({ maxWireVisionCells: 2 }));
    const snapshot = picture.observe(
      vision([
        { cell: 1, excess: 1 },
        { cell: 2, excess: 30 },
        { cell: 3, excess: 2 },
        { cell: 4, excess: 20 },
      ]),
      2,
      0.1,
      lookForFoe,
    );

    // Brightest chosen, then put back into ascending order so the delta encoding stays small.
    expect(snapshot.cells).toEqual([2, 4]);
    expect(snapshot.dropped).toBe(2);
  });

  it('confirms from every square, not only the ones that fit on the wire', () => {
    // The chart must not depend on how much of the picture fitted in a packet — otherwise the
    // team's memory of the map is a function of its bandwidth.
    const picture = new TeamPicture(tuned({ maxWireVisionCells: 1 }));
    picture.observe(
      vision([
        { cell: 1, excess: confirm + 1 },
        { cell: 2, excess: confirm + 9 },
      ]),
      2,
      0.1,
      lookForFoe,
    );

    expect(picture.chart.size).toBe(2);
  });

  it('carries the chart backlog a frame at a time and moves the watermark with it', () => {
    const picture = new TeamPicture(tuned({ maxChartCellsPerFrame: 2 }));
    picture.observe(
      vision([1, 2, 3, 4, 5].map((cell) => ({ cell, excess: confirm + 1 }))),
      2,
      0.1,
      lookForFoe,
    );

    const first = picture.frameFor(0);
    expect(unpackCells(first.charted)).toEqual([1, 2]);
    expect(first.chartSeen).toBe(2);

    const second = picture.frameFor(first.chartSeen);
    expect(unpackCells(second.charted)).toEqual([3, 4]);
    expect(second.chartSeen).toBe(4);
  });

  it('ages contacts on a tick where the team heard nothing at all', () => {
    // A fleet with every hydrophone gone produces no `TeamVision`, and a picture that only
    // aged on a solve would freeze its contacts mid-fade at that exact moment.
    const picture = new TeamPicture();
    picture.observe(vision([{ cell: 10, excess: 90, owner: FOE.id }]), 2, 0.1, lookForFoe);
    expect(picture.current.contacts[0]?.live).toBe(true);

    const settled = picture.settle(0.1 + ACOUSTICS.contactFadeSeconds + 1);
    expect(settled.contacts[0]?.live).toBe(false);
    expect(settled.cells).toEqual([]);
  });
});
