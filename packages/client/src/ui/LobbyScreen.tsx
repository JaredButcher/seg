import {
  FLEET_POINTS_MAX,
  FLEET_POINTS_MIN,
  LOBBY_NAME_MAX_LENGTH,
  MAX_PLAYERS_MAX,
  MAX_PLAYERS_MIN,
  describeGameMode,
  describeLobbySettingsProblem,
  normalizeLobbyName,
  teamCapacity,
  validateLobbyName,
  type GameMode,
  type LobbyMember,
  type LobbyPosition,
  type LobbySettings,
  type LobbyState,
  type LobbyVisibility,
} from '@seg/shared';
import { useState } from 'react';

import { useAuth } from '../state/auth.js';
import { useLobby } from '../state/lobby.js';
import { Button, FormError } from './controls.js';
import { Choice, Slider } from './Slider.js';

const POSITION_LABELS: Record<LobbyPosition, string> = {
  team1: 'Team 1',
  team2: 'Team 2',
  spectator: 'Spectating',
};

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

      <LobbyFooter />
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

  const perTeam = teamCapacity(lobby.settings.maxPlayers);

  return (
    <section className="panel lobby__panel">
      <div className="panel__head">
        <h2 className="panel__title">Players</h2>
        <span className="panel__meta">
          {lobby.members.filter((m) => m.position !== 'spectator').length} /{' '}
          {lobby.settings.maxPlayers}
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
}: {
  member: LobbyMember;
  isSelf: boolean;
  isTheHost: boolean;
  canKick: boolean;
  onKick: () => void;
}) {
  return (
    <li className="roster__item">
      <span className="roster__name">
        {member.username}
        {isSelf && <span className="roster__badge">YOU</span>}
        {isTheHost && <span className="roster__badge roster__badge--host">HOST</span>}
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
    a.visibility === b.visibility
  );
}

// ── footer ──────────────────────────────────────────────────────────────────────

function LobbyFooter() {
  const leave = useLobby((s) => s.leave);
  const rejection = useLobby((s) => s.rejection);

  const unrelated =
    rejection !== null && rejection.op !== 'lobby.modify' && rejection.op !== 'lobby.create';

  return (
    <div className="lobby__footer">
      {unrelated && <FormError>{rejection.message}</FormError>}
      <Button variant="ghost" onClick={leave}>
        LEAVE LOBBY
      </Button>
    </div>
  );
}
