import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  describeJoinCodeProblem,
  normalizeJoinCode,
  validateJoinCode,
} from '@seg/shared';
import { type FormEvent, useState } from 'react';

import { useLobby } from '../state/lobby.js';
import { Button, Field, FormError } from './controls.js';
import { Screen } from './Screen.js';

/**
 * Join by code (planning/07 §4).
 *
 * The code rules live in `@seg/shared` so this form enforces exactly what the server will —
 * a malformed code never costs a round trip, and a well-formed one gets the server's answer
 * rather than a guess.
 */
export function JoinLobbyScreen() {
  const joinByCode = useLobby((s) => s.joinByCode);
  const rejection = useLobby((s) => s.rejection);
  const clearRejection = useLobby((s) => s.clearRejection);

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const normalized = normalizeJoinCode(code);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const problem = validateJoinCode(normalized);
    if (problem !== null) {
      setError(describeJoinCodeProblem(problem));
      return;
    }

    setError(null);
    clearRejection();
    setBusy(true);
    try {
      // On success the store receives `lobby.state` and navigates into the lobby.
      await joinByCode(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Join a lobby">
      <form className="form" onSubmit={onSubmit} noValidate>
        <Field
          label="Join code"
          name="joinCode"
          value={code}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          // Long enough to paste a hyphenated or spaced code into; the normalizer strips
          // the separators before the length rule is applied.
          maxLength={JOIN_CODE_LENGTH * 3}
          inputClassName="field__input--code"
          disabled={busy}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
            clearRejection();
          }}
          error={error ?? undefined}
          hint={
            <>
              {JOIN_CODE_LENGTH} characters. Case and spacing do not matter — codes use only{' '}
              <span className="code">{JOIN_CODE_ALPHABET}</span>, so there are no vowels and no
              characters that look like each other.
            </>
          }
        />

        {rejection !== null && rejection.op === 'lobby.join' && error === null && (
          <FormError>{rejection.message}</FormError>
        )}

        <Button type="submit" busy={busy} disabled={normalized.length === 0}>
          JOIN LOBBY
        </Button>
      </form>
    </Screen>
  );
}
