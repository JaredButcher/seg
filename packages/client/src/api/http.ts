import type { ApiErrorBody, AuthErrorCode } from '@seg/shared';

/** A structured failure from the API. Forms read `code` and `field` to place messages. */
export class ApiError extends Error {
  constructor(
    readonly code: AuthErrorCode | 'network_error',
    message: string,
    readonly status: number,
    readonly field?: 'username' | 'password',
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isApiErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/**
 * JSON request helper.
 *
 * `credentials: 'same-origin'` is explicit rather than relied upon: the session cookie is
 * the only thing authenticating a request, and a silent default is a bad thing to depend on.
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(
      'network_error',
      'Could not reach the server. Check your connection and try again.',
      0,
    );
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiError(
        body.error.code,
        body.error.message,
        response.status,
        body.error.field,
        body.error.retryAfterSeconds,
      );
    }
    throw new ApiError('internal_error', 'Something went wrong.', response.status);
  }

  return body as T;
}
