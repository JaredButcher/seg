/**
 * @seg/shared/match/results — how a match ended, and what everyone did in it.
 *
 * Two things live here: the **rule** that decides a match is over (`decideMatch`) and the
 * **record** of it that everyone is then shown (`buildResults`). They are together because the
 * second is meaningless without the first — a results screen is a claim about why the match
 * stopped, and a screen that computed its own answer from the same state would eventually
 * disagree with the server that stopped it.
 *
 * ## Everything in here is public
 *
 * This is the one match payload that is **not** narrowed per recipient (`view.ts`), and that is
 * deliberate rather than an oversight. The match is over: there is no next decision to protect,
 * and the whole value of the screen is that it finally answers the questions the fog spent
 * thirty minutes refusing — where they were, what they brought, and which of your shots actually
 * landed (planning/06 §5, "The Reveal"). Withholding the enemy's fleet here would make the
 * screen a scoreboard rather than a teacher.
 *
 * So there is one `MatchResults` per match, built once, sent to both sides and to spectators.
 *
 * ## Why the per-boat tally is not on the boat
 *
 * `BoatState` is the shape the simulation advances twenty times a second and the shape every
 * phase copies to mutate. A running total of damage dealt is not something the world does to a
 * boat — no rule in the simulation reads it — so it is carried beside the fleet by whatever is
 * keeping score (`server/match/runtime.ts`) and folded in here at the end. What the simulation
 * owes is *events*: a detonation's hits, a capture's occupants, a hull's status changing. Those
 * it already reports.
 *
 * ## What is deliberately not here yet
 *
 * The acoustic report (planning/06 §5, panel 5) — time detected, the depth trace, cavitation
 * time, first blood. `secondsDetected` is carried on `TeamStanding` and is still always zero,
 * because nothing tracks it yet; it appears in `TeamResult` so the tiebreak below has a number to
 * read and so the day it is tracked is a day nothing on the wire moves. The Reveal, the awards,
 * and per-player assists and damage-taken wait on the same milestone.
 */

import type { HullId } from '../content/hulls.js';
import type { GameMode } from '../lobby/settings.js';
import type { AccountId } from '../lobby/state.js';
import type { MatchId, MatchState, TeamStanding } from './state.js';
import { TEAM_IDS, type BoatState, type EntityId, type TeamId } from './world.js';

// ── The decision ────────────────────────────────────────────────────────────────────

/**
 * Why a match stopped.
 *
 * The first three are the three planning/06 §2 gives. `score` is Objective Capture's target
 * reached; `wipe` is a fleet destroyed, which is Deathmatch's win condition and — see
 * `decideMatch` — ends an Objective Capture match too; `time` is the 30-minute clock running out,
 * where whoever is ahead on the mode's own measure wins. `abandoned` is not a game-design
 * condition at all — see `decideAbandonment`.
 */
export type WinReason = 'score' | 'wipe' | 'time' | 'abandoned';

/** Who won, or that nobody did. A draw is rare and real — see `decideMatch`. */
export type MatchWinner = TeamId | 'draw';

export interface MatchDecision {
  readonly winner: MatchWinner;
  readonly reason: WinReason;
}

/** The headline, for a screen or a log. Present tense of the thing that ended it. */
export function describeWinReason(reason: WinReason): string {
  switch (reason) {
    case 'score':
      return 'SCORE TARGET REACHED';
    case 'wipe':
      return 'FLEET DESTROYED';
    case 'time':
      return 'TIME EXPIRED';
    case 'abandoned':
      return 'MATCH ABANDONED';
  }
}

/**
 * Whether this state ends the match, and how — `null` while it is still being played.
 *
 * Pure in the state, and called once per tick by the runtime. The order of the three checks is
 * the order of their finality:
 *
 * 1. **A wipe ends it in both modes.** Deathmatch says so outright (§2.1). Objective Capture does
 *    not mention it, but boats never respawn, so a side with nothing in the water cannot contest
 *    another objective for the rest of the clock — playing that out is twenty minutes of one team
 *    driving between circles. Ending it is the same judgement Deathmatch already made.
 * 2. **The score target**, in Objective Capture only. Deathmatch's `score` is always zero.
 * 3. **The clock**, comparing whatever the mode is played for: captures in Objective Capture,
 *    surviving fleet points in Deathmatch — where a damaged boat is worth half, which is what
 *    makes hiding a losing strategy for whoever is behind (§2.1).
 *
 * A **draw** is possible at every step and is not smoothed over. Two fleets that finish each
 * other in the same tick drew; two teams level on points at 30:00 with the same time detected
 * drew. Inventing a winner from, say, the lower team number would be inventing a rule.
 */
export function decideMatch(state: MatchState): MatchDecision | null {
  if (state.phase === 'complete') return null;

  const [team1, team2] = [state.teams.team1, state.teams.team2];

  // A team that brought nothing is not a team that has been wiped out. Nothing in the lobby
  // produces one today, and reading it as a wipe would end such a match on tick one.
  const wiped = (team: TeamStanding): boolean => team.boatsTotal > 0 && team.boatsAlive === 0;
  if (wiped(team1) || wiped(team2)) {
    if (wiped(team1) && wiped(team2)) return { winner: 'draw', reason: 'wipe' };
    return { winner: wiped(team1) ? 'team2' : 'team1', reason: 'wipe' };
  }

  if (state.mode === 'objective-capture') {
    if (TEAM_IDS.some((team) => state.teams[team].score >= state.scoreTarget)) {
      return { winner: leader(state), reason: 'score' };
    }
  }

  if (state.clock.remainingSeconds <= 0) return { winner: leader(state), reason: 'time' };

  return null;
}

/**
 * Whether every player has walked away — left, or dropped, and neither has come back
 * (`MatchHandler.departed`/`detach`) — which ends the match the moment it becomes true rather
 * than waiting for a game-design win condition that a fleet nobody is commanding may never
 * trigger.
 *
 * Deliberately separate from `decideMatch`: that function is the three win conditions
 * planning/06 §2 gives, and this is an infrastructural stop, not a fourth one — nobody won,
 * which is why it hands back `'draw'` rather than inventing a winner from an empty room.
 */
export function decideAbandonment(state: MatchState): MatchDecision | null {
  if (state.phase === 'complete') return null;
  if (state.players.length === 0) return null;
  if (state.players.some((player) => player.connected)) return null;
  return { winner: 'draw', reason: 'abandoned' };
}

/**
 * Who is ahead on the mode's own measure, with the tiebreak applied.
 *
 * The tiebreak is **less time detected by the enemy** (planning/06 §2.1) — a real skill measure
 * on the pillar the whole game is built around, rather than a coin toss. It is specified for
 * Deathmatch and applied in both modes here: a level Objective Capture match needs an answer
 * too, and this is the only one the design has ever offered.
 */
function leader(state: MatchState): MatchWinner {
  const measure = (team: TeamStanding): number =>
    state.mode === 'objective-capture' ? team.score : team.survivingPoints;

  const [team1, team2] = [state.teams.team1, state.teams.team2];
  if (measure(team1) !== measure(team2)) return measure(team1) > measure(team2) ? 'team1' : 'team2';

  // The tie proper — including the one case where both sides cross the score target on the same
  // tick with the same total, which two simultaneous captures can produce.
  if (team1.secondsDetected !== team2.secondsDetected) {
    return team1.secondsDetected < team2.secondsDetected ? 'team1' : 'team2';
  }
  return 'draw';
}

// ── The tally ───────────────────────────────────────────────────────────────────────

/**
 * What one boat did, accumulated over the match by whoever is keeping score.
 *
 * Deliberately small, and deliberately made of things the simulation already reports as events
 * rather than things it would have to be taught to measure. See the file header on why it does
 * not live on `BoatState`.
 */
export interface BoatTally {
  /**
   * Hit points this boat's weapons took off hulls — every hull, its own side included, because
   * friendly fire is on (Q7) and a results screen that quietly dropped it would be hiding the one
   * number the player most needs to see.
   *
   * Counted as damage that *landed*: a warhead that takes a boat from 4 hp to 0 is credited with
   * 4, not with its full yield. Overkill is not damage dealt.
   */
  readonly damageDealt: number;
  /**
   * The boats it sank, in the order they went down.
   *
   * Credited to the boat that did the most of the damage on the tick a hull reached zero, which
   * is whoever is keeping score's rule to apply (`server/match/runtime.ts`) — a tick applies
   * every warhead at once, so "the killing blow" is otherwise a question about iteration order.
   * A hull that drowns in rock or in a collision is nobody's kill, and no card claims it.
   */
  readonly sank: readonly EntityId[];
  /** Objectives it was standing in when they fell. */
  readonly captures: number;
  readonly torpedoesFired: number;
  /**
   * The simulation tick it was destroyed on, or `null` if it survived.
   *
   * A tick rather than a duration, because the simulation's only clock is the tick count
   * (planning/02 §5) and the duration is a division the results do once at the end.
   */
  readonly destroyedTick: number | null;
}

export const EMPTY_TALLY: BoatTally = {
  damageDealt: 0,
  sank: [],
  captures: 0,
  torpedoesFired: 0,
  destroyedTick: null,
};

// ── The record ──────────────────────────────────────────────────────────────────────

/** A boat that went down, named well enough for the boat that sank it to say so. */
export interface SunkBoat {
  readonly id: EntityId;
  readonly name: string;
  readonly hull: HullId;
  readonly team: TeamId;
}

/** One boat's match. Both fleets' worth of these are sent to everyone — see the file header. */
export interface BoatResult {
  readonly id: EntityId;
  readonly owner: AccountId;
  readonly team: TeamId;
  /** Position in its owner's fleet. The order the cards are drawn in. */
  readonly index: number;
  readonly name: string;
  readonly hull: HullId;
  readonly cost: number;
  /** Hit points left. Zero on a wreck, which is what `sunk` says in one field. */
  readonly hp: number;
  readonly maxHp: number;
  readonly sunk: boolean;
  /** How long it was in the water: to its destruction, or to the end of the match. */
  readonly secondsAlive: number;
  readonly sank: readonly SunkBoat[];
  readonly damageDealt: number;
  readonly captures: number;
  readonly torpedoesFired: number;
}

/**
 * One player's match: who they were, and the boats they brought.
 *
 * Spectators are in the list with `team: null` and no boats, exactly as they are in `MatchState`
 * — every question the results ask has the same answer shape for both, and a second list would
 * be a second thing to keep in step.
 */
export interface PlayerResult {
  readonly accountId: AccountId;
  readonly username: string;
  readonly team: TeamId | null;
  readonly boats: readonly BoatResult[];
}

/** One team's final standing. `TeamStanding` with nothing withheld — the match is over. */
export interface TeamResult {
  readonly team: TeamId;
  readonly score: number;
  readonly survivingPoints: number;
  readonly boatsAlive: number;
  readonly boatsTotal: number;
  /** Still always zero — see the file header. Carried so the day it moves, the wire does not. */
  readonly secondsDetected: number;
}

export interface MatchResults {
  readonly matchId: MatchId;
  readonly mode: GameMode;
  readonly winner: MatchWinner;
  readonly reason: WinReason;
  /** Objective Capture's target, so the screen can say "7 of 10" rather than a bare 7. */
  readonly scoreTarget: number;
  /** How long the match actually ran, which is under 30 minutes whenever it was won early. */
  readonly durationSeconds: number;
  /** Both teams, always in `TEAM_IDS` order. The screen decides which side to draw first. */
  readonly teams: readonly TeamResult[];
  readonly players: readonly PlayerResult[];
}

/**
 * The record of a finished match.
 *
 * Takes the tallies rather than reaching for them, so the whole projection stays pure and a test
 * can hand it a fleet and a map of totals without running a simulation.
 *
 * Boats are grouped under the player who commanded them and players are left in roster order,
 * which is the order the lobby showed and therefore the order both teams have been looking at
 * for half an hour.
 */
export function buildResults(
  state: MatchState,
  decision: MatchDecision,
  tallies: ReadonlyMap<EntityId, BoatTally>,
  tickHz: number,
): MatchResults {
  const endTick = state.clock.tick;
  const named = new Map(state.boats.map((boat) => [boat.id, boat]));

  const resultFor = (boat: BoatState): BoatResult => {
    const tally = tallies.get(boat.id) ?? EMPTY_TALLY;
    return {
      id: boat.id,
      owner: boat.owner,
      team: boat.team,
      index: boat.index,
      name: boat.name,
      hull: boat.hull,
      cost: boat.cost,
      hp: boat.hp,
      maxHp: boat.stats.maxHp,
      sunk: boat.status === 'destroyed',
      secondsAlive: (tally.destroyedTick ?? endTick) / tickHz,
      sank: tally.sank.flatMap((id) => {
        const victim = named.get(id);
        return victim === undefined
          ? []
          : [{ id: victim.id, name: victim.name, hull: victim.hull, team: victim.team }];
      }),
      damageDealt: tally.damageDealt,
      captures: tally.captures,
      torpedoesFired: tally.torpedoesFired,
    };
  };

  return {
    matchId: state.matchId,
    mode: state.mode,
    winner: decision.winner,
    reason: decision.reason,
    scoreTarget: state.scoreTarget,
    durationSeconds: state.clock.elapsedSeconds,
    teams: TEAM_IDS.map((team) => {
      const standing = state.teams[team];
      return {
        team: standing.team,
        score: standing.score,
        survivingPoints: standing.survivingPoints,
        boatsAlive: standing.boatsAlive,
        boatsTotal: standing.boatsTotal,
        secondsDetected: standing.secondsDetected,
      };
    }),
    players: state.players.map((player) => ({
      accountId: player.accountId,
      username: player.username,
      team: player.team,
      boats: state.boats
        .filter((boat) => boat.owner === player.accountId)
        .slice()
        .sort((a, b) => a.index - b.index)
        .map(resultFor),
    })),
  };
}
