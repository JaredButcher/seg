/**
 * ╔═══════════════════════════════════════════════════════════════════════════════════╗
 * ║  ACOUSTIC TABLE — tuning data. Edit the numbers here; nothing else needs touching. ║
 * ╚═══════════════════════════════════════════════════════════════════════════════════╝
 *
 * Every dB in the game comes from this file (planning/03 §11). The simulation reads it, the
 * HUD reads it, and the balance harness reads it, so a tuning pass is a diff in one table
 * rather than a hunt through the solver.
 *
 * ## The scale
 *
 * **0 dB is the quiet ocean.** Every level in the game is relative to ambient, which is what
 * makes the numbers readable: a source at 40 dB is forty decibels above the sea it is hiding
 * in, and a return at −3 dB is under the noise. Nothing here is dB re 1 µPa and none of it
 * should be checked against a real hydrophone datasheet — planning/03 opens by saying the
 * model is built for legibility, not accuracy, and this is where that is cashed in.
 *
 * ## The model, in four lines
 *
 * ```
 * SL       = hull's rest level + flow + cavitation + damage + stress ⊕ transients   §3
 * TL(r)    = spreadingExponent · log10(r / referenceRange) + absorptionPerKm · r     §4
 * echo     = incident level at the reflector − that material's absorption
 * detected = echo − TL(back) + arrayGain − noiseFloor ≥ detectionThreshold           §5
 * ```
 *
 * Sound travels through water and through nothing else, so `r` is the shortest path *through
 * water*, not the straight line. That is the solver's job (`sim/acoustics`), not this file's.
 *
 * ## Why absorption per kilometre is a hundred times too big
 *
 * Real seawater absorbs a fraction of a dB per kilometre at the frequencies a submarine
 * radiates. Sixteen is not a mistake and it is not a unit error: it is the term that makes
 * planning/03 §9's detection ranges *ratios* come out right. Spreading alone is a logarithm,
 * so the sixty-decibel spread between a creeping scout and a cavitating heavy would be a
 * ten-thousand-fold spread in range rather than the ten-fold the design asks for. A linear
 * term compresses the loud end without touching the quiet end, and it is the only single knob
 * that does. Read it as a lumped stand-in for scattering in a warren of rock, and tune the
 * ranges, not the physics.
 */

import { addDecibels, toDecibels, toPower } from '../math/decibels.js';
import type { Stats } from './stats.js';

export interface AcousticTuning {
  // ── The water ─────────────────────────────────────────────────────────────────
  /** The quiet ocean, and the zero of the whole scale. Moving it moves every other number. */
  readonly ambientNoise: number;
  /** The range a source level is quoted at, metres. `TL(referenceRange)` is zero by definition. */
  readonly referenceRange: number;
  /** Geometric spreading: this many dB per decade of range. 15 sits between spherical and cylindrical. */
  readonly spreadingExponent: number;
  /** The linear loss term, dB per km of water. See the file header on why it is so large. */
  readonly absorptionPerKm: number;

  // ── The materials ─────────────────────────────────────────────────────────────
  /**
   * dB swallowed by one bounce off rock. The same everywhere: the design has no soft
   * sediment, no hard basalt, and no angle of incidence, so terrain is one material.
   */
  readonly terrainAbsorption: number;
  /**
   * dB swallowed by one bounce off a hull of `targetStrength` zero. A hull's own target
   * strength moves it: a quieter-returning boat absorbs more, which is what an anechoic
   * coating buys.
   */
  readonly hullAbsorption: number;

  // ── The emit side (planning/03 §3) ────────────────────────────────────────────
  /** dB added at full speed by flow over the hull, rising as the square of the speed fraction. */
  readonly flowNoiseSpan: number;
  /** The cliff. Added the instant a boat crosses its cavitation speed. */
  readonly cavitationPenalty: number;
  /** And the slope above the cliff, reached at maximum speed. */
  readonly cavitationSpan: number;
  /** The depth a hull's `cavitationSpeed` stat is quoted at, metres. */
  readonly cavitationReferenceDepth: number;
  /** Cavitation speed rises by its own quoted value again per this many metres of extra depth. */
  readonly cavitationDepthScale: number;
  /** A boat past `DAMAGED_HP_FRACTION` is this much louder, permanently (planning/04 §8). */
  readonly damagedPenalty: number;

  // ── Active sonar (planning/03 §3, §6) ─────────────────────────────────────────
  /**
   * Milliseconds between pulses while active sonar is switched on.
   *
   * **A magic number, and knowingly so.** It sets the rhythm of the whole mechanic: how often
   * the picture refreshes, how often the ring goes out, and how often a listening enemy gets a
   * fresh, unambiguous bearing on the boat that fired it. Two seconds is slow enough that each
   * pulse reads as a discrete event with a wait behind it — "the wait is the drama" — and still
   * fast enough that a boat manoeuvring on active sonar is not steering off a stale picture. It
   * wants the balance harness (planning/03 §11), not an argument.
   */
  readonly pingIntervalMs: number;
  /**
   * How long one pulse takes to ring down into the ambient, seconds.
   *
   * Deliberately shorter than `pingIntervalMs`, so pulses never overlap and the picture has a
   * dark interval between them — a boat that pinged continuously would be a floodlight, and the
   * whole tactical grammar of active sonar is that it is *intermittent* and each burst is paid
   * for. Long enough to span several acoustic solves, so a pulse lights more than one frame.
   */
  readonly pingSeconds: number;
  /** A hull below its test depth groans. Continuous, not a transient (planning/03 §3). */
  readonly hullStressPenalty: number;
  /**
   * What a wreck radiates, dB, for as long as it is on the map (planning/04 §8, revised).
   *
   * Air escaping and metal groaning under pressure, and unlike `hullStressPenalty` it is not
   * conditional on depth — a hull that has been torn open makes this noise wherever it sinks.
   * Continuous rather than a transient for the same reason `hullStressPenalty` is: it does not
   * decay, because the thing making it has not stopped. Pitched under every hull's own rest
   * level (41–58 dB) so a wreck reads as background clutter rather than the loudest thing in
   * the water — it is a corpse, not a beacon — while staying clearly above ambient, which is
   * what makes it a legitimate sonar contact and a legitimate seeker target (`sim/weapons/seeker.ts`).
   */
  readonly wreckNoiseLevel: number;

  // ── The receive side (planning/03 §5) ─────────────────────────────────────────
  /** A boat's own machinery, heard by its own hydrophones, at rest. */
  readonly selfNoiseAtRest: number;
  /** And at full speed, again as the square of the speed fraction. */
  readonly selfNoiseSpan: number;
  /** Signal excess required to call something detected. */
  readonly detectionThreshold: number;
  /**
   * How much of the water's background noise actually reaches a listener's noise floor, as a
   * fraction of its power.
   *
   * The heatmap says how loud the water is where the listener is sitting; this says how much of
   * that it has to compete with. Below one it stands in for everything the model does not have —
   * directivity, an operator who knows which bearing the din is on — and its real job is balance:
   * at full weight a few boats in the same chamber raise each other's floors far enough to
   * flatten the picture into nothing, which reads to a player as the sonar breaking rather than
   * as a crowd. Halving the power is a 3 dB cut where the water is noisy and nothing at all where
   * it is quiet, so it costs the lone-boat case nothing.
   *
   * What it does *not* stand in for is tone-filtering, which has its own knob below
   * (`filterableNoiseFraction`): a listener that knows a sound is there can notch it out, and
   * that is a separate reduction from not being able to tell where any of it is coming from.
   *
   * `ambientNoise` is deliberately not scaled by this — the quiet ocean is the zero of the scale
   * and moving it moves every other number in the table.
   */
  readonly backgroundNoiseFraction: number;
  /**
   * How much of a *filterable* sound's power reaches a listener's noise floor, as a fraction of
   * its power — the filter the operator is assumed to be able to run.
   *
   * Not every noise is equal to a hydrophone. A ping is a coherent tone a listener can lock out
   * of its noise estimate, where a bang or a cavitating screw is broadband racket it has to sit
   * in. `filterableNoiseFraction` is the price of that assumption: one means a ping deafens like
   * any other noise of its level (the legacy behaviour), zero means it never deafens anyone —
   * it is still a full-strength *return* and still lights the walls, it just stops drowning out
   * everything else. 0.25 is a 6 dB cut on the ping's floor contribution, kept short of zero so
   * the loudest sound in the game still costs the *other* side a little of their hearing.
   *
   * Applied on top of `backgroundNoiseFraction` at accumulation time, so the effective weight of
   * a ping in a floor is the product of the two. Today the only filterable sound is a ping —
   * a boat's active pulse and a torpedo seeker's — and this is where a future classification
   * module would hang its own lever.
   */
  readonly filterableNoiseFraction: number;

  // ── Confirmation (planning/03 §5.3) ───────────────────────────────────────────
  /**
   * How far a square has to clear the detection threshold before the server calls it
   * *confirmed* rather than merely heard, dB of signal excess.
   *
   * This is the second threshold and it is what the whole player-facing picture hangs off. A
   * square between `0` and this is a faint return: the client shows it as a sonar-green flash
   * and it fades to nothing. A square at or above it is a fact — a rock square joins the team's
   * chart for the rest of the match, a hull square reveals the boat it sits on.
   *
   * The gap between the two thresholds is the skill window planning/03 §5.3 is buying: a good
   * player reads the faint squares and acts on them before the server is willing to agree.
   * Widening it rewards inference; narrowing it makes the game a readout. Twelve decibels is
   * roughly a doubling of range between "something is there" and "that is a wall".
   */
  readonly confirmationThreshold: number;
  /**
   * How far a square has to clear the detection threshold before the server is willing to say
   * **what kind** of weapon it is sitting on, dB of signal excess.
   *
   * The third threshold, and the only one that is about *classification* rather than about
   * position. Confirmation already reveals the object whole for a boat — a hull's silhouette is
   * its class, and a confirmed contact is drawn as it (`match/vision.ts#RevealedContact`). A
   * weapon has no comparable profile: at seven metres every load in the table presents the same
   * three squares, so `ContactKind` can honestly say *torpedo* and stop there. This is what buys
   * the rest of the sentence, and it has to cost something extra because it is worth a great
   * deal: whether the thing running at you is a warhead or a decoy changes what you do about it.
   *
   * Set one confirmation band above `confirmationThreshold`, so the three thresholds divide the
   * scale into equal steps: *something is there* → *that is a torpedo* → *that is a
   * super-cavitating torpedo*. Echo level falls as `40 log₁₀ R` on the two-way path, so 8 dB is
   * about a factor of 1.6 in range — you classify at roughly 40% of the range you confirm at,
   * which is close enough to be a decision and far enough to be a reward.
   *
   * **Sticky once earned** (`ContactBook.confirm`). A classification that flickered back to
   * *generic torpedo* every time the signal breathed would read as the display malfunctioning
   * rather than as the sonar being marginal, and a contact that genuinely slips is dropped and
   * re-acquired under a new `ContactId` anyway.
   */
  readonly identificationThreshold: number;
  /**
   * Seconds a confirmed hull stays *live* after the last solve that confirmed it.
   *
   * While live the client draws a filled silhouette, fading across this window. After it, the
   * boat has slipped detection and what remains is a hollow outline at the last measured pose —
   * never extrapolated, because the client inventing a position is the one thing pillar P3
   * forbids (planning/02 §5).
   */
  readonly contactFadeSeconds: number;
  /**
   * Seconds a hollow last-known marker survives, or `Infinity` to keep it for the match.
   *
   * planning/03 §7 wanted a 30–90 s quality-dependent hold. The picture keeps them for the
   * match instead: with no tracker there is no quality to scale a hold time by, and "he was here
   * once" is information the team genuinely earned. Revisit when the marker clutter of a
   * thirty-minute match has been seen rather than imagined.
   */
  readonly contactHoldSeconds: number;

  // ── The solver's budget (planning/03 §10) ─────────────────────────────────────
  /**
   * Propagation lattice spacing, metres. Detection is decided per lattice cell.
   *
   * Its counterpart, the resolution the *picture* is reported at, is not in this table:
   * `VISION_CELL_SIZE` in `sim/acoustics/skin.ts`. It lives there because both ends of the wire
   * derive the square grid from it, so it cannot be a per-solver override the way these can.
   */
  readonly latticeCell: number;
  /** No sound is followed past this range, whatever the arithmetic says. Metres. */
  readonly maxRange: number;
  /**
   * How far a listener images reflections, metres. Shorter than `maxRange` on purpose.
   *
   * A reflection pays the path twice, so the picture is short-ranged whatever this says; what
   * a longer field would buy is scenery — a cave wall lit by a cavitating boat a mile off. The
   * boat itself is found on the direct path, which needs no field at all, so capping this
   * costs no detection and is the single biggest lever on what a tick costs.
   */
  readonly maxImagingRange: number;
  /** Nor past this many lattice cells from one source, whatever the range says. */
  readonly maxFieldCells: number;
  /** The brightest this many vision squares are sent to a team each solve. */
  readonly maxVisionCells: number;

  // ── Ghosts (planning/15) ─────────────────────────────────────────────────────
  /** Metres from the listening boat a ghost may appear within. */
  readonly ghostRadius: number;
  /** Metres from the boat kept clear. At zero a ghost may land on the boat's own silhouette. */
  readonly ghostInnerRadius: number;
  /**
   * How fast the freckling thins with range: ghosts per square metre fall as `r^−this`.
   *
   * Zero is a flat disc — every square inside `ghostRadius` equally likely, which is where the
   * halo started when it was only 200 m across. At the ping-sized radius it now has, flat would
   * be wrong twice over: twenty-five times the area at the same density is snow rather than
   * own-noise, and the same density at a kilometre as against the hull says nothing about where
   * the noise is coming from. With a falloff the halo reads as what it is — a boat sitting in a
   * dense knot of its own racket, trailing off into the odd distant speck.
   *
   * Must stay below `2`, where the density integrates logarithmically and a zero inner radius has
   * no answer at all; `sim/acoustics/ghosts.ts#ghostRadiusFor` clamps rather than divides by zero.
   */
  readonly ghostFalloffExponent: number;
  /** dB above the boat's own rest level before any ghost appears. The genuinely silent band. */
  readonly ghostNoiseFloor: number;
  /** dB above the floor at which the rate reaches its maximum. */
  readonly ghostNoiseSpan: number;
  /** Ghosts per second per boat, at full rate. */
  readonly ghostRateMax: number;
  /**
   * Ghost signal excess, as a fraction of `confirmationThreshold`. A ghost is emitted with a
   * uniform excess in `[0, this × confirmationThreshold]`, which is what keeps it sub-threshold
   * and lets the client's strength-linked fade (planning/15 §2 Option A) make it short-lived
   * without the wire ever labelling it a ghost.
   */
  readonly ghostExcessFraction: number;

  // ── The wire's budget (planning/02 §6) ────────────────────────────────────────
  /**
   * The brightest this many *uncharted* squares reach a client in one view frame.
   *
   * A separate, much smaller cap than `maxVisionCells`, and the reason it can be small is that
   * a square already on the team's chart is already drawn: only the frontier of discovery and
   * the squares sitting on somebody's hull are ever transmitted. Seconds into a match that is a
   * thin edge rather than every wall in imaging range.
   *
   * This is the number `bench-bandwidth` (planning/13 §9) will argue with — see ADR 0002 on
   * why a fine-grained picture at 10 Hz is in tension with the 8 KB/s budget in the first
   * place.
   */
  readonly maxWireVisionCells: number;
  /**
   * How much of a team's chart backlog one view frame may carry.
   *
   * Chart squares are sent once each and never again, so the steady state is a handful per
   * frame. The cap exists for the two bursts: the opening seconds, and a reconnecting player
   * who is owed the whole chart from scratch. Both catch up over the following frames rather
   * than arriving as one enormous message.
   */
  readonly maxChartCellsPerFrame: number;
}

export const ACOUSTICS: AcousticTuning = {
  ambientNoise: 0,
  referenceRange: 10,
  spreadingExponent: 15,
  absorptionPerKm: 22,

  terrainAbsorption: 8,
  hullAbsorption: 10,

  flowNoiseSpan: 25,
  cavitationPenalty: 18,
  cavitationSpan: 12,
  cavitationReferenceDepth: 200,
  cavitationDepthScale: 600,
  damagedPenalty: 5,
  hullStressPenalty: 6,
  wreckNoiseLevel: 38,

  pingIntervalMs: 2000,
  // Four acoustic solves lit, thirty-six dark. Also a cost decision: a pulse's field sweeps to
  // `maxRange` because it really is audible that far, which makes it the most expensive thing
  // one boat can ask the solver for. Sixty per cent duty would be most of a tick, every tick.
  pingSeconds: 0.4,

  selfNoiseAtRest: -6,
  selfNoiseSpan: 30,
  detectionThreshold: 6,
  backgroundNoiseFraction: 0.5,
  filterableNoiseFraction: 0.25,

  // Placeholder, and measured rather than guessed: a 1v1 on a small dense map produces square
  // excesses in the 15–45 dB band, while four boats clustered in a deployment band raise each
  // other's noise floor enough to cap the picture near 11 dB. Eight leaves a wide faint band in
  // the first case and still lets a crowded fleet chart *something* in the second. It wants the
  // balance harness (planning/03 §11), which does not exist yet.
  confirmationThreshold: 8,
  // One confirmation band above it, so the two gaps are the same size. Wants the same balance
  // harness the number under it does — the knob to watch is whether a player ever gets to read a
  // load's type *before* it is close enough that knowing does not help.
  identificationThreshold: 16,
  contactFadeSeconds: 8,
  contactHoldSeconds: Infinity,

  // Ghosts (planning/15 §3). First-pass, expected to move under the balance harness: the
  // knobs to reach for first are `ghostRateMax` (clutter), `ghostExcessFraction` (how bright),
  // and `ghostInnerRadius` (the Heavy's silhouette).
  //
  // The radius is deliberately the active pulse's own reach rather than a number of its own: own
  // noise smears the picture as far as the picture goes, and a halo that stopped dead at 200 m
  // drew a circle the player could read a range off. `ghostFalloffExponent` is what keeps that
  // from being twenty-five times the clutter — two thirds of the draws still land inside the old
  // 200 m disc, and density at the rim is a seventeenth of density against the hull.
  ghostRadius: 1000,
  ghostInnerRadius: 0,
  ghostFalloffExponent: 1.75,
  ghostNoiseFloor: 1,
  ghostNoiseSpan: 45,
  // Raised from 5 with the radius, and by exactly the factor that leaves the near field alone:
  // 0.2^(2 − 1.75) ≈ 0.67 of the draws land inside 200 m, so 7.5/s there is the 5/s a flank-speed
  // boat used to see. Everything past that is new halo rather than clutter moved outward.
  ghostRateMax: 7.5,
  ghostExcessFraction: 0.25,

  latticeCell: 20,
  maxRange: 4000,
  maxImagingRange: 1200,
  maxFieldCells: 60_000,
  maxVisionCells: 40_000,

  maxWireVisionCells: 1500,
  maxChartCellsPerFrame: 3000,
};

// ── Propagation ─────────────────────────────────────────────────────────────────────

/**
 * How many dB a sound loses over `range` metres of water.
 *
 * Monotone and unbounded above, which the range gate in the solver relies on. Inside the
 * reference range the loss is zero rather than negative: a source level *is* the level at
 * `referenceRange`, so nothing is louder than its own source level.
 */
export function transmissionLoss(range: number, tuning: AcousticTuning = ACOUSTICS): number {
  const beyond = Math.max(range, tuning.referenceRange) - tuning.referenceRange;
  const spread = (beyond + tuning.referenceRange) / tuning.referenceRange;
  return tuning.spreadingExponent * Math.log10(spread) + (tuning.absorptionPerKm * beyond) / 1000;
}

/**
 * The inverse: how far a sound gets before it has lost `loss` dB.
 *
 * Bisected rather than solved, because the two terms are a logarithm and a line and there is
 * no closed form. The upper bracket comes from the linear term alone — the log can only make
 * the loss larger, so `1000·loss/absorptionPerKm` is always past the answer. Used to size the
 * solver's search radius, so it runs a few dozen times a tick, not a few thousand.
 */
export function rangeForLoss(loss: number, tuning: AcousticTuning = ACOUSTICS): number {
  if (loss <= 0) return tuning.referenceRange;
  if (tuning.absorptionPerKm <= 0) {
    return tuning.referenceRange * 10 ** (loss / tuning.spreadingExponent);
  }

  let low = tuning.referenceRange;
  let high = low + Math.max(0, (1000 * loss) / tuning.absorptionPerKm);
  for (let i = 0; i < 40 && high - low > 0.5; i += 1) {
    const mid = (low + high) / 2;
    if (transmissionLoss(mid, tuning) < loss) low = mid;
    else high = mid;
  }
  return high;
}

// ── Materials ───────────────────────────────────────────────────────────────────────

/**
 * What a surface does to a sound that hits it, as one number: the dB it swallows.
 *
 * Angle of incidence is deliberately absent — every bounce is treated as square-on
 * (planning/03 opens by cutting anything unreadable, and a target strength that swings with
 * aspect is unreadable in a game where the player cannot see the target). Absorption is
 * therefore the whole of the material model, and the whole of the difference between a bare
 * hull and a coated one.
 */
export interface Material {
  /** dB lost on one reflection. Larger swallows more and returns less. */
  readonly absorption: number;
}

/** Rock. One value for the whole map, by design. */
export const ROCK: Material = { absorption: ACOUSTICS.terrainAbsorption };

/**
 * A boat, as a thing sound bounces off.
 *
 * `targetStrength` is the stat that carries this — it is already "how much of a ping comes
 * back", and a second stat meaning the same thing in the opposite direction is how two
 * numbers end up disagreeing. Absorption is its complement: Anechoic Coating's −5 dB of
 * target strength is +5 dB of absorption, and a Heavy's +6 is 6 dB less.
 */
export function hullMaterial(stats: Stats, tuning: AcousticTuning = ACOUSTICS): Material {
  return { absorption: tuning.hullAbsorption - stats.targetStrength };
}

// ── Transients (planning/03 §3) ─────────────────────────────────────────────────────

export type TransientKind =
  | 'torpedo-launch'
  | 'torpedo-detonation'
  | 'emergency-blow'
  | 'hard-turn'
  | 'hull-damage'
  | 'hull-destroyed'
  | 'bottoming'
  | 'collision'
  | 'surface-breach';

export interface TransientDef {
  readonly kind: TransientKind;
  /** Peak level, dB, at the instant it happens. */
  readonly level: number;
  /** How long it takes to fade back into the ambient, seconds. */
  readonly seconds: number;
  /** What a listener with the right module would be told it was. */
  readonly label: string;
}

/**
 * What planning/03 §3's transient figures have to be shifted by to be on the scale they are
 * summed on.
 *
 * The design table reads `+30 dB` for bottom contact, `+25` for a torpedo launch, `+10` for a
 * knuckle. Those numbers are a *relative ranking*, and they were written beside the other `+`
 * terms in the emit formula — `cavitationPenalty`, `damagedPenalty` — every one of which really is
 * an increment on the hull's own level. Transients are not: they are **power-summed** as absolute
 * levels, because a bang and a hum heard together are not their decibels added.
 *
 * Read as absolute levels, the design's figures do nothing whatsoever. Hull rest levels are 41,
 * 48, and 58 dB, so power-summing a 30 dB bang onto a Heavy raises it by **one hundredth of a
 * decibel** — a "punishment for careless piloting" (§3) that the enemy cannot hear, and a torpedo
 * launch that does not announce a torpedo launch. That was invisible while nothing in the game
 * produced a transient; collision produces them, so it had to be settled.
 *
 * The fix keeps the design's ranking and moves the whole table onto the absolute scale, by the one
 * number that makes its *quietest* entry still an event: a knuckle at 70 dB is 12 dB above the
 * noisiest hull at rest, which is a doubling of detection range. Everything louder than a knuckle
 * follows from the spacing planning/03 already chose. Tune this, not the seven figures below.
 *
 * Well clear of active sonar at 108–124 dB, which stays what it is: the loudest thing in the game
 * by a wide margin, and the only one a player chooses to do.
 */
export const TRANSIENT_BASE = 60;

/**
 * Every level is `TRANSIENT_BASE` plus planning/03 §3's own figure, written that way so the
 * relationship to the design table is visible and so there is one knob rather than seven.
 */
export const TRANSIENTS: Readonly<Record<TransientKind, TransientDef>> = {
  'torpedo-launch': {
    kind: 'torpedo-launch',
    level: TRANSIENT_BASE + 25,
    seconds: 2,
    label: 'Torpedo launch',
  },
  /**
   * A warhead going off, or a weapon scuttling itself on its timeout. Not in planning/03 §3's
   * table, which predates there being anything to detonate.
   *
   * The loudest thing in the transient table by fifteen decibels, and it should be: it is the
   * only event in the game that is *itself* the consequence rather than a hint of one. Still
   * short of an active pulse at 108–124 dB, because a ping is a decision a player makes about
   * their own position and a detonation is a fact everyone already knows.
   *
   * It rings on the torpedo rather than on anything it hit, which is why a spent weapon stays in
   * the world for these four seconds (`sim/weapons`) instead of vanishing at the moment of
   * impact — the bang has to come from where the bang was.
   */
  'torpedo-detonation': {
    kind: 'torpedo-detonation',
    level: TRANSIENT_BASE + 45,
    seconds: 4,
    label: 'Detonation',
  },
  'emergency-blow': {
    kind: 'emergency-blow',
    level: TRANSIENT_BASE + 12,
    seconds: 4,
    label: 'Rapid depth change',
  },
  'hard-turn': { kind: 'hard-turn', level: TRANSIENT_BASE + 10, seconds: 4, label: 'Knuckle' },
  'hull-damage': {
    kind: 'hull-damage',
    level: TRANSIENT_BASE + 20,
    seconds: 5,
    label: 'Hull damage',
  },
  /**
   * The finishing blow — the hit that actually takes a boat to zero hit points, as distinct
   * from every `hull-damage` bang before it (planning/04 §8, revised). A hull failing outright
   * is a bigger, longer event than a boat merely taking a hit, so it is louder than
   * `hull-damage` and rings for longer, though it stays short of a warhead's own voice: a
   * detonation is still the one event in the game that *is* the consequence rather than a
   * report of one, and this stays that ranking's second-loudest entry rather than displacing it.
   *
   * Fires once, on the tick a boat's hit points reach zero, from whichever phase did it
   * (`sim/weapons/phase.ts#hurt`, `sim/collision/phase.ts#hurtBy`) — a boat is destroyed exactly
   * once, so there is exactly one of these per boat per match.
   */
  'hull-destroyed': {
    kind: 'hull-destroyed',
    level: TRANSIENT_BASE + 35,
    seconds: 8,
    label: 'Hull breach',
  },
  /**
   * Rock, in any orientation. planning/03 §3 calls it "bottom contact" because the seabed is
   * the wall a boat in open water can hit; in a cave system the ceiling and the sides of a
   * passage are the same event with the same cause — a boat driven into stone — so they are the
   * same transient rather than three that would want the same number.
   */
  bottoming: {
    kind: 'bottoming',
    level: TRANSIENT_BASE + 30,
    seconds: 6,
    label: 'Bottom contact',
  },
  /**
   * Hull against hull. Not in planning/03 §3's table, and it needs its own entry rather than
   * borrowing `hull-damage`: two boats grinding together is a *classifiable* event, and a
   * listener told "hull damage" would read it as somebody having scored a hit.
   *
   * Quieter than bottoming and louder than a knuckle. Rock does not give and a hull does, so a
   * collision at the same closing speed is the softer of the two impacts.
   */
  collision: { kind: 'collision', level: TRANSIENT_BASE + 24, seconds: 5, label: 'Collision' },
  'surface-breach': {
    kind: 'surface-breach',
    level: TRANSIENT_BASE + 22,
    seconds: 4,
    label: 'Surface breach',
  },
};

/**
 * What a transient is still worth, `elapsed` seconds after it fired.
 *
 * Linear from its peak down to zero, which on this scale *is* silence — zero dB is the quiet
 * ocean, so a transient that has decayed to ambient has stopped mattering by definition. That
 * coincidence is the reason the scale is anchored where it is.
 */
export function transientLevel(kind: TransientKind, elapsed: number): number {
  const def = TRANSIENTS[kind];
  if (elapsed >= def.seconds) return -Infinity;
  return def.level * (1 - Math.max(0, elapsed) / def.seconds);
}

// ── Active sonar (planning/03 §3) ───────────────────────────────────────────────────

/**
 * What one active pulse is still worth, `elapsed` seconds after it fired.
 *
 * **A ping is a transient, and that is the whole of the model here.** It rings down the same
 * linear way a torpedo launch does, and it reaches the rest of the game through exactly the
 * same door: `EmitState.transients`, power-summed onto the boat's source level. Nothing in the
 * solver knows what a ping is, and it does not need to — a pulse lights the cave walls because
 * *any* loud thing lights the cave walls, and it announces the boat that fired it because a
 * source level is a source level.
 *
 * That is a deliberate reading of planning/03 §6, which describes a travelling wavefront with
 * echoes arriving `2·range/c` later and rays cast across a target's angular extent. None of
 * that is here. What is here is the part that pays for itself against the picture the game
 * already draws: for the six-tenths of a second the pulse rings, the boat is enormously loud,
 * so its own reflection field fills out to the imaging cap and every listener on the map gets
 * a strong direct arrival. The wavefront, the return delay, and the traced near-side outline
 * remain unbuilt, and the ring the client draws is presentation rather than simulation.
 *
 * `level` is the boat's resolved `pingLevel` stat — hull plus whatever module it is carrying.
 */
export function activePingLevel(
  level: number,
  elapsed: number,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  if (elapsed >= tuning.pingSeconds || elapsed < 0) return -Infinity;
  return level * (1 - elapsed / tuning.pingSeconds);
}

/** Simulation ticks between pulses, at a given tick rate. At 20 Hz and 2000 ms, forty. */
export function ticksPerPing(tickHz: number, tuning: AcousticTuning = ACOUSTICS): number {
  return Math.max(1, Math.round((tickHz * tuning.pingIntervalMs) / 1000));
}

// ── The emit side ───────────────────────────────────────────────────────────────────

/**
 * The speed at which this boat's screw starts screaming, at this depth.
 *
 * Deeper is more pressure is more speed before the propeller cavitates, which is the whole
 * reason to go down. The hull's stat is quoted at `cavitationReferenceDepth`, so a boat
 * shallower than that cavitates *sooner* than its stat block suggests — the sign of that term
 * is the difference between depth being a refuge and depth being a trap.
 */
export function cavitationSpeedAt(
  stats: Stats,
  depth: number,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  const excess = (depth - tuning.cavitationReferenceDepth) / tuning.cavitationDepthScale;
  return Math.max(0, stats.cavitationSpeed * (1 + excess));
}

/** Everything the source level of one boat depends on. Depth is game depth, not `pos.y`. */
export interface EmitState {
  readonly stats: Stats;
  /** m/s along the boat's facing. */
  readonly speed: number;
  /** Game depth, metres below the surface (`map/sizes.ts#depthAt`). */
  readonly depth: number;
  /** Past `DAMAGED_HP_FRACTION` — permanently louder (planning/04 §8). */
  readonly damaged?: boolean;
  /** Levels of whatever transients are still ringing, from `transientLevel`. */
  readonly transients?: readonly number[];
}

/**
 * How loud a boat is right now, dB at the reference range.
 *
 * The continuous terms add — they are ratios stacked on the hull's rest level — and the
 * transients are then *power-summed* on top, because a bang and a hum heard together are not
 * their decibels added (`math/decibels.ts`).
 */
export function sourceLevelOf(state: EmitState, tuning: AcousticTuning = ACOUSTICS): number {
  const { stats, speed, depth } = state;
  const fraction = stats.maxSpeed > 0 ? Math.min(1, Math.max(0, speed / stats.maxSpeed)) : 0;

  let level = stats.sourceLevel + tuning.flowNoiseSpan * fraction * fraction;

  const cavitation = cavitationSpeedAt(stats, depth, tuning);
  if (speed > cavitation) {
    const headroom = Math.max(stats.maxSpeed - cavitation, 1e-6);
    const over = Math.min(1, (speed - cavitation) / headroom);
    level += tuning.cavitationPenalty + tuning.cavitationSpan * over;
  }

  if (state.damaged === true) level += tuning.damagedPenalty;
  if (depth > stats.testDepth) level += tuning.hullStressPenalty;

  if (state.transients === undefined || state.transients.length === 0) return level;

  let power = toPower(level);
  for (const transient of state.transients) power += toPower(transient);
  return toDecibels(power);
}

/**
 * How loud a wreck is right now, dB at the reference range — `sourceLevelOf`'s counterpart for
 * a hull with nobody running it.
 *
 * None of `sourceLevelOf`'s continuous terms mean anything here: there is no throttle to make
 * flow noise, nothing left to cavitate, and the depth-conditional groan `hullStressPenalty`
 * models is superseded by `wreckNoiseLevel`, which is the same phenomenon made permanent rather
 * than conditional on crush depth. What is left is `wreckNoiseLevel` itself, plus whatever of
 * the destruction bang (`hull-destroyed`) is still ringing, power-summed on top exactly the way
 * a live boat's transients are.
 */
export function wreckSourceLevel(
  ringing: readonly number[],
  tuning: AcousticTuning = ACOUSTICS,
): number {
  if (ringing.length === 0) return tuning.wreckNoiseLevel;
  let power = toPower(tuning.wreckNoiseLevel);
  for (const level of ringing) power += toPower(level);
  return toDecibels(power);
}

/**
 * A boat's own machinery as its own hydrophones hear it — the reason you slow down to listen.
 *
 * Quadratic in the speed fraction, like flow noise and for the same reason, but with a wider
 * span: going fast costs you more hearing than it costs you stealth, so "all stop and listen"
 * beats "creep and listen" by more than the source levels alone suggest.
 */
export function selfNoiseOf(
  stats: Stats,
  speed: number,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  const fraction = stats.maxSpeed > 0 ? Math.min(1, Math.max(0, speed / stats.maxSpeed)) : 0;
  return tuning.selfNoiseAtRest + tuning.selfNoiseSpan * fraction * fraction;
}

// ── The receive side ────────────────────────────────────────────────────────────────

/**
 * What a listener is competing against: the ocean, its own machinery, and everything else
 * making noise where it happens to be sitting.
 *
 * `background` is the level of *other* things at the listener's position, read off the noise
 * heatmap. A boat's own contribution is excluded there and supplied as `selfNoise` instead,
 * because its own noise at its own position is a division by zero and its self-noise figure
 * is the answer that division was standing in for.
 *
 * That background term is weighted by `backgroundNoiseFraction` before it is summed — the one
 * place in the model that happens, so every caller gets it without knowing about it. The ocean
 * and the boat's own machinery are summed at full weight.
 */
export function noiseFloorOf(
  background: number,
  selfNoise: number,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  const heard = toDecibels(toPower(background) * tuning.backgroundNoiseFraction);
  return addDecibels(addDecibels(heard, selfNoise), tuning.ambientNoise);
}

/**
 * The level a return has to reach to be seen at all — the whole of the detection rule,
 * rearranged so the solver can compare against it once per listener instead of once per cell.
 *
 * `SE = echo + arrayGain − noiseFloor ≥ DT` is the same statement as
 * `echo ≥ noiseFloor + DT − arrayGain`, and the right-hand side does not change as the solver
 * walks the map.
 */
export function returnThreshold(
  noiseFloor: number,
  arrayGain: number,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  return noiseFloor + tuning.detectionThreshold - arrayGain;
}
