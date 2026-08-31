/**
 * @seg/client/render/field — the debug acoustic overlays, under everything.
 *
 * The only layer on the scope that draws something the player is not supposed to know. It is the
 * acoustic model's own state — the noise in the water, how far a boat can hear, what it can see,
 * how far sound had to swim — arriving on its own message for a connection that asked for it
 * (`@seg/shared/match/field.ts`, `debug/console.ts`), because a balance question about detection
 * is a question about those fields and there was previously no way to look at one but a
 * breakpoint.
 *
 * **One layer for all of them.** Every field is a scalar over the water lattice with a unit and a
 * domain, and the payload carries its own quantization and label, so nothing here knows which one
 * it is drawing. A new field is a `FieldSpec` on the server; this end does not change.
 *
 * ## A texture, not geometry
 *
 * The payload is up to `MAX_FIELD_SAMPLES` cells. Drawn as rectangles that is sixteen thousand
 * fills every time a frame lands, which is a redraw the scope would feel. So it goes the way the
 * mini-map's chart does: an `ImageData` of exactly the payload's grid, one pixel per sample,
 * uploaded as a texture and stretched over the map by a single sprite. The repaint is then a
 * typed-array write and one texture upload, and panning and zooming cost nothing at all because
 * the sprite lives in the world container like everything else.
 *
 * Nearest-neighbour sampling, deliberately. A smoothed heatmap would look better and would be
 * lying about its own resolution — the samples are 40–80 m blocks of a 20 m lattice, and a
 * developer reading a gradient off this needs to see where one sample ends and the next begins.
 *
 * ## The ramp
 *
 * **Bucket zero is *no reading*, and draws as nothing at all** — not as the bottom of the ramp.
 * Every field has that state and it means something different in each (empty sea, water out of
 * reach, a return under the threshold), but they agree on what it looks like: the overlay has to
 * sit *under* the whole scope without dimming the parts of it nobody is asking about. From there
 * it climbs through the three accents the palette already uses for readings — cool, then green,
 * then hot — so a strong reading reads as strong to an eye already trained on this display. Alpha
 * climbs with the value too, so the ramp survives being drawn over the water box at any zoom.
 *
 * jsdom has no 2D context, and this module is imported by a screen the HUD tests mount. Every
 * canvas call is therefore behind a null check and the whole layer degrades to "draws nothing",
 * which is the same path a browser without canvas takes (`test/match-fixture.ts#stubCanvas`).
 */

import {
  fieldDomainOf,
  fieldScaleStops,
  unpackFieldMap,
  FIELD_LEVELS,
  type FieldMapView,
  type MapExtents,
} from '@seg/shared';
import { Container, Sprite, Texture } from 'pixi.js';

/**
 * How opaque the loudest sample is drawn.
 *
 * Short of solid on purpose: at full opacity the overlay hides the water box under it, and the
 * scope stops looking like the scope. Everything the player actually commands is drawn over the
 * top of this and stays fully bright, so the ceiling only has to leave the *background* legible.
 */
const MAX_ALPHA = 0.72;

/** The ramp's stops: level fraction 0..1 to an RGB triple. */
const RAMP: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0x0a, 0x3a, 0x6b], // deep blue — barely above ambient
  [0.35, 0x1f, 0xa3, 0xa8], // teal
  [0.6, 0x5b, 0xf0, 0x8a], // `sonar` green
  [0.8, 0xff, 0xd2, 0x4a], // amber
  [1.0, 0xff, 0x3b, 0x5c], // `hostile` red — the loudest thing in the water
];

/**
 * The ramp as a CSS gradient, for the legend beside the scale bar.
 *
 * Generated from `RAMP` rather than written out again in the stylesheet, which is the whole point
 * of it being here: a legend whose colours had drifted from the overlay's would be worse than no
 * legend, because it would be confidently wrong. Drawn at full opacity — the overlay's alpha ramp
 * is about staying legible over the water, and the legend sits over the HUD where there is
 * nothing to see through.
 */
export function fieldRampGradient(): string {
  const stops = RAMP.map(
    ([at, r, g, b]) => `rgb(${String(r)} ${String(g)} ${String(b)}) ${String(at * 100)}%`,
  );
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/**
 * The overlay's Pixi objects and the canvas behind them.
 *
 * One instance per scope, created whether or not the overlay is ever switched on: it is a
 * container and a sprite with no texture until the first payload lands, which costs nothing, and
 * it means the layer is already in the right place in the stack when a developer types the
 * command mid-match.
 */
export class FieldLayer {
  readonly container = new Container();

  private readonly sprite = new Sprite();
  private readonly canvas: HTMLCanvasElement | null;
  private readonly context: CanvasRenderingContext2D | null;
  private texture: Texture | null = null;
  /** The grid the current texture was built for, so it is only reallocated when the shape moves. */
  private cols = 0;
  private rows = 0;

  constructor(private readonly extents: MapExtents) {
    this.canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    this.context = this.canvas?.getContext('2d') ?? null;
    this.container.visible = false;
    this.container.addChild(this.sprite);
  }

  /**
   * Show one frame of the heatmap, or hide the layer when there is none.
   *
   * `null` is the ordinary case — no overlay, or a match that never had one — and it hides rather
   * than clearing, so switching the overlay off and on again does not have to re-upload a texture
   * that has not changed.
   */
  update(view: FieldMapView | null): void {
    if (view === null || view.cols <= 0 || view.rows <= 0) {
      this.container.visible = false;
      return;
    }
    if (this.context === null || this.canvas === null) return;

    if (view.cols !== this.cols || view.rows !== this.rows) {
      this.canvas.width = view.cols;
      this.canvas.height = view.rows;
      this.cols = view.cols;
      this.rows = view.rows;
      this.texture?.destroy(true);
      this.texture = null;
    }

    const image = this.context.createImageData(view.cols, view.rows);
    paintField(image.data, view);
    this.context.putImageData(image, 0, 0);

    if (this.texture === null) {
      this.texture = Texture.from(this.canvas);
      this.texture.source.scaleMode = 'nearest';
      this.sprite.texture = this.texture;
      // Stretched over the whole map. Sample (0, 0) is the map origin and the payload's rows run
      // the same way the world's y does (`match/field.ts`), so the image needs no flip — the
      // world container's own −y scale is what puts row 0 at the bottom of the screen, where the
      // seabed is.
      this.sprite.position.set(0, 0);
      this.sprite.width = this.extents.width;
      this.sprite.height = this.extents.height;
    } else {
      this.texture.source.update();
    }

    this.container.visible = true;
  }

  destroy(): void {
    this.texture?.destroy(true);
    this.texture = null;
    this.container.destroy({ children: true });
  }
}

/**
 * Fill an RGBA buffer from a packed field — the whole of the drawing, and pure, so the ramp can be
 * tested without a canvas.
 *
 * `rgba` is written in place and must be `cols × rows × 4` bytes, laid out the way `ImageData`
 * wants it. Row `r` of the payload becomes row `r` of the image: the payload is in the map's y-up
 * frame and the world container is flipped, so the two cancel and nothing is mirrored here.
 */
export function paintField(rgba: Uint8ClampedArray, view: FieldMapView): void {
  const samples = unpackFieldMap(view);
  const top = Math.max(1, FIELD_LEVELS - 1);

  for (let i = 0; i < samples.length; i += 1) {
    const bucket = samples[i] ?? 0;
    const at = i * 4;
    if (bucket <= 0) {
      // Left at zero — including the alpha, which is what makes an absent reading invisible
      // rather than a dark wash over the whole map.
      rgba[at + 3] = 0;
      continue;
    }
    // Buckets run 1..FIELD_LEVELS across the payload's domain, so the ramp is driven off the
    // bucket rather than off the value — the units differ between fields and the colours do not.
    const t = Math.min(1, (bucket - 1) / top);
    const [r, g, b] = rampAt(t);
    rgba[at] = r;
    rgba[at + 1] = g;
    rgba[at + 2] = b;
    // Alpha climbs with the reading as well as the hue, so a weak one reads as weak even where
    // its colour is already off the bottom of the ramp.
    rgba[at + 3] = Math.round(255 * MAX_ALPHA * (0.25 + 0.75 * t));
  }
}

/**
 * The five labels a colour key carries for one payload: its own domain, evenly spaced, formatted.
 *
 * Rounded to whole units — every field's domain is chosen so that five stops land on whole numbers
 * (`FIELD_SPECS`), and a key a developer has to read off a fraction is a worse key.
 */
export function fieldScaleLabels(view: FieldMapView, count = 5): string[] {
  return fieldScaleStops(view, count).map((value) => String(Math.round(value)));
}

/** The domain a key's ends stand for, for whoever is announcing it to a screen reader. */
export function fieldRangeText(view: FieldMapView): string {
  const { min, max } = fieldDomainOf(view);
  return `${String(Math.round(min))} to ${String(Math.round(max))} ${view.unit}`;
}

/** The ramp at `t ∈ [0, 1]`, linearly interpolated between its stops. */
function rampAt(t: number): readonly [number, number, number] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < RAMP.length; i += 1) {
    const previous = RAMP[i - 1];
    const next = RAMP[i];
    if (previous === undefined || next === undefined) break;
    if (clamped > next[0] && i < RAMP.length - 1) continue;
    const span = Math.max(1e-6, next[0] - previous[0]);
    const k = Math.min(1, Math.max(0, (clamped - previous[0]) / span));
    return [
      Math.round(previous[1] + (next[1] - previous[1]) * k),
      Math.round(previous[2] + (next[2] - previous[2]) * k),
      Math.round(previous[3] + (next[3] - previous[3]) * k),
    ];
  }
  const last = RAMP[RAMP.length - 1] ?? [1, 0, 0, 0];
  return [last[1], last[2], last[3]];
}
