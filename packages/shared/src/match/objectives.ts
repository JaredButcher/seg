/**
 * @seg/shared/match/objectives — capture zones, and the rules that move them.
 *
 * Objective Capture's whole mechanic lives here: where a zone may appear, what it takes to
 * take one, and what happens when someone does. Deathmatch never calls any of it, and the
 * zone list is empty there.
 *
 * ## The loop
 *
 * A zone is a 200 m circle somewhere in the **middle third** of the map. Hold it for
 * `CAPTURE_SECONDS` with no enemy inside and it is yours: it is worth **one point**, it
 * vanishes, and a replacement appears somewhere else in the band, grey and untakeable for
 * `ARMING_SECONDS`. Three are on the board at once, so the fleet always has a choice of where
 * to be and the loser of one fight is never left with nothing to do.
 *
 * Two rules carry the tension, and they are deliberately asymmetric:
 *
 * - **Leaving loses everything.** Progress belongs to the team standing on the point, and the
 *   moment its last boat is outside the circle the count goes back to zero. Twenty-nine
 *   seconds of holding is worth exactly as much as none.
 * - **Being contested only pauses it.** An enemy boat inside freezes the count where it is
 *   rather than draining it. So an interloper cannot undo the work by arriving — they have to
 *   *stay*, or kill, and the zone becomes the knife fight planning/06 §2.2 asks for.
 *
 * Together those mean the interesting question is never "who got here first" but "who can
 * still be here in thirty seconds", which is the question the acoustic game is good at asking.
 *
 * ## Why the middle third
 *
 * Deployment bands are the outer 12% of each end (`deploy.ts`), and a zone that could spawn
 * near one would be a free point for whoever started beside it. Confining every objective to
 * the middle third makes the travel cost symmetric by construction, whatever the map did —
 * which matters more here than a hand-placed layout would, because the placement is random.
 *
 * ## Determinism
 *
 * Placement draws from a seeded stream (`math/rng.ts`), never `Math.random`, for the same
 * reason the map generator does: a replay reproduces a match from its seed and its command log
 * (planning/04 §9), and an objective that appeared somewhere else on replay would invalidate
 * every order given after it. The opening layout and the respawns run on **separate forks** of
 * the map seed, so adding a zone to the opening layout does not shift where the twentieth
 * respawn lands.
 */

import { TerrainRuler } from '../map/measure.js';
import type { GeneratedMap, MapExtents, Vec2 } from '../map/types.js';
import { createRng, type Rng } from '../math/rng.js';
import type { BoatState, EntityId, TeamId } from './world.js';

// ── Tuning ──────────────────────────────────────────────────────────────────────────

/** A zone's radius, metres. Flat rather than scaled with the map: it is a distance a boat travels. */
export const OBJECTIVE_RADIUS = 200;

/** How many zones are on the board at once. A capture is replaced, so the count never moves. */
export const OBJECTIVE_COUNT = 3;

/** Uncontested seconds inside the circle to take it. */
export const CAPTURE_SECONDS = 30;

/**
 * How long a replacement sits grey and untakeable after it appears.
 *
 * It is the mode's only pacing lever. Without it a team already sitting in the middle would
 * capture, watch a new circle open under them, and capture again — the replacement would
 * reward being *there* rather than getting there. A minute is enough for the other side to
 * read the new position off the mini-map and commit to it.
 */
export const ARMING_SECONDS = 60;

/**
 * How much of the map's width each end is excluded from, as a fraction. A third off each end
 * leaves the middle third. See the file header for why.
 */
export const OBJECTIVE_BAND_FRACTION = 1 / 3;

/**
 * The lattice objective placement is measured on, metres.
 *
 * Coarser than the ruler deployment berths on (5 m), and deliberately: a berth asks whether a
 * 40 m hull fits, and this asks whether a 400 m circle does. `TerrainRuler` biases every
 * clearance *low* by half a cell, so a coarser lattice can only refuse a spot that would have
 * fitted — never accept one that would not. The error is on the safe side of "does not overlap
 * terrain", which is the property that has to hold.
 */
export const OBJECTIVE_LATTICE_CELL = 20;

/** Spacing of candidate centres within the band, metres. */
const SPAWN_STEP = 50;

/**
 * How far apart two zones' centres must be, as a multiple of the radius, tried in order.
 *
 * `2` is the hard requirement — two circles of equal radius whose centres are `2r` apart touch
 * and do not overlap, which is the rule. `2.5` is tried first so the three read as three
 * separate places to go rather than as one contested blob, and it is abandoned rather than
 * insisted on: a crowded board is better than a refused spawn.
 */
const SEPARATION_STEPS: readonly number[] = [2.5, 2];

/**
 * Zone ids start well above the boats' so the two are distinguishable at a glance in a log.
 * They share the `EntityId` space because a zone is an entity (planning/04 §4).
 *
 * **Each spawn gets a fresh id**, counting up from here for the life of the match. A
 * replacement is a new objective in a new place, not the old one moved, and giving it the old
 * id would let a client animate a circle sliding across the map — which is the one thing that
 * did not happen.
 */
export const ZONE_ID_BASE = 1000;

/** Independent streams, so the opening layout and the respawns cannot shift each other. */
const INITIAL_LAYOUT_SALT = 0x0b1ec7;
const RESPAWN_SALT = 0x0b1ed0;

// ── The zone ────────────────────────────────────────────────────────────────────────

/**
 * A capture zone (planning/06 §2.2). Objective Capture only; the list is empty in deathmatch.
 *
 * **Every field of this changes during a match**, including `centre` — which is why the whole
 * shape travels in the view frame rather than half of it riding in `MatchSetup` (`view.ts`).
 */
export interface CaptureZone {
  /** Fresh per spawn. See `ZONE_ID_BASE`. */
  readonly id: EntityId;
  /**
   * Player-facing designation, and the name chat's "objective: N" quick ping uses.
   *
   * Per **slot** rather than per spawn: there are always exactly three, and a callout that
   * named a number counting up past twenty would be useless to say out loud. A replacement
   * inherits the label of the objective it replaces.
   */
  readonly label: string;
  readonly centre: Vec2;
  readonly radius: number;
  /**
   * Simulation ticks until it opens for capture. Zero once open.
   *
   * A tick count rather than seconds, because the simulation's only clock is the tick
   * (planning/02 §5) and a float decremented twelve hundred times would land near zero rather
   * than on it. The client divides by `SIM_TICK_HZ` to draw a countdown, the same way it reads
   * a boat's `lastPingTick`.
   */
  readonly armingTicks: number;
  /** The team accruing progress, or `null` when nobody is. */
  readonly capturing: TeamId | null;
  /** Progress toward capture by `capturing`, 0..1. Frozen while `contested`. */
  readonly progress: number;
  /** Boats from both teams are inside. Progress stops and the zone becomes a knife fight. */
  readonly contested: boolean;
}

/** Whether a point lies inside a zone. The definition of "in the circle", in one place. */
export function withinZone(zone: Pick<CaptureZone, 'centre' | 'radius'>, point: Vec2): boolean {
  return Math.hypot(point.x - zone.centre.x, point.y - zone.centre.y) <= zone.radius;
}

/** Whether a zone is open for capture, rather than still counting down to it. */
export function isArmed(zone: Pick<CaptureZone, 'armingTicks'>): boolean {
  return zone.armingTicks <= 0;
}

// ── Placement ───────────────────────────────────────────────────────────────────────

/** The horizontal slice zones may appear in: the middle third of the map. */
export function objectiveBand(extents: MapExtents): { readonly x0: number; readonly x1: number } {
  const margin = extents.width * OBJECTIVE_BAND_FRACTION;
  return { x0: margin, x1: extents.width - margin };
}

/**
 * A ruler for objective placement, at `OBJECTIVE_LATTICE_CELL`.
 *
 * Built through here by both callers — the opening layout in `deploy.ts` and the respawns in
 * the server's `MatchRuntime` — so the two measure "is this water" against the same lattice
 * and cannot disagree about where a circle fits.
 */
export function objectiveRuler(map: GeneratedMap): TerrainRuler {
  return new TerrainRuler(map.extents, map.terrain.obstacles, {
    cellSize: OBJECTIVE_LATTICE_CELL,
  });
}

/** The stream the opening layout is drawn from. Pure in the map seed. */
export function initialLayoutRng(seed: number): Rng {
  return createRng(seed).fork(INITIAL_LAYOUT_SALT);
}

/** The stream every replacement is drawn from. Independent of the opening layout's. */
export function respawnRng(seed: number): Rng {
  return createRng(seed).fork(RESPAWN_SALT);
}

export interface SpawnZoneOptions {
  readonly ruler: TerrainRuler;
  readonly extents: MapExtents;
  readonly rng: Rng;
  readonly id: EntityId;
  readonly label: string;
  /** Centres to stay clear of — the zones already on the board, and the one being replaced. */
  readonly avoid: readonly Vec2[];
  /** Ticks it spends grey before opening. Zero for the opening layout. */
  readonly armingTicks: number;
  readonly radius?: number;
}

/**
 * One zone, at a random spot in the band that is clear of terrain and of the other zones.
 *
 * "Clear of terrain" is `clearanceAt >= 2 · radius`: the ruler reports the diameter of the
 * largest disc that fits at a point, so a point measuring twice the radius is one where the
 * whole circle is water. That is the *whole* circle, not merely its centre — a zone with a
 * wall through it would be capturable from a pocket the other side could not reach.
 *
 * Uniform over the candidates rather than weighted toward the middle: every legal spot is an
 * equally good fight, and a bias would make the mode's geography predictable after a dozen
 * matches, which is the one thing random placement is for.
 */
export function spawnZone(options: SpawnZoneOptions): CaptureZone {
  const radius = options.radius ?? OBJECTIVE_RADIUS;

  let pool: readonly Vec2[] = [];
  for (const factor of SEPARATION_STEPS) {
    pool = candidateCentres(options.ruler, options.extents, radius, options.avoid, radius * factor);
    if (pool.length > 0) break;
  }

  const centre =
    pool.length === 0
      ? roomiestPoint(options.ruler, options.extents)
      : (pool[options.rng.int(0, pool.length - 1)] ??
        roomiestPoint(options.ruler, options.extents));

  return {
    id: options.id,
    label: options.label,
    centre,
    radius,
    armingTicks: Math.max(0, Math.round(options.armingTicks)),
    capturing: null,
    progress: 0,
    contested: false,
  };
}

/** The label slot `index` carries, for the life of the match. */
export function zoneLabel(index: number): string {
  return `OBJ ${String(index + 1)}`;
}

/**
 * The opening layout: `count` zones, none overlapping, all live from tick zero.
 *
 * The opening three do **not** arm — `ARMING_SECONDS` exists so a replacement cannot be taken
 * by whoever was already standing there, and at tick zero nobody is standing anywhere. A
 * grey minute at the start would only be a minute of the match in which nothing can happen.
 */
export function spawnZones(
  map: GeneratedMap,
  ruler: TerrainRuler,
  rng: Rng,
  count = OBJECTIVE_COUNT,
): readonly CaptureZone[] {
  const zones: CaptureZone[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    zones.push(
      spawnZone({
        ruler,
        extents: map.extents,
        rng,
        id: ZONE_ID_BASE + slot,
        label: zoneLabel(slot),
        avoid: zones.map((zone) => zone.centre),
        armingTicks: 0,
      }),
    );
  }
  return zones;
}

/** Every point in the band with room for the circle and distance from what is already there. */
function candidateCentres(
  ruler: TerrainRuler,
  extents: MapExtents,
  radius: number,
  avoid: readonly Vec2[],
  separation: number,
): readonly Vec2[] {
  const band = objectiveBand(extents);
  const needed = radius * 2;
  const found: Vec2[] = [];

  for (let x = band.x0 + SPAWN_STEP / 2; x < band.x1; x += SPAWN_STEP) {
    for (let y = SPAWN_STEP / 2; y < extents.height; y += SPAWN_STEP) {
      if (ruler.clearanceAt(x, y) < needed) continue;

      let blocked = false;
      for (const other of avoid) {
        if (Math.hypot(x - other.x, y - other.y) < separation) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      found.push({ x, y });
    }
  }

  return found;
}

/**
 * The most open point in the band, as the last resort when nothing fits at all.
 *
 * It has never fired on a generated map — the cave tuning's galleries measure 1300 m across at
 * their narrowest over every size and seed sampled, against the 400 m a zone asks for — and it
 * is here because "no legal spawn" must degrade to a zone in the roomiest water rather than to
 * a crash or a circle in the rock. Deterministic, ties breaking lower-left, so it cannot be a
 * source of replay divergence either.
 */
function roomiestPoint(ruler: TerrainRuler, extents: MapExtents): Vec2 {
  const band = objectiveBand(extents);
  let best: Vec2 = { x: (band.x0 + band.x1) / 2, y: extents.height / 2 };
  let bestClearance = -1;

  for (let x = band.x0 + SPAWN_STEP / 2; x < band.x1; x += SPAWN_STEP) {
    for (let y = SPAWN_STEP / 2; y < extents.height; y += SPAWN_STEP) {
      const clearance = ruler.clearanceAt(x, y);
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = { x, y };
      }
    }
  }

  return best;
}

// ── Capture ─────────────────────────────────────────────────────────────────────────

/** One objective taken, and by whom. */
export interface ZoneCapture {
  /** The zone as it stood when it fell — its position is where the fight was. */
  readonly zone: CaptureZone;
  readonly team: TeamId;
  /** Which slot fell, so a replacement can be put back in its place with its label. */
  readonly slot: number;
}

export interface ZoneAdvance {
  /**
   * The zones after this tick, captures included — a captured zone is left standing at
   * `progress: 1`. Replacing it needs a terrain ruler and a random stream, which are the
   * runtime's to hold, so it is the runtime that swaps it out (`server/match/runtime.ts`) —
   * and it must, on the tick it is told, or the next tick reports the same capture again.
   */
  readonly zones: readonly CaptureZone[];
  readonly captures: readonly ZoneCapture[];
}

/**
 * Advance every zone by one tick against the fleet as it now stands.
 *
 * Called after movement and collision have settled, so "inside the circle" is asked of where
 * the boats *ended up* rather than where they were proposed to go.
 *
 * Returns the same array it was given when nothing moved — no zone armed, nobody inside any of
 * them — which is most ticks of most matches, and which is the identity the runtime tests
 * against before it recomputes anything downstream.
 */
export function advanceZones(
  zones: readonly CaptureZone[],
  boats: readonly BoatState[],
  tickSeconds: number,
): ZoneAdvance {
  if (zones.length === 0) return { zones, captures: [] };

  const captures: ZoneCapture[] = [];
  let moved = false;

  const next = zones.map((zone, slot) => {
    const stepped = advanceZone(zone, boats, tickSeconds);
    if (stepped !== zone) moved = true;
    if (stepped.capturing !== null && stepped.progress >= 1) {
      captures.push({ zone: stepped, team: stepped.capturing, slot });
    }
    return stepped;
  });

  return { zones: moved ? next : zones, captures };
}

/** One zone, one tick. Returns the same object when nothing about it changed. */
function advanceZone(
  zone: CaptureZone,
  boats: readonly BoatState[],
  tickSeconds: number,
): CaptureZone {
  if (zone.armingTicks > 0) return { ...zone, armingTicks: zone.armingTicks - 1 };

  let team1Inside = false;
  let team2Inside = false;
  for (const boat of boats) {
    if (boat.status !== 'active') continue;
    if (!withinZone(zone, boat.pos)) continue;
    if (boat.team === 'team1') team1Inside = true;
    else team2Inside = true;
    if (team1Inside && team2Inside) break;
  }

  const inside = (team: TeamId): boolean => (team === 'team1' ? team1Inside : team2Inside);

  let capturing = zone.capturing;
  let progress = zone.progress;

  // Progress belongs to the team that made it and does not outlive their presence. This is
  // the "all progress is lost if the subs leave" rule, and it is checked before anything else
  // so that a team walking in behind another starts from zero rather than inheriting the work.
  if (capturing !== null && !inside(capturing)) {
    capturing = null;
    progress = 0;
  }

  const contested = team1Inside && team2Inside;
  if (!contested) {
    const sole: TeamId | null = team1Inside ? 'team1' : team2Inside ? 'team2' : null;
    if (sole === null) {
      capturing = null;
      progress = 0;
    } else {
      capturing = sole;
      progress = Math.min(1, progress + tickSeconds / CAPTURE_SECONDS);
    }
  }

  if (capturing === zone.capturing && progress === zone.progress && contested === zone.contested) {
    return zone;
  }
  return { ...zone, capturing, progress, contested };
}
