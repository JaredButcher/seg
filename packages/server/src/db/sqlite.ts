import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { Db } from './db.js';
import { sqliteDialect } from './dialect.js';

/**
 * SQLite is single-writer. The settings below are not optional — the default rollback
 * journal produces lock contention the first time two players save at once (planning/07 §6.1).
 */
function configure(raw: Database.Database): void {
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('foreign_keys = ON');
  raw.pragma('synchronous = NORMAL');
}

class SqliteDb implements Db {
  readonly dialect = sqliteDialect;

  constructor(
    private readonly raw: Database.Database,
    private readonly inTransaction: boolean,
  ) {}

  query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return Promise.resolve(this.raw.prepare(sql).all(...params) as T[]);
  }

  queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return Promise.resolve(this.raw.prepare(sql).get(...params) as T | undefined);
  }

  exec(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const info = this.raw.prepare(sql).run(...params);
    return Promise.resolve({ changes: info.changes });
  }

  /**
   * BEGIN IMMEDIATE, not BEGIN: it takes the write lock up front rather than discovering
   * the conflict partway through and failing with SQLITE_BUSY.
   *
   * better-sqlite3's own `transaction()` helper cannot be used here because it requires a
   * synchronous callback, and this interface is async for Postgres's sake.
   */
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this); // already inside one; join it
    this.raw.prepare('BEGIN IMMEDIATE').run();
    try {
      const result = await fn(new SqliteDb(this.raw, true));
      this.raw.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try {
        this.raw.prepare('ROLLBACK').run();
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw err;
    }
  }

  execScript(sql: string): void {
    this.raw.exec(sql);
  }

  close(): Promise<void> {
    this.raw.close();
    return Promise.resolve();
  }
}

export type SqliteDatabase = Db & { execScript(sql: string): void };

/** `:memory:` is supported and is what the tests use. */
export function openSqlite(file: string): SqliteDatabase {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new Database(file);
  configure(raw);
  return new SqliteDb(raw, false);
}
