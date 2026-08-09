/**
 * @seg/client/render/zones — what a capture zone looks like, decided once for both views.
 *
 * The scope draws objectives in Pixi and the mini-map draws them in a 2D context, and they have
 * to agree: a circle that is amber on the strategic view and purple on the scope is two
 * objectives to a player glancing between them. So the *decision* — what colour, how far round,
 * how loud — lives here, and each renderer does nothing but put it on its own surface.
 *
 * ## The colour is the progress bar
 *
 * planning/06 §2.2 asks for a zone that reads at a glance, and the mode's whole state fits in a
 * colour and an arc:
 *
 * - **Grey** — it has appeared but has not armed (`objectives.ts`, `ARMING_SECONDS`). Nothing
 *   you do inside it counts.
 * - **Neutral** — armed, and nobody is taking it.
 * - **Blending toward a side** — someone is, and how far the colour has travelled is how far
 *   along they are. Toward `own` when it is going your way and `hostile` when it is not, so the
 *   question "am I winning this one" is answered by hue before it is answered by the arc.
 * - **Frozen** — both sides are inside. The blend holds where it stopped and the ring doubles,
 *   which is the only state that looks like *nothing happening on purpose*.
 *
 * A spectator has no side to be on, so the two teams take the two accents outright.
 */

import { SIM_TICK_HZ, type TeamId, type ZoneStatusView } from '@seg/shared';

import { COLORS } from './palette.js';

/** How a zone should be drawn, in colours and fractions rather than in pixels or metres. */
export interface ZoneStyle {
  /** The ring and fill colour: the neutral tone blended toward `accent` by `progress`. */
  readonly body: number;
  /** The capturing side's colour at full strength, for the progress arc. Neutral when nobody is. */
  readonly accent: number;
  /** 0..1 of the circle the arc sweeps. Zero while arming — an unarmed zone has no progress. */
  readonly progress: number;
  /** Nobody may take it yet. Everything is drawn dimmer and in `zoneArming`. */
  readonly arming: boolean;
  /** Both sides are inside: progress is held, not lost. */
  readonly contested: boolean;
}

/** How long until this zone opens for capture, seconds. Zero once it has. */
export function armingSeconds(zone: Pick<ZoneStatusView, 'armingTicks'>): number {
  return Math.max(0, zone.armingTicks) / SIM_TICK_HZ;
}

/**
 * The style for one zone, from the point of view of one team.
 *
 * `you` is `null` for a spectator, who is watching rather than playing: team 1 takes the
 * friendly accent and team 2 the hostile one, so the two sides stay distinguishable without
 * either of them being *theirs*.
 */
export function zoneStyle(zone: ZoneStatusView, you: TeamId | null): ZoneStyle {
  if (zone.armingTicks > 0) {
    return {
      body: COLORS.zoneArming,
      accent: COLORS.zoneArming,
      progress: 0,
      arming: true,
      contested: false,
    };
  }

  const accent =
    zone.capturing === null
      ? COLORS.zone
      : zone.capturing === (you ?? 'team1')
        ? COLORS.own
        : COLORS.hostile;

  return {
    body: mix(COLORS.zone, accent, zone.progress),
    accent,
    progress: Math.min(1, Math.max(0, zone.progress)),
    arming: false,
    contested: zone.contested,
  };
}

/**
 * Two colours blended channel-wise, `t` of the way from `from` to `to`.
 *
 * Straight linear interpolation in sRGB. It is not perceptually uniform and a proper blend
 * would go through OKLab — but both endpoints here are saturated accents of similar lightness,
 * where the difference is a shade in the middle of the ramp, and what the player has to read is
 * "which end is it nearer", which survives the approximation intact.
 */
export function mix(from: number, to: number, t: number): number {
  const amount = Math.min(1, Math.max(0, t));
  const channel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * amount) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}
