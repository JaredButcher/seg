/**
 * Objective Capture: where a zone may appear, and what it takes to take one.
 *
 * Two families of property, and they fail in opposite ways. **Placement** is asserted over many
 * seeds and every map size, because a zone half inside a wall or sitting in a deployment band is
 * a match decided by the generator rather than by the players, and it would look like a bad map
 * rather than like a bug. **Capture** is asserted by driving ticks by hand, because every rule
 * in it is a rule about *time* — thirty seconds of it, lost or held or frozen — and the only
 * honest way to test that is to spend the ticks.
 */

import {
  ARMING_SECONDS,
  CAPTURE_SECONDS,
  MAP_SIZES,
  MAX_DEEP_OBJECTIVES,
  OBJECTIVE_COUNT,
  OBJECTIVE_MAX_DEPTH,
  OBJECTIVE_RADIUS,
  SIM_TICK_SECONDS,
  advanceZones,
  depthAt,
  deployMatch,
  generateMap,
  initialLayoutRng,
  isDeepZone,
  objectiveBand,
  objectiveRuler,
  respawnRng,
  spawnZone,
  spawnZones,
  vacantLabels,
  withinZone,
  yAt,
  zoneLabel,
  type BoatState,
  type BoatTemplate,
  type CaptureZone,
  type DeployingPlayer,
  type GeneratedMap,
  type TeamId,
  type Vec2,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const LIGHT: BoatTemplate = { name: 'S-01', hull: 'light', modules: [] };

function player(accountId: string, position: DeployingPlayer['position']): DeployingPlayer {
  return { accountId, username: accountId, position, boats: [LIGHT] };
}

/** A match's worth of state, only ever read for its boats — a template to move around. */
const TEMPLATE = deployMatch({
  matchId: 'm1',
  mode: 'objective-capture',
  map: generateMap('empty', { seed: 3, mapSize: 'medium' }),
  startedAt: 0,
  players: [player('host', 'team1'), player('foe', 'team2')],
});

/** One boat of `team`, parked at `pos`. The only two fields any capture rule reads. */
function boatAt(team: TeamId, pos: Vec2, status: BoatState['status'] = 'active'): BoatState {
  const base = TEMPLATE.boats.find((boat) => boat.team === team);
  if (base === undefined) throw new Error('fixture has no boat for that team');
  return { ...base, pos, status };
}

/** One zone at the origin-ish, open for capture, with whatever else the test needs set. */
function zone(overrides: Partial<CaptureZone> = {}): CaptureZone {
  return {
    id: 1000,
    label: zoneLabel(0),
    centre: { x: 5000, y: 2000 },
    radius: OBJECTIVE_RADIUS,
    armingTicks: 0,
    capturing: null,
    progress: 0,
    contested: false,
    ...overrides,
  };
}

/**
 * Run `seconds` of ticks with a fixed fleet, returning the zone and everything captured.
 *
 * Deliberately not a single call with a big `tickSeconds`: the rules are per tick and a test
 * that took one giant step would pass over exactly the accumulation it is checking.
 */
function run(
  start: CaptureZone,
  boats: readonly BoatState[],
  seconds: number,
): { readonly zone: CaptureZone; readonly captures: number } {
  let zones: readonly CaptureZone[] = [start];
  let captures = 0;
  const ticks = Math.round(seconds / SIM_TICK_SECONDS);

  for (let tick = 0; tick < ticks; tick += 1) {
    const advance = advanceZones(zones, boats, SIM_TICK_SECONDS);
    captures += advance.captures.length;
    // The runtime replaces a captured zone on the tick it falls; here the test simply stops
    // counting it, which is the same thing for the purposes of "how many points was that".
    zones = advance.captures.length > 0 ? [start] : advance.zones;
  }

  const settled = zones[0];
  if (settled === undefined) throw new Error('lost the zone');
  return { zone: settled, captures };
}

describe('objective placement', () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

  /**
   * Generating four dozen cave maps and rasterizing each of them is seconds of real work, not
   * a hung test. Stated rather than left to the default, the same way `map-caves.test.ts`
   * states it, so a genuine hang is still caught.
   */
  const SWEEP_TIMEOUT = 60_000;

  it(
    'puts every zone in open water, in the middle third, clear of the others',
    () => {
      for (const size of MAP_SIZES) {
        for (const type of ['sparse', 'dense'] as const) {
          for (const seed of SEEDS) {
            const map: GeneratedMap = generateMap(type, { seed, mapSize: size });
            const ruler = objectiveRuler(map);
            const zones = spawnZones(map, ruler, initialLayoutRng(map.seed));
            const band = objectiveBand(map.extents);

            expect(zones).toHaveLength(OBJECTIVE_COUNT);
            for (const placed of zones) {
              expect(placed.radius).toBe(OBJECTIVE_RADIUS);
              // The middle third, so neither deployment band is nearer to any objective than
              // the other is — the fairness the random placement cannot be trusted with itself.
              expect(placed.centre.x).toBeGreaterThanOrEqual(band.x0);
              expect(placed.centre.x).toBeLessThanOrEqual(band.x1);
              // And never below the depth ceiling. The seabed is out of reach of every hull in
              // the game, so a zone down there would be uncontestable rather than merely hard —
              // asserted in *depth* rather than in Y, because that is the frame the rule is
              // written in and the two run in opposite directions.
              expect(depthAt(map.extents, placed.centre.y)).toBeLessThanOrEqual(
                OBJECTIVE_MAX_DEPTH,
              );
              // Twice the radius of room is the whole circle in water, not merely its centre.
              expect(ruler.clearanceAt(placed.centre.x, placed.centre.y)).toBeGreaterThanOrEqual(
                OBJECTIVE_RADIUS * 2,
              );
            }

            // No two overlap: centres at least a diameter apart is two circles that touch at
            // most. This is the rule a player would notice being broken before any other.
            for (let a = 0; a < zones.length; a += 1) {
              for (let b = a + 1; b < zones.length; b += 1) {
                const one = zones[a];
                const other = zones[b];
                if (one === undefined || other === undefined) continue;
                const gap = Math.hypot(
                  one.centre.x - other.centre.x,
                  one.centre.y - other.centre.y,
                );
                expect(gap).toBeGreaterThanOrEqual(OBJECTIVE_RADIUS * 2);
              }
            }
          }
        }
      }
    },
    SWEEP_TIMEOUT,
  );

  it('draws a replacement somewhere else, clear of what is still standing', () => {
    const map = generateMap('dense', { seed: 11, mapSize: 'medium' });
    const ruler = objectiveRuler(map);
    const rng = respawnRng(map.seed);
    const standing = spawnZones(map, ruler, initialLayoutRng(map.seed));
    const [taken, ...rest] = standing;
    if (taken === undefined) throw new Error('no zone to take');

    const replacement = spawnZone({
      ruler,
      extents: map.extents,
      rng,
      id: 2000,
      label: taken.label,
      standing: rest,
      clearOf: [taken.centre],
      armingTicks: Math.round(ARMING_SECONDS * 20),
    });
    if (replacement === null) throw new Error('this map has room and the spawner should find it');

    // Its slot's name, a new identity, and a minute of grey before it is worth anything.
    expect(replacement.label).toBe(taken.label);
    expect(replacement.id).not.toBe(taken.id);
    expect(replacement.armingTicks).toBe(Math.round(ARMING_SECONDS * 20));
    // A replacement answers to the depth ceiling too — it is the same spawner, and a rule that
    // held only for the opening three would fail for the first time twenty minutes into a match.
    expect(depthAt(map.extents, replacement.centre.y)).toBeLessThanOrEqual(OBJECTIVE_MAX_DEPTH);

    for (const other of [taken, ...rest]) {
      const gap = Math.hypot(
        replacement.centre.x - other.centre.x,
        replacement.centre.y - other.centre.y,
      );
      expect(gap).toBeGreaterThanOrEqual(OBJECTIVE_RADIUS * 2);
    }
  });

  it('never puts a second objective in the deep water', () => {
    // One deep zone is a question about fleet composition; two is a verdict, because a side
    // that brought no pressure hulls is then playing for one objective out of three.
    for (const size of MAP_SIZES) {
      for (const seed of SEEDS) {
        const map = generateMap('dense', { seed, mapSize: size });
        const zones = spawnZones(map, objectiveRuler(map), initialLayoutRng(map.seed));
        const deep = zones.filter((zone) => isDeepZone(map.extents, zone.centre));
        expect(deep.length).toBeLessThanOrEqual(MAX_DEEP_OBJECTIVES);
      }
    }
  });

  it('refuses to spawn at all rather than break a rule', () => {
    const map = generateMap('empty', { seed: 5, mapSize: 'medium' });
    const ruler = objectiveRuler(map);
    const rng = respawnRng(map.seed);

    // A radius wider than the band it has to fit inside. Nothing legal exists, and the honest
    // answer is no zone — the alternative is a circle somewhere the rules said it must not be.
    expect(
      spawnZone({
        ruler,
        extents: map.extents,
        rng,
        id: 9000,
        label: 'OBJ 1',
        standing: [],
        armingTicks: 0,
        radius: map.extents.width,
      }),
    ).toBeNull();

    // The deep quota is enforced the same way rather than relaxed. With one deep zone already
    // standing, on a map that is nothing but open water, every draw comes back shallow — the
    // spawner had thousands of deep candidates available and took none of them.
    const alreadyDeep = zone({
      centre: { x: map.extents.width / 2, y: yAt(map.extents, 700) },
    });
    expect(isDeepZone(map.extents, alreadyDeep.centre)).toBe(true);

    for (let draw = 0; draw < 20; draw += 1) {
      const next = spawnZone({
        ruler,
        extents: map.extents,
        rng,
        id: 9100 + draw,
        label: 'OBJ 2',
        standing: [alreadyDeep],
        armingTicks: 0,
      });
      if (next === null) throw new Error('open water has shallow room');
      expect(isDeepZone(map.extents, next.centre)).toBe(false);
    }
  });

  it('reports the slots it could not fill, so they can be tried again later', () => {
    const map = generateMap('empty', { seed: 5, mapSize: 'medium' });
    const zones = spawnZones(map, objectiveRuler(map), initialLayoutRng(map.seed));

    // Open water has room for all three, so nothing is owed.
    expect(zones).toHaveLength(OBJECTIVE_COUNT);
    expect(vacantLabels(zones)).toEqual([]);

    // Take the middle one off the board and the vacancy is named by its label, not by an index —
    // which is what lets a replacement inherit the slot it is replacing.
    const short = zones.filter((zone) => zone.label !== 'OBJ 2');
    expect(vacantLabels(short)).toEqual(['OBJ 2']);
    expect(vacantLabels([])).toEqual(['OBJ 1', 'OBJ 2', 'OBJ 3']);
  });

  it('places from a seeded stream, and the respawns from a different one', () => {
    const map = generateMap('dense', { seed: 12, mapSize: 'small' });
    const ruler = objectiveRuler(map);

    // Same seed, same layout — the property replays depend on (planning/04 §9).
    expect(spawnZones(map, ruler, initialLayoutRng(map.seed))).toEqual(
      spawnZones(map, ruler, initialLayoutRng(map.seed)),
    );
    // And the respawn fork is genuinely a different stream, or adding a zone to the opening
    // layout would shift every replacement for the rest of the match.
    expect(spawnZones(map, ruler, respawnRng(map.seed))).not.toEqual(
      spawnZones(map, ruler, initialLayoutRng(map.seed)),
    );
  });
});

describe('capture', () => {
  const centre = { x: 5000, y: 2000 };
  const inside = { x: 5100, y: 2000 };
  const outside = { x: 5000 + OBJECTIVE_RADIUS + 50, y: 2000 };

  it('draws the circle at the radius, edge included', () => {
    expect(withinZone(zone(), inside)).toBe(true);
    expect(withinZone(zone(), outside)).toBe(false);
    expect(withinZone(zone(), { x: centre.x + OBJECTIVE_RADIUS, y: centre.y })).toBe(true);
  });

  it('takes exactly thirty uncontested seconds, and pays one point', () => {
    const held = [boatAt('team1', inside)];

    // A second short is a second short: the rule is worth nothing until it is worth a point.
    const nearly = run(zone(), held, CAPTURE_SECONDS - 1);
    expect(nearly.captures).toBe(0);
    expect(nearly.zone.progress).toBeGreaterThan(0.9);
    expect(nearly.zone.capturing).toBe('team1');

    expect(run(zone(), held, CAPTURE_SECONDS).captures).toBe(1);
  });

  it('is no faster with a fleet than with one boat', () => {
    // The old design scaled progress with the boats inside; this one does not, so a deathball
    // buys survivability and nothing else (planning/06 §2.2 on diminishing returns, taken to
    // its limit). Worth pinning: it is the kind of rule a later change adds back by accident.
    const alone = run(zone(), [boatAt('team1', inside)], CAPTURE_SECONDS - 1);
    const crowd = run(
      zone(),
      [boatAt('team1', inside), boatAt('team1', centre), boatAt('team1', { x: 4900, y: 2050 })],
      CAPTURE_SECONDS - 1,
    );

    expect(crowd.zone.progress).toBeCloseTo(alone.zone.progress, 10);
  });

  it('loses everything when the last boat leaves', () => {
    const half = run(zone(), [boatAt('team1', inside)], CAPTURE_SECONDS / 2).zone;
    expect(half.progress).toBeGreaterThan(0.4);

    const abandoned = run(half, [boatAt('team1', outside)], SIM_TICK_SECONDS).zone;
    expect(abandoned.progress).toBe(0);
    expect(abandoned.capturing).toBeNull();
  });

  it('only pauses while an enemy contests it', () => {
    const half = run(zone(), [boatAt('team1', inside)], CAPTURE_SECONDS / 2).zone;

    const frozen = run(half, [boatAt('team1', inside), boatAt('team2', centre)], 60);
    expect(frozen.captures).toBe(0);
    expect(frozen.zone.contested).toBe(true);
    // Held, not drained: the interloper has to *stay*, and a minute of standing there has not
    // undone a second of the work.
    expect(frozen.zone.progress).toBeCloseTo(half.progress, 10);
    expect(frozen.zone.capturing).toBe('team1');

    // And it picks straight back up where it stopped when they leave.
    const resumed = run(frozen.zone, [boatAt('team1', inside)], CAPTURE_SECONDS / 2 + 1);
    expect(resumed.captures).toBe(1);
  });

  it('gives an enemy nothing of the progress they interrupted', () => {
    const half = run(zone(), [boatAt('team1', inside)], CAPTURE_SECONDS / 2).zone;

    // Team 1 leaves and team 2 walks in. Team 2 starts from zero, not from halfway.
    const stolen = run(half, [boatAt('team2', inside)], CAPTURE_SECONDS - 1);
    expect(stolen.captures).toBe(0);
    expect(stolen.zone.capturing).toBe('team2');
    expect(stolen.zone.progress).toBeLessThan(1);
  });

  it('counts neither a destroyed boat nor one that never entered', () => {
    const wreck = run(zone(), [boatAt('team1', inside, 'destroyed')], CAPTURE_SECONDS + 1);
    expect(wreck.captures).toBe(0);
    expect(wreck.zone.capturing).toBeNull();

    // A wreck does not contest either — a hull on the bottom is not holding a point.
    const uncontested = run(
      zone(),
      [boatAt('team1', inside), boatAt('team2', centre, 'destroyed')],
      CAPTURE_SECONDS,
    );
    expect(uncontested.captures).toBe(1);
  });

  it('counts nothing at all while it is still arming', () => {
    const arming = zone({ armingTicks: Math.round(ARMING_SECONDS / SIM_TICK_SECONDS) });
    const held = [boatAt('team1', inside)];

    // Sat on for the whole minute: it arms, and only then does the clock start.
    const waited = run(arming, held, ARMING_SECONDS);
    expect(waited.captures).toBe(0);
    expect(waited.zone.progress).toBe(0);
    expect(waited.zone.armingTicks).toBe(0);

    expect(run(waited.zone, held, CAPTURE_SECONDS).captures).toBe(1);
  });

  it('hands back the same array when nothing happened', () => {
    // The identity the runtime tests against before it recomputes the standings.
    const zones = [zone()];
    expect(advanceZones(zones, [boatAt('team1', outside)], SIM_TICK_SECONDS).zones).toBe(zones);
    expect(advanceZones([], [], SIM_TICK_SECONDS).zones).toEqual([]);
  });
});
