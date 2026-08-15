/**
 * What a tube loads next — the panel that covers the fleet list (planning/08 §5).
 *
 * Deliberately *not* the `<dialog>` the fleet editor uses. That one is a modal over a screen
 * where the player is planning; this one opens over a running match, and a modal would make the
 * ocean inert while a torpedo was in the water. It is a popover over the fleet list — the whole
 * of it, rather than anchored to the pip that opened it (`hud/FleetList`) — the match keeps
 * running behind it, and Escape or a click anywhere else puts it away.
 *
 * ## Two commands on one list
 *
 * A plain click **queues** the load. For a tube sitting *loaded*, nothing changes until it next
 * cycles; for one already *reloading*, the pick retargets the reload in progress — there is
 * nothing in the tube yet to lose, so the new choice is simply what arrives (`match/tubes.ts`).
 * A **shift**-click *swaps* — the weapon in the tube is ejected over `UNLOAD_SECONDS` and the new
 * one loaded behind it, which costs the tube an unload and a reload and is the price of changing
 * your mind about something you are already holding.
 *
 * Both are on the same row rather than on two, because they are the same decision made with
 * different urgency, and a separate "swap" column would be a second thing to read on a control
 * the player is using while being shot at. The modifier is stated on the panel, and shift-held
 * relabels every row so the player can see which command they are about to give before they give
 * it.
 *
 * ## And both are reachable without the mouse
 *
 * `E` opens this for the tube that is up and `shift`+the tube's number opens it for any other
 * (`hud/FleetList`). Then **↑ / ↓** walk the list committing nothing, and **`E`** takes the load
 * the walk landed on and closes — shift+`E` swaps, the same as shift-click. One key for the whole
 * loadout decision, at two levels: it opens the panel, and it takes what the panel is offering.
 *
 * **Enter does nothing here.** It used to be this key, and it is now chat's alone — a match where
 * the one binding for talking to your team depends on whether a panel happens to be open is a
 * match where players stop talking. The key is still *taken* by the panel and dropped on the
 * floor, because every row in the list is a `<button>` and the browser activates a focused button
 * on Enter: left alone, the load would be chosen by the very key that is supposed to have stopped
 * choosing loads.
 *
 * The highlight is real DOM focus rather than a state the panel paints, which is what makes the
 * take key, the focus ring, and what a screen reader announces one thing instead of three that
 * have to agree. It also scrolls the list for free, which matters the day there are more loads
 * than fit.
 *
 * The scope stops answering the arrows while this has focus, or choosing a torpedo would zoom the
 * camera behind the panel (`hud/typing.ts#ownsKeyboard`).
 */

import {
  UNLOAD_SECONDS,
  getWeapon,
  type TubeState,
  type WeaponId,
  type WeaponSeeker,
} from '@seg/shared';
import { useEffect, useRef, useState } from 'react';

import { useEscape } from '../escape.js';

/** The key that opens this panel, and then takes from it. Its other half is in `hud/FleetList`. */
const TAKE_KEY = 'e';

/**
 * The sensor half of a row's stat line — the shortest true thing that can be said about each.
 *
 * Exhaustive over `WeaponSeeker` rather than a ternary on "is it `none`", because the difference
 * between the two homing loads is *entirely* this field and a picker that called both of them
 * "seeker" would be hiding the only decision the pair asks the player to make
 * (`content/weapons.ts`). The words are the ones the descriptions use, so a player reading down a
 * row meets the same vocabulary twice rather than two names for one thing.
 */
const SEEKER_LABELS: Readonly<Record<WeaponSeeker, string>> = {
  none: 'no seeker',
  active: 'active seeker — it pings',
  passive: 'passive seeker — silent',
  switchable: 'switchable seeker',
};

interface TubePickerProps {
  readonly tube: TubeState;
  /** Which boat, for the accessible name — the panel can be open over any row. */
  readonly boatName: string;
  /**
   * What this boat's tube may actually be told to load — `TUBE_WEAPON_IDS` with any fitted
   * "Improved" module's variant substituted in for the load it replaces
   * (`content/weapons.ts#tubeWeaponIdsFor`). Passed in rather than read off the constant here so
   * this panel never has to know that substitution is a thing, only that it has a list.
   */
  readonly tubeWeaponIds: readonly WeaponId[];
  readonly onPick: (weapon: WeaponId, swap: boolean) => void;
  readonly onClose: () => void;
}

export function TubePicker({ tube, boatName, tubeWeaponIds, onPick, onClose }: TubePickerProps) {
  /*
   * Shift is tracked rather than only read at the click, so the panel can *say* what a click
   * will do. A modifier whose effect is invisible until after it has fired is a modifier players
   * do not use, and this one destroys a loaded weapon.
   */
  const [swapping, setSwapping] = useState(false);

  /*
   * Which row the keyboard is on. It opens on the load the tube already has queued rather than
   * at the top, so the panel opens *at* the current decision — one press of ↓ from "what I chose
   * last time" is the question a player is actually asking, and Enter straight away is a no-op
   * rather than a surprise.
   */
  const queuedIndex = tubeWeaponIds.indexOf(tube.next);
  const [highlight, setHighlight] = useState(queuedIndex < 0 ? 0 : queuedIndex);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  /*
   * The highlight *is* focus. Moved here rather than at the keypress so the two can never drift,
   * and applied on open as well — a panel summoned by shift+3 that left focus behind on the
   * fleet row would answer Enter with whatever that row does.
   */
  useEffect(() => {
    items.current[highlight]?.focus();
  }, [highlight]);

  useEffect(() => {
    const update = (event: KeyboardEvent) => setSwapping(event.shiftKey);
    // `blur` as well: alt-tabbing away while shift is down eats the keyup, and the panel would
    // otherwise sit there claiming the next click will eject a torpedo.
    const release = () => setSwapping(false);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', release);
    };
  }, []);

  useEscape(onClose);

  /** Take a load: queue it, or — held shift, or nothing worth ejecting — swap to it now. */
  function choose(weapon: WeaponId, swap: boolean): void {
    onPick(weapon, swap && tube.status === 'loaded' && tube.weapon !== weapon);
    onClose();
  }

  /*
   * The keyboard, on the panel rather than on the window: focus is in here, so the keys are
   * scoped to it by the DOM instead of by a flag that has to be kept in step with the mounting.
   *
   * The list wraps at both ends. It is a menu of two or three loads rather than a ladder with
   * meaningful extremes — the throttle clamps because "already flat out" is a fact worth feeling,
   * and here the only fact is that there is another load below this one.
   */
  function onKeyDown(event: React.KeyboardEvent): void {
    // ── E: take the load the highlight is on, and shut ────────────────────────
    // Shift swaps, exactly as a shift-click does. This is the key Enter used to be.
    if (event.key.toLowerCase() === TAKE_KEY && !event.ctrlKey && !event.metaKey) {
      const weapon = tubeWeaponIds[highlight];
      if (weapon === undefined) return;
      event.preventDefault();
      // And the key stops here. The fleet list binds `E` on the *window* to open this panel, and
      // taking a load closes it — so a press that carried on to the window would find no panel
      // open and immediately put a new one back up, on whichever tube is armed rather than on this
      // one. Stopping it at the panel is what makes the close stick.
      event.stopPropagation();
      choose(weapon, event.shiftKey);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Otherwise the page scrolls under the match, and — for as long as the panel is open —
      // the arrows are this list's rather than the scope's zoom.
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const count = tubeWeaponIds.length;
      setHighlight((current) => (current + step + count) % count);
      return;
    }

    // ── Enter: taken, and dropped ─────────────────────────────────────────────
    // It chooses nothing here any more; it belongs to chat. But it cannot simply be ignored: the
    // highlight *is* focus and every row is a `<button>`, so the browser's own "Enter activates
    // the focused button" would go on choosing loads with the key that is supposed to have
    // stopped. Preventing the default is the whole of the binding.
    //
    // The event is left to bubble. Chat's own guard is `ownsKeyboard`, and this panel is a focused
    // `[role="dialog"]` — so the box stays shut while it is open, without this having to say so.
    if (event.key === 'Enter') event.preventDefault();
  }

  // Closing on any press outside is what makes this a popover rather than a mode. Captured on
  // the way down so a click meant to dismiss the panel does not also reach the scope behind it
  // and order a boat somewhere.
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && document.querySelector('.tube-picker')?.contains(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', dismiss, { capture: true });
    return () => window.removeEventListener('pointerdown', dismiss, { capture: true });
  }, [onClose]);

  return (
    <div
      className="tube-picker"
      role="dialog"
      aria-label={`${boatName} tube ${String(tube.index + 1)}: choose the next load`}
      onKeyDown={onKeyDown}
    >
      <p className="tube-picker__head">
        TUBE {tube.index + 1}
        <span className="tube-picker__now">
          {tube.status === 'loaded'
            ? getWeapon(tube.weapon).abbreviation
            : tube.status === 'unloading'
              ? 'EMPTYING'
              : tube.status === 'reloading'
                ? 'LOADING'
                : 'OUT'}
        </span>
      </p>

      <ul className="tube-picker__list">
        {tubeWeaponIds.map((id, index) => {
          const weapon = getWeapon(id);
          const queued = tube.next === id;
          // Swapping to what is already in the tube would spend a full cycle to end up exactly
          // where it started, which is never what a player meant by it.
          const swap = swapping && tube.status === 'loaded' && tube.weapon !== id;

          return (
            <li key={id}>
              <button
                type="button"
                className="tube-picker__item"
                aria-current={queued}
                // The row the keyboard is on is the row the browser has focused, so the list has
                // to hand its buttons over for the highlight effect to move focus onto.
                ref={(node) => {
                  items.current[index] = node;
                }}
                // Focus follows the pointer as well, so a player who reaches for the mouse and
                // then goes back to the keyboard resumes from where they were looking rather
                // than from where they left off.
                onFocus={() => setHighlight(index)}
                onClick={(event) => {
                  choose(id, event.shiftKey);
                }}
              >
                <span className="tube-picker__abbr" aria-hidden="true">
                  {weapon.abbreviation}
                </span>
                <span className="tube-picker__main">
                  <span className="tube-picker__name">
                    {weapon.name}
                    {queued && !swap && <span className="tube-picker__badge">NEXT</span>}
                    {swap && (
                      <span className="tube-picker__badge tube-picker__badge--swap">SWAP</span>
                    )}
                  </span>
                  <span className="tube-picker__stats">
                    {weapon.speed} m/s · {weapon.range} m · {weapon.turnRate}°/s ·{' '}
                    {SEEKER_LABELS[weapon.seeker]}
                  </span>
                  <span className="tube-picker__desc">{weapon.description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="tube-picker__hint">
        {swapping
          ? `SHIFT+E — EMPTY THE TUBE NOW, ${UNLOAD_SECONDS} S THEN RELOAD`
          : '↑ ↓ AND E, OR CLICK, TO QUEUE · HOLD SHIFT TO EMPTY AND RELOAD NOW'}
      </p>
    </div>
  );
}
