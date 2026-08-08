/**
 * The fleet HTTP contract. Both sides import these types, so a route that changes shape
 * breaks the client at compile time rather than at runtime.
 *
 * HTTP rather than the game protocol, matching the auth API: a fleet is account data edited
 * between matches, not lobby or match traffic. It is request/response, it is not real-time,
 * and it should keep working whether or not a socket is open (planning/07 §3).
 */

import type { BoatTemplate, Fleet, FleetId, FleetSummary } from './types.js';

export const FLEET_API_BASE = '/api/fleets';

export const FLEET_ROUTES = {
  /** GET — the load list. POST — create. */
  collection: FLEET_API_BASE,
  /** GET one, PUT to overwrite, DELETE to remove. Id goes in the query string. */
  item: `${FLEET_API_BASE}/item`,
} as const;

export type FleetErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'not_found'
  | 'too_many_fleets'
  | 'unauthenticated'
  | 'payload_too_large'
  | 'internal_error';

export interface FleetErrorBody {
  readonly error: {
    readonly code: FleetErrorCode;
    readonly message: string;
  };
}

export interface FleetListResponse {
  readonly fleets: readonly FleetSummary[];
}

export interface FleetResponse {
  readonly fleet: Fleet;
}

export interface SaveFleetRequest {
  /** Absent to create; present to overwrite an existing fleet. */
  readonly id?: FleetId;
  readonly name: string;
  readonly boats: readonly BoatTemplate[];
}
