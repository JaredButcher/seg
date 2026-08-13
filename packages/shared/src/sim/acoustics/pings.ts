/**
 * Being pinged — the receiving end of active sonar.
 *
 * `boats.ts` and `torpedoes.ts` say how loud a pulse is; `solve.ts` puts that loudness in the
 * water and lets it light whatever it lights. This file answers the one question neither of them
 * can: **whose** pulse just washed over my hull, and was it strong enough that my crew can say
 * where it came from.
 *
 * ## Why the arithmetic is here and not in the solver
 *
 * The same reason `sim/weapons/decoy.ts` gives, and it is the decisive one. The solve accumulates
 * *power at a point* — by the time a pulse reaches a listener's cell it has been summed with the
 * ocean, the machinery, and everyone else's noise, and there is no longer anything in the
 * structure that could name the boat it came from. An alert that names an origin needs a path
 * from one named pinger to one named listener, which is what this is: `transmissionLoss`,
 * `noiseFloorOf`, `returnThreshold` and `clearWater`, the same functions the ocean uses, so a
 * tuning pass on `content/acoustics.ts` moves the alert range with everything else.
 *
 * ## One way, not two
 *
 * A seeker's echo (`sim/weapons/seeker.ts`) and a pulse that strips a decoy both pay the path
 * *twice* — out to the hull and back to the transducer. This pays it **once**. Nothing is being
 * reflected: the pulse is heard directly, the way any loud noise is heard directly, which is why
 * being pinged is noticed from very much further away than pinging finds anything. That asymmetry
 * is the whole cost of the switch (planning/03 §3), and here it falls out of the arithmetic rather
 * than being asserted.
 *
 * ## "Received and filtered"
 *
 * A ping is a coherent tone, so a listener notches it *out of its own noise estimate* and hears it
 * through — that is what `filterableNoiseFraction` buys on the solve's side. The consequence here
 * is that the level the pulse has to beat is the listener's floor **without** the pulse in it,
 * which is exactly what `noiseFloorOf(-Infinity, selfNoise)` computes: the ocean and its own
 * machinery, and nothing else.
 *
 * That the floor is the listener's own rather than the heatmap's is the simplification
 * `decoy.ts` and `seeker.ts` both make, and it errs the same way for the same reason. The range at
 * which a pulse gives its owner away is a number a player can learn, rather than one that breathes
 * with whatever traffic happens to be in the next chamber — and the memorable injustice is the
 * other one, where the ping that lit you up last time silently does not this time.
 */

import {
  ACOUSTICS,
  noiseFloorOf,
  returnThreshold,
  selfNoiseOf,
  transmissionLoss,
  type AcousticTuning,
} from '../../content/acoustics.js';
import { getWeapon } from '../../content/weapons.js';
import type { Vec2 } from '../../map/types.js';
import type { TorpedoState } from '../../match/torpedo.js';
import type { BoatState } from '../../match/world.js';
import type { TerrainCollider } from '../collision/terrain.js';
import { clearWater } from '../weapons/seeker.js';
import type { Hydrophone } from './solve.js';

/**
 * One active pulse in the water, as the listening side needs it.
 *
 * `level` is the pulse's **peak**, not what is left of it as it rings down (`activePingLevel`).
 * The caller owns "did this thing actually pulse, and how recently" — a fact about the tick that
 * the runtime already holds in `lastPingTick`, and asking it twice is how an alert comes to fire
 * for a pulse that never went out. What is owned here is the *level*, out to the listener.
 */
export interface ActivePulse {
  /** Where the pulse came from. What the alert draws its ring at. */
  readonly at: Vec2;
  /** Peak source level of the pulse, dB at the reference range. */
  readonly level: number;
  /** The tick it fired on. The alert's identity, and no part of the arithmetic. */
  readonly tick: number;
}

/** Something of yours with ears, as being-pinged needs to read it. */
export interface PulseListener {
  readonly pos: Vec2;
  readonly hydrophone: Hydrophone;
}

/**
 * A boat's pulse, if it fired one on or after `since`, else `null`.
 *
 * `at` is where the boat is **now** rather than where it was when the transducer fired, which for
 * a solve's worth of ticks is a few metres at any speed a submarine travels. The launch alert
 * makes exactly the same approximation (`server/match/runtime.ts#hearLaunches`), and the fix for
 * either would be to stamp a position onto the event when it happens.
 */
export function boatPulse(boat: BoatState, since: number): ActivePulse | null {
  if (boat.status === 'destroyed' || !boat.activeSonar) return null;
  // Zero is *never pulsed* rather than "pulsed at tick zero" — the distinction `pingLevelOf`
  // draws, and for the same reason: a fixture whose switch starts on must not alert anybody.
  if (boat.lastPingTick <= 0 || boat.lastPingTick < since) return null;
  return { at: boat.pos, level: boat.stats.pingLevel, tick: boat.lastPingTick };
}

/**
 * A weapon's seeker pulse, if it fired one on or after `since`, else `null`.
 *
 * Only an `enabled` weapon pings, which is the same gate `seekerPulseLevel` applies — a torpedo
 * still running out to its enable point is silent, and a spent one has nothing left to ping with.
 * A drone's is the strongest of the two that ping (100 dB against the active torpedo's 95) and
 * still under every hull in the table, which does not save it: a pulse is heard one-way and
 * returns two-way, so it is reported from several times further than it images.
 */
export function seekerPulse(torpedo: TorpedoState, since: number): ActivePulse | null {
  const level = getWeapon(torpedo.weapon).seekerPingLevel;
  if (level <= 0 || torpedo.phase !== 'enabled') return null;
  if (torpedo.lastPingTick <= 0 || torpedo.lastPingTick < since) return null;
  return { at: torpedo.pos, level, tick: torpedo.lastPingTick };
}

/** A live boat as a listener, or `null` for a wreck — a hull with nobody left to hear anything. */
export function boatListener(boat: BoatState, tuning?: AcousticTuning): PulseListener | null {
  if (boat.status === 'destroyed') return null;
  return {
    pos: boat.pos,
    hydrophone: {
      gain: boat.stats.arrayGain,
      selfNoise: selfNoiseOf(boat.stats, boat.speed, tuning),
    },
  };
}

/**
 * A weapon as a listener — the drone, and nothing else.
 *
 * Its ears come off the weapon table flat, with no speed term, for the reason
 * `torpedoes.ts#torpedoEntity` gives: a drone is never not under way, so a curve in its speed
 * would be a curve evaluated at one point forever. Every other load has `hydrophone: null` and
 * hears nothing, which is `sim/weapons/seeker.ts`'s argument being kept rather than an oversight.
 */
export function torpedoListener(torpedo: TorpedoState): PulseListener | null {
  const ears = getWeapon(torpedo.weapon).hydrophone;
  if (ears === null || torpedo.phase === 'spent') return null;
  return { pos: torpedo.pos, hydrophone: ears };
}

/** The level a pulse has to reach at this listener before it is heard at all, dB. */
export function pulseThreshold(hydrophone: Hydrophone, tuning: AcousticTuning = ACOUSTICS): number {
  return returnThreshold(
    noiseFloorOf(-Infinity, hydrophone.selfNoise, tuning),
    hydrophone.gain,
    tuning,
  );
}

/**
 * How far this pulse clears that listener's threshold, dB. Negative means it was never heard.
 *
 * One-way transmission loss over the straight line between them — see the file header on why the
 * path is not paid twice, and `sim/weapons/seeker.ts` on what a straight line gives up against the
 * solver's geodesics.
 */
export function pulseExcessAt(
  pulse: ActivePulse,
  listener: PulseListener,
  tuning: AcousticTuning = ACOUSTICS,
): number {
  const range = Math.hypot(pulse.at.x - listener.pos.x, pulse.at.y - listener.pos.y);
  return (
    pulse.level - transmissionLoss(range, tuning) - pulseThreshold(listener.hydrophone, tuning)
  );
}

/**
 * Whether this pulse washed over that listener hard enough for the crew to call its origin.
 *
 * The bar is `confirmationThreshold` rather than bare detection, and reusing that number is the
 * point rather than a shortcut. An alert that draws a ring at a *position* is the server saying
 * where something is, which is the same claim confirming a square makes — so it is held to the
 * same bar, and the band between hearing a pulse and being able to place it is the same band the
 * rest of the picture already has (`match/vision.ts`). A pulse under it still reaches the team the
 * ordinary way: it lights the water, and the pinger is loud in the picture like anything else.
 *
 * Line of sight last, and only for a pulse that would otherwise be reported: a ping cannot be
 * traced round a corner any more than a seeker can hear round one.
 */
export function pulseHeardBy(
  pulse: ActivePulse,
  listener: PulseListener,
  terrain: TerrainCollider | null,
  tuning: AcousticTuning = ACOUSTICS,
): boolean {
  if (pulseExcessAt(pulse, listener, tuning) < tuning.confirmationThreshold) return false;
  return terrain === null || clearWater(terrain, pulse.at, listener.pos);
}
