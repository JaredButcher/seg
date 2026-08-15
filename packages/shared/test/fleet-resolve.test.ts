/**
 * Cost and stat resolution — the numbers the editor shows and the server validates.
 *
 * These matter more than most shared tests: they are computed twice in the product's mental
 * model (a player builds, a server accepts) but must be one implementation, and the failure
 * mode of getting it wrong is "the builder said 340 and the server said 355".
 */
import { describe, expect, it } from 'vitest';

import {
  HULLS,
  HULL_IDS,
  MODULES,
  MODULE_IDS,
  STAT_KEYS,
  applyModifiers,
  boatCost,
  fleetCost,
  getHull,
  modulesForSlot,
  resolveBoat,
  resolveSlots,
  totalSlots,
  type BoatTemplate,
  type Modifier,
  type Stats,
} from '../src/index.js';

const BASE: Stats = { ...HULLS.medium.stats };

function boat(over: Partial<BoatTemplate> = {}): BoatTemplate {
  return { name: 'S-01', hull: 'medium', modules: [], ...over };
}

describe('the content tables', () => {
  it('gives every hull a full stat block', () => {
    for (const id of HULL_IDS) {
      for (const key of STAT_KEYS) {
        expect(typeof getHull(id).stats[key], `${id}.${key}`).toBe('number');
      }
    }
  });

  it('gives every hull a closed silhouette with enough vertices to be recognisable', () => {
    for (const id of HULL_IDS) {
      const hull = getHull(id);
      // planning/03 §6 budgets 10–20 vertices for a side profile.
      expect(hull.silhouette.length, id).toBeGreaterThanOrEqual(10);
      expect(hull.silhouette.length, id).toBeLessThanOrEqual(20);
    }
  });

  it('keeps each silhouette the same length as the hull it belongs to', () => {
    for (const id of HULL_IDS) {
      const hull = getHull(id);
      const xs = hull.silhouette.map(([x]) => x);
      // Length in the table and length in the art must not drift — the polygon is the
      // collision shape, so a mismatch is a boat that does not fit where it says it does.
      expect(Math.max(...xs) - Math.min(...xs), id).toBeCloseTo(hull.length, 1);
    }
  });

  it('gives every module a positive cost and at least one effect', () => {
    for (const id of MODULE_IDS) {
      expect(MODULES[id].cost, id).toBeGreaterThan(0);
      // A stat modifier, or — for the three "Improved" torpedoes — a granted `WeaponId`
      // substitution (`ModuleDef.upgrades`): the other shape of effect a module can have,
      // since a torpedo upgrade is not expressible as a `Modifier` (`content/modules.ts`).
      const hasEffect = MODULES[id].modifiers.length > 0 || MODULES[id].upgrades !== undefined;
      expect(hasEffect, id).toBe(true);
    }
  });

  it('only offers a module for the slot kind it declares', () => {
    for (const kind of ['equipment', 'weapon'] as const) {
      for (const module of modulesForSlot(kind)) {
        expect(module.slot, module.id).toBe(kind);
      }
    }
  });

  it('gives every hull at least one slot of each kind', () => {
    // A hull with no weapon slot could never fit a weapon module, which would make part of
    // the module table unreachable for it without saying so anywhere.
    for (const id of HULL_IDS) {
      expect(getHull(id).slots.equipment, id).toBeGreaterThan(0);
      expect(getHull(id).slots.weapon, id).toBeGreaterThan(0);
      expect(totalSlots(getHull(id)), id).toBeGreaterThan(0);
    }
  });
});

describe('applyModifiers', () => {
  it('leaves stats alone when nothing is fitted', () => {
    expect(applyModifiers(BASE, [])).toEqual(BASE);
  });

  it('adds, multiplies, and sets', () => {
    expect(applyModifiers(BASE, [{ stat: 'maxHp', op: 'add', value: 40 }]).maxHp).toBe(150);
    expect(applyModifiers(BASE, [{ stat: 'maxHp', op: 'mul', value: 2 }]).maxHp).toBe(220);
    expect(applyModifiers(BASE, [{ stat: 'baffleArc', op: 'set', value: 10 }]).baffleArc).toBe(10);
  });

  it('resolves set before add before mul, regardless of fitting order', () => {
    const mods: Modifier[] = [
      { stat: 'maxHp', op: 'mul', value: 2 },
      { stat: 'maxHp', op: 'add', value: 10 },
      { stat: 'maxHp', op: 'set', value: 100 },
    ];

    // set 100 → add 10 → mul 2 = 220, whichever order they arrive in.
    expect(applyModifiers(BASE, mods).maxHp).toBe(220);
    expect(applyModifiers(BASE, [...mods].reverse()).maxHp).toBe(220);
  });

  it('is order-independent for any shuffling of the real module table', () => {
    // The property that matters: two boats with the same modules resolve identically. If
    // this ever fails, players will find it in an afternoon.
    const mods = MODULE_IDS.flatMap((id) => [...MODULES[id].modifiers]);
    const shuffled = [...mods].reverse();
    expect(applyModifiers(BASE, shuffled)).toEqual(applyModifiers(BASE, mods));
  });

  it('does not mutate the base block it was handed', () => {
    const base = { ...BASE };
    applyModifiers(base, [{ stat: 'maxHp', op: 'add', value: 999 }]);
    expect(base.maxHp).toBe(BASE.maxHp);
  });

  it('clamps with min and max', () => {
    expect(applyModifiers(BASE, [{ stat: 'maxSpeed', op: 'min', value: 20 }]).maxSpeed).toBe(20);
    expect(applyModifiers(BASE, [{ stat: 'maxSpeed', op: 'max', value: 5 }]).maxSpeed).toBe(5);
  });
});

describe('resolveSlots', () => {
  it('produces exactly the slots the hull declares', () => {
    const slots = resolveSlots('heavy', []);
    expect(slots.filter((s) => s.kind === 'equipment')).toHaveLength(HULLS.heavy.slots.equipment);
    expect(slots.filter((s) => s.kind === 'weapon')).toHaveLength(HULLS.heavy.slots.weapon);
  });

  it('places a fitted module in its slot', () => {
    const slots = resolveSlots('medium', [{ slot: 'weapon', index: 1, module: 'rapid-loader' }]);
    const slot = slots.find((s) => s.kind === 'weapon' && s.index === 1);
    expect(slot?.module?.id).toBe('rapid-loader');
  });

  it('ignores a module fitted to a slot the hull does not have', () => {
    // The Light hull has one weapon slot, so index 5 is nonexistent. Generating slots from
    // the hull rather than from the saved data is what makes content drift survivable.
    const slots = resolveSlots('light', [{ slot: 'weapon', index: 5, module: 'extra-tube' }]);
    expect(slots.every((s) => s.module === null)).toBe(true);
  });

  it('ignores a module in the wrong kind of slot', () => {
    const slots = resolveSlots('medium', [{ slot: 'equipment', index: 0, module: 'extra-tube' }]);
    expect(slots.find((s) => s.kind === 'equipment' && s.index === 0)?.module).toBeNull();
  });
});

describe('resolveBoat', () => {
  it('reports base and current separately', () => {
    const resolved = resolveBoat(
      boat({ modules: [{ slot: 'equipment', index: 0, module: 'improved-hydrophones' }] }),
    );

    expect(resolved.base.arrayGain).toBe(HULLS.medium.stats.arrayGain);
    expect(resolved.current.arrayGain).toBe(HULLS.medium.stats.arrayGain + 4);
  });

  it('splits cost into hull and modules', () => {
    const resolved = resolveBoat(
      boat({ modules: [{ slot: 'equipment', index: 0, module: 'towed-array' }] }),
    );

    expect(resolved.hullCost).toBe(HULLS.medium.cost);
    expect(resolved.moduleCost).toBe(MODULES['towed-array'].cost);
    expect(resolved.cost).toBe(HULLS.medium.cost + MODULES['towed-array'].cost);
  });

  it('stacks several modules on one boat', () => {
    const resolved = resolveBoat(
      boat({
        hull: 'heavy',
        modules: [
          { slot: 'equipment', index: 0, module: 'armor-plating' },
          { slot: 'weapon', index: 0, module: 'extra-tube' },
        ],
      }),
    );

    // 185 × 1.4 = 259, and 4 + 1 tubes.
    expect(resolved.current.maxHp).toBeCloseTo(259, 6);
    expect(resolved.current.torpedoTubes).toBe(5);
    // Armour also costs a knot.
    expect(resolved.current.maxSpeed).toBe(HULLS.heavy.stats.maxSpeed - 1);
  });

  it('does not charge for a module that could not be fitted', () => {
    const resolved = resolveBoat(
      boat({ hull: 'light', modules: [{ slot: 'weapon', index: 9, module: 'extra-tube' }] }),
    );
    expect(resolved.cost).toBe(HULLS.light.cost);
  });

  it('substitutes an improved torpedo for the load it upgrades, and nothing else', () => {
    const resolved = resolveBoat(
      boat({
        hull: 'heavy',
        modules: [{ slot: 'weapon', index: 0, module: 'improved-active-torpedo' }],
      }),
    );

    expect(resolved.substitutions).toEqual({ 'active-torpedo': 'improved-active-torpedo' });
  });

  it('gives an empty substitution table to a boat with nothing upgraded', () => {
    expect(resolveBoat(boat()).substitutions).toEqual({});
  });

  it('stacks two different upgrades onto one boat', () => {
    const resolved = resolveBoat(
      boat({
        hull: 'heavy',
        modules: [
          { slot: 'weapon', index: 0, module: 'improved-active-torpedo' },
          { slot: 'weapon', index: 1, module: 'improved-passive-torpedo' },
        ],
      }),
    );

    expect(resolved.substitutions).toEqual({
      'active-torpedo': 'improved-active-torpedo',
      'passive-torpedo': 'improved-passive-torpedo',
    });
  });
});

describe('fleetCost', () => {
  it('is zero for an empty fleet', () => {
    expect(fleetCost([])).toBe(0);
  });

  it('is the sum of its boats', () => {
    const boats = [boat({ hull: 'light' }), boat({ hull: 'heavy' })];
    expect(fleetCost(boats)).toBe(HULLS.light.cost + HULLS.heavy.cost);
    expect(fleetCost(boats)).toBe(boatCost(boats[0]!) + boatCost(boats[1]!));
  });
});
