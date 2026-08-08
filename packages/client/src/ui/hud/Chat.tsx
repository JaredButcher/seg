/**
 * Chat (planning/08 §11, element 6). Bottom-left, collapsed to the last line by default.
 *
 * Collapsed is the important default: the panel sits over the water, and a chat box that
 * occupies a corner of the ocean permanently is a chat box players turn off. It expands on a
 * click or on Enter, and Escape closes it — which is *not* the Esc menu's Escape, because
 * while the input has focus the key means "put this away".
 *
 * **Team** is the default channel and **all** is one click away. A spectator has neither and
 * gets the observers' channel instead: they may read both teams and speak only among
 * themselves (08 §11), which the shared `canSpeakOn` decides rather than this component.
 */

import {
  canSpeakOn,
  CHAT_MAX_LENGTH,
  describeTeam,
  type ChatEntry,
  type ChatScope,
  type MatchSelf,
} from '@seg/shared';
import { useEffect, useRef, useState } from 'react';

interface ChatProps {
  readonly you: MatchSelf;
  readonly entries: readonly ChatEntry[];
  readonly rejection: string | null;
  readonly onSend: (scope: ChatScope, text: string) => void;
}

export function Chat({ you, entries, rejection, onSend }: ChatProps) {
  const spectating = you.team === null;
  const [scope, setScope] = useState<ChatScope>(spectating ? 'spectator' : 'team');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const log = useRef<HTMLOListElement | null>(null);

  // Enter opens the panel and puts the caret in the box, the way every game does it. Only
  // when something else does not already own the keyboard — typing "enter" into the lobby
  // name field should not open a chat box on a screen behind it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter' || open) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open && log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [open, entries]);

  const last = entries.at(-1);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (draft.trim().length === 0) {
      setOpen(false);
      return;
    }
    onSend(scope, draft);
    setDraft('');
  }

  if (!open) {
    return (
      <div className="hud-chat hud-chat--collapsed">
        <button type="button" className="hud-chat__peek" onClick={() => setOpen(true)}>
          <span className="hud-chat__key">CHAT ⏎</span>
          {last === undefined ? (
            <span className="hud-chat__quiet">Nothing said yet.</span>
          ) : (
            <Line entry={last} />
          )}
        </button>
        {/*
          A refusal shows while collapsed too. The panel closes itself on an empty submit, so
          "slow down" would otherwise land on a box the player is no longer looking at, and
          the line they typed would simply have vanished.
        */}
        {rejection !== null && (
          <p className="hud-chat__rejection" role="status">
            {rejection}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="hud-chat hud-chat--open">
      <ol className="hud-chat__log" ref={log} aria-label="Chat" aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.id}>
            <Line entry={entry} />
          </li>
        ))}
      </ol>

      {rejection !== null && (
        <p className="hud-chat__rejection" role="status">
          {rejection}
        </p>
      )}

      <form className="hud-chat__compose" onSubmit={submit}>
        <div className="hud-chat__scopes" role="group" aria-label="Channel">
          {(['team', 'all', 'spectator'] as const)
            .filter((option) => canSpeakOn(option, you.team))
            .map((option) => (
              <button
                type="button"
                key={option}
                className={
                  option === scope ? 'hud-chat__scope hud-chat__scope--on' : 'hud-chat__scope'
                }
                aria-pressed={option === scope}
                onClick={() => setScope(option)}
              >
                {option.toUpperCase()}
              </button>
            ))}
        </div>

        <input
          ref={input}
          className="hud-chat__input"
          value={draft}
          maxLength={CHAT_MAX_LENGTH}
          placeholder={spectating ? 'To the other observers…' : `To ${scope}…`}
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Handled here and stopped, so the Esc menu does not also open behind it.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }}
        />
      </form>
    </div>
  );
}

function Line({ entry }: { readonly entry: ChatEntry }) {
  return (
    <span className={`hud-chat__line hud-chat__line--${entry.scope}`}>
      <span className="hud-chat__from">
        {entry.username}
        <span className="hud-chat__where">
          {entry.scope === 'spectator'
            ? ' · watching'
            : entry.scope === 'all'
              ? ' · all'
              : entry.team === null
                ? ''
                : ` · ${describeTeam(entry.team).toLowerCase()}`}
        </span>
      </span>
      <span className="hud-chat__text">{entry.text}</span>
    </span>
  );
}
