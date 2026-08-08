/**
 * Fleet shapes. planning/07 §3.
 *
 * A fleet is account data, not match data: it is built between matches and brought into one.
 */

import type { HullId, SlotKind } from '../content/hulls.js';
import type { ModuleId } from '../content/modules.js';

export type FleetId = string;

export const FLEET_NAME_MIN_LENGTH = 1;
export const FLEET_NAME_MAX_LENGTH = 32;
export const BOAT_NAME_MIN_LENGTH = 1;
export const BOAT_NAME_MAX_LENGTH = 20;

/** planning/05: 1–10 boats, 3–5 the expected norm. */
export const FLEET_MIN_BOATS = 1;
export const FLEET_MAX_BOATS = 10;

/** planning/12 Q19. Generous for players, bounded for storage and the load list. */
export const MAX_FLEETS_PER_ACCOUNT = 30;

/**
 * One fitted module. `index` is the slot's position *within its kind*, so a hull with three
 * equipment slots has equipment 0, 1, 2 — independent of its weapon slots.
 *
 * Addressing by (kind, index) rather than by a flat slot number means changing a hull's slot
 * counts in the content table does not silently re-point every saved fleet's modules at
 * different slots.
 */
export interface FittedModule {
  readonly slot: SlotKind;
  readonly index: number;
  readonly module: ModuleId;
}

export interface BoatTemplate {
  /** Player-chosen. Appears on the scope, so it is short and length-capped. */
  readonly name: string;
  readonly hull: HullId;
  readonly modules: readonly FittedModule[];
}

export interface Fleet {
  readonly id: FleetId;
  readonly name: string;
  readonly boats: readonly BoatTemplate[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The row the load dialog lists: name, boat count, points. Nothing heavier. */
export interface FleetSummary {
  readonly id: FleetId;
  readonly name: string;
  readonly boatCount: number;
  readonly points: number;
  readonly updatedAt: number;
}
