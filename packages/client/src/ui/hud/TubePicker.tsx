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
 * `shift`+the tube's number opens this (`hud/FleetList`), **↑ / ↓** walk the list, and **Enter**
 * takes the load the walk landed on — shift-Enter swaps, the same as shift-click. The highlight
 * is real DOM focus rather than a state the panel paints, which is what makes Enter, the focus
 * ring, and what a screen reader announces one thing instead of three that have to agree. It also
 * scrolls the list for free, which matters the day there are more loads than fit.
 *
 * The scope stops answering the arrows while this has focus, or choosing a torpedo would zoom the
 * camera behind the panel (`hud/typing.ts#ownsKeyboard`).
 */

import {
  DEPLOYABLE_WEAPON_IDS,
  UNLOAD_SECONDS,
  getWeapon,
  type TubeState,
  type WeaponId,
} from '@seg/shared';
import { useEffect, useRef, useState } from 'react';

import { useEscape } from '../escape.js';

interface TubePickerProps {
  readonly tube: TubeState;
  /** Which boat, for the accessible name — the panel can be open over any row. */
  readonly boatName: string;
  readonly onPick: (weapon: WeaponId, swap: boolean) => void;
  readonly onClose: () => void;
}

export function TubePicker({ tube, boatName, onPick, onClose }: TubePickerProps) {
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
  const queuedIndex = DEPLOYABLE_WEAPON_IDS.indexOf(tube.next);
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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Otherwise the page scrolls under the match, and — for as long as the panel is open —
      // the arrows are this list's rather than the scope's zoom.
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const count = DEPLOYABLE_WEAPON_IDS.length;
      setHighlight((current) => (current + step + count) % count);
      return;
    }

    if (event.key === 'Enter') {
      const weapon = DEPLOYABLE_WEAPON_IDS[highlight];
      if (weapon === undefined) return;
      // Enter on a focused button already means "click it", and letting both happen would load
      // the tube twice. This handler is the one that runs, because it is the one that can also
      // read shift as the swap it is on the mouse.
      event.preventDefault();
      // And the key stops here. Chat opens on a bare Enter (`hud/Chat`), and its guard is the
      // focus-based `ownsKeyboard` — which no longer holds by the time the window sees this
      // press, because taking a load closes the panel and focus falls to the body with it.
      // Stopping the event at the panel is what keeps the chat box from opening behind a load
      // that was just chosen.
      event.stopPropagation();
      choose(weapon, event.shiftKey);
    }
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
        {DEPLOYABLE_WEAPON_IDS.map((id, index) => {
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
                    {weapon.seeker === 'none' ? 'no seeker' : 'active seeker'}
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
          ? `SHIFT — EMPTY THE TUBE NOW, ${UNLOAD_SECONDS} S THEN RELOAD`
          : '↑ ↓ AND ENTER, OR CLICK, TO QUEUE · HOLD SHIFT TO EMPTY AND RELOAD NOW'}
      </p>
    </div>
  );
}
