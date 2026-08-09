/**
 * Fleet validation, and the repair path for fleets saved against older content tables.
 *
 * Validation is what rejects a malicious payload; repair is what tolerates an honest one.
 * They are deliberately different operations and the order they run in matters — see the
 * note in the server's readSaveRequest.
 */
import { describe, expect, it } from 'vitest';

import {
  BOAT_NAME_MAX_LENGTH,
  FLEET_MAX_BOATS,
  FLEET_NAME_MAX_LENGTH,
  describeFleetProblem,
  normalizeName,
  repairBoat,
  validateBoat,
  validateBoatName,
  validateFleet,
  validateFleetName,
  type BoatTemplate,
} from '../src/index.js';

function boat(over: Partial<BoatTemplate> = {}): BoatTemplate {
  return { name: 'S-01', hull: 'medium', modules: [], ...over };
}

describe('names', () => {
  it('accepts ordinary names and the permitted punctuation', () => {
    expect(validateFleetName('First Wolfpack')).toBeNull();
    expect(validateBoatName("Ivan's Run - 2")).toBeNull();
  });

  it('enforces the length caps', () => {
    expect(validateFleetName('')).toBe('fleet_name_too_short');
    expect(validateFleetName('x'.repeat(FLEET_NAME_MAX_LENGTH + 1))).toBe('fleet_name_too_long');
    expect(validateBoatName('')).toBe('boat_name_too_short');
    expect(validateBoatName('x'.repeat(BOAT_NAME_MAX_LENGTH + 1))).toBe('boat_name_too_long');
  });

  it('rejects the characters that make a HUD label dangerous', () => {
    // Boat names are drawn on the scope and there is no moderation tooling at 1.0.
    expect(validateBoatName('S-01‮')).toBe('boat_name_invalid_characters');
    expect(validateBoatName('S​01')).toBe('boat_name_invalid_characters');
    expect(validateFleetName('<script>')).toBe('fleet_name_invalid_characters');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeName('  First    Wolfpack  ')).toBe('First Wolfpack');
  });
});

describe('validateBoat', () => {
  it('accepts a legal boat', () => {
    expect(validateBoat(boat())).toBeNull();
    expect(
      validateBoat(boat({ modules: [{ slot: 'weapon', index: 0, module: 'extra-tube' }] })),
    ).toBeNull();
  });

  it('rejects an unknown hull or module', () => {
    expect(validateBoat(boat({ hull: 'battlestar' as never }))).toBe('unknown_hull');
    expect(
      validateBoat(boat({ modules: [{ slot: 'weapon', index: 0, module: 'death-ray' as never }] })),
    ).toBe('unknown_module');
  });

  it('rejects a module in the wrong kind of slot', () => {
    expect(
      validateBoat(boat({ modules: [{ slot: 'equipment', index: 0, module: 'extra-tube' }] })),
    ).toBe('wrong_slot_kind');
  });

  it('rejects a slot the hull does not have', () => {
    // Light carries one weapon slot.
    expect(
      validateBoat(
        boat({ hull: 'light', modules: [{ slot: 'weapon', index: 1, module: 'extra-tube' }] }),
      ),
    ).toBe('no_such_slot');
    expect(
      validateBoat(boat({ modules: [{ slot: 'weapon', index: -1, module: 'extra-tube' }] })),
    ).toBe('no_such_slot');
  });

  it('rejects two modules in one slot', () => {
    // Otherwise the resolver would pick whichever it found first, which is exactly the
    // order-dependence the modifier system is built to avoid.
    expect(
      validateBoat(
        boat({
          modules: [
            { slot: 'weapon', index: 0, module: 'extra-tube' },
            { slot: 'weapon', index: 0, module: 'rapid-loader' },
          ],
        }),
      ),
    ).toBe('slot_occupied_twice');
  });
});

describe('validateFleet', () => {
  it('accepts a legal fleet', () => {
    expect(validateFleet('Wolfpack', [boat()]).problem).toBeNull();
  });

  it('requires at least one boat and at most ten', () => {
    expect(validateFleet('Empty', []).problem).toBe('no_boats');
    expect(
      validateFleet(
        'Swarm',
        Array.from({ length: FLEET_MAX_BOATS + 1 }, () => boat()),
      ).problem,
    ).toBe('too_many_boats');
  });

  it('says which boat is at fault', () => {
    const result = validateFleet('Wolfpack', [boat(), boat({ name: '' })]);
    expect(result.problem).toBe('boat_name_too_short');
    expect(result.boatIndex).toBe(1);
  });

  it('has readable text for every problem it can report', () => {
    const problems = [
      'fleet_name_too_short',
      'fleet_name_too_long',
      'fleet_name_invalid_characters',
      'no_boats',
      'too_many_boats',
      'boat_name_too_short',
      'boat_name_too_long',
      'boat_name_invalid_characters',
      'unknown_hull',
      'unknown_module',
      'wrong_slot_kind',
      'no_such_slot',
      'slot_occupied_twice',
    ] as const;

    for (const problem of problems) {
      expect(describeFleetProblem(problem).length, problem).toBeGreaterThan(0);
    }
  });
});

describe('repairBoat', () => {
  it('leaves a valid boat alone', () => {
    const valid = boat({ modules: [{ slot: 'weapon', index: 0, module: 'extra-tube' }] });
    expect(repairBoat(valid)).toEqual(valid);
  });

  it('drops a module that no longer exists', () => {
    const repaired = repairBoat(
      boat({ modules: [{ slot: 'weapon', index: 0, module: 'death-ray' as never }] }),
    );
    expect(repaired.modules).toHaveLength(0);
  });

  it('drops a module whose slot the hull lost', () => {
    const repaired = repairBoat(
      boat({ hull: 'light', modules: [{ slot: 'weapon', index: 4, module: 'extra-tube' }] }),
    );
    expect(repaired.modules).toHaveLength(0);
  });

  it('keeps the first of two modules in one slot', () => {
    const repaired = repairBoat(
      boat({
        modules: [
          { slot: 'weapon', index: 0, module: 'extra-tube' },
          { slot: 'weapon', index: 0, module: 'rapid-loader' },
        ],
      }),
    );
    expect(repaired.modules).toHaveLength(1);
    expect(repaired.modules[0]?.module).toBe('extra-tube');
  });

  it('never silently changes the hull or the name', () => {
    // planning/07 §3: repair what can be repaired, flag what cannot, and never silently
    // alter a fleet beyond dropping what has become impossible.
    const original = boat({ name: 'Leviathan', hull: 'heavy' });
    const repaired = repairBoat(original);
    expect(repaired.name).toBe('Leviathan');
    expect(repaired.hull).toBe('heavy');
  });
});
