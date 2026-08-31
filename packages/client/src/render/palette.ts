/**
 * @seg/client/render/palette — planning/09 §4, as numbers.
 *
 * One copy, because three things now draw the same world: the Pixi scope, the 2D mini-map, and
 * the CSS around them. Pixi wants a number and a canvas wants a string, so both forms live here
 * and are generated from the same literal rather than typed out twice — which is how a rock
 * fill ends up one shade different on the mini-map and nobody can say why.
 *
 * The CSS custom properties in `styles.css` mirror these. They are the fourth copy and the one
 * that cannot be imported; keep them in step by hand.
 */

/** The tokens, as Pixi colours. */
export const COLORS = {
  // ── Field ────────────────────────────────────────────────────────────────────
  background: 0x04070a,
  water: 0x0a1a22,

  // ── Structure ────────────────────────────────────────────────────────────────
  frame: 0x164a55,
  grid: 0x0e2a33,
  label: 0x4e8a94,
  rockFill: 0x0a1418,
  /** `terrain`: a wall the team's own sonar has confirmed. The only rock a player ever sees. */
  rockEdge: 0x1b4650,
  /** `terrain-charted`: ground truth shown to a spectator, who did not earn it. Dim on purpose. */
  rockCharted: 0x0f2830,

  // ── Readings ─────────────────────────────────────────────────────────────────
  own: 0x3bf0c4,
  ally: 0x2b8f95,
  hostile: 0xff3b5c,
  /**
   * `sonar`: a return that has cleared the detection threshold and nothing more.
   *
   * A tenth accent, added for the uncharted picture (ADR 0002), and it earns the slot: every
   * other accent names a thing the game has *identified*, and this one names the state of not
   * having identified it yet. Green rather than a tint of `own` because the two are on screen
   * at once and constantly — a shimmer of squares over your own fleet has to read as a
   * different kind of mark, not as a brighter boat.
   */
  sonar: 0x5bf08a,
  /** `zone`: an objective nobody is taking. The colour a capture blends *out of*. */
  zone: 0xb37aff,
  /**
   * `zone-arming`: an objective that has appeared but cannot yet be taken (`objectives.ts`).
   *
   * Deliberately grey rather than a dimmer `zone`: "not yet" is a different state from "not
   * being taken", and a player glancing at the mini-map has to be able to tell a circle worth
   * moving to from one worth waiting out. Brighter than `lost`, which is a thin mark on a boat
   * where this is a wide thin ring, and lifted so it still reads over charted rock.
   */
  zoneArming: 0x6b7478,
  lost: 0x40474a,
  /**
   * `bubble`: the air still escaping a wreck (planning/04 §8, revised). Pale and cool rather than
   * a tint of `own` or `hostile` — a wreck belongs to neither side any more, and the dots have to
   * read as water doing something, not as a third team's colour.
   */
  bubble: 0x9fd6dc,
} as const;

export type ColorToken = keyof typeof COLORS;

/** The same token as a CSS hex string, for the 2D contexts. */
export function hex(token: ColorToken): string {
  return cssColor(COLORS[token]);
}

/**
 * Any Pixi colour as a CSS hex string.
 *
 * Separate from `hex` because a capture blends two tokens into a colour that is not one
 * (`render/zones.ts`), and the mini-map needs to write that blend into a 2D context.
 */
export function cssColor(value: number): string {
  return `#${Math.round(value).toString(16).padStart(6, '0')}`;
}
