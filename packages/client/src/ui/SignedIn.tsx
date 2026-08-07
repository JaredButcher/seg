import { useState } from 'react';

import { useAuth } from '../state/auth.js';
import { Button } from './controls.js';

/**
 * Placeholder for the main menu. Everything below the account block — server browser,
 * fleet builder, practice range — arrives with M5 proper (planning/08 §2).
 */
export function SignedIn() {
  const account = useAuth((s) => s.account);
  const session = useAuth((s) => s.session);
  const logout = useAuth((s) => s.logout);
  const logoutEverywhere = useAuth((s) => s.logoutEverywhere);

  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  if (account === null) return null;

  return (
    <main className="auth">
      <header className="auth__header">
        <h1 className="auth__title">SEG</h1>
        <p className="auth__subtitle">Submarine fleet command</p>
      </header>

      <div className="panel">
        <div className="panel__body">
          <dl className="readout">
            <dt>Signed in as</dt>
            <dd>{account.username}</dd>

            <dt>Account created</dt>
            <dd>{new Date(account.createdAt).toLocaleDateString()}</dd>

            <dt>Session</dt>
            <dd>{session?.remembered === true ? 'Persistent' : 'This browser session'}</dd>
          </dl>

          <p className="muted">
            No game here yet — the simulation begins at M1. This screen exists to prove the account
            flow end to end.
          </p>

          <div className="actions">
            <Button variant="ghost" busy={busy} onClick={() => void run(logout)}>
              SIGN OUT
            </Button>
            <Button variant="ghost" busy={busy} onClick={() => void run(logoutEverywhere)}>
              SIGN OUT EVERYWHERE
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
