/**
 * The fleet list (planning/08 §11, element 3; §5). Right edge, above the mini-map.
 *
 * One row per boat **you** command, in fixed fleet order — the order never re-sorts, because
 * a list that reorders itself under the cursor is unusable as a command surface (§6). Each
 * row carries what the spec asks for: name, class, hit points, **depth**, **speed**, throttle
 * notch, test/crush proximity, cavitation state, and per-tube status.
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
 * Each notch wears **the speed it is worth on that hull**, because the notches are absolute speeds
 * and not fractions: full is a knot under the boat's own cavitation line, so the same three words
 * mean three different pairs of numbers on a Light, a Medium, and a Heavy.
 *
 * ## The tubes, and the second level of selection
 *
 * **Every boat has exactly one tube selected, always**, and **space** fires it at the point under
 * the cursor and steps the selection to the next one, wrapping past the last (`hud/ScopeHost`
 * takes the key, `MatchScreen#onFire` performs it). So the default gesture for a four-tube boat is
 * space four times, in tube order, with no set-up at all — and the selection is remembered per
 * boat, so switching away and back finds the boat where it was left (`state/match.ts#armedTube`).
 *
 * **Ctrl+number aims that selection at a tube outright**, and **← / →** step it without firing.
 * Two ways again, and the same split as everywhere else in this panel: the digit is for the tube
 * you have decided about, and the arrows are for walking past one you would rather skip — a tube
 * with twenty seconds left on it, when the one behind it is loaded.
 *
 * The digits are the *tube's* number, not the boat's, and the two bindings share a keyboard
 * because they are never both meaningful: an unmodified digit means "this boat" and a modified
 * one means "this tube of the boat I already have". The modifier is the level.
 *
 * ## The loads
 *
 * **`E` opens the load picker for the tube that is up**, and that is all it does with the panel
 * shut. Once it is open the key changes hands: `E` is then the panel's, where ↑ / ↓ walk the loads
 * and `E` takes the one the walk landed on — shift+`E` takes it and empties the tube to load it now
 * (`hud/TubePicker`). One key for the whole loadout decision, and the opening press is deliberately
 * inert: a player reaching for `E` to see what a tube is holding must not change it by looking.
 *
 * **Shift+number opens the picker for a named tube**, and clicking a tube pip opens it too. Three
 * ways in, for the same reason `Q` and the sonar switch are two ways to one command: `E` is for the
 * tube you are about to fire, shift+number is for another tube on the same boat, and the pip is for
 * the one three rows down that you can see is about to matter.
 *
 * **Enter has nothing to do with the tubes any more, at either level.** It used to open the picker
 * for the tube most recently armed, and inside the panel it took the highlighted load; both are
 * gone and it is chat's alone (`hud/Chat`). The first went when a tube became *always* armed — the
 * condition the binding hung on stopped existing, and the key would have swallowed every Enter in
 * the match. The second went with it, because a chat key that works only while a panel happens to
 * be shut is a chat key players stop trusting. `E` covers both jobs now.
 *
 * `C` used to eject and reload every stale tube on the boat at once, which was the "load it now"
 * gesture before there was a single armed tube to hang one off; shift+`E` is that gesture on the
 * tube the player is actually looking at, and two keys for one idea was one too many. The key is
 * now the **countermeasure**, which is the one thing it should always have been: it is the only
 * command on this panel a player gives without deciding anything, and `C` is where their hand
 * already is.
 *
 * The panel covers the **whole** fleet list rather than opening beside the pip that summoned it,
 * so it is rendered here and not inside the row. Anchored to the row it would hang off the top or
 * the bottom of a right column it is nearly as tall as, and be clipped by the list's own scroll
 * besides — the load names are the widest text in the HUD, and there is no anchor position that
 * fits them for every row. The tube it belongs to is named on its head, which is the one thing
 * the anchoring was carrying.
 *
 * ## The countermeasure launcher
 *
 * **`C` drops the selected boat's noisemaker** (`match/world.ts#CountermeasureState`), and the row
 * carries the launcher as a pip at the end of the tube strip — the same control, the same
 * countdown, and deliberately set apart from the tubes it sits beside, because it is not one.
 *
 * It is a bare key with no aiming step and no second level, unlike everything else here, and that
 * is the whole design of the control: a countermeasure is dropped in the two seconds between
 * hearing a torpedo and being hit by it. A gesture that asked *where* would be a gesture nobody
 * completed in time, and there is nowhere to ask about anyway — a noisemaker goes straight down.
 */

import {
  getHull,
  getWeapon,
  throttleSpeedFor,
  tubeWeaponIdsFor,
  THROTTLE_LABELS,
  THROTTLE_NOTCHES,
  type CountermeasureState,
  type EntityId,
  type MatchSetup,
  type MatchViewState,
  type ThrottleNotch,
  type TubeState,
} from '@seg/shared';
import { useEffect, useRef, useState } from 'react';

import type { SonarPicture } from '../../render/picture.js';
import { useLobby } from '../../state/lobby.js';
import { armedTubeOf, useMatch } from '../../state/match.js';
import {
  digitIndexFor,
  formatDepth,
  formatNoiseLevel,
  formatPitch,
  formatSpeed,
  formatSpeedValue,
  fleetRows,
  fleetThreats,
  shiftThrottle,
  SELECTION_KEYS,
  type FleetRow,
} from './rows.js';
import { TubePicker } from './TubePicker.js';
import { isTyping, ownsKeyboard } from './typing.js';

/** The key that toggles active sonar on the selected boat. */
const PING_KEY = 'q';

/** One notch up the throttle, and one notch down, on the selected boat. */
const THROTTLE_UP_KEY = 'r';
const THROTTLE_DOWN_KEY = 'f';

/**
 * Open the load picker for the tube that is up.
 *
 * Only with the panel shut. Once it is open the key belongs to the panel, which spends it walking
 * the loads (`hud/TubePicker`) — one key for the whole decision, at two levels.
 */
const OPEN_LOAD_KEY = 'e';

/** One tube along the selected boat's strip, and one back. Fires nothing. */
const TUBE_NEXT_KEY = 'ArrowRight';
const TUBE_PREV_KEY = 'ArrowLeft';

/** Drop the selected boat's noisemaker. No modifier, no aim, no confirmation — see the header. */
const COUNTERMEASURE_KEY = 'c';

/** Which tube a picker is open for: whose boat, and which of its tubes. */
interface OpenPicker {
  readonly boat: EntityId;
  readonly tube: number;
}

interface FleetListProps {
  readonly setup: MatchSetup;
  readonly view: MatchViewState;
  /**
   * The team's sonar picture, for the threat solve behind the alert badge (`hud/rows.ts`).
   *
   * Handed over by reference and mutated in place as frames land, exactly as `MiniMap` takes it.
   * That is safe here for the same reason it is safe there: this panel already re-renders on every
   * view frame, because `view` is replaced whole, and the frame that mutates the picture is the
   * frame that triggers the render which reads it.
   */
  readonly picture: SonarPicture | null;
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
  picture,
  onFocus,
  onPick,
  onThrottle,
  inputEnabled,
}: FleetListProps) {
  const rows = fleetRows(setup, view);
  /*
   * Which of these rows has a weapon closing on it (`render/threat.ts`).
   *
   * Recomputed every render rather than memoized, because the inputs change on every view frame
   * anyway and one of them — the picture — is mutable, so a dependency array could not see it move.
   * It is a handful of dot products over a handful of boats.
   */
  const threatened = fleetThreats(setup, view, picture).threatened;
  const selected = useMatch((s) => s.selected);
  /** The one tube the selected boat would fire. Always a tube, never a set (`state/match.ts`). */
  const armed = useMatch((s) => armedTubeOf(s, s.selected));
  const select = useMatch((s) => s.select);
  const selectTube = useMatch((s) => s.selectTube);
  const cycleTube = useMatch((s) => s.cycleTube);
  const setActiveSonar = useLobby((s) => s.setActiveSonar);
  const loadTube = useLobby((s) => s.loadTube);
  const dropCountermeasure = useLobby((s) => s.dropCountermeasure);

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
  /** Whether a picker is open, for the key handler — which owns `E` only while none is. */
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

      // ── ctrl+number: point the selection at a tube ─────────────────────────────
      // Ctrl+digit is a browser tab switch, so this is genuinely taking something back. It is
      // worth it: the gesture is the one the whole weapons interface is built on, it only fires
      // when a boat is selected and the digit names one of its tubes, and every other ctrl+digit
      // falls through to the browser untouched.
      //
      // Pressed twice it does nothing the second time, where it used to disarm. There is no
      // "nothing selected" state to go back to any more — a boat always has exactly one tube up —
      // so a key that undid itself would have to guess which other tube the player meant.
      if (event.ctrlKey || event.metaKey) {
        if (commandable === undefined) return;
        const index = SELECTION_KEYS.indexOf(event.key);
        if (index < 0 || index >= commandable.tubes.length) return;
        event.preventDefault();
        selectTube(commandable.profile.id, index);
        return;
      }

      // ── E: the load picker for the tube that is up ─────────────────────────────
      // Ahead of the shift branch, and deliberately indifferent to shift: with the panel shut,
      // both `E` and shift+`E` mean "open it". The shifted form only starts to differ once there
      // is a load to step *from*, and a shift+`E` that did nothing until the panel happened to be
      // open would be a key that works or not depending on state the player cannot see.
      //
      // And nothing at all while a panel is already open: the key is the panel's there, where it
      // queues the next load along (`hud/TubePicker`). The panel stops the event itself as well —
      // this guard is the one that does not depend on where focus happens to be.
      if (event.key.toLowerCase() === OPEN_LOAD_KEY) {
        if (commandable === undefined || open.current !== null) return;
        if (commandable.tubes.length === 0) return;
        event.preventDefault();
        // Clamped, so a remembered index that has outlived the tubes it named opens *a* picker
        // rather than none. `armedTubeOf` is read from the store rather than from this render for
        // the same reason the boat is: the listener outlives both.
        const armedIndex = armedTubeOf(useMatch.getState(), commandable.profile.id);
        const tube = Math.min(armedIndex, commandable.tubes.length - 1);
        setPicker({ boat: commandable.profile.id, tube });
        return;
      }

      // ── shift+number: open a tube's load picker outright ───────────────────────
      // The tube is named rather than armed first, because choosing a load and choosing what
      // fires next are different jobs: a player queueing a super-cavitator into tube three has no
      // reason to fire from it, and arming it as a side effect would quietly change what the next
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

      // ── ← and →: walk the selected boat's tubes, firing nothing ────────────────
      // The other half of the tube selection, and the one for the tube you have *not* decided
      // about: space steps the selection as a side effect of shooting, and this steps it without.
      // What it is actually for is skipping — a tube with twenty seconds left on it, when the one
      // behind it is loaded and the shot is now.
      //
      // Gated on `ownsKeyboard` rather than on this handler's own `isTyping`, because the load
      // picker binds arrows of its own to walk its list (`hud/TubePicker`): without this, choosing
      // a torpedo would quietly move the firing tube behind the panel. It is the same rule the
      // scope uses to give up the zoom arrows, stated the same way (`hud/typing.ts`).
      if (event.key === TUBE_NEXT_KEY || event.key === TUBE_PREV_KEY) {
        if (commandable === undefined || ownsKeyboard(document.activeElement)) return;
        if (commandable.tubes.length === 0) return;
        // Otherwise the page scrolls sideways under the fixed match screen.
        event.preventDefault();
        cycleTube(
          commandable.profile.id,
          commandable.tubes.length,
          event.key === TUBE_NEXT_KEY ? 1 : -1,
        );
        return;
      }

      if (event.key.toLowerCase() === PING_KEY) {
        if (commandable === undefined) return;
        event.preventDefault();
        setActiveSonar(commandable.profile.id, !commandable.snapshot.activeSonar);
        return;
      }

      // ── C: drop the countermeasure ────────────────────────────────────────────
      // Sent whatever the launcher's state, and not gated on `canDrop` here: the server owns that
      // rule (`server/match/runtime.ts#drop`) and a client that also owned it would be a second
      // copy racing a countdown that arrives at 10 Hz. A press against a reloading launcher costs
      // one small message and changes nothing, which is the same bargain the fire key makes.
      //
      // Gated on the boat having a launcher this player can *see*, which is the same thing as its
      // being theirs: `MatchViewState.own` carries it for their own boats and nothing else, so a
      // teammate's hull selected off the scope has `null` here and the key does nothing rather
      // than sending a command the server would refuse.
      if (event.key.toLowerCase() === COUNTERMEASURE_KEY) {
        if (commandable === undefined || commandable.countermeasure === null) return;
        event.preventDefault();
        dropCountermeasure(commandable.profile.id);
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
  }, [select, setActiveSonar, selectTube, cycleTube, dropCountermeasure, inputEnabled]);

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
                // Whether a weapon in the water is on course for this boat and close enough to
                // reach it (`render/threat.ts`). Not "is there a torpedo somewhere" — an alert
                // that fired for every weapon on the map is an alert a player stops reading.
                threatened={threatened.has(row.profile.id)}
                // Every boat remembers a tube, but only the selected boat's is the one space
                // would fire — so only its row shows the mark. A column of highlighted pips down
                // a panel of boats none of which the next press would fire from would be actively
                // misleading, and that argument did not change when the set became a single tube.
                armed={row.profile.id === selected ? armed : null}
                onChoose={(chosen) => {
                  select(chosen.profile.id);
                  onFocus(chosen);
                }}
                onThrottle={onThrottle}
                onPing={setActiveSonar}
                onDrop={() => {
                  // Selects the boat as well, for the reason clicking a tube pip does: the key is
                  // bound to the *selection*, and leaving the two pointing at different boats is
                  // how a player drops from one hull and then presses C expecting another.
                  select(row.profile.id);
                  dropCountermeasure(row.profile.id);
                }}
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
          tubeWeaponIds={tubeWeaponIdsFor(openBoat.profile.weaponSubstitutions)}
          onPick={(weapon, swap) => {
            loadTube(openBoat.profile.id, openTube.index, weapon, swap);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}

function Row({
  row,
  selected,
  threatened,
  armed,
  onChoose,
  onThrottle,
  onPing,
  onDrop,
  onOpenPicker,
}: {
  readonly row: FleetRow;
  readonly selected: boolean;
  /** A weapon is closing on this boat and can reach it. Draws the alert badge. */
  readonly threatened: boolean;
  /** The tube a press of space would fire, or `null` on a boat that is not selected. */
  readonly armed: number | null;
  /** The row's hit target was clicked: select this boat and look at it. */
  readonly onChoose: (row: FleetRow) => void;
  readonly onThrottle: (row: FleetRow, notch: ThrottleNotch) => void;
  readonly onPing: (boat: EntityId, active: boolean) => void;
  /** The launcher pip was clicked: drop this boat's noisemaker. */
  readonly onDrop: () => void;
  readonly onOpenPicker: (tube: number) => void;
}) {
  const { profile, snapshot, key, tubes, countermeasure, depth, standing, integrity, cavitating, noiseLevel } =
    row;
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
          `${profile.name}, ${hull.name}, ${formatDepth(depth)} deep, ${formatSpeed(snapshot.speed)}, ` +
          `${formatNoiseLevel(noiseLevel)} of noise.` +
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
          {/*
            The alert, between the name and the class so it lands in the column a player scans
            down rather than at the ragged right edge where the class abbreviation ends.

            A wreck never shows one. A weapon still running at a hull that has already been lost
            is true and completely useless, and an alarm on a row marked LOST is the panel
            contradicting itself.

            `role="status"` rather than `alert`: it is announced when a screen reader next comes up
            for air instead of interrupting whatever the player was being told, which for a
            condition that lasts tens of seconds is the right urgency. The text is the accessible
            half of a badge whose visual half is a shape and a colour.
          */}
          {threatened && !lost && (
            <span className="hud-boat__threat" role="status">
              <span aria-hidden="true">!</span>
              <span className="hud-boat__threat-text">Torpedo closing</span>
            </span>
          )}
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

            {/*
              Depth, pitch, and the speed the boat is *actually* making — which is not the notch
              below it. A throttle is a request the hull takes seconds to answer, and the gap
              between the two is the whole reason this number is worth a line: a boat ordered to
              slow is still loud until this catches up, and a boat that has run into rock reads
              flank on the strip and nothing here.

              Noise sits beside it rather than deriving from speed alone, because it isn't just
              speed: hull and upgrades set the floor, and damage or running past test depth add
              to it on top (`BoatSnapshot.noiseLevel`).

              Hard against the right edge, so a column of them lines up down the panel and the
              question "who is moving" is answered by scanning one column rather than the row.
            */}
            <span className="hud-boat__line">
              <span className={`hud-boat__depth hud-boat__depth--${standing}`}>
                {formatDepth(depth)}
              </span>
              <span className="hud-boat__pitch">{formatPitch(snapshot.facing)}</span>
              <span className="hud-boat__noise">{formatNoiseLevel(noiseLevel)}</span>
              <span className="hud-boat__speed">{formatSpeed(snapshot.speed)}</span>
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
      {!lost && (tubes.length > 0 || countermeasure !== null) && (
        <div className="hud-boat__tubes" role="group" aria-label={`${profile.name} tubes`}>
          {tubes.map((tube) => (
            <Tube
              key={tube.index}
              tube={tube}
              armed={armed === tube.index}
              onOpen={() => onOpenPicker(tube.index)}
            />
          ))}
          {/*
            The launcher at the end of the strip, after a gap the stylesheet puts there. In the
            strip because it is the same kind of thing — a slot with something in it and a clock on
            it — and set apart in it because it is not a tube: it has no number, it cannot be armed,
            and no picker opens off it. A player scanning the row for "what can I do right now"
            wants one place to look, and a separate control somewhere else on the row would be a
            second place to learn.
          */}
          {countermeasure !== null && (
            <Launcher launcher={countermeasure} boatName={profile.name} onDrop={onDrop} />
          )}
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
            {THROTTLE_NOTCHES.map((notch) => {
              /*
               * What this notch is worth on *this* hull, under its name.
               *
               * The notches are absolute speeds rather than fractions and every hull answers them
               * differently (`match/world.ts`): slow is five knots for everyone, full is a knot
               * under the boat's own cavitation line, and flank is whatever it has. So SLOW /
               * FULL / FLANK names a decision without saying what the decision costs, and a
               * player deciding whether a Heavy can reach a zone before the enemy does has no way
               * to find out short of ordering it and watching. The number is the answer.
               *
               * Bare, without the unit: the row's own speed readout carries `m/s` one line above,
               * and repeating it three times per row across ten rows would be thirty copies of a
               * unit that never changes.
               */
              const notchSpeed = throttleSpeedFor(profile.stats, notch);
              return (
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
                  title={`${THROTTLE_LABELS[notch]} — ${formatSpeed(notchSpeed)}. R for one notch up, F for one down`}
                  // Spelled out rather than left to the two spans, which would be read as
                  // "FLANK 15.0" — a bare number is not a speed to anyone who cannot see the
                  // column it is lined up in.
                  aria-label={`${THROTTLE_LABELS[notch]}, ${formatSpeed(notchSpeed)}`}
                >
                  <span className="hud-boat__notch">{THROTTLE_LABELS[notch]}</span>
                  <span className="hud-boat__notch-speed" aria-hidden="true">
                    {formatSpeedValue(notchSpeed)}
                  </span>
                </button>
              );
            })}
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
 * is the state that decides whether the next press of space fires this tube. Exactly one pip on
 * the selected boat's row wears it, and the mark walks the strip as the player fires or arrows
 * along it — which makes the strip a readout of the firing order as well as of the loads.
 */
/**
 * The countermeasure launcher pip: whether there is a noisemaker in it, or how long until there is.
 *
 * Reads like a tube on purpose — the same size, the same countdown-replaces-the-abbreviation rule,
 * the same "what is in it / how long" question — because it is the same question about the same
 * kind of gear. What it deliberately does *not* have is the tube's second level: no number, no
 * armed state, and no picker. There is one thing it can hold and one thing you can do with it, so
 * the whole control is a button that does that thing (`match/world.ts#CountermeasureState`).
 *
 * It is not `aria-pressed`, unlike a tube pip, for the same reason: a tube pip is a *selection* that
 * persists, and this fires a command and is over.
 */
function Launcher({
  launcher,
  boatName,
  onDrop,
}: {
  readonly launcher: CountermeasureState;
  readonly boatName: string;
  readonly onDrop: () => void;
}) {
  const ready = launcher.status === 'ready';
  const verb = ready ? 'noisemaker ready' : 'reloading';

  return (
    <button
      type="button"
      className={`hud-tube hud-tube--launcher hud-tube--${ready ? 'loaded' : 'reloading'}`}
      // A reloading launcher refuses the command anyway (`server/match/runtime.ts#drop`), but a
      // disabled button says so before the press rather than after it — and unlike the fire key,
      // which walks on to the next tube whatever happens, there is nothing else this could do.
      disabled={!ready}
      onClick={onDrop}
      title={`Countermeasure launcher: ${verb}. C drops it.`}
      aria-label={`${boatName} countermeasure launcher, ${verb}. Drop it. Key C.`}
    >
      <span aria-hidden="true">
        {ready
          ? getWeapon('noisemaker').abbreviation
          : `${String(Math.ceil(launcher.readyInSeconds))}s`}
      </span>
    </button>
  );
}

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
      title={`Tube ${String(tube.index + 1)}: ${verb}. Next: ${getWeapon(tube.next).name}. Ctrl+${String(tube.index + 1)} to fire from it next, ← → to step, E or Shift+${String(tube.index + 1)} to choose its load.`}
      aria-label={`Tube ${String(tube.index + 1)}, ${verb}.${armed ? ' Firing next.' : ''} Choose the next load.`}
    >
      <span aria-hidden="true">
        {cycling ? `${String(Math.ceil(tube.readyInSeconds))}s` : weapon.abbreviation}
      </span>
    </button>
  );
}
