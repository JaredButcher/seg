/**
 * @seg/shared/match/probe — one point of water, read out in full.
 *
 * The third of the debug views, and the one that answers a question the other two only draw.
 * `field.ts` is the whole map at a coarse resolution with one number per cell; `reach.ts` is two
 * radii round a transducer. This is **every number the model holds about one point**, taken
 * against one listener, because the last mile of a balance question is always specific: not "why
 * is detection short round here" but *why did that boat, standing there, not hear this one, here*.
 *
 * ## Two halves, and the second one is optional
 *
 * The point's own readings — where it is, how deep, whether it is rock, how loud it is — are facts
 * about the water and need nobody to be listening. Everything else is a fact about a **pair**: a
 * range is from somewhere, a minimum audible level is for somebody. So the listener half is its
 * own object and it is `null` when no boat was named, when the one named has sunk, or when it was
 * never in this match — a probe with nothing selected is still worth taking, and still tells you
 * what the water is doing.
 *
 * ## It is an instant, where the overlays are not
 *
 * A probe is measured on the tick it is asked for, with no window behind it. The `detect` overlay
 * reports the worst gate since its last frame (`field.ts`), so the two can disagree by whatever a
 * transient did in between — and when they do, the overlay is telling you about a moment the probe
 * missed rather than either of them being wrong.
 *
 * ## Units
 *
 * Metres and decibels throughout, and every decibel figure is on the same scale as the content
 * tables (`content/acoustics.ts`) — a source level here is a number that can be compared directly
 * against a hull's `sourceLevel`, which is the whole point of reading one off.
 */

import type { Vec2 } from '../map/types.js';
import type { EntityId } from './world.js';

/**
 * Everything the acoustic model knows about one point, as of one tick.
 *
 * Self-describing in the same way a `FieldMapView` is: nothing here has to be joined against the
 * view frame to be read, because a debug reading that needed the rest of the client to make sense
 * of it would be useless from a console and useless in a bug report.
 */
export interface ProbeReading {
  /** The point asked about, in map metres — not the centre of the lattice cell it landed in. */
  readonly at: Vec2;
  /** Metres below the surface, the same figure a boat's HUD shows for its own depth. */
  readonly depth: number;
  /**
   * Whether the point is open water on the acoustic lattice.
   *
   * Worth its own flag rather than being inferred from a missing range: a point inside rock still
   * gets readings, taken at the nearest water cell (`WaterLattice.waterIndexAt`), because that is
   * how the solver treats a wall — sound reaches its face through the water beside it. Knowing
   * which of the two you are looking at is the difference between "that wall is lit" and "the
   * water there is lit".
   */
  readonly water: boolean;
  /** The lattice cell the readings were actually taken at, for lining up against a field frame. */
  readonly cell: number;
  /**
   * Total sound power at the point, dB, ambient included — what `seg.field('noise')` draws.
   *
   * This is the level that *lights* things: a rock face returns a fraction of it, and a hull is
   * seen by it. It is not what deafens a listener standing here; that is the figure below.
   */
  readonly noise: number;
  /**
   * The deafening part of the same reading, dB.
   *
   * Lower than `noise` wherever a pulse is in the water, because a coherent tone is filtered down
   * to `filterableNoiseFraction` before it counts against anyone's floor. The gap between these
   * two numbers is the whole of the filtering, which is otherwise invisible — and it is a gap only
   * where something with a fraction below 1 is sounding. Every transient deafens in full
   * (`TRANSIENT_NOISE_FRACTION`), so a bang moves both figures together.
   */
  readonly background: number;
  /**
   * Whether the solve this was read from had been asked to compute the water at this point
   * (planning/16 §3.9).
   *
   * The heatmap is only filled where something reads it — rock, hulls, listeners — which is a per
   * cent or two of the sea. A probe reads it somewhere else by definition, so it registers its
   * cell and the *next* solve fills it in. **A reading with `settled: false` is the ambient ocean
   * rather than the truth**, and the client asks again rather than showing it: this is the
   * instrument you would reach for to find a disagreement, so it is the last thing allowed to
   * invent one.
   *
   * `noise`, `background` and `listener.imaging` are the figures affected — the last because it is
   * the one number under `listener` that reads the heatmap rather than a sweep taken on the spot.
   * It comes back `null` until the reading settles, rather than being computed against an ocean
   * that was never filled in.
   */
  readonly settled: boolean;
  /** Everything that needs somebody to be listening, or `null` when nobody was. */
  readonly listener: ProbeListener | null;
}

/**
 * The half of a reading that is about a pair: this point, as heard from one boat.
 *
 * Every figure here is the one the simulation itself uses, taken from the same helpers the solve
 * and the overlays take them from — this file adds no arithmetic of its own, on purpose. A probe
 * that computed its own answer would eventually disagree with the game, and the disagreement would
 * be invisible precisely because this is the instrument you would use to look for it.
 */
export interface ProbeListener {
  readonly boat: EntityId;
  /** Where it is, so a bearing and a ruler can be read off the same object. */
  readonly from: Vec2;
  /** Straight-line distance, metres. */
  readonly straight: number;
  /**
   * The geodesic path length sound actually has to swim to get there, metres — `seg.field('range')`
   * at one point. `null` when no path under `maxRange` exists at all, which is what water sealed
   * off behind rock looks like.
   *
   * Bigger than `straight` wherever the path bends. The two together are the cheapest way to see
   * *that* it bends, which no single number says.
   */
  readonly range: number | null;
  /** Transmission loss over that path, dB. `null` with no path. */
  readonly loss: number | null;
  /** This boat's own machinery as its own array hears it, dB (`selfNoiseOf`). */
  readonly selfNoise: number;
  /**
   * The noise floor it is actually working against, dB: the water round it, weighted, plus its own
   * machinery, plus the ocean — with its own racket taken back out (`noiseFloorOf`).
   */
  readonly floor: number;
  /** The level a return has to reach for this boat to see anything at all, dB (`returnThreshold`). */
  readonly gate: number;
  /**
   * **How loud a source at the point would have to be for this boat to hear it, dB.**
   *
   * The reading this whole tool exists for, and the one to compare against a hull's `sourceLevel`:
   * if this number is under what that hull radiates at rest, it cannot sit there quietly unseen.
   * `seg.field('detect')` at one point — except that the overlay reports a window's worst and this
   * is the instant (see the header). `null` with no path.
   */
  readonly audible: number | null;
  /**
   * The signal excess a rock face at the point would return to this boat, dB — `seg.field('imaging')`
   * at one point.
   *
   * `null` means the return does not clear the threshold: water this boat is lighting too faintly
   * to get an answer back from. Zero would mean it clears it exactly.
   */
  readonly imaging: number | null;
}
