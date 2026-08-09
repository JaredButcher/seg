/**
 * Decibels, and the one thing about them that everything gets wrong.
 *
 * A decibel is a logarithm, so **decibels do not add**. Two sources of 40 dB together are
 * 43 dB, not 80; a source 20 dB above the noise contributes 99% of what is heard and the
 * noise contributes 1%. Every "sum" in the acoustic model therefore has to leave the log
 * domain, add powers, and come back — and every place that forgets produces a number that
 * looks plausible and is wrong by an order of magnitude.
 *
 * These four functions exist so that summation is spelled `addDecibels` at the call site and
 * a plain `+` on two dB values reads as the mistake it is. The one legitimate `+` on decibels
 * is a *gain* — array gain, a reflection loss, a transmission loss — because those are ratios
 * and ratios really do add in the log domain.
 *
 * The reference is arbitrary and shared: every level in the game is dB relative to the quiet
 * ocean (`ACOUSTICS.ambientNoise` is 0 by construction). Nothing here is dB re 1 µPa and
 * nothing should be compared against a real hydrophone datasheet.
 */

/** The power ratio a decibel figure stands for. `toPower(0)` is 1, `toPower(10)` is 10. */
export function toPower(decibels: number): number {
  return 10 ** (decibels / 10);
}

/**
 * The decibel figure a power ratio stands for. Silence — a power of zero or less — is
 * `-Infinity`, which is the honest answer and compares correctly against every threshold.
 */
export function toDecibels(power: number): number {
  return power > 0 ? 10 * Math.log10(power) : -Infinity;
}

/** Two levels heard at once. Not `a + b`. */
export function addDecibels(a: number, b: number): number {
  return toDecibels(toPower(a) + toPower(b));
}

/** Every level heard at once. `sumDecibels([])` is silence. */
export function sumDecibels(levels: readonly number[]): number {
  let power = 0;
  for (const level of levels) power += toPower(level);
  return toDecibels(power);
}
