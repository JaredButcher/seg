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
import { useDebug } from '../debug/state.js';
import { useLobby } from '../state/lobby.js';
import { activeSetup, activeView, armedTubeOf, useMatch } from '../state/match.js';
import { EscMenu } from './EscMenu.js';
import { useEscape } from './escape.js';
import { Chat } from './hud/Chat.js';
import { FleetList } from './hud/FleetList.js';
import { MiniMap } from './hud/MiniMap.js';
import { Probe } from './hud/Probe.js';
import { Score } from './hud/Score.js';
import { Stats } from './hud/Stats.js';
import { Timer } from './hud/Timer.js';
import {
  fleetRows,
  fleetThreats,
  scopeBoats,
  scopeTorpedoes,
  scopeWrecks,
  type FleetRow,
} from './hud/rows.js';
import { NO_THREATS } from '../render/threat.js';

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
  /** Armed by `seg.spawn` in the devtools console (`debug/console.ts`), or `null`. */
  const pendingSpawn = useDebug((s) => s.pendingSpawn);
  /** And whether `seg.probe` has the reading panel up, which is what binds ctrl+click. */
  const probing = useDebug((s) => s.probing);
  const probe = useMatch((s) => s.probe);
  /**
   * The server's own statistics, or `null` when nobody has asked for them.
   *
   * The panel's visibility is the *payload's* rather than a local flag like `probing`, and that is
   * the difference between the two tools: a probe panel with nothing in it still tells you to
   * ctrl+click, where a statistics panel is nothing but its numbers — so it appears when they
   * start arriving and goes when `seg.stats(false)` clears them.
   */
  const stats = useMatch((s) => s.stats);

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
      wrecks: () => {
        const currentView = activeView(useMatch.getState());
        return currentView === undefined ? [] : scopeWrecks(currentView);
      },
      // The accumulated sonar picture, handed over by reference. It is mutated in place as
      // frames land, which is exactly why it is polled rather than passed as a prop.
      picture: () => useMatch.getState().picture,
      /*
       * Who is about to be hit, both ways (`hud/rows.ts#fleetThreats`). Solved here rather than
       * shared with the fleet list through a ref: it is pure over the state one frame carries and
       * costs a handful of dot products, so two callers reading it independently is cheaper than
       * the plumbing that would keep one cached copy honest.
       */
      threats: () => {
        const state = useMatch.getState();
        const currentSetup = activeSetup(state);
        const currentView = activeView(state);
        if (currentSetup === undefined || currentView === undefined) return NO_THREATS;
        return fleetThreats(currentSetup, currentView, state.picture);
      },
      // The debug acoustic overlay, `null` in every match nobody turned one on for. Polled on its
      // own counter for the reason `ScopeFleet` gives: it arrives at its own, slower rate.
      field: () => useMatch.getState().field,
      fieldRevision: () => useMatch.getState().fieldRevision,
      // And the ping-reach rings beside it, on the same terms: empty in every match nobody turned
      // them on for, polled on their own counter (`debug/console.ts`, `seg.reach`).
      reach: () => useMatch.getState().reach,
      reachRevision: () => useMatch.getState().reachRevision,
      // Straight off the latest frame. Zones carry their own position now, so there is nothing
      // to join against the setup and nothing to go stale when one is captured and replaced.
      zones: () => activeView(useMatch.getState())?.zones ?? [],
      tick: () => activeView(useMatch.getState())?.clock.tick ?? 0,
      selected: () => useMatch.getState().selected,
      /*
       * Every friendly boat under orders, the team's included — `view.boats` is the friendly
       * fleet, so this is exactly "my side's plans" with no filtering to get wrong. Which one is
       * drawn boldly is the scope's business; this only says which one is selected.
       *
       * A wreck is skipped. It keeps whatever order it died under, and a line running out of a
       * hulk towards water it will never reach is a plan the player cannot cancel.
       */
      routes: () => {
        const state = useMatch.getState();
        const currentSetup = activeSetup(state);
        const currentView = activeView(state);
        if (currentSetup === undefined || currentView === undefined) return [];
        const picked = state.selected;
        const mine = new Set(
          currentSetup.fleet
            .filter((profile) => profile.owner === currentSetup.you.accountId)
            .map((profile) => profile.id),
        );
        return currentView.boats.flatMap((snapshot) =>
          snapshot.order.kind !== 'transit' || snapshot.status === 'destroyed'
            ? []
            : [
                {
                  boatId: snapshot.id,
                  pos: snapshot.pos,
                  waypoints: snapshot.order.waypoints,
                  selected: snapshot.id === picked,
                  mine: mine.has(snapshot.id),
                },
              ],
        );
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
   * Space: the selected boat's armed tube fires at the point under the cursor, and the selection
   * steps to the next tube.
   *
   * **One tube, and the step is the point.** Space, space, space walks a four-tube boat round its
   * tubes in order and back to the first, which is the salvo a player actually wants and used to
   * cost four ctrl-presses to set up. The step happens whether or not the shot was any good: a
   * tube that is still reloading refuses the command at the server (`match/tubes.ts`) and the
   * selection moves along anyway, because the alternative is a space bar that sticks on a tube
   * with thirty seconds left on it while three loaded ones sit behind it.
   *
   * Gated on the boat having tubes *this player can see*, which is the same thing as it being
   * theirs — `MatchViewState.own` carries tube state for their own boats and nothing else. A
   * teammate's hull can be selected by clicking it on the scope, and firing from one is a command
   * the server would refuse; there is no tube count to step through either, so the whole gesture
   * is dropped rather than half-performed.
   *
   * Nothing happens with no boat selected, and nothing is said about it: the scope has no
   * selection ring to point at, so a message would be the only thing on screen and the fix is
   * one key press away.
   */
  const onFire = (to: Vec2) => {
    const state = useMatch.getState();
    const boat = state.selected;
    if (boat === null) return;
    const count = activeView(state)?.own.find((own) => own.id === boat)?.tubes.length ?? 0;
    if (count === 0) return;
    useLobby.getState().fireTubes(boat, [armedTubeOf(state, boat)], to);
    useMatch.getState().cycleTube(boat, count, 1);
  };

  const onThrottle = (row: FleetRow, notch: ThrottleNotch) => {
    useLobby.getState().setThrottle(row.profile.id, notch);
  };

  /*
   * The debug console's spawn, armed by `seg.spawn` and consumed by the next click on the
   * viewport. `ScopeHost` only treats a click this way while the prop is defined, which is why
   * this is `undefined` rather than a callback that checks `pendingSpawn` itself — the arming
   * state has to decide *whether* a click is a spawn before the scope's own hit test runs.
   */
  const onDebugSpawn =
    pendingSpawn === null
      ? undefined
      : (at: Vec2) => {
          useLobby
            .getState()
            .debugSpawn(pendingSpawn.kind, pendingSpawn.subtype, pendingSpawn.team, at);
          useDebug.getState().clear();
        };

  /**
   * Ctrl+click while the probe panel is up: ask the server to read that point out.
   *
   * Bound only while the panel is open, so ctrl+click is an ordinary click the rest of the time.
   * The selection is read at the moment of the click rather than being followed like the field
   * overlay's is: a probe is one question asked once, and the boat it is asked against is whoever
   * was picked when the developer pointed at the water.
   */
  const onProbe = probing
    ? (at: Vec2) => {
        useLobby.getState().debugProbe(at, useMatch.getState().selected);
      }
    : undefined;

  /**
   * Ask again when the first answer was taken before the water there had been computed.
   *
   * A solve only fills the noise heatmap where something reads it, so the first probe of a fresh
   * point registers the cell and comes back `settled: false` — the ambient sea rather than the
   * reading (`@seg/shared/match/probe.ts`, planning/16 §3.9). One repeat is enough: by then the
   * next solve has been told to compute it. Guarded on the point so this cannot loop on a cell the
   * server will never fill, such as one off the map.
   */
  const unsettled = probe !== null && !probe.settled ? probe.at : null;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (unsettled === null) {
      asked.current = null;
      return;
    }
    const key = `${unsettled.x},${unsettled.y}`;
    if (asked.current === key) return;
    asked.current = key;
    useLobby.getState().debugProbe(unsettled, useMatch.getState().selected);
  }, [unsettled]);

  /** What the last reading's listener is called, when this client can see that boat at all. */
  const probedBoat =
    probe?.listener == null
      ? null
      : (setup?.fleet.find((profile) => profile.id === probe.listener?.boat)?.name ?? null);

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
        onDebugSpawn={onDebugSpawn}
        onProbe={onProbe}
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

      {/*
        The statistics panel up the left edge, over the gutter `CORE_INSETS.left` reserves for the
        depth scale — and wider than it, deliberately. A permanent inset for a panel that only a
        debug session ever opens would move every player's camera to make room for something they
        will never see.
      */}
      {stats !== null && (
        <aside className="match__left" aria-label="Server statistics">
          <Stats stats={stats} />
        </aside>
      )}

      {view !== undefined && (
        <aside className="match__right" aria-label="Fleet and map">
          <FleetList
            setup={setup}
            view={view}
            picture={picture}
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
        {/*
          Above the chat rather than beside it, in the footer's own grid: bottom left is where the
          panel belongs and it is also where chat lives, and two absolutely-placed boxes fighting
          over one corner is a layout bug waiting for somebody to open the chat box.
        */}
        {probing && <Probe reading={probe} boatName={probedBoat} />}
        <Chat you={setup.you} entries={chat} rejection={chatRejection} onSend={sendChat} />
        <p className="match__meta match__hint">
          DRAG OR W A S D TO PAN · WHEEL OR ↑ ↓ TO ZOOM · SPACE FIRES THE ARMED TUBE AT THE CURSOR
          AND STEPS TO THE NEXT · ← → STEP WITHOUT FIRING · R / F THROTTLE · CTRL+NUM ARMS A TUBE ·
          E OPENS ITS LOAD PICKER · ↑ ↓ THEN E TAKES A LOAD, SHIFT+E RELOADS IT NOW
        </p>
      </footer>

      {menuOpen && <EscMenu onResume={() => setMenuOpen(false)} onLeave={leaveMatch} />}
    </main>
  );
}
