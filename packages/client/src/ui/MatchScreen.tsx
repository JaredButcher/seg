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
 * the Esc window. The seventh, the permanent control strip along the bottom (depth readout,
 * tubes, fire), is still to come; until it exists, the fleet list carries the throttle, and
 * ordering is a click on the water.
 */

import {
  describeGameMode,
  describeMapSize,
  describeMapType,
  type EntityId,
  type ThrottleNotch,
  type Vec2,
} from '@seg/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

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
import { fleetRows, scopeBoats, scopeTorpedoes, type FleetRow } from './hud/rows.js';

export function MatchScreen() {
  const setup = useMatch(activeSetup);
  const view = useMatch(activeView);
  const chat = useMatch((s) => s.chat);
  const chatRejection = useMatch((s) => s.chatRejection);
  // The mini-map is a React component and does have to re-render for it. That is affordable
  // where the scope is not: it repaints a 296 px canvas at the view frame rate, and the chart
  // half of that is incremental (see MiniMap).
  const picture = useMatch((s) => s.picture);
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
      torpedoes: () => {
        const currentView = activeView(useMatch.getState());
        return currentView === undefined ? [] : scopeTorpedoes(currentView);
      },
      // The accumulated sonar picture, handed over by reference. It is mutated in place as
      // frames land, which is exactly why it is polled rather than passed as a prop.
      picture: () => useMatch.getState().picture,
      // Straight off the latest frame. Zones carry their own position now, so there is nothing
      // to join against the setup and nothing to go stale when one is captured and replaced.
      zones: () => activeView(useMatch.getState())?.zones ?? [],
      tick: () => activeView(useMatch.getState())?.clock.tick ?? 0,
      selected: () => useMatch.getState().selected,
      route: () => {
        const state = useMatch.getState();
        const currentSetup = activeSetup(state);
        const currentView = activeView(state);
        const picked = state.selected;
        if (currentSetup === undefined || currentView === undefined || picked === null) return null;
        const snapshot = currentView.boats.find((boat) => boat.id === picked);
        if (snapshot === undefined || snapshot.order.kind !== 'transit') return null;
        return { boatId: picked, pos: snapshot.pos, waypoints: snapshot.order.waypoints };
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

  const look = (point: Vec2) => controls.current?.lookAt(point);

  /*
   * The camera half of a number key press.
   *
   * A number key means the same thing a click on the row means — look at this boat — with one
   * exception: while the pointer is holding the scope in a drag, the player already has the
   * camera in hand. Jumping it then would fight the gesture, and the next pointer move would
   * drag on from wherever the jump left the camera rather than from where they are pointing.
   * The selection still lands; only the look is withheld.
   */
  const pick = (row: FleetRow) => {
    if (controls.current?.dragging() === true) return;
    look(row.snapshot.pos);
  };

  /*
   * The opening command: as soon as the fleet is on the water, press `1` for the player.
   *
   * Selection *and* look, because that is what the key does (`hud/FleetList`) and because the
   * two halves answer the same question — the scope has no fleet to follow when it mounts, so
   * it opens on the middle of the map, and a match that began by asking the player to go and
   * find their own boats before they could order one has spent their first ten seconds badly.
   *
   * The one-shot is keyed on the scope's control handle rather than on the match id, and that
   * is the whole reason this works: the handle is made when `ScopeHost` builds a Pixi app and
   * dropped when it tears one down, so a remount — which StrictMode does to every screen in
   * development, and a new map does in earnest — hands back a *different* handle. Keyed on the
   * match, the press would have been spent on the canvas that was then thrown away, and the
   * player would be left looking at the middle of the map with nothing selected.
   */
  const commanded = useRef<ScopeControls | null>(null);
  // No dependency array: what decides whether this fires is the identity of a ref's contents,
  // which no dependency list can watch. Once the match is commanded it costs a few comparisons
  // on each of the ten renders a second the view frames cause.
  useEffect(() => {
    const scope = controls.current;
    if (setup === undefined || view === undefined || scope === null || commanded.current === scope)
      return;
    // Fleet order, so this is the boat `1` names. Empty for a spectator, who has no boat to
    // command and keeps the scope's opening view of the whole map.
    const first = fleetRows(setup, view)[0];
    if (first === undefined) return;
    commanded.current = scope;
    useMatch.getState().select(first.profile.id);
    pick(first);
  });

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

  /*
   * The command half of a click on the water. Selection is the boat the keys picked; the scope
   * reports the point and the shift state, and the boat travels here — the scope does not need
   * to know which boat, and this is where the id is read so the click handler cannot go stale
   * against a selection made between frames.
   */
  const onOrder = (to: Vec2, queue: boolean) => {
    const selected = useMatch.getState().selected;
    if (selected === null) return;
    useLobby.getState().orderBoat(selected, to, queue);
  };

  /*
   * A click that landed on a hull instead. The scope did the hit test — it is the only thing
   * holding the zoom, and the pick tolerance is a number of screen pixels — so all that is left
   * here is the store write. No camera move: the boat is under the cursor already, and jumping
   * the picture to centre what the player is looking at would move the water out from under the
   * order they are about to give.
   */
  const onSelect = (boat: EntityId) => {
    useMatch.getState().select(boat);
  };

  const onCancel = () => {
    const selected = useMatch.getState().selected;
    if (selected === null) return;
    useLobby.getState().cancelOrders(selected);
  };

  /*
   * Space: the selected boat's armed tubes fire at the point under the cursor.
   *
   * The sub-selection is *not* cleared afterwards. A player who has armed tubes one and two is
   * setting up a firing posture, and the next salvo — forty seconds later, when both have
   * reloaded — is almost certainly meant to come from the same pair. Clearing it would make the
   * arming gesture something you do before every single shot rather than once.
   *
   * Nothing happens with no boat selected, and nothing is said about it: the scope has no
   * selection ring to point at, so a message would be the only thing on screen and the fix is
   * one key press away.
   */
  const onFire = (to: Vec2) => {
    const state = useMatch.getState();
    if (state.selected === null) return;
    useLobby.getState().fireTubes(state.selected, state.armedTubes, to);
  };

  const onThrottle = (row: FleetRow, notch: ThrottleNotch) => {
    useLobby.getState().setThrottle(row.profile.id, notch);
  };

  return (
    <main className="screen screen--match">
      {/*
        The scope stops answering the camera keys while the menu is up. Not because the match
        pauses — it does not — but because the menu's own keys would otherwise double as pan
        commands on the water behind it.
      */}
      <ScopeHost
        map={map}
        inputEnabled={!menuOpen}
        viewerTeam={setup.you.team}
        fleet={fleet}
        controls={controls}
        onOrder={onOrder}
        onFire={onFire}
        onSelect={onSelect}
        onCancel={onCancel}
      />

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
            onPick={pick}
            onThrottle={onThrottle}
          />
          <MiniMap setup={setup} view={view} picture={picture} onJump={look} />
        </aside>
      )}

      <footer className="match__foot">
        <Chat you={setup.you} entries={chat} rejection={chatRejection} onSend={sendChat} />
        <p className="match__meta match__hint">
          DRAG OR W A S D TO PAN · WHEEL OR ↑ ↓ TO ZOOM · SPACE TO FIRE AT THE CURSOR · R / F
          THROTTLE · CTRL+NUM ARMS A TUBE · SHIFT+NUM PICKS ITS LOAD · C LOADS IT NOW
        </p>
      </footer>

      {menuOpen && <EscMenu onResume={() => setMenuOpen(false)} onLeave={leaveMatch} />}
    </main>
  );
}
