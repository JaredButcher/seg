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
 * **Clicking a row is the same command as pressing its key**: it selects the boat and takes the
 * camera with it (planning/08 §5, §11 element 3). The selection is made here and the camera move
 * is the caller's, exactly as it is for the keys — the two paths are one behaviour, and splitting
 * them differently would be two behaviours that only happen to agree today.
 *
 * **`Q` throws the selected boat's active sonar switch**, and each row carries the same switch
 * as a button. Two ways to the same command rather than one, because they answer different
 * questions: the key is for the boat you are already flying, and the button is for the one three
 * rows down that you can see is about to need it. The button is a sibling of the row's hit
 * target rather than a child — the row is itself a button, and buttons do not nest.
 *
 * Each row also carries the **throttle notch** as a SLOW / FULL / FLANK button group — the fleet
 * list is where the throttle lives until the bottom control strip lands (planning/08 §5, §11).
 *
 * ## The tubes, and the second level of selection
 *
 * **Ctrl+number sub-selects a tube** on the boat that is already selected, and a ctrl-click on
 * the scope fires every tube so armed at that point (`render/ScopeHost`). Pressed again it
 * disarms. With nothing armed, a ctrl-click fires the first tube that can — which is the shot a
 * player who has never read a key binding will take, and it should work.
 *
 * The digits are the *tube's* number, not the boat's, and the two bindings share a keyboard
 * because they are never both meaningful: an unmodified digit means "this boat" and a modified
 * one means "this tube of the boat I already have". The modifier is the level.
 *
 * **Ctrl+number then Enter opens the load picker** for the last tube armed, and clicking a tube
 * pip opens it too. Two ways in, for the same reason `Q` and the sonar switch are two ways to one
 * command: the key is for the tube you are already working, the pip is for the one three rows
 * down that you can see is about to matter.
 */

import {
  getHull,
  getWeapon,
  THROTTLE_LABELS,
  THROTTLE_NOTCHES,
  type EntityId,
  type MatchSetup,
  type MatchViewState,
  type ThrottleNotch,
  type TubeState,
  type WeaponId,
} from '@seg/shared';
import { useEffect, useRef, useState } from 'react';

import { useLobby } from '../../state/lobby.js';
import { useMatch } from '../../state/match.js';
import { formatDepth, formatPitch, fleetRows, SELECTION_KEYS, type FleetRow } from './rows.js';
import { TubePicker } from './TubePicker.js';
import { isTyping } from './typing.js';

/** The key that toggles active sonar on the selected boat. */
const PING_KEY = 'q';

/** Which tube a picker is open for: whose boat, and which of its tubes. */
interface OpenPicker {
  readonly boat: EntityId;
  readonly tube: number;
}

interface FleetListProps {
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
  /**
   * Centre the scope on a boat. A row was clicked — the selection is already made.
   *
   * Unconditional, unlike `onPick`: a click cannot arrive mid-drag, because the scope holds the
   * pointer capture for as long as the gesture lasts and this button never sees the press.
   */
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
  const armed = useMatch((s) => s.armedTubes);
  const select = useMatch((s) => s.select);
  const toggleTube = useMatch((s) => s.toggleTube);
  const setActiveSonar = useLobby((s) => s.setActiveSonar);
  const loadTube = useLobby((s) => s.loadTube);

  const [picker, setPicker] = useState<OpenPicker | null>(null);

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

  /*
   * A picker left open on a boat that has been lost — or that the player has switched away
   * from — is a panel pointing at nothing. Closed here rather than guarded at every use, so
   * there is one rule and it is visible.
   */
  useEffect(() => {
    if (picker !== null && picker.boat !== selected) setPicker(null);
  }, [picker, selected]);

  useEffect(() => {
    if (!inputEnabled) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.altKey) return;
      if (isTyping(document.activeElement)) return;

      /*
       * The boat the keys act on, read from the store rather than from the render that
       * registered this listener — so picking a boat does not have to tear the listener down and
       * put it back. `undefined` for no selection, for an id that has left the frames, or for a
       * wreck: a key pressed too early is not an error state worth a message.
       */
      const target = useMatch.getState().selected;
      const chosen = latest.current.find((candidate) => candidate.profile.id === target);
      const commandable = chosen?.snapshot.status === 'destroyed' ? undefined : chosen;

      // ── ctrl+number: arm a tube on the selected boat ───────────────────────────
      // Ctrl+digit is a browser tab switch, so this is genuinely taking something back. It is
      // worth it: the gesture is the one the whole weapons interface is built on, it only fires
      // when a boat is selected and the digit names one of its tubes, and every other ctrl+digit
      // falls through to the browser untouched.
      if (event.ctrlKey || event.metaKey) {
        if (commandable === undefined) return;
        const index = SELECTION_KEYS.indexOf(event.key);
        if (index < 0 || index >= commandable.tubes.length) return;
        event.preventDefault();
        toggleTube(index);
        return;
      }

      // ── Enter: open the picker for the tube most recently armed ────────────────
      // Only with something armed, because Enter belongs to the chat box otherwise (hud/Chat).
      // The two never both fire: chat checks the same armed set before it opens.
      if (event.key === 'Enter') {
        const tubes = useMatch.getState().armedTubes;
        const last = tubes[tubes.length - 1];
        if (commandable === undefined || last === undefined) return;
        event.preventDefault();
        setPicker({ boat: commandable.profile.id, tube: last });
        return;
      }

      if (event.key.toLowerCase() === PING_KEY) {
        if (commandable === undefined) return;
        event.preventDefault();
        setActiveSonar(commandable.profile.id, !commandable.snapshot.activeSonar);
        return;
      }

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
  }, [select, setActiveSonar, toggleTube, inputEnabled]);

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
              // Only the selected boat's tubes can be armed, so only its row shows the marks.
              // A column of highlighted pips down a panel of boats none of which the next click
              // would fire from would be actively misleading.
              armed={row.profile.id === selected ? armed : EMPTY_TUBES}
              picker={picker?.boat === row.profile.id ? picker.tube : null}
              onChoose={(chosen) => {
                select(chosen.profile.id);
                onFocus(chosen);
              }}
              onThrottle={onThrottle}
              onPing={setActiveSonar}
              onOpenPicker={(tube) => {
                // Clicking a pip selects the boat too. The picker acts on one boat and the
                // firing keys act on the selection, and leaving those two pointing at different
                // boats is how a player queues a load on one and fires from another.
                select(row.profile.id);
                setPicker({ boat: row.profile.id, tube });
              }}
              onLoad={(tube, weapon, swap) => {
                loadTube(row.profile.id, tube, weapon, swap);
              }}
              onClosePicker={() => setPicker(null)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** A stable empty array, so an unselected row's props do not change identity every frame. */
const EMPTY_TUBES: readonly number[] = [];

function Row({
  row,
  selected,
  armed,
  picker,
  onChoose,
  onThrottle,
  onPing,
  onOpenPicker,
  onLoad,
  onClosePicker,
}: {
  readonly row: FleetRow;
  readonly selected: boolean;
  /** Tube indices a ctrl-click would fire. Always empty for a boat that is not selected. */
  readonly armed: readonly number[];
  /** The tube whose load picker is open on this row, or `null`. */
  readonly picker: number | null;
  /** The row's hit target was clicked: select this boat and look at it. */
  readonly onChoose: (row: FleetRow) => void;
  readonly onThrottle: (row: FleetRow, notch: ThrottleNotch) => void;
  readonly onPing: (boat: EntityId, active: boolean) => void;
  readonly onOpenPicker: (tube: number) => void;
  readonly onLoad: (tube: number, weapon: WeaponId, swap: boolean) => void;
  readonly onClosePicker: () => void;
}) {
  const { profile, snapshot, key, tubes, depth, standing, integrity, cavitating } = row;
  const hull = getHull(profile.hull);
  const lost = snapshot.status === 'destroyed';
  const pinging = snapshot.activeSonar;
  const open = picker === null ? undefined : tubes.find((tube) => tube.index === picker);

  return (
    <li
      className={lost ? 'hud-boat hud-boat--lost' : 'hud-boat'}
      data-selected={selected ? true : undefined}
    >
      <button
        type="button"
        className="hud-boat__hit"
        onClick={() => onChoose(row)}
        // The key is in the accessible name, not only in the badge: a player who cannot read
        // the badge still has to be told which digit picks this boat. So is the selection,
        // because the border that carries it is colour and position alone.
        aria-label={
          `${profile.name}, ${hull.name}, ${formatDepth(depth)} deep.` +
          `${key === null ? '' : ` Key ${key}.`}` +
          `${selected ? ' Selected.' : ''}` +
          ` Select it and centre the scope on it.`
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

            <span className="hud-boat__order">
              {snapshot.order.kind === 'hold' ? 'HOLDING' : 'TRANSIT'}
            </span>
          </>
        )}
      </button>

      {/*
        The tubes, as a row of buttons under the boat's readout rather than inside it.

        Outside the hit target because they are commands of their own — a pip opens the load
        picker — and a button cannot nest inside a button. Which means the row's own click no
        longer covers this strip, and that is the right trade: the strip is four small controls
        and the row is a large one, so the thing a stray click lands on is the thing with the
        bigger target.
      */}
      {!lost && tubes.length > 0 && (
        <div className="hud-boat__tubes" role="group" aria-label={`${profile.name} tubes`}>
          {tubes.map((tube) => (
            <Tube
              key={tube.index}
              tube={tube}
              armed={armed.includes(tube.index)}
              onOpen={() => onOpenPicker(tube.index)}
            />
          ))}

          {open !== undefined && (
            <TubePicker
              tube={open}
              boatName={profile.name}
              onPick={(weapon, swap) => onLoad(open.index, weapon, swap)}
              onClose={onClosePicker}
            />
          )}
        </div>
      )}

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

      {/*
        The active sonar switch. A wreck gets none — there is nothing to switch — and the gap
        is left rather than filled, so the column of switches stays a column.

        `aria-pressed` rather than a checkbox, because this is a control that acts on the world
        the instant it is pressed rather than a setting collected and submitted. The label says
        what pressing it will *do*, and the state is carried by `aria-pressed` — a label that
        read "ping on" would be ambiguous between the two in exactly the way toggles always are.
      */}
      {!lost && (
        <button
          type="button"
          className={pinging ? 'hud-boat__ping hud-boat__ping--on' : 'hud-boat__ping'}
          aria-pressed={pinging}
          onClick={() => onPing(profile.id, !pinging)}
          title={pinging ? 'Active sonar on — Q' : 'Active sonar off — Q'}
          aria-label={`${profile.name}: ${pinging ? 'stop pinging' : 'ping'}. Key Q.`}
        >
          <span aria-hidden="true">(( ))</span>
        </button>
      )}
    </li>
  );
}

/**
 * One tube pip: what it holds, what state it is in, and whether a ctrl-click would fire it.
 *
 * The **countdown replaces the abbreviation** while a tube is cycling, because the two facts a
 * player wants from a tube are never both interesting at once: a loaded tube prompts "what is in
 * it", and a reloading one prompts "how long". The load that is *arriving* is still readable —
 * `TubeState.weapon` becomes `next` at the moment of firing (`match/tubes.ts`), so the title and
 * the accessible name carry it while the face carries the clock.
 *
 * Armed is drawn as a filled pip rather than as a colour change alone (planning/08 §7), and it
 * is the state that decides whether the next ctrl-click on the water fires this tube.
 */
function Tube({
  tube,
  armed,
  onOpen,
}: {
  readonly tube: TubeState;
  readonly armed: boolean;
  readonly onOpen: () => void;
}) {
  const weapon = getWeapon(tube.weapon);
  const cycling = tube.status === 'reloading' || tube.status === 'unloading';
  const verb =
    tube.status === 'reloading'
      ? `loading ${weapon.name}`
      : tube.status === 'unloading'
        ? `emptying, then ${getWeapon(tube.next).name}`
        : tube.status === 'empty'
          ? 'out of action'
          : `${weapon.name} loaded`;

  return (
    <button
      type="button"
      className={[`hud-tube hud-tube--${tube.status}`, armed ? 'hud-tube--armed' : '']
        .filter(Boolean)
        .join(' ')}
      aria-pressed={armed}
      onClick={onOpen}
      title={`Tube ${String(tube.index + 1)}: ${verb}. Next: ${getWeapon(tube.next).name}. Ctrl+${String(tube.index + 1)} to arm.`}
      aria-label={`Tube ${String(tube.index + 1)}, ${verb}.${armed ? ' Armed.' : ''} Choose the next load.`}
    >
      <span aria-hidden="true">
        {cycling ? `${String(Math.ceil(tube.readyInSeconds))}s` : weapon.abbreviation}
      </span>
    </button>
  );
}
