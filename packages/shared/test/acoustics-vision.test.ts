/**
 * The vision system end to end: boats in water, and the square metres their crews are shown.
 *
 * planning/13 §2 asks for the widest valuable layer to be scenario tests rather than unit
 * tests, and this is that layer for acoustics. Every assertion below is a statement about the
 * *game* — how far you can see, what hides you, what blinds you — rather than about a
 * function, because those are the properties a tuning change silently breaks.
 *
 * The terrain is hand-built for the same reason it is in the propagation suite: a wall with a
 * door in it has an answer that can be reasoned about, and a procedural cave does not.
 *
 * Every scene sits at `LEVEL`, which is 300 m of game depth — above every hull's test depth,
 * so the hull-stress term is not quietly adding six decibels to numbers that are supposed to
 * be about range.
 */

import {
  ACOUSTICS,
  AcousticSolver,
  applyModifiers,
  boatEntity,
  emittedLevels,
  generateMap,
  getHull,
  MODULES,
  resolveExtents,
  SIM_TICK_HZ,
  visionCellCentre,
  VISION_CELL_SIZE,
  type AcousticEntity,
  type AcousticTuning,
  type BoatState,
  type GeneratedMap,
  type HullId,
  type MapExtents,
  type Obstacle,
  type TeamId,
} from '@seg/shared';
import { describe, expect, it } from 'vitest';

const EXTENTS: MapExtents = { width: 5000, height: 2000 };
/** Game depth per metre of y, so `LEVEL` is 300 m down. planning/14 §1.2. */
const DEPTH_SCALE = 1200 / EXTENTS.height;
const LEVEL = EXTENTS.height * 0.75;

function world(obstacles: readonly Obstacle[] = []): GeneratedMap {
  return {
    generatorVersion: 1,
    seed: 1,
    mapType: 'empty',
    mapSize: 'medium',
    extents: EXTENTS,
    depthScale: DEPTH_SCALE,
    terrain: { obstacles },
  };
}

function block(x0: number, y0: number, x1: number, y1: number): Obstacle {
  return {
    vertices: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  };
}

interface BoatSpec {
  readonly id: number;
  readonly team: TeamId;
  readonly hull?: HullId;
  readonly x: number;
  readonly y?: number;
  readonly speed?: number;
  readonly modules?: readonly (keyof typeof MODULES)[];
}

function boat(spec: BoatSpec): BoatState {
  const hull = getHull(spec.hull ?? 'medium');
  const modifiers = (spec.modules ?? []).flatMap((id) => MODULES[id].modifiers);
  return {
    id: spec.id,
    team: spec.team,
    owner: `p${spec.team}`,
    index: 0,
    name: `S-0${spec.id}`,
    hull: hull.id,
    stats: applyModifiers(hull.stats, modifiers),
    cost: hull.cost,
    weaponSubstitutions: {},
    moduleModifiers: [],
    pos: { x: spec.x, y: spec.y ?? LEVEL },
    facing: 0,
    speed: spec.speed ?? 0,
    throttle: 'slow',
    hp: hull.stats.maxHp,
    tubes: [],
    order: { kind: 'hold' },
    status: 'active',
    activeSonar: false,
    lastPingTick: 0,
    transients: [],
  };
}

function entities(specs: readonly BoatSpec[]): AcousticEntity[] {
  return specs.map((spec) => boatEntity(boat(spec), EXTENTS));
}

/**
 * A boat with its machinery genuinely secured — no radiated noise at all, so the only way to
 * find it is to light it up. Built by hand rather than through a throttle setting, because a
 * hull's rest source level is a floor no throttle goes under.
 */
function mute(spec: BoatSpec): AcousticEntity {
  return {
    ...boatEntity(boat(spec), EXTENTS),
    sourceLevel: -Infinity,
    // Both, and `-Infinity` in both: what deafens is a *part* of the source level, so a boat that
    // radiates nothing deafens nobody. Leaving this at the real hull's figure would be a silent
    // boat that still raised everyone's floor.
    deafeningLevel: -Infinity,
  };
}

interface Picture {
  readonly count: number;
  readonly best: number;
  readonly cells: Int32Array;
  readonly excess: Float32Array;
}

function read(solver: AcousticSolver, list: readonly AcousticEntity[], team: TeamId): Picture {
  const seen = solver.solve(list).vision.find((v) => v.team === team);
  return {
    count: seen?.cells.length ?? 0,
    best: seen === undefined || seen.excess.length === 0 ? -Infinity : Math.max(...seen.excess),
    cells: seen?.cells ?? new Int32Array(0),
    excess: seen?.excess ?? new Float32Array(0),
  };
}

function picture(solver: AcousticSolver, specs: readonly BoatSpec[], team: TeamId): Picture {
  return read(solver, entities(specs), team);
}

/** Squares within 90 m of an x, which is how a hull's own returns are picked out of a picture. */
function around(solver: AcousticSolver, cells: Int32Array, x: number): number[] {
  return [...cells].filter((c) => Math.abs(visionCellCentre(solver.grid, c).x - x) < 90);
}

const CREEP = getHull('medium').stats.maxSpeed * 0.2;
const FLANK = getHull('medium').stats.maxSpeed;

describe('seeing a boat by the noise it makes', () => {
  const solver = new AcousticSolver(world());

  it('draws the hull, not a dot — the picture is squares of surface', () => {
    const seen = picture(
      solver,
      [
        { id: 1, team: 'team1', x: 1500 },
        { id: 2, team: 'team2', x: 1700, speed: CREEP },
      ],
      'team1',
    );

    // A Medium is 140 m long, so its outline is a few hundred metres of perimeter — and that
    // many metres divided by the square size is how many squares of skin it can return from.
    // Stated against the knob rather than in raw counts: retuning the resolution is allowed to
    // change how many squares a hull is drawn with, but not to collapse it to a dot.
    expect(seen.count).toBeGreaterThan(200 / VISION_CELL_SIZE);
    expect(seen.count).toBeLessThan(600 / VISION_CELL_SIZE);

    // And all of it is where that boat is, not where the listener is.
    for (const cell of seen.cells) {
      const p = visionCellCentre(solver.grid, cell);
      expect(Math.abs(p.x - 1700)).toBeLessThan(120);
      expect(Math.abs(p.y - LEVEL)).toBeLessThan(60);
    }
  });

  it('never shows a boat its own hull', () => {
    const seen = picture(solver, [{ id: 1, team: 'team1', x: 1500, speed: FLANK }], 'team1');
    expect(seen.count).toBe(0);
  });

  it('fades with range and then stops', () => {
    const at = (gap: number) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 1000 },
          { id: 2, team: 'team2', x: 1000 + gap, speed: CREEP },
        ],
        'team1',
      );

    const near = at(200);
    const mid = at(600);
    const far = at(3000);

    expect(near.best).toBeGreaterThan(mid.best);
    expect(mid.best).toBeGreaterThan(0);
    expect(far.count).toBe(0);
  });

  it('reaches roughly the ranges planning/03 §9 asks for', () => {
    // Not exact figures — that table is placeholders and says so. What is asserted is the
    // *ordering* and the rough scale, which is the design intent that has to survive tuning.
    const heard = (hull: HullId, speed: number, gap: number) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 300 },
          { id: 2, team: 'team2', hull, x: 300 + gap, speed },
        ],
        'team1',
      ).count > 0;

    const creep = (hull: HullId) => getHull(hull).stats.maxSpeed * 0.2;

    // A creeping Light can sit a few hundred metres off and not be found.
    expect(heard('light', creep('light'), 300)).toBe(true);
    expect(heard('light', creep('light'), 900)).toBe(false);
    // A creeping Medium is heard further, being a bigger and louder boat.
    expect(heard('medium', creep('medium'), 500)).toBe(true);
    expect(heard('medium', creep('medium'), 1200)).toBe(false);
    // A cavitating Heavy is audible across most of the map. Cavitation is a disaster.
    expect(heard('heavy', getHull('heavy').stats.maxSpeed, 3000)).toBe(true);
  });

  it('is quieter deep, where the screw has stopped cavitating', () => {
    // Same speed and the same 1600 m of water either way. Only the depth changes, and with it
    // whether the propeller is screaming.
    const speed = getHull('medium').stats.cavitationSpeed * 1.4;
    const at = (y: number) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 1000, y },
          { id: 2, team: 'team2', x: 2600, y, speed },
        ],
        'team1',
      );

    expect(at(EXTENTS.height * 0.9).count).toBeGreaterThan(0);
    expect(at(EXTENTS.height * 0.1).count).toBe(0);
  });

  it('deafens a listener that is going fast', () => {
    const at = (ownSpeed: number) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 1000, speed: ownSpeed },
          { id: 2, team: 'team2', x: 1600, speed: CREEP },
        ],
        'team1',
      );

    expect(at(0).count).toBeGreaterThan(0);
    expect(at(FLANK).count).toBe(0);
  });

  it('hears further with better hydrophones', () => {
    const at = (modules: readonly (keyof typeof MODULES)[]) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 1000, modules },
          { id: 2, team: 'team2', x: 1900, speed: CREEP },
        ],
        'team1',
      );

    expect(at([]).count).toBe(0);
    expect(at(['improved-hydrophones', 'towed-array']).count).toBeGreaterThan(0);
  });

  it('hides a boat that has secured its machinery', () => {
    const at = (modules: readonly (keyof typeof MODULES)[]) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 1000 },
          { id: 2, team: 'team2', x: 1700, speed: CREEP, modules },
        ],
        'team1',
      );

    expect(at([]).count).toBeGreaterThan(0);
    expect(at(['silent-running-gear']).count).toBe(0);
  });
});

describe('terrain', () => {
  const pair: BoatSpec[] = [
    { id: 1, team: 'team1', x: 1800 },
    { id: 2, team: 'team2', x: 2400, speed: CREEP },
  ];

  it('breaks contact outright — the most reliable escape in the game', () => {
    const open = new AcousticSolver(world());
    const walled = new AcousticSolver(world([block(2050, 0, 2150, EXTENTS.height)]));

    expect(picture(open, pair, 'team1').count).toBeGreaterThan(0);
    expect(picture(walled, pair, 'team1').count).toBe(0);
  });

  it('leaks through a door, weaker than the straight line would be', () => {
    // The gap is three hundred metres below both boats, so the sound has to go down through it
    // and back up: about 850 m of water instead of 600, and eight decibels for the detour.
    const louder: BoatSpec[] = [
      { id: 1, team: 'team1', x: 1800 },
      { id: 2, team: 'team2', x: 2400, speed: getHull('medium').stats.maxSpeed * 0.6 },
    ];
    const open = new AcousticSolver(world());
    const doored = new AcousticSolver(
      world([block(2050, 0, 2150, 900), block(2050, 1200, 2150, EXTENTS.height)]),
    );

    const through = picture(doored, louder, 'team1');
    expect(through.count).toBeGreaterThan(0);
    expect(through.best).toBeLessThan(picture(open, louder, 'team1').best - 4);
  });

  it('lights up around a loud boat, so the rock says where it is', () => {
    const solver = new AcousticSolver(world([block(0, 0, EXTENTS.width, 300)]));
    const seen = picture(
      solver,
      [{ id: 1, team: 'team1', x: 2000, y: 500, speed: FLANK }],
      'team1',
    );

    // Its own hull is excluded, so every square here is rock — the floor beneath it.
    expect(seen.count).toBeGreaterThan(100);
    for (const cell of seen.cells) {
      const p = visionCellCentre(solver.grid, cell);
      expect(p.y).toBeLessThan(400);
      expect(Math.abs(p.x - 2000)).toBeLessThan(1200);
    }
  });

  it('shows a quiet boat nothing at all — you see by your own noise', () => {
    const solver = new AcousticSolver(world([block(0, 0, EXTENTS.width, 300)]));
    const seen = picture(solver, [{ id: 1, team: 'team1', x: 2000, y: 700, speed: 0 }], 'team1');
    expect(seen.count).toBe(0);
  });

  /**
   * Every rock square in a picture comes from water that carries rock (planning/16 §3.6).
   *
   * This is the licence for the first branch of the reflection pass. About 98% of the water a
   * listener sweeps holds neither a scrap of rock face nor a hull square, and the pass skips those
   * cells before computing anything, on the grounds that neither of the branches below could fire
   * for them. That is a claim about the *skin*, not about the arithmetic, so this is where it is
   * checked: if a square ever appeared from a lattice cell with an empty terrain span, the fast
   * path would be dropping work that mattered and this would catch it.
   */
  it('never reports a rock square from water that carries no rock', () => {
    const solver = new AcousticSolver(
      // Two separate walls, so the map has plenty of open water to sweep through as well as rock
      // to find — a fixture where the skip is doing real work rather than never firing.
      world([block(0, 0, EXTENTS.width, 300), block(1000, 1400, 1600, EXTENTS.height)]),
    );
    const seen = solver
      .solve(entities([{ id: 1, team: 'team1', x: 2000, y: 700, speed: FLANK }]))
      .vision.find((v) => v.team === 'team1');

    expect(seen).toBeDefined();
    expect(seen?.cells.length).toBeGreaterThan(100);

    for (let i = 0; i < (seen?.cells.length ?? 0); i += 1) {
      // `-1` is rock; anything else is a hull square and comes from the per-solve skin instead.
      if (seen?.owners[i] !== -1) continue;
      const centre = visionCellCentre(solver.grid, seen.cells[i]!);
      const cell = solver.lattice.waterIndexAt(centre.x, centre.y);
      const from = solver.terrain.starts[cell]!;
      const to = solver.terrain.starts[cell + 1]!;
      expect(to).toBeGreaterThan(from);
    }
  });
});

describe('your own noise is your searchlight', () => {
  const solver = new AcousticSolver(world());

  /** A stopped, silent boat 300 m away, and one of ours deciding how hard to look for it. */
  const hunt = (ownSpeed: number, modules: readonly (keyof typeof MODULES)[] = []) =>
    read(
      solver,
      [
        ...entities([{ id: 1, team: 'team1', x: 1000, speed: ownSpeed }]),
        mute({ id: 2, team: 'team2', x: 1300, modules }),
      ],
      'team1',
    );

  it('finds a boat that is making no noise at all, if you make enough of your own', () => {
    // Stopped: nothing is lighting it, so it does not exist as far as you are concerned.
    expect(hunt(0).count).toBe(0);
    // At flank your machinery floods the water and its hull comes back out of the dark —
    // which is also the moment everyone else knows exactly where you are.
    expect(hunt(FLANK).count).toBeGreaterThan(100);
  });

  it('is what an anechoic coating defends against', () => {
    const bare = hunt(FLANK);
    const coated = hunt(FLANK, ['anechoic-coating']);
    const swallowed = MODULES['anechoic-coating'].modifiers[0]?.value ?? 0;

    expect(coated.count).toBeGreaterThan(0);
    // Five decibels of target strength is five decibels off every square of the return.
    expect(bare.best - coated.best).toBeCloseTo(Math.abs(swallowed), 1);
  });

  it('does nothing about the racket you make yourself', () => {
    // A coating changes absorption, and a boat's own radiated noise is not a reflection — so
    // the direct return is untouched. This is the whole reason the two paths are kept apart.
    const at = (modules: readonly (keyof typeof MODULES)[]) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 1000 },
          { id: 2, team: 'team2', x: 1500, speed: CREEP, modules },
        ],
        'team1',
      );

    expect(at(['anechoic-coating']).best).toBeCloseTo(at([]).best, 5);
  });
});

/**
 * The heatmap, asked for in full.
 *
 * A solve only writes the heatmap where something reads it — rock, hulls, listeners — because that
 * is one or two per cent of the water and the rest was being computed for nobody (planning/16
 * §3.9). Reading it at an arbitrary point in the sea is a *debug* question, so these tests ask the
 * way the debug overlay asks: `{ everywhere: true }`. The values are the same either way; what
 * differs is only whether the cell was filled in at all.
 */
describe('the noise heatmap', () => {
  const solver = new AcousticSolver(world());
  const FULL = { everywhere: true } as const;

  it('is the quiet ocean where nothing is happening', () => {
    const out = solver.solve(
      entities([{ id: 1, team: 'team1', x: 200, speed: 0 }]),
      undefined,
      FULL,
    );
    expect(out.noise.levelAt(4800, LEVEL)).toBeCloseTo(ACOUSTICS.ambientNoise, 1);
  });

  it('falls away from a source', () => {
    const out = solver.solve(
      entities([{ id: 1, team: 'team1', x: 500, speed: FLANK }]),
      undefined,
      FULL,
    );
    const near = out.noise.levelAt(700, LEVEL);
    const mid = out.noise.levelAt(1500, LEVEL);
    const far = out.noise.levelAt(3000, LEVEL);

    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(ACOUSTICS.ambientNoise);
  });

  it('does not go through rock', () => {
    const walled = new AcousticSolver(world([block(1000, 0, 1200, EXTENTS.height)]));
    const out = walled.solve(
      entities([{ id: 1, team: 'team1', x: 800, speed: FLANK }]),
      undefined,
      FULL,
    );

    expect(out.noise.levelAt(900, LEVEL)).toBeGreaterThan(30);
    expect(out.noise.levelAt(1400, LEVEL)).toBeCloseTo(ACOUSTICS.ambientNoise, 1);
  });

  it('raises the bar for everyone listening in it', () => {
    const at = (extra: readonly BoatSpec[]) =>
      picture(
        solver,
        [
          { id: 1, team: 'team1', x: 1000 },
          { id: 2, team: 'team2', x: 1600, speed: CREEP },
          ...extra,
        ],
        'team1',
      );

    const target = (p: Picture) => around(solver, p.cells, 1600).length;

    expect(target(at([]))).toBeGreaterThan(0);
    // A teammate at flank alongside, drowning it out. Fleets get in each other's way.
    expect(target(at([{ id: 3, team: 'team1', x: 1150, speed: FLANK }]))).toBe(0);
  });
});

/**
 * Filterable sound — a ping a listener can hear *through*
 * (`content/acoustics.ts#filterableNoiseFraction`).
 *
 * The split the solve now carries is that a coherent tone lights the water and is heard directly
 * at full strength, but contributes only `filterableNoiseFraction` of its power to anyone's noise
 * floor. These are the two halves of that claim: the heatmap shows the pulse at full level while
 * the floor sees less of it, an enemy ping announces its boat without hiding a third, and the
 * pinger's own walls still light up.
 */
describe('filterable sound', () => {
  /** One pinging boat as the server feeds the solver: `boatEntity` fed by `emittedLevels`. */
  const pinger = (spec: BoatSpec): AcousticEntity => {
    const b = { ...boat(spec), activeSonar: true, lastPingTick: 10 };
    return boatEntity(b, EXTENTS, emittedLevels(b, 10, SIM_TICK_HZ), ACOUSTICS);
  };

  it('lights the water at full strength while the floor sees only a quarter of it', () => {
    // In full, because the point sampled below is open water with nothing in it to reflect — the
    // solve would not otherwise have written the cell (planning/16 §3.9).
    const out = new AcousticSolver(world()).solve(
      [pinger({ id: 1, team: 'team1', x: 2000 })],
      undefined,
      { everywhere: true },
    );
    const probe = { x: 2400, y: LEVEL }; // 400 m of water away

    const full = out.noise.levelAt(probe.x, probe.y);
    const background = out.noise.backgroundLevelAt(probe.x, probe.y);

    // A stopped Medium pinging is 116 dB at the reference range, so the pulse genuinely reaches
    // here. `filterableNoiseFraction` (0.25) is a 6 dB cut on what a listener has to hear through
    // — and the hull's own broadband (48 dB) is far too quiet at this range to muddy the diff.
    expect(full).toBeGreaterThan(80);
    expect(full - background).toBeCloseTo(10 * Math.log10(4), 0);
  });

  it('you can hear the third boat through an enemy’s ping, but only just', () => {
    const scene = (tuning: AcousticTuning): AcousticEntity[] => {
      const pingB = {
        ...boat({ id: 2, team: 'team2', x: 1300 }),
        activeSonar: true,
        lastPingTick: 10,
      };
      return [
        boatEntity(boat({ id: 1, team: 'team1', x: 1000 }), EXTENTS, [], tuning),
        boatEntity(pingB, EXTENTS, emittedLevels(pingB, 10, SIM_TICK_HZ, tuning), tuning),
        boatEntity(
          boat({
            id: 3,
            team: 'team2',
            x: 750,
            hull: 'heavy',
            speed: getHull('heavy').stats.maxSpeed,
          }),
          EXTENTS,
          [],
          tuning,
        ),
      ];
    };
    const at = (fraction: number): { solver: AcousticSolver; picture: Picture } => {
      // Flow noise carries its own, independent fraction (`flowNoiseFraction`) — pinned to `1`
      // here so the Heavy's own flank-speed screw does not confound what this test is isolating,
      // which is the pulse's.
      const tuning = { ...ACOUSTICS, filterableNoiseFraction: fraction, flowNoiseFraction: 1 };
      const solver = new AcousticSolver(world(), { tuning });
      return { solver, picture: read(solver, scene(tuning), 'team1') };
    };
    /** Squares within 90 m of an x — one hull's own returns, picked out of the pooled picture. */
    const hullSquares = (s: AcousticSolver, p: Picture, x: number) => around(s, p.cells, x).length;
    const brightest = (s: AcousticSolver, p: Picture, x: number) => {
      let best = -Infinity;
      for (let i = 0; i < p.cells.length; i += 1) {
        if (Math.abs(visionCellCentre(s.grid, p.cells[i]!).x - x) < 60)
          best = Math.max(best, p.excess[i]!);
      }
      return best;
    };

    const legacy = at(1);
    const shipped = at(0.25);
    const floodlight = at(0);

    // A Heavy at flank 250 m out is well within a stopped Medium's hearing — until a second boat
    // pings. At legacy weight the 116 dB pulse arriving 300 m away raises the floor enough to
    // hide the Heavy entirely. Skimmed to a quarter, the same pulse still deafens — the Heavy
    // clears the raised floor by only a few dB — but it is seen.
    expect(hullSquares(legacy.solver, legacy.picture, 750)).toBe(0);
    expect(hullSquares(shipped.solver, shipped.picture, 750)).toBeGreaterThan(0);
    expect(hullSquares(floodlight.solver, floodlight.picture, 750)).toBeGreaterThan(0);

    // The announcement survives every weight: the pinger itself is a loud direct return.
    expect(hullSquares(legacy.solver, legacy.picture, 1300)).toBeGreaterThan(0);
    expect(hullSquares(shipped.solver, shipped.picture, 1300)).toBeGreaterThan(0);

    // "But only just": a quarter keeps most of the deafening. A fully filterable ping would paint
    // the Heavy at floodlight excess; the shipped value leaves it a faint return near the edge.
    expect(brightest(shipped.solver, shipped.picture, 750)).toBeLessThan(
      brightest(floodlight.solver, floodlight.picture, 750),
    );
  });

  it('still lights the walls for the boat that pinged', () => {
    const solver = new AcousticSolver(world([block(0, 0, EXTENTS.width, 300)]));
    const seen = read(solver, [pinger({ id: 1, team: 'team1', x: 2000, y: 500 })], 'team1');

    // Its own hull is excluded, so every square here is rock beneath it, lit by its own pulse —
    // the whole reason active sonar is a tool for mapping (ADR 0003).
    expect(seen.count).toBeGreaterThan(100);
  });
});

describe('the solve as a whole', () => {
  const solver = new AcousticSolver(world());
  const scene: BoatSpec[] = [
    { id: 3, team: 'team2', x: 1800, speed: CREEP },
    { id: 1, team: 'team1', x: 1400, speed: CREEP },
    { id: 2, team: 'team1', x: 1200, speed: FLANK },
  ];

  it('gives each side its own picture', () => {
    const out = solver.solve(entities(scene));
    expect(out.vision.map((v) => v.team).sort()).toEqual(['team1', 'team2']);
    for (const side of out.vision) expect(side.cells.length).toBe(side.excess.length);
  });

  it('does not depend on the order the entities arrive in', () => {
    const forwards = solver.solve(entities(scene));
    const backwards = solver.solve(entities([...scene].reverse()));

    for (const team of ['team1', 'team2'] as const) {
      const a = forwards.vision.find((v) => v.team === team);
      const b = backwards.vision.find((v) => v.team === team);
      expect([...(a?.cells ?? [])]).toEqual([...(b?.cells ?? [])]);
      expect([...(a?.excess ?? [])]).toEqual([...(b?.excess ?? [])]);
    }
  });

  it('gives a fresh solver the same answer as a used one', () => {
    const first = solver.solve(entities(scene)).vision.map((v) => [...v.cells]);
    solver.solve(entities([{ id: 9, team: 'team2', x: 4200, speed: FLANK }]));

    expect(solver.solve(entities(scene)).vision.map((v) => [...v.cells])).toEqual(first);
    expect(
      new AcousticSolver(world()).solve(entities(scene)).vision.map((v) => [...v.cells]),
    ).toEqual(first);
  });

  it('reports what it did', () => {
    const out = solver.solve(entities(scene));
    expect(out.stats.entities).toBe(3);
    expect(out.stats.sources).toBe(3);
    expect(out.stats.listeners).toBe(3);
    expect(out.stats.fieldCells).toBeGreaterThan(0);
    expect(out.stats.visionCells).toBe(
      out.vision.reduce((sum, side) => sum + side.cells.length, 0),
    );
  });

  it('drops the dimmest squares rather than random ones when it runs out of budget', () => {
    // A loud boat over a seabed: its own noise lights the floor and the glow fades off with
    // range, so there is a real spread of strengths for the cap to choose between.
    const floored = world([block(0, 0, EXTENTS.width, 300)]);
    const loud: BoatSpec[] = [{ id: 1, team: 'team1', x: 2000, y: 500, speed: FLANK }];

    const full = picture(new AcousticSolver(floored), loud, 'team1');
    expect(full.count).toBeGreaterThan(400);

    const budget = 200;
    const side = picture(
      new AcousticSolver(floored, { tuning: { ...ACOUSTICS, maxVisionCells: budget } }),
      loud,
      'team1',
    );

    expect(side.count).toBe(budget);
    expect(full.count - budget).toBeGreaterThan(0);

    // Nothing kept is dimmer than something thrown away.
    const kept = new Set(side.cells);
    const faintestKept = Math.min(...side.excess);
    for (let i = 0; i < full.count; i += 1) {
      if (kept.has(full.cells[i] ?? -1)) continue;
      expect(full.excess[i] ?? 0).toBeLessThanOrEqual(faintestKept + 1e-4);
    }
  });

  it('keeps a wreck in the water as a reflector, groaning quietly, that hears nothing', () => {
    const sunk = boat({ id: 2, team: 'team2', x: 1300 });
    const wreck = boatEntity({ ...sunk, status: 'destroyed' }, EXTENTS);

    // Continuous and modest — air escaping and metal groaning (planning/04 §8, revised), not
    // the silence a wreck used to radiate.
    expect(wreck.sourceLevel).toBe(ACOUSTICS.wreckNoiseLevel);
    expect(wreck.hydrophone).toBeNull();
    expect(wreck.outline).not.toBeNull();

    const out = solver.solve([
      ...entities([{ id: 1, team: 'team1', x: 1000, speed: FLANK }]),
      wreck,
    ]);
    expect(out.stats.listeners).toBe(1);

    const seen = out.vision.find((v) => v.team === 'team1');
    expect(around(solver, seen?.cells ?? new Int32Array(0), 1300).length).toBeGreaterThan(0);
  });
});

describe('over a generated cave system', () => {
  // The hand-built scenes above are the ones with a right answer that can be checked on
  // paper. This is the other half of planning/13 §4.1's argument: the real terrain is what
  // the game runs on, and a model that only holds on rectangles proves nothing.
  const SEEDS = 8;

  it('binds every square metre of rock face to water something could hear it from', () => {
    for (const mapType of ['sparse', 'dense'] as const) {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const solver = new AcousticSolver(generateMap(mapType, { seed, mapSize: 'medium' }));
        expect(solver.terrain.orphaned).toBe(0);
        expect(solver.terrain.cells.length).toBeGreaterThan(10_000);
      }
    }
  });

  it('solves a fleet without clipping a field or overrunning the picture budget', () => {
    const mapSize = 'medium';
    const extents = resolveExtents(mapSize);
    const solver = new AcousticSolver(generateMap('dense', { seed: 4, mapSize }));

    // Twelve boats spread along the map, wherever the first open water is.
    const open: Array<{ x: number; y: number }> = [];
    for (let x = extents.width * 0.1; x < extents.width * 0.9 && open.length < 12; x += 211) {
      for (let y = extents.height * 0.1; y < extents.height * 0.9; y += 47) {
        if (solver.lattice.water[solver.lattice.indexAt(x, y)] === 1) {
          open.push({ x, y });
          break;
        }
      }
    }
    expect(open.length).toBe(12);

    const fleet = open.map((at, i) =>
      boatEntity(
        boat({
          id: i + 1,
          team: i % 2 === 0 ? 'team1' : 'team2',
          hull: (['light', 'medium', 'heavy'] as const)[i % 3],
          x: at.x,
          y: at.y,
          speed: i === 3 ? FLANK : CREEP,
        }),
        extents,
      ),
    );

    const out = solver.solve(fleet);
    expect(out.stats.clippedFields).toBe(0);
    expect(out.stats.listeners).toBe(12);
    expect(out.vision.length).toBe(2);
    for (const side of out.vision) expect(side.dropped).toBe(0);

    // Every reported square is inside the map, and every one of them is somewhere rock or a
    // hull actually is — the picture never invents open water.
    for (const side of out.vision) {
      for (const cell of side.cells) {
        const p = visionCellCentre(solver.grid, cell);
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(extents.width);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(extents.height);
      }
    }
  });

  it('reproduces itself from the same seed, which replays depend on', () => {
    const mapSize = 'small';
    const extents = resolveExtents(mapSize);
    const first = new AcousticSolver(generateMap('sparse', { seed: 11, mapSize }));
    const second = new AcousticSolver(generateMap('sparse', { seed: 11, mapSize }));

    const at = { x: extents.width / 2, y: extents.height / 2 };
    const fleet = (solver: AcousticSolver) => {
      const cell = solver.lattice.waterIndexAt(at.x, at.y);
      const centre = solver.lattice.centreOf(cell);
      return [
        boatEntity(boat({ id: 1, team: 'team1', x: centre.x, y: centre.y, speed: FLANK }), extents),
        boatEntity(
          boat({ id: 2, team: 'team2', x: centre.x + 300, y: centre.y, speed: CREEP }),
          extents,
        ),
      ];
    };

    const a = first.solve(fleet(first));
    const b = second.solve(fleet(second));
    expect(a.vision.map((v) => [...v.cells])).toEqual(b.vision.map((v) => [...v.cells]));
    expect(a.vision.map((v) => [...v.excess])).toEqual(b.vision.map((v) => [...v.excess]));
  });
});
