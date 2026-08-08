import { useEffect } from 'react';

import { useAuth } from './state/auth.js';
import { useLobby } from './state/lobby.js';
import type { Screen } from './state/nav.js';
import { useNav } from './state/nav.js';
import { AuthScreen } from './ui/AuthScreen.js';
import { BrowseLobbiesScreen } from './ui/BrowseLobbiesScreen.js';
import { CreateLobbyScreen } from './ui/CreateLobbyScreen.js';
import { FleetEditorScreen } from './ui/FleetEditorScreen.js';
import { Home } from './ui/Home.js';
import { JoinLobbyScreen } from './ui/JoinLobbyScreen.js';
import { LobbyScreen } from './ui/LobbyScreen.js';

/**
 * Screens that need an account. Browsing lobbies deliberately does not — see the note in
 * ui/Home.tsx, and planning/12 Q17.
 */
const REQUIRES_ACCOUNT: ReadonlySet<Screen> = new Set<Screen>([
  'lobby-create',
  'lobby-join',
  'lobby',
  'fleet-editor',
]);

export function App() {
  const status = useAuth((s) => s.status);
  const restore = useAuth((s) => s.restore);
  const screen = useNav((s) => s.screen);
  const authTab = useNav((s) => s.authTab);

  useEffect(() => {
    void restore();
  }, [restore]);

  /*
   * Open the socket as soon as there is an account, rather than on the first lobby action.
   *
   * Lobby membership lives on the account, not on the connection, so a tab that has not
   * connected cannot know it is already in a lobby — it shows the main menu while the server
   * considers the player seated, and every create or join comes back `already_in_lobby` with
   * nothing on screen to explain it. Connecting on mount is what makes a second tab, or a
   * reload, recover the lobby the player is actually in.
   */
  useEffect(() => {
    if (status !== 'signedIn') return;
    // A failure here is not actionable: the player is on a menu, and the next action they
    // take will retry and surface its own error.
    void useLobby
      .getState()
      .connect()
      .catch(() => undefined);
  }, [status]);

  // Showing the login form before we know whether the cookie is valid makes a signed-in
  // player watch the form flash and vanish, which reads as a bug.
  if (status === 'restoring') {
    return (
      <main className="screen">
        <p className="muted" role="status">
          Restoring session…
        </p>
      </main>
    );
  }

  switch (resolve(screen, status === 'signedIn')) {
    case 'auth':
      return <AuthScreen initialTab={authTab} />;
    case 'lobby-create':
      return <CreateLobbyScreen />;
    case 'lobby-join':
      return <JoinLobbyScreen />;
    case 'lobby-browse':
      return <BrowseLobbiesScreen />;
    case 'lobby':
      return <LobbyScreen />;
    case 'fleet-editor':
      return <FleetEditorScreen />;
    case 'home':
      return <Home />;
  }
}

/**
 * Which screen actually renders, given where the player navigated and whether they are
 * signed in.
 *
 * Derived rather than applied as an effect: signing in from the auth screen must land on
 * the menu in the same paint, and a session that expires while a gated screen is open must
 * not leave that screen visible for a frame. Keeping the rule pure also keeps the nav store
 * free of auth knowledge.
 */
function resolve(screen: Screen, signedIn: boolean): Screen {
  if (signedIn && screen === 'auth') return 'home';
  if (!signedIn && REQUIRES_ACCOUNT.has(screen)) return 'home';
  return screen;
}
