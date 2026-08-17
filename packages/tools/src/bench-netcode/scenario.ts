/**
 * The match the netcode benchmarks measure, and the knobs that shape it.
 *
 * Shared by every probe in this directory so that two of them quoting a frame size are quoting the
 * same frame, exactly as `bench-acoustics/scenario.ts` does for cell counts. Everything is
 * deterministic — fixed seed, boats berthed by index, no dice anywhere — because a benchmark whose
 * *workload* moves between runs cannot be compared against itself a month later.
 *
 * ## What this drives, and why it is the real thing
 *
 * A real `MatchStore`, a real `MatchRuntime`, a real `MatchHandler`, and a real `JsonCodec` behind
 * a `CountingCodec`. The only fake is the socket: `BenchConnection` encodes exactly as
 * `realtime/gateway.ts` does — `codec.encode(message)` — counts the bytes, and drops them on the
 * floor instead of handing them to `ws`. Everything above that line is production code, which is
 * the whole point: a bench that reimplements the publish path measures the reimplementation.
 *
 * ## The one mirror, and what pins it
 *
 * `publishByPhase` is the exception. `MatchHandler.publish` builds a frame and sends it in one
 * step, so the real path cannot tell you what `vision` cost against `assemble` against `encode`.
 * The mirror below reproduces `MatchStore.viewFor` in four timed pieces. It is load-bearing and it
 * is **pinned byte-for-byte against the real handler** by `netcode-harness.test.ts` — two
 * identical scenarios driven to the same tick, published down the two paths, compared as bytes.
 * If that test fails, the mirror has drifted and every phase number here is a lie.
 */

import {
  CountingCodec,
  JsonCodec,
  SIM_TICK_HZ,
  createMatchView,
  deployMatch,
  generateMap,
  isMapSize,
  isGameMode,
  isMapType,
  isThrottleNotch,
  teamFor,
  throttleSpeedFor,
  viewFor,
  type AccountId,
  type BoatTemplate,
  type DeployingPlayer,
  type GameMode,
  type HullId,
  type MapSize,
  type MapType,
  type MatchState,
  type MatchViewState,
  type Message,
  type ServerMessage,
  type CodecId,
  type ThrottleNotch,
} from '@seg/shared';
import { MatchRuntime, publishMatch, ViewSequencer } from '@seg/server/match/index';
import { ConnectionRegistry, type PlayerConnection } from '@seg/server/realtime/connections';

// ── Options ───────────────────────────────────────────────────────────────────────────

export interface NetBenchOptions {
  /** Players seated in the match, split evenly between the two teams. 2–16 (`MAX_PLAYERS_MAX`). */
  readonly players: number;
  /** Boats each of them brings. 1–10 (`FLEET_MAX_BOATS`). */
  readonly boats: number;
  /** Spectators, who cost a frame each and command nothing. */
  readonly spectators: number;
  readonly hull: HullId;
  /**
   * The notch the whole fleet runs at.
   *
   * This is the picture knob, not the speed knob. A quiet boat lights very little around it, so a
   * fixture left at its berth would be measuring a nearly empty frame — `match-runtime.test.ts`
   * says the same thing about its own fixtures, and puts them under way for the same reason.
   *
   * `full` is the fastest notch *below* the cavitation line by construction
   * (`world.ts#quietestNotch`); `flank` is over it, which is what makes a worst case worst.
   */
  readonly throttle: ThrottleNotch;
  readonly mapType: MapType;
  readonly mapSize: MapSize;
  readonly mode: GameMode;
  readonly seed: number;
  /** Sim ticks to run. Frames come every second one (`ACOUSTIC_TICK_HZ`). */
  readonly ticks: number;
  /** Sim ticks run before anything is measured, so timings are of optimized code. */
  readonly warmup: number;
  /**
   * Whether the fleet is given somewhere to go.
   *
   * **Not cosmetic, and `false` is the trap.** `deployMatch` berths every boat on a `hold` order,
   * and a boat on `hold` does not move however loud its throttle is — so a fixture that only sets
   * the notch produces a fleet that is *noisy and stationary*. Every `pos`, `facing` and `speed` in
   * every frame is then byte-identical to the frame before, which makes delta encoding look
   * perfect, makes the acoustic field cache a pure hit (planning/16 §3.1 warns about exactly this
   * on its own axis), and quietly measures the wrong world.
   *
   * `ROUTE=0` turns it off for a like-for-like against a stationary fleet. It is a ceiling, not a
   * number to quote.
   */
  readonly routed: boolean;
  /** Matches on the process. Only `concurrency.ts` moves it off 1. */
  readonly matches: number;
  /** Repeats of the whole measured section. Report the **minimum** (planning/16 §6). */
  readonly runs: number;
}

/**
 * The four scenarios planning/17 §3.2 names, as presets rather than knob combinations.
 *
 * A preset exists so a number can be quoted with its scenario attached. Individual knobs still
 * override it, which is how a one-off question gets asked without inventing a fifth preset that
 * nobody else will ever reproduce.
 */
export type ScenarioName = 'quiet' | 'typical' | 'worst' | 'burst';

const PRESETS: Readonly<Record<ScenarioName, Partial<NetBenchOptions>>> = {
  /** Two boats creeping across open water. The floor: what a frame costs with nothing going on. */
  quiet: {
    players: 2,
    boats: 1,
    throttle: 'slow',
    mapType: 'empty',
    mapSize: 'small',
    spectators: 0,
  },
  /** The design target — 3v3, four boats each, under way on a real map (planning/05 §6). */
  typical: {
    players: 6,
    boats: 4,
    throttle: 'full',
    mapType: 'dense',
    mapSize: 'medium',
    spectators: 0,
  },
  /**
   * The case planning/02 §6's budget is written against: the supported maximum, not the expected
   * one. 8v8, ten boats each, dense water, everybody at flank. 160 boats is `FLEET_MAX_BOATS` ×
   * `MAX_PLAYERS_MAX` and is the largest match the lobby will let anyone start.
   */
  worst: {
    players: 16,
    boats: 10,
    throttle: 'flank',
    mapType: 'dense',
    mapSize: 'large',
    spectators: 4,
  },
  /**
   * The burst: a full match where every recipient's chart watermark is at zero, which is what a
   * mass reconnect looks like from the server's side. `NetBench.forgetCharts()` is what makes it
   * happen; the preset only sets the shape around it.
   */
  burst: {
    players: 16,
    boats: 6,
    throttle: 'full',
    mapType: 'dense',
    mapSize: 'large',
    spectators: 0,
  },
};

const DEFAULTS: NetBenchOptions = {
  players: 6,
  boats: 4,
  spectators: 0,
  hull: 'medium',
  throttle: 'full',
  mapType: 'dense',
  mapSize: 'medium',
  mode: 'objective-capture',
  routed: true,
  seed: 11,
  ticks: 40,
  warmup: 20,
  matches: 1,
  runs: 5,
};

/**
 * Options from the environment: a preset first, then explicit knobs over the top.
 *
 * `PLAYERS` is rounded up to an even number, because `teamCapacity` is `maxPlayers / 2` and a
 * lopsided fixture would quietly measure one team carrying more of the picture than the other.
 */
export function optionsFromEnv(overrides: Partial<NetBenchOptions> = {}): NetBenchOptions {
  const name = process.env.SCENARIO;
  const preset = name !== undefined && name in PRESETS ? PRESETS[name as ScenarioName] : {};
  const base: NetBenchOptions = { ...DEFAULTS, ...preset, ...overrides };

  const mapType = process.env.MAP;
  const mapSize = process.env.SIZE;
  const throttle = process.env.THROTTLE;
  const mode = process.env.MODE;

  const players = num(process.env.PLAYERS, base.players);
  return {
    players: Math.max(2, players + (players % 2)),
    boats: Math.max(1, num(process.env.BOATS, base.boats)),
    spectators: Math.max(0, num(process.env.SPECTATORS, base.spectators)),
    hull: (process.env.HULL ?? base.hull) as HullId,
    throttle: throttle !== undefined && isThrottleNotch(throttle) ? throttle : base.throttle,
    mapType: mapType !== undefined && isMapType(mapType) ? mapType : base.mapType,
    mapSize: mapSize !== undefined && isMapSize(mapSize) ? mapSize : base.mapSize,
    mode: mode !== undefined && isGameMode(mode) ? mode : base.mode,
    routed: process.env.ROUTE !== '0' && base.routed,
    seed: num(process.env.SEED, base.seed),
    ticks: Math.max(2, num(process.env.TICKS, base.ticks)),
    warmup: Math.max(0, num(process.env.WARMUP, base.warmup)),
    matches: Math.max(1, num(process.env.MATCHES, base.matches)),
    runs: Math.max(1, num(process.env.RUNS, base.runs)),
  };
}

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw === undefined || Number.isNaN(parsed) ? fallback : parsed;
}

/** The preset by name, for tests and for callers that do not want the environment involved. */
export function scenario(
  name: ScenarioName,
  overrides: Partial<NetBenchOptions> = {},
): NetBenchOptions {
  return { ...DEFAULTS, ...PRESETS[name], ...overrides };
}

// ── The fake socket ───────────────────────────────────────────────────────────────────

/**
 * One recipient: encodes what it is sent exactly as the gateway does, counts it, drops it.
 *
 * The encode is the point. `realtime/gateway.ts` builds its connection as
 * `transport.send('control', codec.encode(message))`, so encoding here — rather than counting the
 * object and estimating — is what makes the byte figures real rather than modelled. Dropping the
 * buffer afterwards is the only difference from production, and it is the difference between
 * measuring the server and measuring a socket.
 */
export class BenchConnection implements PlayerConnection {
  /** Encoded bytes this connection has been sent since the last `clear()`. */
  bytes = 0;
  messages = 0;
  /** Encoded size of every `match.view` frame, in order. `bandwidth.ts` takes percentiles. */
  readonly frameSizes: number[] = [];

  /**
   * The codec this recipient "negotiated".
   *
   * On the interface because a match encodes its own outbound bytes on its own thread and has to
   * be told which codec to use (`realtime/connections.ts`). The bench never goes through a worker,
   * so this is carried to satisfy the type and the real encoding happens in `send` below.
   */
  readonly codec: CodecId = 'json';

  constructor(
    readonly accountId: AccountId,
    readonly username: string,
    private readonly counting: CountingCodec,
  ) {}

  /**
   * The last `MatchViewState` this connection was sent.
   *
   * Kept because a frame cannot be rebuilt to look at: building one advances the chart watermark
   * and the view sequence, and `MatchStore.viewFor` says in as many words that calling it twice
   * for one tick hands the second call an empty chart. So the composition table in `bandwidth.ts`
   * reads the frame that was really sent rather than a second one that would be a different shape.
   */
  lastView: MatchViewState | undefined;

  send(message: ServerMessage): void {
    const encoded = this.counting.encode(message);
    this.bytes += encoded.byteLength;
    this.messages += 1;
    if (message.t === 'match.view') {
      this.frameSizes.push(encoded.byteLength);
      this.lastView = message.view;
    }
  }

  /**
   * Bytes that arrived already encoded.
   *
   * Never called here — the bench publishes through `match/publish.ts` and encodes in `send`, so
   * nothing hands it a finished payload. It exists because `PlayerConnection` requires it, and
   * counting is the only sensible thing for it to do if that ever changes.
   */
  sendEncoded(payload: Uint8Array): void {
    this.bytes += payload.byteLength;
    this.messages += 1;
  }

  clear(): void {
    this.bytes = 0;
    this.messages = 0;
    this.frameSizes.length = 0;
    this.lastView = undefined;
  }
}

// ── The harness ───────────────────────────────────────────────────────────────────────

/** What one publish cost, split four ways. Milliseconds. */
export interface PublishPhases {
  /** `MatchRuntime.visionFor` — the team picture sliced against this recipient's watermark. */
  vision: number;
  /** `@seg/shared/match/view.ts#viewFor` — building the `MatchViewState` object. */
  assemble: number;
  /** `Codec.encode` — the message to bytes. */
  encode: number;
  /** Handing the bytes to the transport. Near zero here; a real socket is not free. */
  send: number;
  /** The four above, plus whatever fell between them. */
  total: number;
  /** Frames actually built. `players + spectators` on a publish tick, zero otherwise. */
  frames: number;
}

export function emptyPhases(): PublishPhases {
  return { vision: 0, assemble: 0, encode: 0, send: 0, total: 0, frames: 0 };
}

const BOAT_NAMES = 'ABCDEFGHIJKLMNOP';

/**
 * One match, wired the way the server wires it, with the sockets replaced by counters.
 *
 * Construct it, `warmUp()`, then drive it: `tick()` until it returns true, then `publish()` or
 * `publishByPhase()`. Every benchmark in this directory is those four calls in a different order.
 */
export class NetBench {
  readonly connections = new ConnectionRegistry();
  readonly codec: CountingCodec;
  readonly recipients: readonly BenchConnection[];
  readonly matchId: string;
  readonly runtime: MatchRuntime;

  /**
   * The real publish path's sequencer, and the mirror's own beside it.
   *
   * Two, because the two paths are measured against each other and a shared counter would make the
   * second one's frames carry the first one's numbers.
   */
  private readonly seqs = new ViewSequencer();
  private readonly mirrorSeq = new Map<AccountId, number>();

  /**
   * A `MatchRuntime` directly, with no `MatchStore` and no `MatchHandler` around it.
   *
   * Those two used to be here because publishing went through them. It does not: a match runs on
   * its own worker thread now, and the loop that decides who is owed what was lifted into
   * `match/publish.ts` so the worker and this file could share it (planning/17 §9). What is left
   * is the sim and the projection, which is all these benchmarks were ever measuring.
   *
   * Deliberately **not** a worker. The question these benchmarks answer is what a publish costs in
   * CPU, and putting a thread boundary in the middle would measure the postMessage instead. The
   * boundary's own cost is a separate question and `bench:netcode:concurrency` is where it belongs.
   */
  constructor(
    readonly options: NetBenchOptions,
    matchId = 'bench-1',
    codec: CountingCodec = new CountingCodec(new JsonCodec()),
  ) {
    this.matchId = matchId;
    this.codec = codec;

    const state = underWay(buildMatch(options, matchId), options.throttle);
    this.runtime = new MatchRuntime(state);

    const recipients: BenchConnection[] = [];
    for (const player of state.players) {
      const connection = new BenchConnection(player.accountId, player.accountId, this.codec);
      recipients.push(connection);
      this.connections.add(connection);
    }
    this.recipients = recipients;

    if (options.routed) routeFleet(this.runtime, state);
  }

  get state(): MatchState {
    return this.runtime.state;
  }

  /** Advance one sim tick. `true` when a solve ran and a frame is due. */
  tick(): boolean {
    return this.runtime.tick();
  }

  /**
   * Run the fleet forward without measuring anything, and forget what it cost.
   *
   * Two jobs, and the second is the one that is easy to miss. The obvious one is letting the JIT
   * reach the optimized code. The subtle one is the **chart**: the first frame after deployment
   * carries every terrain square the team can see and is several times the size of the steady
   * state (`match-runtime.test.ts` pins that behaviour). A bench that measured from tick zero
   * would report the reconnect burst as if it were the normal case.
   */
  warmUp(): void {
    for (let i = 0; i < this.options.warmup; i += 1) {
      if (this.tick()) this.publish();
    }
    this.clear();
  }

  /**
   * The real path: `match/publish.ts`, the same function the match's worker thread calls.
   *
   * Shared rather than reproduced, which is what makes the figures below figures about the server
   * (see that file's header). The only difference from production is where the bytes go: the
   * worker encodes each message with the recipient's negotiated codec and posts it, and here
   * `BenchConnection.send` encodes it, counts it and drops it.
   */
  publish(): void {
    publishMatch(this.runtime, this.seqs, (accountId, message) => {
      this.connections.get(accountId)?.send(message);
    });
  }

  /**
   * The mirror: the same work, in four timed pieces.
   *
   * Reproduces `MatchStore.viewFor` (which is `runtime.visionFor` then `shared/match/view.ts`'s
   * `viewFor`, with a per-recipient sequence) and `MatchHandler.publish`'s send. Pinned against
   * the real path by `netcode-harness.test.ts` — see this file's header.
   *
   * The debug overlays are deliberately absent: they are gated on `debugMode` and on somebody
   * having asked, so they are not part of what a match costs in production and folding them in
   * would make every number here pessimistic by an amount that depends on who has a panel open.
   */
  publishByPhase(): PublishPhases {
    const phases = emptyPhases();
    const state = this.state;
    const runtime = this.runtime;
    const started = performance.now();

    for (const player of state.players) {
      if (!player.connected) continue;
      const connection = this.connections.get(player.accountId);
      if (connection === undefined) continue;

      const t0 = performance.now();
      const vision = runtime.visionFor(player.accountId, teamFor(state, player.accountId));
      const t1 = performance.now();
      const view = viewFor(
        state,
        player.accountId,
        vision,
        runtime.hasDebugVision(player.accountId),
      );
      const t2 = performance.now();
      const seq = (this.mirrorSeq.get(player.accountId) ?? 0) + 1;
      this.mirrorSeq.set(player.accountId, seq);
      const bytes = this.codec.encode(createMatchView(this.matchId, seq, view));
      const t3 = performance.now();
      sink(bytes);
      const t4 = performance.now();

      phases.vision += t1 - t0;
      phases.assemble += t2 - t1;
      phases.encode += t3 - t2;
      phases.send += t4 - t3;
      phases.frames += 1;
    }

    phases.total = performance.now() - started;
    return phases;
  }

  /**
   * Put every recipient's chart watermark back to zero — the reconnect burst (planning/17 §3.2
   * scenario 4).
   *
   * `MatchRuntime.forget` is what a real reconnect calls (Q21), so this is the production path
   * rather than a bench-only lever.
   */
  forgetCharts(): void {
    for (const connection of this.recipients) this.runtime.forget(connection.accountId);
    for (const key of this.mirrorSeq.keys()) this.mirrorSeq.delete(key);
  }

  /** Bytes and counters back to zero, on the connections and on the codec's meters. */
  clear(): void {
    for (const connection of this.recipients) connection.clear();
    this.codec.reset();
  }

  /**
   * The last frame the *first* recipient was sent, for callers that want to look inside one.
   *
   * The first rather than an arbitrary one because it is a team-1 player with boats, which is the
   * case worth inspecting; a spectator's frame has no `own` and no `vision` at all.
   */
  get lastView(): MatchViewState | undefined {
    return this.recipients[0]?.lastView;
  }

  /** Total encoded bytes every recipient has been sent since the last `clear()`. */
  get bytes(): number {
    return this.recipients.reduce((total, connection) => total + connection.bytes, 0);
  }

  /** A one-line description of the world being measured, for the top of every bench's output. */
  describe(): string {
    const o = this.options;
    const state = this.state;
    return (
      `${o.players}p×${o.boats}b (${state.boats.length} boats, ${o.hull}, ${o.throttle}) ` +
      `+${o.spectators} spec  map=${o.mapType}/${o.mapSize} seed=${o.seed} mode=${o.mode}\n` +
      `  ${o.ticks} ticks (${Math.floor(o.ticks / 2)} frames), ${o.warmup} warm-up`
    );
  }
}

/**
 * Several matches ticked serially on one thread.
 *
 * ## What this measures now
 *
 * It used to be the production loop verbatim: `server/match/clock.ts` walked every running match
 * through one `setInterval`, so a match's publish cost was not a share of its own 50 ms — it was
 * 50 ms of the whole box, spent while every other match waited.
 *
 * **That loop is gone.** A match runs on its own worker thread, capped by `SEG_MAX_MATCHES`
 * (`server/match/worker/pool.ts`), so `M` matches on an `N`-core box are genuinely parallel at the
 * match granularity and no match waits on another's solve.
 *
 * So this is no longer a model of the deployment, and pretending otherwise would be worse than
 * deleting it. What it is now is the **per-core capacity figure**: how many matches one thread
 * could carry if it had to, which is what says how many cores `SEG_MAX_MATCHES` of them will
 * actually need. Read `M` here as "matches per core", and the cap as `M × cores`.
 *
 * The `M = 1` row is the one that transfers directly, because that is exactly what one worker
 * does. Rows above it are the contention curve, and they are the answer to "is 32 a sane default
 * on this box" rather than to "how long is a tick".
 */
export class NetProcess {
  readonly connections = new ConnectionRegistry();
  readonly codec: CountingCodec;
  readonly recipients: readonly BenchConnection[];
  private readonly runtimes: readonly MatchRuntime[];
  private readonly seqs: readonly ViewSequencer[];

  constructor(
    readonly options: NetBenchOptions,
    readonly count = options.matches,
  ) {
    this.codec = new CountingCodec(new JsonCodec());

    const recipients: BenchConnection[] = [];
    const runtimes: MatchRuntime[] = [];
    const seqs: ViewSequencer[] = [];
    for (let m = 0; m < count; m += 1) {
      const matchId = `proc-${m}`;
      // A distinct seed per match, so `M` matches are not `M` copies of one cache-friendly world.
      // The map is the expensive part of construction and the realistic case has every match on a
      // different one.
      const state = underWay(
        buildMatch({ ...options, seed: options.seed + m }, matchId, `m${m}`),
        options.throttle,
      );
      runtimes.push(new MatchRuntime(state));
      seqs.push(new ViewSequencer());
      for (const player of state.players) {
        const connection = new BenchConnection(player.accountId, player.accountId, this.codec);
        recipients.push(connection);
        this.connections.add(connection);
      }
    }
    this.recipients = recipients;
    this.runtimes = runtimes;
    this.seqs = seqs;
  }

  /**
   * One tick for every match, publishing where a frame came due.
   *
   * The old clock's `step` inlined, because there is no longer a `MatchClock` to borrow it from —
   * a worker owns its own timer and there is nothing walking a set of matches any more. A tick
   * that throws is still skipped rather than allowed to stop the rest, which is the one behaviour
   * of that loop worth keeping here.
   */
  step(): void {
    for (let m = 0; m < this.runtimes.length; m += 1) {
      const runtime = this.runtimes[m];
      const seq = this.seqs[m];
      if (runtime === undefined || seq === undefined) continue;
      try {
        if (runtime.tick()) {
          publishMatch(runtime, seq, (accountId, message) => {
            this.connections.get(accountId)?.send(message);
          });
        }
      } catch (error) {
        console.error('[bench] match tick failed', m, error);
      }
    }
  }

  warmUp(): void {
    for (let i = 0; i < this.options.warmup; i += 1) this.step();
    for (const connection of this.recipients) connection.clear();
    this.codec.reset();
  }

  get bytes(): number {
    return this.recipients.reduce((total, connection) => total + connection.bytes, 0);
  }
}

/**
 * Keep the encoder honest.
 *
 * A `JSON.stringify` whose result is never read is exactly the kind of thing an optimizer is
 * entitled to notice. Touching one byte costs nothing measurable and means the work provably
 * happened — the same trick `bench-acoustics` gets for free by keeping its `stats`.
 */
let residue = 0;
function sink(bytes: Uint8Array): void {
  residue += bytes[0] ?? 0;
}

/** So `residue` is read somewhere and cannot be eliminated. Prints nothing anyone needs. */
export function encoderResidue(): number {
  return residue;
}

// ── Building the world ────────────────────────────────────────────────────────────────

/**
 * `prefix` namespaces the account ids.
 *
 * Not cosmetic. `ConnectionRegistry` and `MatchStore.byAccount` are both keyed by account, so two
 * matches on one process whose players are both called `p0` would evict each other's connections
 * and route one match's commands into the other. `NetProcess` is the only caller that passes one,
 * and it is the only caller that could hit this.
 */
function buildMatch(options: NetBenchOptions, matchId: string, prefix = 'p'): MatchState {
  const templates: BoatTemplate[] = Array.from({ length: options.boats }, (_, i) => ({
    name: `${BOAT_NAMES[i % BOAT_NAMES.length] ?? 'X'}-${String(i + 1).padStart(2, '0')}`,
    hull: options.hull,
    modules: [],
  }));

  const players: DeployingPlayer[] = Array.from({ length: options.players }, (_, i) => ({
    accountId: `${prefix}${i}`,
    username: `${prefix}${i}`,
    position: i % 2 === 0 ? ('team1' as const) : ('team2' as const),
    boats: templates,
  }));

  for (let i = 0; i < options.spectators; i += 1) {
    players.push({
      accountId: `${prefix}s${i}`,
      username: `${prefix}s${i}`,
      position: 'spectator',
      boats: [],
    });
  }

  return deployMatch({
    matchId,
    mode: options.mode,
    map: generateMap(options.mapType, { seed: options.seed, mapSize: options.mapSize }),
    startedAt: 0,
    players,
  });
}

/**
 * Send every boat across the map, so the fleet is actually under way.
 *
 * The counterpart to `underWay`, and the half that is easy to forget: the notch decides how loud a
 * boat is, the *order* decides whether it moves. Each boat is aimed at the far side of the map on
 * a lane derived from its index — deterministic, spread across the height, and far enough that
 * nothing arrives and stops during a benchmark run.
 *
 * `MatchRuntime.order` is the production path (`nav.order` lands there), so this is a fleet doing
 * what a fleet does rather than a fixture poking at state.
 */
function routeFleet(runtime: MatchRuntime, state: MatchState): void {
  const { width, height } = state.map.extents;
  state.boats.forEach((boat, i) => {
    // Team 1 berths in the west and team 2 in the east (`deploymentBands`), so each is sent at the
    // other's end — which also means the two fleets close on each other and the picture develops.
    const x = boat.team === 'team1' ? width * 0.92 : width * 0.08;
    const lane = ((i * 2 + 1) / (2 * Math.max(1, state.boats.length))) * height;
    runtime.order(boat.owner, boat.id, { x, y: lane }, false);
  });
}

/**
 * Put the whole fleet on a notch.
 *
 * Straight off `match-runtime.test.ts`'s fixture helper, and for the same reason: deployment
 * berths boats stopped, a stopped boat is nearly silent, and a silent fleet lights nothing. The
 * throttle does the talking so the picture is worth measuring.
 */
function underWay(state: MatchState, notch: ThrottleNotch): MatchState {
  return {
    ...state,
    boats: state.boats.map((boat) => ({
      ...boat,
      throttle: notch,
      speed: throttleSpeedFor(boat.stats, notch),
    })),
  };
}

// ── Reporting helpers, shared by every bench in this directory ────────────────────────

/** One tick's budget, ms. What every share here is a share of (planning/16 §1.1). */
export const BUDGET_MS = 1000 / SIM_TICK_HZ;

/**
 * The **minimum** of `runs` samples, which is the estimator planning/16 §6 insists on.
 *
 * Under contention on an unpinned box the minimum is the only robust answer to "how fast can this
 * code go"; a mean measures the machine's mood. Every timing printed by these benches comes
 * through here.
 */
export function best(samples: readonly number[]): number {
  return samples.reduce((low, value) => (value < low ? value : low), Number.POSITIVE_INFINITY);
}

/** Nearest-rank percentile over a copy of `samples`. Exact for byte counts, which is the point. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** A message's channel, re-exported so the benches do not each import the protocol directly. */
export type { Message };
