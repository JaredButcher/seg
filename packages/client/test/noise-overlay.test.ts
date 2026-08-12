/**
 * The debug noise overlay's ramp (`render/noise.ts`).
 *
 * Pure, so it is tested without a canvas — which is the reason the drawing is a function that
 * fills a buffer rather than a method that talks to a 2D context. What is worth pinning is not
 * the colours, which are a taste decision, but the two properties a reader of the overlay is
 * relying on without knowing it: quiet water is *invisible* rather than dark, and the buffer is
 * written in the payload's own row order so the heatmap lands on the map the right way up.
 */

import { type NoiseMapView } from '@seg/shared';
import { describe, expect, it } from 'vitest';

import {
  noiseRampGradient,
  noiseScaleStops,
  paintNoise,
  NOISE_MAX_DB,
  NOISE_MIN_DB,
} from '../src/render/noise.js';

/** A payload of one sample per given bucket, laid out `cols × rows`. */
function map(cols: number, rows: number, buckets: readonly number[]): NoiseMapView {
  const runs: number[] = [];
  for (const bucket of buckets) runs.push(bucket, 1);
  return { cols, rows, sampleSize: 40, floor: 0, step: 2, runs };
}

/** The RGBA of sample `i`. */
function pixel(rgba: Uint8ClampedArray, i: number): number[] {
  return [...rgba.slice(i * 4, i * 4 + 4)];
}

describe('painting a heatmap', () => {
  it('leaves quiet water completely transparent', () => {
    // The whole reason the overlay can sit under the scope: most of the map is ambient, and an
    // ambient wash over all of it would dim the display for no information at all.
    const rgba = new Uint8ClampedArray(4 * 4);
    paintNoise(rgba, map(2, 2, [0, 0, 0, 0]));

    for (let i = 0; i < 4; i += 1) expect(pixel(rgba, i)[3]).toBe(0);
  });

  it('draws louder water more opaquely, and never fully opaque', () => {
    const rgba = new Uint8ClampedArray(3 * 4);
    // Buckets of 2 dB: 4 dB, 40 dB, and 100 dB — the last past the top of the ramp.
    paintNoise(rgba, map(3, 1, [2, 20, 50]));

    const [faint, middling, loud] = [pixel(rgba, 0), pixel(rgba, 1), pixel(rgba, 2)];
    expect(faint[3]).toBeGreaterThan(0);
    expect(middling[3]).toBeGreaterThan(faint[3] ?? 0);
    expect(loud[3]).toBeGreaterThan(middling[3] ?? 0);
    // Short of solid, so the water box and the frame under it stay legible.
    expect(loud[3]).toBeLessThan(255);
  });

  it('runs hot at the top of the ramp and cool at the bottom', () => {
    const rgba = new Uint8ClampedArray(2 * 4);
    paintNoise(rgba, map(2, 1, [2, 50]));

    const cool = pixel(rgba, 0);
    const hot = pixel(rgba, 1);
    // Blue-dominant when barely above ambient, red-dominant at the loudest — the direction the
    // rest of the display already trains the eye for (`render/palette.ts`).
    expect(cool[2]).toBeGreaterThan(cool[0] ?? 0);
    expect(hot[0]).toBeGreaterThan(hot[2] ?? 0);
  });

  it('writes the payload in its own row order, so nothing is mirrored', () => {
    // Row 0 of the payload is the map's y ≈ 0 edge (`@seg/shared/match/noise.ts`), and the world
    // container's own −y scale is what puts it at the bottom of the screen. A flip here would
    // cancel that one and hang the heatmap upside down over the map.
    const rgba = new Uint8ClampedArray(4 * 4);
    paintNoise(rgba, map(2, 2, [0, 0, 40, 40]));

    expect(pixel(rgba, 0)[3]).toBe(0);
    expect(pixel(rgba, 1)[3]).toBe(0);
    expect(pixel(rgba, 2)[3]).toBeGreaterThan(0);
    expect(pixel(rgba, 3)[3]).toBeGreaterThan(0);
  });

  it('draws nothing at all for a payload with no runs, rather than throwing', () => {
    const rgba = new Uint8ClampedArray(2 * 4);
    paintNoise(rgba, { cols: 2, rows: 1, sampleSize: 40, floor: 0, step: 2, runs: [] });

    expect([...rgba]).toEqual(new Array(8).fill(0));
  });
});

describe('the colour key', () => {
  it('labels both ends of the ramp and three evenly spread between them', () => {
    const stops = noiseScaleStops();

    expect(stops).toHaveLength(5);
    // The ends are the ramp's own bounds, so the key cannot disagree with the overlay at the two
    // points a reader trusts most.
    expect(stops[0]).toBe(NOISE_MIN_DB);
    expect(stops[4]).toBe(NOISE_MAX_DB);

    const steps = stops.slice(1).map((db, i) => db - (stops[i] ?? 0));
    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 10);
    // Whole decibels, which is what `NOISE_MIN_DB` being 2 rather than 1 buys.
    for (const db of stops) expect(Number.isInteger(db)).toBe(true);
  });

  it('honours a different number of stops, ends included', () => {
    expect(noiseScaleStops(2)).toEqual([NOISE_MIN_DB, NOISE_MAX_DB]);
    expect(noiseScaleStops(3)).toEqual([
      NOISE_MIN_DB,
      (NOISE_MIN_DB + NOISE_MAX_DB) / 2,
      NOISE_MAX_DB,
    ]);
  });

  it('draws its gradient from the same ramp the overlay paints with', () => {
    const gradient = noiseRampGradient();

    // Both ends of the ramp, in the order the bar runs. If the two ever drift, the key would be
    // confidently wrong about every colour on the screen — which is the whole reason it is
    // generated rather than written out in the stylesheet.
    expect(gradient).toMatch(/^linear-gradient\(to right, /);
    expect(gradient).toContain('rgb(10 58 107) 0%');
    expect(gradient).toContain('rgb(255 59 92) 100%');

    // And the ends agree with what `paintNoise` puts down at the same two levels.
    const rgba = new Uint8ClampedArray(2 * 4);
    paintNoise(rgba, {
      cols: 2,
      rows: 1,
      sampleSize: 40,
      floor: 0,
      step: 2,
      runs: [NOISE_MIN_DB / 2, 1, NOISE_MAX_DB / 2, 1],
    });
    expect([...rgba.slice(0, 3)]).toEqual([10, 58, 107]);
    expect([...rgba.slice(4, 7)]).toEqual([255, 59, 92]);
  });
});
