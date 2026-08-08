import type { ReactNode } from 'react';
import { useState } from 'react';

import { useAuth } from '../state/auth.js';
import type { Screen } from '../state/nav.js';
import { useNav } from '../state/nav.js';
import { Button } from './controls.js';

/**
 * The home page — the first screen after the session is resolved, and the hub every other
 * screen returns to (planning/08 §2, "Main Menu").
 *
 * The menu is state-dependent rather than uniformly disabled: a signed-out player is
 * offered the two account actions, and a signed-in one gets the four game actions plus
 * sign-out. The one exception is browsing lobbies, which is offered in both states — see
 * the note on that action below.
 */
export function Home() {
  const status = useAuth((s) => s.status);

  return status === 'signedIn' ? <SignedInMenu /> : <SignedOutMenu />;
}

// ── signed out ──────────────────────────────────────────────────────────────────

function SignedOutMenu() {
  const goToAuth = useNav((s) => s.goToAuth);
  const go = useNav((s) => s.go);

  return (
    <main className="screen">
      <Masthead />

      <div className="panel">
        <div className="panel__body">
          <p className="pitch">
            Two fleets. One cave system. You see nothing but what your boats can hear.
          </p>

          <div className="actions">
            <Button onClick={() => goToAuth('signIn')}>SIGN IN</Button>
            <Button variant="ghost" onClick={() => goToAuth('create')}>
              CREATE ACCOUNT
            </Button>
          </div>

          {/*
            Reachable without an account on purpose. planning/12 Q17 and risk R4: with no
            matchmaking and no bots at 1.0, making someone sign up before they can even see
            whether anyone is online is a funnel loss the game cannot afford.
          */}
          <p className="home__aside">
            <button type="button" className="link" onClick={() => go('lobby-browse')}>
              Browse open lobbies
            </button>{' '}
            without signing in.
          </p>
        </div>
      </div>
    </main>
  );
}

// ── signed in ───────────────────────────────────────────────────────────────────

function SignedInMenu() {
  const account = useAuth((s) => s.account);
  const session = useAuth((s) => s.session);
  const logout = useAuth((s) => s.logout);
  const logoutEverywhere = useAuth((s) => s.logoutEverywhere);
  const go = useNav((s) => s.go);

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
    <main className="screen">
      <Masthead />

      <div className="panel">
        <div className="panel__body">
          <nav className="menu" aria-label="Main menu">
            <MenuAction
              screen="lobby-create"
              label="CREATE LOBBY"
              description="Host a match. You choose the mode, the map seed, and the point budget."
              onSelect={go}
            />
            <MenuAction
              screen="lobby-join"
              label="JOIN WITH CODE"
              description="Enter the six-character code a host gave you."
              onSelect={go}
            />
            <MenuAction
              screen="lobby-browse"
              label="BROWSE LOBBIES"
              description="Every public lobby, sorted by which is most likely to start soon."
              onSelect={go}
            />
            <MenuAction
              screen="fleet-editor"
              label="FLEET EDITOR"
              description="Build and save the fleets you bring into a match."
              onSelect={go}
            />
          </nav>
        </div>

        <div className="panel__foot">
          <dl className="account">
            <dt className="visually-hidden">Signed in as</dt>
            <dd className="account__name">{account.username}</dd>
            <dt className="visually-hidden">Session</dt>
            <dd className="account__session">
              {session?.remembered === true ? 'Persistent session' : 'This browser session'}
            </dd>
          </dl>

          <div className="account__actions">
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

// ── pieces ──────────────────────────────────────────────────────────────────────

function Masthead() {
  return (
    <header className="screen__header">
      <h1 className="screen__title">SEG</h1>
      <p className="screen__subtitle">Submarine fleet command</p>
    </header>
  );
}

interface MenuActionProps {
  screen: Screen;
  label: string;
  description: ReactNode;
  onSelect: (screen: Screen) => void;
}

/**
 * A menu entry is a button carrying its own explanation, not a bare word.
 *
 * The description is inside the button rather than beside it so the accessible name a
 * screen reader announces is the whole entry — "Join with code, enter the six-character
 * code a host gave you" — which is exactly what a sighted player reads.
 */
function MenuAction({ screen, label, description, onSelect }: MenuActionProps) {
  return (
    <button type="button" className="menu__item" onClick={() => onSelect(screen)}>
      <span className="menu__label">{label}</span>
      <span className="menu__description">{description}</span>
    </button>
  );
}
