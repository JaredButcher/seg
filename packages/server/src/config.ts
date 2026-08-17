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
  /**
   * How many matches may run at once, each on its own worker thread (planning/01 §1).
   *
   * A hard refusal rather than a soft target: at the cap `lobby.start` is rejected and the lobby
   * survives, because the alternative — admitting the match anyway — degrades every match already
   * running rather than the one that arrived last.
   *
   * 32 is a starting figure, not a measured one. `pnpm --filter @seg/tools bench:netcode:concurrency`
   * is what turns it into a measured one for a given box, and the number that matters there is p99
   * tick slip rather than mean utilization.
   */
  readonly maxConcurrentMatches: number;
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

/**
 * A positive count, with no upper bound of its own.
 *
 * Separate from `envInt` because that one's 0–65535 range is a *port* range, and borrowing it
 * here would report a match cap of 70000 as a bad port number. Zero is refused rather than read
 * as "no matches": a server that silently cannot start a match is worse than one that will not
 * boot, and turning matches off is not a thing anybody wants to do by typing a zero.
 */
function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be an integer of at least 1, got: ${raw}`);
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
    maxConcurrentMatches: envCount('SEG_MAX_MATCHES', 32),
  };
}
