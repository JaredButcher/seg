/**
 * @seg/shared/protocol/channels — which channel a message belongs on.
 *
 * [planning/02 §3](../../../../planning/02-netcode-protocol.md) names three channels and says
 * what each carries. Until now that was prose: `WsTransport.send` ignores its `channel` argument
 * and the gateway passes `'control'` for everything, which is *correct* — one reliable ordered
 * socket is a superset of all three guarantees — and also means nothing in the tree can answer
 * "how many bytes went out on `view` this second".
 *
 * This file is that answer, and it is deliberately only that. It is a pure total function from a
 * message to a channel name. It does not route, it does not send, and nothing changes behaviour
 * by importing it. What it buys today is per-channel accounting
 * ([planning/17 §4.2](../../../../planning/17-netcode-performance.md)); what it buys later is the
 * `Link`'s lookup table, already written and already tested, on the day a second transport exists
 * (planning/01 §4.1a, planning/02 §9 step 1).
 *
 * ## The rule that decides every case
 *
 * A message goes on `view` **only if losing it is better than delaying it** — that is what
 * unreliable-sequenced delivery means, and a view frame is superseded 100 ms later, so dropping
 * a stale one beats retransmitting it behind head-of-line blocking (planning/02 §3).
 *
 * A message goes on `commands` if it is a client→server order about the world. Those are
 * reliable-ordered on both transports, which is why planning/02 §9 moves them first: the handover
 * gets exercised where a mistake is cheap.
 *
 * **Everything else is `control`, and `control` never migrates** (planning/02 §3.1). When in doubt
 * the answer is `control`, because reliable-ordered is a superset and the cost of being wrong in
 * that direction is bandwidth rather than correctness.
 */

import type { ChannelId, Message } from './schema.js';

/**
 * The channel a message travels on.
 *
 * Total by construction: the map below is keyed by every type tag on the wire, and the fallback
 * is `control` rather than a throw. A new message type that nobody adds here gets the safe
 * channel and a slightly wrong bandwidth attribution, which is the right failure — a protocol
 * addition should never be able to break a session by being forgotten in a lookup table.
 * `protocol-channels.test.ts` is what stops it being forgotten *quietly*.
 */
export function channelFor(message: Message): ChannelId {
  return CHANNELS[message.t] ?? 'control';
}

/**
 * Type tag → channel, for every message in the schema.
 *
 * Written out rather than derived from a prefix, because the prefixes do not agree with the
 * channels and pretending they do would be a bug waiting for the first exception. `match.view` is
 * droppable and `match.state` is not; `debug.stats` is droppable and `debug.setStats` is not.
 * The `.` in a type tag says which *file* declares it, never which channel carries it.
 */
const CHANNELS: Readonly<Record<string, ChannelId>> = {
  // ── control ──────────────────────────────────────────────────────────────────────
  // Handshake and session.
  welcome: 'control',
  'session.replaced': 'control',
  ping: 'control',
  pong: 'control',

  // All lobby traffic, permanently (planning/02 §3.1 reason 1: the lobby is upstream of the
  // WebRTC negotiation, so it cannot depend on a data channel existing).
  'lobby.create': 'control',
  'lobby.join': 'control',
  'lobby.leave': 'control',
  'lobby.exit': 'control',
  'lobby.kick': 'control',
  'lobby.list': 'control',
  'lobby.list.result': 'control',
  'lobby.modify': 'control',
  'lobby.rejected': 'control',
  'lobby.selectFleet': 'control',
  'lobby.setPosition': 'control',
  'lobby.setReady': 'control',
  'lobby.start': 'control',
  'lobby.state': 'control',

  // Match lifecycle. `match.state` is the static half and travels once (planning/02 §6's whole
  // bandwidth argument rests on it being reliable and rare), so it is emphatically not `view`.
  'match.started': 'control',
  'match.state': 'control',
  'match.results': 'control',
  'match.rejoin': 'control',
  'match.rejoinable': 'control',

  // Chat. Human-paced, and a dropped line is a line the player never sees.
  'chat.send': 'control',
  'chat.message': 'control',
  'chat.rejected': 'control',

  // Debug *requests* and their one-shot answers. A toggle that goes missing leaves an overlay
  // switched on for the rest of the match, which is exactly the failure `control` exists for.
  'debug.setField': 'control',
  'debug.setReach': 'control',
  'debug.setStats': 'control',
  'debug.setVision': 'control',
  'debug.spawn': 'control',
  'debug.probe': 'control',
  'debug.reading': 'control',

  // ── commands ─────────────────────────────────────────────────────────────────────
  // Client → server orders about the world. Reliable-ordered on both transports.
  'nav.order': 'commands',
  'nav.throttle': 'commands',
  'nav.cancel': 'commands',
  'weapon.fire': 'commands',
  'weapon.load': 'commands',
  'weapon.drop': 'commands',
  'match.setActiveSonar': 'commands',

  // ── view ─────────────────────────────────────────────────────────────────────────
  // Server → client per-tick snapshots. Each is superseded by the next, which is the entire
  // argument for a droppable channel (planning/02 §3).
  'match.view': 'view',
  // The debug overlays are per-tick snapshots on the same terms — a stale field map is worth
  // less than the next one — so they belong with the frames they are drawn over rather than
  // with the toggles that asked for them.
  'debug.field': 'view',
  'debug.reach': 'view',
  'debug.stats': 'view',
};

/** Every type tag the table knows, for the test that keeps it exhaustive. */
export const CHANNELLED_TYPES: readonly string[] = Object.keys(CHANNELS);
