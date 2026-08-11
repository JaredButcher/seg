/**
 * @seg/shared/protocol/debug — the browser-console debug commands.
 *
 * Both messages follow the shape everything else on this channel does (`protocol/weapon.ts`):
 * say what you're asking for, and take the answer in the `match.view` frame already arriving —
 * there is no `debug.accepted`.
 *
 * **Gated on `LobbySettings.debugMode`, not on anything a client asserts.** A match deploys
 * with `MatchState.debugMode` fixed for its life (`match/deploy.ts`), and `MatchHandler` drops
 * every message here that arrives on a match where it is `false`. A production match nobody
 * turned this on for is therefore immune to a fabricated one — the same defence-in-depth every
 * other command on this channel gets, just against a whole feature rather than one field.
 */

import type { Vec2 } from '../map/types.js';
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

export type DebugClientMessage = DebugSetVisionMessage | DebugSpawnMessage;

// ── helpers ─────────────────────────────────────────────────────────────────────────

export function createDebugSetVision(enabled: boolean): DebugSetVisionMessage {
  return { t: 'debug.setVision', enabled };
}

export function createDebugSpawn(
  kind: DebugSpawnKind,
  subtype: string,
  team: TeamId,
  at: Vec2,
): DebugSpawnMessage {
  return { t: 'debug.spawn', kind, subtype, team, at };
}
