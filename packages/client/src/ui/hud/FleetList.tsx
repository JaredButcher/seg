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
 * list is where the throttle lives until the bottom control strip lands (planning/08 §5, §11) —
 * and **`R` and `F` step the selected boat's notch up and down**. Two ways to one command again,
 * and the same split: the keys are for the boat you are flying, the buttons for the one three
 * rows down. A step rather than a key per notch, because the decision a player makes under fire
 * is "faster" or "quieter", not "flank specifically", and three notches is a short ladder.
 *
 * ## The tubes, and the second level of selection
 *
 * **Ctrl+number sub-selects a tube** on the boat that is already selected, and **space** fires
 * every tube so armed at the point under the cursor (`render/ScopeHost`). Pressed again it
 * disarms. With nothing armed, space fires the first tube that can — which is the shot a player
 * who has never read a key binding will take, and it should work.
 *
 * The digits are the *tube's* number, not the boat's, and the two bindings share a keyboard
 * because they are never both meaningful: an unmodified digit means "this boat" and a modified
 * one means "this tube of the boat I already have". The modifier is the level.
 *
 * **Shift+number opens a tube's load picker** outright, and clicking a tube pip opens it too —
 * plus Enter, which opens the one for the tube most recently armed. Three ways in, for the same
 * reason `Q` and the sonar switch are two ways to one command: shift+number is for the tube you
 * have decided about, Enter is for the one you are already working, and the pip is for the one
 * three rows down that you can see is about to matter. Inside the panel the arrow keys walk the
 * loads and Enter takes one (`hud/TubePicker`).
 *
 * The panel covers the **whole** fleet list rather than opening beside the pip that summoned it,
 * so it is rendered here and not inside the row. Anchored to the row it would hang off the top or
 * the bottom of a right column it is nearly as tall as, and be clipped by the list's own scroll
 * besides — the load names are the widest text in the HUD, and there is no anchor position that
 * fits them for every row. The tube it belongs to is named on its head, which is the one thing
 * the anchoring was carrying.
 *
 * **`C` empties every tube holding something other than what it has queued, and loads what they
 * have queued, now** — the same swap a shift-click in the picker performs, across the whole boat
 * at once, whether or not the tube happens to be armed. A queued load otherwise waits for the
 * tube to cycle, and the moment a player stops being willing to wait is a moment they have no
 * clicks to spare picking tubes one at a time either.
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
} from '@seg/shared';
import { useEffect, useRef, useState } from 'react';

import { useLobby } from '../../state/lobby.js';
import { useMatch } from '../../state/match.js';
import {
  digitIndexFor,
  formatDepth,
  formatPitch,
  fleetRows,
  shiftThrottle,
  SELECTION_KEYS,
  type FleetRow,
} from './rows.js';
import { TubePicker } from './TubePicker.js';
import { isTyping } from './typing.js';

/** The key that toggles active sonar on the selected boat. */
const PING_KEY = 'q';

/** One notch up the throttle, and one notch down, on the selected boat. */
const THROTTLE_UP_KEY = 'r';
const THROTTLE_DOWN_KEY = 'f';

/** Eject what the armed tubes are holding and load what they have queued, now. */
const SWAP_KEY = 'c';

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
  const throttle = useRef(onThrottle);
  /** Whether a picker is open, for the key handler — which owns Enter only while none is. */
  const open = useRef(picker);
  useEffect(() => {
    latest.current = rows;
    pick.current = onPick;
    throttle.current = onThrottle;
    open.current = picker;
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
      // Every binding below is a discrete command — pick this boat, arm that tube, one notch up
      // — and none of them is a key you hold. Without this, a finger resting on R would send a
      // throttle order per repeat, and a resting C would eject a torpedo per repeat.
      if (event.repeat) return;

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

      // ── shift+number: open a tube's load picker outright ───────────────────────
      // The tube is named rather than armed first, because choosing a load and setting up a
      // salvo are different jobs: a player queueing a super-cavitator into tube three has no
      // reason to arm it, and arming it as a side effect would quietly change what the next
      // shot fires. Shift rather than another modifier because the picker's *other* gesture is
      // already shift — shift-click to swap — so the whole load interface sits on one key.
      //
      // Any shift press stops here: the bindings below are bare keys, and shift+Q is not one
      // of them. `event.code`, because shift turns a digit into punctuation (`rows.ts`).
      if (event.shiftKey) {
        if (commandable === undefined) return;
        const index = digitIndexFor(event.code);
        if (index === null || index >= commandable.tubes.length) return;
        event.preventDefault();
        setPicker({ boat: commandable.profile.id, tube: index });
        return;
      }

      // ── Enter: open the picker for the tube most recently armed ────────────────
      // Only with something armed, because Enter belongs to the chat box otherwise (hud/Chat).
      // The two never both fire: chat checks the same armed set before it opens.
      //
      // And not at all while a picker is already open: there Enter means "take the load I have
      // walked the highlight onto" (`hud/TubePicker`), which is the panel's own binding and the
      // reason the arrow keys are worth having.
      if (event.key === 'Enter') {
        if (open.current !== null) return;
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

      // ── R and F: one notch up, one notch down ─────────────────────────────────
      // The notch the step is measured from is the *boat's*, off the latest view frame, rather
      // than anything this panel remembers: the throttle is a request, and the row only moves
      // when the server says it did (`onThrottle`). Stepping from a local guess would let a
      // player who leaned on R outrun the acknowledgements and send notches that do not exist.
      const stepped = event.key.toLowerCase();
      if (stepped === THROTTLE_UP_KEY || stepped === THROTTLE_DOWN_KEY) {
        if (commandable === undefined) return;
        event.preventDefault();
        const next = shiftThrottle(
          commandable.snapshot.throttle,
          stepped === THROTTLE_UP_KEY ? 1 : -1,
        );
        // Already flat out, or already crawling. Sending it anyway would be a command that
        // changes nothing, ten times a second, for as long as the key is held.
        if (next === commandable.snapshot.throttle) return;
        throttle.current(commandable, next);
        return;
      }

      // ── C: stop waiting, change the load now ──────────────────────────────────
      // For every tube on the boat holding something other than what it has queued: eject it and
      // start the new load, which is the shift-click swap and costs the same (`match/tubes.ts`).
      // A queued load is otherwise a decision that only lands on the next cycle, and the moment
      // a player wants it now — a Heavy has appeared and every tube is holding the cheap load —
      // is a moment they do not have four clicks to spare picking each tube first.
      //
      // Whether the tube is armed is irrelevant: this is a loadout command, not a firing one, and
      // gating it on arming would make the one key a player reaches for under pressure silently
      // do nothing until they had separately named every tube it should touch.
      if (stepped === SWAP_KEY) {
        if (commandable === undefined) return;
        // Only a loaded tube can be swapped — one already cycling has nothing to eject, and one
        // whose queued load matches what it holds would spend a full cycle to change nothing.
        const stale = commandable.tubes.filter(
          (tube) => tube.status === 'loaded' && tube.weapon !== tube.next,
        );
        if (stale.length === 0) return;
        event.preventDefault();
        for (const tube of stale) loadTube(commandable.profile.id, tube.index, tube.next, true);
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
  }, [select, setActiveSonar, toggleTube, loadTube, inputEnabled]);

  /*
   * The boat and tube a picker is open for, resolved here rather than inside the row that owns
   * the pip: the panel covers the whole list, so it is the list's child and not the row's (see
   * `.tube-picker` in styles.css). A picker whose boat or tube has left the latest frame renders
   * as nothing, which is the same "points at nothing" case the effect above closes.
   */
  const openBoat = picker === null ? undefined : rows.find((row) => row.profile.id === picker.boat);
  const openTube = openBoat?.tubes.find((tube) => tube.index === picker?.tube);

  return (
    <section className="hud-fleet" aria-label="Fleet">
      {/*
        The scrolling half, inside the panel rather than being it: the picker overlays the whole
        list, and an overlay inside the scroll container would scroll away with the rows.
      */}
      <div className="hud-fleet__body">
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
              />
            ))}
          </ol>
        )}
      </div>

      {openBoat !== undefined && openTube !== undefined && (
        <TubePicker
          tube={openTube}
          boatName={openBoat.profile.name}
          onPick={(weapon, swap) => {
            loadTube(openBoat.profile.id, openTube.index, weapon, swap);
          }}
          onClose={() => setPicker(null)}
        />
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
  onChoose,
  onThrottle,
  onPing,
  onOpenPicker,
}: {
  readonly row: FleetRow;
  readonly selected: boolean;
  /** Tube indices a press of space would fire. Always empty for a boat that is not selected. */
  readonly armed: readonly number[];
  /** The row's hit target was clicked: select this boat and look at it. */
  readonly onChoose: (row: FleetRow) => void;
  readonly onThrottle: (row: FleetRow, notch: ThrottleNotch) => void;
  readonly onPing: (boat: EntityId, active: boolean) => void;
  readonly onOpenPicker: (tube: number) => void;
}) {
  const { profile, snapshot, key, tubes, depth, standing, integrity, cavitating } = row;
  const hull = getHull(profile.hull);
  const lost = snapshot.status === 'destroyed';
  const pinging = snapshot.activeSonar;

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
        </div>
      )}

      {/*
        The commands, in one strip under the readout: the throttle, and the active sonar switch
        at its end. Both are siblings of the hit button rather than parts of it — the hit button
        is the row's camera target, and a nested button would both be invalid markup and make
        clicking a notch jump the camera.

        A wreck gets neither, and the strip is dropped rather than emptied: there is nothing to
        command, and a row of dead controls would be four hit targets that do nothing.
      */}
      {!lost && (
        <div className="hud-boat__controls">
          <div
            className="hud-boat__throttle"
            role="group"
            aria-label={`${profile.name} throttle. Keys R and F, one notch up and down.`}
          >
            {THROTTLE_NOTCHES.map((notch) => (
              <button
                type="button"
                key={notch}
                className={[
                  'hud-boat__throttle-button',
                  snapshot.throttle === notch ? 'hud-boat__throttle-button--on' : '',
                  cavitating && snapshot.throttle === notch
                    ? 'hud-boat__throttle-button--loud'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-pressed={snapshot.throttle === notch}
                onClick={() => onThrottle(row, notch)}
                // The keys are on the buttons, the way Q is on the sonar switch: a binding is
                // learned by reading the panel it belongs to or it is not learned at all.
                title={`${THROTTLE_LABELS[notch]} — R for one notch up, F for one down`}
              >
                {THROTTLE_LABELS[notch]}
              </button>
            ))}
          </div>

          {/*
            `aria-pressed` rather than a checkbox, because this is a control that acts on the
            world the instant it is pressed rather than a setting collected and submitted. The
            label says what pressing it will *do*, and the state is carried by `aria-pressed` — a
            label that read "ping on" would be ambiguous between the two in exactly the way
            toggles always are.
          */}
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
        </div>
      )}
    </li>
  );
}

/**
 * One tube pip: what it holds, what state it is in, and whether a press of space would fire it.
 *
 * The **countdown replaces the abbreviation** while a tube is cycling, because the two facts a
 * player wants from a tube are never both interesting at once: a loaded tube prompts "what is in
 * it", and a reloading one prompts "how long". The load that is *arriving* is still readable —
 * `TubeState.weapon` becomes `next` at the moment of firing (`match/tubes.ts`), so the title and
 * the accessible name carry it while the face carries the clock.
 *
 * Armed is drawn as a filled pip rather than as a colour change alone (planning/08 §7), and it
 * is the state that decides whether the next press of space fires this tube.
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
      title={`Tube ${String(tube.index + 1)}: ${verb}. Next: ${getWeapon(tube.next).name}. Ctrl+${String(tube.index + 1)} to arm, Shift+${String(tube.index + 1)} to choose its load.`}
      aria-label={`Tube ${String(tube.index + 1)}, ${verb}.${armed ? ' Armed.' : ''} Choose the next load.`}
    >
      <span aria-hidden="true">
        {cycling ? `${String(Math.ceil(tube.readyInSeconds))}s` : weapon.abbreviation}
      </span>
    </button>
  );
}
