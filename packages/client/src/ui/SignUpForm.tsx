import {
  describeProblem,
  PASSWORD_MIN_LENGTH,
  passwordLength,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validatePassword,
  validateUsername,
} from '@seg/shared';
import { type FormEvent, useState } from 'react';

import { ApiError } from '../api/http.js';
import { useAuth } from '../state/auth.js';
import { Button, Checkbox, Field, FormError } from './controls.js';
import { formatRetry } from './LoginForm.js';

export function SignUpForm() {
  const signup = useAuth((s) => s.signup);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // The same validators the server enforces with, imported from @seg/shared. Errors are
  // held back until submit so the form does not shout at someone mid-typing.
  const usernameProblem = validateUsername(username);
  const passwordProblem = validatePassword(password);
  const confirmMismatch = confirm.length > 0 && confirm !== password;

  const usernameError =
    error?.field === 'username'
      ? error.message
      : submitted && usernameProblem
        ? describeProblem(usernameProblem)
        : undefined;

  const passwordError =
    error?.field === 'password'
      ? error.message
      : submitted && passwordProblem
        ? describeProblem(passwordProblem)
        : undefined;

  const confirmError =
    (submitted || confirm.length > 0) && confirmMismatch ? 'Passwords do not match.' : undefined;

  const acknowledgedError =
    submitted && !acknowledged
      ? 'Please confirm you understand this before continuing.'
      : undefined;

  const valid =
    usernameProblem === null && passwordProblem === null && !confirmMismatch && acknowledged;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);

    if (!valid || busy) return;

    setBusy(true);
    try {
      await signup(username, password, rememberMe);
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError('internal_error', 'Sign-up failed.', 0),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit} noValidate>
      {/*
        planning/07 §2: this warning appears before the form, not as fine print, because
        the consequence is permanent and irreversible. The acknowledgement below is
        required, not advisory.
      */}
      <aside className="callout callout--warning" aria-labelledby="no-recovery-heading">
        <h2 className="callout__title" id="no-recovery-heading">
          There is no password reset
        </h2>
        <p>
          We store a username and a password. No email address, no security questions, nothing else.
          That means <strong>nobody can recover your account for you</strong> — not you, not us.
        </p>
        <p>
          If you forget your password, your account and every fleet you have saved are gone
          permanently. Use a password manager.
        </p>
      </aside>

      <Field
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={USERNAME_MAX_LENGTH}
        value={username}
        disabled={busy}
        onChange={(e) => setUsername(e.target.value)}
        requirements={[
          {
            label: `${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters`,
            met:
              username.trim().length >= USERNAME_MIN_LENGTH &&
              username.trim().length <= USERNAME_MAX_LENGTH,
          },
        ]}
        hint="Letters, numbers, hyphens, and underscores."
        error={usernameError}
      />

      <Field
        label="Password"
        name="password"
        type={revealed ? 'text' : 'password'}
        autoComplete="new-password"
        value={password}
        disabled={busy}
        revealable
        revealed={revealed}
        onToggleReveal={() => setRevealed((v) => !v)}
        onChange={(e) => setPassword(e.target.value)}
        requirements={[
          {
            label: `At least ${PASSWORD_MIN_LENGTH} characters`,
            // Counted with the shared helper, so this ticks over at exactly the point the
            // server's rule is satisfied.
            met: passwordLength(password) >= PASSWORD_MIN_LENGTH,
          },
        ]}
        hint="A passphrase of a few words beats a short complicated one. There are no other requirements — no symbols, no digits, no capitals."
        error={passwordError}
      />

      {/*
        Confirmation is usually redundant. It is not here: with no recovery path, a typo
        during signup is permanent account loss on the very first use.
      */}
      <Field
        label="Confirm password"
        name="confirmPassword"
        type={revealed ? 'text' : 'password'}
        autoComplete="new-password"
        value={confirm}
        disabled={busy}
        onChange={(e) => setConfirm(e.target.value)}
        error={confirmError}
      />

      <Checkbox
        label="I understand my account cannot be recovered if I forget my password."
        checked={acknowledged}
        disabled={busy}
        onChange={setAcknowledged}
        error={acknowledgedError}
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

      <Button type="submit" busy={busy}>
        CREATE ACCOUNT
      </Button>
    </form>
  );
}
