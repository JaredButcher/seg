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
  ARMING_SECONDS,
  AcousticSolver,
  advanceZones,
  boatEntity,
  boatListener,
  boatPulse,
  buildResults,
  canFire,
  chooseNext,
  decideAbandonment,
  decideMatch,
  decoyRevealedBy,
  emittedLevels,
  HOLDING,
  DEFAULT_WEAPON,
  isDeployableWeapon,
  LAUNCH_SPEED,
  launch,
  MATCH_DURATION_SECONDS,
  newTube,
  objectiveRuler,
  pruneTransients,
  pulseHeardBy,
  resolveBoat,
  resolveCollisions,
  respawnRng,
  seekerPulse,
  SIM_TICK_HZ,
  SIM_TICK_SECONDS,
  spawnZone,
  standingFor,
  stepBoat,
  stepWeapons,
  swapTo,
  TEAM_IDS,
  TeamPicture,
  TerrainCollider,
  torpedoEmittedLevels,
  torpedoEntity,
  torpedoListener,
  ZONE_ID_BASE,
  depthAt,
  generateGhosts,
  ghostRng,
  isDamaged,
  opposingTeam,
  pingDue,
  sourceLevelOf,
  vacantLabels,
  visionGridFor,
  wreckHasLeftMap,
  type AccountId,
  type AcousticEntity,
  type AcousticTuning,
  type ActivePulse,
  type BoatState,
  type CaptureZone,
  type ContactSighting,
  type Detonation,
  type EmittedLevels,
  type EntityId,
  type Ghost,
  type GhostSource,
  type HullId,
  type MatchResults,
  type MatchState,
  type PulseListener,
  type Rng,
  type SolveStats,
  type TeamId,
  type TerrainRuler,
  type ThrottleNotch,
  type TorpedoState,
  type TubeState,
  type Vec2,
  type VisionFrame,
  type VisionSnapshot,
  type WeaponId,
  type ZoneCapture,
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
  /**
   * The ruler a replacement objective is placed against, or `null` in a mode that has none.
   *
   * Built up front rather than on the first capture, and that is the whole reason it is a
   * field: it rasterizes the map and runs a distance transform over it, which is tens of
   * milliseconds of work. Paying that during a tick — the tick a fight was just decided on —
   * would drop frames at the least forgiving moment in the match. Its lattice is the
   * objectives' own, so it is far cheaper than the collider beside it (`objectives.ts`).
   */
  private readonly objectives: TerrainRuler | null;
  /** Where replacement positions are drawn from. Seeded from the map, so a replay agrees. */
  private readonly respawns: Rng;
  /**
   * The stream ambient ghosts are drawn from (planning/15 §6).
   *
   * A ghost is presentation-facing but it is *simulation state* by the definition that matters
   * here — a replay that haunted different squares would not be a replay — so it draws from a
   * stream forked off the map seed with its own salt, and the layout and respawn streams are
   * none the wiser (`match/objectives.ts#ghostRng`).
   */
  private readonly ghosts: Rng;
  /** The next zone id to hand out. Ids count up and are never reused (`objectives.ts`). */
  private nextZoneId: EntityId;
  private readonly pictures: Readonly<Record<TeamId, TeamPicture>>;
  /**
   * The hostile active decoys each team's own pulses have caught out.
   *
   * **Sticky, and per team.** A classification is a thing a crew has worked out, and it does not
   * come undone because the next pulse was a second late or the decoy went behind a rock — the
   * contact simply reads as a torpedo from then on (`sightingFor`). Sticky is also what makes the
   * player-facing behaviour legible: you ping, the silhouette you were chasing turns into a dart,
   * and it stays a dart.
   *
   * Held here rather than on the decoy because it is not a fact about the decoy. One team can
   * have stripped it while the other is still being fooled by the same weapon, which is exactly
   * right — and is why this is keyed by team and never reaches `TorpedoState`.
   */
  private readonly exposedDecoys: Readonly<Record<TeamId, Set<EntityId>>> = {
    team1: new Set(),
    team2: new Set(),
  };
  /** How far through its team's chart each connection has been carried. */
  private readonly chartSeen = new Map<AccountId, number>();
  /**
   * Which accounts have thrown their own fog of war off (`debug.setVision`).
   *
   * Per connection rather than per team, like `chartSeen` — it is a fact about what one player
   * has asked the console for, not a fact the world remembers. Empty on every match that is not
   * `debugMode`, because `setDebugVision` is never called for one (`MatchHandler.debugSetVision`
   * refuses before it reaches here).
   */
  private readonly debugVision = new Set<AccountId>();
  private lastStats: SolveStats | null = null;
  private readonly tuning: AcousticTuning;
  /**
   * What each boat has done, for the results screen (`match/results.ts`).
   *
   * Here rather than on `BoatState` because no rule in the simulation reads any of it: it is
   * bookkeeping over the events the phases already report, and putting it on the boat would put
   * five more fields through every copy the tick makes. It lives across state replacements for
   * free, which `replace()` — and therefore a player connecting or disconnecting — depends on.
   */
  private readonly tallies = new Map<EntityId, RunningTally>();
  /** The record of a finished match, built once on the tick that ended it. `null` until then. */
  private finished: MatchResults | null = null;

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
    this.objectives = state.zones.length === 0 ? null : objectiveRuler(state.map);
    this.respawns = respawnRng(state.map.seed);
    this.ghosts = ghostRng(state.map.seed);
    this.nextZoneId = state.zones.reduce((next, zone) => Math.max(next, zone.id + 1), ZONE_ID_BASE);
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
   * One team's last folded picture, ghosts included.
   *
   * `visionFor` is the wire — a delta over a watermark — and ghosts are deliberately not on it
   * (planning/15 §2, Option A). This is the picture itself, which is what the dev overlay and
   * the determinism tests read. A team with no solve yet holds the empty initial frame.
   */
  snapshotFor(team: TeamId): VisionSnapshot {
    return this.pictures[team].current;
  }

  /**
   * How the match ended, or `null` while it is still being played.
   *
   * The runtime decides *that* a match is over (`tick`) and never tells anybody: the driver reads
   * this and publishes, exactly as it does with a view frame, because the runtime does not know
   * what a socket is (planning/01 §1).
   */
  get results(): MatchResults | null {
    return this.finished;
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
   * the steps that ended in rock or in another hull are refused (`sim/collision`), then the
   * objectives are advanced against where the fleets ended up, then — every second tick — the
   * acoustic solve runs and a view frame is due. Movement, collision, and capture run every tick
   * because they are the simulation's physics; the solve runs at half the rate because it is the
   * expensive part (planning/03 §10), and the two never fight because the alignment is the point
   * (planning/04 §1).
   *
   * **Capture last, after collision and weapons.** A boat whose step was refused for ending in
   * rock is not where it asked to be, and asking "is it in the circle" of the proposed position
   * rather than the settled one would let a fleet capture a zone from inside a wall — and a boat
   * a torpedo killed this tick is not holding anything.
   *
   * **Collision after movement, never during it.** `stepBoat` is a pure function of one boat and
   * knows nothing about the map or about the rest of the fleet; teaching it either would make the
   * movement phase quadratic in the fleet and untestable without a map. So movement proposes and
   * this phase disposes, which is planning/04 §1's step order verbatim.
   *
   * Returns `true` when this tick produced a fresh acoustic solve and a view frame is therefore
   * due. The driver publishes; the runtime does not know what a socket is (planning/01 §1).
   *
   * **The last tick of a match is the one `decideMatch` answers on.** The phase goes to
   * `complete`, the results are built from the state as it finally stands, and every later call
   * does nothing — a finished match is a value, and a driver that keeps calling gets the same
   * one back rather than a thirty-first minute.
   */
  tick(): boolean {
    if (this.current.phase === 'complete') return false;

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

    // Weapons after collision, on the fleet collision has finished with, so a torpedo fuzes
    // against where a boat actually ended the tick rather than where movement wanted to put it.
    // It also turns every tube over, which is why it runs on a tick with nothing in the water.
    const weapons = stepWeapons({
      boats: settled,
      torpedoes: this.current.torpedoes,
      terrain: this.terrain,
      tick,
      tickHz: SIM_TICK_HZ,
      tuning: this.tuning,
    });

    // A weapon whose run has ended stops being a contact for *both* teams the tick it happens.
    // A warhead that goes off stays in the water to ring its bang down (`match/torpedo.ts`) and
    // the squares of that bang still light a picture as returns, but the blip on a scope and a
    // mini-map has nothing true to stand for any more. `sightingFor` is the guard that keeps the
    // corpse from being re-minted while it rings down.
    //
    // Read off the weapon lists rather than off `weapons.detonations`, and that is the whole of
    // the rule rather than a defensive extra. A load with no warhead reports no detonation
    // because none happened (`sim/weapons/phase.ts`) — it scuttles — so a decoy that reaches the
    // end of its two minutes used to leave its last-known marker standing for the rest of the
    // match, and a decoy is the one contact a team is most likely to have chased and least able
    // to explain. Ending on the transition out of the live phases catches every way a weapon can
    // go: a bang, a wall, a hull, a clock, a fuel gauge, and whatever a later load invents.
    for (const ended of this.endedWeapons(weapons.torpedoes)) {
      for (const team of TEAM_IDS) this.pictures[team].contacts.drop(ended);
    }

    // Capture last of all, on the fleet weapons have finished with: a boat that was destroyed
    // this tick is not standing in the circle any more, and one whose step was refused for
    // ending in rock never was.
    // Who hurt whom, before the fleet this tick produced is folded into the state and the
    // hit points it entered the weapons phase with are gone.
    this.creditWeapons(settled, weapons.boats, weapons.detonations, this.current.torpedoes);

    const advanced = advanceZones(this.current.zones, weapons.boats, SIM_TICK_SECONDS);
    // A captured objective is worth one point and is gone; a replacement appears elsewhere in
    // the band, grey for a minute (planning/06 §2.2). Retiring it happens on the tick it fell —
    // `advanceZones` leaves the finished zone standing and would report it again next tick.
    // Filling the slot may not happen at all, and a capture is the only moment it is worth
    // trying: nothing else in a match can make a position legal that was not.
    const zones =
      advanced.captures.length === 0
        ? advanced.zones
        : this.fillVacancies(retire(advanced.zones, advanced.captures), advanced.captures);
    const scored = tally(this.current.teams, advanced.captures);
    // Everyone who was still standing in the circle when it fell. Progress does not scale with
    // boat count, so there is no single captor to name (`match/objectives.ts#ZoneCapture`).
    for (const capture of advanced.captures) {
      for (const boat of capture.boats) this.tallyFor(boat).captures += 1;
    }

    this.current = {
      ...this.current,
      clock: {
        tick,
        elapsedSeconds,
        remainingSeconds: Math.max(0, MATCH_DURATION_SECONDS - elapsedSeconds),
      },
      boats: weapons.boats,
      torpedoes: weapons.torpedoes,
      ...(zones === this.current.zones ? {} : { zones }),
      // The standings are derived from the fleet (`standingFor`), and three things can change
      // what they derive from: a collision and a detonation, which move hit points and with them
      // a boat's surviving value or its life, and a capture, which moves the objective score.
      // Recomputed only on a tick that produced one, which is a rounding error's worth of them —
      // `resolveCollisions` hands back the same array it was given when nothing touched anything,
      // `stepWeapons` says in one flag whether any hull lost a point, and `tally` returns the same
      // standings when nothing fell. Those identities are the test.
      ...(settled === after && !weapons.damaged && scored === this.current.teams
        ? {}
        : { teams: standings(weapons.boats, { teams: scored }) }),
    };

    // Guarded by the same identities the standings are: a hull can only have been lost on a tick
    // where collision moved something or a warhead landed.
    if (settled !== after || weapons.damaged) this.noteLosses(tick);

    const due = tick % TICKS_PER_SOLVE === 0;
    if (due) this.solve(tick, elapsedSeconds);

    /*
     * Is that the match?
     *
     * Asked after everything else has settled, so the question is put to the state a player will
     * actually be shown: the fleet weapons finished with, the score the captures moved, and a
     * clock that has already been advanced past the half-hour if this is the tick it ran out.
     *
     * Abandonment is checked first and separately from the three game-design conditions: an
     * empty room is not a wipe, a score, or a clock running out, and it can be true on a tick
     * where none of those three ever will be — the last player to leave is what ends a match
     * where a fleet is still afloat on both sides.
     *
     * A frame is published either way — the final one carries `phase: 'complete'` and the last
     * positions of both fleets, which is what a client draws behind the results.
     */
    const decision = decideAbandonment(this.current) ?? decideMatch(this.current);
    if (decision === null) return due;

    this.current = { ...this.current, phase: 'complete' };
    this.finished = buildResults(this.current, decision, this.tallies, SIM_TICK_HZ);
    return true;
  }

  /**
   * Fire one or more of a boat's tubes at a point (planning/04 §7 step 1).
   *
   * Returns how many weapons actually left the tubes, which the caller uses only to decide
   * whether anything happened — a salvo where three of four tubes were reloading fires three,
   * silently, because the fourth's state is already on the player's screen and the tube pip not
   * moving *is* the refusal (`protocol/weapon.ts`).
   *
   * An empty `tubes` means "the first tube that can fire", in tube order. That is the bare
   * space press with nothing sub-selected, and it is the path most shots in a match will take.
   *
   * The ownership check is here rather than in the handler for the reason `setActiveSonar` gives:
   * a rule enforced next to the data it protects cannot be routed around by a second caller.
   */
  fire(accountId: AccountId, boatId: EntityId, tubes: readonly number[], to: Vec2): number {
    const boat = this.current.boats.find((candidate) => candidate.id === boatId);
    if (boat === undefined || boat.owner !== accountId || boat.status === 'destroyed') return 0;

    const wanted =
      tubes.length > 0
        ? [...new Set(tubes)].sort((a, b) => a - b)
        : boat.tubes
            .filter(canFire)
            .slice(0, 1)
            .map((tube) => tube.index);

    const tick = this.current.clock.tick;
    const fired: TorpedoState[] = [];
    let firing = boat;
    let nextId = this.current.nextEntityId;

    for (const index of wanted) {
      const tube = firing.tubes[index];
      if (tube === undefined || !canFire(tube)) continue;
      const result = launch({
        boat: firing,
        tubeIndex: index,
        id: nextId++,
        aim: to,
        tick,
        tickHz: SIM_TICK_HZ,
      });
      // Threaded through rather than accumulated: each launch reads the boat the previous one
      // produced, so a four-tube salvo ends with four tubes reloading rather than with the last
      // write winning.
      firing = result.boat;
      fired.push(result.torpedo);
    }

    if (fired.length === 0) return 0;

    this.tallyFor(boatId).torpedoesFired += fired.length;

    this.current = {
      ...this.current,
      boats: this.current.boats.map((candidate) => (candidate.id === boatId ? firing : candidate)),
      torpedoes: [...this.current.torpedoes, ...fired],
      nextEntityId: nextId,
    };
    return fired.length;
  }

  /**
   * Choose what a tube loads next, or — with `swap` — eject what it is holding and load that now.
   *
   * Both refuse a weapon the phase cannot put in the water (`isDeployableWeapon`), because the
   * alternative is a tube a player has quietly disarmed by picking a drone the game has not
   * built. The picker offers only deployable loads, so this is the second copy of a rule the
   * client already enforces — which is the rule everywhere: the client checks so the player is
   * told instantly, and the server checks because the client is not trusted.
   */
  load(
    accountId: AccountId,
    boatId: EntityId,
    index: number,
    weapon: WeaponId,
    swap: boolean,
  ): boolean {
    if (!isDeployableWeapon(weapon)) return false;
    const boat = this.current.boats.find((candidate) => candidate.id === boatId);
    if (boat === undefined || boat.owner !== accountId || boat.status === 'destroyed') return false;
    const tube = boat.tubes[index];
    if (tube === undefined) return false;

    const updated = swap ? swapTo(chooseNext(tube, weapon), weapon) : chooseNext(tube, weapon);
    if (updated === tube) return false;

    this.current = {
      ...this.current,
      boats: this.current.boats.map((candidate) =>
        candidate.id === boatId
          ? {
              ...candidate,
              tubes: candidate.tubes.map((each) => (each.index === index ? updated : each)),
            }
          : candidate,
      ),
    };
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

  /** Throw one account's own fog of war off or back on (`debug.setVision`). */
  setDebugVision(accountId: AccountId, enabled: boolean): void {
    if (enabled) this.debugVision.add(accountId);
    else this.debugVision.delete(accountId);
  }

  /** Whether `accountId` currently sees both fleets at true position, `setupFor`/`viewFor`'s `godMode`. */
  hasDebugVision(accountId: AccountId): boolean {
    return this.debugVision.has(accountId);
  }

  /**
   * Put a fresh boat in the water, owned by `accountId`, on `team`, at `at` (`debug.spawn`).
   *
   * Modelled on `deployMatch`'s own boat construction, not on it: a debug spawn has no berth to
   * search for and no budget to fit against, so it takes the point the console asked for
   * directly and fits nothing beyond the bare hull. `owner` is the *spawning* account regardless
   * of `team` — a debug player may put a boat on either side and it is always theirs to command
   * (`match/view.ts#viewFor`'s `own`, which is ownership-gated for exactly this reason).
   */
  spawnBoat(accountId: AccountId, hull: HullId, team: TeamId, at: Vec2): void {
    const resolved = resolveBoat({ name: 'DEBUG', hull, modules: [] });
    const id = this.current.nextEntityId;

    const boat: BoatState = {
      id,
      team,
      owner: accountId,
      index: this.current.boats.filter((candidate) => candidate.owner === accountId).length,
      name: 'DEBUG',
      hull,
      stats: resolved.current,
      cost: resolved.cost,
      pos: at,
      facing: team === 'team1' ? 0 : 180,
      speed: 0,
      throttle: 'slow',
      hp: resolved.current.maxHp,
      tubes: debugTubes(resolved.current.torpedoTubes),
      order: HOLDING,
      status: 'active',
      activeSonar: false,
      lastPingTick: 0,
      transients: [],
    };

    this.current = {
      ...this.current,
      boats: [...this.current.boats, boat],
      nextEntityId: id + 1,
    };
  }

  /**
   * Put a fresh torpedo in the water on `team`, at `at`, running as though it had just cleared
   * a tube (`debug.spawn`).
   *
   * There is no firing boat to build one from `launch()`'s way, so this constructs the
   * `TorpedoState` directly, in the `launch` phase at `LAUNCH_SPEED`, aimed at the point it was
   * spawned at — the same state a real launch leaves a weapon in a tick after it clears the
   * tube, minus the boat it would otherwise be credited to (`firedBy: 0`, an id no boat holds).
   * `owner` is the spawning account, for blame if it runs into someone (Q7 still applies).
   */
  spawnTorpedo(accountId: AccountId, weapon: WeaponId, team: TeamId, at: Vec2): void {
    const id = this.current.nextEntityId;

    const torpedo: TorpedoState = {
      id,
      weapon,
      team,
      owner: accountId,
      firedBy: 0,
      firedTick: this.current.clock.tick,
      aim: at,
      mimic: null,
      pos: at,
      facing: team === 'team1' ? 0 : 180,
      speed: LAUNCH_SPEED,
      travelled: 0,
      phase: 'launch',
      alignedTick: 0,
      track: null,
      trackTick: 0,
      lastPingTick: 0,
      transients: [],
    };

    this.current = {
      ...this.current,
      torpedoes: [...this.current.torpedoes, torpedo],
      nextEntityId: id + 1,
    };
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

  /** This boat's running tally, created on the first thing it does. */
  private tallyFor(boat: EntityId): RunningTally {
    const existing = this.tallies.get(boat);
    if (existing !== undefined) return existing;
    const fresh: RunningTally = {
      damageDealt: 0,
      sank: [],
      captures: 0,
      torpedoesFired: 0,
      destroyedTick: null,
    };
    this.tallies.set(boat, fresh);
    return fresh;
  }

  /**
   * The weapons that stopped being weapons this tick — every id whose blip is now a lie.
   *
   * A weapon is live while its phase is one of the three that move; `spent` is the corpse and
   * being absent from the list altogether is the scuttle that left no corpse to ring down. Both
   * are the same fact to a contact book, so both are reported, and the transition is read against
   * the tick's *incoming* weapons so an id is only ever ended once — the corpse of a warhead sits
   * in the list for four more seconds and must not be re-dropped on each of them, which would
   * delete a fresh contact if the entity counter ever came round.
   *
   * Returns nothing on the overwhelming majority of ticks, and allocates nothing on them: both
   * lists are a handful of entries and the common case is that neither has changed.
   */
  private endedWeapons(after: readonly TorpedoState[]): readonly EntityId[] {
    const wasLive = this.current.torpedoes.some((torpedo) => torpedo.phase !== 'spent');
    if (!wasLive) return [];

    const stillLive = new Set<EntityId>();
    for (const torpedo of after) {
      if (torpedo.phase !== 'spent') stillLive.add(torpedo.id);
    }

    const ended: EntityId[] = [];
    for (const torpedo of this.current.torpedoes) {
      if (torpedo.phase !== 'spent' && !stillLive.has(torpedo.id)) ended.push(torpedo.id);
    }
    return ended;
  }

  /**
   * Attribute this tick's warheads to the boats that fired them.
   *
   * Two rules, and both exist because a tick applies every warhead at once (`sim/weapons/phase`):
   *
   * **Damage is what landed.** The detonation reports its full yield against each hull it caught,
   * which can be more than the hull had left — two warheads arriving together each claim their
   * share of a boat with four hit points. So each attacker's figure is scaled by the hit points
   * the victim *actually* lost. Overkill is not damage dealt, and a results screen where the
   * numbers beat the fleet's whole hit-point pool is one nobody believes.
   *
   * **A kill goes to the largest contributor on the tick it died.** There is no killing blow to
   * find when four hits are applied simultaneously; picking the biggest is the reading that does
   * not depend on iteration order. A boat lost to rock or to a collision is nobody's kill, which
   * falls out of this for free — no detonation names it, so no card claims it.
   */
  private creditWeapons(
    before: readonly BoatState[],
    after: readonly BoatState[],
    detonations: readonly Detonation[],
    torpedoes: readonly TorpedoState[],
  ): void {
    if (detonations.length === 0) return;

    const firedBy = new Map(torpedoes.map((torpedo) => [torpedo.id, torpedo.firedBy]));
    /** Victim → attacker → the damage that attacker's warheads claimed against it. */
    const claimed = new Map<EntityId, Map<EntityId, number>>();
    for (const detonation of detonations) {
      const attacker = firedBy.get(detonation.torpedo);
      if (attacker === undefined) continue;
      for (const hit of detonation.hits) {
        const perAttacker = claimed.get(hit.boat) ?? new Map<EntityId, number>();
        perAttacker.set(attacker, (perAttacker.get(attacker) ?? 0) + hit.damage);
        claimed.set(hit.boat, perAttacker);
      }
    }
    if (claimed.size === 0) return;

    const priorHp = new Map(before.map((boat) => [boat.id, boat.hp]));
    const priorStatus = new Map(before.map((boat) => [boat.id, boat.status]));

    for (const boat of after) {
      const attackers = claimed.get(boat.id);
      if (attackers === undefined) continue;

      let total = 0;
      for (const damage of attackers.values()) total += damage;
      const lost = (priorHp.get(boat.id) ?? boat.hp) - boat.hp;
      const scale = total <= 0 ? 0 : Math.min(1, lost / total);

      let killer: EntityId | null = null;
      let largest = 0;
      for (const [attacker, damage] of attackers) {
        this.tallyFor(attacker).damageDealt += damage * scale;
        if (damage > largest) {
          largest = damage;
          killer = attacker;
        }
      }

      const sunkNow = boat.status === 'destroyed' && priorStatus.get(boat.id) === 'active';
      if (sunkNow && killer !== null) this.tallyFor(killer).sank.push(boat.id);
    }
  }

  /** Stamp the tick on every wreck that does not have one yet, whatever finished it. */
  private noteLosses(tick: number): void {
    for (const boat of this.current.boats) {
      if (boat.status !== 'destroyed') continue;
      const tally = this.tallyFor(boat.id);
      if (tally.destroyedTick === null) tally.destroyedTick = tick;
    }
  }

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

  /**
   * Try to put an objective in every empty slot, and leave empty the ones that cannot have one.
   *
   * A replacement keeps its slot's **label** and takes a **new id**: to a player it is
   * "objective 2" again, which is what they will say out loud, and to the wire it is a
   * different entity, which is what stops a client animating a circle gliding across the map to
   * a place nothing travelled to. It is placed clear of the zones still standing *and* of the
   * ones just retired — the position that was fought over a moment ago is the least interesting
   * place to put the next fight.
   *
   * **A slot that cannot be filled stays empty**, and the id is not spent on it: `spawnZone`
   * refuses rather than compromising (see its note), and this is where that refusal becomes
   * "the board runs one objective short for now". The next attempt comes with the next capture,
   * because a capture is the only thing that changes what is legal — the terrain does not move,
   * the band does not move, and the two constraints that *can* free a position are the standing
   * zones' separation and the deep quota, both of which are exactly what a capture releases.
   *
   * Filling is sequential rather than in one shot, and deliberately: each placement is part of
   * the board the next one is measured against, so two vacancies cannot both be granted the
   * same water or the last deep slot.
   */
  private fillVacancies(
    zones: readonly CaptureZone[],
    retired: readonly ZoneCapture[],
  ): readonly CaptureZone[] {
    const ruler = this.objectives;
    if (ruler === null) return zones;

    const vacant = vacantLabels(zones);
    if (vacant.length === 0) return zones;

    const clearOf = retired.map((capture) => capture.zone.centre);
    const next = zones.slice();
    for (const label of vacant) {
      const placed = spawnZone({
        ruler,
        extents: this.current.map.extents,
        rng: this.respawns,
        id: this.nextZoneId,
        label,
        standing: next,
        clearOf,
        armingTicks: Math.round(ARMING_SECONDS * SIM_TICK_HZ),
      });
      if (placed === null) continue;
      this.nextZoneId += 1;
      next.push(placed);
    }

    if (next.length === zones.length) return zones;
    // Back into slot order. The list is a set rather than a fixed-length array now, and a board
    // whose objectives shuffled position in the frame every time one was replaced would make a
    // client's list diffing — and a reader's eye down a log — work for nothing.
    return next.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  }

  private solve(tick: number, seconds: number): void {
    const extents = this.current.map.extents;

    // `levels` is hoisted so the acoustic entity and the ghost-rate driver below read the same
    // figure — a boat's ghost count and its loudness cannot disagree about how loud it is
    // (planning/15 §5).
    const levels = new Map<EntityId, EmittedLevels>();
    const entities: AcousticEntity[] = this.current.boats
      // A wreck that has sunk out of the map is not a reflector any more (`wreckHasLeftMap`) —
      // it has despawned, and an entity built for it would be a hull sitting far below the world
      // solving for nothing. Skipped before `emittedLevels` runs at all, so `levels` never holds
      // one either.
      .filter((boat) => !wreckHasLeftMap(boat))
      .map((boat) => {
        // A ringing pulse and a hull that has just hit a wall both reach the solver through
        // `emittedLevels` — the difference between them is inside that split now: a ping rides the
        // `filterable` channel, so it is still heard at full strength and still lights the water,
        // it just deafens less. A collision is broadband `deafening`, and nothing downstream
        // treats it as anything but the source level it becomes.
        const boatLevels = emittedLevels(boat, tick, SIM_TICK_HZ, this.tuning);
        levels.set(boat.id, boatLevels);
        return boatEntity(boat, extents, boatLevels, this.tuning);
      });
    // Weapons go in beside the boats, as the same shape, which is planning/04 §4's uniform entity
    // model cashed in: a torpedo lights cave walls, raises noise floors, and appears in the
    // enemy's picture without one line of the solver knowing what it is.
    for (const torpedo of this.current.torpedoes) {
      entities.push(
        torpedoEntity(
          torpedo,
          extents,
          torpedoEmittedLevels(torpedo, tick, SIM_TICK_HZ, this.tuning),
          this.tuning,
        ),
      );
    }

    const solution = this.solver.solve(entities);
    this.lastStats = solution.stats;

    // Before the pictures are folded, so a pulse and the reclassification it bought land in the
    // same frame the player fired it for. `sightingFor` reads what this writes.
    this.classifyDecoys(tick);

    // Ambient ghosts: one source per alive boat, drawn in id order so the RNG stream does not
    // depend on array order, and generated for both teams up front in `TEAM_IDS` order for the
    // same reason. A destroyed boat has no hydrophone and contributes nothing (planning/15 §6).
    const grid = visionGridFor(extents);
    const sources: Record<TeamId, GhostSource[]> = { team1: [], team2: [] };
    const alive = this.current.boats
      .filter((boat) => boat.status !== 'destroyed')
      .slice()
      .sort((a, b) => a.id - b.id);
    for (const boat of alive) {
      const boatLevels = levels.get(boat.id);
      if (boatLevels === undefined) continue;
      const excess =
        sourceLevelOf(
          {
            stats: boat.stats,
            speed: boat.speed,
            depth: depthAt(extents, boat.pos.y),
            damaged: isDamaged(boat),
            transients: boatLevels.deafening,
          },
          this.tuning,
        ) - boat.stats.sourceLevel;
      sources[boat.team].push({ pos: boat.pos, excess });
    }

    const ghosts: Record<TeamId, readonly Ghost[]> = { team1: [], team2: [] };
    for (const team of TEAM_IDS) {
      ghosts[team] = generateGhosts(sources[team], grid, this.ghosts, seconds, this.tuning);
    }

    // Before the pictures are folded, so a pulse that lands this solve reaches the wire on the
    // frame it landed on rather than the next one. It can run this early because it owes the solve
    // nothing: being pinged is a path from one named transducer to one named hull, and neither the
    // heatmap nor the picture has an opinion about it (`sim/acoustics/pings.ts`). Every team, not
    // only the ones the solve produced a picture for — a boat can be lit on a tick when its own
    // sonar is finding nothing at all, which is the tick the alert matters most.
    for (const team of TEAM_IDS) this.hearPings(team, tick, seconds);

    const heard = new Set<TeamId>();
    for (const vision of solution.vision) {
      heard.add(vision.team);
      this.pictures[vision.team].observe(
        vision,
        tick,
        seconds,
        (entity) => this.sightingFor(entity, vision.team),
        ghosts[vision.team],
      );
      this.hearLaunches(vision.team, vision.owners, tick, seconds);
    }
    // A team with nobody listening — every boat destroyed, or a solve that reached nothing —
    // still has to age. Without this its contacts would freeze mid-fade at the moment its last
    // hydrophone went quiet, which reads as the display having crashed rather than as the fleet
    // having been wiped out. Its ghosts ride along, so a team mid-solve-gap does not see its
    // halo stutter either (planning/15 §5).
    for (const team of TEAM_IDS) {
      if (!heard.has(team)) this.pictures[team].settle(seconds, ghosts[team]);
    }
  }

  /**
   * Which hostile tube-firing events `team` heard this solve (`match/vision.ts#HeardLaunch`).
   *
   * The rule is deliberately not a rule: a launch is a very loud transient, so it lights the
   * firing boat's own hull squares in whoever's picture can reach them, and "did we hear the
   * shot" is answered by asking whether that boat is in `owners`. Nothing here computes a level
   * or compares a threshold — the solve already did, and a second calculation beside it is how
   * the alert and the picture come to disagree about whether a boat was audible.
   *
   * `owners` is the *raw* solve output, before `TeamPicture` filters it down to what may be
   * revealed and before the confirmation threshold. That is right for an alert: hearing a bang
   * loud enough to classify is a lower bar than proving where a hull is, and the alert says only
   * that a weapon is in the water.
   */
  private hearLaunches(team: TeamId, owners: Int32Array, tick: number, seconds: number): void {
    const enemy = opposingTeam(team);
    // The window is one solve's worth of ticks. Inclusive at the far end, because a command
    // arrives *between* ticks and is stamped with the last one that completed — so a shot fired
    // immediately after the previous solve carries that solve's own tick number, and a strict
    // comparison would drop exactly the shots taken in the moment the player took them.
    const since = tick - TICKS_PER_SOLVE;

    for (const boat of this.current.boats) {
      if (boat.team !== enemy) continue;
      const launch = boat.transients.find((t) => t.kind === 'torpedo-launch' && t.tick >= since);
      if (launch === undefined) continue;
      if (!owners.includes(boat.id)) continue;
      // Keyed on the tick the *launch* fired, not the tick it was heard on. A shot that falls
      // inside two consecutive windows — which the inclusive end makes possible — has to dedupe
      // to one alert, and the solve tick would be a different number each time.
      this.pictures[team].noteLaunch(boat.pos, launch.tick, seconds);
    }
  }

  /**
   * Which hostile pulses lit `team`'s own boats this solve (`match/vision.ts#HeardPing`).
   *
   * The counterpart of `hearLaunches`, and deliberately *not* built the same way. A launch is
   * heard through the ordinary picture — the bang lights the firer's hull squares, so asking
   * whether that boat is in `owners` is asking the solve a question it has already answered. A
   * pulse cannot be read off the picture at all: the heatmap is a sum, so a listener's cell knows
   * how loud the water is and not one thing about whose transducer made it that way. So the level
   * is measured here, one named pinger to one named listener, out of the same primitives the ocean
   * uses (`sim/acoustics/pings.ts`).
   *
   * The window is the two ticks since the last solve, **exclusive** at the far end — where
   * `hearLaunches` is inclusive. A launch is a command, stamped with the last tick that completed
   * and therefore able to arrive after the solve carrying that number has run; a pulse is fired
   * inside the tick loop (`pulse()`), so every pulse tick falls in exactly one of these windows.
   * That exactness is what makes one pulse one alert even though the pinger has moved a few metres
   * by the time the next solve looks.
   */
  private hearPings(team: TeamId, tick: number, seconds: number): void {
    const enemy = opposingTeam(team);
    const since = tick - TICKS_PER_SOLVE + 1;

    const pulses: ActivePulse[] = [];
    for (const boat of this.current.boats) {
      if (boat.team !== enemy) continue;
      const pulse = boatPulse(boat, since);
      if (pulse !== null) pulses.push(pulse);
    }
    // A seeker's pulse and a submarine's are the same event to whoever it lands on, and a drone's
    // is louder than either. Nothing downstream distinguishes them.
    for (const weapon of this.current.torpedoes) {
      if (weapon.team !== enemy) continue;
      const pulse = seekerPulse(weapon, since);
      if (pulse !== null) pulses.push(pulse);
    }
    // Empty on almost every solve — a boat pulses once every two seconds and this runs ten times
    // a second — which is what keeps the pairing below free in the case that actually dominates.
    if (pulses.length === 0) return;

    const listeners: PulseListener[] = [];
    for (const boat of this.current.boats) {
      if (boat.team !== team) continue;
      const listener = boatListener(boat, this.tuning);
      if (listener !== null) listeners.push(listener);
    }
    // The drone hears on behalf of its team in the solve (`content/weapons.ts#WeaponHydrophone`),
    // so it hears a pulse here too. Every other load has no ears and is skipped.
    for (const weapon of this.current.torpedoes) {
      if (weapon.team !== team) continue;
      const listener = torpedoListener(weapon);
      if (listener !== null) listeners.push(listener);
    }

    for (const listener of listeners) {
      for (const pulse of pulses) {
        if (!pulseHeardBy(pulse, listener, this.terrain, this.tuning)) continue;
        // Keyed on the pulse's own tick and origin, so four boats lit by one pulse raise one
        // alert — `notePing` is where that collapse happens.
        this.pictures[team].notePing(pulse.at, pulse.tick, seconds);
      }
    }
  }

  /**
   * Which hostile decoys each team's active sonar stripped this solve.
   *
   * The pairing is tiny — boats with the switch on, times decoys in the water, which is almost
   * always zero — so it is done directly rather than through the solve. It has to be done
   * *somewhere* other than the solve: a summed power field cannot say whose pulse lit what, and
   * that is the whole argument in `sim/weapons/decoy.ts`.
   *
   * The window is one solve's worth of ticks, the same trick `hearLaunches` uses and for the same
   * reason. A boat pulses every two seconds and this runs every tenth of one, so without it a
   * boat with the switch on would be treated as pinging continuously — which would strip a decoy
   * the moment it drifted into range rather than on the pulse that measured it.
   */
  private classifyDecoys(tick: number): void {
    const decoys = this.current.torpedoes.filter((weapon) => weapon.mimic !== null);
    if (decoys.length === 0) return;

    for (const boat of this.current.boats) {
      if (boat.lastPingTick <= 0 || boat.lastPingTick < tick - TICKS_PER_SOLVE) continue;
      const caught = this.exposedDecoys[boat.team];

      for (const decoy of decoys) {
        // Its own team's decoys are not a puzzle it has to solve, and a decoy already stripped is
        // not one it has to solve twice.
        if (decoy.team === boat.team || caught.has(decoy.id)) continue;
        if (decoyRevealedBy(boat, decoy, this.terrain, this.tuning)) caught.add(decoy.id);
      }
    }
  }

  /**
   * What `team` may learn from a square sitting on entity `owner`: a hostile boat, a hostile
   * weapon, or nothing.
   *
   * Returning nothing for a friendly is what keeps your own fleet — and your own torpedoes — out
   * of your own sonar picture. The solver lights teammates exactly as readily as enemies; it has
   * no idea whose hull it is looking at, and that blindness is deliberate (planning/03 §5), so
   * the filter has to be here, where team membership is known.
   *
   * A **spent** weapon still reflects — it is a lump of metal in the water, and the bang it is
   * ringing down is the loudest thing the ocean has carried, so its squares keep lighting a
   * picture. But it is no longer a contact: the blip was dropped the tick its run ended
   * (`tick()`, over `ContactBook.drop`), and `confirm: false` is what stops the corpse being
   * re-minted while it rings down. It is set on both branches below, because a load with no
   * warhead ends with no bang at all and a decoy ends still wearing a submarine's silhouette.
   *
   * A **destroyed** boat is the same shape of exception, for a different reason. It still
   * reflects — `boatEntity` gives it a continuous voice of its own now (planning/04 §8, revised)
   * — so its squares keep lighting the picture and contributing to the battlefield's confusion.
   * But minting it as an ordinary confirmed contact would fight the channel that already shows
   * every wreck to everyone, unconditionally (`match/view.ts#WreckView`): a player would see the
   * same hull twice, once as a permanent grey hulk and once as a contact that can fade and slip
   * detection like a live one, which it cannot. `confirm: false` keeps the wreck out of that
   * second picture and leaves the first one as the only place a player learns where it is.
   */
  private sightingFor(owner: EntityId, team: TeamId): ContactSighting | undefined {
    const enemy = opposingTeam(team);

    const boat = this.current.boats.find(
      (candidate) => candidate.id === owner && candidate.team === enemy,
    );
    if (boat !== undefined) {
      return {
        id: boat.id,
        kind: 'boat',
        hull: boat.hull,
        // A boat has nothing for the identification threshold to buy: confirmation already
        // revealed the hull, and the hull *is* the class (planning/03 §6).
        weapon: null,
        pos: boat.pos,
        facing: boat.facing,
        ...(boat.status === 'destroyed' ? { confirm: false } : {}),
      };
    }

    const torpedo = this.current.torpedoes.find(
      (candidate) => candidate.id === owner && candidate.team === enemy,
    );
    if (torpedo === undefined) return undefined;

    /*
     * An active decoy this team has not pinged is reported as the boat it is imitating — the
     * hull class and all, so the scope draws the full silhouette and the mini-map a live contact
     * (`client/render/sonar.ts`). That is not the projection being generous: the squares that
     * confirmed it really were a submarine-sized reflector radiating a submarine's noise, and
     * this is the only place in the codebase that knows otherwise.
     *
     * Once a pulse has measured it (`classifyDecoys`) the same entity keeps its `ContactId` and
     * comes back as a torpedo — and a torpedo already named, because the pulse that stripped it
     * *was* the measurement. That is what turns the silhouette the player was chasing into a
     * blunt decoy dart in front of them rather than opening a second contact beside it, or
     * leaving them with an anonymous dart and a question the ping already answered.
     *
     * `weapon` is null here and that is load-bearing rather than incidental: a decoy heard well
     * enough to clear `identificationThreshold` would otherwise be handed to the player labelled
     * *active decoy*, which is precisely the answer the pulse is meant to cost them. The
     * classification band gives a team the type of a weapon that is honestly presenting as one;
     * it does not see through a disguise, because seeing through the disguise is a different
     * mechanic with a different price (`sim/weapons/decoy.ts`).
     */
    if (torpedo.mimic !== null && !this.exposedDecoys[team].has(torpedo.id)) {
      return {
        id: torpedo.id,
        kind: 'boat',
        hull: torpedo.mimic.hull,
        weapon: null,
        pos: torpedo.pos,
        facing: torpedo.facing,
        // A spent decoy is as dead as any other spent weapon, and the disguise does not survive
        // it. Without this the corpse would be re-minted on the next solve — under a *fresh*
        // `ContactId`, because the old one was dropped the tick its run ended — and the marker
        // this whole rule exists to remove would come straight back wearing a new number.
        ...(torpedo.phase === 'spent' ? { confirm: false } : {}),
      };
    }

    return {
      id: torpedo.id,
      kind: 'torpedo',
      hull: null,
      // What it actually is. Whether the team is told depends on how loudly they heard it, and
      // that comparison belongs to the picture rather than here (`match/vision.ts#observe`) —
      // except for the decoy this team has already stripped, where the answer was bought with a
      // pulse and `classified` is how that is spent.
      weapon: torpedo.weapon,
      ...(torpedo.mimic !== null ? { classified: true } : {}),
      pos: torpedo.pos,
      facing: torpedo.facing,
      ...(torpedo.phase === 'spent' ? { confirm: false } : {}),
    };
  }
}

/**
 * A `BoatTally` (`@seg/shared/match/results`) while it is still being written to.
 *
 * The same shape with the `readonly` taken off. A map of these is handed straight to
 * `buildResults` without a copy, so any drift from the shared shape is a compile error at that
 * call — which is exactly where it should be.
 */
interface RunningTally {
  damageDealt: number;
  readonly sank: EntityId[];
  captures: number;
  torpedoesFired: number;
  destroyedTick: number | null;
}

/** Every tube loaded and ready, for a debug-spawned boat. Same shape `deployMatch` gives a real one. */
function debugTubes(count: number): readonly TubeState[] {
  const tubes: TubeState[] = [];
  for (let index = 0; index < Math.max(0, Math.round(count)); index += 1) {
    tubes.push(newTube(index, DEFAULT_WEAPON));
  }
  return tubes;
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

/**
 * The board with this tick's captures taken off it.
 *
 * By id rather than by position: a captured zone is a *specific* entity, and its slot is about
 * to be refilled by a different one wearing the same label.
 */
function retire(
  zones: readonly CaptureZone[],
  captures: readonly ZoneCapture[],
): readonly CaptureZone[] {
  const taken = new Set(captures.map((capture) => capture.zone.id));
  return zones.filter((zone) => !taken.has(zone.id));
}

/**
 * The standings with this tick's captures added — one point each (planning/06 §2.2).
 *
 * Returns the standings it was given when nothing fell, so the caller can tell "no capture"
 * from "a capture worth nothing" by identity rather than by comparing numbers. The rest of each
 * standing is left alone here and rebuilt from the fleet by `standings`; this only moves the
 * one figure nothing about the boats can reconstruct.
 */
function tally(teams: MatchState['teams'], captures: readonly ZoneCapture[]): MatchState['teams'] {
  if (captures.length === 0) return teams;

  const scores: Record<TeamId, number> = { team1: 0, team2: 0 };
  for (const capture of captures) scores[capture.team] += 1;

  return {
    team1: { ...teams.team1, score: teams.team1.score + scores.team1 },
    team2: { ...teams.team2, score: teams.team2.score + scores.team2 },
  };
}
