/**
 * @seg/server/match/runtime — one running match, advanced one tick at a time.
 *
 * This is the first thing in the project that *runs*. Everything before it was a shape: a map
 * that had been generated, boats that had been deployed, a solver that had been tested. The
 * runtime is what puts the ocean in motion — boats advancing along their orders each tick, and
 * the acoustic solve making all of it audible (planning/04 §1).
 *
 * ## What it owns, and why those things and not others
 *
 * The acoustic solver, because it is expensive to build (the water lattice and the rock
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
  emittedLevels,
  HOLDING,
  MATCH_DURATION_SECONDS,
  pruneTransients,
  resolveCollisions,
  SIM_TICK_HZ,
  SIM_TICK_SECONDS,
  standingFor,
  stepBoat,
  TEAM_IDS,
  TeamPicture,
  TerrainCollider,
  opposingTeam,
  pingDue,
  type AccountId,
  type AcousticEntity,
  type AcousticTuning,
  type BoatState,
  type ContactSighting,
  type EntityId,
  type MatchState,
  type SolveStats,
  type TeamId,
  type ThrottleNotch,
  type Vec2,
  type VisionFrame,
} from '@seg/shared';

/** Sim ticks between acoustic solves. Two, and the two constants are what say so. */
const TICKS_PER_SOLVE = Math.max(1, Math.round(SIM_TICK_HZ / ACOUSTIC_TICK_HZ));

export interface MatchRuntimeOptions {
  /** Overrides the shipped acoustic table. Tests use it to trade fidelity for speed. */
  readonly tuning?: AcousticTuning;
  /** Overrides `tuning.latticeCell`. A coarser lattice builds far faster in a test. */
  readonly cellSize?: number;
  /** Overrides `COLLISION_CELL`. Same bargain as `cellSize`, for the rock mask. */
  readonly collisionCell?: number;
}

export class MatchRuntime {
  private current: MatchState;

  private readonly solver: AcousticSolver;
  /**
   * The map's rock, as movement has to answer to it (planning/04 §1 step 4).
   *
   * Built here beside the solver because the two are the same kind of thing: a rasterization of
   * the terrain that costs something once and nothing thereafter. They rasterize at different
   * spacings — 20 m decides what can be *heard*, 5 m decides where a hull may *be* — through the
   * same routine, so the two can never disagree about where a wall is.
   */
  private readonly terrain: TerrainCollider;
  private readonly pictures: Readonly<Record<TeamId, TeamPicture>>;
  /** How far through its team's chart each connection has been carried. */
  private readonly chartSeen = new Map<AccountId, number>();
  private lastStats: SolveStats | null = null;
  private readonly tuning: AcousticTuning;

  constructor(state: MatchState, options: MatchRuntimeOptions = {}) {
    const tuning = options.tuning ?? ACOUSTICS;
    this.tuning = tuning;
    this.current = state;
    this.solver = new AcousticSolver(state.map, {
      tuning,
      ...(options.cellSize === undefined ? {} : { cellSize: options.cellSize }),
    });
    this.terrain = TerrainCollider.forMap(
      state.map,
      options.collisionCell === undefined ? {} : { cellSize: options.collisionCell },
    );
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

  /**
   * Swap in a new state — what a movement phase does, once there is one.
   */
  replace(state: MatchState): void {
    this.current = state;
  }

  /**
   * Point a boat at a waypoint, replacing its route or appending to it (shift-click).
   *
   * The route is owned here, not by the client: `queue` is a request to extend it, and the
   * server is the only place the route exists as a fact. A boat already under way and told to
   * go somewhere fresh simply drops its old legs — there is no merging to be clever about.
   */
  order(boatId: EntityId, to: Vec2, queue: boolean): void {
    this.current = {
      ...this.current,
      boats: this.current.boats.map((boat) => {
        if (boat.id !== boatId) return boat;
        const waypoints =
          queue && boat.order.kind === 'transit' ? [...boat.order.waypoints, to] : [to];
        return { ...boat, order: { kind: 'transit', waypoints } };
      }),
    };
  }

  /** Drop a boat's orders and stop it. Its throttle notch stays where the owner set it. */
  cancel(boatId: EntityId): void {
    this.current = {
      ...this.current,
      boats: this.current.boats.map((boat) =>
        boat.id === boatId ? { ...boat, order: HOLDING, speed: 0 } : boat,
      ),
    };
  }

  /** Set a boat's throttle notch, for this order and the next. */
  setThrottle(boatId: EntityId, notch: ThrottleNotch): void {
    this.current = {
      ...this.current,
      boats: this.current.boats.map((boat) =>
        boat.id === boatId ? { ...boat, throttle: notch } : boat,
      ),
    };
  }

  /**
   * One simulation tick.
   *
   * The clock advances, then every boat is stepped along its orders (`match/movement.ts`), then
   * the steps that ended in rock or in another hull are refused (`sim/collision`), then — every
   * second tick — the acoustic solve runs and a view frame is due. Movement and collision run
   * every tick because they are the simulation's physics; the solve runs at half the rate because
   * it is the expensive part (planning/03 §10), and the two never fight because the alignment
   * is the point (planning/04 §1).
   *
   * **Collision after movement, never during it.** `stepBoat` is a pure function of one boat and
   * knows nothing about the map or about the rest of the fleet; teaching it either would make the
   * movement phase quadratic in the fleet and untestable without a map. So movement proposes and
   * this phase disposes, which is planning/04 §1's step order verbatim.
   *
   * Returns `true` when this tick produced a fresh acoustic solve and a view frame is therefore
   * due. The driver publishes; the runtime does not know what a socket is (planning/01 §1).
   */
  tick(): boolean {
    const tick = this.current.clock.tick + 1;
    const elapsedSeconds = tick / SIM_TICK_HZ;

    // Any pings due this tick are fired first, then movement, then collision. All three run at
    // the full 20 Hz rather than the 10 Hz acoustic rate: a transient's level is read from how
    // long ago it fired, so making noise on the sim clock and sampling it on the acoustic clock is
    // what keeps the two rates independent. Nothing here depends on whether this is a solve tick.
    const before = this.pulse(tick);
    const after = before.map((boat) =>
      // Pruned on the way past, so a bang that has rung down leaves the boat — and the wire —
      // rather than riding along for the rest of the match.
      stepBoat(pruneTransients(boat, tick, SIM_TICK_HZ), SIM_TICK_SECONDS),
    );

    const settled = resolveCollisions({
      before,
      after,
      terrain: this.terrain,
      tick,
      tickHz: SIM_TICK_HZ,
    });

    this.current = {
      ...this.current,
      clock: {
        tick,
        elapsedSeconds,
        remainingSeconds: Math.max(0, MATCH_DURATION_SECONDS - elapsedSeconds),
      },
      boats: settled,
      // The standings are derived from the fleet (`standingFor`), and a collision is the first
      // thing in the game that can change what they derive from — hit points, and with them a
      // boat's surviving value or its life. Recomputed only on a tick that produced a contact,
      // which is a rounding error's worth of them: `resolveCollisions` hands back the same array
      // it was given when nothing touched anything, and that identity is the test.
      ...(settled === after ? {} : { teams: standings(settled, this.current) }),
    };

    if (tick % TICKS_PER_SOLVE !== 0) return false;
    this.solve(tick, elapsedSeconds);
    return true;
  }

  /**
   * Switch one boat's active sonar (planning/03 §3), if the account commands it.
   *
   * Returns whether anything changed, which the caller uses to decide whether to say so — an
   * ignored command and a redundant one are different things to a log and the same thing to a
   * player. The ownership check is here rather than in the handler because this is where the
   * boats are: a rule enforced next to the data it protects cannot be routed around by a second
   * caller (planning/01 §5).
   */
  setActiveSonar(accountId: AccountId, boatId: EntityId, active: boolean): boolean {
    const boat = this.current.boats.find((candidate) => candidate.id === boatId);
    if (boat === undefined || boat.owner !== accountId) return false;
    if (boat.status === 'destroyed' || boat.activeSonar === active) return false;

    this.current = {
      ...this.current,
      boats: this.current.boats.map((candidate) =>
        candidate.id === boatId ? { ...candidate, activeSonar: active } : candidate,
      ),
    };
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

  /**
   * Fire whichever boats are due to pulse, and hand back the fleet.
   *
   * Returns the same array when nothing fired, so a tick with no active sonar anywhere — which
   * is most of them — allocates nothing and leaves `boats` referentially unchanged.
   */
  private pulse(tick: number): readonly BoatState[] {
    let firing = false;
    for (const boat of this.current.boats) {
      if (pingDue(boat, tick, SIM_TICK_HZ, this.tuning)) {
        firing = true;
        break;
      }
    }
    if (!firing) return this.current.boats;

    return this.current.boats.map((boat) =>
      pingDue(boat, tick, SIM_TICK_HZ, this.tuning) ? { ...boat, lastPingTick: tick } : boat,
    );
  }

  private solve(tick: number, seconds: number): void {
    const entities: AcousticEntity[] = this.current.boats.map((boat) =>
      // A ringing pulse and a hull that has just hit a wall both reach the solver as transients,
      // which is all either of them is (`emittedLevels`). Nothing downstream of here knows a ping
      // from a collision from a torpedo launch.
      boatEntity(
        boat,
        this.current.map.extents,
        emittedLevels(boat, tick, SIM_TICK_HZ, this.tuning),
        this.tuning,
      ),
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

/**
 * Both teams' standings, recounted from the fleet.
 *
 * `standingFor` derives every counter it can and takes the two it cannot — the objective score and
 * the seconds-detected tiebreak — from whatever the previous standing held, because nothing about
 * the boats as they are now can reconstruct a running total.
 */
function standings(
  boats: readonly BoatState[],
  previous: Pick<MatchState, 'teams'>,
): MatchState['teams'] {
  return {
    team1: standingFor('team1', boats, previous.teams.team1),
    team2: standingFor('team2', boats, previous.teams.team2),
  };
}
