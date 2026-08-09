import {
  type AuthenticatedResponse,
  AUTH_ROUTES,
  type LoginRequest,
  type LogoutResponse,
  type SignupRequest,
} from '@seg/shared';

import { request } from './http.js';

/**
 * The request bodies are the shared contract types, so a route that changes shape breaks
 * this file at compile time rather than at runtime.
 */
export const authApi = {
  signup(body: SignupRequest): Promise<AuthenticatedResponse> {
    return request<AuthenticatedResponse>(AUTH_ROUTES.signup, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  login(body: LoginRequest): Promise<AuthenticatedResponse> {
    return request<AuthenticatedResponse>(AUTH_ROUTES.login, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  me(): Promise<AuthenticatedResponse> {
    return request<AuthenticatedResponse>(AUTH_ROUTES.me);
  },

  logout(): Promise<LogoutResponse> {
    return request<LogoutResponse>(AUTH_ROUTES.logout, { method: 'POST', body: '{}' });
  },

  logoutAll(): Promise<LogoutResponse> {
    return request<LogoutResponse>(AUTH_ROUTES.logoutAll, { method: 'POST', body: '{}' });
  },
};
