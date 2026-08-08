/**
 * Fleet validation — the same rules on both sides.
 *
 * The editor runs these so a player is told before they save; the server runs them because a
 * fleet arriving over the wire is untrusted (planning/05: "validated server-side, never
 * trusted from the client").
 */

import { getHull, isHullId, SLOT_KINDS, type SlotKind } from '../content/hulls.js';
import { isModuleId, getModule } from '../content/modules.js';
import {
  BOAT_NAME_MAX_LENGTH,
  BOAT_NAME_MIN_LENGTH,
  FLEET_MAX_BOATS,
  FLEET_MIN_BOATS,
  FLEET_NAME_MAX_LENGTH,
  FLEET_NAME_MIN_LENGTH,
  type BoatTemplate,
  type FittedModule,
} from './types.js';

export type FleetProblem =
  | 'fleet_name_too_short'
  | 'fleet_name_too_long'
  | 'fleet_name_invalid_characters'
  | 'no_boats'
  | 'too_many_boats'
  | 'boat_name_too_short'
  | 'boat_name_too_long'
  | 'boat_name_invalid_characters'
  | 'unknown_hull'
  | 'unknown_module'
  | 'wrong_slot_kind'
  | 'no_such_slot'
  | 'slot_occupied_twice';

/**
 * Same restricted set as lobby names, and for the same reason: fleet and boat names are the
 * only user-generated content at 1.0 (planning/01 §8), boat names are drawn on the scope, and
 * there is no moderation tooling. Keeping the surface to printable ASCII means the worst case
 * is a rude word rather than a right-to-left override in the middle of a HUD.
 */
const NAME_PATTERN = /^[A-Za-z0-9 '\-_.!?]+$/;

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function validateFleetName(name: string): FleetProblem | null {
  if (name.length < FLEET_NAME_MIN_LENGTH) return 'fleet_name_too_short';
  if (name.length > FLEET_NAME_MAX_LENGTH) return 'fleet_name_too_long';
  if (!NAME_PATTERN.test(name)) return 'fleet_name_invalid_characters';
  return null;
}

export function validateBoatName(name: string): FleetProblem | null {
  if (name.length < BOAT_NAME_MIN_LENGTH) return 'boat_name_too_short';
  if (name.length > BOAT_NAME_MAX_LENGTH) return 'boat_name_too_long';
  if (!NAME_PATTERN.test(name)) return 'boat_name_invalid_characters';
  return null;
}

/** Checks one boat's hull, name, and every fitted module against the content tables. */
export function validateBoat(boat: BoatTemplate): FleetProblem | null {
  const nameProblem = validateBoatName(normalizeName(boat.name));
  if (nameProblem !== null) return nameProblem;

  if (!isHullId(boat.hull)) return 'unknown_hull';
  const hull = getHull(boat.hull);

  const seen = new Set<string>();
  for (const fitted of boat.modules) {
    if (!isModuleId(fitted.module)) return 'unknown_module';
    if (!isSlotKind(fitted.slot)) return 'wrong_slot_kind';

    // The module has to fit the kind of slot it claims…
    if (getModule(fitted.module).slot !== fitted.slot) return 'wrong_slot_kind';

    // …and the hull has to actually have that slot.
    if (!Number.isInteger(fitted.index) || fitted.index < 0) return 'no_such_slot';
    if (fitted.index >= hull.slots[fitted.slot]) return 'no_such_slot';

    // Two modules in one slot would resolve to whichever the resolver happened to find
    // first, which is exactly the kind of order-dependence the modifier system forbids.
    const key = `${fitted.slot}:${String(fitted.index)}`;
    if (seen.has(key)) return 'slot_occupied_twice';
    seen.add(key);
  }

  return null;
}

export interface FleetValidation {
  readonly problem: FleetProblem | null;
  /** Which boat the problem is on, when it belongs to one. */
  readonly boatIndex?: number;
}

export function validateFleet(name: string, boats: readonly BoatTemplate[]): FleetValidation {
  const nameProblem = validateFleetName(normalizeName(name));
  if (nameProblem !== null) return { problem: nameProblem };

  if (boats.length < FLEET_MIN_BOATS) return { problem: 'no_boats' };
  if (boats.length > FLEET_MAX_BOATS) return { problem: 'too_many_boats' };

  for (const [index, boat] of boats.entries()) {
    const problem = validateBoat(boat);
    if (problem !== null) return { problem, boatIndex: index };
  }

  return { problem: null };
}

export function describeFleetProblem(problem: FleetProblem): string {
  switch (problem) {
    case 'fleet_name_too_short':
      return 'Give the fleet a name.';
    case 'fleet_name_too_long':
      return `A fleet name is at most ${FLEET_NAME_MAX_LENGTH} characters.`;
    case 'fleet_name_invalid_characters':
      return "A fleet name may use letters, numbers, spaces, and ' - _ . ! ?";
    case 'no_boats':
      return 'A fleet needs at least one boat.';
    case 'too_many_boats':
      return `A fleet can hold at most ${FLEET_MAX_BOATS} boats.`;
    case 'boat_name_too_short':
      return 'Every boat needs a name.';
    case 'boat_name_too_long':
      return `A boat name is at most ${BOAT_NAME_MAX_LENGTH} characters.`;
    case 'boat_name_invalid_characters':
      return "A boat name may use letters, numbers, spaces, and ' - _ . ! ?";
    case 'unknown_hull':
      return 'That hull no longer exists.';
    case 'unknown_module':
      return 'That module no longer exists.';
    case 'wrong_slot_kind':
      return 'That module does not fit that kind of slot.';
    case 'no_such_slot':
      return 'That hull does not have that slot.';
    case 'slot_occupied_twice':
      return 'Two modules are fitted to the same slot.';
  }
}

function isSlotKind(value: unknown): value is SlotKind {
  return typeof value === 'string' && (SLOT_KINDS as readonly string[]).includes(value);
}

/** Drops anything the content tables no longer recognise. Used when loading a saved fleet. */
export function repairBoat(boat: BoatTemplate): BoatTemplate {
  if (!isHullId(boat.hull)) return boat;
  const hull = getHull(boat.hull);
  const kept: FittedModule[] = [];
  const seen = new Set<string>();

  for (const fitted of boat.modules) {
    if (!isModuleId(fitted.module)) continue;
    if (!isSlotKind(fitted.slot)) continue;
    if (getModule(fitted.module).slot !== fitted.slot) continue;
    if (!Number.isInteger(fitted.index) || fitted.index < 0) continue;
    if (fitted.index >= hull.slots[fitted.slot]) continue;
    const key = `${fitted.slot}:${String(fitted.index)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(fitted);
  }

  return { ...boat, modules: kept };
}
