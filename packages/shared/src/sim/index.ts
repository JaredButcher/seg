/**
 * @seg/shared/sim — the simulation (planning/04).
 *
 * Acoustics first, because planning/11 sequences M1 that way and because everything else in
 * the tick loop is easier to test once there is something for a boat to be hunted by. Collision
 * is beside it now; navigation, weapons, and the tracker are still to come.
 *
 * Everything under here must be a pure function of `(seed, state, commands)` — no wall clock,
 * no `Math.random()`, both banned by lint (planning/10 §3) — because a replay stores a seed and
 * expects to get the same match back (planning/04 §9).
 */

export * from './acoustics/index.js';
export * from './collision/index.js';
