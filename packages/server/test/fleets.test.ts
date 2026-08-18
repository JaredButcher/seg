/**
 * Fleet persistence and its HTTP surface, against the real server.
 *
 * The two things worth testing here are ownership — every route derives the account from the
 * cookie, never from the body — and that the server validates with the same shared functions
 * the editor uses, so a fleet the editor accepts is a fleet the server accepts.
 */
import {
  AUTH_ROUTES,
  FLEET_ROUTES,
  MAX_FLEETS_PER_ACCOUNT,
  type BoatTemplate,
  type FleetErrorBody,
  type FleetListResponse,
  type FleetResponse,
} from '@seg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { api, cookieValue, startTestApp, type TestApp } from './helpers.js';

const GOOD_PASSWORD = 'correct horse battery staple';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

async function account(username: string): Promise<string> {
  const res = await api(t.baseUrl, AUTH_ROUTES.signup, {
    method: 'POST',
    body: { username, password: GOOD_PASSWORD, rememberMe: true },
  });
  return cookieValue(res.setCookie);
}

function boat(name: string, hull: BoatTemplate['hull'] = 'medium'): BoatTemplate {
  return { name, hull, modules: [] };
}

const save = (cookie: string, name: string, boats: BoatTemplate[]) =>
  api<FleetResponse & FleetErrorBody>(t.baseUrl, FLEET_ROUTES.collection, {
    method: 'POST',
    cookie,
    body: { name, boats },
  });

const list = (cookie: string) =>
  api<FleetListResponse & FleetErrorBody>(t.baseUrl, FLEET_ROUTES.collection, { cookie });

const load = (cookie: string, id: string) =>
  api<FleetResponse & FleetErrorBody>(t.baseUrl, `${FLEET_ROUTES.item}?id=${id}`, { cookie });

describe('saving', () => {
  it('creates a fleet and returns it with an id', async () => {
    const cookie = await account('Skipper');

    const res = await save(cookie, 'First Wolfpack', [boat('S-01'), boat('S-02', 'light')]);

    expect(res.status).toBe(201);
    expect(res.body.fleet.name).toBe('First Wolfpack');
    expect(res.body.fleet.boats).toHaveLength(2);
    expect(res.body.fleet.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('computes the point total server-side from the content tables', async () => {
    const cookie = await account('Skipper');
    await save(cookie, 'Mixed', [boat('S-01', 'light'), boat('S-02', 'heavy')]);

    const rows = await list(cookie);

    // light 100 + heavy 200. The client is never asked what the fleet costs.
    expect(rows.body.fleets[0]?.points).toBe(300);
    expect(rows.body.fleets[0]?.boatCount).toBe(2);
  });

  it('counts fitted modules toward the total', async () => {
    const cookie = await account('Skipper');
    await save(cookie, 'Fitted', [
      {
        name: 'S-01',
        hull: 'light',
        modules: [{ slot: 'equipment', index: 0, module: 'towed-array' }],
      },
    ]);

    // light 100 + towed array 40.
    expect((await list(cookie)).body.fleets[0]?.points).toBe(140);
  });

  it('overwrites in place, keeping the id', async () => {
    const cookie = await account('Skipper');
    const created = await save(cookie, 'Wolfpack', [boat('S-01')]);
    const id = created.body.fleet.id;

    const updated = await api<FleetResponse>(t.baseUrl, `${FLEET_ROUTES.item}?id=${id}`, {
      method: 'PUT',
      cookie,
      body: { name: 'Wolfpack II', boats: [boat('S-01'), boat('S-02')] },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.fleet.id).toBe(id);
    expect((await list(cookie)).body.fleets).toHaveLength(1);
    expect((await list(cookie)).body.fleets[0]?.name).toBe('Wolfpack II');
  });

  it('caps how many fleets one account can keep', async () => {
    const cookie = await account('Skipper');
    for (let i = 0; i < MAX_FLEETS_PER_ACCOUNT; i += 1) {
      await save(cookie, `Fleet ${String(i)}`, [boat('S-01')]);
    }

    const overflow = await save(cookie, 'One Too Many', [boat('S-01')]);

    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('too_many_fleets');
  });
});

describe('validation', () => {
  it('rejects a fleet with no boats', async () => {
    const cookie = await account('Skipper');
    const res = await save(cookie, 'Empty', []);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects an unknown hull rather than storing it', async () => {
    const cookie = await account('Skipper');
    const res = await api<FleetErrorBody>(t.baseUrl, FLEET_ROUTES.collection, {
      method: 'POST',
      cookie,
      body: { name: 'Bogus', boats: [{ name: 'S-01', hull: 'battlestar', modules: [] }] },
    });

    expect(res.status).toBe(400);
    expect((await list(cookie)).body.fleets).toHaveLength(0);
  });

  it('names the boat a problem belongs to', async () => {
    const cookie = await account('Skipper');
    const res = await save(cookie, 'Nameless', [boat('S-01'), boat('')]);

    expect(res.body.error.message).toMatch(/boat 2/);
  });

  it('drops a module fitted to a slot the hull does not have', async () => {
    const cookie = await account('Skipper');

    // The Light hull has one weapon slot, so index 2 does not exist.
    const res = await api<FleetErrorBody>(t.baseUrl, FLEET_ROUTES.collection, {
      method: 'POST',
      cookie,
      body: {
        name: 'Overfitted',
        boats: [
          {
            name: 'S-01',
            hull: 'light',
            modules: [{ slot: 'weapon', index: 2, module: 'extra-tube' }],
          },
        ],
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('refuses a module in the wrong kind of slot', async () => {
    const cookie = await account('Skipper');
    const res = await api<FleetErrorBody>(t.baseUrl, FLEET_ROUTES.collection, {
      method: 'POST',
      cookie,
      body: {
        name: 'Miscategorised',
        boats: [
          {
            name: 'S-01',
            hull: 'medium',
            // A weapon module in an equipment slot.
            modules: [{ slot: 'equipment', index: 0, module: 'extra-tube' }],
          },
        ],
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/does not fit/i);
  });
});

describe('ownership', () => {
  it('lists only your own fleets', async () => {
    const mine = await account('Skipper');
    const theirs = await account('Bosun');
    await save(mine, 'Mine', [boat('S-01')]);
    await save(theirs, 'Theirs', [boat('S-01')]);

    const rows = await list(mine);

    expect(rows.body.fleets).toHaveLength(1);
    expect(rows.body.fleets[0]?.name).toBe('Mine');
  });

  it('reports someone else’s fleet as missing, not as forbidden', async () => {
    const mine = await account('Skipper');
    const theirs = await account('Bosun');
    const created = await save(theirs, 'Theirs', [boat('S-01')]);

    const res = await load(mine, created.body.fleet.id);

    // A distinguishable error would confirm the id exists and hint at who owns it.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('refuses to overwrite someone else’s fleet', async () => {
    const mine = await account('Skipper');
    const theirs = await account('Bosun');
    const created = await save(theirs, 'Theirs', [boat('S-01')]);

    const res = await api<FleetErrorBody>(
      t.baseUrl,
      `${FLEET_ROUTES.item}?id=${created.body.fleet.id}`,
      { method: 'PUT', cookie: mine, body: { name: 'Hijacked', boats: [boat('S-01')] } },
    );

    expect(res.status).toBe(404);
    // And the owner's copy is untouched.
    expect((await list(theirs)).body.fleets[0]?.name).toBe('Theirs');
  });

  it('refuses to delete someone else’s fleet', async () => {
    const mine = await account('Skipper');
    const theirs = await account('Bosun');
    const created = await save(theirs, 'Theirs', [boat('S-01')]);

    const res = await api(t.baseUrl, `${FLEET_ROUTES.item}?id=${created.body.fleet.id}`, {
      method: 'DELETE',
      cookie: mine,
    });

    expect(res.status).toBe(404);
    expect((await list(theirs)).body.fleets).toHaveLength(1);
  });

  it('turns every route away without a session', async () => {
    const cookie = await account('Skipper');
    const created = await save(cookie, 'Mine', [boat('S-01')]);
    const id = created.body.fleet.id;

    for (const [method, path] of [
      ['GET', FLEET_ROUTES.collection],
      ['POST', FLEET_ROUTES.collection],
      ['GET', `${FLEET_ROUTES.item}?id=${id}`],
      ['PUT', `${FLEET_ROUTES.item}?id=${id}`],
      ['DELETE', `${FLEET_ROUTES.item}?id=${id}`],
    ] as const) {
      const res = await api<FleetErrorBody>(t.baseUrl, path, {
        method,
        body: method === 'GET' || method === 'DELETE' ? undefined : { name: 'X', boats: [] },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('loading and deleting', () => {
  it('round-trips a fleet with its modules intact', async () => {
    const cookie = await account('Skipper');
    const boats: BoatTemplate[] = [
      {
        name: 'Nautilus',
        hull: 'heavy',
        modules: [
          { slot: 'equipment', index: 0, module: 'titanium-hull' },
          { slot: 'weapon', index: 1, module: 'rapid-loader' },
        ],
      },
    ];
    const created = await save(cookie, 'Deep Patrol', boats);

    const loaded = await load(cookie, created.body.fleet.id);

    expect(loaded.body.fleet.name).toBe('Deep Patrol');
    expect(loaded.body.fleet.boats).toEqual(boats);
  });

  it('deletes, and stops listing it', async () => {
    const cookie = await account('Skipper');
    const created = await save(cookie, 'Temporary', [boat('S-01')]);

    const res = await api(t.baseUrl, `${FLEET_ROUTES.item}?id=${created.body.fleet.id}`, {
      method: 'DELETE',
      cookie,
    });

    expect(res.status).toBe(204);
    expect((await list(cookie)).body.fleets).toHaveLength(0);
  });

  it('lists most recently edited first', async () => {
    const cookie = await account('Skipper');
    await save(cookie, 'Older', [boat('S-01')]);
    t.advance(60_000);
    await save(cookie, 'Newer', [boat('S-01')]);

    expect((await list(cookie)).body.fleets.map((f) => f.name)).toEqual(['Newer', 'Older']);
  });

  it('requires an id on the item routes', async () => {
    const cookie = await account('Skipper');
    const res = await api<FleetErrorBody>(t.baseUrl, FLEET_ROUTES.item, { cookie });
    expect(res.status).toBe(400);
  });
});
