/**
 * @seg/client/ui/EscMenu — the in-match Esc window (planning/08 §11, element 7).
 *
 * A thin overlay, and deliberately **not a pause**: the simulation keeps running on standing
 * orders while it is open. The panel says so out loud rather than leaving the player to
 * discover it, because every other game they have played stopped the world here.
 *
 * Four destinations — Resume, Settings, Controls, Leave — and no surrender or concede,
 * because there is none in 1.0. Settings and Controls open **in place** rather than
 * navigating: reading your keybinds must never cost you the match.
 *
 * Native `<dialog>` carries the top layer, the focus trap, and inertness for the rest of the
 * page, the same as the fleet pickers. Escape is handled here rather than left to the
 * element's own `cancel`, because the key does two different things depending on where the
 * player is — back out of a sub-pane, or resume — so `onCancel` is always suppressed and the
 * native path never races ours.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';

import { isMuted, setMuted as setAudioMuted } from '../audio/context.js';
import { Pending } from './Pending.js';
import { Button } from './controls.js';
import { useEscape } from './escape.js';

/** Which face of the menu is showing. */
type Pane = 'root' | 'settings' | 'controls' | 'leave';

/**
 * Every key this build binds.
 *
 * Where a boat *goes* sits under the mouse: click to order, shift-click to queue a leg on the
 * route, right-click to cancel (planning/08 §5). What it *does* sits on the left hand — Q for
 * active sonar, R and F for the throttle, and space for the shot the mouse is aiming.
 */
const BINDINGS: ReadonlyArray<{ readonly keys: string; readonly does: string }> = [
  { keys: 'Esc', does: 'Open this menu, back out of a pane, or resume.' },
  {
    keys: '1 – 9, 0',
    does: 'Select a boat, in fleet order. 0 is the tenth, and the scope follows.',
  },
  { keys: 'L-click', does: 'Order the selected boat to the point.' },
  { keys: 'Shift + L-click', does: 'Queue a leg on the selected boat’s route.' },
  { keys: 'R-click', does: 'Cancel the selected boat’s orders.' },
  {
    keys: 'Space',
    does: 'Fire at the cursor: every armed tube, or the first loaded one if none are armed.',
  },
  { keys: 'Ctrl + 1 – 9', does: 'Arm one of the selected boat’s tubes, or disarm it.' },
  { keys: 'R / F', does: 'One notch up or down the selected boat’s throttle.' },
  { keys: 'Q', does: 'Active sonar on or off, for the selected boat. Everyone hears it.' },
  { keys: 'W A S D', does: 'Pan the scope. Drag with the left mouse button does the same.' },
  { keys: '↑ / ↓', does: 'Zoom in and out. The scroll wheel does the same, about the cursor.' },
  { keys: 'Home / End', does: 'Jump to the west or east end of the map.' },
  { keys: 'Enter', does: 'Open chat and start typing. Escape puts it away again.' },
  { keys: 'Tab', does: 'While typing, switch between team and all chat.' },
];

interface EscMenuProps {
  /** Close and return to the scope. */
  onResume: () => void;
  /** Leave the match for the main menu. Confirmed in here first. */
  onLeave: () => void;
}

export function EscMenu({ onResume, onLeave }: EscMenuProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pane, setPane] = useState<Pane>('root');

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  // Through the shared stack rather than the dialog's own `cancel`, so it fires wherever
  // focus sits and the match screen underneath cannot re-open the menu on the same press.
  useEscape(() => {
    if (pane === 'root') onResume();
    else setPane('root');
  });

  return (
    <dialog
      ref={ref}
      className="esc"
      aria-labelledby="esc-title"
      onCancel={(e) => e.preventDefault()}
      // The dialog is the click target only when the press landed on the backdrop, outside
      // the panel's content box.
      onClick={(e) => {
        if (e.target === ref.current) onResume();
      }}
    >
      <div className="esc__head">
        <h2 className="esc__title" id="esc-title">
          MATCH MENU
        </h2>
        {/*
          The single most important line in the panel. `role="status"` rather than plain text
          so a screen-reader user is told the same thing a sighted one reads at a glance.
        */}
        <p className="esc__live" role="status">
          Not paused — your boats are running their standing orders.
        </p>
      </div>

      <div className="esc__body">
        {pane === 'root' && <RootPane onResume={onResume} onGo={setPane} />}
        {pane === 'settings' && <SettingsPane onBack={() => setPane('root')} />}
        {pane === 'controls' && <ControlsPane onBack={() => setPane('root')} />}
        {pane === 'leave' && <LeavePane onCancel={() => setPane('root')} onConfirm={onLeave} />}
      </div>
    </dialog>
  );
}

// ── panes ───────────────────────────────────────────────────────────────────────

function RootPane({ onResume, onGo }: { onResume: () => void; onGo: (pane: Pane) => void }) {
  return (
    <nav className="menu" aria-label="Match menu">
      <MenuAction label="RESUME" description="Back to the scope." onSelect={onResume} />
      <MenuAction
        label="SETTINGS"
        description="Audio, video quality, and accessibility."
        onSelect={() => onGo('settings')}
      />
      <MenuAction
        label="CONTROLS"
        description="Every key this build binds."
        onSelect={() => onGo('controls')}
      />
      {/*
        Leaving is the one entry with a consequence, so it is marked as one — a left edge and
        a warmer label, not colour alone (planning/08 §7) — and it opens a confirmation
        rather than firing on the click.
      */}
      <MenuAction
        label="LEAVE MATCH"
        description="Return to the main menu. Your boats stay in the water."
        danger
        onSelect={() => onGo('leave')}
      />
    </nav>
  );
}

/**
 * One real setting, and a note about the rest.
 *
 * The mute is here ahead of the audio pass for a plain reason: active sonar made this the first
 * build that makes a noise — and the propellers made it the first that makes one *continuously* —
 * and shipping a sound a player cannot turn off is not a thing to do to someone. It writes
 * straight through to the audio module rather than into a settings store,
 * because there is no settings store and inventing one for a single boolean would be inventing
 * the shape M6 has to live with.
 */
function SettingsPane({ onBack }: { onBack: () => void }) {
  const [muted, setMuted] = useState(isMuted);

  return (
    <Pane title="Settings" onBack={onBack}>
      <label className="esc__setting">
        <input
          type="checkbox"
          checked={muted}
          onChange={(event) => {
            setMuted(event.target.checked);
            setAudioMuted(event.target.checked);
          }}
        />
        <span className="esc__setting-label">
          Mute audio
          <span className="esc__setting-note">
            Silences everything: your fleet&rsquo;s propellers, active sonar pulses, and impacts.
            The choice is remembered.
          </span>
        </span>
      </label>

      <Pending
        milestone="M6"
        heading="The rest of the settings arrive with the art and audio pass"
        what={
          <>
            Audio mixing, post-processing quality, colourblind palettes, motion toggles, and key
            remapping are all part of that milestone. The mute above is here early because this
            build makes a noise and nothing else here can silence it.
          </>
        }
      />
    </Pane>
  );
}

function ControlsPane({ onBack }: { onBack: () => void }) {
  return (
    <Pane title="Controls" onBack={onBack}>
      <dl className="esc__bindings">
        {BINDINGS.map((binding) => (
          <div className="esc__binding" key={binding.keys}>
            <dt>
              <kbd className="esc__key">{binding.keys}</kbd>
            </dt>
            <dd className="esc__does">{binding.does}</dd>
          </div>
        ))}
      </dl>
    </Pane>
  );
}

/**
 * Leaving is a two-step commit.
 *
 * Not because it is destructive — the boats keep going and the seat is held — but because a
 * mis-click on a four-entry menu should not be the way a player finds out what "leave" means
 * here. The explanation is the point of the step; the button is incidental.
 */
function LeavePane({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <Pane title="Leave match" onBack={onCancel}>
      <aside className="callout" aria-labelledby="esc-leave-heading">
        <h4 className="callout__title" id="esc-leave-heading">
          Your boats keep their orders
        </h4>
        <p>
          Leaving is not conceding, and there is no concede. Your fleet stays in the water on its
          standing orders until the match ends, and it can still be shot at.
        </p>
      </aside>

      <div className="actions">
        <Button variant="ghost" onClick={onCancel}>
          STAY
        </Button>
        <Button onClick={onConfirm}>LEAVE MATCH</Button>
      </div>
    </Pane>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────────────

/** A sub-pane: its own heading, and a back affordance that mirrors what Escape does. */
function Pane({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <section className="esc__pane">
      <div className="esc__pane-head">
        <button type="button" className="back" onClick={onBack}>
          <span aria-hidden="true">←</span> BACK
        </button>
        <h3 className="esc__pane-title">{title}</h3>
      </div>
      {children}
    </section>
  );
}

/**
 * A menu entry carrying its own explanation, matching the main menu's plates.
 *
 * The description sits inside the button so the accessible name is the whole entry — "LEAVE
 * MATCH Return to the main menu. Your boats stay in the water." — which is exactly what a
 * sighted player reads.
 */
function MenuAction({
  label,
  description,
  danger,
  onSelect,
}: {
  label: string;
  description: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={danger === true ? 'menu__item menu__item--danger' : 'menu__item'}
      onClick={onSelect}
    >
      <span className="menu__label">{label}</span>
      <span className="menu__description">{description}</span>
    </button>
  );
}
