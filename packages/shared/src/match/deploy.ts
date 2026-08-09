/**
 * @seg/shared/match/deploy — putting a lobby's fleets on the map.
 *
 * Pure and deterministic: the same map, the same roster, the same boats, every time. That is
 * not tidiness — a replay reproduces a match from its seed and its command log (planning/04
 * §9), so if deployment wandered, every replay would diverge at tick zero.
 *
 * Shared rather than server-only for the same reason `fleet/resolve.ts` is: the lobby's map
 * preview will want to show where a fleet would start, and a second implementation of "where
 * does a Heavy fit" is a second answer.
 *
 * **This is not the Deployment phase.** planning/06 §1 gives players 60 s to place their own
 * boats and choose their depths, and that is the better game — depth choice is the match's
 * first strategic decision. What this does is place them *for* the player, so a match has
 * boats in it before the placement UI exists. The phase, and the choice, arrive with it.
 *
 * Because the player did not choose, the deployer owes them a start they would not have to
 * undo: no boat is berthed below its own test depth (`deepestBerth`). When the phase does
 * arrive, that becomes a default rather than a rule — a player may dive their own boat as
 * deep as they like, and pay for it.
 */

import { getHull } from '../content/hulls.js';
import { DEFAULT_WEAPON } from '../content/weapons.js';
import { resolveBoat } from '../fleet/resolve.js';
import type { BoatTemplate } from '../fleet/types.js';
import type { GameMode, LobbyPosition } from '../lobby/settings.js';
import type { AccountId } from '../lobby/state.js';
import { TerrainRuler } from '../map/measure.js';
import { BASE_MAP_HEIGHT, MAP_DEPTH, yAt } from '../map/sizes.js';
import type { GeneratedMap, MapExtents, Vec2 } from '../map/types.js';
import {
  DEFAULT_SCORE_TARGET,
  standingFor,
  startingClock,
  type CaptureZone,
  type MatchId,
  type MatchPlayer,
  type MatchState,
} from './state.js';
import {
  HOLDING,
  teamOf,
  TEAM_IDS,
  type BoatState,
  type EntityId,
  type TeamId,
  type TubeState,
} from './world.js';

// ── Tuning ──────────────────────────────────────────────────────────────────────────

/** How much of the map's width each team's deployment band occupies, per end. */
export const DEPLOYMENT_BAND_FRACTION = 0.12;

/**
 * How much wider than the hull a berth has to be, as a multiple of the clearance diameter.
 *
 * A boat parked in a passage exactly its own width cannot turn and cannot be ordered anywhere
 * without immediately grazing rock, which would read as the game starting you stuck.
 */
export const BERTH_CLEARANCE_FACTOR = 1.6;

/** Sampling step for candidate berths, metres. Fine enough to find a slot, coarse enough to be quick. */
const BERTH_STEP = 25;

/**
 * Clearance that counts as water at all, metres. Rock measures zero, so a search that asks
 * for nothing would happily return a point inside it.
 */
const ANY_WATER = 1;

/**
 * The shallowest a boat is berthed, as a fraction of game depth. The surface is loud and it is
 * a hard boundary (planning/04 §6), so nothing starts pressed against it.
 */
const SHALLOWEST_BERTH = 0.1;

/**
 * How much shallower than its test depth a boat is berthed, in metres of game depth.
 *
 * Parking exactly on the line would be legal — the hull groans *past* test depth, not at it —
 * but it leaves the player nothing: the first order that noses the boat down starts it making
 * noise before it has gone anywhere. A few metres in hand costs nothing, and makes the margin
 * theirs to spend rather than the deployer's to have already spent.
 */
const TEST_DEPTH_MARGIN = 10;

/**
 * The deepest a boat of these stats may be berthed, in metres of game depth.
 *
 * Test depth is where the hull starts to groan, and that groan is a noise the enemy can hear
 * (`content/acoustics.ts` adds `hullStressPenalty` past it). A boat that begins the match
 * already below it is broadcasting before its owner has given a single order — the one bad
 * start state a player can do nothing about, because they did not choose it.
 *
 * Test depth is resolved per boat rather than per hull: a pressure-hull module moves it, and a
 * fitted boat has earned the deeper berth its owner paid for.
 */
function deepestBerth(testDepth: number): number {
  return Math.max(MAP_DEPTH * SHALLOWEST_BERTH, testDepth - TEST_DEPTH_MARGIN);
}

/**
 * How far apart boats prefer to sit, as a multiple of the two hulls' clearance radii. Relaxed
 * when the band cannot honour it — a crowded start is better than a refused one.
 */
const SEPARATION_FACTOR = 3;

/** The relaxation ladder for separation, tried in order until a berth is found. */
const SEPARATION_STEPS: readonly number[] = [1, 0.6, 0.3, 0];

/** Capture zone radius on the base map, scaled with the arena (planning/06 §2.2). */
export const BASE_CAPTURE_RADIUS = 400;

/**
 * Where the three capture zones sit, as fractions of width and of game depth.
 *
 * **Mirror-symmetric about mid-map, deliberately.** planning/14 §3 invariant I6 makes zone
 * placement the generator's job, and it will place them by region — a shallow Open Column, a
 * deep Cathedral, a mid-depth Choke (06 §2.2). Until it does, the one property that must not
 * be got wrong is fairness: whatever the layout, neither end may have the easier half. A deep
 * centre flanked by two shallow zones is symmetric, legible, and honest about being interim.
 */
const ZONE_LAYOUT: readonly {
  readonly label: string;
  readonly x: number;
  readonly depth: number;
}[] = [
  { label: 'WEST', x: 0.25, depth: 0.25 },
  { label: 'CENTRE', x: 0.5, depth: 0.8 },
  { label: 'EAST', x: 0.75, depth: 0.25 },
];

// ── Inputs ──────────────────────────────────────────────────────────────────────────

/** One lobby member, with whatever fleet they brought. Spectators bring none. */
export interface DeployingPlayer {
  readonly accountId: AccountId;
  readonly username: string;
  readonly position: LobbyPosition;
  /** The boats of their selected fleet, in fleet order. Empty for a spectator. */
  readonly boats: readonly BoatTemplate[];
}

export interface DeployOptions {
  readonly matchId: MatchId;
  readonly mode: GameMode;
  readonly map: GeneratedMap;
  /** Epoch ms. Injected rather than read from a clock, so this stays pure. */
  readonly startedAt: number;
  readonly players: readonly DeployingPlayer[];
  readonly scoreTarget?: number;
}

// ── Deployment bands ────────────────────────────────────────────────────────────────

/** A vertical slab at one end of the map, the full water column deep (planning/06 §1). */
export interface DeploymentBand {
  readonly team: TeamId;
  readonly x0: number;
  readonly x1: number;
}

/** Team 1 starts in the west, team 2 in the east. Equal bands, so neither has more room. */
export function deploymentBands(extents: MapExtents): Readonly<Record<TeamId, DeploymentBand>> {
  const bandWidth = extents.width * DEPLOYMENT_BAND_FRACTION;
  return {
    team1: { team: 'team1', x0: 0, x1: bandWidth },
    team2: { team: 'team2', x0: extents.width - bandWidth, x1: extents.width },
  };
}

/** Which way a team's boats point at the start: toward the rest of the map. */
export function startingFacing(team: TeamId): number {
  return team === 'team1' ? 0 : 180;
}

// ── Deployment ──────────────────────────────────────────────────────────────────────

/**
 * Build the initial state of a match: fleets on the map, standings at zero, clock at 0:00.
 *
 * Entity ids are handed out in roster order — every player's boats in the order they were
 * built, players in the order the lobby lists them — so two servers given the same lobby mint
 * the same ids. Anything less makes a replay's command log meaningless.
 */
export function deployMatch(options: DeployOptions): MatchState {
  const { map, players } = options;
  const ruler = new TerrainRuler(map.extents, map.terrain.obstacles);
  const bands = deploymentBands(map.extents);

  const matchPlayers: MatchPlayer[] = players.map((player) => ({
    accountId: player.accountId,
    username: player.username,
    team: teamOf(player.position),
    connected: true,
  }));

  const boats: BoatState[] = [];
  let nextId: EntityId = 1;

  for (const team of TEAM_IDS) {
    const roster = players.filter((player) => teamOf(player.position) === team);
    // Every boat on the side, flattened before placement, so berths are spread across the
    // whole team rather than each player's fleet being stacked on the last one's.
    const pending = roster.flatMap((player) =>
      player.boats.map((template, index) => ({ player, template, index })),
    );

    const placed: { readonly pos: Vec2; readonly radius: number }[] = [];

    pending.forEach((entry, ordinal) => {
      const resolved = resolveBoat(entry.template);
      const radius = getHull(entry.template.hull).clearanceRadius;
      const pos = findBerth({
        ruler,
        extents: map.extents,
        band: bands[team],
        radius,
        // Spread the team down the water column: boat k of n aims at the k-th of n equal
        // depth slices, so a fleet starts stacked across strata rather than in a huddle.
        target: berthTarget(
          map.extents,
          bands[team],
          ordinal,
          pending.length,
          resolved.current.testDepth,
        ),
        // Y, not depth, because the search works in map coordinates. `depthScale` is what
        // makes the two comparable, and it differs by map size: the same Y is a different
        // depth on a small map than on a large one.
        minY: yAt(map.extents, deepestBerth(resolved.current.testDepth)),
        placed,
      });
      placed.push({ pos, radius });

      boats.push({
        id: nextId++,
        team,
        owner: entry.player.accountId,
        index: entry.index,
        name: entry.template.name,
        hull: entry.template.hull,
        stats: resolved.current,
        cost: resolved.cost,
        pos,
        facing: startingFacing(team),
        // Stopped, and told to stay that way. A boat that began under way would be making
        // noise before its owner had looked at the map.
        speed: 0,
        throttle: 'stop',
        hp: resolved.current.maxHp,
        tubes: startingTubes(resolved.current.torpedoTubes),
        order: HOLDING,
        status: 'active',
        // Passive, like the throttle is stopped. A fleet that deployed pinging would announce
        // both sides' positions before either player had looked at the map.
        activeSonar: false,
        lastPingTick: 0,
      });
    });
  }

  const zones = options.mode === 'objective-capture' ? placeZones(map, ruler) : [];

  return {
    matchId: options.matchId,
    mode: options.mode,
    // Deployment is skipped: the server has already placed the boats. See the file header.
    phase: 'active',
    map,
    startedAt: options.startedAt,
    clock: startingClock(),
    scoreTarget: options.scoreTarget ?? DEFAULT_SCORE_TARGET,
    players: matchPlayers,
    teams: {
      team1: standingFor('team1', boats, { score: 0, secondsDetected: 0 }),
      team2: standingFor('team2', boats, { score: 0, secondsDetected: 0 }),
    },
    boats,
    zones,
  };
}

/** Every tube loaded, with the variant the editor cannot choose yet (see `DEFAULT_WEAPON`). */
function startingTubes(count: number): readonly TubeState[] {
  const tubes: TubeState[] = [];
  for (let index = 0; index < Math.max(0, Math.round(count)); index += 1) {
    tubes.push({ index, weapon: DEFAULT_WEAPON, status: 'loaded', readyInSeconds: 0 });
  }
  return tubes;
}

/**
 * The depth slice boat `ordinal` of `count` aims for, at the middle of its team's band.
 *
 * Spread across the boat's *legal* column rather than the map's whole one. Test depths sit
 * around a third of `MAP_DEPTH`, so a spread that still aimed at the seabed would put most of
 * the fleet below the limit and the search would pull all of them back to the same line —
 * stacking the fleet on it instead of spreading them at all.
 */
function berthTarget(
  extents: MapExtents,
  band: DeploymentBand,
  ordinal: number,
  count: number,
  testDepth: number,
): Vec2 {
  const share = (ordinal + 0.5) / Math.max(1, count);
  const shallowest = MAP_DEPTH * SHALLOWEST_BERTH;
  const deepest = deepestBerth(testDepth);

  return {
    x: (band.x0 + band.x1) / 2,
    y: yAt(extents, shallowest + (deepest - shallowest) * share),
  };
}

interface BerthSearch {
  readonly ruler: TerrainRuler;
  readonly extents: MapExtents;
  readonly band: DeploymentBand;
  readonly radius: number;
  readonly target: Vec2;
  /**
   * The lowest Y a berth may take. The frame is y-up (`map/types.ts`) while depth counts down
   * from the surface, so the boat's depth limit is a *floor* on Y, not a ceiling.
   */
  readonly minY: number;
  readonly placed: readonly { readonly pos: Vec2; readonly radius: number }[];
}

/**
 * The berth nearest a boat's target depth that its hull actually fits in, and that is never
 * below its test depth.
 *
 * Separation is relaxed in steps before it is abandoned, and clearance is abandoned last of
 * all: ten Heavies in a small map's deployment band genuinely cannot all have room, and the
 * honest failure is a crowded start rather than a refused match or a boat inside a wall.
 *
 * **The depth limit is not on that ladder.** Every step of the search is bounded by `minY`,
 * including the fallbacks, so there is no relaxation that trades it away — a crowded berth is
 * recoverable by moving, and a berth below test depth is not recoverable at all, because the
 * boat is already making the noise by the time the player sees the map.
 */
function findBerth(search: BerthSearch): Vec2 {
  const needed = search.radius * 2 * BERTH_CLEARANCE_FACTOR;

  for (const relaxation of SEPARATION_STEPS) {
    const berth = scanBand(search, needed, relaxation);
    if (berth !== null) return berth;
  }
  // No slot wide enough in the legal column. Take the nearest point to the target that is
  // water at all — asking for zero clearance would accept rock, which measures zero too.
  return (
    scanBand(search, ANY_WATER, 0) ?? {
      x: (search.band.x0 + search.band.x1) / 2,
      y: search.target.y,
    }
  );
}

/**
 * The candidate closest to the target that clears `needed` and keeps its distance from what
 * is already placed. Ties break on the lower-left point, so the scan order does not decide.
 */
function scanBand(search: BerthSearch, needed: number, relaxation: number): Vec2 | null {
  const { ruler, extents, band, target, placed, minY } = search;
  let best: Vec2 | null = null;
  let bestScore = Infinity;

  for (let x = band.x0 + BERTH_STEP / 2; x < band.x1; x += BERTH_STEP) {
    for (let y = BERTH_STEP / 2; y < extents.height; y += BERTH_STEP) {
      // Filtered rather than clipping the loop bound, so every boat is scored against the
      // same candidate lattice whatever its depth limit — two hulls with different test
      // depths agree about where a berth is, and only about which ones they may take.
      if (y < minY) continue;
      if (ruler.clearanceAt(x, y) < needed) continue;

      let blocked = false;
      for (const other of placed) {
        const wanted = (search.radius + other.radius) * SEPARATION_FACTOR * relaxation;
        if (distance({ x, y }, other.pos) < wanted) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      const score = distance({ x, y }, target);
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }

  return best;
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── Objectives ──────────────────────────────────────────────────────────────────────

/**
 * The three capture zones, snapped to water.
 *
 * A zone centred inside rock would be uncapturable, so each nominal centre is nudged to the
 * nearest sampled point with room to sit in. `ZONE_LAYOUT` explains why they sit where they
 * do, and why that is temporary.
 */
export function placeZones(map: GeneratedMap, ruler: TerrainRuler): readonly CaptureZone[] {
  const { extents } = map;
  const radius = BASE_CAPTURE_RADIUS * (extents.height / BASE_MAP_HEIGHT);

  return ZONE_LAYOUT.map((zone, index) => ({
    id: ZONE_ID_BASE + index,
    label: zone.label,
    centre: waterNear(ruler, extents, {
      x: extents.width * zone.x,
      y: yAt(extents, MAP_DEPTH * zone.depth),
    }),
    radius,
    holder: null,
    progress: 0,
    contested: false,
  }));
}

/**
 * Zone ids start well above the boats' so the two are distinguishable at a glance in a log.
 * They share the `EntityId` space because a zone is an entity (planning/04 §4) — its beacon
 * pings, and that makes it something the acoustic model has to be able to name.
 */
const ZONE_ID_BASE = 1000;

/**
 * How much room a zone's centre wants, in descending order of preference: comfortably more
 * than the widest hull, then merely open water, then wherever the layout asked for.
 */
const ZONE_CLEARANCES: readonly number[] = [240, 120, 1];

/** The sampled point nearest `target` with room to hold a zone; `target` if there is none. */
function waterNear(ruler: TerrainRuler, extents: MapExtents, target: Vec2): Vec2 {
  for (const needed of ZONE_CLEARANCES) {
    if (ruler.clearanceAt(target.x, target.y) >= needed) return target;

    let best: Vec2 | null = null;
    let bestScore = Infinity;
    for (let x = BERTH_STEP / 2; x < extents.width; x += BERTH_STEP) {
      for (let y = BERTH_STEP / 2; y < extents.height; y += BERTH_STEP) {
        if (ruler.clearanceAt(x, y) < needed) continue;
        const score = distance({ x, y }, target);
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    if (best !== null) return best;
  }
  return target;
}
