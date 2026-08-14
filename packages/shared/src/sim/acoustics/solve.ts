/**
 * The acoustic solve — one tick of the ocean.
 *
 * Everything that makes noise puts sound into the water; the sound spreads and loses level;
 * what a listener is shown is the square metres of surface whose return beats what it is
 * already hearing. That is the whole model, and this file is all of it.
 *
 * ## What the player is sent
 *
 * A list of squares and how far each cleared the threshold. Not contacts, not bearings —
 * squares. Some are rock and some are somebody's hull, and **the picture does not say which**.
 * A player reading a shape and deciding whether it is a ledge or a submarine is the game
 * (planning/03 §6: silhouette recognition is a real skill). The tracker that turns squares
 * into named tracks is a separate layer and is not this one's business.
 *
 * ## Two ways a square lights up
 *
 * **Direct.** A boat's own hull squares are lit by its own radiated noise, at
 * `SL − TL(range)`. No absorption: you are hearing the boat, not an echo of it. This is
 * classical passive detection (planning/03 §5) drawn as geometry instead of as a bearing line.
 *
 * **Reflected.** Any surface — rock, or somebody's hull — is lit by the total sound arriving
 * at it, minus what that material swallows, minus the loss on the way back:
 * `incident − absorption − TL(range)`. This is what draws cave walls, and it is what finds a
 * boat that is *not* making noise, because your own machinery is lighting it up.
 *
 * Keeping them apart is not tidiness, it is the difference between a model that works and one
 * that cannot detect anything at all. Treating a boat as reflecting its own noise puts the
 * direct arrival into the listener's noise floor and the echo of it into the signal — and the
 * echo is quieter than the direct sound by exactly the absorption, so the signal is *always*
 * under its own interference and nothing is ever seen. Which is what the first version of this
 * file did.
 *
 * Two consequences worth being explicit about, because they fall out rather than being
 * designed in:
 *
 * - **Absorption is a defence against being illuminated, not against being heard.** An
 *   anechoic coating does nothing about the racket you make yourself, and everything about
 *   being lit by an enemy. That is exactly what the real thing does.
 * - **You light up what you are looking at.** Your own noise illuminates the walls around you,
 *   so going quiet does not merely make you harder to find — it makes you blind. All-stop is
 *   the best listening posture and the worst seeing one, and the player feels that trade
 *   without being told about it.
 *
 * ## Three passes, not a pairing
 *
 * ```
 * pass 0   every entity     → one bounded level field
 * pass 1   every field      → accumulate the noise heatmap, and record entity→listener ranges
 * pass 2   every listener   → direct returns from the pair table, reflections from its field
 * ```
 *
 * The naive shape is `listeners × sources`, ten thousand pair evaluations a tick at the fleet
 * sizes planning/03 §10 budgets for. Pass 1 is linear in entities because the thing pass 2
 * reads is not each source individually but the **heatmap** — the summed power at every point
 * in the water. That heatmap is also, exactly, the "background noise that affects detection":
 * one structure answers *what lights the walls* and *what drowns out the return*, and it would
 * be a mistake to compute them separately since they are the same number.
 *
 * With one deliberate exception, which is the whole of the filterable-sound model: a coherent
 * tone — an active ping, or a torpedo seeker's — lights the walls and is heard directly at full
 * strength, but is a *different* background to a listener, because a tone can be notched out of
 * a noise estimate where a bang cannot. Pass 1 therefore keeps a second, filtered accumulation
 * (`noiseBackground`) built from each entity's `deafeningLevel`; reflections and direct returns
 * read the full heatmap, noise floors read the filtered one. Everything that deafens in full —
 * machinery, and every transient in the table today — is identical in both.
 *
 * The solve is told the *answer* rather than the ingredients on purpose. Which sounds an entity is
 * making, and how notchable each one is, is settled once on the emit side
 * (`boats.ts#deafeningLevelOf`) and arrives as one number, so a model with fifty different
 * fractions in it costs this loop exactly what a model with one does.
 *
 * ## Cost
 *
 * The transcendentals are gone from the inner loops. Transmission loss is a table lookup at
 * 1 m resolution, and every detection test is rearranged from
 * `incident_dB − absorption − loss_dB ≥ threshold` into a comparison of powers, so a square
 * that fails costs a multiply and a branch. A logarithm is only paid for a square that lights.
 *
 * What remains expensive is pass 0, and it scales with `entities × water cells in reach`.
 * `maxImagingRange` bounds the reflection picture for that reason (see `reachOf`), and
 * `maxFieldCells` is the hard guardrail behind it. planning/03 §10's tiered re-evaluation —
 * pairs far from threshold refreshed at 2 Hz rather than 10 — is the next lever and is not
 * built here.
 */

import {
  ACOUSTICS,
  noiseFloorOf,
  rangeForLoss,
  returnThreshold,
  transmissionLoss,
  type AcousticTuning,
} from '../../content/acoustics.js';
import { toDecibels, toPower } from '../../math/decibels.js';
import type { GeneratedMap, Vec2 } from '../../map/types.js';
import type { SolveProbe } from '../../match/perf.js';
import { TEAM_IDS, type EntityId, type TeamId } from '../../match/world.js';
import { FieldArena, type FieldArenaOptions, type FieldHandle } from './field.js';
import { WaterLattice } from './lattice.js';
import {
  buildTerrainSkin,
  groupByLattice,
  traceOutline,
  visionGridFor,
  type ReflectorSet,
  type VisionGrid,
} from './skin.js';

/**
 * A source is followed until it has fallen this far under ambient, and no further. Three
 * decibels under is half the power of the sea it is hiding in, which moves a noise floor by
 * less than a decibel and cannot light anything at all — ambient on its own never clears a
 * threshold, which is why a silent boat is a blind one.
 */
const AMBIENT_TAIL = 3;

/** What a listener brings to the problem. */
export interface Hydrophone {
  /** Array gain, dB. Straight off the `arrayGain` stat. */
  readonly gain: number;
  /** Its own machinery as it hears it, dB — `selfNoiseOf`. The reason to slow down. */
  readonly selfNoise: number;
}

/**
 * One thing in the water, as the acoustic model sees it. Boats, torpedoes, drones, decoys, and
 * wrecks are all the same shape here — planning/04 §4's uniform entity model is what lets a
 * torpedo seeker and a submarine share this code path exactly.
 */
export interface AcousticEntity {
  readonly id: EntityId;
  /** `null` for something nobody owns. A wreck still reflects; it just reports to no one. */
  readonly team: TeamId | null;
  readonly pos: Vec2;
  /** dB at the reference range. `-Infinity` for something genuinely silent. */
  readonly sourceLevel: number;
  /**
   * The part of `sourceLevel` that raises listeners' noise floors, dB.
   *
   * Never above `sourceLevel`, and **equal to it for anything that is not making a filterable
   * sound** — which is the default and the common case, not a special one. Note the polarity:
   * `-Infinity` here means "deafens nobody", so a hand-built entity that wants the ordinary
   * behaviour sets this to its own `sourceLevel`, not to silence.
   *
   * A ping is a coherent tone; a bang is not. The full level still propagates, lights the walls,
   * and reaches listeners as a direct return — this only tells the solve how much of that power a
   * listener has to hear *through*. Which sounds were skimmed, and by how much, is the emit side's
   * business (`boats.ts#EmittedSound`); the solve is handed the total and never asks.
   */
  readonly deafeningLevel: number;
  /** dB swallowed per bounce (`hullMaterial`). `Infinity` for something that does not reflect. */
  readonly absorption: number;
  /**
   * Closed outline in map metres, already placed and rotated (`hullOutline`). `null` for
   * something with no body worth drawing at one-metre resolution.
   */
  readonly outline: readonly Vec2[] | null;
  /** `null` when it cannot hear. */
  readonly hydrophone: Hydrophone | null;
}

/** What one team is shown. Squares, and how far each beat the threshold. */
export interface TeamVision {
  readonly team: TeamId;
  /** Packed vision squares (`skin.ts#packVisionCell`). */
  readonly cells: Int32Array;
  /** dB of signal excess per square, parallel to `cells`. Drives brightness, and nothing else. */
  readonly excess: Float32Array;
  /**
   * What each square is attached to: `-1` for rock, otherwise the `EntityId` whose hull it sits
   * on. Parallel to `cells`.
   *
   * **This never leaves the server**, and the split matters. The *picture* must not say whether
   * a square is a ledge or a submarine — reading the shape is the game (planning/03 §6) — but
   * *confirmation* has to know, because a confirmed rock square joins the team's chart forever
   * while a confirmed hull square reveals a boat that will move away. One flag answers both,
   * and keeping it out of `VisionFrame` (`match/vision.ts`) is what keeps the player's copy
   * honest.
   */
  readonly owners: Int32Array;
  /** Squares that cleared the threshold and were cut by `maxVisionCells`. Zero on a quiet tick. */
  readonly dropped: number;
}

/**
 * The background noise everywhere in the water, this tick — in both of its meanings, kept
 * together because they are the same number except for the one place a listener can notch a tone
 * out of it.
 *
 * Handed out by reference and **rewritten by the next solve** — the whole point of the arena is
 * that a tick allocates nothing. Read it before the next tick, or copy what you need.
 *
 * `levelAt` is the full incident energy: what lights the walls, and how loud the water really is.
 * `backgroundLevelAt` is what a listener has to compete with — the same energy with every
 * filterable sound (a ping) already skimmed by its own fraction on the emit side, so a ping that
 * is lighting a chamber does not have to be deafening it too.
 */
export class NoiseHeatmap {
  /** `ambient` as a power ratio. Every read adds it, and it never changes within a solve. */
  private readonly ambientPower: number;

  constructor(
    readonly lattice: WaterLattice,
    private readonly power: Float64Array,
    private readonly background: Float64Array,
    private readonly ambient: number,
  ) {
    this.ambientPower = toPower(ambient);
  }

  /** The noise level at a point, dB, ambient included. Off the map reads as bare ambient. */
  levelAt(x: number, y: number): number {
    const cell = this.lattice.waterIndexAt(x, y);
    return cell < 0 ? this.ambient : this.levelAtCell(cell);
  }

  levelAtCell(cell: number): number {
    return toDecibels(this.powerAtCell(cell));
  }

  /**
   * The same reading, left as a power ratio — ambient included, no logarithm paid.
   *
   * Here for the same reason the solver's inner loops compare powers rather than decibels: a
   * caller that only needs to know *which* cell is loudest is asking a question `Math.log10`
   * cannot answer any better, and over a whole map's worth of cells that log is the entire cost.
   * The debug heatmap sweeps every cell on the map to find the loudest in each block
   * (`match/noise.ts`) and converts once per block, which is a fifteenth of the logarithms.
   */
  powerAtCell(cell: number): number {
    return (this.power[cell] ?? 0) + this.ambientPower;
  }

  /** The deafening background at a point, dB — full power minus what can be filtered out. */
  backgroundLevelAt(x: number, y: number): number {
    const cell = this.lattice.waterIndexAt(x, y);
    return cell < 0 ? this.ambient : this.backgroundLevelAtCell(cell);
  }

  backgroundLevelAtCell(cell: number): number {
    return toDecibels(this.backgroundPowerAtCell(cell));
  }

  /** The deafening background as a power ratio, ambient included — `powerAtCell`'s counterpart. */
  backgroundPowerAtCell(cell: number): number {
    return (this.background[cell] ?? 0) + this.ambientPower;
  }
}

export interface SolveStats {
  readonly entities: number;
  readonly sources: number;
  readonly listeners: number;
  /** Lattice cells swept across every field. The honest measure of what a tick cost. */
  readonly fieldCells: number;
  /** Fields cut short by `maxFieldCells` rather than by range. */
  readonly clippedFields: number;
  /** Vision squares reported, across both teams. */
  readonly visionCells: number;
  /** Cells the reflection pass walked — the listeners' fields only, not every entity's. */
  readonly lookCells: number;
  /** Vision-grid squares covered by hull silhouettes, which is what `traceHulls` produced. */
  readonly reflectorCells: number;
}

export interface AcousticSolution {
  readonly vision: readonly TeamVision[];
  readonly noise: NoiseHeatmap;
  readonly stats: SolveStats;
}

export interface SolverOptions {
  readonly tuning?: AcousticTuning;
  /** Overrides `tuning.latticeCell`. Tests use it to trade fidelity for speed. */
  readonly cellSize?: number;
  /**
   * Passed straight to the `FieldArena` (planning/16 §3.1). The default caches; `{ cache: false }`
   * makes every field a fresh sweep, which is what a benchmark of the sweep — or a check that the
   * cache changes nothing — needs.
   */
  readonly fields?: FieldArenaOptions;
}

/**
 * Holds everything that survives a tick: the lattice, the rock skin, the loss tables, and the
 * scratch the solve runs in. Built once per match, then `solve` is called every acoustic tick.
 */
export class AcousticSolver {
  readonly lattice: WaterLattice;
  readonly grid: VisionGrid;
  readonly terrain: ReflectorSet;

  private readonly tuning: AcousticTuning;
  private readonly arena: FieldArena;

  /** `lossFactor[r]` is the transmission loss at `r` metres, as a power ratio. */
  private readonly lossFactor: Float64Array;
  /** And the same figure in decibels, for the callers that need it that way. */
  private readonly lossDb: Float64Array;
  private readonly maxLossIndex: number;

  private readonly noisePower: Float64Array;
  private readonly noiseBackground: Float64Array;
  private readonly ambientPower: number;

  /** Which listener slots sit in which lattice cell, CSR. Rebuilt each solve. */
  private readonly listenerStart: Int32Array;
  private listenerAt: Int32Array;

  /**
   * Best excess per lattice cell for terrain, and per dynamic-skin entry for hulls, within the
   * team being assembled. `-1` means "not lit" — a square exactly on the threshold has an
   * excess of zero and is still a detection, so zero cannot be the empty value.
   */
  private readonly terrainBest: Float32Array;
  private hullBest: Float32Array;

  constructor(map: GeneratedMap, options: SolverOptions = {}) {
    this.tuning = options.tuning ?? ACOUSTICS;
    const cellSize = options.cellSize ?? this.tuning.latticeCell;

    this.lattice = new WaterLattice(map.extents, map.terrain.obstacles, { cellSize });
    this.grid = visionGridFor(map.extents);
    this.terrain = buildTerrainSkin(this.lattice, map.extents, map.terrain.obstacles);

    this.arena = new FieldArena(this.lattice, options.fields);
    this.noisePower = new Float64Array(this.lattice.cellCount);
    this.noiseBackground = new Float64Array(this.lattice.cellCount);
    this.ambientPower = toPower(this.tuning.ambientNoise);
    this.listenerStart = new Int32Array(this.lattice.cellCount + 1);
    this.listenerAt = new Int32Array(64);
    this.terrainBest = new Float32Array(this.lattice.cellCount).fill(-1);
    this.hullBest = new Float32Array(1024).fill(-1);

    // Loss at 1 m resolution. Path lengths are floored into it, so the worst quantization is
    // one metre of range — under a hundredth of a decibel anywhere it matters, and it buys a
    // multiply where the inner loop would otherwise pay for a logarithm.
    this.maxLossIndex = Math.ceil(this.tuning.maxRange);
    this.lossFactor = new Float64Array(this.maxLossIndex + 1);
    this.lossDb = new Float64Array(this.maxLossIndex + 1);
    for (let r = 0; r <= this.maxLossIndex; r += 1) {
      const loss = transmissionLoss(r, this.tuning);
      this.lossDb[r] = loss;
      this.lossFactor[r] = toPower(-loss);
    }
  }

  /**
   * One acoustic tick.
   *
   * `entities` is copied and sorted by id before anything else happens. Determinism must not
   * depend on the order the caller's entity store happens to iterate in: the heatmap is a sum
   * of floats and floating-point addition is not associative, so a different order is a
   * different match for the rest of the game (planning/04 §9).
   *
   * `probe`, when given, is handed the duration of each of the five passes below
   * (`match/perf.ts#SolvePhase`). It is the debug statistics panel's stopwatch and it is optional
   * for the reason everything else about that panel is: this is the hot path, and a solve nobody
   * is watching must not pay for a clock. It cannot change the answer — the only thing it is
   * given is two numbers — so the promise this method makes about being a pure function of its
   * entity list survives it.
   */
  /**
   * Cells the reflection pass walked on the last solve, for the statistics panel.
   *
   * A counter on the instance rather than a return value, exactly like `FieldArena.clippedFields`
   * and for the same reason: it is a fact about how much work was done, and threading it back up
   * through `look`'s return type would put a debug figure in the shape a team's vision travels in.
   */
  private lookCells = 0;

  /**
   * What the field cache has done since this solver was built (planning/16 §3.1).
   *
   * Deliberately *not* part of `SolveStats`: those are facts about the ocean this tick, and every
   * one of them is identical whether a field was swept or reused. A cache counter in there would
   * make two solves that agree about the water disagree about their statistics, which is the one
   * thing the cache is not allowed to do. This is an instrument on the solver, for benchmarks.
   */
  get fieldCache(): { readonly hits: number; readonly misses: number; readonly cells: number } {
    return {
      hits: this.arena.cacheHits,
      misses: this.arena.cacheMisses,
      cells: this.arena.cachedFieldCells,
    };
  }

  solve(entities: readonly AcousticEntity[], probe?: SolveProbe): AcousticSolution {
    const startedReset = probe?.start() ?? 0;
    const list = [...entities].sort((a, b) => a.id - b.id);
    const count = list.length;

    this.arena.reset();
    this.noisePower.fill(0);
    this.noiseBackground.fill(0);
    this.lookCells = 0;
    // The one step here that scales with the *map* rather than the fleet: two fills over every
    // lattice cell, whether there is anything in the water or not.
    probe?.record('reset', startedReset);

    const startedHulls = probe?.start() ?? 0;
    const dynamic = this.traceHulls(list);
    const byOwner = groupByOwner(dynamic, count);
    if (this.hullBest.length < dynamic.cells.length) {
      this.hullBest = new Float32Array(dynamic.cells.length).fill(-1);
    }
    probe?.record('hulls', startedHulls);

    // ── Reach ───────────────────────────────────────────────────────────────────
    let loudest = -Infinity;
    let quietestThreshold = Infinity;
    let softestAbsorption = this.tuning.terrainAbsorption;
    const seats: number[] = [];
    let sources = 0;

    for (let e = 0; e < count; e += 1) {
      const entity = list[e];
      if (entity === undefined) continue;
      if (entity.sourceLevel > -Infinity) {
        loudest = Math.max(loudest, entity.sourceLevel);
        sources += 1;
      }
      if (entity.outline !== null && Number.isFinite(entity.absorption)) {
        softestAbsorption = Math.min(softestAbsorption, entity.absorption);
      }
      if (entity.hydrophone !== null && entity.team !== null) {
        seats.push(e);
        const floor = noiseFloorOf(-Infinity, entity.hydrophone.selfNoise, this.tuning);
        quietestThreshold = Math.min(
          quietestThreshold,
          returnThreshold(floor, entity.hydrophone.gain, this.tuning),
        );
      }
    }
    softestAbsorption = Math.max(0, softestAbsorption);

    // ── Pass 0: a field per entity ──────────────────────────────────────────────
    const startedFields = probe?.start() ?? 0;
    const fields: (FieldHandle | null)[] = new Array<FieldHandle | null>(count).fill(null);
    const ownCell = new Int32Array(count).fill(-1);
    const ownBackgroundPower = new Float64Array(count);
    const emitPower = new Float64Array(count);
    const deafeningPower = new Float64Array(count);
    const absorptionFactor = new Float64Array(count);
    let fieldCells = 0;

    for (let e = 0; e < count; e += 1) {
      const entity = list[e];
      if (entity === undefined) continue;
      absorptionFactor[e] = toPower(entity.absorption);
      emitPower[e] = entity.sourceLevel > -Infinity ? toPower(entity.sourceLevel) : 0;
      deafeningPower[e] = entity.deafeningLevel > -Infinity ? toPower(entity.deafeningLevel) : 0;

      const reach = this.reachOf(entity, softestAbsorption, quietestThreshold);
      if (reach <= 0) continue;

      const field = this.arena.solve(entity.pos.x, entity.pos.y, {
        maxRange: reach,
        maxCells: this.tuning.maxFieldCells,
      });
      if (field.count === 0) continue;

      fields[e] = field;
      fieldCells += field.count;
      // The first cell of a field is always the one the entity is standing in.
      ownCell[e] = this.arena.cellAt(field, 0);
    }

    probe?.record('fields', startedFields);

    // ── Pass 1: the heatmap, and the entity→listener range table ────────────────
    const startedHeatmap = probe?.start() ?? 0;
    this.indexListeners(seats, ownCell);
    const slots = seats.length;
    // Power ratio from each entity to each listener. Zero means "did not reach", which is the
    // same as inaudible and needs no separate flag.
    const pairFactor = new Float64Array(count * Math.max(1, slots));

    for (let e = 0; e < count; e += 1) {
      const field = fields[e];
      if (field == null) continue;
      const emitted = emitPower[e] ?? 0;
      // Already net of whatever each sound's `noiseFraction` skims off (`boats.ts`), so the
      // background costs one multiply per cell however many filterable sounds went into it.
      const deafening = deafeningPower[e] ?? 0;

      for (let i = 0; i < field.count; i += 1) {
        const cell = this.arena.cellAt(field, i);
        const factor = this.factorAt(this.arena.rangeAt(field, i));

        if (emitted > 0) {
          const power = emitted * factor;
          this.noisePower[cell] = (this.noisePower[cell] ?? 0) + power;

          const background = deafening * factor;
          this.noiseBackground[cell] = (this.noiseBackground[cell] ?? 0) + background;
          if (i === 0) ownBackgroundPower[e] = background;
        }

        const from = this.listenerStart[cell] ?? 0;
        const to = this.listenerStart[cell + 1] ?? from;
        for (let k = from; k < to; k += 1) {
          pairFactor[e * slots + (this.listenerAt[k] ?? 0)] = factor;
        }
      }
    }

    probe?.record('heatmap', startedHeatmap);

    // ── Pass 2: what each team can see ──────────────────────────────────────────
    const startedLook = probe?.start() ?? 0;
    const vision: TeamVision[] = [];
    let visionCells = 0;

    for (const team of TEAM_IDS) {
      const crew = seats.filter((e) => list[e]?.team === team);
      if (crew.length === 0) continue;

      const picture = this.look(team, {
        list,
        crew,
        seats,
        fields,
        ownCell,
        ownBackgroundPower,
        emitPower,
        absorptionFactor,
        pairFactor,
        slots,
        dynamic,
        byOwner,
      });
      vision.push(picture);
      visionCells += picture.cells.length;
    }

    probe?.record('look', startedLook);

    return {
      vision,
      noise: new NoiseHeatmap(
        this.lattice,
        this.noisePower,
        this.noiseBackground,
        this.tuning.ambientNoise,
      ),
      stats: {
        entities: count,
        sources,
        listeners: seats.length,
        fieldCells,
        clippedFields: this.arena.clippedFields,
        visionCells,
        lookCells: this.lookCells,
        reflectorCells: dynamic.cells.length,
      },
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  /**
   * Transmission loss as a power ratio, from the table — **the exact factor the heatmap was
   * accumulated with**, quantization and all.
   *
   * Public because reconstructing one entity's own contribution to the heatmap is otherwise a
   * trap. The residual after subtracting it is the difference of two nearly equal large numbers,
   * so recomputing the loss from `transmissionLoss` instead of reading this table — a
   * disagreement of a hundredth of a decibel, from the table's 1 m rounding — leaves a *thirty
   * decibel* phantom background behind. Anything undoing part of pass 1 has to undo it with pass
   * 1's own arithmetic (`server/match/runtime.ts#listenerGate`).
   */
  lossFactorAt(range: number): number {
    const index = range < 0 ? 0 : range > this.maxLossIndex ? this.maxLossIndex : range | 0;
    return this.lossFactor[index] ?? 0;
  }

  /**
   * Transmission loss in decibels, from the same table.
   *
   * The solver itself never wants this — every test in here is rearranged into powers so the
   * inner loops pay no logarithm (see the file header) — but a caller building a *field* of
   * levels does, and it should not have to pay a `Math.log10` per lattice cell to get what has
   * already been tabulated (`server/match/runtime.ts`, the `detect` overlay).
   */
  lossDbAt(range: number): number {
    const index = range < 0 ? 0 : range > this.maxLossIndex ? this.maxLossIndex : range | 0;
    return this.lossDb[index] ?? Infinity;
  }

  /** The same, for the solver's own loops. */
  private factorAt(range: number): number {
    return this.lossFactorAt(range);
  }

  /**
   * How far one entity's field has to reach.
   *
   * As a **source** it must be followed until it can neither be heard directly by the keenest
   * listener in the match nor lift anyone's noise floor. That bound is honest and it is
   * sometimes the whole map — a cavitating boat really is audible three kilometres away, and
   * clipping that would delete the loudest event in the game.
   *
   * As a **listener** the bound is `maxImagingRange`, a flat cap, and that one is a choice
   * rather than a derivation. Reflections pay the path twice, so the picture is short-ranged
   * by construction; the far-off case a longer field would buy — a cave wall lit by a distant
   * cavitating boat — is scenery, while the boat itself is found through the direct path,
   * which needs no field at all. Capping it is what keeps the sweep affordable.
   */
  private reachOf(
    entity: AcousticEntity,
    softestAbsorption: number,
    quietestThreshold: number,
  ): number {
    let budget = -Infinity;

    if (entity.sourceLevel > -Infinity) {
      budget = Math.max(
        budget,
        entity.sourceLevel - quietestThreshold,
        entity.sourceLevel - softestAbsorption - quietestThreshold,
        entity.sourceLevel - this.tuning.ambientNoise + AMBIENT_TAIL,
      );
    }

    const reach = budget === -Infinity ? 0 : rangeForLoss(budget, this.tuning);
    const imaging = entity.hydrophone === null ? 0 : this.tuning.maxImagingRange;
    return Math.min(this.tuning.maxRange, Math.max(reach, imaging));
  }

  /** Every hull outline in the match, on the vision grid, bucketed by the water beside it. */
  private traceHulls(list: readonly AcousticEntity[]): ReflectorSet {
    const cells: number[] = [];
    const owners: number[] = [];

    for (let e = 0; e < list.length; e += 1) {
      const entity = list[e];
      if (entity?.outline == null || !Number.isFinite(entity.absorption)) continue;
      const before = cells.length;
      traceOutline(this.grid, entity.outline, cells);
      for (let i = before; i < cells.length; i += 1) owners.push(e);
    }

    return groupByLattice(this.lattice, this.grid, cells, owners);
  }

  /** Which listeners sit in which lattice cell, so pass 1 can fill the pair table as it sweeps. */
  private indexListeners(seats: readonly number[], ownCell: Int32Array): void {
    this.listenerStart.fill(0);
    if (this.listenerAt.length < seats.length) this.listenerAt = new Int32Array(seats.length);

    for (const e of seats) {
      const cell = ownCell[e] ?? -1;
      if (cell < 0) continue;
      this.listenerStart[cell + 1] = (this.listenerStart[cell + 1] ?? 0) + 1;
    }
    for (let i = 0; i < this.lattice.cellCount; i += 1) {
      this.listenerStart[i + 1] = (this.listenerStart[i + 1] ?? 0) + (this.listenerStart[i] ?? 0);
    }

    const cursor = this.listenerStart.slice(0, this.lattice.cellCount);
    for (let slot = 0; slot < seats.length; slot += 1) {
      const e = seats[slot] ?? 0;
      const cell = ownCell[e] ?? -1;
      if (cell < 0) continue;
      const at = cursor[cell] ?? 0;
      cursor[cell] = at + 1;
      this.listenerAt[at] = slot;
    }
  }

  /**
   * What one team can see, pooled across its boats.
   *
   * Pooled rather than solved per player because teammates share their whole picture (C17,
   * planning/03 §10 guardrail 6) — and because a square lit for two boats has one answer, not
   * two. Whichever boat sees it best is the one the excess comes from.
   */
  private look(team: TeamId, w: LookWork): TeamVision {
    const litLattice: number[] = [];
    const litHull: number[] = [];
    const terrainFactor = toPower(this.tuning.terrainAbsorption);

    for (const e of w.crew) {
      const listener = w.list[e];
      if (listener?.hydrophone == null) continue;
      const slot = w.seats.indexOf(e);

      // The heatmap at your own position includes your own racket, which is a division by zero
      // dressed up as a number. Take it back out and use the self-noise figure, which is what
      // that term was always standing in for. Read against the *filtered* background, not the
      // full one: your own ping and a teammate's are still there as loud returns, they just are
      // not part of what deafens you.
      const at = w.ownCell[e] ?? -1;
      const around =
        at < 0 ? 0 : Math.max(0, (this.noiseBackground[at] ?? 0) - (w.ownBackgroundPower[e] ?? 0));

      // ── Direct returns: every other hull, lit by its own noise ────────────────
      for (let a = 0; a < w.list.length; a += 1) {
        if (a === e) continue;
        const emitted = w.emitPower[a] ?? 0;
        if (emitted <= 0) continue;
        const direct = emitted * (w.pairFactor[a * w.slots + slot] ?? 0);
        if (direct <= 0) continue;

        // Everything *except* this source is what it has to be heard over. Counting a boat
        // against itself is what makes a purely reflective model detect nothing.
        const floor = noiseFloorOf(
          toDecibels(Math.max(0, around - direct)),
          listener.hydrophone.selfNoise,
          this.tuning,
        );
        const gate = toPower(returnThreshold(floor, listener.hydrophone.gain, this.tuning));
        if (direct < gate) continue;

        const excess = toDecibels(direct / gate);
        const from = w.byOwner.starts[a] ?? 0;
        const to = w.byOwner.starts[a + 1] ?? from;
        for (let i = from; i < to; i += 1) {
          const k = w.byOwner.entries[i] ?? 0;
          const best = this.hullBest[k] ?? -1;
          if (excess > best) {
            if (best < 0) litHull.push(k);
            this.hullBest[k] = excess;
          }
        }
      }

      // ── Reflections: everything the sound in the water bounces off ────────────
      const field = w.fields[e];
      if (field == null) continue;
      // Counted for the statistics panel, and counted here rather than derived: this pass walks
      // the *listeners'* fields, which is a different number from the `fieldCells` every entity
      // contributed to (`match/perf.ts#SimCounts`).
      this.lookCells += field.count;

      const floor = noiseFloorOf(toDecibels(around), listener.hydrophone.selfNoise, this.tuning);
      const thresholdPower = toPower(returnThreshold(floor, listener.hydrophone.gain, this.tuning));
      const terrainGate = thresholdPower * terrainFactor;

      for (let i = 0; i < field.count; i += 1) {
        const cell = this.arena.cellAt(field, i);

        // **Is there anything here to reflect?** Asked first, and it is the most valuable branch
        // in this loop: about **98%** of the water a listener sweeps carries neither a scrap of
        // rock face nor a hull square, and a cell with neither cannot reach either branch below —
        // the rock one needs `rockTo > rockFrom` and the hull one needs `from !== to`. So skipping
        // it here is not an approximation, it is the same nothing arrived at sooner
        // (planning/16 §3.6).
        //
        // The two spans were already being read a few lines further down; all that changed is that
        // they are read *before* the arithmetic rather than after it. What that buys is not paying
        // a `factorAt` and a scattered read into an 800 KB heatmap for water that holds nothing.
        const rockFrom = this.terrain.starts[cell] ?? 0;
        const rockTo = this.terrain.starts[cell + 1] ?? rockFrom;
        const from = w.dynamic.starts[cell] ?? 0;
        const to = w.dynamic.starts[cell + 1] ?? from;
        if (rockFrom === rockTo && from === to) continue;

        // The return leg. Its loss is the outbound leg's, because path length is symmetric —
        // this is the second job the one field does.
        const back = this.factorAt(this.arena.rangeAt(field, i));
        const incident = (this.noisePower[cell] ?? 0) + this.ambientPower;
        const returned = incident * back;

        if (returned >= terrainGate && rockTo > rockFrom) {
          const excess = toDecibels(returned / terrainGate);
          const best = this.terrainBest[cell] ?? -1;
          if (excess > best) {
            if (best < 0) litLattice.push(cell);
            this.terrainBest[cell] = excess;
          }
        }

        if (from === to) continue;

        const centre = this.lattice.centreOf(cell);
        for (let k = from; k < to; k += 1) {
          const owner = w.dynamic.owners[k] ?? -1;
          // You do not image yourself. Everything else is fair game, including teammates: the
          // picture has no idea whose hull it is looking at, and neither will the player.
          if (owner === e || owner < 0) continue;
          const hull = w.list[owner];
          if (hull === undefined) continue;

          // A boat does not reflect its own noise — that arrival is the direct return above,
          // and counting it twice would draw every boat at its own source level plus an echo.
          // The straight-line range is right here: the square is on the hull's own skin.
          const mine =
            (w.emitPower[owner] ?? 0) *
            this.factorAt(Math.hypot(centre.x - hull.pos.x, centre.y - hull.pos.y));
          const lit = Math.max(0, incident - mine) * back;

          const gate = thresholdPower * (w.absorptionFactor[owner] ?? Infinity);
          if (lit < gate) continue;
          const excess = toDecibels(lit / gate);
          const best = this.hullBest[k] ?? -1;
          if (excess > best) {
            if (best < 0) litHull.push(k);
            this.hullBest[k] = excess;
          }
        }
      }
    }

    const picture = this.assemble(litLattice, litHull, w.dynamic, w.list);

    for (const cell of litLattice) this.terrainBest[cell] = -1;
    for (const k of litHull) this.hullBest[k] = -1;

    return { team, ...picture };
  }

  /**
   * Turns lit lattice cells and lit hull squares into the flat list that goes to the client.
   *
   * Under the cap this is a walk in lattice order — cheap, and roughly left-to-right up the
   * map. Over it, the two lists are merged brightest-first and the tail is dropped: a picture
   * truncated at random would flicker between ticks, while one truncated by strength fades at
   * the edges the way a display does. Nothing is sorted on a tick that fits.
   *
   * Terrain is emitted a lattice cell at a time because every square in one shares an answer —
   * the same rock, the same absorption, the same return leg. Only the shape is per-square.
   */
  private assemble(
    litLattice: readonly number[],
    litHull: readonly number[],
    dynamic: ReflectorSet,
    list: readonly AcousticEntity[],
  ): { cells: Int32Array; excess: Float32Array; owners: Int32Array; dropped: number } {
    const spanOf = (cell: number): number =>
      (this.terrain.starts[cell + 1] ?? 0) - (this.terrain.starts[cell] ?? 0);

    let total = litHull.length;
    for (const cell of litLattice) total += spanOf(cell);

    const budget = this.tuning.maxVisionCells;
    const cells = new Int32Array(Math.min(total, budget));
    const excess = new Float32Array(cells.length);
    const owners = new Int32Array(cells.length);
    let n = 0;

    const pushHull = (k: number): void => {
      if (n >= cells.length) return;
      cells[n] = dynamic.cells[k] ?? 0;
      excess[n] = this.hullBest[k] ?? 0;
      // The skin's owner is an index into `list`; what the caller can act on is the entity id.
      // Translating here rather than at every call site is what keeps a solve's output free of
      // the solver's own private numbering.
      owners[n] = list[dynamic.owners[k] ?? -1]?.id ?? -1;
      n += 1;
    };
    const pushRock = (cell: number): void => {
      const value = this.terrainBest[cell] ?? 0;
      const from = this.terrain.starts[cell] ?? 0;
      const to = this.terrain.starts[cell + 1] ?? from;
      for (let k = from; k < to && n < cells.length; k += 1) {
        cells[n] = this.terrain.cells[k] ?? 0;
        excess[n] = value;
        owners[n] = -1;
        n += 1;
      }
    };

    if (total <= budget) {
      for (const k of litHull) pushHull(k);
      for (const cell of litLattice) pushRock(cell);
    } else {
      const order: Array<{ key: number; hull: boolean; at: number }> = [];
      for (const k of litHull) order.push({ key: -(this.hullBest[k] ?? 0), hull: true, at: k });
      for (const c of litLattice) {
        order.push({ key: -(this.terrainBest[c] ?? 0), hull: false, at: c });
      }
      order.sort((a, b) => a.key - b.key || (a.hull === b.hull ? a.at - b.at : a.hull ? -1 : 1));

      for (const entry of order) {
        if (n >= cells.length) break;
        if (entry.hull) pushHull(entry.at);
        else pushRock(entry.at);
      }
    }

    return {
      cells: cells.subarray(0, n),
      excess: excess.subarray(0, n),
      owners: owners.subarray(0, n),
      dropped: total - n,
    };
  }
}

/** Everything `look` needs, bundled so the signature does not run to a dozen positional arguments. */
interface LookWork {
  readonly list: readonly AcousticEntity[];
  /** Listener indices on the team being assembled. */
  readonly crew: readonly number[];
  /** Every listener index, in slot order — the pair table's second axis. */
  readonly seats: readonly number[];
  readonly fields: readonly (FieldHandle | null)[];
  readonly ownCell: Int32Array;
  readonly ownBackgroundPower: Float64Array;
  readonly emitPower: Float64Array;
  readonly absorptionFactor: Float64Array;
  readonly pairFactor: Float64Array;
  readonly slots: number;
  readonly dynamic: ReflectorSet;
  readonly byOwner: OwnerIndex;
}

/** Which skin entries belong to which entity — how a direct return lights a whole hull at once. */
interface OwnerIndex {
  readonly starts: Int32Array;
  readonly entries: Int32Array;
}

function groupByOwner(dynamic: ReflectorSet, count: number): OwnerIndex {
  const starts = new Int32Array(count + 1);
  for (let k = 0; k < dynamic.owners.length; k += 1) {
    const owner = dynamic.owners[k] ?? -1;
    if (owner < 0) continue;
    starts[owner + 1] = (starts[owner + 1] ?? 0) + 1;
  }
  for (let i = 0; i < count; i += 1) starts[i + 1] = (starts[i + 1] ?? 0) + (starts[i] ?? 0);

  const entries = new Int32Array(starts[count] ?? 0);
  const cursor = starts.slice(0, count);
  for (let k = 0; k < dynamic.owners.length; k += 1) {
    const owner = dynamic.owners[k] ?? -1;
    if (owner < 0) continue;
    const at = cursor[owner] ?? 0;
    cursor[owner] = at + 1;
    entries[at] = k;
  }

  return { starts, entries };
}
