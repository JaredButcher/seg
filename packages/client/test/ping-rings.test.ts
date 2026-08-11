/**
 * The expanding ring a pulse draws (`render/pings.ts`), whoever fired it.
 *
 * Pure with respect to time, so none of this needs a canvas or a frame loop — which is the whole
 * reason the geometry lives in its own file instead of inside the Pixi ticker.
 */
import type { HeardPing } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import {
  HostilePings,
  PingRings,
  PING_RING_ALPHA,
  PING_RING_MS,
  PING_SPEED_M_PER_S,
  type PingSource,
} from '../src/render/pings.js';

function boat(id: number, lastPingTick: number, x = 100, y = 200): PingSource {
  return { id, pos: { x, y }, lastPingTick, destroyed: false };
}

function heard(tick: number, x = 100, y = 200): HeardPing {
  return { at: { x, y }, tick };
}

describe('PingRings', () => {
  /*
   * The reconnect case. A returning client's first frame carries whatever `lastPingTick` its
   * team's boats happen to be holding, which is a pulse that went out while the tab was closed.
   * Birthing rings for those would open the match with a barrage of sound and circles for
   * events that are already over.
   */
  it('draws nothing for a boat it is seeing for the first time', () => {
    const rings = new PingRings();

    expect(rings.observe([boat(1, 480)], 0)).toEqual([]);
    expect(rings.active).toBe(false);
  });

  it('draws a ring when the tick moves, and reports where', () => {
    const rings = new PingRings();
    rings.observe([boat(1, 20)], 0);

    const born = rings.observe([boat(1, 40, 300, 400)], 100);

    expect(born).toEqual([{ x: 300, y: 400 }]);
    expect(rings.active).toBe(true);
  });

  it('draws nothing on a frame where nothing pulsed', () => {
    const rings = new PingRings();
    rings.observe([boat(1, 20)], 0);

    expect(rings.observe([boat(1, 20)], 100)).toEqual([]);
    expect(rings.observe([boat(1, 20)], 200)).toEqual([]);
  });

  it('draws nothing for a wreck, whatever its last tick says', () => {
    const rings = new PingRings();
    rings.observe([boat(1, 20)], 0);

    expect(rings.observe([{ ...boat(1, 40), destroyed: true }], 100)).toEqual([]);
  });

  /* A tick that went backwards is a new match reusing an entity id, not a pulse. */
  it('draws nothing when the tick goes backwards', () => {
    const rings = new PingRings();
    rings.observe([boat(1, 400)], 0);

    expect(rings.observe([boat(1, 20)], 100)).toEqual([]);
  });

  it('expands at the speed of sound and fades to nothing', () => {
    const rings = new PingRings();
    rings.observe([boat(1, 20)], 0);
    rings.observe([boat(1, 40)], 1_000);

    const atBirth = rings.rings(1_000)[0];
    expect(atBirth?.radius).toBe(0);
    expect(atBirth?.alpha).toBeCloseTo(PING_RING_ALPHA, 6);

    // Half a second later: 750 m of water, and dimmer in proportion to its age.
    const later = rings.rings(1_500)[0];
    expect(later?.radius).toBeCloseTo(PING_SPEED_M_PER_S * 0.5, 6);
    expect(later?.alpha).toBeLessThan(PING_RING_ALPHA);
    expect(later?.alpha).toBeGreaterThan(0);
  });

  it('lets a ring go, and stops being active once the last one has', () => {
    const rings = new PingRings();
    rings.observe([boat(1, 20)], 0);
    rings.observe([boat(1, 40)], 100);

    expect(rings.rings(100 + PING_RING_MS - 1)).toHaveLength(1);
    expect(rings.rings(100 + PING_RING_MS)).toHaveLength(0);
    expect(rings.active).toBe(false);
  });

  it('tracks each boat separately', () => {
    const rings = new PingRings();
    rings.observe([boat(1, 20), boat(2, 20)], 0);

    const born = rings.observe([boat(1, 40, 10, 20), boat(2, 20, 30, 40)], 100);

    expect(born).toEqual([{ x: 10, y: 20 }]);
    expect(rings.rings(100)).toHaveLength(1);
  });
});

describe('HostilePings', () => {
  /*
   * The frame repeats an alert for a few seconds so a dropped packet cannot delete it
   * (`match/vision.ts#PING_ALERT_SECONDS`), which means the tracker — not the wire — decides which
   * repetition is the event.
   */
  it('flashes a pulse once, however many frames repeat it', () => {
    const pings = new HostilePings();

    expect(pings.observe([heard(40)], 0)).toEqual([{ x: 100, y: 200 }]);
    expect(pings.observe([heard(40)], 100)).toEqual([]);
    expect(pings.observe([heard(40)], 200)).toEqual([]);
  });

  /* A first sight is *not* silent: unlike a pulse of your own, this is news to a reconnecting
   * player — somebody found them, from over there. */
  it('flashes one it has never seen, on the first frame it sees it', () => {
    const pings = new HostilePings();

    expect(pings.observe([heard(12, 500, 600)], 0)).toEqual([{ x: 500, y: 600 }]);
    expect(pings.active).toBe(true);
  });

  it('treats two pingers on the same tick as two rings', () => {
    const pings = new HostilePings();

    const born = pings.observe([heard(40, 10, 20), heard(40, 30, 40)], 0);

    expect(born).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
    expect(pings.rings(0)).toHaveLength(2);
  });

  /* The whole point of the class: the ring is the one every other pulse draws. Only the colour
   * differs, and the colour is the renderer's business (`render/ScopeHost.tsx#drawPings`). */
  it('expands at the speed of sound and fades, exactly like a pulse of our own', () => {
    const pings = new HostilePings();
    pings.observe([heard(40)], 1_000);

    const atBirth = pings.rings(1_000)[0];
    expect(atBirth?.radius).toBe(0);
    expect(atBirth?.alpha).toBeCloseTo(PING_RING_ALPHA, 6);

    const later = pings.rings(1_500)[0];
    expect(later?.radius).toBeCloseTo(PING_SPEED_M_PER_S * 0.5, 6);
    expect(later?.alpha).toBeLessThan(PING_RING_ALPHA);
    expect(later?.alpha).toBeGreaterThan(0);
  });

  it('lets a ring go, and stops being active once the last one has', () => {
    const pings = new HostilePings();
    pings.observe([heard(40)], 100);

    expect(pings.rings(100 + PING_RING_MS - 1)).toHaveLength(1);
    expect(pings.rings(100 + PING_RING_MS)).toHaveLength(0);
    expect(pings.active).toBe(false);
  });

  /*
   * And it does not flash again when the finished ring is still being repeated on the wire. The
   * dedupe set outlives the animation on purpose.
   */
  it('does not flash an alert again after its ring has died', () => {
    const pings = new HostilePings();
    pings.observe([heard(40)], 0);
    pings.rings(PING_RING_MS);

    expect(pings.observe([heard(40)], PING_RING_MS + 10)).toEqual([]);
    expect(pings.active).toBe(false);
  });
});
