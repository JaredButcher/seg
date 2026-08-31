/**
 * The debug overlay's ramp and colour key (`render/field.ts`).
 *
 * Pure, so it is tested without a canvas — which is the reason the drawing is a function that
 * fills a buffer rather than a method that talks to a 2D context. What is worth pinning is not the
 * colours, which are a taste decision, but the properties a reader of an overlay relies on without
 * knowing it: an absent reading is *invisible* rather than dark, the buffer is written in the
 * payload's own row order so the field lands on the map the right way up, and the key's colours
 * are the overlay's own.
 */

import { packFieldMap, FIELD_LEVELS, FIELD_SPECS, type FieldMapView } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import {
  fieldRampGradient,
  fieldRangeText,
  fieldScaleLabels,
  paintField,
} from '../src/render/field.js';

/** A payload of one sample per bucket given, laid out `cols × rows`. Bucket 0 is absent. */
function map(cols: number, rows: number, buckets: readonly number[]): FieldMapView {
  const runs: number[] = [];
  for (const bucket of buckets) runs.push(bucket, 1);
  return { ...packFieldMap(FIELD_SPECS.noise, { cols, rows, cellSize: 20 }, []), cols, rows, runs };
}

/** The RGBA of sample `i`. */
function pixel(rgba: Uint8ClampedArray, i: number): number[] {
  return [...rgba.slice(i * 4, i * 4 + 4)];
}

describe('painting a field', () => {
  it('leaves an absent reading completely transparent', () => {
    // The whole reason the overlay can sit under the scope: most of most fields is nothing, and a
    // wash over all of it would dim the display for no information at all.
    const rgba = new Uint8ClampedArray(4 * 4);
    paintField(rgba, map(2, 2, [0, 0, 0, 0]));

    for (let i = 0; i < 4; i += 1) expect(pixel(rgba, i)[3]).toBe(0);
  });

  it('draws a stronger reading more opaquely, and never fully opaque', () => {
    const rgba = new Uint8ClampedArray(3 * 4);
    paintField(rgba, map(3, 1, [1, 30, FIELD_LEVELS]));

    const [faint, middling, loud] = [pixel(rgba, 0), pixel(rgba, 1), pixel(rgba, 2)];
    expect(faint[3]).toBeGreaterThan(0);
    expect(middling[3]).toBeGreaterThan(faint[3] ?? 0);
    expect(loud[3]).toBeGreaterThan(middling[3] ?? 0);
    // Short of solid, so the water box and the frame under it stay legible.
    expect(loud[3]).toBeLessThan(255);
  });

  it('runs hot at the top of the ramp and cool at the bottom', () => {
    const rgba = new Uint8ClampedArray(2 * 4);
    paintField(rgba, map(2, 1, [1, FIELD_LEVELS]));

    const cool = pixel(rgba, 0);
    const hot = pixel(rgba, 1);
    // Blue-dominant at the bottom, red-dominant at the top — the direction the rest of the
    // display already trains the eye for (`render/palette.ts`).
    expect(cool[2]).toBeGreaterThan(cool[0] ?? 0);
    expect(hot[0]).toBeGreaterThan(hot[2] ?? 0);
  });

  it('drives the ramp off the bucket, so every field gets the same colours', () => {
    // The fields are in different units over different domains; the *colours* must not be, or a
    // developer who learns to read one overlay has learned nothing about the next.
    const noise = new Uint8ClampedArray(4);
    const range = new Uint8ClampedArray(4);
    paintField(noise, map(1, 1, [40]));
    paintField(range, {
      ...packFieldMap(FIELD_SPECS.range, { cols: 1, rows: 1, cellSize: 20 }, []),
      cols: 1,
      rows: 1,
      runs: [40, 1],
    });

    expect([...noise]).toEqual([...range]);
  });

  it('writes the payload in its own row order, so nothing is mirrored', () => {
    // Row 0 of the payload is the map's y ≈ 0 edge (`@seg/shared/match/field.ts`), and the world
    // container's own −y scale is what puts it at the bottom of the screen. A flip here would
    // cancel that one and hang the field upside down over the map.
    const rgba = new Uint8ClampedArray(4 * 4);
    paintField(rgba, map(2, 2, [0, 0, 20, 20]));

    expect(pixel(rgba, 0)[3]).toBe(0);
    expect(pixel(rgba, 1)[3]).toBe(0);
    expect(pixel(rgba, 2)[3]).toBeGreaterThan(0);
    expect(pixel(rgba, 3)[3]).toBeGreaterThan(0);
  });

  it('draws nothing at all for a payload with no runs, rather than throwing', () => {
    const rgba = new Uint8ClampedArray(2 * 4);
    paintField(rgba, map(2, 1, []));

    expect([...rgba]).toEqual(new Array(8).fill(0));
  });
});

describe('the colour key', () => {
  it('labels each field in its own units, from the payload alone', () => {
    // The key relabels itself because the payload says what it is measuring — nothing on this end
    // knows the roster, which is what lets a field be added server-side without touching the
    // client at all.
    const noise = map(1, 1, [1]);
    expect(fieldScaleLabels(noise)).toEqual(['2', '24', '46', '68', '90']);
    expect(fieldRangeText(noise)).toBe('2 to 90 dB');

    const range = packFieldMap(FIELD_SPECS.range, { cols: 1, rows: 1, cellSize: 20 }, []);
    expect(fieldScaleLabels(range)).toEqual(['0', '1000', '2000', '3000', '4000']);
    expect(fieldRangeText(range)).toBe('0 to 4000 m');
  });

  it('draws its gradient from the same ramp the overlay paints with', () => {
    const gradient = fieldRampGradient();

    // Both ends of the ramp, in the order the bar runs. If the two ever drift, the key would be
    // confidently wrong about every colour on the screen — which is the whole reason it is
    // generated rather than written out in the stylesheet.
    expect(gradient).toMatch(/^linear-gradient\(to right, /);
    expect(gradient).toContain('rgb(10 58 107) 0%');
    expect(gradient).toContain('rgb(255 59 92) 100%');

    // And the ends agree with what `paintField` puts down at the same two buckets.
    const rgba = new Uint8ClampedArray(2 * 4);
    paintField(rgba, map(2, 1, [1, FIELD_LEVELS]));
    expect([...rgba.slice(0, 3)]).toEqual([10, 58, 107]);
    expect([...rgba.slice(4, 7)]).toEqual([255, 59, 92]);
  });
});
