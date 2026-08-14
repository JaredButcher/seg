/**
 * @seg/shared/match — the match data model.
 *
 * `world.ts` is what a boat is, `torpedo.ts` is what a weapon in the water is, `tubes.ts` is the
 * loading gear that puts one there, `state.ts` is what a match is, `deploy.ts` puts one on a map,
 * `movement.ts` advances it along its orders, `objectives.ts` is what Objective Capture is played
 * for, `vision.ts` is what a team has managed to hear of it, `view.ts` decides what each player
 * may know about it, `results.ts` decides when it is over and what everyone is then told, and
 * `chat.ts` is the one channel that carries words rather than state. The simulation that advances
 * any of it lands on top of these shapes rather than beside them.
 *
 * `field.ts`, `reach.ts`, `probe.ts` and `perf.ts` are the odd ones out and say so in their own
 * headers: the acoustic model's own state — the water as a field, what one pulse would buy the
 * thing that fired it, every number the model holds about a single point — and what the tick
 * itself is costing, as ground truth for the debug panels, on messages no ordinary match sends.
 */

export * from './chat.js';
export * from './deploy.js';
export * from './movement.js';
export * from './field.js';
export * from './objectives.js';
export * from './perf.js';
export * from './probe.js';
export * from './reach.js';
export * from './results.js';
export * from './state.js';
export * from './torpedo.js';
export * from './tubes.js';
export * from './view.js';
export * from './vision.js';
export * from './world.js';
