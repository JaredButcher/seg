/**
 * The match screen — a full-window Pixi scope with a floating HUD (planning/08 §11).
 *
 * The store navigates here on `match.started`; this component only renders. The scope is the
 * star and React never touches the render loop; the HUD floats above it in CSS. Of the seven
 * HUD elements the Esc window is built; the rest (minimap, fleet list, score, timer, chat)
 * arrive with the sim state they describe.
 */

import { describeGameMode, describeMapSize, describeMapType } from '@seg/shared';
import { useEffect, useState } from 'react';

import { ScopeHost } from '../render/ScopeHost.js';
import { useLobby } from '../state/lobby.js';
import { useMatch } from '../state/match.js';
import { EscMenu } from './EscMenu.js';

export function MatchScreen() {
  const matchId = useMatch((s) => s.matchId);
  const states = useMatch((s) => s.states);
  const leaveMatch = useLobby((s) => s.leaveMatch);
  const state = matchId === null ? undefined : states[matchId];

  const [menuOpen, setMenuOpen] = useState(false);

  /*
   * Only the *opening* keystroke is listened for here. While the menu is up it owns Escape
   * itself, because the key means "back out of this pane" as often as it means "resume" —
   * so this listener is not registered at all in that state and the two can never both fire
   * on one press.
   */
  useEffect(() => {
    if (menuOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenuOpen(true);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  // `match.started` navigates here before `match.state` necessarily lands; the two travel
  // together on the control channel, so this is a brief splash at most.
  if (state === undefined) {
    return (
      <main className="screen screen--match">
        <p className="match__loading" role="status">
          Loading match…
        </p>
      </main>
    );
  }

  const map = state.map;

  return (
    <main className="screen screen--match">
      <ScopeHost map={map} />

      <header className="match__hud">
        <div className="match__hud-group">
          <h1 className="match__title">MATCH LIVE</h1>
          <p className="match__meta">
            {describeGameMode(state.mode)} · {describeMapType(map.mapType)} ·{' '}
            {describeMapSize(map.mapSize)}
          </p>
        </div>

        <div className="match__hud-group match__hud-group--end">
          {/*
            The Esc window is specified as a key, not a button (planning/08 §11). It gets one
            anyway: leaving is currently the only way out of a match, and a player who has not
            guessed the key would otherwise be stuck in one. The label carries the binding, so
            the button teaches the key rather than replacing it.
          */}
          <button type="button" className="match__menu" onClick={() => setMenuOpen(true)}>
            MENU <span className="match__menu-key">ESC</span>
          </button>
          <p className="match__meta match__meta--id">MATCH {state.matchId.slice(0, 8)}</p>
        </div>
      </header>

      <footer className="match__hint">
        <p className="match__meta">SCOPE ONLY · FLEET AND ORDERS ARRIVE WITH THE SIM</p>
      </footer>

      {menuOpen && <EscMenu onResume={() => setMenuOpen(false)} onLeave={leaveMatch} />}
    </main>
  );
}
