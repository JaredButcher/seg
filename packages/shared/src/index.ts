/**
 * @seg/shared — the simulation, map generation, content tables, and wire protocol.
 *
 * This package must run identically in Node and the browser: no I/O, no Node builtins,
 * no DOM. Both @seg/server and @seg/client import it, which is what keeps the content
 * tables, the wire schema, and the kinematics from drifting between the two.
 *
 * Enforced by ESLint (see eslint.config.js) and by this package's tsconfig, which
 * deliberately provides neither @types/node nor the DOM lib.
 */

export * from './auth/index.js';
export * from './content/index.js';
export * from './fleet/index.js';
export * from './lobby/index.js';
export * from './map/index.js';
export * from './protocol/lobby.js';
export * from './protocol/schema.js';

export const PROTOCOL_VERSION = 1;

/** Simulation ticks per second. Movement, collision, and torpedo fuzing. planning/04 §1. */
export const SIM_TICK_HZ = 20;

/** Acoustic solve and network view frames — every second sim tick. planning/03 §10. */
export const ACOUSTIC_TICK_HZ = 10;

export const SIM_TICK_SECONDS = 1 / SIM_TICK_HZ;
