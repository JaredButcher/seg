import type { Db } from '../db.js';

export interface AccountRow {
  id: string;
  username: string;
  username_lower: string;
  password_hash: string;
  recovery_hash: string | null;
  created_at: number;
  last_seen_at: number;
  deleted_at: number | null;
}

export interface CreateAccountInput {
  readonly id: string;
  readonly username: string;
  readonly usernameLower: string;
  readonly passwordHash: string;
  readonly now: number;
}

export interface AccountRepo {
  create(input: CreateAccountInput): Promise<void>;
  findByUsernameKey(usernameLower: string): Promise<AccountRow | undefined>;
  findById(id: string): Promise<AccountRow | undefined>;
  usernameExists(usernameLower: string): Promise<boolean>;
  touchLastSeen(id: string, now: number): Promise<void>;
}

/**
 * Written once and run against both engines. There is no SQLite-specific and no
 * Postgres-specific version of this file — that is the whole portability guarantee
 * (planning/01 §3.1).
 */
export function createAccountRepo(db: Db): AccountRepo {
  const sql = (text: string) => db.dialect.placeholders(text);

  return {
    async create(input) {
      await db.exec(
        sql(`
          INSERT INTO account
            (id, username, username_lower, password_hash, recovery_hash, created_at, last_seen_at, deleted_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
        `),
        [input.id, input.username, input.usernameLower, input.passwordHash, input.now, input.now],
      );
    },

    findByUsernameKey(usernameLower) {
      return db.queryOne<AccountRow>(
        sql('SELECT * FROM account WHERE username_lower = ? AND deleted_at IS NULL'),
        [usernameLower],
      );
    },

    findById(id) {
      return db.queryOne<AccountRow>(
        sql('SELECT * FROM account WHERE id = ? AND deleted_at IS NULL'),
        [id],
      );
    },

    async usernameExists(usernameLower) {
      // Includes soft-deleted accounts: a deleted username is not recycled, so an old
      // player's name cannot be claimed and used to impersonate them.
      const row = await db.queryOne<{ one: number }>(
        sql('SELECT 1 AS one FROM account WHERE username_lower = ?'),
        [usernameLower],
      );
      return row !== undefined;
    },

    async touchLastSeen(id, now) {
      await db.exec(sql('UPDATE account SET last_seen_at = ? WHERE id = ?'), [now, id]);
    },
  };
}
