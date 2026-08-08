import {
  FLEET_ROUTES,
  type BoatTemplate,
  type Fleet,
  type FleetId,
  type FleetListResponse,
  type FleetResponse,
  type FleetSummary,
} from '@seg/shared';

import { request } from './http.js';

/** The fleet HTTP API. Same `request` helper — and same cookie — as the auth calls. */
export const fleetApi = {
  async list(): Promise<readonly FleetSummary[]> {
    const body = await request<FleetListResponse>(FLEET_ROUTES.collection);
    return body.fleets;
  },

  async load(id: FleetId): Promise<Fleet> {
    const body = await request<FleetResponse>(`${FLEET_ROUTES.item}?id=${encodeURIComponent(id)}`);
    return body.fleet;
  },

  async create(name: string, boats: readonly BoatTemplate[]): Promise<Fleet> {
    const body = await request<FleetResponse>(FLEET_ROUTES.collection, {
      method: 'POST',
      body: JSON.stringify({ name, boats }),
    });
    return body.fleet;
  },

  async update(id: FleetId, name: string, boats: readonly BoatTemplate[]): Promise<Fleet> {
    const body = await request<FleetResponse>(`${FLEET_ROUTES.item}?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name, boats }),
    });
    return body.fleet;
  },

  async remove(id: FleetId): Promise<void> {
    await request<undefined>(`${FLEET_ROUTES.item}?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};
