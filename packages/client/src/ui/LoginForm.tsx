import { type FormEvent, useState } from 'react';

import { ApiError } from '../api/http.js';
import { useAuth } from '../state/auth.js';
import { Button, Checkbox, Field, FormError } from './controls.js';

export function LoginForm() {
  const login = useAuth((s) => s.login);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    setError(null);
    setBusy(true);
    try {
      await login(username, password, rememberMe);
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError('internal_error', 'Sign-in failed.', 0),
      );
    } finally {
      setBusy(false);
    }
  }

  // Sign-in deliberately does no client-side validation of the credential *rules*.
  // Telling someone their password is too short to be correct is a rule disclosure, and
  // the server's answer is identical either way.
  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  return (
    <form className="form" onSubmit={onSubmit} noValidate>
      <Field
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={username}
        disabled={busy}
        onChange={(e) => setUsername(e.target.value)}
        error={error?.field === 'username' ? error.message : undefined}
      />

      <Field
        label="Password"
        name="password"
        type={revealed ? 'text' : 'password'}
        autoComplete="current-password"
        value={password}
        disabled={busy}
        revealable
        revealed={revealed}
        onToggleReveal={() => setRevealed((v) => !v)}
        onChange={(e) => setPassword(e.target.value)}
        error={error?.field === 'password' ? error.message : undefined}
      />

      <Checkbox
        label="Keep me signed in"
        checked={rememberMe}
        disabled={busy}
        onChange={setRememberMe}
      />

      {error && error.field === undefined && (
        <FormError>
          {error.message}
          {error.retryAfterSeconds !== undefined && (
            <> Try again in {formatRetry(error.retryAfterSeconds)}.</>
          )}
        </FormError>
      )}

      <Button type="submit" disabled={!canSubmit} busy={busy}>
        SIGN IN
      </Button>
    </form>
  );
}

export function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
