/** Server configuration, read once at startup. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** SQLite file path, or `:memory:`. */
  readonly databaseFile: string;
  /** Whether to set `Secure` on cookies. Must be on in production. */
  readonly secureCookies: boolean;
  /** Whether to believe `X-Forwarded-For`. Only behind our own reverse proxy. */
  readonly trustProxy: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535, got: ${raw}`);
  }
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false, got: ${raw}`);
}

export function loadConfig(): ServerConfig {
  const production = process.env['NODE_ENV'] === 'production';

  return {
    host: process.env['SEG_HOST'] ?? '127.0.0.1',
    port: envInt('SEG_PORT', 8787),
    databaseFile: process.env['SEG_DB'] ?? 'data/seg.db',
    // Defaults to on in production, off for plain-http local dev — where `Secure` would
    // make the cookie silently never arrive.
    secureCookies: envBool('SEG_SECURE_COOKIES', production),
    trustProxy: envBool('SEG_TRUST_PROXY', false),
  };
}
