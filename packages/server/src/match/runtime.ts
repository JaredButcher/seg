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
  activePingLevel,
  advanceZones,
  boatEntity,
  boatListener,
  boatPulse,
  buildResults,
  canFire,
  canDrop,
  chooseNext,
  decideAbandonment,
  decideMatch,
  decoyRevealedBy,
  dropCountermeasure,
  emittedLevels,
  HOLDING,
  DEFAULT_WEAPON,
  isTubeWeapon,
  LAUNCH_SPEED,
  launch,
  MATCH_DURATION_SECONDS,
  newLauncher,
  newTube,
  NOISEMAKER_SINK_SPEED,
  COUNTERMEASURE_DROP_HEADING,
  FieldArena,
  FIELD_SPECS,
  getWeapon,
  heardReach,
  hullMaterial,
  imagingReach,
  noiseFloorOf,
  objectiveRuler,
  packFieldMap,
  pruneTransients,
  pulseHeardBy,
  pulseSound,
  radiatedLevels,
  resolveBoat,
  resolveCollisions,
  respawnRng,
  returnThreshold,
  ringingSounds,
  selfNoiseOf,
  seekerPulse,
  seekerThreshold,
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
  toDecibels,
  toPower,
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
  type PingReachView,
  type SimStatsView,
  type ProbeListener,
  type ProbeReading,
  type DebugFieldKind,
  type FieldMapView,
  type MatchState,
  type HeatmapDemand,
  type NoiseHeatmap,
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

import { PerfTracker } from './perf.js';

/**
 * What one listener is working against: the noise floor it hears through, and the level a return
 * has to clear to be seen at all.
 *
 * The pair travels together because the second is derived from the first and nothing else
 * (`returnThreshold`), so a caller holding only the gate has thrown away a number it cannot get
 * back without inverting a content-table rule by hand.
 */
interface ListenerHearing {
  readonly floor: number;
  readonly gate: number;
}

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

/**
 * How many ticks a probe's cell stays in the heatmap's demand after it was last asked about
 * (planning/16 §3.9). A couple of seconds — long enough that clicking around a panel does not
 * re-pay the settling wait, short enough that a forgotten panel stops costing anything.
 */
const PROBE_CELL_TICKS = 40;

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
  /**
   * And which acoustic field each has asked to be drawn (`debug.setField`), on the same terms.
   *
   * A separate map rather than a flag beside the vision set because the two are independent
   * switches a developer reaches for separately — reading the water around a boat is exactly as
   * useful with the fog still on, and often more so.
   *
   * The `boat` is whatever the client last named, held rather than validated: which boat is picked
   * is the client's business and it changes as often as the player's selection does, so the check
   * that it still exists belongs at the moment the field is built and nowhere else.
   */
  /**
   * Lattice cells a probe has asked about, against the tick it last asked (planning/16 §3.9).
   *
   * A probe reads the heatmap at a point nothing else in the solve cares about, so the cell has to
   * be asked for before it holds anything — the first reading at a fresh point is therefore taken
   * before the water there was computed. That is reported as `ProbeReading.settled` rather than
   * quietly handed back as ambient: this is the instrument you would use to find a disagreement,
   * and it is not allowed to be the one telling the lie.
   *
   * Entries lapse so a panel nobody is using stops costing a cell a tick.
   */
  private readonly probeCells = new Map<number, number>();
  /** The cells the last solve actually filled — what makes a reading `settled`. */
  private probeFilled: ReadonlySet<number> = new Set();

  private readonly debugFields = new Map<
    AccountId,
    { readonly kind: DebugFieldKind; readonly boat: EntityId | null }
  >();
  /**
   * And which accounts have asked for the ping-reach rings (`debug.setReach`).
   *
   * A set rather than a map, because unlike a field there is nothing to choose: the rings cover
   * every active transducer in the match at once (`match/reach.ts`). Otherwise it is the vision
   * set exactly — per connection, empty on every match nobody turned it on for.
   */
  private readonly debugReach = new Set<AccountId>();
  /**
   * And which accounts have the statistics panel open (`debug.setStats`).
   *
   * The one debug switch that changes what the *server* does rather than only what it sends: the
   * stopwatch behind it is off until somebody is watching, so this set is also what arms it
   * (`perf.ts`).
   */
  private readonly debugStats = new Set<AccountId>();
  /** The stopwatch, dormant until the set above stops being empty. */
  private readonly perf = new PerfTracker();
  /**
   * The sweep the per-listener fields are measured with, built on first use.
   *
   * **Deliberately not the solver's own.** `AcousticSolver.solve` stays a pure function of its
   * entity list — several tests depend on that, and it is why ambient ghosts were kept out of it
   * too (`sim/acoustics/ghosts.ts`) — so a debug field that needs one boat's propagation runs its
   * own bounded sweep here, on the publish tick, rather than making the hot path carry a branch
   * for a feature nobody has switched on. One Dijkstra every half second, and only while somebody
   * is watching.
   */
  private fieldArena: FieldArena | null = null;
  /** Scratch for one field, one entry per lattice cell. Reused, because it is megabytes. */
  private fieldValues: Float64Array | null = null;
  /**
   * The worst listener gate each watched boat has met since its last overlay frame went out.
   *
   * What makes a `peak` field peak (`match/field.ts`). `detect` is a geodesic sweep plus one
   * scalar — the gate — and the sweep is the slow half of it in both senses: it costs a Dijkstra,
   * and it barely moves, since a boat at flank covers 7.5 m in the half second between frames
   * against a 20 m lattice. The gate is the half that moves, because it is read off the noise at
   * the listener and a pulse or an impact anywhere on the map shifts it for a few ticks and is
   * gone. So the gate is sampled on **every solve**, and the frame pairs the window's worst gate
   * with the sweep taken when it was packed.
   *
   * Only for boats somebody is actually watching a `peak` field of, so a match with no overlay on
   * — every production one, and most debug ones — samples nothing at all. Consumed and cleared by
   * the frame that reports it (`fieldMap`), which is what makes the window "since you last saw
   * this" rather than "since the match began", and what makes the next frame honest again once
   * the water has gone quiet.
   */
  private readonly gatePeaks = new Map<EntityId, number>();
  private lastStats: SolveStats | null = null;
  /**
   * The heatmap the last solve produced, or `null` before the first one.
   *
   * Held by reference and **rewritten by the next solve** — that is the arena's whole point
   * (`sim/acoustics/solve.ts#NoiseHeatmap`) — so it is only ever read on the tick that produced
   * it, which is the tick the publishing loop runs on. `noiseMap()` is the only reader, and it
   * packs a copy rather than handing the live object out past this class.
   */
  private lastNoise: NoiseHeatmap | null = null;
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
    // The stopwatch takes this tick's slot before anything writes to it (`perf.ts`). Every `start`
    // below hands back a zero and every `record` returns on its first line while nobody is
    // watching, which is what keeps the instrument out of the thing it measures.
    this.perf.beginTick(tick);
    const startedTick = this.perf.start();
    const startedWorld = this.perf.start();

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
      extents: this.current.map.extents,
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

    // And a boat that was sunk this tick, for the same reason and by the same rule. A last-known
    // marker is a real place a real submarine really was, and it stands until the boat is
    // re-confirmed somewhere else — which is what makes it worth reading. A *wreck's* marker
    // stands for a boat that is not coming back, at a position the wreck channel is already
    // drawing unconditionally and better (`match/view.ts#WreckView`), so leaving it up put two
    // silhouettes of one hull on the scope, one of them permanent and neither of them news.
    // `sightingFor` keeps the wreck from being re-minted afterwards; this is what removes the
    // contact it had while it was afloat.
    for (const sunk of this.sunkBoats(weapons.boats)) {
      for (const team of TEAM_IDS) this.pictures[team].contacts.drop(sunk);
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
    // One phase for the whole 20 Hz half of a tick: hulls stepped and collided, weapons run and
    // credited, objectives advanced, and the state assembled from all three. They were four rows
    // once and every one of them measured a hundredth of a millisecond — four ways of saying *not
    // this* in a panel whose job is to point at the part that costs something (`match/perf.ts`).
    this.perf.record('world', startedWorld);

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
    if (decision === null) {
      this.perf.record('tick', startedTick);
      return due;
    }

    this.current = { ...this.current, phase: 'complete' };
    this.finished = buildResults(this.current, decision, this.tallies, SIM_TICK_HZ);
    this.perf.record('tick', startedTick);
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
   * Drop this boat's noisemaker (`protocol/weapon.ts#WeaponDropMessage`).
   *
   * The countermeasure counterpart of `fire`, and it is a separate method rather than a tube index
   * because it is a separate piece of gear with no tube to name and no point to aim at
   * (`match/world.ts#CountermeasureState`). Returns whether anything actually went in the water,
   * which the caller uses only to decide whether the world moved: a launcher still reloading
   * refuses silently, because the countdown is already on the player's screen and the pip not
   * moving *is* the refusal.
   *
   * The ownership check is here rather than in the handler for the reason `fire` gives.
   */
  drop(accountId: AccountId, boatId: EntityId): boolean {
    const boat = this.current.boats.find((candidate) => candidate.id === boatId);
    if (boat === undefined || boat.owner !== accountId || boat.status === 'destroyed') return false;
    if (!canDrop(boat.countermeasure)) return false;

    const id = this.current.nextEntityId;
    const result = dropCountermeasure({
      boat,
      id,
      tick: this.current.clock.tick,
      tickHz: SIM_TICK_HZ,
    });

    this.current = {
      ...this.current,
      boats: this.current.boats.map((candidate) =>
        candidate.id === boatId ? result.boat : candidate,
      ),
      torpedoes: [...this.current.torpedoes, result.noisemaker],
      nextEntityId: id + 1,
    };
    return true;
  }

  /**
   * Choose what a tube loads next, or — with `swap` — eject what it is holding and load that now.
   *
   * Both refuse a weapon a tube may not hold (`isTubeWeapon`), which is two rules in one: a load
   * the phase cannot put in the water at all, so a player cannot quietly disarm a tube by picking
   * a mine the game has not built; and a countermeasure, which is deployable but lives in its own
   * launcher and would otherwise cost the boat a torpedo for something it already has. The picker
   * offers only tube loads, so this is the second copy of a rule the client already enforces —
   * which is the rule everywhere: the client checks so the player is told instantly, and the
   * server checks because the client is not trusted.
   */
  load(
    accountId: AccountId,
    boatId: EntityId,
    index: number,
    weapon: WeaponId,
    swap: boolean,
  ): boolean {
    if (!isTubeWeapon(weapon)) return false;
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

  /** Draw one acoustic field for an account, or stop drawing any (`debug.setField`). */
  setDebugField(
    accountId: AccountId,
    kind: DebugFieldKind | null,
    boat: EntityId | null = null,
  ): void {
    if (kind === null) this.debugFields.delete(accountId);
    else this.debugFields.set(accountId, { kind, boat });
  }

  /** What `accountId` is watching, or `undefined` for the overwhelming majority who are not. */
  debugFieldOf(accountId: AccountId): { kind: DebugFieldKind; boat: EntityId | null } | undefined {
    return this.debugFields.get(accountId);
  }

  /** Draw the ping-reach rings for an account, or stop (`debug.setReach`). */
  setDebugReach(accountId: AccountId, enabled: boolean): void {
    if (enabled) this.debugReach.add(accountId);
    else this.debugReach.delete(accountId);
  }

  /** Whether `accountId` is being sent the rings. */
  hasDebugReach(accountId: AccountId): boolean {
    return this.debugReach.has(accountId);
  }

  /** Whether anybody is, which is what lets the publishing loop skip measuring them. */
  get anyDebugReach(): boolean {
    return this.debugReach.size > 0;
  }

  /**
   * Open or close the statistics panel for an account (`debug.setStats`).
   *
   * The only debug switch that changes what the tick *does*: the stopwatch is dormant until
   * somebody is watching, so this is where it is armed and disarmed. The window is thrown away
   * when the last watcher leaves rather than left to go stale — the next one to open the panel
   * would otherwise read two seconds that ended some time ago as though they were now.
   */
  setDebugStats(accountId: AccountId, enabled: boolean): void {
    if (enabled) this.debugStats.add(accountId);
    else this.debugStats.delete(accountId);

    const watched = this.debugStats.size > 0;
    if (!watched && this.perf.enabled) this.perf.reset();
    this.perf.enabled = watched;
  }

  /** Whether `accountId` is being sent the panel. */
  hasDebugStats(accountId: AccountId): boolean {
    return this.debugStats.has(accountId);
  }

  /** Whether anybody is, which is what lets the publishing loop skip building it. */
  get anyDebugStats(): boolean {
    return this.debugStats.size > 0;
  }

  /**
   * The stopwatch's window, with the world's own counts folded in (`match/perf.ts`).
   *
   * The counts are taken here rather than in the tracker because they are facts about the match
   * and the tracker has no view of one: what is in the water now, and what the last solve made of
   * it (`SolveStats`). `null` before the first solve, when half of them would be invented.
   */
  simStats(): SimStatsView | null {
    const stats = this.lastStats;
    if (stats === null) return null;

    const lattice = this.solver.lattice;
    let water = 0;
    for (let i = 0; i < lattice.water.length; i += 1) water += lattice.water[i] ?? 0;

    return this.perf.snapshot({
      boats: this.current.boats.length,
      torpedoes: this.current.torpedoes.length,
      zones: this.current.zones.length,
      entities: stats.entities,
      sources: stats.sources,
      listeners: stats.listeners,
      fieldCells: stats.fieldCells,
      lookCells: stats.lookCells,
      reflectorCells: stats.reflectorCells,
      clippedFields: stats.clippedFields,
      visionCells: stats.visionCells,
      latticeCells: lattice.cellCount,
      waterCells: water,
    });
  }

  /**
   * The stopwatch itself, for the one phase that does not happen inside a tick.
   *
   * `publish` is the handler's work — building a frame per recipient and handing it to a socket —
   * and it runs after `tick` has returned, so the handler has to be able to time it against the
   * same window (`match/perf.ts#PERF_TOTALS`). Exposed rather than wrapped in a pair of methods
   * because a stopwatch with two halves is worse to use through a keyhole.
   */
  get stopwatch(): PerfTracker {
    return this.perf;
  }

  /**
   * One field, measured now and packed for the wire — or `null` when there is nothing to measure.
   *
   * `null` covers every ordinary refusal and they are all the same to a caller: no solve yet, a
   * per-listener field with no boat named, a boat that has sunk or was never there. The overlay
   * simply stops arriving, which is the client's cue to take it off the scope.
   *
   * Packed here rather than handed out raw because the heatmap it reads is a live view into the
   * solver's arena — the next solve overwrites it — and because packing is where the payload's
   * cost is decided (`match/field.ts`), which is not a decision the publishing loop should be
   * making for itself.
   *
   * "Now" is the whole of it for three of the four. A `peak` field is measured now and reported
   * against the window behind it, and **calling this closes that window** — it is the publishing
   * loop's once-a-frame call, not a getter.
   */
  fieldMap(kind: DebugFieldKind, boatId: EntityId | null): FieldMapView | null {
    const noise = this.lastNoise;
    if (noise === null) return null;

    const spec = FIELD_SPECS[kind];
    const lattice = this.solver.lattice;
    const values = this.scratchField(lattice.cellCount);

    // Both of these read the heatmap somewhere the solve had no reason to fill unless asked, so a
    // frame taken before the request reached a solve has nothing to draw (planning/16 §3.9). One
    // blank frame when an overlay is switched on, and the next one is real — which is exactly what
    // the header above says a missing overlay means.
    if ((kind === 'noise' || kind === 'imaging') && !noise.complete) return null;

    if (kind === 'noise') {
      // The floor as a power ratio, so the common cell — empty sea, which is most of the map —
      // costs a compare rather than a logarithm. This walks every lattice cell on the map, so
      // that is the difference between a couple of milliseconds and ten of them on the tick that
      // publishes.
      const quiet = toPower(spec.min);
      for (let cell = 0; cell < lattice.cellCount; cell += 1) {
        const power = noise.powerAtCell(cell);
        // Under the floor is *nothing here* rather than a dark wash over the whole map: at
        // ambient the sea is not quiet-but-interesting, it is empty (`match/field.ts`).
        values[cell] = power < quiet ? NaN : toDecibels(power);
      }
      return packFieldMap(spec, lattice, values);
    }

    // Everything below is a question about one boat's hydrophone, or one boat's position.
    const boat = this.current.boats.find(
      (candidate) => candidate.id === boatId && candidate.status !== 'destroyed',
    );
    if (boat === undefined) return null;

    const arena = (this.fieldArena ??= new FieldArena(lattice));
    arena.reset();
    // `imaging` is bounded by what the solver itself images with, so the overlay's edge is the
    // real edge rather than an artefact of how far this sweep happened to be followed. The other
    // two are followed as far as sound is followed at all.
    const reach = kind === 'imaging' ? this.tuning.maxImagingRange : this.tuning.maxRange;
    const field = arena.solve(boat.pos.x, boat.pos.y, {
      maxRange: reach,
      maxCells: this.tuning.maxFieldCells,
    });
    if (field.count === 0) return null;

    values.fill(NaN);

    if (kind === 'range') {
      for (let i = 0; i < field.count; i += 1)
        values[arena.cellAt(field, i)] = arena.rangeAt(field, i);
      return packFieldMap(spec, lattice, values);
    }

    const gate = this.listenerGate(boat, noise, arena.rangeAt(field, 0));

    if (kind === 'detect') {
      // How loud a source at each point would have to be to clear this boat's gate: the gate plus
      // whatever the path costs. The contour where it crosses a hull's rest level is that hull's
      // detection range against this listener, bending around headlands because the ranges are
      // geodesic rather than straight.
      //
      // The gate is the window's worst rather than this instant's, so a pulse or an impact that
      // rang and died between two frames is still in the one that follows it (`gatePeaks`). The
      // sweep is this instant's either way — it is the half that does not move.
      const worst = spec.window === 'peak' ? this.consumeGatePeak(boat.id, gate) : gate;
      for (let i = 0; i < field.count; i += 1) {
        values[arena.cellAt(field, i)] = worst + this.solver.lossDbAt(arena.rangeAt(field, i));
      }
      return packFieldMap(spec, lattice, values);
    }

    // `imaging`: what a rock face at each point would return, against the same gate. The same
    // arithmetic the solve does for terrain (`solve.ts#look`), which is the point — an overlay
    // that computed the imaging edge its own way would eventually disagree with the picture.
    const terrainGate = toPower(gate + this.tuning.terrainAbsorption);
    for (let i = 0; i < field.count; i += 1) {
      const cell = arena.cellAt(field, i);
      const returned = noise.powerAtCell(cell) * this.solver.lossFactorAt(arena.rangeAt(field, i));
      // Under the gate is water this boat is lighting too faintly to get an answer back from,
      // which is *absent* rather than a low reading — the edge of the colour is the edge of what
      // it can see.
      values[cell] = returned < terrainGate ? NaN : toDecibels(returned / terrainGate);
    }
    return packFieldMap(spec, lattice, values);
  }

  /**
   * Every number the model holds about one point, against one boat (`match/probe.ts`).
   *
   * A question rather than a subscription, and measured on the tick it is asked on — the panel
   * that reads this is somebody clicking on the water, so there is nothing to accumulate and
   * nothing to rate-limit against. `null` only when there is nothing to measure at all: no solve
   * yet, or a point off the map.
   *
   * **Nothing here is computed a second way.** Every figure comes back from the same helper the
   * simulation itself uses — `noiseFloorOf`, `returnThreshold`, the solver's own loss table, the
   * same arena sweep the overlays run — because a probe that derived its own answer would
   * eventually disagree with the game, and it is the instrument you would reach for to find out
   * why. Where a figure has an overlay, this is that overlay at one point, and the file header
   * says which.
   *
   * The listener half is skipped rather than faked for a boat that was not named, has sunk, or was
   * never here: the water's own readings do not need anybody to be listening for them.
   */
  probe(boatId: EntityId | null, at: Vec2): ProbeReading | null {
    const noise = this.lastNoise;
    if (noise === null) return null;

    const lattice = this.solver.lattice;
    const index = lattice.indexAt(at.x, at.y);
    if (index < 0) return null;
    // Rock reads at the water beside it, exactly as the solver has it — a wall's face is lit
    // through the water it fronts (`WaterLattice.waterIndexAt`). `water` is what says which of the
    // two the reader is looking at.
    const cell = lattice.waterIndexAt(at.x, at.y);
    if (cell < 0) return null;

    const settled = noise.complete || this.probeFilled.has(cell);
    const reading: ProbeReading = {
      at,
      depth: depthAt(this.current.map.extents, at.y),
      water: lattice.water[index] === 1,
      cell,
      noise: noise.levelAtCell(cell),
      background: noise.backgroundLevelAtCell(cell),
      // Whether the solve this was read from had been told to compute the water here. A fresh
      // point has not, so its first reading is the ambient sea rather than the truth, and the
      // client asks again once the cell is in (`ProbeReading.settled`).
      settled,
      listener: this.probeListener(boatId, cell, at, noise, settled),
    };
    this.probeCells.set(cell, this.current.clock.tick);
    return reading;
  }

  /**
   * The pair-wise half of a probe: this point as heard from one boat.
   *
   * The sweep is the same bounded Dijkstra the per-listener fields run, out of the boat rather
   * than out of the point — path length is symmetric, so one field answers both directions
   * (`sim/acoustics/field.ts`), and running it from the boat is what makes the number here the
   * same number the overlay would draw. Scanned linearly for the one cell wanted, which is the
   * honest cost of asking about one cell: a probe is a click, not a loop.
   */
  private probeListener(
    boatId: EntityId | null,
    cell: number,
    at: Vec2,
    noise: NoiseHeatmap,
    settled: boolean,
  ): ProbeListener | null {
    const boat = this.current.boats.find(
      (candidate) => candidate.id === boatId && candidate.status !== 'destroyed',
    );
    if (boat === undefined) return null;

    const arena = (this.fieldArena ??= new FieldArena(this.solver.lattice));
    arena.reset();
    const field = arena.solve(boat.pos.x, boat.pos.y, {
      maxRange: this.tuning.maxRange,
      maxCells: this.tuning.maxFieldCells,
    });

    let range: number | null = null;
    for (let i = 0; i < field.count; i += 1) {
      if (arena.cellAt(field, i) !== cell) continue;
      range = arena.rangeAt(field, i);
      break;
    }

    const heard = this.listenerHearing(
      boat,
      noise,
      // The sweep's own seed where there is one, exactly as the overlays take it. A boat with no
      // field at all — standing somewhere sound cannot leave — still has a floor and a gate.
      field.count === 0 ? this.seedRangeAt(boat.pos) : arena.rangeAt(field, 0),
    );
    const gate = heard.gate;
    const loss = range === null ? null : this.solver.lossDbAt(range);

    // The imaging figure, as `fieldMap` computes it and `solve.ts#look` decides it: what the water
    // there is lit by, attenuated over the return leg, against the gate a reflection has to clear.
    let imaging: number | null = null;
    // Absent rather than wrong when the water here has not been computed yet: this figure is the
    // one thing under `listener` that is not self-contained, because it reads the heatmap.
    if (range !== null && settled) {
      const terrainGate = toPower(gate + this.tuning.terrainAbsorption);
      const returned = noise.powerAtCell(cell) * this.solver.lossFactorAt(range);
      imaging = returned < terrainGate ? null : toDecibels(returned / terrainGate);
    }

    return {
      boat: boat.id,
      from: boat.pos,
      straight: Math.hypot(at.x - boat.pos.x, at.y - boat.pos.y),
      range,
      loss,
      selfNoise: selfNoiseOf(boat.stats, boat.speed, this.tuning),
      floor: heard.floor,
      gate,
      audible: loss === null ? null : gate + loss,
      imaging,
    };
  }

  /**
   * Every active transducer in the water and the two radii of its pulse (`match/reach.ts`).
   *
   * Measured for a pulse fired **now**, whether or not one is due: a transducer is dark for most
   * of the time anyone would be watching it, and rings that blinked on for two frames in forty
   * would be unreadable. So each pinger is rebuilt as the entity it would be *mid-pulse* — the
   * machinery it is really running, plus its own pulse at full strength (`pulseSound`) — and the
   * level that comes out is the one the solver would put in the water.
   *
   * Two passes, and it has to be two: the outer radius of one boat's pulse is a fact about the
   * *other* side's ears, so every gate in the match has to be known before any radius is. The
   * gates are the real ones, read off this tick's heatmap (`entityHearing`), which is what makes the
   * ring move when the enemy slows down to listen rather than only when this boat changes hulls.
   *
   * The keenest hostile listener sets the outer ring, because "how far away would this be heard"
   * has exactly one useful answer and it is the worst case for the boat about to press the button.
   * Hostile *drones* count among those listeners: they are listeners in the solve, with better
   * ears than any hull carries, and a ring that ignored them would be quietly optimistic in the
   * one situation where it matters most.
   *
   * The inner ring is measured against whichever receiver the platform actually has. A boat and a
   * drone hear through the solve, so theirs is the rock their pulse would light; a homing torpedo
   * hears through its seeker, so theirs is the range it would acquire a hull from — the number its
   * homing is made of. Two receivers, two kinds of reflector, one inversion (`match/reach.ts`).
   *
   * Empty before the first solve, and empty — not absent — when nothing is carrying an active
   * transducer, which is most of a match.
   */
  pingReach(): readonly PingReachView[] {
    const noise = this.lastNoise;
    if (noise === null) return [];

    const tick = this.current.clock.tick;
    const extents = this.current.map.extents;
    /** The lowest gate on each side: whoever over there is listening hardest. */
    const keenest: Record<TeamId, number> = { team1: Infinity, team2: Infinity };
    /**
     * The least absorbent thing in the water, for the seekers.
     *
     * A seeker's reach is a fact about what it is looking at — `seekerEcho` pays the target hull's
     * absorption — so the envelope is set by the most reflective hull in the match, exactly as the
     * solver sizes its own sweeps by `softestAbsorption` (`solve.ts#reachOf`). A bare hull if
     * there is somehow nothing to bounce off.
     */
    let softest = this.tuning.hullAbsorption;
    const pingers: {
      readonly id: EntityId;
      readonly team: TeamId;
      readonly pos: Vec2;
      /** What it would be radiating with its own pulse going out, dB. */
      readonly pulsing: number;
      /** Its own ears' gate, or `null` for a platform that does not hear through the solve. */
      readonly gate: number | null;
      /**
       * Its seeker's own pulse level, for a homing load — `null` for anything that does not home.
       *
       * The bare `seekerPingLevel` rather than the level above, and the difference is the seeker's
       * own model: its receiver is listening for *its own pulse* coming back, so the motor beside
       * it is noise it is deaf to (`sim/weapons/seeker.ts#seekerEcho`). The outer ring is the
       * whole weapon at once, because that is what the other side hears.
       */
      readonly homing: number | null;
    }[] = [];

    for (const boat of this.current.boats) {
      // A wreck that has sunk out of the map is not there any more, exactly as the solve has it —
      // and as `seekerLook` has it, which is the other reader of this same filter.
      if (wreckHasLeftMap(boat)) continue;
      softest = Math.min(softest, hullMaterial(boat.stats, this.tuning).absorption);
      const levels = emittedLevels(boat, tick, SIM_TICK_HZ, this.tuning);
      const entity = boatEntity(boat, extents, levels, this.tuning);
      const gate = this.entityHearing(entity, noise)?.gate ?? null;
      if (gate !== null) keenest[boat.team] = Math.min(keenest[boat.team], gate);

      if (boat.status === 'destroyed' || !boat.activeSonar) continue;
      // Its bangs, plus a pulse at full strength — rebuilt from the transients rather than added
      // to `levels`, which already carries whatever pulse is really ringing and would otherwise
      // be counted twice on the four ticks in ten that a pinging boat is lit.
      const armed = boatEntity(
        boat,
        extents,
        [
          ...ringingSounds(boat.transients, tick, SIM_TICK_HZ),
          pulseSound(activePingLevel(boat.stats.pingLevel, 0, this.tuning), this.tuning),
        ],
        this.tuning,
      );
      pingers.push({
        id: boat.id,
        team: boat.team,
        pos: boat.pos,
        pulsing: armed.sourceLevel,
        gate,
        homing: null,
      });
    }

    for (const torpedo of this.current.torpedoes) {
      const levels = torpedoEmittedLevels(torpedo, tick, SIM_TICK_HZ, this.tuning);
      const entity = torpedoEntity(torpedo, extents, levels, this.tuning);
      const gate = this.entityHearing(entity, noise)?.gate ?? null;
      if (gate !== null) keenest[torpedo.team] = Math.min(keenest[torpedo.team], gate);
      // A live decoy is a reflector wearing a boat's stat block, and a seeker cannot tell — which
      // is what it is bought for. So it counts towards the envelope like the hull it mimics.
      if (torpedo.mimic !== null && torpedo.phase !== 'spent') {
        softest = Math.min(softest, hullMaterial(torpedo.mimic.stats, this.tuning).absorption);
      }

      // The same three conditions `sim/weapons/phase.ts#look` fires a pulse on, and no fourth:
      // a weapon that has not armed yet, or has spent itself, is carrying a transducer that is
      // switched off, and a load with no transducer at all (a decoy, a mine) never had one.
      const def = getWeapon(torpedo.weapon);
      if (torpedo.phase !== 'enabled' || def.seekerPingLevel <= 0 || def.pingIntervalMs <= 0) {
        continue;
      }
      const armed = torpedoEntity(
        torpedo,
        extents,
        [
          ...ringingSounds(torpedo.transients, tick, SIM_TICK_HZ),
          pulseSound(activePingLevel(def.seekerPingLevel, 0, this.tuning), this.tuning),
        ],
        this.tuning,
      );
      pingers.push({
        id: torpedo.id,
        team: torpedo.team,
        pos: torpedo.pos,
        pulsing: armed.sourceLevel,
        gate,
        homing: def.behaviour === 'seeker' ? def.seekerPingLevel : null,
      });
    }

    const seekerGate = seekerThreshold(this.tuning);

    return pingers.map((pinger) => {
      const hostile = keenest[opposingTeam(pinger.team)];
      return {
        id: pinger.id,
        team: pinger.team,
        pos: pinger.pos,
        // Two receivers, one inversion (`match/reach.ts`). A platform that hears through the solve
        // reads its own echo off *rock*, against its own noise-dependent gate; a homing weapon
        // reads it off a *hull*, against the flat threshold its seeker never gets quieter than.
        imaging:
          pinger.gate !== null
            ? imagingReach(pinger.pulsing, pinger.gate, this.tuning.terrainAbsorption, this.tuning)
            : pinger.homing !== null
              ? imagingReach(pinger.homing, seekerGate, softest, this.tuning)
              : null,
        // Nobody left to hear it is a real reading and it is zero, not a ring of unknown size.
        heard: Number.isFinite(hostile) ? heardReach(pinger.pulsing, hostile, this.tuning) : 0,
      };
    });
  }

  /**
   * The level a return has to reach for one boat to see it — its noise floor, plus the detection
   * threshold, less its array gain.
   *
   * The floor is the *real* one, read off the heatmap at the boat's own cell with the boat's own
   * racket taken back out, exactly as `solve.ts#look` does it. That is what makes the two
   * listener fields worth having rather than being a relabelled range plot: they move when a
   * teammate goes to flank, when a weapon runs past, when somebody pings. Its own noise at its own
   * position is a division by zero dressed up as a number, and `selfNoise` is the figure that term
   * was always standing in for.
   *
   * `seedRange` is the distance from the boat to the centre of the cell it stands in — the first
   * entry of its own field — which is what its own contribution has been attenuated by.
   */
  private listenerGate(boat: BoatState, noise: NoiseHeatmap, seedRange: number): number {
    return this.listenerHearing(boat, noise, seedRange).gate;
  }

  /** The same, with the floor it was built on — what a probe reads out (`match/probe.ts`). */
  private listenerHearing(
    boat: BoatState,
    noise: NoiseHeatmap,
    seedRange: number,
  ): ListenerHearing {
    const entity = boatEntity(
      boat,
      this.current.map.extents,
      emittedLevels(boat, this.current.clock.tick, SIM_TICK_HZ, this.tuning),
      this.tuning,
    );
    const heard = this.entityHearing(entity, noise, seedRange);
    if (heard !== null) return heard;

    // A boat always has a hydrophone until it is destroyed, and a destroyed one is refused long
    // before this (`fieldMap`, `trackGatePeaks`, `probeListener`). The fallback is this boat in
    // perfectly quiet water rather than a throw: this is a debug path, and no reading on it is
    // worth taking a match down for.
    const floor = noiseFloorOf(
      -Infinity,
      selfNoiseOf(boat.stats, boat.speed, this.tuning),
      this.tuning,
    );
    return { floor, gate: returnThreshold(floor, boat.stats.arrayGain, this.tuning) };
  }

  /**
   * The same rule for anything that hears at all: a boat, or the one weapon that carries ears.
   *
   * Everything `listenerGate` explains, expressed against the shape both platforms already reach
   * the solver as (`AcousticEntity`) rather than against `BoatState`. That is what lets a drone's
   * pulse be measured with the same arithmetic as a submarine's — the drone is a listener in the
   * solve like any other, and a second copy of this rule is how the two would start disagreeing.
   *
   * `null` for a platform with no hydrophone, which is every weapon except the drone and every
   * boat that has been sunk. The caller decides what that means; here it is simply not a listener.
   * A homing torpedo is *not* deaf for having no entry here — its seeker is a receiver with a
   * threshold of its own (`sim/weapons/seeker.ts`), deliberately kept out of the solve so that a
   * weapon's ears do not become its team's. What it is not is a listener in the pooled picture.
   */
  private entityHearing(
    entity: AcousticEntity,
    noise: NoiseHeatmap,
    seedRange = this.seedRangeAt(entity.pos),
  ): ListenerHearing | null {
    const ears = entity.hydrophone;
    if (ears === null) return null;

    const cell = this.solver.lattice.waterIndexAt(entity.pos.x, entity.pos.y);
    // The solver's own table, not `transmissionLoss` — see `AcousticSolver.lossFactorAt`. The
    // subtraction below is the difference of two nearly equal large numbers, and a hundredth of a
    // decibel of disagreement here leaves a thirty-decibel phantom in it, so this has to be the
    // same `deafeningLevel` the heatmap was accumulated from and not a second reckoning of it.
    const own =
      (entity.deafeningLevel > -Infinity ? toPower(entity.deafeningLevel) : 0) *
      this.solver.lossFactorAt(seedRange);

    const around = cell < 0 ? 0 : Math.max(0, noise.backgroundPowerAtCell(cell) - own);
    const floor = noiseFloorOf(toDecibels(around), ears.selfNoise, this.tuning);
    // Both, because the floor is not recoverable from the gate without re-deriving
    // `returnThreshold` backwards — and a probe that did that would be the one instrument in the
    // game computing a figure its own way (`match/probe.ts`).
    return { floor, gate: returnThreshold(floor, ears.gain, this.tuning) };
  }

  /**
   * One gate sample per watched boat, into `gatePeaks`. Called on every solve.
   *
   * The first line is the guard and it is the whole cost for a match with no overlay running: an
   * empty `debugFields` is a match nobody has switched one on for, which is all of them until
   * somebody types the command. Beyond that it is one gate per *distinct boat* being watched —
   * a heatmap lookup and the arithmetic of `listenerGate`, no sweep — however many developers are
   * watching it.
   *
   * A boat that has stopped being watched, or has sunk, forgets what it had rather than keeping a
   * peak that would surprise whoever picks it up next.
   */
  /**
   * What this tick's solve has to fill the heatmap in for, beyond its own needs
   * (planning/16 §3.9).
   *
   * A solve writes the heatmap only where something reads it — rock, hulls, listeners — which is a
   * per cent or two of the water. The debug instruments read it somewhere else by definition, so
   * they have to ask, and what they ask for is the only reason a tick ever pays for the rest.
   *
   * Two of the four overlays want the whole map: `noise` draws it, and `imaging` reads it across a
   * boat's entire field. `range` and `detect` are geometry and a gate, and both are already
   * covered. A probe wants one cell, and says which.
   */
  private heatmapDemand(): HeatmapDemand {
    for (const request of this.debugFields.values()) {
      if (request.kind === 'noise' || request.kind === 'imaging') return { everywhere: true };
    }
    const tick = this.current.clock.tick;
    for (const [cell, asked] of this.probeCells) {
      if (tick - asked > PROBE_CELL_TICKS) this.probeCells.delete(cell);
    }
    if (this.probeCells.size === 0) {
      this.probeFilled = new Set();
      return {};
    }
    const cells = [...this.probeCells.keys()];
    this.probeFilled = new Set(cells);
    return { cells };
  }

  private trackGatePeaks(noise: NoiseHeatmap): void {
    if (this.debugFields.size === 0 && this.gatePeaks.size === 0) return;

    const watched = new Set<EntityId>();
    for (const request of this.debugFields.values()) {
      if (request.boat !== null && FIELD_SPECS[request.kind].window === 'peak') {
        watched.add(request.boat);
      }
    }
    for (const boat of this.gatePeaks.keys()) {
      if (!watched.has(boat)) this.gatePeaks.delete(boat);
    }
    if (watched.size === 0) return;

    for (const id of watched) {
      const boat = this.current.boats.find(
        (candidate) => candidate.id === id && candidate.status !== 'destroyed',
      );
      if (boat === undefined) {
        this.gatePeaks.delete(id);
        continue;
      }
      const gate = this.listenerGate(boat, noise, this.seedRangeAt(boat.pos));
      const peak = this.gatePeaks.get(id);
      if (peak === undefined || gate > peak) this.gatePeaks.set(id, gate);
    }
  }

  /**
   * The window's worst gate for a boat, against the one measured now, and the window closed.
   *
   * `now` wins when there is no peak to compare against — a boat whose overlay was only just
   * asked for has no window behind it yet, and one measured outside the publishing loop (a test,
   * a console) has none either. Both should read the instant rather than nothing.
   */
  private consumeGatePeak(boat: EntityId, now: number): number {
    const peak = this.gatePeaks.get(boat);
    this.gatePeaks.delete(boat);
    return peak === undefined || now > peak ? now : peak;
  }

  /**
   * The distance from a point to the centre of the lattice cell it stands in.
   *
   * `FieldArena.solve` seeds its sweep with exactly this and `listenerGate` needs it to take the
   * boat's own contribution back out, so a gate sampled between frames — which has no sweep to
   * read it off — computes it the same way rather than passing zero and putting the boat's own
   * racket through a division by nothing.
   */
  private seedRangeAt(pos: Vec2): number {
    const lattice = this.solver.lattice;
    const cell = lattice.waterIndexAt(pos.x, pos.y);
    if (cell < 0) return 0;
    const centre = lattice.centreOf(cell);
    return Math.hypot(pos.x - centre.x, pos.y - centre.y);
  }

  /** The reused per-cell buffer the field builders fill. Allocated once, and it is megabytes. */
  private scratchField(cells: number): Float64Array {
    if (this.fieldValues === null || this.fieldValues.length < cells) {
      this.fieldValues = new Float64Array(cells);
    }
    return this.fieldValues;
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
      countermeasure: newLauncher(),
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
   *
   * A **noisemaker** is the one load this cannot spawn that way, and it is spawned the way one is
   * actually dropped instead: pointed down, at its sinking speed, already `enabled`. A countermeasure
   * has no run-out to fake the first tick of (`sim/weapons/launch.ts#dropCountermeasure`), and one
   * spawned in the `launch` phase would spend its life creeping toward the point it was spawned at
   * rather than sinking away from it — which is a debug tool that lies about the thing it exists to
   * let a developer look at.
   */
  spawnTorpedo(accountId: AccountId, weapon: WeaponId, team: TeamId, at: Vec2): void {
    const id = this.current.nextEntityId;
    const dropped = getWeapon(weapon).behaviour === 'noisemaker';

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
      facing: dropped ? COUNTERMEASURE_DROP_HEADING : team === 'team1' ? 0 : 180,
      speed: dropped ? NOISEMAKER_SINK_SPEED : LAUNCH_SPEED,
      travelled: 0,
      phase: dropped ? 'enabled' : 'launch',
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
   * The boats that stopped being boats this tick — every hull whose contact is now a wreck's.
   *
   * Read against the tick's *incoming* fleet, so a hull is only ever reported once however long
   * the wreck sits on the bottom afterwards. That is the same guard `endedWeapons` needs and for
   * the same reason: dropping a contact is destructive, and re-dropping a wreck on every tick of
   * the rest of the match would delete a live contact the day the entity counter came round.
   *
   * A hull can only be lost to a warhead (`sim/weapons/phase.ts`) or to rock
   * (`sim/collision/phase.ts`), and `after` is the fleet both have finished with, so one
   * comparison catches every way a boat can go. Returns nothing on almost every tick.
   */
  private sunkBoats(after: readonly BoatState[]): readonly EntityId[] {
    const sunk: EntityId[] = [];
    for (const boat of after) {
      if (boat.status !== 'destroyed') continue;
      const before = this.current.boats.find((candidate) => candidate.id === boat.id);
      if (before !== undefined && before.status !== 'destroyed') sunk.push(boat.id);
    }
    return sunk;
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
    const startedAcoustics = this.perf.start();
    const startedEntities = this.perf.start();
    const levels = new Map<EntityId, EmittedLevels>();
    const entities: AcousticEntity[] = this.current.boats
      // A wreck that has sunk out of the map is not a reflector any more (`wreckHasLeftMap`) —
      // it has despawned, and an entity built for it would be a hull sitting far below the world
      // solving for nothing. Skipped before `emittedLevels` runs at all, so `levels` never holds
      // one either.
      .filter((boat) => !wreckHasLeftMap(boat))
      .map((boat) => {
        // A ringing pulse and a hull that has just hit a wall both reach the solver through
        // `emittedLevels` — the difference between them is one number each carries: a ping's
        // `noiseFraction` is a quarter, so it is still heard at full strength and still lights the
        // water, it just deafens less. A collision's is 1, and nothing downstream treats it as
        // anything but the source level it becomes.
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

    // The entity list above is a step of the acoustic tick rather than something that happens
    // before one: it is `emittedLevels` and `boatEntity` over the whole world, and left unmeasured
    // it would fall into the gap between two phases (`match/perf.ts#PERF_SOLVE_PHASES`).
    this.perf.record('entities', startedEntities);

    // The stopwatch goes *into* the solve, which is what breaks the meat of this simulation open
    // into its five passes. Handed over whether or not anybody is watching — every method on it
    // returns on its first line while nobody is — so the hot path carries no branch of its own.
    const solution = this.solver.solve(entities, this.perf, this.heatmapDemand());
    this.perf.record('acoustics', startedAcoustics);
    this.lastStats = solution.stats;
    // Kept for the debug overlay, and only ever read on this tick — see the field's note.
    this.lastNoise = solution.noise;
    // The one thing an overlay reads that *cannot* wait for the tick it is published on: the
    // deafening a developer is watching for is over in a handful of ticks (`gatePeaks`).
    this.trackGatePeaks(solution.noise);

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
            // The broadband racket only, which is what this read has always meant. A ghost is a
            // false contact teased out of *noise*, and a coherent tone is the one thing a listener
            // is assumed to be able to tell apart from noise — so a boat's own pulse drives no
            // ghosts, the same as before transients carried fractions of their own.
            transients: radiatedLevels(boatLevels.filter((sound) => sound.noiseFraction >= 1)),
          },
          this.tuning,
        ) - boat.stats.sourceLevel;
      sources[boat.team].push({ pos: boat.pos, excess });
    }

    const startedVision = this.perf.start();
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
    // Everything an acoustic tick does *with* a solve rather than to get one: the ambient ghosts,
    // the two event channels, and folding the result into each team's picture. Measured together
    // because they are one concern — what the fleet is told — and apart from the solve because
    // that is a different question with a different answer.
    this.perf.record('vision', startedVision);
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
   *
   * It is half the rule, and the other half is in `tick()`: this stops a wreck being *minted*,
   * and `sunkBoats` drops the contact the hull already had while it was afloat. Without both, a
   * boat killed after it slipped detection left its last-known silhouette standing for the rest
   * of the match, a few hundred metres from the wreck marking where it actually died.
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
