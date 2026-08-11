import {
  FLEET_POINTS_MAX,
  FLEET_POINTS_MIN,
  LOBBY_NAME_MAX_LENGTH,
  MAP_SIZES,
  MAP_TYPES,
  MAX_PLAYERS_MAX,
  MAX_PLAYERS_MIN,
  describeGameMode,
  describeLobbySettingsProblem,
  describeMapSize,
  describeMapType,
  everyoneReady,
  normalizeLobbyName,
  playerCount,
  readyCount,
  teamCapacity,
  validateLobbyName,
  type GameMode,
  type LobbyMember,
  type LobbyPosition,
  type LobbySettings,
  type LobbyState,
  type LobbyVisibility,
  type MapSize,
  type MapType,
  type SelectedFleet,
} from '@seg/shared';
import { useState } from 'react';

import { useAuth } from '../state/auth.js';
import { useLobby } from '../state/lobby.js';
import { useNav } from '../state/nav.js';
import { Button, FormError } from './controls.js';
import { FleetPicker } from './fleet/FleetPicker.js';
import { Choice, Slider } from './Slider.js';

const POSITION_LABELS: Record<LobbyPosition, string> = {
  team1: 'Team 1',
  team2: 'Team 2',
  spectator: 'Spectating',
};

/** Built from the shared ids so the labels can never drift from the wire vocabulary. */
const MAP_TYPES_OPTIONS = MAP_TYPES.map((value) => ({ value, label: describeMapType(value) }));
const MAP_SIZES_OPTIONS = MAP_SIZES.map((value) => ({ value, label: describeMapSize(value) }));

export function LobbyScreen() {
  const lobby = useLobby((s) => s.lobby);
  const account = useAuth((s) => s.account);

  // The store navigates away on `lobby.exit`, so this is a torn-down frame, not a state.
  if (lobby === null || account === null) return null;

  const isHost = lobby.hostAccountId === account.id;

  return (
    <main className="screen screen--wide">
      <header className="screen__header">
        <h1 className="lobby__name">{lobby.settings.name}</h1>
        <p className="lobby__code">
          JOIN CODE <strong>{lobby.code}</strong>
          {lobby.settings.visibility === 'unlisted' && <span className="lobby__tag">UNLISTED</span>}
        </p>
      </header>

      <div className="lobby">
        <Members lobby={lobby} accountId={account.id} isHost={isHost} />
        <Settings lobby={lobby} isHost={isHost} />
      </div>

      <LobbyFooter lobby={lobby} accountId={account.id} isHost={isHost} />
    </main>
  );
}

// ── members ─────────────────────────────────────────────────────────────────────

function Members({
  lobby,
  accountId,
  isHost,
}: {
  lobby: LobbyState;
  accountId: string;
  isHost: boolean;
}) {
  const setPosition = useLobby((s) => s.setPosition);
  const kick = useLobby((s) => s.kick);
  const selfFleet = useLobby((s) => s.selfFleet);

  const perTeam = teamCapacity(lobby.settings.maxPlayers);
  const seated = playerCount(lobby.members);

  return (
    <section className="panel lobby__panel">
      <div className="panel__head">
        <h2 className="panel__title">Players</h2>
        <span className="panel__meta">
          {readyCount(lobby.members)} / {seated} ready · {seated} / {lobby.settings.maxPlayers}
        </span>
      </div>

      <div className="panel__body">
        {(['team1', 'team2', 'spectator'] as const).map((position) => {
          const members = lobby.members.filter((m) => m.position === position);
          return (
            <div key={position} className="roster">
              <h3 className="roster__title">
                {POSITION_LABELS[position]}
                {position !== 'spectator' && (
                  <span className="roster__count">
                    {members.length} / {perTeam}
                  </span>
                )}
              </h3>
              {members.length === 0 ? (
                <p className="roster__empty">Empty</p>
              ) : (
                <ul className="roster__list">
                  {members.map((member) => (
                    <MemberRow
                      key={member.occupant.accountId}
                      member={member}
                      isSelf={member.occupant.accountId === accountId}
                      isTheHost={member.occupant.accountId === lobby.hostAccountId}
                      // The host sees a kick button on everyone but themselves.
                      canKick={isHost && member.occupant.accountId !== accountId}
                      onKick={() => kick(member.occupant.accountId)}
                      // Only ever passed for your own row. Everyone else's fleet is not in
                      // the state this client holds, so there is nothing here to leak.
                      fleet={member.occupant.accountId === accountId ? selfFleet : null}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        <div className="lobby__positions">
          <span className="lobby__positions-label">Move to</span>
          {(['team1', 'team2', 'spectator'] as const).map((position) => (
            <Button key={position} variant="ghost" onClick={() => setPosition(position)}>
              {POSITION_LABELS[position].toUpperCase()}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}

function MemberRow({
  member,
  isSelf,
  isTheHost,
  canKick,
  onKick,
  fleet,
}: {
  member: LobbyMember;
  isSelf: boolean;
  isTheHost: boolean;
  canKick: boolean;
  onKick: () => void;
  /** Your own fleet, on your own row only. Never populated for anyone else. */
  fleet: SelectedFleet | null;
}) {
  return (
    <li className="roster__item" data-ready={member.ready}>
      <span className="roster__name">
        {member.username}
        {isSelf && <span className="roster__badge">YOU</span>}
        {isTheHost && <span className="roster__badge roster__badge--host">HOST</span>}

        {/*
         * Your own row names the fleet; everyone else's says only that there is one. That
         * asymmetry is the feature, not an oversight — knowing an opponent's hull count
         * before the first ping would give away most of what sonar is there to hide.
         */}
        {isSelf && fleet !== null ? (
          <span className="roster__fleet">
            {fleet.name} <span className="roster__fleet-pts">{fleet.points} pts</span>
          </span>
        ) : member.hasFleet ? (
          <span className="roster__fleet roster__fleet--hidden">Fleet chosen</span>
        ) : (
          <span className="roster__fleet roster__fleet--none">No fleet</span>
        )}

        {member.position !== 'spectator' && (
          <span
            className={`roster__badge ${member.ready ? 'roster__badge--ready' : 'roster__badge--waiting'}`}
          >
            {member.ready ? 'READY' : 'NOT READY'}
          </span>
        )}
      </span>
      {canKick && (
        <button
          type="button"
          className="roster__kick"
          onClick={onKick}
          // The visible label is just "KICK"; the accessible name says who, because a
          // screen-reader user hearing eight identical buttons learns nothing.
          aria-label={`Remove ${member.username} from the lobby`}
        >
          KICK
        </button>
      )}
    </li>
  );
}

// ── settings ────────────────────────────────────────────────────────────────────

function Settings({ lobby, isHost }: { lobby: LobbyState; isHost: boolean }) {
  const modify = useLobby((s) => s.modify);
  const rejection = useLobby((s) => s.rejection);

  const saved = lobby.settings;
  const [draft, setDraft] = useState<LobbySettings>(saved);
  /** The server settings the draft was last reconciled against. */
  const [base, setBase] = useState<LobbySettings>(saved);
  const [nameError, setNameError] = useState<string | null>(null);

  /*
   * Adopt the server's settings when they change, but only if the host has nothing unsaved.
   *
   * That guard is what makes Revert meaningful: without it, a `lobby.state` broadcast caused
   * by someone else joining would overwrite half-finished edits, and the host would watch
   * their sliders jump back mid-drag.
   *
   * Adjusting state during render rather than in an effect, because this is derived state
   * catching up with a prop — React re-runs the component immediately and never commits the
   * stale frame, so there is no flash of the previous values.
   */
  if (base !== saved) {
    setBase(saved);
    if (sameSettings(draft, base)) setDraft(saved);
  }

  const dirty = !sameSettings(draft, saved);

  function save() {
    const name = normalizeLobbyName(draft.name);
    const problem = validateLobbyName(name);
    if (problem !== null) {
      setNameError(describeLobbySettingsProblem(problem));
      return;
    }
    setNameError(null);
    modify({
      name,
      maxPlayers: draft.maxPlayers,
      mode: draft.mode,
      fleetPoints: draft.fleetPoints,
      visibility: draft.visibility,
      mapType: draft.mapType,
      mapSize: draft.mapSize,
      debugMode: draft.debugMode,
    });
  }

  function revert() {
    setNameError(null);
    setDraft(saved);
  }

  return (
    <section className="panel lobby__panel">
      <div className="panel__head">
        <h2 className="panel__title">Settings</h2>
        {!isHost && <span className="panel__meta">Host only</span>}
      </div>

      <div className="panel__body settings">
        <div className="setting" data-dirty={draft.name !== saved.name}>
          <div className="setting__head">
            <label className="setting__label" htmlFor="lobby-name">
              Lobby name
            </label>
          </div>
          <input
            id="lobby-name"
            className="field__input"
            value={draft.name}
            maxLength={LOBBY_NAME_MAX_LENGTH}
            disabled={!isHost}
            aria-invalid={nameError === null ? undefined : true}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setNameError(null);
            }}
          />
          {nameError !== null && (
            <p className="field__error" role="alert">
              {nameError}
            </p>
          )}
        </div>

        <Slider
          label="Players"
          display={`${draft.maxPlayers / 2}v${draft.maxPlayers / 2} · ${draft.maxPlayers} total`}
          value={draft.maxPlayers}
          min={MAX_PLAYERS_MIN}
          max={MAX_PLAYERS_MAX}
          // Even numbers only, so both teams are the same size (shared rule).
          step={2}
          disabled={!isHost}
          dirty={draft.maxPlayers !== saved.maxPlayers}
          onChange={(maxPlayers) => setDraft({ ...draft, maxPlayers })}
        />

        <Slider
          label="Fleet budget"
          display={`${draft.fleetPoints} points`}
          value={draft.fleetPoints}
          min={FLEET_POINTS_MIN}
          max={FLEET_POINTS_MAX}
          step={50}
          disabled={!isHost}
          dirty={draft.fleetPoints !== saved.fleetPoints}
          onChange={(fleetPoints) => setDraft({ ...draft, fleetPoints })}
        />

        <Choice<GameMode>
          label="Mode"
          value={draft.mode}
          options={[
            { value: 'objective-capture', label: describeGameMode('objective-capture') },
            { value: 'deathmatch', label: describeGameMode('deathmatch') },
          ]}
          disabled={!isHost}
          dirty={draft.mode !== saved.mode}
          onChange={(mode) => setDraft({ ...draft, mode })}
        />

        <Choice<LobbyVisibility>
          label="Visibility"
          value={draft.visibility}
          options={[
            { value: 'public', label: 'Public' },
            { value: 'unlisted', label: 'Code only' },
          ]}
          disabled={!isHost}
          dirty={draft.visibility !== saved.visibility}
          onChange={(visibility) => setDraft({ ...draft, visibility })}
        />

        <Choice<MapType>
          label="Map type"
          value={draft.mapType}
          options={MAP_TYPES_OPTIONS}
          disabled={!isHost}
          dirty={draft.mapType !== saved.mapType}
          onChange={(mapType) => setDraft({ ...draft, mapType })}
        />

        <Choice<MapSize>
          label="Map size"
          value={draft.mapSize}
          options={MAP_SIZES_OPTIONS}
          disabled={!isHost}
          dirty={draft.mapSize !== saved.mapSize}
          onChange={(mapSize) => setDraft({ ...draft, mapSize })}
        />

        <div className="setting" data-dirty={draft.debugMode !== saved.debugMode}>
          <div className="setting__head">
            <label className="setting__label" htmlFor="lobby-debug-mode">
              Debug console
            </label>
            {draft.debugMode !== saved.debugMode && (
              <span className="setting__value setting__dirty" aria-label="unsaved change">
                •
              </span>
            )}
          </div>
          {/*
            No `Choice`/`Slider` control fits a single on/off switch, so this is the one setting
            in the panel that is a bare checkbox rather than the shared radio-group look — same
            `.setting` wrapper and dirty-dot convention as every other row, so it still reads as
            one settings panel rather than an outlier.
          */}
          <label className="choice__option">
            <input
              id="lobby-debug-mode"
              type="checkbox"
              checked={draft.debugMode}
              disabled={!isHost}
              onChange={(e) => setDraft({ ...draft, debugMode: e.target.checked })}
            />
            <span>
              Enable the browser-console debug commands (fog-of-war toggle, spawning) for this
              match
            </span>
          </label>
        </div>

        {rejection !== null && rejection.op === 'lobby.modify' && (
          <FormError>{rejection.message}</FormError>
        )}
      </div>

      {isHost && (
        <div className="panel__foot">
          <div className="actions">
            <Button disabled={!dirty} onClick={save}>
              SAVE
            </Button>
            <Button variant="ghost" disabled={!dirty} onClick={revert}>
              REVERT
            </Button>
          </div>
          <p className="muted settings__note">
            {dirty ? 'Unsaved changes. Nobody else sees them yet.' : 'Everything is saved.'}
          </p>
        </div>
      )}
    </section>
  );
}

function sameSettings(a: LobbySettings, b: LobbySettings): boolean {
  return (
    a.name === b.name &&
    a.maxPlayers === b.maxPlayers &&
    a.mode === b.mode &&
    a.fleetPoints === b.fleetPoints &&
    a.visibility === b.visibility &&
    a.mapType === b.mapType &&
    a.mapSize === b.mapSize &&
    a.debugMode === b.debugMode
  );
}

// ── footer ──────────────────────────────────────────────────────────────────────

function LobbyFooter({
  lobby,
  accountId,
  isHost,
}: {
  lobby: LobbyState;
  accountId: string;
  isHost: boolean;
}) {
  const leave = useLobby((s) => s.leave);
  const rejection = useLobby((s) => s.rejection);
  const selfFleet = useLobby((s) => s.selfFleet);
  const selectFleet = useLobby((s) => s.selectFleet);
  const setReady = useLobby((s) => s.setReady);
  const startMatch = useLobby((s) => s.startMatch);
  const go = useNav((s) => s.go);

  const [picking, setPicking] = useState(false);

  const self = lobby.members.find((m) => m.occupant.accountId === accountId);
  const spectating = self?.position === 'spectator';
  const ready = self?.ready === true;
  const canStart = everyoneReady(lobby.members);

  const unrelated =
    rejection !== null && rejection.op !== 'lobby.modify' && rejection.op !== 'lobby.create';

  return (
    <div className="lobby__footer">
      {unrelated && <FormError>{rejection.message}</FormError>}

      <div className="actions">
        <Button variant="ghost" disabled={spectating} onClick={() => setPicking(true)}>
          {selfFleet === null ? 'SELECT FLEET' : 'CHANGE FLEET'}
        </Button>

        {/* Fleets are chosen against a known map, so the editor has to be reachable from
            inside the lobby and not only from the menu (planning/05 §2, 14 §8). */}
        <Button variant="ghost" onClick={() => go('fleet-editor')}>
          FLEET EDITOR
        </Button>

        {/*
         * Readiness needs a fleet, so the button stays inert until there is one. The server
         * refuses either way — this only saves the player a round trip to be told so.
         */}
        <Button
          variant={ready ? 'ghost' : 'primary'}
          disabled={spectating || selfFleet === null}
          onClick={() => setReady(!ready)}
        >
          {ready ? 'NOT READY' : 'READY'}
        </Button>

        {isHost && (
          <Button disabled={!canStart} onClick={startMatch}>
            START MATCH
          </Button>
        )}

        <Button variant="ghost" onClick={leave}>
          LEAVE LOBBY
        </Button>
      </div>

      <p className="muted settings__note">
        {spectating
          ? 'Spectators do not field a fleet. Join a team to take part.'
          : selfFleet === null
            ? 'Pick a fleet to be able to ready up.'
            : isHost && !canStart
              ? 'Waiting for everyone to be ready.'
              : `Bringing ${selfFleet.name} — ${String(selfFleet.boatCount)} ${
                  selfFleet.boatCount === 1 ? 'boat' : 'boats'
                }, ${String(selfFleet.points)} of ${String(lobby.settings.fleetPoints)} points.`}
      </p>

      {picking && (
        <FleetPicker
          budget={lobby.settings.fleetPoints}
          selectedId={selfFleet?.id ?? null}
          onSelect={selectFleet}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
