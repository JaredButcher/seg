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
 * to be and the loser of one fight is never left with nothing to do. No two of them sit closer
 * than a kilometre when the water can spread them, so the three read as three separate fights
 * rather than one contested blob.
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
 * ## Where a zone may be
 *
 * Two bounds, one horizontal and one vertical, and they answer different objections.
 *
 * **The middle third of the width.** Deployment bands are the outer 12% of each end
 * (`deploy.ts`), and a zone that could spawn near one would be a free point for whoever started
 * beside it. Confining every objective to the centre makes the travel cost symmetric by
 * construction, whatever the map did — which matters more here than it would for a hand-placed
 * layout, because the placement is random and nobody is checking it per match.
 *
 * **No deeper than `OBJECTIVE_MAX_DEPTH`.** The seabed is deeper than any hull can go, so the
 * bottom of the map would produce objectives that cannot be contested at all rather than ones
 * that are hard to.
 *
 * **At most `MAX_DEEP_OBJECTIVES` below `OBJECTIVE_DEEP_DEPTH`.** Deep water is a tax on fleet
 * composition, and one objective's worth of it is a question; two at once is a verdict.
 *
 * A spawn that cannot satisfy all of those **does not happen**. There is no fallback position:
 * the slot stays empty and is tried again the next time the board changes, which is the only
 * thing that can make a location legal that was not. A match can therefore run with two
 * objectives, or one, or none — and that is the honest outcome, because the alternative is
 * putting a circle somewhere the rules said it must not go.
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
import { depthAt, yAt } from '../map/sizes.js';
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
 * The deepest an objective's centre may sit, in metres of game depth.
 *
 * The bottom of the map is the one place a zone cannot fairly be put. `MAP_DEPTH` is 1000 m and
 * the deepest a boat can be built to go is 860 m (`map/sizes.ts`), so an objective in the last
 * couple of hundred metres would be one no fleet could contest at all — not a hard fight, an
 * impossible one, and the mode would quietly be playing two-thirds of its objectives.
 *
 * 800 m is still deep enough to bite. Every base hull crushes shallower than that (580–680 m),
 * so a zone near the ceiling is takeable only by a boat that paid for a pressure hull — which is
 * exactly the "composition decides which objectives you can contest" axis planning/06 §2.2 wants,
 * arrived at through the depth limit rather than through hand-placement.
 */
export const OBJECTIVE_MAX_DEPTH = 800;

/**
 * Below this game depth an objective counts as **deep** — past every base hull's crush depth
 * except by a margin, and into the water only a pressure-hulled fleet can hold.
 */
export const OBJECTIVE_DEEP_DEPTH = 600;

/**
 * How many deep objectives may be on the board at once.
 *
 * One, and the reason is that the depth limit is a *composition* tax rather than a difficulty
 * dial. A single deep zone asks a fleet whether it brought something that can go and get it, and
 * that is an interesting question because there are two other objectives it can have instead.
 * Two deep zones at once asks it whether it brought a deep fleet at all — and a side that did
 * not is now playing for one objective out of three, which is a match decided in the lobby.
 *
 * **Not on the relaxation ladder.** A spawn that can only find deep water while a deep zone is
 * already standing does not spawn at all (see `spawnZone`). A crowded board is recoverable and
 * a board where two thirds of the objectives are out of reach is not.
 */
export const MAX_DEEP_OBJECTIVES = 1;

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
 * `5` is the first ask — a full kilometre between zones (5 · `OBJECTIVE_RADIUS` = 1000 m), so
 * the three read as three separate fights and a win does not empty a corner of the map. It is a
 * preference, not a law: `2.5` then `2` relax it, a crowded board being better than a refused
 * spawn.
 *
 * `2` is the hard requirement — two circles of equal radius whose centres are `2r` apart touch
 * and do not overlap, which is the rule. Each looser step is abandoned rather than insisted on.
 *
 * This is the *only* rule that relaxes. The depth ceiling, the deep quota, the band, and
 * non-overlap itself all hold or the zone does not spawn.
 */
const SEPARATION_STEPS: readonly number[] = [5, 2.5, 2];

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
/** The ambient-ghost stream (planning/15 §6). A third salt, so adding ghosts cannot shift
 * the layout or the respawns — the whole point of the fork pattern. */
const GHOST_SALT = 0x0b1ee0;

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

/**
 * The slice of the map zones may appear in: the middle third of its width, and no deeper than
 * `OBJECTIVE_MAX_DEPTH`.
 *
 * `y0` is a *floor* on Y rather than a ceiling, because the frame is y-up while depth counts
 * down from the surface (`map/sizes.ts`) — the same inversion `deploy.ts` navigates for berths,
 * and the same one that puts a boat at the seabed if it is read the wrong way round.
 */
export function objectiveBand(extents: MapExtents): {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
} {
  const margin = extents.width * OBJECTIVE_BAND_FRACTION;
  return {
    x0: margin,
    x1: extents.width - margin,
    y0: yAt(extents, OBJECTIVE_MAX_DEPTH),
  };
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

/** The stream ambient ghosts are drawn from (planning/15 §6). Pure in the map seed. */
export function ghostRng(seed: number): Rng {
  return createRng(seed).fork(GHOST_SALT);
}

export interface SpawnZoneOptions {
  readonly ruler: TerrainRuler;
  readonly extents: MapExtents;
  readonly rng: Rng;
  readonly id: EntityId;
  readonly label: string;
  /**
   * The zones still on the board.
   *
   * Two rules read it and they need different things from it, which is why it is the zones
   * rather than a bare list of points: non-overlap needs their centres, and the deep quota needs
   * to count how many of them are deep. A retired zone's position belongs in `clearOf`, where it
   * is avoided without being counted — it is not on the board any more, and letting it hold the
   * deep slot it used to occupy would block its own replacement.
   */
  readonly standing: readonly CaptureZone[];
  /** Positions to keep clear of without counting toward anything. The zone just retired. */
  readonly clearOf?: readonly Vec2[];
  /** Ticks it spends grey before opening. Zero for the opening layout. */
  readonly armingTicks: number;
  readonly radius?: number;
}

/**
 * One zone at a random legal spot, or **`null` if there is no legal spot at all**.
 *
 * "Clear of terrain" is `clearanceAt >= 2 · radius`: the ruler reports the diameter of the
 * largest disc that fits at a point, so a point measuring twice the radius is one where the
 * whole circle is water. That is the *whole* circle, not merely its centre — a zone with a
 * wall through it would be capturable from a pocket the other side could not reach.
 *
 * Uniform over the candidates rather than weighted toward the middle: every legal spot is an
 * equally good fight, and a bias would make the mode's geography predictable after a dozen
 * matches, which is the one thing random placement is for. The candidate scan itself anchors on
 * a random point in the middle of the band and fans out (`candidateCentres`), so the search does
 * not walk in from one edge of the map.
 *
 * **`null` is a real answer, not an error.** The caller leaves the slot empty and tries again
 * later (`vacantLabels`). Every rule this function applies is a rule about fairness — inside the
 * band, in water, not on top of another objective, reachable, and not the second deep one — so
 * the only way to honour a failed draw is to have no objective there. An earlier version fell
 * back to "the roomiest water it could find", which quietly meant *the rules apply unless they
 * are inconvenient*, and the one case it would have fired in is the one case it mattered.
 */
export function spawnZone(options: SpawnZoneOptions): CaptureZone | null {
  const radius = options.radius ?? OBJECTIVE_RADIUS;
  const avoid = [...options.standing.map((zone) => zone.centre), ...(options.clearOf ?? [])];
  const deepAllowed =
    options.standing.filter((zone) => isDeepZone(options.extents, zone.centre)).length <
    MAX_DEEP_OBJECTIVES;

  let pool: readonly Vec2[] = [];
  for (const factor of SEPARATION_STEPS) {
    pool = candidateCentres(
      options.ruler,
      options.extents,
      radius,
      avoid,
      radius * factor,
      deepAllowed,
      options.rng,
    );
    if (pool.length > 0) break;
  }

  const centre = pool.length === 0 ? undefined : pool[options.rng.int(0, pool.length - 1)];
  if (centre === undefined) return null;

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

/** Whether a point sits in the water only a pressure-hulled fleet can hold. */
export function isDeepZone(extents: MapExtents, centre: Vec2): boolean {
  return depthAt(extents, centre.y) > OBJECTIVE_DEEP_DEPTH;
}

/** The label slot `index` carries, for the life of the match. */
export function zoneLabel(index: number): string {
  return `OBJ ${String(index + 1)}`;
}

/**
 * The opening layout: up to `count` zones, none overlapping, all live from tick zero.
 *
 * The opening zones do **not** arm — `ARMING_SECONDS` exists so a replacement cannot be taken
 * by whoever was already standing there, and at tick zero nobody is standing anywhere. A
 * grey minute at the start would only be a minute of the match in which nothing can happen.
 *
 * **Up to**, because a slot with no legal position is simply not filled. Each slot keeps its own
 * id and label whether or not it was placed, so the labels of the ones that did land still say
 * which of the three they are, and `vacantLabels` can name the ones that did not.
 */
export function spawnZones(
  map: GeneratedMap,
  ruler: TerrainRuler,
  rng: Rng,
  count = OBJECTIVE_COUNT,
): readonly CaptureZone[] {
  const zones: CaptureZone[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const placed = spawnZone({
      ruler,
      extents: map.extents,
      rng,
      id: ZONE_ID_BASE + slot,
      label: zoneLabel(slot),
      standing: zones,
      armingTicks: 0,
    });
    if (placed !== null) zones.push(placed);
  }
  return zones;
}

/**
 * The slot labels with nothing standing in them — the objectives the board owes.
 *
 * Derived from the labels rather than tracked, so there is no second list to be kept in step
 * with the first. A vacancy is *a slot whose label is not on the board*, which is true whether
 * it was never placed, or was captured a tick ago, or has been waiting since deployment.
 */
export function vacantLabels(
  zones: readonly CaptureZone[],
  count = OBJECTIVE_COUNT,
): readonly string[] {
  const held = new Set(zones.map((zone) => zone.label));
  const vacant: string[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const label = zoneLabel(slot);
    if (!held.has(label)) vacant.push(label);
  }
  return vacant;
}

/** Every point in the band with room for the circle and distance from what is already there. */
function candidateCentres(
  ruler: TerrainRuler,
  extents: MapExtents,
  radius: number,
  avoid: readonly Vec2[],
  separation: number,
  deepAllowed: boolean,
  rng: Rng,
): readonly Vec2[] {
  const band = objectiveBand(extents);
  const needed = radius * 2;
  const found: Vec2[] = [];

  // The scan anchors on a random point in the middle of the band and fans out from it, wrapping
  // past the far edge back to the near one, rather than walking in from the left. The pool it
  // builds is the same set either way; the anchor only sets the order, so a later change that
  // turns the pick into "take the first found" starts from the middle of the map rather than
  // from one edge — and objectives stop quietly favouring the side the scan happens to begin on.
  const span = band.x1 - band.x0;
  const startX = (band.x0 + band.x1) / 2 + rng.range(-span / 2, span / 2);
  const firstX = band.x0 + SPAWN_STEP / 2;
  const cols = Math.max(0, Math.ceil((band.x1 - firstX) / SPAWN_STEP));
  const start =
    cols === 0 ? 0 : Math.max(0, Math.min(cols - 1, Math.round((startX - firstX) / SPAWN_STEP)));

  for (let step = 0; step < cols; step += 1) {
    const index = (start + step) % cols;
    const x = firstX + index * SPAWN_STEP;
    if (x >= band.x1) continue;
    for (let y = SPAWN_STEP / 2; y < extents.height; y += SPAWN_STEP) {
      // Filtered rather than clipping the loop bound, so the candidate lattice is the same one
      // whatever the depth ceiling is set to — the same discipline `deploy.ts` applies to a
      // hull's own depth limit, and for the same reason.
      if (y < band.y0) continue;
      if (!deepAllowed && isDeepZone(extents, { x, y })) continue;
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

// ── Capture ─────────────────────────────────────────────────────────────────────────

/** One objective taken, and by whom. */
export interface ZoneCapture {
  /**
   * The zone as it stood when it fell. Its `label` is the slot the replacement inherits and its
   * `centre` is where the fight was — which is the one place the replacement should not be.
   */
  readonly zone: CaptureZone;
  readonly team: TeamId;
  /**
   * The capturing team's boats standing in the circle on the tick it fell.
   *
   * **All of them, not one.** Progress does not scale with boat count (planning/06 §2.2), so
   * there is no "the boat that captured it" to name — a point is taken by whoever was still
   * there at the end, and the results screen credits each of them with it. Reported here rather
   * than recomputed by the caller because the capture is the only moment it is true: a tick
   * later the fleet has moved on and the zone is gone.
   */
  readonly boats: readonly EntityId[];
}

export interface ZoneAdvance {
  /**
   * The zones after this tick, captures included — a captured zone is left standing at
   * `progress: 1`. Retiring it and drawing a replacement needs a terrain ruler and a random
   * stream, which are the runtime's to hold, so it is the runtime that does both
   * (`server/match/runtime.ts`) — and it must retire it on the tick it is told, or the next
   * tick reports the same capture again.
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

  const next = zones.map((zone) => {
    const stepped = advanceZone(zone, boats, tickSeconds);
    if (stepped !== zone) moved = true;
    if (stepped.capturing !== null && stepped.progress >= 1) {
      const team = stepped.capturing;
      captures.push({
        zone: stepped,
        team,
        // Only walked on the tick a zone falls, which is a handful of ticks in a whole match.
        boats: boats
          .filter(
            (boat) =>
              boat.status === 'active' && boat.team === team && withinZone(stepped, boat.pos),
          )
          .map((boat) => boat.id),
      });
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
