/**
 * @seg/shared/match — the match data model.
 *
 * `world.ts` is what a boat is, `state.ts` is what a match is, `deploy.ts` puts one on a map,
 * `vision.ts` is what a team has managed to hear of it, `view.ts` decides what each player may
 * know about it, and `chat.ts` is the one channel that carries words rather than state. The
 * simulation that advances any of it lands on top of these shapes rather than beside them.
 */

export * from './chat.js';
export * from './deploy.js';
export * from './state.js';
export * from './view.js';
export * from './vision.js';
export * from './world.js';
