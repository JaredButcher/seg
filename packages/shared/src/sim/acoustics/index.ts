/**
 * @seg/shared/sim/acoustics — the sonar model (planning/03).
 *
 * `lattice.ts` is where the water is, `skin.ts` is every square metre that can reflect,
 * `field.ts` is how far a sound has had to travel to reach a place, and `solve.ts` puts the
 * three together into one acoustic tick: a heatmap of background noise, and per team the
 * squares whose reflection came back loud enough to see. `boats.ts` is the translation from a
 * `BoatState` into the four numbers the solver actually wants.
 *
 * The tuning — every decibel in the game — is in `content/acoustics.ts`, not here.
 */

export * from './boats.js';
export * from './field.js';
export * from './lattice.js';
export * from './skin.js';
export * from './solve.js';
