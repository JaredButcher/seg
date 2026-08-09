/**
 * Fleet CRUD, behind the session cookie.
 *
 * Every route here derives the account from the cookie and never from the request body: a
 * client that could name its own account id could read and overwrite anybody's fleets. The
 * repository reinforces it — ownership is in the WHERE clause of every write, so an update
 * naming someone else's fleet changes zero rows rather than succeeding.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  FLEET_ROUTES,
  MAX_FLEETS_PER_ACCOUNT,
  SESSION_COOKIE,
  describeFleetProblem,
  fleetCost,
  isHullId,
  isModuleId,
  normalizeName,
  repairBoat,
  validateFleet,
  type BoatTemplate,
  type FittedModule,
  type Fleet,
  type FleetErrorCode,
  type FleetListResponse,
  type FleetResponse,
  type FleetSummary,
} from '@seg/shared';

import type { AuthService } from '../../auth/service.js';
import type { Repositories } from '../../db/index.js';
import type { FleetRow } from '../../db/repos/fleets.js';
import type { Router } from '../router.js';
import { HttpError, readCookie, readJsonBody, sendJson, sendNoContent } from '../util.js';

/**
 * Extends HttpError so the app's existing `toErrorBody` maps it without a second error
 * path. The typed `FleetErrorCode` is what the client switches on; HttpError carries it
 * as a plain string, which is all the response body needs.
 */
export class FleetError extends HttpError {
  constructor(code: FleetErrorCode, message: string, status: number) {
    super(status, code, message);
    this.name = 'FleetError';
  }
}

export interface FleetRouteOptions {
  readonly auth: AuthService;
  readonly repos: Repositories;
  readonly clock: () => number;
  /**
   * Told after a fleet is written or deleted.
   *
   * A fleet selected in a lobby has a point value the lobby has already checked against its
   * budget. Editing the fleet afterwards would otherwise be a free way past that check, so
   * the write notifies whoever cares. Optional, because fleets are perfectly usable on a
   * server with no lobby attached — the tests run that way.
   */
  readonly onFleetChanged?: (accountId: string, fleetId: string) => void;
}

export function registerFleetRoutes(router: Router, options: FleetRouteOptions): void {
  const { auth, repos, clock, onFleetChanged } = options;

  async function requireAccount(req: IncomingMessage): Promise<string> {
    const token = readCookie(req, SESSION_COOKIE);
    const resolved = token === undefined ? undefined : await auth.resolveSession(token, clock());
    if (resolved === undefined) {
      throw new FleetError('unauthenticated', 'Not signed in.', 401);
    }
    return resolved.account.id;
  }

  /** Reads `?id=` and refuses a missing one rather than falling through to a list. */
  function requireId(url: URL): string {
    const id = url.searchParams.get('id');
    if (id === null || id.length === 0) {
      throw new FleetError('bad_request', 'A fleet id is required.', 400);
    }
    return id;
  }

  // ── list ──────────────────────────────────────────────────────────────────────
  router.get(FLEET_ROUTES.collection, async (req, res) => {
    const accountId = await requireAccount(req);
    const rows = await repos.fleets.listByAccount(accountId);

    const body: FleetListResponse = {
      fleets: rows.map((row): FleetSummary => ({
        id: row.id,
        name: row.name,
        boatCount: row.boat_count,
        points: row.points,
        updatedAt: row.updated_at,
      })),
    };
    sendJson(res, 200, body);
  });

  // ── load one ──────────────────────────────────────────────────────────────────
  router.get(FLEET_ROUTES.item, async (req, res, url) => {
    const accountId = await requireAccount(req);
    const row = await repos.fleets.findById(requireId(url));

    // Someone else's fleet is reported as missing, not as forbidden. A distinguishable
    // error would confirm that a given id exists and who might own it.
    if (row === undefined || row.account_id !== accountId) {
      throw new FleetError('not_found', 'No such fleet.', 404);
    }

    const body: FleetResponse = { fleet: toFleet(row) };
    sendJson(res, 200, body);
  });

  // ── create ────────────────────────────────────────────────────────────────────
  router.post(FLEET_ROUTES.collection, async (req, res) => {
    const accountId = await requireAccount(req);
    const { name, boats } = await readSaveRequest(req);

    const existing = await repos.fleets.countByAccount(accountId);
    if (existing >= MAX_FLEETS_PER_ACCOUNT) {
      throw new FleetError(
        'too_many_fleets',
        `You already have ${String(MAX_FLEETS_PER_ACCOUNT)} saved fleets. Delete one first.`,
        409,
      );
    }

    const now = clock();
    const id = randomUUID();
    await repos.fleets.create({
      id,
      accountId,
      name,
      data: JSON.stringify(boats),
      boatCount: boats.length,
      // Denormalised here so the load list never parses JSON, and recomputed on every
      // write from the same shared function the editor uses.
      points: fleetCost(boats),
      now,
    });

    const body: FleetResponse = {
      fleet: { id, name, boats, createdAt: now, updatedAt: now },
    };
    sendJson(res, 201, body);
  });

  // ── overwrite ─────────────────────────────────────────────────────────────────
  router.put(FLEET_ROUTES.item, async (req, res, url) => {
    const accountId = await requireAccount(req);
    const id = requireId(url);
    const { name, boats } = await readSaveRequest(req);

    const now = clock();
    const changes = await repos.fleets.update({
      id,
      accountId,
      name,
      data: JSON.stringify(boats),
      boatCount: boats.length,
      points: fleetCost(boats),
      now,
    });

    if (changes === 0) throw new FleetError('not_found', 'No such fleet.', 404);
    onFleetChanged?.(accountId, id);

    const existing = await repos.fleets.findById(id);
    const body: FleetResponse = {
      fleet: {
        id,
        name,
        boats,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      },
    };
    sendJson(res, 200, body);
  });

  // ── delete ────────────────────────────────────────────────────────────────────
  router.delete(FLEET_ROUTES.item, async (req, res, url) => {
    const accountId = await requireAccount(req);
    const id = requireId(url);
    const changes = await repos.fleets.remove(id, accountId);
    if (changes === 0) throw new FleetError('not_found', 'No such fleet.', 404);
    onFleetChanged?.(accountId, id);
    sendNoContent(res);
  });
}

// ── inbound parsing ─────────────────────────────────────────────────────────────────

/**
 * Reads and validates a save request.
 *
 * Everything is checked field by field rather than cast: this is untrusted input, and the
 * validation is the *same shared function* the editor ran before submitting, so the server
 * and the client cannot disagree about what a legal fleet is (planning/05 §2).
 */
async function readSaveRequest(
  req: IncomingMessage,
): Promise<{ name: string; boats: BoatTemplate[] }> {
  const raw = await readJsonBody(req);
  if (typeof raw !== 'object' || raw === null) {
    throw new FleetError('bad_request', 'Malformed request.', 400);
  }

  const input = raw as Record<string, unknown>;
  if (typeof input['name'] !== 'string' || !Array.isArray(input['boats'])) {
    throw new FleetError('bad_request', 'A fleet needs a name and a list of boats.', 400);
  }

  const name = normalizeName(input['name']);
  const boats = input['boats'].map(readBoat);

  const { problem, boatIndex } = validateFleet(name, boats);
  if (problem !== null) {
    const where = boatIndex === undefined ? '' : ` (boat ${String(boatIndex + 1)})`;
    throw new FleetError('validation_failed', `${describeFleetProblem(problem)}${where}`, 400);
  }

  // Repaired after validation, not before: validation is what rejects a malicious payload,
  // and repair is what tolerates an honest one saved against older content tables.
  return { name, boats: boats.map(repairBoat) };
}

function readBoat(raw: unknown): BoatTemplate {
  if (typeof raw !== 'object' || raw === null) {
    throw new FleetError('bad_request', 'Malformed boat.', 400);
  }
  const input = raw as Record<string, unknown>;

  if (typeof input['name'] !== 'string' || !isHullId(input['hull'])) {
    throw new FleetError('bad_request', 'A boat needs a name and a hull.', 400);
  }

  const modulesRaw = Array.isArray(input['modules']) ? input['modules'] : [];
  const modules: FittedModule[] = [];

  for (const entry of modulesRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const fitted = entry as Record<string, unknown>;
    if (fitted['slot'] !== 'equipment' && fitted['slot'] !== 'weapon') continue;
    if (!isModuleId(fitted['module'])) continue;
    if (typeof fitted['index'] !== 'number') continue;
    modules.push({ slot: fitted['slot'], index: fitted['index'], module: fitted['module'] });
  }

  return { name: normalizeName(input['name']), hull: input['hull'], modules };
}

/**
 * A stored row as a `Fleet`.
 *
 * Exported because match start needs the same reading: the boats it deploys have to be the
 * boats the editor saved, repaired the same way, or a fleet that loads fine in the builder
 * would deploy differently. One parser, two callers.
 */
export function toFleet(row: FleetRow): Fleet {
  let boats: BoatTemplate[] = [];
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (Array.isArray(parsed)) boats = parsed.map((b) => repairBoat(b as BoatTemplate));
  } catch {
    // A fleet whose JSON no longer parses is returned empty rather than 500ing the load
    // list. The player can see it, name it, and delete it.
    boats = [];
  }

  return {
    id: row.id,
    name: row.name,
    boats,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
