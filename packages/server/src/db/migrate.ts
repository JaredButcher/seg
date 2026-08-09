import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Db } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

interface MigrationRow {
  id: string;
}

/**
 * A deliberately small runner: numbered `.sql` files, applied in filename order, each in
 * its own transaction, recorded in `schema_migration`. No framework (planning/01 §3).
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id         TEXT   PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);

  const applied = new Set(
    (await db.query<MigrationRow>('SELECT id FROM schema_migration')).map((r) => r.id),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(new URL(file, `file://${MIGRATIONS_DIR}`), 'utf8');

    await db.transaction(async (tx) => {
      // Migration files contain multiple statements, which the prepared-statement path
      // cannot run. Split on semicolons at end of line — adequate because migrations are
      // ours and contain no semicolons inside literals.
      for (const statement of splitStatements(sql)) {
        await tx.exec(statement);
      }
      await tx.exec('INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)', [
        file,
        Date.now(),
      ]);
    });

    newlyApplied.push(file);
  }

  return newlyApplied;
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => stripComments(s).trim())
    .filter((s) => s.length > 0);
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}
