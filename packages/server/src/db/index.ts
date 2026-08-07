import type { Db } from './db.js';
import { migrate } from './migrate.js';
import { type AccountRepo, createAccountRepo } from './repos/accounts.js';
import { createSessionRepo, type SessionRepo } from './repos/sessions.js';
import { openSqlite } from './sqlite.js';

export type { Db } from './db.js';
export type { SqlDialect } from './dialect.js';
export { postgresDialect, sqliteDialect } from './dialect.js';
export { migrate } from './migrate.js';
export type { AccountRepo, AccountRow } from './repos/accounts.js';
export type { SessionRepo, SessionRow } from './repos/sessions.js';
export { openSqlite } from './sqlite.js';

export interface Repositories {
  readonly accounts: AccountRepo;
  readonly sessions: SessionRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    accounts: createAccountRepo(db),
    sessions: createSessionRepo(db),
  };
}

export interface OpenedDatabase {
  readonly db: Db;
  readonly repos: Repositories;
}

/** Opens SQLite, applies pending migrations, and wires the repositories. */
export async function openDatabase(file: string): Promise<OpenedDatabase> {
  const db = openSqlite(file);
  await migrate(db);
  return { db, repos: createRepositories(db) };
}
