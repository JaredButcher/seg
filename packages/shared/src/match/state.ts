/**
 * @seg/shared/match/state — the running match, as the server holds it.
 *
 * Ground truth: every boat on both sides, both teams' scores, the clock. **No part of this
 * shape is sent to a client as it stands.** `view.ts` narrows it per recipient, and that
 * narrowing is the enforcement of "never put ground truth on the wire" (planning/01 §5).
 *
 * There is no simulation behind it yet. What exists is the state a tick would advance and the
 * projections a view frame would carry, so the runtime lands as a loop over a settled shape
 * rather than as a shape and a loop at once.
 */

import type { GameMode } from '../lobby/settings.js';
import type { AccountId } from '../lobby/state.js';
import type { GeneratedMap } from '../map/types.js';
import type { CaptureZone } from './objectives.js';
import type { TorpedoState } from './torpedo.js';
import { survivingValue, type BoatState, type EntityId, type TeamId } from './world.js';

/** Identifies one running match, for the lifetime of the process. */
export type MatchId = string;

// ── Lifecycle ───────────────────────────────────────────────────────────────────────

/**
 * Where a match is in its life (planning/06 §1).
 *
 * Fleet Lock and Loading are lobby-side and never reach this state; Results is a screen, not
 * a phase of the world. Deployment is here and unused: boats are placed by the server today
 * (`deploy.ts`), and the phase becomes reachable when the placement UI exists. Modelling it
 * now costs a union member and saves a protocol change.
 */
export type MatchPhase = 'deployment' | 'active' | 'resolution' | 'complete';

/**
 * Both modes end at 30:00 unless won early, and the timer is **not host-configurable**
 * (planning/06 §3). Tune the score target against this clock, not the other way round.
 */
export const MATCH_DURATION_SECONDS = 30 * 60;

/**
 * Objective Capture's default target (planning/06 §3). Not yet a lobby setting.
 *
 * Ten, because a capture is worth **one point** rather than a trickle per second
 * (`objectives.ts`). Under the earlier per-second scoring the same setting read 1000; a
 * three-figure target against a one-point capture would be a match nobody could finish, so the
 * two numbers move together and this one is meaningless without that file's rules.
 */
export const DEFAULT_SCORE_TARGET = 10;

/**
 * The match clock, as the server last computed it.
 *
 * `tick` is authoritative and the two second counts are derived from it — they are on the
 * wire so the client can render a countdown without knowing the tick rate, and so a change
 * to the tick rate is not a protocol change. The client interpolates between frames; it never
 * treats its own wall clock as the truth (planning/02 §5).
 */
export interface MatchClock {
  readonly tick: number;
  readonly elapsedSeconds: number;
  readonly remainingSeconds: number;
}

// ── Teams and players ───────────────────────────────────────────────────────────────

/**
 * One team's standing. Every field is public to both sides — this is the score line, and a
 * scoreboard that hid the other team's score would not be one.
 *
 * `secondsDetected` is the exception worth naming: it is the deathmatch tiebreak (06 §2.1)
 * and the results screen's headline (04 §11), and it is **only revealed when it can decide
 * the match** (08 §11, element 4). The number is here because the server is the only thing
 * that can compute it; whether the HUD draws it is the HUD's decision.
 */
export interface TeamStanding {
  readonly team: TeamId;
  /** Objective Capture points. Always zero in deathmatch. */
  readonly score: number;
  /** Surviving fleet points, damaged boats at half value (06 §2.1). Deathmatch's score. */
  readonly survivingPoints: number;
  readonly boatsAlive: number;
  readonly boatsTotal: number;
  /** Total seconds any of this team's boats spent detected by the enemy. */
  readonly secondsDetected: number;
}

/**
 * Someone watching the match, whether or not they command anything.
 *
 * `team` is `null` for a spectator. Spectators are modelled as players with no side rather
 * than as a separate list, because every question the match asks — who is connected, who gets
 * a view frame, who may speak in chat — has the same answer shape for both.
 */
export interface MatchPlayer {
  readonly accountId: AccountId;
  readonly username: string;
  readonly team: TeamId | null;
  /**
   * Whether their socket is up. A disconnected player's boats keep their standing orders and
   * the seat is held for the 90 s reconnect window (planning/01 §7) — nothing here expires it.
   */
  readonly connected: boolean;
}

// ── The match ───────────────────────────────────────────────────────────────────────

export interface MatchState {
  readonly matchId: MatchId;
  readonly mode: GameMode;
  readonly phase: MatchPhase;
  readonly map: GeneratedMap;
  /** Epoch ms the match began. Only for display and logs; the clock is authoritative. */
  readonly startedAt: number;
  readonly clock: MatchClock;
  /** Objective Capture's win threshold. Meaningless in deathmatch, carried anyway. */
  readonly scoreTarget: number;
  readonly players: readonly MatchPlayer[];
  readonly teams: Readonly<Record<TeamId, TeamStanding>>;
  /** **Ground truth.** Both teams' boats. Never sent whole — see `view.ts`. */
  readonly boats: readonly BoatState[];
  /**
   * **Ground truth.** Every weapon in the water, both sides. Never sent whole either.
   *
   * A separate list rather than entries in `boats` because almost nothing treats them alike: a
   * torpedo has no tubes, no throttle, no hit points, and no owner who can order it about, and
   * a union would put a dozen `undefined` fields on every submarine in the match. The one place
   * they *are* alike — the acoustic solve — takes both through `AcousticEntity`, which is
   * exactly where planning/04 §4's uniform entity model has to hold and nowhere else.
   *
   * Almost always empty. Torpedoes live under a minute and most of a match has none in flight.
   */
  readonly torpedoes: readonly TorpedoState[];
  /**
   * The next entity id to hand out.
   *
   * On the state rather than in a counter beside the runtime because a torpedo is the first
   * thing in the game created *during* a match, and every mutation in this codebase is a state
   * replacement — a counter living outside would not survive one, and reusing an id is how a
   * stale reference becomes wrong rather than missing (`world.ts#EntityId`).
   */
  readonly nextEntityId: EntityId;
  /**
   * The objectives on the board (`objectives.ts`). Empty in deathmatch.
   *
   * Unlike the boats this is *not* ground truth — both teams see all of it, including the
   * circles sitting in water neither has charted, which is the whole point of the mode
   * (planning/06 §2.2: the enemy must come to known places).
   */
  readonly zones: readonly CaptureZone[];
}

// ── Derived ─────────────────────────────────────────────────────────────────────────

/** A fresh clock at tick zero. */
export function startingClock(durationSeconds = MATCH_DURATION_SECONDS): MatchClock {
  return { tick: 0, elapsedSeconds: 0, remainingSeconds: durationSeconds };
}

/**
 * Recompute a team's standing from the boats on it.
 *
 * The counters are derived rather than incremented, so a destroyed boat cannot leave a
 * standing that disagrees with the fleet — the classic scoreboard bug, and one that is
 * invisible until a match ends on the wrong number. Carried-forward figures (`score`,
 * `secondsDetected`) are the two the caller supplies, because nothing about the current fleet
 * can reconstruct them.
 */
export function standingFor(
  team: TeamId,
  boats: readonly BoatState[],
  carried: { readonly score: number; readonly secondsDetected: number },
): TeamStanding {
  const mine = boats.filter((boat) => boat.team === team);
  return {
    team,
    score: carried.score,
    survivingPoints: mine.reduce((sum, boat) => sum + survivingValue(boat), 0),
    boatsAlive: mine.filter((boat) => boat.status === 'active').length,
    boatsTotal: mine.length,
    secondsDetected: carried.secondsDetected,
  };
}

/** The boats one account commands, in fleet order. */
export function boatsOwnedBy(
  state: Pick<MatchState, 'boats'>,
  accountId: AccountId,
): readonly BoatState[] {
  return state.boats
    .filter((boat) => boat.owner === accountId)
    .slice()
    .sort((a, b) => a.index - b.index);
}

/** Every boat on a team, in owner then fleet order — the fleet list's fixed order (08 §5). */
export function boatsOnTeam(state: Pick<MatchState, 'boats'>, team: TeamId): readonly BoatState[] {
  return state.boats
    .filter((boat) => boat.team === team)
    .slice()
    .sort((a, b) => (a.owner === b.owner ? a.index - b.index : a.owner < b.owner ? -1 : 1));
}
