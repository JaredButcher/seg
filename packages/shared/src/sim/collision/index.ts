/**
 * @seg/shared/sim/collision — step 4 of the tick (planning/04 §1).
 *
 * `geometry.ts` is the polygon arithmetic, `terrain.ts` is the map's rock and the test against it,
 * `hulls.ts` is boats against each other and what that costs, and `phase.ts` is the phase the
 * runtime calls once per tick. The shape everything is tested against is the authored silhouette
 * in `content/hulls.ts` — the same polygon the fleet editor draws and the acoustic model reflects
 * sound off, which is the sharing that file asks for in as many words.
 */

export * from './geometry.js';
export * from './hulls.js';
export * from './phase.js';
export * from './terrain.js';
