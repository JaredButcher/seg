import type { Db } from '../db.js';

export interface FleetRow {
  id: string;
  account_id: string;
  name: string;
  data: string;
  boat_count: number;
  points: number;
  created_at: number;
  updated_at: number;
}

/** The columns the load list needs. Deliberately excludes `data`. */
export interface FleetSummaryRow {
  id: string;
  name: string;
  boat_count: number;
  points: number;
  updated_at: number;
}

export interface SaveFleetInput {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  /** Already-serialised boat list. The repository does not know what is inside it. */
  readonly data: string;
  readonly boatCount: number;
  readonly points: number;
  readonly now: number;
}

export interface FleetRepo {
  listByAccount(accountId: string): Promise<FleetSummaryRow[]>;
  findById(id: string): Promise<FleetRow | undefined>;
  countByAccount(accountId: string): Promise<number>;
  create(input: SaveFleetInput): Promise<void>;
  update(input: SaveFleetInput): Promise<number>;
  remove(id: string, accountId: string): Promise<number>;
}

/**
 * Written once and run against both engines. There is no SQLite-specific and no
 * Postgres-specific version of this file (planning/01 §3.1).
 */
export function createFleetRepo(db: Db): FleetRepo {
  const sql = (text: string) => db.dialect.placeholders(text);

  return {
    async listByAccount(accountId) {
      // Newest edit first: the fleet you were last working on is the one you want again.
      return db.query<FleetSummaryRow>(
        sql(`
          SELECT id, name, boat_count, points, updated_at
          FROM fleet
          WHERE account_id = ?
          ORDER BY updated_at DESC
        `),
        [accountId],
      );
    },

    async findById(id) {
      const rows = await db.query<FleetRow>(sql('SELECT * FROM fleet WHERE id = ?'), [id]);
      return rows[0];
    },

    async countByAccount(accountId) {
      const rows = await db.query<{ n: number }>(
        sql('SELECT COUNT(*) AS n FROM fleet WHERE account_id = ?'),
        [accountId],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async create(input) {
      await db.exec(
        sql(`
          INSERT INTO fleet (id, account_id, name, data, boat_count, points, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `),
        [
          input.id,
          input.accountId,
          input.name,
          input.data,
          input.boatCount,
          input.points,
          input.now,
          input.now,
        ],
      );
    },

    async update(input) {
      // `account_id` is in the WHERE clause, not just the lookup: an update naming someone
      // else's fleet id must change zero rows rather than succeed. Ownership is enforced by
      // the query, so it cannot be forgotten by a caller.
      const { changes } = await db.exec(
        sql(`
          UPDATE fleet
          SET name = ?, data = ?, boat_count = ?, points = ?, updated_at = ?
          WHERE id = ? AND account_id = ?
        `),
        [
          input.name,
          input.data,
          input.boatCount,
          input.points,
          input.now,
          input.id,
          input.accountId,
        ],
      );
      return changes;
    },

    async remove(id, accountId) {
      const { changes } = await db.exec(sql('DELETE FROM fleet WHERE id = ? AND account_id = ?'), [
        id,
        accountId,
      ]);
      return changes;
    },
  };
}
