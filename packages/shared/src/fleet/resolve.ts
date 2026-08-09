/**
 * Turning a boat template into numbers: cost, and base stats versus fitted stats.
 *
 * Shared deliberately. The fleet editor shows the player a final stat block and the server
 * validates the same fleet at match start; if those were two implementations they would
 * eventually disagree, and "the builder said 340 points but the server said 355" is exactly
 * the class of bug sharing this package exists to remove (planning/01 §2).
 */

import { getHull, type Hull, type HullId, type SlotKind, SLOT_KINDS } from '../content/hulls.js';
import { getModule, isModuleId, type ModuleDef } from '../content/modules.js';
import { applyModifiers, type Modifier, type Stats } from '../content/stats.js';
import type { BoatTemplate, FittedModule, Fleet } from './types.js';

/** A slot on a boat: where it is, what it takes, and what is in it. */
export interface ResolvedSlot {
  readonly kind: SlotKind;
  readonly index: number;
  readonly module: ModuleDef | null;
}

export interface ResolvedBoat {
  readonly hull: Hull;
  readonly name: string;
  /** The hull's own numbers, before anything is fitted. */
  readonly base: Stats;
  /** What the boat actually has, after every module. */
  readonly current: Stats;
  readonly slots: readonly ResolvedSlot[];
  readonly hullCost: number;
  readonly moduleCost: number;
  readonly cost: number;
}

/**
 * Every slot the hull carries, in display order, with whatever occupies it.
 *
 * Slots are generated from the hull's own counts rather than from the saved modules, so a
 * fleet saved before a hull gained a slot simply shows an empty one, and a module in a slot
 * the hull no longer has is dropped rather than crashing the editor. Content drift is
 * expected, not exceptional (planning/07 §3).
 */
export function resolveSlots(hullId: HullId, modules: readonly FittedModule[]): ResolvedSlot[] {
  const hull = getHull(hullId);
  const slots: ResolvedSlot[] = [];

  for (const kind of SLOT_KINDS) {
    for (let index = 0; index < hull.slots[kind]; index += 1) {
      const fitted = modules.find((m) => m.slot === kind && m.index === index);
      const def =
        fitted !== undefined && isModuleId(fitted.module) ? getModule(fitted.module) : null;
      // A module that no longer fits this slot kind is treated as empty rather than
      // honoured — the table is the authority, not the saved fleet.
      slots.push({ kind, index, module: def !== null && def.slot === kind ? def : null });
    }
  }

  return slots;
}

export function resolveBoat(boat: BoatTemplate): ResolvedBoat {
  const hull = getHull(boat.hull);
  const slots = resolveSlots(boat.hull, boat.modules);

  const fitted = slots.flatMap((slot) => (slot.module === null ? [] : [slot.module]));
  const modifiers: Modifier[] = fitted.flatMap((m) => [...m.modifiers]);
  const moduleCost = fitted.reduce((sum, m) => sum + m.cost, 0);

  return {
    hull,
    name: boat.name,
    base: { ...hull.stats },
    current: applyModifiers(hull.stats, modifiers),
    slots,
    hullCost: hull.cost,
    moduleCost,
    cost: hull.cost + moduleCost,
  };
}

/** What one boat costs. Cheap enough to call per render. */
export function boatCost(boat: BoatTemplate): number {
  return resolveBoat(boat).cost;
}

/** What the whole fleet costs — the number the load list and the budget meter show. */
export function fleetCost(boats: readonly BoatTemplate[]): number {
  return boats.reduce((sum, boat) => sum + boatCost(boat), 0);
}

export function fleetSummaryOf(fleet: Fleet): {
  boatCount: number;
  points: number;
} {
  return { boatCount: fleet.boats.length, points: fleetCost(fleet.boats) };
}
