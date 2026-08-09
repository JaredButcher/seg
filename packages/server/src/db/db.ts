import type { SqlDialect } from './dialect.js';

/**
 * The only thing repositories talk to. One implementation per engine (planning/01 §4.4).
 *
 * The interface is async even though better-sqlite3 is synchronous, because Postgres is
 * genuinely async and repositories must be written once for both. Paying a microtask per
 * query is the cost of not reimplementing every repository later.
 */
export interface Db {
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  exec(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  readonly dialect: SqlDialect;
  close(): Promise<void>;
}
