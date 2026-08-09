/**
 * @seg/shared/protocol/match — the match messages.
 *
 * Three shapes, and the split between them is the data model's split (planning/06 §1, Q21):
 *
 * - **`match.started`** — a one-shot "the match has begun, leave the lobby view" signal, on
 *   `control`. It carries an id and nothing else, so re-sending it is never a data update.
 * - **`match.state`** — the static half, on `control`: the map, the roster, your team's boats
 *   and their stat blocks, where the objectives are. Built per recipient (see `MatchSetup`),
 *   and re-sent whole to a player who reconnects.
 * - **`match.view`** — the volatile half, on `view`: the clock, the scores, and where your
 *   boats are. One per acoustic solve, 10 Hz, once there is a simulation producing them.
 *
 * Every one of them is interpretable alone. That is not a nicety — `control` and `view` will
 * be on different transports after WebRTC lands, and no message may depend on the arrival
 * order of one on another channel (planning/02 §3.3). A view frame that meant nothing without
 * the `match.state` before it would be a bug that stays invisible until a data channel is
 * fast and a WebSocket is briefly slow.
 */

import type { MatchSetup, MatchViewState } from '../match/view.js';
import type { MatchId } from '../match/state.js';
import type { EntityId } from '../match/world.js';
import type { Envelope } from './schema.js';

export type { MatchId };

// ── client → server ─────────────────────────────────────────────────────────────────

/**
 * Throw one boat's active sonar switch (planning/03 §3).
 *
 * **The first command in the game**, and it sets the shape the rest will take. Three properties
 * are worth stating because every later order has to have them too:
 *
 * - It names a boat by id and nothing else. The client does not say *when* — the server stamps
 *   the tick — and it does not say what the resulting state is, only what it is asking for.
 * - It is **idempotent**. `active: true` on a boat already pinging is a no-op rather than an
 *   extra pulse, so a duplicate delivered by an unreliable `commands` channel is harmless. That
 *   is the property that lets the channel be unreliable at all (planning/02 §3.2).
 * - The server answers with a view frame, not with an acknowledgement. There is no
 *   `match.accepted`: the frame the player is already receiving carries `activeSonar`, so the
 *   switch flipping *is* the confirmation and a rejected command is simply one where it does
 *   not flip.
 *
 * It rides `control` today with everything else, and belongs on `commands` when that channel
 * exists.
 */
export interface MatchSetActiveSonarMessage extends Envelope {
  readonly t: 'match.setActiveSonar';
  /** The boat to switch. Must be one the sender commands; the server checks and drops if not. */
  readonly boat: EntityId;
  readonly active: boolean;
}

export type MatchClientMessage = MatchSetActiveSonarMessage;

// ── server → client ─────────────────────────────────────────────────────────────────

/** "A match has begun." Sent to every member of the starting lobby. */
export interface MatchStartedMessage extends Envelope {
  readonly t: 'match.started';
  readonly matchId: MatchId;
}

/**
 * The static half of a match, addressed to one recipient.
 *
 * Sent to every member when the match starts, and re-sent to a player who reconnects (Q21) —
 * which is exactly why it is separate from `match.started`: the data does not change when the
 * event happens again.
 */
export interface MatchStateMessage extends Envelope {
  readonly t: 'match.state';
  readonly matchId: MatchId;
  readonly setup: MatchSetup;
}

/**
 * One view frame.
 *
 * `baseSeq` is the baseline this frame is encoded against (planning/02 §3.4): `null` means a
 * keyframe carrying the whole picture. **Every frame is a keyframe today**, because with no
 * simulation there is exactly one frame per match and a differ would have nothing to diff.
 * The field is here rather than added later because the alternative is a protocol change on
 * the day deltas arrive, and because a client written against a shape that cannot express a
 * delta will have assumed a whole picture everywhere.
 *
 * The matching acknowledgement — the client's highest applied `seq`, piggybacked on the
 * command channel — arrives with the commands it rides on.
 */
export interface MatchViewMessage extends Envelope {
  readonly t: 'match.view';
  readonly matchId: MatchId;
  /** Monotonic per connection. What an ack names, and what a stale frame is detected by. */
  readonly seq: number;
  /** The simulation tick this frame describes. */
  readonly tick: number;
  /** The baseline this frame is a delta against, or `null` for a keyframe. */
  readonly baseSeq: number | null;
  readonly view: MatchViewState;
}

export type MatchServerMessage = MatchStartedMessage | MatchStateMessage | MatchViewMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createSetActiveSonar(boat: EntityId, active: boolean): MatchSetActiveSonarMessage {
  return { t: 'match.setActiveSonar', boat, active };
}

export function createMatchStarted(matchId: MatchId): MatchStartedMessage {
  return { t: 'match.started', matchId };
}

export function createMatchState(setup: MatchSetup): MatchStateMessage {
  return { t: 'match.state', matchId: setup.matchId, setup };
}

/** A keyframe. There is no delta constructor yet, deliberately — see `MatchViewMessage`. */
export function createMatchView(
  matchId: MatchId,
  seq: number,
  view: MatchViewState,
): MatchViewMessage {
  return { t: 'match.view', matchId, seq, tick: view.clock.tick, baseSeq: null, view };
}
