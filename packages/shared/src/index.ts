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
export * from './protocol/debug.js';
export * from './protocol/lobby.js';
export * from './protocol/match.js';
export * from './protocol/nav.js';
export * from './protocol/schema.js';
export * from './protocol/weapon.js';

/**
 * Bumped to 8 by the ping alert: `VisionFrame` gains `pings`, the hostile active pulses that lit
 * one of the team's boats hard enough to place the transducer that fired them
 * (`match/vision.ts#HeardPing`). A version-7 client would silently drop the alert and give a
 * pinging enemy the one thing pinging is supposed to cost — anonymity.
 *
 * 7 was the end of a match existing at all.
 *
 * `match.results` is a new server-to-client message and the first one that is *not* narrowed per
 * recipient: it carries both fleets, every boat's fate, and why the match stopped
 * (`match/results.ts`). A version-6 client would play a match that never ended — the server
 * stops ticking it and sends a message the client drops on the floor, leaving a live HUD over a
 * frozen ocean.
 *
 * 6 was two features at once — torpedoes and Objective Capture — which between them
 * move more of the wire than anything since the uncharted map. Both directions change.
 *
 * Torpedoes, client to server: `weapon.fire` and `weapon.load` (`protocol/weapon.ts`) — a salvo
 * at a point, and what a tube should hold next. Server to client: `MatchViewState` gains
 * `torpedoes`, the team's own weapons in the water; `TubeState` gains `next` and an `unloading`
 * status; `RevealedContact` gains a `kind` and its `hull` becomes nullable, because a confirmed
 * contact is now sometimes a weapon rather than a boat; and `VisionFrame` gains `launches`, the
 * hostile tube-firing events the team heard. A version-5 client could not fire, could not read a
 * contact that was not a submarine, and would silently drop the alert that a weapon is in the
 * water.
 *
 * Objective Capture: capture zones move. A captured objective is replaced by a fresh one
 * elsewhere on the map, so `MatchSetup.zones` — a *static* list of positions — is gone, and
 * `MatchViewState.zones` carries the whole zone on every frame: where it is, how big, how long
 * until it arms, who is taking it and how far along. A version-5 client would draw three circles
 * at the places the match started with and never move them.
 *
 * 5 was collision: `BoatSnapshot` carries `transients`, the noise events still ringing
 * on a friendly boat, and a version-4 client would play no cue when one of its own boats hit a
 * wall or another hull. Nothing on the client-to-server side moved — a collision is something the
 * world does to a boat, not something a player asks for.
 *
 * 4 was the first command-layer work, which landed in two steps. Navigation commands
 * (`nav.order`, `nav.cancel`, `nav.throttle`) and `BoatState`'s throttle — three absolute
 * notches (slow/full/flank) rather than six fractions of maximum — arrived with movement;
 * active sonar then added the first client-to-server *command* (`match.setActiveSonar`) and
 * `BoatSnapshot` gaining `activeSonar` and `lastPingTick`. A version-3 client can neither order
 * a boat to go anywhere nor switch a boat's sonar on, and would draw no pulse for one a
 * teammate switched on.
 *
 * (3 was the uncharted map, ADR 0002: `match.state` carries a `MapChart` with no rock and no
 * seed where it used to carry the whole `GeneratedMap`, and `match.view` carries a
 * `VisionFrame`. 2 was the match data model: `match.state` gained a per-recipient `MatchSetup`
 * where it used to carry a bare mode and map.)
 *
 * There are no compatibility shims for 1.0 — client and server deploy together and a mismatch
 * is a reload (planning/02 §8).
 */
export const PROTOCOL_VERSION = 8;

/** Simulation ticks per second. Movement, collision, and torpedo fuzing. planning/04 §1. */
export const SIM_TICK_HZ = 20;

/** Acoustic solve and network view frames — every second sim tick. planning/03 §10. */
export const ACOUSTIC_TICK_HZ = 10;

export const SIM_TICK_SECONDS = 1 / SIM_TICK_HZ;
