import {
  LOBBY_NAME_MAX_LENGTH,
  LOBBY_NAME_MIN_LENGTH,
  describeLobbySettingsProblem,
  normalizeLobbyName,
  validateLobbyName,
} from '@seg/shared';
import { type FormEvent, useState } from 'react';

import { useAuth } from '../state/auth.js';
import { useLobby } from '../state/lobby.js';
import { Button, Field, FormError } from './controls.js';
import { Screen } from './Screen.js';

/**
 * Create a lobby.
 *
 * Name only — everything else takes its default and is changed inside the lobby, where the
 * host can see the settings alongside the people they affect. Asking for a point budget
 * before anyone has joined is a decision with no context.
 */
export function CreateLobbyScreen() {
  const account = useAuth((s) => s.account);
  const createLobby = useLobby((s) => s.createLobby);
  const rejection = useLobby((s) => s.rejection);
  const clearRejection = useLobby((s) => s.clearRejection);

  const [name, setName] = useState(account === null ? '' : `${account.username}'s lobby`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const normalized = normalizeLobbyName(name);
    const problem = validateLobbyName(normalized);
    if (problem !== null) {
      setError(describeLobbySettingsProblem(problem));
      return;
    }

    setError(null);
    clearRejection();
    setBusy(true);
    try {
      // On success the store receives `lobby.state` and navigates to the lobby, so there is
      // nothing to do here but stop being busy.
      await createLobby(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Create a lobby">
      <form className="form" onSubmit={onSubmit} noValidate>
        <Field
          label="Lobby name"
          name="lobbyName"
          value={name}
          maxLength={LOBBY_NAME_MAX_LENGTH}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          error={error ?? undefined}
          hint={`${LOBBY_NAME_MIN_LENGTH}–${LOBBY_NAME_MAX_LENGTH} characters. Letters, numbers, spaces, and ' - _ . ! ?`}
        />

        {rejection !== null && rejection.op === 'lobby.create' && error === null && (
          <FormError>{rejection.message}</FormError>
        )}

        <Button type="submit" busy={busy} disabled={name.trim().length === 0}>
          CREATE LOBBY
        </Button>
      </form>

      <p className="muted create__note">
        You will be the host. Mode, player cap, and fleet budget are set inside the lobby, and every
        player can see them.
      </p>
    </Screen>
  );
}
