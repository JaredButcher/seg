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
  type Ghost,
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

const FOE: ContactSighting = {
  id: 7,
  kind: 'boat',
  hull: 'heavy',
  weapon: null,
  pos: { x: 12, y: 34 },
  facing: 180,
};

/** A hostile weapon, as the runtime reports one: it knows the load, the picture decides who is
 * told (`match/vision.ts#ContactSighting.weapon`). */
const FISH: ContactSighting = {
  id: 11,
  kind: 'torpedo',
  hull: null,
  weapon: 'super-cavitating',
  pos: { x: 40, y: 40 },
  facing: 0,
};

const lookForFish = (entity: EntityId): ContactSighting | undefined =>
  entity === FISH.id ? FISH : undefined;

/**
 * The same weapon as the runtime reports an **unmasked decoy**: a load this team established with
 * a pulse rather than overheard, so the picture is told not to gate it
 * (`match/vision.ts#ContactSighting.classified`).
 */
const STRIPPED: ContactSighting = { ...FISH, weapon: 'active-decoy', classified: true };

const lookForStripped = (entity: EntityId): ContactSighting | undefined =>
  entity === STRIPPED.id ? STRIPPED : undefined;

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

  it('drops a contact outright rather than waiting for the fade', () => {
    // The torpedo that just went off: the blip has nothing true to stand for any more, so the
    // runtime removes it the tick of the detonation instead of letting it decay over the window.
    const book = new ContactBook();
    book.confirm(FOE, 20, 1);

    book.drop(FOE.id);
    expect(book.snapshot(1)).toEqual([]);
    // A drop is a delete, not a tombstone: a contact that returns is a new one.
    expect(book.confirm(FOE, 30, 2)).not.toBe(1);
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

  it('sees a spent torpedo’s square without confirming its corpse as a contact', () => {
    // The bang rings the water down for seconds after the weapon detonates, so its squares still
    // transmit — but the blip was dropped the tick it went off, and `confirm: false` is what
    // stops the corpse being re-minted while it rings down.
    const picture = new TeamPicture();
    const corpse: ContactSighting = {
      id: 9,
      kind: 'torpedo',
      hull: null,
      weapon: 'active-torpedo',
      pos: { x: 5, y: 5 },
      facing: 0,
      confirm: false,
    };
    const snapshot = picture.observe(
      vision([{ cell: 10, excess: 90, owner: corpse.id }]),
      2,
      0.1,
      (entity) => (entity === corpse.id ? corpse : undefined),
    );

    expect(snapshot.cells).toEqual([10]);
    expect(picture.chart.size).toBe(0);
    expect(picture.contacts.size).toBe(0);
    expect(snapshot.contacts).toEqual([]);
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

describe('classifying a weapon', () => {
  const confirm = ACOUSTICS.confirmationThreshold;
  const identify = ACOUSTICS.identificationThreshold;

  /** The band the whole mechanic lives in has to be a band, or none of the rest matters. */
  it('is a harder standard than confirmation', () => {
    expect(identify).toBeGreaterThan(confirm);
  });

  it('confirms a weapon without naming it below the identification threshold', () => {
    // The state the generic dart draws: the team knows a weapon is in the water and no more.
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([{ cell: 10, excess: identify - 0.1, owner: FISH.id }]),
      2,
      0.1,
      lookForFish,
    );

    expect(snapshot.contacts).toHaveLength(1);
    expect(snapshot.contacts[0]?.kind).toBe('torpedo');
    expect(snapshot.contacts[0]?.weapon).toBeNull();
  });

  it('names it once a square clears the identification threshold', () => {
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([{ cell: 10, excess: identify, owner: FISH.id }]),
      2,
      0.1,
      lookForFish,
    );

    expect(snapshot.contacts[0]?.weapon).toBe('super-cavitating');
  });

  it('classifies on the best square, not on a count of them', () => {
    // The same rule confirmation follows: a weapon seen bow-on presents a handful of squares and
    // is no less identified for it.
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([
        { cell: 10, excess: confirm, owner: FISH.id },
        { cell: 11, excess: identify + 5, owner: FISH.id },
        { cell: 12, excess: confirm, owner: FISH.id },
      ]),
      2,
      0.1,
      lookForFish,
    );

    expect(snapshot.contacts[0]?.weapon).toBe('super-cavitating');
  });

  it('keeps the classification when the signal falls back into the confirmed band', () => {
    // Sticky, and the reason is legibility: a type that reverted every time the signal breathed
    // would read as the display failing rather than as the sonar being marginal.
    const picture = new TeamPicture();
    picture.observe(
      vision([{ cell: 10, excess: identify + 2, owner: FISH.id }]),
      2,
      0.1,
      lookForFish,
    );
    const faded = picture.observe(
      vision([{ cell: 10, excess: confirm, owner: FISH.id }]),
      4,
      0.2,
      lookForFish,
    );

    expect(faded.contacts[0]?.weapon).toBe('super-cavitating');
    expect(faded.contacts[0]?.id).toBe(1);
  });

  it('does not carry a classification across a re-acquisition', () => {
    // Stickiness is a property of the contact, not of the entity. A track that expires takes what
    // the team knew about it along, which is what makes holding it for the contact's life safe.
    const picture = new TeamPicture(tuned({ contactFadeSeconds: 1, contactHoldSeconds: 1 }));
    picture.observe(
      vision([{ cell: 10, excess: identify + 2, owner: FISH.id }]),
      2,
      0,
      lookForFish,
    );
    picture.settle(10);

    const again = picture.observe(
      vision([{ cell: 10, excess: confirm, owner: FISH.id }]),
      200,
      11,
      lookForFish,
    );
    expect(again.contacts[0]?.id).not.toBe(1);
    expect(again.contacts[0]?.weapon).toBeNull();
  });

  it('names a classified sighting at any level, however faintly it is heard', () => {
    // The unmasked decoy. A team that pinged one has *measured* it as seven metres of torpedo,
    // so making them close the range and hear it at `identificationThreshold` to re-learn what
    // the pulse already proved would leave them holding an anonymous dart on the strength of the
    // one action that answers exactly that question.
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([{ cell: 10, excess: confirm, owner: STRIPPED.id }]),
      2,
      0.1,
      lookForStripped,
    );

    expect(snapshot.contacts[0]?.kind).toBe('torpedo');
    expect(snapshot.contacts[0]?.weapon).toBe('active-decoy');
  });

  it('carries a classified load across a re-acquisition, unlike an overheard one', () => {
    // The other half of "unmasking is sticky". An ordinary classification dies with its contact,
    // because what the team knew was a property of that track. What a pulse proved about a decoy
    // is not — the runtime holds it for the match (`server/match/runtime.ts#exposedDecoys`) and
    // re-supplies it on every solve, so a decoy that slips detection and comes back comes back
    // named, at whatever level it is re-acquired.
    const picture = new TeamPicture(tuned({ contactFadeSeconds: 1, contactHoldSeconds: 1 }));
    picture.observe(
      vision([{ cell: 10, excess: identify + 2, owner: STRIPPED.id }]),
      2,
      0,
      lookForStripped,
    );
    picture.settle(10);

    const again = picture.observe(
      vision([{ cell: 10, excess: confirm, owner: STRIPPED.id }]),
      200,
      11,
      lookForStripped,
    );
    expect(again.contacts[0]?.id).not.toBe(1);
    expect(again.contacts[0]?.weapon).toBe('active-decoy');
  });

  it('never names a boat, however loudly it is heard', () => {
    // A hull's class is already given away by the silhouette confirmation reveals; there is
    // nothing left for a second threshold to sell. It is also the shape of the decoy guarantee:
    // a sighting reported as a boat carries no load, so no amount of signal can leak one.
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([{ cell: 10, excess: 90, owner: FOE.id }]),
      2,
      0.1,
      lookForFoe,
    );

    expect(snapshot.contacts[0]?.kind).toBe('boat');
    expect(snapshot.contacts[0]?.weapon).toBeNull();
  });
});

describe('ambient ghosts', () => {
  const confirm = ACOUSTICS.confirmationThreshold;
  /** A ghost is always faint — well under the confirmation threshold (planning/15 §3). */
  const ghostAt = (cell: number, excess = 0.5): Ghost => ({ cell, excess });

  it('never touches the chart, across many solves — the important one', () => {
    // A ghost that confirmed would put a permanent fake rock square on the team's chart for the
    // rest of the match, and rock does not un-confirm. The structural guarantee is that ghosts
    // are folded in after the confirmation pass, not that they happen to be quiet.
    const picture = new TeamPicture();
    for (let tick = 2; tick <= 20; tick += 2) {
      picture.observe(vision([{ cell: 10, excess: confirm + 1 }]), tick, tick * 0.1, lookForFoe, [
        ghostAt(40 + tick),
        ghostAt(41 + tick, 1.5),
      ]);
    }

    // The one genuine square confirmed on its first solve; ten solves of ghosts changed nothing.
    expect(picture.chart.size).toBe(1);
    expect(picture.chart.has(10)).toBe(true);
    for (let cell = 42; cell <= 61; cell += 1) {
      expect(picture.chart.has(cell)).toBe(false);
    }
  });

  it('never mints a contact', () => {
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([{ cell: 10, excess: confirm + 1, owner: FOE.id }]),
      2,
      0.1,
      lookForFoe,
      [ghostAt(20), ghostAt(21)],
    );

    // The genuine hull square confirmed the contact; the ghosts standing beside it did not.
    expect(picture.contacts.size).toBe(1);
    expect(snapshot.ghosts).toHaveLength(2);
    expect(snapshot.contacts).toHaveLength(1);
  });

  it('lets a real return beat a ghost on the same square, keeping the run ascending', () => {
    const picture = new TeamPicture();
    const snapshot = picture.observe(
      vision([
        { cell: 10, excess: 1 },
        { cell: 12, excess: 1 },
      ]),
      2,
      0.1,
      lookForFoe,
      [ghostAt(10), ghostAt(11), ghostAt(30)],
    );

    // 10 is already lit, so its ghost is dropped; 11 and 30 ride along; the run is unique and
    // strictly ascending because `cells` and `strength` must stay parallel (planning/15 §5).
    expect(snapshot.cells).toEqual([10, 11, 12, 30]);
    expect(snapshot.ghosts).toEqual([ghostAt(11), ghostAt(30)]);
    expect(unpackCells(picture.frameFor(0).cells)).toEqual([10, 11, 12, 30]);
  });

  it('drops a ghost on charted rock outright', () => {
    const picture = new TeamPicture();
    picture.observe(vision([{ cell: 10, excess: confirm + 1 }]), 2, 0.1, lookForFoe);

    const snapshot = picture.observe(vision([]), 4, 0.2, lookForFoe, [ghostAt(10), ghostAt(20)]);

    // 10 is settled rock — a green flicker over it would read as "something moved against that
    // wall", which is a lie about the one thing the team has proven.
    expect(snapshot.cells).toEqual([20]);
    expect(snapshot.ghosts).toEqual([ghostAt(20)]);
  });

  it('does not increase dropped', () => {
    const picture = new TeamPicture(tuned({ maxWireVisionCells: 2 }));
    const snapshot = picture.observe(
      vision([
        { cell: 1, excess: 30 },
        { cell: 2, excess: 20 },
        { cell: 3, excess: 10 },
      ]),
      2,
      0.1,
      lookForFoe,
      [ghostAt(4)],
    );

    // Three real squares against a cap of two: the two brightest are kept and one is dropped,
    // and the ghost is appended after the selection rather than competing in it — a noisy
    // boat's clutter must not evict its own real returns (planning/15 §5).
    expect(snapshot.cells).toEqual([1, 2, 4]);
    expect(snapshot.dropped).toBe(1);
  });

  it('ages a ghost out of a settle that carries one', () => {
    const picture = new TeamPicture();
    const settled = picture.settle(0.2, [ghostAt(30)]);
    expect(settled.cells).toEqual([30]);
    expect(settled.ghosts).toHaveLength(1);
  });
});
