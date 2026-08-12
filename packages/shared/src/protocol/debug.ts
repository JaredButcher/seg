/**
 * @seg/shared/protocol/debug — the browser-console debug commands.
 *
 * The client-to-server messages follow the shape everything else on this channel does
 * (`protocol/weapon.ts`): say what you're asking for, and take the answer in the `match.view`
 * frame already arriving — there is no `debug.accepted`.
 *
 * **`debug.noise` is the one exception, and the reason there is a server-to-client message here
 * at all.** A noise heatmap is not something a view frame could carry: it is ground truth over
 * the whole map for both sides at once, it is two orders of magnitude larger than a frame, and it
 * goes at its own slower rate (`match/noise.ts`). Putting it on `match.view` would mean an
 * optional field on the one payload every match sends ten times a second, whose presence depended
 * on a debug flag — so it is its own message, and a client that never asks never sees the field
 * exist.
 *
 * **Gated on `LobbySettings.debugMode`, not on anything a client asserts.** A match deploys
 * with `MatchState.debugMode` fixed for its life (`match/deploy.ts`), and `MatchHandler` drops
 * every message here that arrives on a match where it is `false`. A production match nobody
 * turned this on for is therefore immune to a fabricated one — the same defence-in-depth every
 * other command on this channel gets, just against a whole feature rather than one field. The
 * outbound half is gated twice over: the same flag, plus the recipient having asked for it.
 */

import type { Vec2 } from '../map/types.js';
import type { NoiseMapView } from '../match/noise.js';
import type { MatchId } from '../match/state.js';
import type { TeamId } from '../match/world.js';
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
 * Start or stop the noise-heatmap overlay for the sender (`match/noise.ts`).
 *
 * Per connection, like `debug.setVision` and for the same reason: it is a fact about what one
 * developer has asked their own screen to draw, not a property of the match. Idempotent, so a
 * duplicate costs nothing, and switching it off stops the sends immediately rather than letting
 * the client discard them — the payload is large enough that "the client ignores it" is not a
 * good enough answer.
 */
export interface DebugSetNoiseMessage extends Envelope {
  readonly t: 'debug.setNoise';
  readonly enabled: boolean;
}

export type DebugClientMessage = DebugSetVisionMessage | DebugSpawnMessage | DebugSetNoiseMessage;

// ── server → client ─────────────────────────────────────────────────────────────────

/**
 * One frame of the noise heatmap, for a connection that asked for it.
 *
 * Interpretable alone, like every other message on a channel that will not be ordered against
 * the others (planning/02 §3.3): the payload carries its own grid and its own quantization, so it
 * needs neither the `match.state` before it nor the view frame beside it. `tick` is the solve it
 * was measured on, which is the only thing a reader needs to line it up against a recording.
 *
 * Sent at `NOISE_MAP_HZ` rather than per frame, so it is normal for several view frames to pass
 * between two of these and for the overlay to be a little older than the boats drawn over it.
 */
export interface DebugNoiseMessage extends Envelope {
  readonly t: 'debug.noise';
  readonly matchId: MatchId;
  /** The simulation tick the heatmap was solved on. */
  readonly tick: number;
  readonly map: NoiseMapView;
}

export type DebugServerMessage = DebugNoiseMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createDebugSetVision(enabled: boolean): DebugSetVisionMessage {
  return { t: 'debug.setVision', enabled };
}

export function createDebugSetNoise(enabled: boolean): DebugSetNoiseMessage {
  return { t: 'debug.setNoise', enabled };
}

export function createDebugNoise(
  matchId: MatchId,
  tick: number,
  map: NoiseMapView,
): DebugNoiseMessage {
  return { t: 'debug.noise', matchId, tick, map };
}

export function createDebugSpawn(
  kind: DebugSpawnKind,
  subtype: string,
  team: TeamId,
  at: Vec2,
): DebugSpawnMessage {
  return { t: 'debug.spawn', kind, subtype, team, at };
}
