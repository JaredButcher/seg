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
  CHAT_SCOPES,
  describeTeam,
  type ChatEntry,
  type ChatScope,
  type MatchSelf,
} from '@seg/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useMatch } from '../../state/match.js';
import { isTyping } from './typing.js';

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

  /** The channels this player may speak on, in the order Tab walks them. */
  const channels = useMemo(
    () => CHAT_SCOPES.filter((option) => canSpeakOn(option, you.team)),
    [you.team],
  );

  // Enter opens the panel and puts the caret in the box, the way every game does it. See
  // `hud/typing.ts` for why the guard is what it is.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter' || open) return;
      if (isTyping(document.activeElement)) return;
      /*
       * Enter means "open the tube's load picker" while a tube is armed (`hud/FleetList`), and
       * the two panels must not both answer one press.
       *
       * Decided by reading the state rather than by one listener stopping the other, because
       * both hang off `window` and which runs first is mount order — a detail neither component
       * should be relying on and neither would notice breaking. Firing is the more urgent of
       * the two meanings and the armed set is deliberate: a player who has just armed a tube is
       * not reaching for the chat box.
       */
      if (useMatch.getState().armedTubes.length > 0) return;
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
          {channels.map((option) => (
            <button
              type="button"
              key={option}
              className={
                option === scope ? 'hud-chat__scope hud-chat__scope--on' : 'hud-chat__scope'
              }
              aria-pressed={option === scope}
              // Not tabbable: Tab is the channel switch while the box is open, so a focus
              // ring walking these buttons would be two meanings for one key.
              tabIndex={-1}
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
            if (e.key === 'Escape') {
              // Handled here and stopped, so the Esc menu does not also open behind it.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              return;
            }
            if (e.key !== 'Tab') return;
            /*
             * Tab cycles the channel rather than moving focus.
             *
             * Taking Tab from the browser is a real cost — it is how a keyboard user leaves a
             * field — so it is taken only *inside* the message box, where the alternative is
             * tabbing out of the thing the player is mid-sentence in. Escape still gets them
             * out, and the channel buttons remain clickable.
             */
            e.preventDefault();
            const at = channels.indexOf(scope);
            const next = channels[(at + 1) % channels.length];
            if (next !== undefined) setScope(next);
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
