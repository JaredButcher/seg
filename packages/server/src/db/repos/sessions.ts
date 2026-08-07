import type { Db } from '../db.js';

export interface SessionRow {
  token_hash: string;
  account_id: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  remember: number;
  user_agent: string | null;
}

export interface CreateSessionInput {
  readonly tokenHash: string;
  readonly accountId: string;
  readonly now: number;
  readonly expiresAt: number;
  readonly remember: boolean;
  readonly userAgent: string | null;
}

export interface SessionRepo {
  create(input: CreateSessionInput): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionRow | undefined>;
  touch(tokenHash: string, lastUsedAt: number, expiresAt: number): Promise<void>;
  deleteByTokenHash(tokenHash: string): Promise<number>;
  deleteAllForAccount(accountId: string): Promise<number>;
  deleteExpired(now: number): Promise<number>;
}

export function createSessionRepo(db: Db): SessionRepo {
  const sql = (text: string) => db.dialect.placeholders(text);

  return {
    async create(input) {
      await db.exec(
        sql(`
          INSERT INTO session
            (token_hash, account_id, created_at, expires_at, last_used_at, remember, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `),
        [
          input.tokenHash,
          input.accountId,
          input.now,
          input.expiresAt,
          input.now,
          input.remember ? 1 : 0,
          input.userAgent,
        ],
      );
    },

    findByTokenHash(tokenHash) {
      return db.queryOne<SessionRow>(sql('SELECT * FROM session WHERE token_hash = ?'), [
        tokenHash,
      ]);
    },

    async touch(tokenHash, lastUsedAt, expiresAt) {
      await db.exec(
        sql('UPDATE session SET last_used_at = ?, expires_at = ? WHERE token_hash = ?'),
        [lastUsedAt, expiresAt, tokenHash],
      );
    },

    async deleteByTokenHash(tokenHash) {
      const { changes } = await db.exec(sql('DELETE FROM session WHERE token_hash = ?'), [
        tokenHash,
      ]);
      return changes;
    },

    async deleteAllForAccount(accountId) {
      const { changes } = await db.exec(sql('DELETE FROM session WHERE account_id = ?'), [
        accountId,
      ]);
      return changes;
    },

    async deleteExpired(now) {
      const { changes } = await db.exec(sql('DELETE FROM session WHERE expires_at <= ?'), [now]);
      return changes;
    },
  };
}
