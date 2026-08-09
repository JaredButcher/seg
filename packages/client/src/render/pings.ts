/**
 * @seg/client/render/pings — the expanding ring a friendly boat draws when it pulses.
 *
 * **This is presentation, and it is important to be clear that it is only presentation.** The
 * simulation has no wavefront: an active pulse reaches the acoustic model as a very loud
 * transient lasting a few tenths of a second (`content/acoustics.ts#activePingLevel`), and
 * everything the player learns from it arrives the ordinary way, as vision squares in the next
 * few frames. The ring drawn here does not carry information, does not gate anything, and is
 * not the thing the returns come back from. What it does is answer a question the player would
 * otherwise have to keep in their head — *is that boat pinging, and did it just go?* — and give
 * the mechanic a beat, which planning/03 §6 asks for in as many words: "the wait is the drama".
 *
 * If the wavefront is ever simulated (§6's `r(t) = c · (t − t_ping)` with echoes arriving at
 * `t_ping + 2·range/c`), this file becomes a *reading* of that rather than an animation beside
 * it, and the constants below become derived rather than chosen. Until then they are chosen.
 *
 * Pure with respect to time — every method takes `now` — so the whole thing is testable without
 * a canvas, a clock, or a frame loop, which is the same bargain `picture.ts` makes.
 */

import type { EntityId, Vec2 } from '@seg/shared';

/**
 * How fast the drawn ring expands, metres per second.
 *
 * The speed of sound in water, from planning/03 §6, and it is the one constant here that is not
 * arbitrary. It is what makes the ring cross a chamber in the time a player's ear expects it to
 * — and, incidentally, what makes it leave a 900 m viewport in well under a second, which is
 * why the thing reads as a pulse rather than as a growing circle.
 */
export const PING_SPEED_M_PER_S = 1500;

/**
 * How long one ring stays on screen, milliseconds.
 *
 * Under two pulse intervals, so a boat pinging steadily shows at most two rings at once. Three
 * would be a boat inside a target, which is a different picture from a boat that just pinged.
 */
export const PING_RING_MS = 1_800;

/** The ring at its brightest, at the instant it is born. Faint on purpose. */
export const PING_RING_ALPHA = 0.32;

/**
 * The most rings drawn at once, across the whole fleet.
 *
 * Ten boats pinging together is twenty rings, so this is slack rather than a real limit. It
 * exists because the list is fed from the wire and an unbounded animation list driven by
 * anything a server says is a leak waiting for a bug upstream.
 */
const MAX_RINGS = 64;

/** One friendly boat, as the ring tracker needs to read it. */
export interface PingSource {
  readonly id: EntityId;
  readonly pos: Vec2;
  readonly lastPingTick: number;
  readonly destroyed: boolean;
}

/** A ring as the renderer wants it: where, how big, how bright. */
export interface PingRing {
  readonly x: number;
  readonly y: number;
  /** Metres. */
  readonly radius: number;
  /** 0..`PING_RING_ALPHA`, falling linearly to nothing. */
  readonly alpha: number;
}

interface LiveRing {
  readonly x: number;
  readonly y: number;
  readonly bornAt: number;
}

export class PingRings {
  /** The `lastPingTick` each boat was last seen at. A *change* is a pulse. */
  private readonly seen = new Map<EntityId, number>();
  private live: LiveRing[] = [];

  /**
   * Fold in this frame's fleet, and return where each new pulse happened.
   *
   * The return value is what drives the audio — the caller knows where the camera is and this
   * does not, so the pan and the level are decided one level up (`ScopeHost`).
   *
   * **A boat seen for the first time never births a ring.** Its `lastPingTick` is whatever it
   * was when this client happened to start looking, which for a reconnecting player is a pulse
   * that went out while they were away. Recording it silently is what makes the first frame
   * after a reconnect quiet instead of a barrage.
   */
  observe(boats: readonly PingSource[], now: number): readonly Vec2[] {
    const born: Vec2[] = [];

    for (const boat of boats) {
      const previous = this.seen.get(boat.id);
      this.seen.set(boat.id, boat.lastPingTick);
      if (previous === undefined || boat.lastPingTick === previous) continue;
      // A tick that went *backwards* is a new match reusing an id, not a pulse.
      if (boat.lastPingTick < previous || boat.destroyed) continue;

      born.push(boat.pos);
      this.live.push({ x: boat.pos.x, y: boat.pos.y, bornAt: now });
    }

    if (this.live.length > MAX_RINGS) this.live = this.live.slice(-MAX_RINGS);
    return born;
  }

  /** Every ring still visible, oldest first. Expires as it goes, so nothing else has to. */
  rings(now: number): readonly PingRing[] {
    const out: PingRing[] = [];
    let kept = 0;

    for (const ring of this.live) {
      const age = now - ring.bornAt;
      if (age >= PING_RING_MS || age < 0) continue;
      // Compacted in place rather than filtered into a new array: this runs every frame.
      this.live[kept] = ring;
      kept += 1;

      const life = age / PING_RING_MS;
      out.push({
        x: ring.x,
        y: ring.y,
        radius: (PING_SPEED_M_PER_S * age) / 1000,
        alpha: PING_RING_ALPHA * (1 - life),
      });
    }

    this.live.length = kept;
    return out;
  }

  /** Whether anything is being drawn. Lets the renderer skip a clear on a quiet frame. */
  get active(): boolean {
    return this.live.length > 0;
  }
}
