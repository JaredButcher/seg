import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  describeJoinCodeProblem,
  normalizeJoinCode,
  validateJoinCode,
} from '@seg/shared';
import { type FormEvent, useState } from 'react';

import { Button, Field } from './controls.js';
import { Pending } from './Pending.js';
import { Screen } from './Screen.js';

/**
 * Join by code (planning/07 §4).
 *
 * The code rules live in `@seg/shared` so this form enforces exactly what the server will.
 * The lobby service itself is an M5 deliverable and does not exist yet, so submitting a
 * well-formed code gets as far as validation and then says so — see the note at `onSubmit`.
 */
export function JoinLobbyScreen() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);

  const normalized = normalizeJoinCode(code);

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    const problem = validateJoinCode(normalized);
    if (problem !== null) {
      setAccepted(null);
      setError(describeJoinCodeProblem(problem));
      return;
    }

    // Where the `lobby.join` message goes once the realtime lobby service lands (M5,
    // planning/02 §4). Until then the form stops here rather than pretending to connect.
    setError(null);
    setAccepted(normalized);
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
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
            setAccepted(null);
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

        <Button type="submit" disabled={normalized.length === 0}>
          JOIN LOBBY
        </Button>
      </form>

      {accepted !== null && (
        <Pending
          milestone="M5"
          heading={`Code ${accepted} accepted`}
          what="Joining a lobby needs the realtime lobby service, which is an M5 deliverable (planning/11). The code above is well-formed and would be sent as it stands."
        />
      )}
    </Screen>
  );
}
