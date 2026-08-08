/**
 * The match screen — a full-window Pixi scope with a floating HUD (planning/08 §11).
 *
 * The store navigates here on `match.started`; this component only renders. The scope is the
 * star and React never touches the render loop; the HUD floats above it in CSS, in the gutters
 * `render/camera.ts` already reserves as `CORE_INSETS`. Those two numbers have to agree: the
 * camera refuses to pan the map out from behind a panel, and a panel that grew past its inset
 * would start covering water the camera thinks is visible.
 *
 * Six of the seven elements are here — scope, mini-map, fleet list, score, timer, chat, and
 * the Esc window. The seventh, the permanent control strip along the bottom (throttle, depth
 * readout, tubes, fire), is a *command* surface and arrives with the commands it sends.
 */

import { describeGameMode, describeMapSize, describeMapType, type Vec2 } from '@seg/shared';
import { useMemo, useRef, useState } from 'react';

import { ScopeHost, type ScopeControls, type ScopeFleet } from '../render/ScopeHost.js';
import { useLobby } from '../state/lobby.js';
import { activeSetup, activeView, useMatch } from '../state/match.js';
import { EscMenu } from './EscMenu.js';
import { useEscape } from './escape.js';
import { Chat } from './hud/Chat.js';
import { FleetList } from './hud/FleetList.js';
import { MiniMap } from './hud/MiniMap.js';
import { Score } from './hud/Score.js';
import { Timer } from './hud/Timer.js';
import { scopeBoats } from './hud/rows.js';

export function MatchScreen() {
  const setup = useMatch(activeSetup);
  const view = useMatch(activeView);
  const chat = useMatch((s) => s.chat);
  const chatRejection = useMatch((s) => s.chatRejection);
  const leaveMatch = useLobby((s) => s.leaveMatch);
  const sendChat = useLobby((s) => s.sendChat);

  const [menuOpen, setMenuOpen] = useState(false);
  const controls = useRef<ScopeControls | null>(null);

  /*
   * The scope reads the fleet through getters rather than props, so a view frame moves boats
   * without re-rendering React (planning/08 §1). The object is built once — a new one each
   * render would tear down and rebuild the Pixi scene on every keystroke in the chat box.
   */
  const fleet = useMemo<ScopeFleet>(
    () => ({
      revision: () => useMatch.getState().revision,
      boats: () => {
        const state = useMatch.getState();
        const currentSetup = activeSetup(state);
        const currentView = activeView(state);
        if (currentSetup === undefined || currentView === undefined) return [];
        return scopeBoats(currentSetup, currentView);
      },
    }),
    [],
  );

  /*
   * Only the *opening* keystroke is taken here. While the menu is up it owns Escape itself,
   * because the key means "back out of this pane" as often as it means "resume" — so this
   * level is not registered at all in that state and the two can never both fire on one
   * press. An open chat box stops the key before it reaches the shared stack.
   */
  useEscape(() => setMenuOpen(true), !menuOpen);

  // `match.started` navigates here before `match.state` necessarily lands; the two travel
  // together on the control channel, so this is a brief splash at most.
  if (setup === undefined) {
    return (
      <main className="screen screen--match">
        <p className="match__loading" role="status">
          Loading match…
        </p>
      </main>
    );
  }

  const map = setup.map;
  const look = (point: Vec2) => controls.current?.lookAt(point);

  return (
    <main className="screen screen--match">
      {/*
        The scope stops answering the camera keys while the menu is up. Not because the match
        pauses — it does not — but because the menu's own keys would otherwise double as pan
        commands on the water behind it.
      */}
      <ScopeHost map={map} inputEnabled={!menuOpen} fleet={fleet} controls={controls} />

      <header className="match__hud">
        <div className="match__hud-group">
          <h1 className="match__title">MATCH LIVE</h1>
          <p className="match__meta">
            {describeGameMode(setup.mode)} · {describeMapType(map.mapType)} ·{' '}
            {describeMapSize(map.mapSize)}
          </p>
        </div>

        {view !== undefined && (
          <div className="match__hud-group match__hud-group--centre">
            <Score setup={setup} view={view} />
            <Timer view={view} />
          </div>
        )}

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
          <p className="match__meta match__meta--id">MATCH {setup.matchId.slice(0, 8)}</p>
        </div>
      </header>

      {view !== undefined && (
        <aside className="match__right" aria-label="Fleet and map">
          <FleetList
            setup={setup}
            view={view}
            // Same reason the scope stops answering the camera keys: while the menu is up, its
            // keys must not double as commands on the fleet behind it.
            inputEnabled={!menuOpen}
            onFocus={(row) => {
              look(row.snapshot.pos);
            }}
          />
          <MiniMap setup={setup} view={view} onJump={look} />
        </aside>
      )}

      <footer className="match__foot">
        <Chat you={setup.you} entries={chat} rejection={chatRejection} onSend={sendChat} />
        <p className="match__meta match__hint">
          DRAG OR W A S D TO PAN · WHEEL OR ↑ ↓ TO ZOOM · HOME / END FOR THE MAP ENDS
        </p>
      </footer>

      {menuOpen && <EscMenu onResume={() => setMenuOpen(false)} onLeave={leaveMatch} />}
    </main>
  );
}
