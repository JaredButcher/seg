/**
 * @seg/shared/protocol/debug — the browser-console debug commands.
 *
 * The client-to-server messages follow the shape everything else on this channel does
 * (`protocol/weapon.ts`): say what you're asking for, and take the answer in the `match.view`
 * frame already arriving — there is no `debug.accepted`.
 *
 * **`debug.field` is the first exception, and the reason there is a server-to-client message here
 * at all.** An acoustic field is not something a view frame could carry: it is ground truth over
 * the whole map for both sides at once, it is two orders of magnitude larger than a frame, and it
 * goes at its own slower rate (`match/field.ts`). Putting it on `match.view` would mean an
 * optional field on the one payload every match sends ten times a second, whose presence depended
 * on a debug flag — so it is its own message, and a client that never asks never sees it exist.
 *
 * **One message for every field, not one per field.** Which of them is being drawn is a `kind` on
 * the request and on the payload, because they are the same shape end to end — a scalar over the
 * water lattice with a unit and a domain — and the day a fifth one is worth having, it should cost
 * a `FieldSpec` rather than a protocol change.
 *
 * **`debug.reach` is the second, and it is the same argument reached from the other end.** The
 * ping-reach rings are small enough to have ridden the view frame, and they still do not: they
 * are ground truth about both fleets — true positions of transducers a team may never have heard
 * — so putting them on the one payload whose whole job is to withhold exactly that would be one
 * `if` away from a leak that no test outside this feature would catch.
 *
 * **Gated on `LobbySettings.debugMode`, not on anything a client asserts.** A match deploys
 * with `MatchState.debugMode` fixed for its life (`match/deploy.ts`), and `MatchHandler` drops
 * every message here that arrives on a match where it is `false`. A production match nobody
 * turned this on for is therefore immune to a fabricated one — the same defence-in-depth every
 * other command on this channel gets, just against a whole feature rather than one field. The
 * outbound half is gated twice over: the same flag, plus the recipient having asked for it.
 */

import type { Vec2 } from '../map/types.js';
import type { DebugFieldKind, FieldMapView } from '../match/field.js';
import type { ProbeReading } from '../match/probe.js';
import type { PingReachView } from '../match/reach.js';
import type { MatchId } from '../match/state.js';
import type { EntityId, TeamId } from '../match/world.js';
import type { Envelope } from './schema.js';

/**
 * Throw the sender's own fog of war off or back on — spectator-style live vision over both
 * fleets, true positions, while still commanding only their own team.
 */
export interface DebugSetVisionMessage extends Envelope {
  readonly t: 'debug.setVision';
  readonly enabled: boolean;
}

/** What kind of thing `debug.spawn` puts in the water. */
export type DebugSpawnKind = 'sub' | 'torpedo';

/**
 * "Put a `kind` of `subtype` on `team`, at `at`."
 *
 * `subtype` is a `HullId` for a `sub` and a (deployable) `WeaponId` for a `torpedo` — one string
 * field rather than two optional ones, because exactly one of the pair is ever meaningful for a
 * given `kind` and a message that carried both would leave the server to guess which one was
 * meant. The spawned entity is owned by the sender regardless of `team`, so a debug player can
 * spawn and command a boat on either side.
 */
export interface DebugSpawnMessage extends Envelope {
  readonly t: 'debug.spawn';
  readonly kind: DebugSpawnKind;
  readonly subtype: string;
  readonly team: TeamId;
  readonly at: Vec2;
}

/**
 * Draw one acoustic field for the sender, or `null` to stop (`match/field.ts`).
 *
 * Per connection, like `debug.setVision` and for the same reason: it is a fact about what one
 * developer has asked their own screen to draw, not a property of the match. Idempotent, so a
 * duplicate costs nothing, and switching it off stops the sends immediately rather than letting
 * the client discard them — the payload is large enough that "the client ignores it" is not a good
 * enough answer.
 *
 * `boat` names the listener for the fields that have one — `detect` and `imaging` are questions
 * about *somebody's* hydrophone, and `range` about somebody's position. It is sent with every
 * request rather than remembered, so following the scope's selection is a re-send and the server
 * holds no notion of what is picked. A field that needs a boat and is given one that has sunk, or
 * one on the other side, simply stops arriving.
 */
export interface DebugSetFieldMessage extends Envelope {
  readonly t: 'debug.setField';
  /** Which field, or `null` to stop drawing any. */
  readonly kind: DebugFieldKind | null;
  /** The boat the per-listener fields are asked about, or `null` for the ones that need none. */
  readonly boat: EntityId | null;
}

/**
 * Draw the ping-reach rings for the sender, or stop (`match/reach.ts`).
 *
 * A flag rather than a selection, unlike `debug.setField`: there is one set of rings and it covers
 * every active transducer in the match at once, so there is nothing to choose between. Per
 * connection and idempotent, like the two switches above it, and for the same reason — it is a
 * fact about what one developer has asked their own screen to draw.
 *
 * It composes with everything else here rather than replacing it: rings over a `noise` field with
 * the fog thrown off is three switches doing three different jobs, and reading a pulse's reach
 * against the water it is being fired into is most of the point of having both.
 */
export interface DebugSetReachMessage extends Envelope {
  readonly t: 'debug.setReach';
  readonly enabled: boolean;
}

/**
 * "Read me everything about this point, against this boat" (`match/probe.ts`).
 *
 * **The one debug message that is a question rather than a switch**, and the only one with an
 * answer of its own: the other three change what the connection is *sent from then on*, where this
 * asks for one reading, once, and is done. So it is the only place on this channel where a reply
 * carries the answer instead of the next view frame doing it.
 *
 * Not idempotent and not remembered — asked again is asked again, at whatever the water is doing
 * by then, which is exactly what a developer clicking twice on the same spot means by it.
 *
 * `boat` is the listener the pair-wise half is measured against, sent with the request for the same
 * reason `debug.setField` sends one: which boat is picked is the client's business and it changes
 * as often as the player's selection. `null`, or a boat that has sunk, still gets a reading — the
 * water's own numbers do not need anybody to be listening.
 */
export interface DebugProbeMessage extends Envelope {
  readonly t: 'debug.probe';
  readonly at: Vec2;
  readonly boat: EntityId | null;
}

export type DebugClientMessage =
  | DebugSetVisionMessage
  | DebugSpawnMessage
  | DebugSetFieldMessage
  | DebugSetReachMessage
  | DebugProbeMessage;

// ── server → client ─────────────────────────────────────────────────────────────────

/**
 * One frame of one acoustic field, for a connection that asked for it.
 *
 * Interpretable alone, like every other message on a channel that will not be ordered against the
 * others (planning/02 §3.3): the payload carries its own grid, its own quantization, and its own
 * label, so it needs neither the `match.state` before it nor the view frame beside it. `tick` is
 * the solve it was measured on, which is the only thing a reader needs to line it up against a
 * recording.
 *
 * Sent at `FIELD_MAP_HZ` rather than per frame, so it is normal for several view frames to pass
 * between two of these and for the overlay to be a little older than the boats drawn over it.
 */
export interface DebugFieldMessage extends Envelope {
  readonly t: 'debug.field';
  readonly matchId: MatchId;
  /** The simulation tick the field was measured on. */
  readonly tick: number;
  readonly map: FieldMapView;
}

/**
 * Every active transducer in the match and the two radii of its pulse, for a connection that
 * asked (`match/reach.ts`).
 *
 * Its own message rather than a field on the view frame, for the reason `debug.field` is one: it
 * is ground truth about both fleets — the positions on it are true positions, of pingers a team
 * may never have heard — and its presence depends on a debug flag rather than on anything about
 * the match. A client that never asks never sees one exist.
 *
 * Unlike a field it is **small and it rides the view frame's own cadence**, because it is read
 * against boats that are moving: a ring half a second behind the hull it belongs to would be
 * read as a ring that is off by a boat length, and the payload is a handful of numbers per
 * transducer rather than a map.
 *
 * `rings` is empty rather than absent when nothing in the water is carrying an active transducer,
 * which is the ordinary state of most of a match. That is a reading too — it is what "nobody has
 * their sonar on" looks like — and it is what takes the last frame's rings off the scope.
 */
export interface DebugReachMessage extends Envelope {
  readonly t: 'debug.reach';
  readonly matchId: MatchId;
  /** The simulation tick the rings were measured on. */
  readonly tick: number;
  readonly rings: readonly PingReachView[];
}

/**
 * One point of water, read out in full — the answer to one `debug.probe` (`match/probe.ts`).
 *
 * Sent immediately rather than folded into the next frame, because a probe is a question somebody
 * is waiting on with a panel open: a reading that arrived on the publishing loop's schedule would
 * be up to a frame late for no reason, and would be measured against a world that had moved.
 *
 * A request that cannot be answered — a point off the map, a match before its first solve — is
 * answered with nothing at all. The panel keeps the last reading it had, which is the honest
 * behaviour: the previous answer is still the last thing that was true.
 */
export interface DebugReadingMessage extends Envelope {
  readonly t: 'debug.reading';
  readonly matchId: MatchId;
  /** The simulation tick it was measured on. */
  readonly tick: number;
  readonly reading: ProbeReading;
}

export type DebugServerMessage = DebugFieldMessage | DebugReachMessage | DebugReadingMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createDebugSetVision(enabled: boolean): DebugSetVisionMessage {
  return { t: 'debug.setVision', enabled };
}

export function createDebugSetField(
  kind: DebugFieldKind | null,
  boat: EntityId | null = null,
): DebugSetFieldMessage {
  return { t: 'debug.setField', kind, boat };
}

export function createDebugField(
  matchId: MatchId,
  tick: number,
  map: FieldMapView,
): DebugFieldMessage {
  return { t: 'debug.field', matchId, tick, map };
}

export function createDebugSetReach(enabled: boolean): DebugSetReachMessage {
  return { t: 'debug.setReach', enabled };
}

export function createDebugReach(
  matchId: MatchId,
  tick: number,
  rings: readonly PingReachView[],
): DebugReachMessage {
  return { t: 'debug.reach', matchId, tick, rings };
}

export function createDebugProbe(at: Vec2, boat: EntityId | null): DebugProbeMessage {
  return { t: 'debug.probe', at, boat };
}

export function createDebugReading(
  matchId: MatchId,
  tick: number,
  reading: ProbeReading,
): DebugReadingMessage {
  return { t: 'debug.reading', matchId, tick, reading };
}

export function createDebugSpawn(
  kind: DebugSpawnKind,
  subtype: string,
  team: TeamId,
  at: Vec2,
): DebugSpawnMessage {
  return { t: 'debug.spawn', kind, subtype, team, at };
}
