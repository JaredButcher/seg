/**
 * @seg/server/match/runtime — one running match, advanced one tick at a time.
 *
 * This is the first thing in the project that *runs*. Everything before it was a shape: a map
 * that had been generated, boats that had been deployed, a solver that had been tested. The
 * runtime is what puts the ocean in motion — or, for now, what makes the ocean *audible*, since
 * movement is still to come (planning/04 §5).
 *
 * ## What it owns, and why those things and not others
 *
 * The acoustic solver, because it is expensive to build (the water lattice and the 1 m rock
 * skin are rasterized once per match, planning/03 §5.2) and cheap to keep. The per-team
 * `TeamPicture`, because a chart is memory and `MatchState` is a value. The per-recipient chart
 * watermark, because "how much of the chart has this connection been told about" is a fact
 * about a connection rather than about the world.
 *
 * ## It never schedules itself
 *
 * `tick()` is called by a driver (`clock.ts` in production, a test in the suite), which is
 * planning/01 §4.3's rule verbatim: a match host is driven by the scheduler at 20 Hz and never
 * self-schedules. It is what lets the whole runtime be tested by calling `tick()` forty times
 * in a row with no timers and no sleeping, and it is what makes moving matches into worker
 * threads later a transport swap rather than a rewrite.
 *
 * ## The rate split
 *
 * The clock advances at `SIM_TICK_HZ`; the acoustic solve and the view frame both happen every
 * second tick, at `ACOUSTIC_TICK_HZ` (planning/04 §1, 02 §5). That alignment is not a
 * coincidence to be maintained — it is the point. Each view frame carries exactly one fresh
 * solve, so neither rate is wasted on the other.
 */

import {
  ACOUSTIC_TICK_HZ,
  ACOUSTICS,
  AcousticSolver,
  boatEntity,
  MATCH_DURATION_SECONDS,
  SIM_TICK_HZ,
  TEAM_IDS,
  TeamPicture,
  opposingTeam,
  type AccountId,
  type AcousticEntity,
  type AcousticTuning,
  type ContactSighting,
  type EntityId,
  type MatchState,
  type SolveStats,
  type TeamId,
  type VisionFrame,
} from '@seg/shared';

/** Sim ticks between acoustic solves. Two, and the two constants are what say so. */
const TICKS_PER_SOLVE = Math.max(1, Math.round(SIM_TICK_HZ / ACOUSTIC_TICK_HZ));

export interface MatchRuntimeOptions {
  /** Overrides the shipped acoustic table. Tests use it to trade fidelity for speed. */
  readonly tuning?: AcousticTuning;
  /** Overrides `tuning.latticeCell`. A coarser lattice builds far faster in a test. */
  readonly cellSize?: number;
}

export class MatchRuntime {
  private current: MatchState;

  private readonly solver: AcousticSolver;
  private readonly pictures: Readonly<Record<TeamId, TeamPicture>>;
  /** How far through its team's chart each connection has been carried. */
  private readonly chartSeen = new Map<AccountId, number>();
  private lastStats: SolveStats | null = null;

  constructor(state: MatchState, options: MatchRuntimeOptions = {}) {
    const tuning = options.tuning ?? ACOUSTICS;
    this.current = state;
    this.solver = new AcousticSolver(state.map, {
      tuning,
      ...(options.cellSize === undefined ? {} : { cellSize: options.cellSize }),
    });
    this.pictures = {
      team1: new TeamPicture(tuning),
      team2: new TeamPicture(tuning),
    };
  }

  get state(): MatchState {
    return this.current;
  }

  /** What the last solve cost. Feeds the tick-time dev overlay (planning/11, M2). */
  get stats(): SolveStats | null {
    return this.lastStats;
  }

  /** Swap in a new state — what a movement phase will do, once there is one. */
  replace(state: MatchState): void {
    this.current = state;
  }

  /**
   * One simulation tick.
   *
   * Returns `true` when this tick produced a fresh acoustic solve and a view frame is therefore
   * due. The driver publishes; the runtime does not know what a socket is (planning/01 §1).
   */
  tick(): boolean {
    const tick = this.current.clock.tick + 1;
    const elapsedSeconds = tick / SIM_TICK_HZ;

    this.current = {
      ...this.current,
      clock: {
        tick,
        elapsedSeconds,
        remainingSeconds: Math.max(0, MATCH_DURATION_SECONDS - elapsedSeconds),
      },
    };

    if (tick % TICKS_PER_SOLVE !== 0) return false;
    this.solve(tick, elapsedSeconds);
    return true;
  }

  /**
   * The vision frame for one recipient, advancing their chart watermark past what it carries.
   *
   * Advancing on *send* rather than on acknowledgement is the honest limit of what exists
   * today: the baseline-ack scheme (planning/02 §3.4) is not built, and the `view` channel is
   * still a reliable ordered WebSocket, so a sent frame is a delivered frame. When acks land,
   * this advances on the ack instead and a dropped frame re-sends its chart slice — the seam is
   * exactly here, and it is one line.
   */
  visionFor(accountId: AccountId, team: TeamId | null): VisionFrame | undefined {
    if (team === null) return undefined;
    const picture = this.pictures[team];
    const frame = picture.frameFor(this.chartSeen.get(accountId) ?? 0);
    this.chartSeen.set(accountId, frame.chartSeen);
    return frame;
  }

  /**
   * Forget what a connection has been told, so its next frame carries the chart from scratch.
   *
   * Called on reconnect (Q21). A returning player's client has no chart — it was in the tab
   * that closed — and the alternative to re-sending it is a player staring at an ocean their
   * team mapped twenty minutes ago.
   */
  forget(accountId: AccountId): void {
    this.chartSeen.delete(accountId);
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private solve(tick: number, seconds: number): void {
    const entities: AcousticEntity[] = this.current.boats.map((boat) =>
      boatEntity(boat, this.current.map.extents),
    );

    const solution = this.solver.solve(entities);
    this.lastStats = solution.stats;

    const heard = new Set<TeamId>();
    for (const vision of solution.vision) {
      heard.add(vision.team);
      this.pictures[vision.team].observe(vision, tick, seconds, (entity) =>
        this.sightingFor(entity, vision.team),
      );
    }
    // A team with nobody listening — every boat destroyed, or a solve that reached nothing —
    // still has to age. Without this its contacts would freeze mid-fade at the moment its last
    // hydrophone went quiet, which reads as the display having crashed rather than as the fleet
    // having been wiped out.
    for (const team of TEAM_IDS) {
      if (!heard.has(team)) this.pictures[team].settle(seconds);
    }
  }

  /**
   * What `team` may learn from a square sitting on entity `owner`: a hostile boat, or nothing.
   *
   * Returning nothing for a friendly is what keeps your own fleet out of your own sonar
   * picture. The solver lights teammates exactly as readily as enemies — it has no idea whose
   * hull it is looking at, and that blindness is deliberate (planning/03 §5) — so the filter
   * has to be here, where team membership is known.
   */
  private sightingFor(owner: EntityId, team: TeamId): ContactSighting | undefined {
    const boat = this.current.boats.find(
      (candidate) => candidate.id === owner && candidate.team === opposingTeam(team),
    );
    if (boat === undefined) return undefined;
    return { id: boat.id, hull: boat.hull, pos: boat.pos, facing: boat.facing };
  }
}
