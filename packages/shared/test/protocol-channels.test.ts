/**
 * Which channel a message belongs on, and the accounting that rests on the answer.
 *
 * `channelFor` is a lookup table, and the failure mode of a lookup table is that somebody adds a
 * message type and forgets it. That is not catastrophic — the fallback is `control`, which is
 * always safe (planning/02 §3.1) — but it silently mis-attributes bandwidth, and bandwidth
 * attribution is the whole reason the table exists (planning/17 §4.2). So the first test here is
 * exhaustiveness, checked against the schema itself rather than against a second hand-written list.
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNELLED_TYPES,
  CountingCodec,
  JsonCodec,
  WireMeter,
  channelFor,
  createMatchView,
  createNavOrder,
  createPing,
  type Message,
} from '../src/index.js';

/**
 * Every `t` tag declared anywhere in `src/protocol/`, read out of the source.
 *
 * Reading the files is deliberate and is the only way this test can *fail* on the thing it is for.
 * A list written here by hand would have to be updated by the same person who forgot to update
 * `channels.ts`, which makes it a duplicate of the bug rather than a check on it.
 */
async function declaredTypes(): Promise<Set<string>> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = new URL('../src/protocol/', import.meta.url).pathname;

  const tags = new Set<string>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(join(dir, file), 'utf8');
    for (const match of source.matchAll(/readonly t: '([^']+)'/g)) {
      const tag = match[1];
      if (tag !== undefined) tags.add(tag);
    }
  }
  return tags;
}

describe('channelFor', () => {
  it('knows every message type the schema declares', async () => {
    const declared = await declaredTypes();
    const known = new Set(CHANNELLED_TYPES);

    const missing = [...declared].filter((tag) => !known.has(tag)).sort();
    expect(missing, 'message types with no channel — add them to protocol/channels.ts').toEqual([]);
  });

  it('does not carry entries for types that no longer exist', async () => {
    const declared = await declaredTypes();
    const stale = CHANNELLED_TYPES.filter((tag) => !declared.has(tag)).sort();
    expect(stale, 'channel entries for types the schema no longer declares').toEqual([]);
  });

  it('puts view frames on the droppable channel and everything else on a reliable one', () => {
    // The rule from planning/02 §3: a message goes on `view` only if losing it beats delaying it.
    expect(channelFor({ t: 'match.view' } as Message)).toBe('view');
    // `match.state` is the static half. It travels once and a client that misses it has no match.
    expect(channelFor({ t: 'match.state' } as Message)).toBe('control');
    expect(channelFor({ t: 'nav.order' } as Message)).toBe('commands');
    // planning/02 §3.1: all lobby traffic is pinned to the WebSocket, permanently.
    expect(channelFor({ t: 'lobby.join' } as Message)).toBe('control');
    expect(channelFor({ t: 'chat.message' } as Message)).toBe('control');
  });

  it('answers control for a type it has never heard of, rather than throwing', () => {
    // Reliable-ordered is a superset of every other guarantee, so being wrong in this direction
    // costs bandwidth and never correctness. A protocol addition must not be able to break a
    // session by being forgotten in a lookup table.
    expect(channelFor({ t: 'nonsense.invented' } as Message)).toBe('control');
  });

  it('keeps the debug toggles apart from the debug payloads', () => {
    // The `.` in a type tag says which file declares it, never which channel carries it — a stale
    // field map is worth less than the next one, but a toggle that goes missing leaves an overlay
    // switched on for the rest of the match.
    expect(channelFor({ t: 'debug.field' } as Message)).toBe('view');
    expect(channelFor({ t: 'debug.setField' } as Message)).toBe('control');
  });
});

describe('WireMeter', () => {
  it('attributes bytes by type and by channel', () => {
    const meter = new WireMeter();
    meter.record(createPing(1), 100);
    meter.record(createPing(2), 40);
    meter.record(createNavOrder(1, { x: 0, y: 0 }, false), 60);

    expect(meter.totals).toEqual({ messages: 3, bytes: 200 });
    expect(meter.bytesOf('ping')).toBe(140);
    expect(meter.countOf('ping')).toBe(2);
    expect(meter.byChannel()).toEqual({ control: 140, commands: 60, view: 0 });
  });

  it('keeps the peak, because a worst case is made of peaks rather than means', () => {
    const meter = new WireMeter();
    meter.record(createPing(1), 10);
    meter.record(createPing(2), 900);
    meter.record(createPing(3), 20);

    const ping = meter.tallies().find((tally) => tally.type === 'ping');
    expect(ping?.peak).toBe(900);
    expect(ping?.mean).toBeCloseTo(310);
  });

  it('sorts tallies heaviest first, which is the order a reader fixes things in', () => {
    const meter = new WireMeter();
    meter.record(createPing(1), 10);
    meter.record(createNavOrder(1, { x: 0, y: 0 }, false), 500);

    expect(meter.tallies().map((tally) => tally.type)).toEqual(['nav.order', 'ping']);
  });

  it('forgets everything on reset', () => {
    const meter = new WireMeter();
    meter.record(createPing(1), 10);
    meter.reset();
    expect(meter.totals).toEqual({ messages: 0, bytes: 0 });
    expect(meter.tallies()).toEqual([]);
  });
});

describe('CountingCodec', () => {
  it('is the codec it wraps, byte for byte', () => {
    const plain = new JsonCodec();
    const counting = new CountingCodec(new JsonCodec());
    const message = createPing(1234);

    expect([...counting.encode(message)]).toEqual([...plain.encode(message)]);
    expect(counting.decode(plain.encode(message))).toEqual(message);
  });

  it('counts the two directions separately', () => {
    // They are measured against different limits — planning/02 §6's bandwidth budget one way and
    // §7's abuse budget the other — so a single total would be compared to nothing.
    const codec = new CountingCodec(new JsonCodec());
    const view = createMatchView('m1', 1, {
      phase: 'active',
      clock: { tick: 2, elapsedSeconds: 0.1, remainingSeconds: 100 },
      teams: [],
      zones: [],
      boats: [],
      wrecks: [],
      torpedoes: [],
      own: [],
      vision: {
        charted: [],
        chartSeen: 0,
        cells: [],
        strength: [],
        dropped: 0,
        contacts: [],
        launches: [],
        pings: [],
      },
    });

    const encoded = codec.encode(view);
    codec.decode(codec.encode(createNavOrder(1, { x: 0, y: 0 }, false)));

    expect(codec.outbound.bytesOf('match.view')).toBe(encoded.byteLength);
    expect(codec.inbound.bytesOf('nav.order')).toBeGreaterThan(0);
    // The nav order was encoded too, so outbound saw it — that is correct and worth pinning, since
    // it is the difference between "what this codec did" and "what went on the wire".
    expect(codec.outbound.countOf('nav.order')).toBe(1);
    expect(codec.inbound.countOf('match.view')).toBe(0);
  });

  it('does not charge the inbound meter for a message that failed to decode', () => {
    const codec = new CountingCodec(new JsonCodec());
    expect(() => codec.decode(new TextEncoder().encode('{not json'))).toThrow();
    expect(codec.inbound.totals.messages).toBe(0);
  });
});
