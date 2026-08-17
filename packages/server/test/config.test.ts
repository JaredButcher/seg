import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const KEYS = [
  'SEG_HOST',
  'SEG_PORT',
  'SEG_DB',
  'SEG_SECURE_COOKIES',
  'SEG_TRUST_PROXY',
  'NODE_ENV',
] as const;

const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of saved) {
    if (value !== undefined) process.env[key] = value;
  }
  saved.clear();
});

function setEnv(key: (typeof KEYS)[number], value: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}

describe('loadConfig', () => {
  it('defaults to loopback, 8787, and a file-backed database', () => {
    expect(loadConfig()).toEqual({
      host: '127.0.0.1',
      port: 8787,
      databaseFile: 'data/seg.db',
      secureCookies: false,
      trustProxy: false,
      // One worker thread per match, and the ceiling on how many (`match/worker/pool.ts`).
      maxConcurrentMatches: 32,
    });
  });

  it('reads the match cap from the environment, and refuses a nonsensical one', () => {
    setEnv('SEG_MAX_MATCHES', '4');
    expect(loadConfig().maxConcurrentMatches).toBe(4);

    // Not a port, so not the 0–65535 range `envInt` enforces — and zero is refused rather than
    // read as "no matches", because a server that silently cannot start one is worse than a
    // server that will not boot (`config.ts#envCount`).
    setEnv('SEG_MAX_MATCHES', '0');
    expect(() => loadConfig()).toThrow(/at least 1/);

    setEnv('SEG_MAX_MATCHES', 'lots');
    expect(() => loadConfig()).toThrow(/at least 1/);

    setEnv('SEG_MAX_MATCHES', '70000');
    expect(loadConfig().maxConcurrentMatches).toBe(70_000);
  });

  it('reads host, port, and database path from the environment', () => {
    setEnv('SEG_HOST', '0.0.0.0');
    setEnv('SEG_PORT', '9000');
    setEnv('SEG_DB', '/tmp/test.db');

    expect(loadConfig()).toMatchObject({
      host: '0.0.0.0',
      port: 9000,
      databaseFile: '/tmp/test.db',
    });
  });

  it('rejects a port that is not a valid integer in range', () => {
    setEnv('SEG_PORT', '70000');
    expect(() => loadConfig()).toThrow(/between 0 and 65535/);

    setEnv('SEG_PORT', 'not-a-port');
    expect(() => loadConfig()).toThrow(/between 0 and 65535/);
  });

  it('turns on Secure cookies in production without being asked', () => {
    setEnv('NODE_ENV', 'production');
    expect(loadConfig().secureCookies).toBe(true);
  });

  it('leaves Secure cookies off in development, where plain http would drop them', () => {
    expect(loadConfig().secureCookies).toBe(false);
  });

  it('allows Secure cookies to be forced either way', () => {
    setEnv('SEG_SECURE_COOKIES', 'true');
    expect(loadConfig().secureCookies).toBe(true);

    setEnv('NODE_ENV', 'production');
    setEnv('SEG_SECURE_COOKIES', 'false');
    expect(loadConfig().secureCookies).toBe(false);
  });

  it('does not trust X-Forwarded-For unless told to', () => {
    expect(loadConfig().trustProxy).toBe(false);

    setEnv('SEG_TRUST_PROXY', '1');
    expect(loadConfig().trustProxy).toBe(true);
  });

  it('rejects a non-boolean flag rather than guessing', () => {
    setEnv('SEG_TRUST_PROXY', 'yes');
    expect(() => loadConfig()).toThrow(/must be true or false/);
  });
});
