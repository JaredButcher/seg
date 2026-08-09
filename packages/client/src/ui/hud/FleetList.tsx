/**
 * The fleet list (planning/08 §11, element 3; §5). Right edge, above the mini-map.
 *
 * One row per boat **you** command, in fixed fleet order — the order never re-sorts, because
 * a list that reorders itself under the cursor is unusable as a command surface (§6). Each
 * row carries what the spec asks for: name, class, hit points, **depth**, throttle notch,
 * test/crush proximity, cavitation state, and per-tube status.
 *
 * At 3–5 boats it is a readout; at 6–10 it becomes the interface. It is built for the second
 * case and looks calm in the first, which is the cheaper way round.
 *
 * **The number keys select, and take the camera with them.** 1–9 then 0, in fleet order, and
 * each row wears its own key so the binding is learned by reading the panel rather than by
 * reading the manual. The keys are handled here rather than in the match screen because this is
 * where the numbering is decided, and a binding whose two halves live in different files drifts.
 *
 * The camera half is *conditional*, and the condition lives one level up: a player dragging the
 * scope has both hands on the camera, and a keypress must not teleport it out from under the
 * gesture. So this panel decides which boat and the match screen decides whether to move, which
 * is the split that keeps the pointer state out of a panel that has no business knowing it.
 *
 * Clicking a row still only snaps the camera, without selecting. That is a deliberate hold on
 * planning/08 §5, and it is now the odd one out.
 */

import {
  getHull,
  getWeapon,
  THROTTLE_LABELS,
  THROTTLE_NOTCHES,
  type MatchSetup,
  type MatchViewState,
  type ThrottleNotch,
} from '@seg/shared';
import { useEffect, useRef } from 'react';

import { useMatch } from '../../state/match.js';
import { formatDepth, formatPitch, fleetRows, type FleetRow } from './rows.js';
import { isTyping } from './typing.js';

interface FleetListProps {
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
  /** Centre the scope on a boat. A row was clicked. */
  readonly onFocus: (row: FleetRow) => void;
  /**
   * A number key picked a boat: centre the scope on it *if the camera is free*.
   *
   * Separate from `onFocus` rather than the same callback, because the two differ in exactly
   * that condition and the caller is the only one holding the state that answers it.
   */
  readonly onPick: (row: FleetRow) => void;
  /** A throttle notch was pressed for a boat: set its speed for the next and current orders. */
  readonly onThrottle: (row: FleetRow, notch: ThrottleNotch) => void;
  /**
   * Whether the number keys are live. False while the Esc menu is up, the same way the scope
   * stops answering the camera keys — the menu's own keys must not double as commands.
   */
  readonly inputEnabled: boolean;
}

export function FleetList({
  setup,
  view,
  onFocus,
  onPick,
  onThrottle,
  inputEnabled,
}: FleetListProps) {
  const rows = fleetRows(setup, view);
  const selected = useMatch((s) => s.selected);
  const select = useMatch((s) => s.select);

  /*
   * The rows are read through a ref rather than closed over: a view frame rebuilds them ten
   * times a second (`ACOUSTIC_TICK_HZ`), and a listener re-registered at that rate for a
   * binding that never changes is pure churn. `onPick` rides along for the same reason — it
   * arrives as a fresh closure on every one of those renders, so putting it in the effect's
   * dependencies would reinstate exactly the churn the ref exists to avoid.
   */
  const latest = useRef(rows);
  const pick = useRef(onPick);
  useEffect(() => {
    latest.current = rows;
    pick.current = onPick;
  });

  useEffect(() => {
    if (!inputEnabled) return;

    function onKeyDown(event: KeyboardEvent): void {
      // Modified digits belong to the browser: ctrl+1 and cmd+2 switch tabs, and taking those
      // would be taking back something the player expects to keep working.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(document.activeElement)) return;

      const row = latest.current.find((candidate) => candidate.key === event.key);
      if (row === undefined) return;

      event.preventDefault();
      // Selection is unconditional; the camera move is the caller's call. Pressing a number
      // during a drag still changes which boat the next order goes to — refusing that as well
      // would make the keys silently dead for as long as the mouse was down.
      select(row.profile.id);
      pick.current(row);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [select, inputEnabled]);

  return (
    <section className="hud-fleet" aria-label="Fleet">
      <h2 className="hud-panel__title">FLEET</h2>

      {rows.length === 0 ? (
        <p className="hud-fleet__empty">
          {setup.you.team === null
            ? 'Spectating. Nothing to command.'
            : 'No boats deployed — the fleet you brought could not be read.'}
        </p>
      ) : (
        <ol className="hud-fleet__rows">
          {rows.map((row) => (
            <Row
              key={row.profile.id}
              row={row}
              selected={row.profile.id === selected}
              onFocus={onFocus}
              onThrottle={onThrottle}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function Row({
  row,
  selected,
  onFocus,
  onThrottle,
}: {
  readonly row: FleetRow;
  readonly selected: boolean;
  readonly onFocus: (row: FleetRow) => void;
  readonly onThrottle: (row: FleetRow, notch: ThrottleNotch) => void;
}) {
  const { profile, snapshot, key, tubes, depth, standing, integrity, cavitating } = row;
  const hull = getHull(profile.hull);
  const lost = snapshot.status === 'destroyed';

  return (
    <li
      className={lost ? 'hud-boat hud-boat--lost' : 'hud-boat'}
      data-selected={selected ? true : undefined}
    >
      <button
        type="button"
        className="hud-boat__hit"
        onClick={() => onFocus(row)}
        // The key is in the accessible name, not only in the badge: a player who cannot read
        // the badge still has to be told which digit picks this boat. So is the selection,
        // because the border that carries it is colour and position alone.
        aria-label={
          `${profile.name}, ${hull.name}, ${formatDepth(depth)} deep.` +
          `${key === null ? '' : ` Key ${key}.`}` +
          `${selected ? ' Selected.' : ''}` +
          ` Centre the scope on it.`
        }
      >
        <span className="hud-boat__head">
          {key !== null && (
            <span className="hud-boat__key" aria-hidden="true">
              {key}
            </span>
          )}
          <span className="hud-boat__name">{profile.name}</span>
          <span className="hud-boat__class">{hull.name.toUpperCase()}</span>
        </span>

        {lost ? (
          <span className="hud-boat__lost">LOST</span>
        ) : (
          <>
            <span className="hud-boat__bar" aria-hidden="true">
              <span
                className={integrity < 0.5 ? 'hud-boat__hp hud-boat__hp--hurt' : 'hud-boat__hp'}
                style={{ inlineSize: `${String(Math.max(0, Math.round(integrity * 100)))}%` }}
              />
            </span>

            <span className="hud-boat__line">
              <span className={`hud-boat__depth hud-boat__depth--${standing}`}>
                {formatDepth(depth)}
              </span>
              <span className="hud-boat__pitch">{formatPitch(snapshot.facing)}</span>
            </span>

            <span className="hud-boat__tubes" aria-label={`${String(tubes.length)} tubes`}>
              {tubes.map((tube) => (
                <span
                  className={`hud-tube hud-tube--${tube.status}`}
                  key={tube.index}
                  title={`Tube ${String(tube.index + 1)}: ${getWeapon(tube.weapon).name}`}
                >
                  {getWeapon(tube.weapon).abbreviation}
                </span>
              ))}
            </span>

            <span className="hud-boat__order">
              {snapshot.order.kind === 'hold' ? 'HOLDING' : 'TRANSIT'}
            </span>
          </>
        )}
      </button>

      {/*
        The throttle, as one button per notch. It is a sibling of the hit button rather than
        part of it — the hit button is the row's camera target, and a nested button would both
        be invalid markup and make clicking a notch jump the camera. The pressed notch is
        `aria-pressed` so the read is not carried by the highlight alone (planning/08 §7).
      */}
      {!lost && (
        <div className="hud-boat__throttle" role="group" aria-label={`${profile.name} throttle`}>
          {THROTTLE_NOTCHES.map((notch) => (
            <button
              type="button"
              key={notch}
              className={[
                'hud-boat__throttle-button',
                snapshot.throttle === notch ? 'hud-boat__throttle-button--on' : '',
                cavitating && snapshot.throttle === notch ? 'hud-boat__throttle-button--loud' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-pressed={snapshot.throttle === notch}
              onClick={() => onThrottle(row, notch)}
            >
              {THROTTLE_LABELS[notch]}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
