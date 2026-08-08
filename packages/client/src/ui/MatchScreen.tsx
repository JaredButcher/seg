/**
 * The match screen — a full-window Pixi scope with a floating HUD (planning/08 §11).
 *
 * The store navigates here on `match.started`; this component only renders. The scope is the
 * star and React never touches the render loop; the HUD floats above it in CSS. The full
 * seven-element HUD (minimap, fleet list, score, timer, chat, Esc menu) arrives with the sim
 * state it describes; this milestone ships the frame it hangs on.
 */

import { describeGameMode, describeMapSize, describeMapType } from '@seg/shared';

import { ScopeHost } from '../render/ScopeHost.js';
import { useMatch } from '../state/match.js';

export function MatchScreen() {
  const matchId = useMatch((s) => s.matchId);
  const states = useMatch((s) => s.states);
  const state = matchId === null ? undefined : states[matchId];

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
        <p className="match__meta match__meta--id">MATCH {state.matchId.slice(0, 8)}</p>
      </header>

      <footer className="match__hint">
        <p className="match__meta">SCOPE ONLY · FLEET AND ORDERS ARRIVE WITH THE SIM</p>
      </footer>
    </main>
  );
}
