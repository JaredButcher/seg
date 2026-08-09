import type { AddressInfo } from 'node:net';

import { type App, createApp } from '../src/app.js';

export interface TestApp {
  readonly app: App;
  readonly baseUrl: string;
  /** Advances the injected clock. Tests never sleep. */
  advance(ms: number): void;
  setNow(ms: number): void;
  close(): Promise<void>;
}

/**
 * Boots the real server against an in-memory database on an ephemeral port, with a
 * controllable clock. Everything below this line is production code — the tests exercise
 * real HTTP, real SQLite, and real argon2.
 */
export async function startTestApp(startTime = 1_700_000_000_000): Promise<TestApp> {
  let now = startTime;

  const app = await createApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      databaseFile: ':memory:',
      secureCookies: false,
      trustProxy: false,
    },
    clock: () => now,
  });

  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;

  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    advance: (ms) => {
      now += ms;
    },
    setNow: (ms) => {
      now = ms;
    },
    close: () => app.close(),
  };
}

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly setCookie: string | null;
  readonly headers: Headers;
}

/** A minimal HTTP client that does not follow cookies automatically, so tests are explicit. */
export async function api<T = unknown>(
  baseUrl: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    cookie?: string | null;
    contentType?: string | null;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...init.headers };

  const hasBody = init.body !== undefined || init.rawBody !== undefined;
  if (hasBody && init.contentType !== null) {
    headers['content-type'] = init.contentType ?? 'application/json';
  }
  if (init.cookie) headers['cookie'] = init.cookie;

  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });

  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  return {
    status: res.status,
    body: body as T,
    setCookie: res.headers.get('set-cookie'),
    headers: res.headers,
  };
}

/** Extracts `name=value` from a Set-Cookie header, ready to send back as a Cookie header. */
export function cookieValue(setCookie: string | null): string {
  if (setCookie === null) throw new Error('expected a Set-Cookie header');
  const first = setCookie.split(';')[0];
  if (first === undefined) throw new Error(`malformed Set-Cookie: ${setCookie}`);
  return first;
}

export function cookieAttributes(setCookie: string | null): string[] {
  if (setCookie === null) throw new Error('expected a Set-Cookie header');
  return setCookie
    .split(';')
    .slice(1)
    .map((s) => s.trim());
}
