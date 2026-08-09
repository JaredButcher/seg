/**
 * xoshiro128** — the seeded PRNG everything deterministic draws from (planning/01 §6).
 *
 * The simulation and the map generator must be pure functions of `(seed, inputs)`: replays
 * store a seed rather than geometry (planning/04 §9), the server generates a map once and
 * ships it to clients where a mismatch is a desync, and the generator's property tests run
 * the same seed hundreds of times expecting the same answer. `Math.random()` is banned under
 * `sim/` and `map/` by lint for exactly this reason; this is what replaces it.
 *
 * xoshiro128** is chosen over a bare LCG because it is small, fast, and has no obvious
 * structure in the low bits — an LCG's low bits are notoriously periodic, and a generator
 * that samples "which side does this passage bend" off a low bit would produce visibly
 * regular maps. It is not cryptographic and does not need to be.
 *
 * All arithmetic is forced through 32-bit integer ops (`| 0`, `>>> 0`, `Math.imul`), so the
 * sequence is bit-identical on every engine rather than drifting with float precision.
 */

export interface Rng {
  /** The next float in [0, 1). */
  next(): number;
  /** A float in [min, max). */
  range(min: number, max: number): number;
  /** An integer in [min, max], inclusive at both ends. */
  int(min: number, max: number): number;
  /** True with the given probability. `chance(0)` is never, `chance(1)` is always. */
  chance(probability: number): boolean;
  /**
   * An independent stream derived from this one and a salt.
   *
   * Worth having: it means adding a draw to one stage — another chamber, say — does not
   * shift every number every later stage pulls, so a generator change perturbs the part it
   * touched instead of reshuffling the whole map. Same salt, same parent seed, same stream.
   */
  fork(salt: number): Rng;
}

/** Mixes a single integer into a well-distributed 32-bit stream, to seed the state words. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function createRng(seed: number): Rng {
  const mix = splitmix32(seed);
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();

  // xoshiro's state must not be all zero, or it stays there forever. Astronomically
  // unlikely from splitmix, and a one-line guard rather than a latent silent failure.
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  function next32(): number {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;

    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);

    return result;
  }

  const rng: Rng = {
    // Divided by 2^32 rather than masked, so the whole 32-bit word contributes.
    next: () => next32() / 4294967296,
    range: (min, max) => min + (next32() / 4294967296) * (max - min),
    int: (min, max) => min + Math.floor((next32() / 4294967296) * (max - min + 1)),
    chance: (probability) => next32() / 4294967296 < probability,
    fork: (salt) => createRng((next32() ^ Math.imul(salt, 0x9e3779b9)) >>> 0),
  };

  return rng;
}

/**
 * Smooth 1-D value noise on [0, 1], from a fixed number of seeded control points.
 *
 * The map's routes need to *wander* rather than jitter: a passage whose centreline hops
 * cell to cell is a zigzag, not a cave. Interpolating a handful of control points with a
 * smoothstep gives a continuous curve with a controllable wavelength, which is all the
 * generator needs and is far less machinery than Perlin noise.
 *
 * Returns a function of `t ∈ [0, 1]` yielding a value in [-1, 1].
 */
export function createWander(rng: Rng, controlPoints: number): (t: number) => number {
  const count = Math.max(2, controlPoints);
  const points = Array.from({ length: count }, () => rng.range(-1, 1));

  return (t: number) => {
    const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const scaled = clamped * (count - 1);
    const index = Math.min(count - 2, Math.floor(scaled));
    const local = scaled - index;
    // Smoothstep, so the curve has no corners where control points meet.
    const eased = local * local * (3 - 2 * local);
    const a = points[index] ?? 0;
    const b = points[index + 1] ?? 0;
    return a + (b - a) * eased;
  };
}
