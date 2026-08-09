import { describeGameMode, type GameMode, type LobbySummary } from '@seg/shared';
import { useEffect, useState } from 'react';

import { useAuth } from '../state/auth.js';
import { useLobby } from '../state/lobby.js';
import { useNav } from '../state/nav.js';
import { Button, FormError } from './controls.js';
import { Screen } from './Screen.js';

/** planning/07 §4 asks for auto-refresh. Slow enough to be free, fast enough to feel live. */
const REFRESH_MS = 6000;
/** Typing in the name box should not fire a request per keystroke. */
const DEBOUNCE_MS = 300;

type ModeFilter = GameMode | 'any';

/**
 * The server browser.
 *
 * planning/07 §4 calls this "load-bearing" and it is: with no matchmaking and a small player
 * base, this screen is how a match starts at all (risk R4). Two consequences show up below —
 * the player count is displayed even when it is zero, so an empty list is legibly *empty*
 * rather than apparently broken, and there is a one-click way to create a lobby from here.
 */
export function BrowseLobbiesScreen() {
  const signedIn = useAuth((s) => s.status === 'signedIn');
  const lobbies = useLobby((s) => s.browse);
  const playersOnline = useLobby((s) => s.playersOnline);
  const listLobbies = useLobby((s) => s.listLobbies);

  const [name, setName] = useState('');
  const [mode, setMode] = useState<ModeFilter>('any');
  const [openOnly, setOpenOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtering = name.trim().length > 0 || mode !== 'any' || openOnly;

  /*
   * One effect owns both the debounce and the polling, because they request the same thing
   * and splitting them would let a poll land between a keystroke and its debounce, briefly
   * showing results for the previous filter.
   */
  useEffect(() => {
    if (!signedIn) return;

    let cancelled = false;
    const request = () => {
      void listLobbies({
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
        ...(mode !== 'any' ? { mode } : {}),
        ...(openOnly ? { hasOpenSlots: true } : {}),
      })
        .then(() => {
          if (!cancelled) setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Could not reach the server.');
          }
        });
    };

    const debounce = setTimeout(request, DEBOUNCE_MS);
    const interval = setInterval(request, REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearInterval(interval);
    };
  }, [signedIn, name, mode, openOnly, listLobbies]);

  return (
    <Screen title="Open lobbies">
      {/*
        Guests cannot browse yet. The gateway authenticates at the upgrade and guest accounts
        are Q17, still open — so until they land, this screen needs an account even though the
        home page offers it to signed-out players.
      */}
      {!signedIn ? (
        <SignInFirst />
      ) : (
        <>
          <Filters
            name={name}
            mode={mode}
            openOnly={openOnly}
            onName={setName}
            onMode={setMode}
            onOpenOnly={setOpenOnly}
          />

          {error !== null && <FormError>{error}</FormError>}

          <Results
            lobbies={lobbies}
            filtering={filtering}
            onClearFilters={() => {
              setName('');
              setMode('any');
              setOpenOnly(false);
            }}
          />

          <p className="browse__status" role="status">
            {playersOnline === 1 ? '1 player online' : `${playersOnline} players online`}
          </p>
        </>
      )}
    </Screen>
  );
}

// ── filters ─────────────────────────────────────────────────────────────────────

function Filters({
  name,
  mode,
  openOnly,
  onName,
  onMode,
  onOpenOnly,
}: {
  name: string;
  mode: ModeFilter;
  openOnly: boolean;
  onName: (value: string) => void;
  onMode: (value: ModeFilter) => void;
  onOpenOnly: (value: boolean) => void;
}) {
  return (
    <div className="browse__filters">
      <div className="field browse__filter">
        <label className="field__label" htmlFor="browse-name">
          Name
        </label>
        <input
          id="browse-name"
          className="field__input"
          type="search"
          value={name}
          placeholder="Any"
          autoComplete="off"
          onChange={(e) => onName(e.target.value)}
        />
      </div>

      <div className="field browse__filter">
        <label className="field__label" htmlFor="browse-mode">
          Mode
        </label>
        <select
          id="browse-mode"
          className="field__input"
          value={mode}
          onChange={(e) => onMode(e.target.value as ModeFilter)}
        >
          <option value="any">Any</option>
          <option value="objective-capture">{describeGameMode('objective-capture')}</option>
          <option value="deathmatch">{describeGameMode('deathmatch')}</option>
        </select>
      </div>

      <label className="browse__toggle">
        <input type="checkbox" checked={openOnly} onChange={(e) => onOpenOnly(e.target.checked)} />
        <span>Open slots only</span>
      </label>
    </div>
  );
}

// ── results ─────────────────────────────────────────────────────────────────────

function Results({
  lobbies,
  filtering,
  onClearFilters,
}: {
  lobbies: readonly LobbySummary[] | null;
  filtering: boolean;
  onClearFilters: () => void;
}) {
  const go = useNav((s) => s.go);

  // `null` is "we have not asked yet", which is not the same as "there are none".
  if (lobbies === null) {
    return (
      <p className="browse__empty" role="status">
        Looking for lobbies…
      </p>
    );
  }

  if (lobbies.length === 0) {
    return (
      <div className="browse__empty">
        {filtering ? (
          <>
            <p className="browse__empty-text">No lobbies match those filters.</p>
            <Button variant="ghost" onClick={onClearFilters}>
              CLEAR FILTERS
            </Button>
          </>
        ) : (
          <>
            <p className="browse__empty-text">
              Nobody is hosting right now. Starting one is how a match happens.
            </p>
            {/* The one-click fallback planning/07 §4 asks for on an empty list. */}
            <Button onClick={() => go('lobby-create')}>CREATE A LOBBY</Button>
          </>
        )}
      </div>
    );
  }

  return (
    <ul className="browse__list">
      {lobbies.map((lobby) => (
        <LobbyRow key={lobby.id} lobby={lobby} />
      ))}
    </ul>
  );
}

function LobbyRow({ lobby }: { lobby: LobbySummary }) {
  const joinById = useLobby((s) => s.joinById);
  const rejection = useLobby((s) => s.rejection);
  const [busy, setBusy] = useState(false);

  const full = lobby.playerCount >= lobby.maxPlayers;

  async function join() {
    if (busy) return;
    setBusy(true);
    try {
      // On success the store receives `lobby.state` and navigates into the lobby.
      await joinById(lobby.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="browse__row">
      <div className="browse__row-main">
        <span className="browse__row-name">{lobby.name}</span>
        <span className="browse__row-meta">
          {describeGameMode(lobby.mode)} · {lobby.fleetPoints} points
        </span>
      </div>

      <span className="browse__row-count" title="Players">
        {lobby.playerCount} / {lobby.maxPlayers}
        {/* A full lobby is still joinable as a spectator, so the button stays — the label
            is what changes, rather than the affordance disappearing. */}
      </span>

      <Button variant={full ? 'ghost' : 'primary'} busy={busy} onClick={() => void join()}>
        {full ? 'SPECTATE' : 'JOIN'}
      </Button>

      {rejection !== null && rejection.op === 'lobby.join' && (
        <p className="browse__row-error field__error" role="alert">
          {rejection.message}
        </p>
      )}
    </li>
  );
}

function SignInFirst() {
  const goToAuth = useNav((s) => s.goToAuth);

  return (
    <div className="browse__empty">
      <p className="browse__empty-text">
        Browsing needs an account for now. Guest access is planned (Q17) and is what will make this
        screen work without one.
      </p>
      <Button onClick={() => goToAuth('signIn')}>SIGN IN</Button>
    </div>
  );
}
