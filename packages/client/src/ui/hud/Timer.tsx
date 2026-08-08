/**
 * The match timer (planning/08 §11, element 5). A countdown, beside the score.
 *
 * Neutral until the last five minutes, amber to the last minute, red for the final minute,
 * where it counts in tenths. There is no closing-map marker because there is no closing map
 * (06 §2.1).
 *
 * **It shows the server's clock and does not run between frames.** The clock advances with
 * the simulation tick, and there is no simulation — so it sits at 30:00 rather than counting
 * down from the moment the match screen mounted. A timer running on wall time while nothing
 * else in the world moves would be the one part of the HUD confidently telling the player
 * something untrue.
 */

import type { MatchViewState } from '@seg/shared';

import { clockUrgency, formatClock } from './rows.js';

export function Timer({ view }: { readonly view: MatchViewState }) {
  const urgency = clockUrgency(view.clock.remainingSeconds);

  return (
    <p className={`hud-timer hud-timer--${urgency}`} role="timer" aria-label="Time remaining">
      <span className="hud-timer__glyph" aria-hidden="true">
        ◷
      </span>
      {formatClock(view.clock.remainingSeconds)}
    </p>
  );
}
