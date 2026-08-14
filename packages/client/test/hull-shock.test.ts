/**
 * The damage glow around the scope's frame.
 *
 * The layer itself is a handful of stroked rectangles and not worth asserting pixel by pixel; what
 * is worth pinning is the *timing policy*, because that is the part a player experiences and the
 * part that is easy to get wrong in a way nobody notices until a match goes badly:
 *
 * - a warning has to be **gone** before the player has finished reacting to it,
 * - a loss has to **outlast** one and hold before it fades,
 * - and a salvo has to read as one event rather than saturating the screen.
 *
 * Drawing is checked through a recorder rather than a real `Graphics`, the same way
 * `torpedo-trails` checks the trail layer: what matters is that it painted, how strongly, and that
 * it stopped.
 */

import { describe, expect, it } from 'vitest';

import { HullShock, SHOCK_DESTROYED_MS, SHOCK_MS } from '../src/render/shock.js';

const CORE = { x: 0, y: 0, width: 1200, height: 800 };

/** The slice of `Graphics` the shock layer touches, recording the alpha of every band. */
function recorder() {
  const alphas: number[] = [];
  let clears = 0;

  const graphics = {
    clear() {
      clears += 1;
      alphas.length = 0;
      return graphics;
    },
    rect() {
      return graphics;
    },
    stroke(style: { alpha?: number }) {
      alphas.push(style.alpha ?? 1);
      return graphics;
    },
  };

  return {
    graphics,
    get bands() {
      return alphas.length;
    },
    /** The brightest band painted on the last draw — the edge hard against the frame. */
    get peak() {
      return alphas.length === 0 ? 0 : Math.max(...alphas);
    },
    get clears() {
      return clears;
    },
  };
}

/** Draw once at `now` and report what was painted. */
function drawAt(shock: HullShock, now: number) {
  const rec = recorder();
  shock.draw(rec.graphics as never, CORE, now);
  return rec;
}

describe('HullShock', () => {
  it('paints nothing until something has hit you', () => {
    const shock = new HullShock();
    expect(shock.active).toBe(false);
    expect(drawAt(shock, 1_000).bands).toBe(0);
  });

  it('paints a gradient of bands after a hit, brightest against the frame', () => {
    const shock = new HullShock();
    shock.hit('damage', 1_000);

    const rec = drawAt(shock, 1_000);
    expect(shock.active).toBe(true);
    // Several bands rather than one, or the glow reads as a hard border instead of a falloff.
    expect(rec.bands).toBeGreaterThan(3);
    expect(rec.peak).toBeGreaterThan(0);
  });

  it('fades a hit out, and lets go of it', () => {
    const shock = new HullShock();
    shock.hit('damage', 1_000);

    const fresh = drawAt(shock, 1_000).peak;
    const later = drawAt(shock, 1_000 + SHOCK_MS * 0.7).peak;
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(fresh);

    // Past its life it is over, the layer is cleared rather than left holding a stale band, and
    // the tracker stops asking to be drawn at all.
    const done = drawAt(shock, 1_000 + SHOCK_MS + 1);
    expect(done.clears).toBe(1);
    expect(done.bands).toBe(0);
    expect(shock.active).toBe(false);
  });

  it('holds a loss at full strength before fading, unlike a hit', () => {
    // There is nothing left for the player to act on, so nothing left to obscure.
    const shock = new HullShock();
    shock.hit('destroyed', 1_000);

    const start = drawAt(shock, 1_000).peak;
    const held = drawAt(shock, 1_000 + SHOCK_DESTROYED_MS * 0.2).peak;
    expect(held).toBeCloseTo(start, 6);

    const fading = drawAt(shock, 1_000 + SHOCK_DESTROYED_MS * 0.8).peak;
    expect(fading).toBeLessThan(start);
  });

  it('makes a loss brighter and much longer-lived than a hit', () => {
    const hit = new HullShock();
    hit.hit('damage', 0);
    const loss = new HullShock();
    loss.hit('destroyed', 0);

    expect(drawAt(loss, 0).peak).toBeGreaterThan(drawAt(hit, 0).peak);

    // The hit is long over by the time the loss has started to fade.
    expect(drawAt(hit, SHOCK_MS + 1).bands).toBe(0);
    expect(drawAt(loss, SHOCK_MS + 1).bands).toBeGreaterThan(0);
    expect(SHOCK_DESTROYED_MS).toBeGreaterThan(SHOCK_MS * 2);
  });

  it('takes the strongest of overlapping flashes rather than summing them', () => {
    // A four-tube salvo landing inside a second is one event to a player's eye. Summing would wash
    // the screen out for a salvo while a single fatal hit stayed dim — exactly backwards.
    const one = new HullShock();
    one.hit('damage', 1_000);

    const many = new HullShock();
    for (let i = 0; i < 4; i += 1) many.hit('damage', 1_000);

    expect(drawAt(many, 1_000).peak).toBeCloseTo(drawAt(one, 1_000).peak, 6);
  });

  it('lets a loss outrank a hit that landed at the same moment', () => {
    const shock = new HullShock();
    shock.hit('damage', 1_000);
    shock.hit('destroyed', 1_000);

    const loss = new HullShock();
    loss.hit('destroyed', 1_000);

    // Both are at full strength, so the tie-break decides — and it has to pick the deeper, longer
    // shape, because that is the one that means the boat is gone.
    expect(drawAt(shock, 1_000).peak).toBeCloseTo(drawAt(loss, 1_000).peak, 6);
  });

  it('keeps burning on the older flash when a newer one has died', () => {
    const shock = new HullShock();
    shock.hit('destroyed', 0);
    shock.hit('damage', 0);

    // The hit is gone; the loss is not, and the layer must not go dark with it.
    expect(drawAt(shock, SHOCK_MS + 1).bands).toBeGreaterThan(0);
    expect(shock.active).toBe(true);
  });
});
