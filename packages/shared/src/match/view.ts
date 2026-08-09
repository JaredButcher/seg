/**
 * @seg/shared/match/view — what one player is allowed to know.
 *
 * The server holds ground truth (`state.ts`); this file is the only way any of it reaches a
 * client. That is the whole enforcement of planning/01 §5 rule 2 — there is no filtering step
 * a caller can forget, because the shapes a connection can send simply do not have fields for
 * the things it must not learn.
 *
 * ## The two halves, and why they are separate messages
 *
 * **`MatchSetup`** is everything that does not change: the map, the roster, your team's boats
 * and their stat blocks. It travels once in `match.state`, and again to a player who
 * reconnects (Q21).
 *
 * **`MatchViewState`** is everything that does: the clock, the scores, where your boats are
 * and what they are doing. It travels in `match.view` at the view frame rate.
 *
 * The split is what makes a view frame small. A boat's name, hull, and thirteen stats are a
 * couple of hundred bytes that never change; sending them ten times a second for a ten-boat
 * fleet is most of the bandwidth budget (planning/02 §6) spent on a constant.
 *
 * ## What is deliberately absent
 *
 * - **The map.** A playing client is sent a `MapChart` — extents, scale, and no rock at all.
 *   Terrain reaches a spectator and nobody else, and the seed reaches nobody, because map
 *   generation is pure and lives in a package the client bundles (`match/vision.ts`, ADR 0002).
 * - **Enemy boats.** They appear only through `VisionFrame`: squares while they are merely
 *   heard, a revealed silhouette once the server confirms them.
 * - **Alerts.** A product of sensing, and inventing its shape before the tracker exists would
 *   be inventing the answer. Added when it can be filled in.
 * - **`secondsDetected`.** The tiebreak stat (planning/06 §2.1) is tracked per team and never
 *   sent live, in either direction. Your own figure rising would tell you the enemy can hear
 *   you *right now* — which is precisely the thing the game is about not knowing. It is
 *   revealed on the results screen, and in the HUD only when it can decide the match
 *   (planning/08 §11, element 4), by which point the match is over.
 */

import type { HullId } from '../content/hulls.js';
import type { Stats } from '../content/stats.js';
import type { GameMode } from '../lobby/settings.js';
import type { AccountId } from '../lobby/state.js';
import type { Vec2 } from '../map/types.js';
import type { MatchClock, MatchId, MatchPhase, MatchState } from './state.js';
import { chartOf, NO_VISION, type MapChart, type VisionFrame } from './vision.js';
import {
  isCavitating,
  TEAM_IDS,
  type BoatTransient,
  type EntityId,
  type StandingOrder,
  type BoatStatus,
  type TeamId,
  type ThrottleNotch,
  type TubeState,
} from './world.js';

// ── The static half ─────────────────────────────────────────────────────────────────

/** A boat's unchanging half. Sent for your own team's boats only. */
export interface BoatProfile {
  readonly id: EntityId;
  readonly owner: AccountId;
  readonly team: TeamId;
  readonly index: number;
  readonly name: string;
  readonly hull: HullId;
  /**
   * The fitted stat block. Teammates' too: an ally's crush depth and clearance decide where
   * they can go, and a team that cannot read each other's limits cannot plan around them.
   */
  readonly stats: Stats;
  readonly cost: number;
}

/** Who is in the match. Public — the lobby roster was public and nothing here narrows it. */
export interface MatchPlayerProfile {
  readonly accountId: AccountId;
  readonly username: string;
  readonly team: TeamId | null;
}

/** The recipient's own place in the match. */
export interface MatchSelf {
  readonly accountId: AccountId;
  /** `null` for a spectator, who commands nothing. */
  readonly team: TeamId | null;
}

export interface MatchSetup {
  readonly matchId: MatchId;
  readonly mode: GameMode;
  /**
   * The ocean's size and scale — and, for a spectator, its rock.
   *
   * A player begins a match with an **uncharted** map and fills it in by sonar (ADR 0002,
   * which reverses C12). What they are given for free is the frame: how wide the world is, how
   * deep, and therefore where the surface and the seabed are. Everything between is earned.
   */
  readonly map: MapChart;
  readonly startedAt: number;
  readonly scoreTarget: number;
  readonly you: MatchSelf;
  readonly players: readonly MatchPlayerProfile[];
  /**
   * Your team's boats. Empty for a spectator until spectator vision is settled (07 §5) —
   * "team-limited or god view" is a lobby setting that does not exist yet, and guessing wrong
   * would hand an observer the whole board.
   */
  readonly fleet: readonly BoatProfile[];
}

// ── The volatile half ───────────────────────────────────────────────────────────────

/** One friendly boat, as of this frame. */
export interface BoatSnapshot {
  readonly id: EntityId;
  readonly pos: Vec2;
  readonly facing: number;
  readonly speed: number;
  readonly throttle: ThrottleNotch;
  readonly hp: number;
  /**
   * Sent rather than derived from `speed`. The threshold moves with depth (planning/05 §4)
   * once the acoustic model lands, and a client recomputing it would eventually draw a
   * different answer from the one the enemy's sonar is acting on.
   */
  readonly cavitating: boolean;
  readonly order: StandingOrder;
  readonly status: BoatStatus;
  /** Whether its active sonar is switched on. The state the fleet row's toggle reflects. */
  readonly activeSonar: boolean;
  /**
   * The tick of its last active pulse, or `0`.
   *
   * On the wire so the client can draw a ring on each pulse without inventing when one
   * happened. A *tick* rather than a timestamp, because the client has no synchronized clock
   * and never treats its own as authoritative (planning/02 §5) — what it does with this is
   * compare it to the value in the previous frame and start an animation when it changes.
   *
   * Friendly boats only, like everything else in this shape. An enemy pulse is not drawn as a
   * ring; it arrives the way every other sound does, as a very loud return in `vision`.
   */
  readonly lastPingTick: number;
  /**
   * The noise events still ringing on this boat, with the tick each fired on.
   *
   * Almost always empty, which is why it is affordable at the frame rate: a transient is a bang,
   * and a fleet under way is not banging. The client watches for a `(kind, tick)` it has not seen
   * and plays the cue for it — the same comparison it makes on `lastPingTick`, and for the same
   * reason (planning/02 §5: the client has no clock of its own to trust).
   *
   * Friendly boats only. **That is not a limitation of the wire, it is the game**: an enemy's
   * collision reaches this player the way every enemy sound does, as returns in `vision`. What
   * this carries is the noise your *own* fleet is making, which you are entitled to hear and
   * which is exactly what a boat's crew would know.
   */
  readonly transients: readonly BoatTransient[];
}

/** The private overlay for boats the recipient commands: what is in the tubes. */
export interface OwnBoatDetail {
  readonly id: EntityId;
  readonly tubes: readonly TubeState[];
}

/** One team's score line. Public to both sides — see the file header on what is not. */
export interface TeamScoreView {
  readonly team: TeamId;
  readonly score: number;
  readonly survivingPoints: number;
  readonly boatsAlive: number;
  readonly boatsTotal: number;
}

/**
 * One capture zone, whole, on every frame.
 *
 * **All of it is volatile, `centre` included.** A captured objective is replaced by a fresh
 * one somewhere else in the middle third (`objectives.ts`), so there is no unchanging half to
 * put in `MatchSetup` — an earlier split that sent position once was a position that went
 * stale the first time anyone scored. Three circles of eight small fields is a rounding error
 * against a fleet's worth of boats at 10 Hz, and it keeps the frame interpretable alone
 * (planning/02 §3.3).
 *
 * Public in both directions, and *not* gated on the sonar picture: an objective is visible to
 * both teams from tick zero whether or not anyone has charted the water it sits in. That is
 * the mode — the enemy must come to known places (planning/06 §2.2) — and it is the one thing
 * on a player's screen that is not something their fleet earned.
 */
export interface ZoneStatusView {
  readonly id: EntityId;
  readonly label: string;
  readonly centre: Vec2;
  readonly radius: number;
  /**
   * Simulation ticks until it opens for capture; zero once open. A tick rather than seconds,
   * like `BoatSnapshot.lastPingTick` and for the same reason (planning/02 §5).
   */
  readonly armingTicks: number;
  /** The team accruing progress, or `null` when nobody is. */
  readonly capturing: TeamId | null;
  /** Progress toward capture by `capturing`, 0..1. Frozen while `contested`. */
  readonly progress: number;
  readonly contested: boolean;
}

export interface MatchViewState {
  readonly phase: MatchPhase;
  readonly clock: MatchClock;
  readonly teams: readonly TeamScoreView[];
  readonly zones: readonly ZoneStatusView[];
  /** Your team's boats, at true position. Everything hostile arrives through `vision`. */
  readonly boats: readonly BoatSnapshot[];
  /** Boats you command, and only those. A teammate's tube states are not yours to read. */
  readonly own: readonly OwnBoatDetail[];
  /**
   * What your team has heard: chart appends, this solve's faint returns, and the hostile
   * contacts it has confirmed (`match/vision.ts`).
   *
   * Pooled per team, so every player on a side reads the same picture (C17). Empty for a
   * spectator, who is looking at ground truth and has no sonar of their own.
   */
  readonly vision: VisionFrame;
}

// ── Projection ──────────────────────────────────────────────────────────────────────

/** Which side an account plays for in this match, or `null` if it watches or is not in it. */
export function teamFor(state: MatchState, accountId: AccountId): TeamId | null {
  return state.players.find((player) => player.accountId === accountId)?.team ?? null;
}

/**
 * The static half, addressed to one account.
 *
 * Built per recipient rather than once per broadcast, exactly like `lobby.state` — the shared
 * object never contains the private part, so there is no client-side filtering to forget and
 * no devtools inspection that reveals it.
 */
export function setupFor(state: MatchState, accountId: AccountId): MatchSetup {
  const team = teamFor(state, accountId);

  return {
    matchId: state.matchId,
    mode: state.mode,
    // The vision policy, and the only place it is decided. A spectator commands nothing, so
    // there is no sonar picture for them to build and ground truth is the only thing they could
    // usefully be shown; a player is told the frame and finds the rock themselves. When the
    // host's spectator policy exists (planning/07 §5) it replaces this predicate and nothing
    // else in the projection moves.
    map: chartOf(state.map, team === null),
    startedAt: state.startedAt,
    scoreTarget: state.scoreTarget,
    you: { accountId, team },
    players: state.players.map((player) => ({
      accountId: player.accountId,
      username: player.username,
      team: player.team,
    })),
    fleet:
      team === null
        ? []
        : state.boats
            .filter((boat) => boat.team === team)
            .map((boat) => ({
              id: boat.id,
              owner: boat.owner,
              team: boat.team,
              index: boat.index,
              name: boat.name,
              hull: boat.hull,
              stats: boat.stats,
              cost: boat.cost,
            })),
  };
}

/**
 * The volatile half, addressed to one account.
 *
 * `vision` is supplied rather than derived because it is *stateful* — a team's chart is
 * everything it has ever confirmed, and a projection over an immutable `MatchState` has no
 * memory to hold that in. The runtime that owns the acoustic solve owns it too, and hands the
 * recipient's frame in here (`server/match/runtime.ts`). The default is the honest answer for
 * anyone with no team and no picture.
 */
export function viewFor(
  state: MatchState,
  accountId: AccountId,
  vision: VisionFrame = NO_VISION,
): MatchViewState {
  const team = teamFor(state, accountId);
  const friendly = team === null ? [] : state.boats.filter((boat) => boat.team === team);

  return {
    phase: state.phase,
    clock: state.clock,
    teams: TEAM_IDS.map((id) => {
      const standing = state.teams[id];
      return {
        team: standing.team,
        score: standing.score,
        survivingPoints: standing.survivingPoints,
        boatsAlive: standing.boatsAlive,
        boatsTotal: standing.boatsTotal,
      };
    }),
    zones: state.zones.map((zone) => ({
      id: zone.id,
      label: zone.label,
      centre: zone.centre,
      radius: zone.radius,
      armingTicks: zone.armingTicks,
      capturing: zone.capturing,
      progress: zone.progress,
      contested: zone.contested,
    })),
    boats: friendly.map((boat) => ({
      id: boat.id,
      pos: boat.pos,
      facing: boat.facing,
      speed: boat.speed,
      throttle: boat.throttle,
      hp: boat.hp,
      cavitating: isCavitating(boat.speed, boat.stats),
      order: boat.order,
      status: boat.status,
      activeSonar: boat.activeSonar,
      lastPingTick: boat.lastPingTick,
      transients: boat.transients,
    })),
    own: friendly
      .filter((boat) => boat.owner === accountId)
      .map((boat) => ({ id: boat.id, tubes: boat.tubes })),
    vision: team === null ? NO_VISION : vision,
  };
}
