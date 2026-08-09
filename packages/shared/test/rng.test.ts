/**
 * The seeded PRNG. Determinism is the point of it, so that is most of what is asserted here:
 * a replay reproduces a map from its seed alone (planning/04 §9), and that is only true if
 * this produces the same stream every time on every engine.
 */

import { describe, expect, it } from 'vitest';

import { createRng, createWander } from '../src/index.js';

describe('createRng', () => {
  it('gives the same stream for the same seed', () => {
    const a = Array.from({ length: 64 }, () => createRng(1234).next());
    const b = Array.from({ length: 64 }, () => createRng(1234).next());

    expect(a).toEqual(b);
  });

  it('gives a different stream for a different seed', () => {
    const a = Array.from({ length: 16 }, () => createRng(1).next());
    const b = Array.from({ length: 16 }, () => createRng(2).next());

    expect(a).not.toEqual(b);
  });

  it('does not repeat itself immediately', () => {
    const rng = createRng(7);
    const values = new Set(Array.from({ length: 500 }, () => rng.next()));

    expect(values.size).toBe(500);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('spreads across the unit interval rather than clustering', () => {
    const rng = createRng(3);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i += 1) {
      const bucket = Math.floor(rng.next() * 10);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    // A loose band. This is a smoke test for a broken mixer, not a statistical test.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1300);
    }
  });

  it('respects range and int bounds, inclusive at both ends for int', () => {
    const rng = createRng(11);
    const seen = new Set<number>();

    for (let i = 0; i < 2000; i += 1) {
      const f = rng.range(-5, 5);
      expect(f).toBeGreaterThanOrEqual(-5);
      expect(f).toBeLessThan(5);
      seen.add(rng.int(0, 3));
    }

    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('forks into an independent stream that is itself reproducible', () => {
    const parentA = createRng(5);
    const parentB = createRng(5);

    expect(parentA.fork(1).next()).toBe(parentB.fork(1).next());

    // Different salts diverge, which is the whole reason fork takes one: two stages of the
    // generator drawing from the same parent must not shadow each other.
    const parent = createRng(5);
    expect(parent.fork(1).next()).not.toBe(createRng(5).fork(2).next());
  });
});

describe('createWander', () => {
  it('is continuous and stays within [-1, 1]', () => {
    const wander = createWander(createRng(1), 6);

    let previous = wander(0);
    for (let t = 0; t <= 1; t += 0.005) {
      const value = wander(t);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
      // No jumps: a curve that hopped would make a zigzag passage rather than a bend.
      expect(Math.abs(value - previous)).toBeLessThan(0.2);
      previous = value;
    }
  });

  it('clamps outside the unit interval rather than running away', () => {
    const wander = createWander(createRng(2), 4);

    expect(wander(-3)).toBe(wander(0));
    expect(wander(4)).toBe(wander(1));
  });

  it('actually varies', () => {
    const wander = createWander(createRng(3), 8);
    const samples = Array.from({ length: 40 }, (_, i) => wander(i / 39));

    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3);
  });
});
