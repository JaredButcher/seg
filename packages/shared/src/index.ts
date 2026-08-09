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
export * from './match/index.js';
export * from './math/index.js';
export * from './protocol/chat.js';
export * from './sim/index.js';
export * from './protocol/lobby.js';
export * from './protocol/match.js';
export * from './protocol/nav.js';
export * from './protocol/schema.js';

/**
 * Bumped to 4 by the navigation commands: the client gained `nav.order`, `nav.cancel`, and
 * `nav.throttle`, and `BoatState`'s throttle is three absolute notches (slow/full/flank) rather
 * than six fractions of maximum. A version-3 client cannot order a boat to go anywhere.
 *
 * (3 was the uncharted map (ADR 0002): `match.state` carries a `MapChart` with no rock and no
 * seed where it used to carry the whole `GeneratedMap`, and `match.view` carries a
 * `VisionFrame`. A version-2 client would render an empty ocean and never fill it in.
 *
 * (2 was the match data model: `match.state` gained a per-recipient `MatchSetup` where it used
 * to carry a bare mode and map.)
 *
 * There are no compatibility shims for 1.0 — client and server deploy together and a mismatch
 * is a reload (planning/02 §8).
 */
export const PROTOCOL_VERSION = 4;

/** Simulation ticks per second. Movement, collision, and torpedo fuzing. planning/04 §1. */
export const SIM_TICK_HZ = 20;

/** Acoustic solve and network view frames — every second sim tick. planning/03 §10. */
export const ACOUSTIC_TICK_HZ = 10;

export const SIM_TICK_SECONDS = 1 / SIM_TICK_HZ;
