/**
 * The dialect shim (planning/01 §3.1).
 *
 * All SQL in this repo is written to the portable subset and uses `?` placeholders.
 * Only two things genuinely differ between SQLite and Postgres, and they live here.
 *
 * Column types need no substitution at all: TEXT, INTEGER, and BIGINT are valid in both.
 * That is why the schema uses epoch-millisecond BIGINT rather than TIMESTAMP, and
 * INTEGER 0/1 rather than BOOLEAN.
 */
export interface SqlDialect {
  readonly name: 'sqlite' | 'postgres';
  /** Rewrites `?` placeholders into this engine's parameter syntax. */
  readonly placeholders: (sql: string) => string;
}

export const sqliteDialect: SqlDialect = {
  name: 'sqlite',
  placeholders: (sql) => sql,
};

/**
 * Postgres numbers its parameters. Rewriting assumes no `?` appears inside a string
 * literal, which holds because every value in this codebase is bound, never inlined.
 */
export const postgresDialect: SqlDialect = {
  name: 'postgres',
  placeholders: (sql) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  },
};
