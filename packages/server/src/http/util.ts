import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A body larger than this is rejected before it is buffered. Auth payloads are a few
 * hundred bytes; anything approaching this limit is an attack, not a user.
 */
export const MAX_BODY_BYTES = 8 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Reads and parses a JSON body.
 *
 * Requiring `application/json` is load-bearing, not pedantry: a cross-site HTML form
 * cannot set that content type without triggering a CORS preflight, so together with
 * `SameSite=Lax` cookies it closes CSRF on these endpoints without a token scheme.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'bad_request', 'Expected content-type: application/json.');
  }

  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'Request body too large.');
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Enforced against actual bytes too — content-length can lie or be absent.
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'Request body too large.');
    }
    chunks.push(buf);
  }

  if (total === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', 'Body is not valid JSON.');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // These endpoints return account state; no cache should ever hold it.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

/** Reads one cookie by name. Node gives us the raw header; there is no parser built in. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export interface CookieOptions {
  readonly maxAgeSeconds?: number;
  readonly secure: boolean;
}

export function serializeSessionCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: Strict would drop the cookie when a player follows a link
    // into the game from elsewhere, logging them out for no security gain here.
    'SameSite=Lax',
  ];
  // Omitting Max-Age makes it a session cookie, which is exactly what "don't keep me
  // logged in" means — it dies with the browser.
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function serializeClearedCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * The client IP, honouring `X-Forwarded-For` only when explicitly told to.
 *
 * Trusting that header unconditionally would let anyone spoof their way past per-IP rate
 * limiting by setting it themselves.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function userAgent(req: IncomingMessage): string | null {
  const ua = req.headers['user-agent'];
  if (typeof ua !== 'string') return null;
  return ua.slice(0, 256);
}
