/**
 * @seg/shared/sim/acoustics — the sonar model (planning/03).
 *
 * `lattice.ts` is where the water is, `skin.ts` is every square metre that can reflect,
 * `field.ts` is how far a sound has had to travel to reach a place, and `solve.ts` puts the
 * three together into one acoustic tick: a heatmap of background noise, and per team the
 * squares whose reflection came back loud enough to see. `boats.ts` and `torpedoes.ts` are the
 * translations from a `BoatState` and a `TorpedoState` into the four numbers the solver actually
 * wants — and they are two files rather than one only because the two entities are loud for
 * entirely different reasons. What the solver receives is the same shape either way.
 *
 * The tuning — every decibel in the game — is in `content/acoustics.ts`, not here.
 */

export * from './boats.js';
export * from './field.js';
export * from './ghosts.js';
export * from './lattice.js';
export * from './skin.js';
export * from './solve.js';
export * from './torpedoes.js';
