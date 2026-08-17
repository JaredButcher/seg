/**
 * `BinaryCodec`, against `JsonCodec`, on real messages.
 *
 * This is [planning/13 §7](../../../planning/13-testing.md)'s differential suite, and the reason
 * planning/02 §9 calls step 3 "safe rather than terrifying": the tests were specified against one
 * codec and simply activated for the second. What they assert is that **the two codecs are the
 * same codec** — encode with either, decode with either, get the same message back — with exactly
 * one declared exception, quantization, which is checked against its own declared bound rather
 * than waved at.
 *
 * The properties, in the order they matter:
 *
 * 1. **Round trip.** `decode(encode(m))` equals `m`, up to quantization.
 * 2. **Idempotence.** `encode(decode(encode(m)))` is *byte-identical* to `encode(m)`. This is the
 *    property delta encoding will rest on: a value that shifted a little every trip through the
 *    codec would make every field look changed and defeat the delta entirely.
 * 3. **Fallback.** A message with no schema still travels, losslessly, through the JSON envelope —
 *    which is what makes converting one type at a time safe.
 * 4. **Hostility.** A truncated or malformed buffer throws rather than returning half a message.
 */

import { describe, expect, it } from 'vitest';

import {
  BinaryCodec,
  BinaryError,
  ByteReader,
  ByteWriter,
  CONTACT_KIND_VALUES,
  HULL_VALUES,
  JsonCodec,
  MESSAGE_IDS,
  MESSAGE_SCHEMAS,
  TEAM_VALUES,
  THROTTLE_VALUES,
  TRANSIENT_KIND_VALUES,
  TUBE_STATUS_VALUES,
  WEAPON_VALUES,
  createPing,
  createPong,
  createMatchView,
  isSchemad,
  readValue,
  writeValue,
  type MatchViewState,
  type Message,
  type WireType,
} from '../src/index.js';
import { HULL_IDS } from '../src/content/hulls.js';
import { WEAPON_IDS } from '../src/content/weapons.js';
import { TEAM_IDS, THROTTLE_NOTCHES } from '../src/match/world.js';

const binary = new BinaryCodec();
const json = new JsonCodec();

// ── A view frame with something in every field ────────────────────────────────────────

/**
 * Deliberately not a minimal fixture.
 *
 * Every array here is non-empty and every nullable is exercised both ways, because the failure
 * mode of a positional decoder is reading the *next* field's bytes — which a fixture full of empty
 * arrays and nulls cannot produce, since every branch it takes is the cheap one.
 */
const view: MatchViewState = {
  phase: 'active',
  clock: { tick: 412, elapsedSeconds: 20.6, remainingSeconds: 1779.4 },
  teams: [
    { team: 'team1', score: 3, survivingPoints: 450, boatsAlive: 3, boatsTotal: 4 },
    { team: 'team2', score: 1, survivingPoints: 300, boatsAlive: 2, boatsTotal: 4 },
  ],
  zones: [
    {
      id: 1000,
      label: 'OBJ 1',
      centre: { x: 2958.5, y: 1375 },
      radius: 200,
      armingTicks: 0,
      capturing: 'team1',
      progress: 0.427,
      contested: false,
    },
    {
      id: 1001,
      label: 'OBJ 2',
      centre: { x: 4408.5, y: 1625 },
      radius: 200,
      armingTicks: 12,
      capturing: null,
      progress: 0,
      contested: true,
    },
  ],
  boats: [
    {
      id: 1,
      pos: { x: 412.5, y: 2037.5 },
      facing: 87.25,
      speed: 7.72,
      throttle: 'full',
      hp: 110,
      cavitating: false,
      order: {
        kind: 'transit',
        waypoints: [
          { x: 7360, y: 1500 },
          { x: 7000, y: 900 },
        ],
      },
      status: 'active',
      activeSonar: true,
      lastPingTick: 400,
      transients: [{ kind: 'torpedo-launch', tick: 398 }],
      noiseLevel: 62.5,
    },
    {
      id: 2,
      pos: { x: 500, y: 1000 },
      facing: 0,
      speed: 0,
      throttle: 'slow',
      hp: 44.5,
      cavitating: true,
      order: { kind: 'hold' },
      status: 'destroyed',
      activeSonar: false,
      lastPingTick: 0,
      transients: [],
      noiseLevel: 48.8,
    },
  ],
  wrecks: [{ id: 9, hull: 'heavy', pos: { x: 3000, y: 2000 }, facing: 271.5 }],
  torpedoes: [
    {
      id: 50,
      weapon: 'super-cavitating',
      firedBy: 1,
      pos: { x: 1200, y: 1800 },
      facing: 45,
      speed: 55,
      phase: 'enabled',
      aim: { x: 4000, y: 2200 },
      lastPingTick: 410,
      transients: [{ kind: 'torpedo-detonation', tick: 411 }],
    },
  ],
  own: [
    {
      id: 1,
      tubes: [
        {
          index: 0,
          weapon: 'active-torpedo',
          next: 'passive-torpedo',
          status: 'loaded',
          readyInSeconds: 0,
        },
        {
          index: 1,
          weapon: 'noisemaker',
          next: 'noisemaker',
          status: 'reloading',
          readyInSeconds: 22.35,
        },
      ],
      countermeasure: { status: 'reloading', readyInSeconds: 8.5 },
    },
  ],
  vision: {
    charted: [4021, 3, 7, 2, 19],
    chartSeen: 314,
    cells: [1200, 4, 9, 1],
    strength: [12, 240, 3, 88],
    dropped: 7,
    contacts: [
      {
        id: 77,
        kind: 'boat',
        hull: 'light',
        weapon: null,
        pos: { x: 5000, y: 1200 },
        facing: 180,
        seenTick: 405,
        live: true,
      },
      {
        id: 78,
        kind: 'torpedo',
        hull: null,
        weapon: 'active-torpedo',
        pos: { x: 5200, y: 1300 },
        facing: 190.5,
        seenTick: 409,
        live: false,
      },
    ],
    launches: [{ at: { x: 5000, y: 1200 }, tick: 398 }],
    pings: [{ at: { x: 6000, y: 900 }, tick: 402 }],
  },
};

const frame = createMatchView('m1', 12, view);

describe('the round trip', () => {
  it('carries a full view frame back unchanged, up to quantization', () => {
    const decoded = binary.decode(binary.encode(frame));
    expect(decoded).toEqual(frame);
  });

  it('carries the ping pair back exactly', () => {
    expect(binary.decode(binary.encode(createPing(1234.5)))).toEqual(createPing(1234.5));
    expect(binary.decode(binary.encode(createPong(1, 2)))).toEqual(createPong(1, 2));
  });

  it('is idempotent — re-encoding a decoded message is byte-identical', () => {
    // The property delta encoding will rest on. A value that drifted a little on each trip would
    // make every field look changed and there would be no delta left to send.
    const once = binary.encode(frame);
    const twice = binary.encode(binary.decode(once) as typeof frame);
    expect([...twice]).toEqual([...once]);
  });

  it('agrees with JsonCodec about what the message is', () => {
    // The differential assertion proper: both codecs, decoded, must be the same object. Run on the
    // *binary-decoded* frame so quantization is applied to both sides — the two codecs disagree
    // about float precision by design, and this pins that the disagreement is the only one.
    const settled = binary.decode(binary.encode(frame));
    expect(json.decode(json.encode(settled as typeof frame))).toEqual(settled);
  });
});

describe('quantization', () => {
  it('loses no more than half a step, per declared field', () => {
    const decoded = binary.decode(binary.encode(frame)) as typeof frame;
    const before = view.boats[0]!;
    const after = decoded.view.boats[0]!;

    // Positions: half a metre step, so a quarter metre of error at worst.
    expect(Math.abs(after.pos.x - before.pos.x)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(after.pos.y - before.pos.y)).toBeLessThanOrEqual(0.25);
    // Angles: hundredths of a degree.
    expect(Math.abs(after.facing - before.facing)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(after.speed - before.speed)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(after.noiseLevel - before.noiseLevel)).toBeLessThanOrEqual(0.05);
  });

  it('keeps values that already sit on the grid exactly', () => {
    // A tick-derived clock is a multiple of one sim tick, which is the step — so it is not
    // approximately right, it is right. Anything else would show up as a drifting match timer.
    const decoded = binary.decode(binary.encode(frame)) as typeof frame;
    expect(decoded.view.clock.elapsedSeconds).toBe(20.6);
    expect(decoded.view.clock.remainingSeconds).toBe(1779.4);
    expect(decoded.view.boats[0]?.pos.x).toBe(412.5);
  });

  it('does not leave floating-point dust behind', () => {
    // `dequantize` rounds back onto the step's own decimal grid. Without it, `3 * 0.1` is
    // `0.30000000000000004`, every `toEqual` above fails, and the idempotence property quietly
    // stops holding.
    const decoded = binary.decode(binary.encode(frame)) as typeof frame;
    expect(String(decoded.view.zones[0]?.progress)).toBe('0.427');
    expect(String(decoded.view.own[0]?.tubes[1]?.readyInSeconds)).toBe('22.35');
  });
});

describe('the JSON fallback', () => {
  it('carries a message with no schema, losslessly', () => {
    const welcome: Message = { t: 'welcome', protocolVersion: 9, contentHash: 'abc123' };
    expect(isSchemad('welcome')).toBe(false);
    expect(binary.decode(binary.encode(welcome))).toEqual(welcome);
  });

  it('is what makes converting one type at a time safe', () => {
    // A schema'd and an unschema'd message on the same connection, in either order, and neither
    // can be mistaken for the other — the envelope's whole job.
    const schemad = binary.encode(createPing(7));
    const fallback = binary.encode({ t: 'session.replaced' } as Message);
    expect(binary.decode(schemad)).toEqual(createPing(7));
    expect(binary.decode(fallback)).toEqual({ t: 'session.replaced' });
    expect(isSchemad('ping')).toBe(true);
  });

  it('rejects a fallback body that is not a message', () => {
    const w = new ByteWriter();
    w.varint(0);
    w.raw(new TextEncoder().encode('{"nope":1}'));
    expect(() => binary.decode(Uint8Array.from(w.finish()))).toThrow(BinaryError);
  });
});

describe('a hostile buffer', () => {
  it('throws on truncation rather than returning half a message', () => {
    const full = binary.encode(frame);
    for (const cut of [1, 8, Math.floor(full.byteLength / 2), full.byteLength - 1]) {
      expect(() => binary.decode(full.subarray(0, cut))).toThrow();
    }
  });

  it('throws on an unknown message id', () => {
    const w = new ByteWriter();
    w.varint(9999);
    expect(() => binary.decode(Uint8Array.from(w.finish()))).toThrow(/unknown message id/);
  });

  it('throws on trailing bytes rather than decoding against the wrong schema', () => {
    const full = binary.encode(createPing(1));
    const extended = new Uint8Array(full.byteLength + 3);
    extended.set(full);
    expect(() => binary.decode(extended)).toThrow(/trailing bytes/);
  });

  it('refuses an array length that could not possibly fit', () => {
    // The allocation guard. Without it a four-byte varint asks for a four-billion-element array
    // before a single element is read.
    const w = new ByteWriter();
    w.varint(MESSAGE_IDS['ping'] ?? 1);
    const hostile: WireType = { k: 'array', of: { k: 'u8' } };
    const w2 = new ByteWriter();
    w2.varint(0xffffff);
    expect(() => readValue(new ByteReader(Uint8Array.from(w2.finish())), hostile)).toThrow(
      /exceeds/,
    );
  });

  it('refuses a value that would silently wrap a fixed-width integer', () => {
    // `DataView.setUint16` masks rather than throwing, so a position past the map extent would
    // encode as somewhere on the far side of the ocean. This is the check that makes it a throw.
    const w = new ByteWriter();
    expect(() => writeValue(w, { k: 'fixed', step: 0.5, as: 'u16' }, 1e9)).toThrow(/does not fit/);
  });
});

describe('the schema itself', () => {
  it('gives every schema a stable id, and every id one meaning', () => {
    for (const type of Object.keys(MESSAGE_SCHEMAS)) {
      expect(MESSAGE_IDS[type], `${type} has a schema but no id`).toBeDefined();
    }
    const ids = Object.values(MESSAGE_IDS);
    expect(new Set(ids).size, 'two message types share an id').toBe(ids.length);
    expect(ids).not.toContain(0); // reserved for the JSON fallback
  });

  it.each([
    ['teams', TEAM_VALUES, TEAM_IDS],
    ['hulls', HULL_VALUES, HULL_IDS],
    ['weapons', WEAPON_VALUES, WEAPON_IDS],
    ['throttles', THROTTLE_VALUES, THROTTLE_NOTCHES],
  ])('covers every %s the content tables define', (_label, wire, runtime) => {
    // The enum lists in `messages.ts` are written out rather than imported, because on the wire an
    // enum is its *index* and a tidy-up that reordered a content table would silently redefine
    // what a `2` means. This catches the opposite mistake: something added to the game and never
    // added to the wire.
    expect([...wire].sort()).toEqual([...runtime].sort());
  });

  it('names every transient, tube status and contact kind the game can produce', () => {
    // No runtime array exists for these, so the check is that the fixture above exercised them and
    // that the lists are non-empty and unique — a weaker guarantee, honestly stated.
    for (const values of [TRANSIENT_KIND_VALUES, TUBE_STATUS_VALUES, CONTACT_KIND_VALUES]) {
      expect(new Set(values).size).toBe(values.length);
      expect(values.length).toBeGreaterThan(0);
    }
  });
});

describe('size', () => {
  it('is dramatically smaller than JSON on the message that matters', () => {
    const binaryBytes = binary.encode(frame).byteLength;
    const jsonBytes = json.encode(frame).byteLength;
    // Measured around 6× on this fixture and 16× on real `worst`-case frames, where the arrays are
    // long and the key names repeat per element (planning/17 §5.2). The assertion is deliberately
    // loose: what must not happen is the ratio quietly going the wrong way.
    expect(jsonBytes / binaryBytes).toBeGreaterThan(3);
  });

  it("costs one byte of envelope for a schema'd message", () => {
    // The ids in use are all under 128, so the varint is one byte. Worth pinning because the
    // envelope is pure overhead on the small messages and the budget for it is exactly this.
    const ping = createPing(0);
    expect(binary.encode(ping).byteLength).toBe(1 + 8);
  });
});
