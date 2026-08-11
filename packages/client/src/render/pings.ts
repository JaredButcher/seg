/**
 * @seg/client/render/pings — the expanding ring a boat draws when it pulses, its own or an
 * enemy's, plus the alarm a hostile launch draws.
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
 * The **hostile** ring (`HostilePings`) is drawn from an event rather than from a state change,
 * because a pulse someone else fired is not on the wire as a state at all — what the server sends
 * is that one of your boats was lit, and by what (`match/vision.ts#HeardPing`). It is the same
 * animation in the hostile colour, and it is presentation in exactly the same way: the information
 * arrived with the frame, and the ring is how the player is told about it.
 *
 * If the wavefront is ever simulated (§6's `r(t) = c · (t − t_ping)` with echoes arriving at
 * `t_ping + 2·range/c`), this file becomes a *reading* of that rather than an animation beside
 * it, and the constants below become derived rather than chosen. Until then they are chosen.
 *
 * Pure with respect to time — every method takes `now` — so the whole thing is testable without
 * a canvas, a clock, or a frame loop, which is the same bargain `picture.ts` makes.
 */

import type { EntityId, HeardLaunch, HeardPing, Vec2 } from '@seg/shared';

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
 * How far the drawn ring gets before it is gone, metres.
 *
 * The ring is a beat, not a reach: it says *that boat just pulsed*, and a circle that keeps
 * growing past the part of the map the player is reading turns into scenery. A kilometre is
 * about a viewport across, so the ring leaves the screen the player is looking at and stops.
 */
export const PING_MAX_RADIUS_M = 1_000;

/**
 * How long one ring stays on screen, milliseconds.
 *
 * Derived rather than chosen: the ring travels at the speed of sound, so its life is however
 * long that takes to cross `PING_MAX_RADIUS_M`. Well inside one pulse interval, so a boat
 * pinging steadily shows one ring at a time and a dark gap between them.
 */
export const PING_RING_MS = Math.round((PING_MAX_RADIUS_M / PING_SPEED_M_PER_S) * 1000);

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

/**
 * One pulse ring at `age` milliseconds: how far the wavefront has got, and how faint it has gone.
 *
 * The whole of the animation, in one place, because more than one thing draws it — a friendly
 * pulse, a seeker's, and the hostile pulse that just lit one of your boats (`HostilePings`). Those
 * differ in colour and in nothing else, which is the point: a ring is *a pulse went out here*, and
 * a player should not have to learn a second shape to read the one that was aimed at them.
 */
function pulseRingAt(x: number, y: number, age: number): PingRing {
  const life = age / PING_RING_MS;
  return {
    x,
    y,
    // Clamped, so the rounding in `PING_RING_MS` can never put the last frame's ring past the
    // radius this file promises.
    radius: Math.min(PING_MAX_RADIUS_M, (PING_SPEED_M_PER_S * age) / 1000),
    alpha: PING_RING_ALPHA * (1 - life),
  };
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

      out.push(pulseRingAt(ring.x, ring.y, age));
    }

    this.live.length = kept;
    return out;
  }

  /** Whether anything is being drawn. Lets the renderer skip a clear on a quiet frame. */
  get active(): boolean {
    return this.live.length > 0;
  }
}

// ── Hostile events ──────────────────────────────────────────────────────────────────

/** A cap for the same reason `MAX_RINGS` has one: the list is fed from the wire. */
const MAX_ALERTS = 16;

interface LiveAlert {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly bornAt: number;
}

/** An alert's identity: which event it was, not which frame reported it. */
function keyOf(event: { readonly at: Vec2; readonly tick: number }): string {
  return `${String(event.tick)}:${String(event.at.x)}:${String(event.at.y)}`;
}

/**
 * The "which of these have I already flashed" half of an alert tracker.
 *
 * The same "remember it, and treat what is new as the event" trick `PingRings` plays on
 * `lastPingTick` and `TransientCues` plays on a boat's bangs — and for the same reason. A vision
 * frame repeats a heard event for a few seconds so an unreliable channel cannot delete it
 * (`match/vision.ts#HeardLaunch`, `#HeardPing`), which means something has to decide which of those
 * repetitions is the event. The key is `(tick, position)`, so two boats acting on the same tick are
 * two alarms and one boat's event reported thirty times is one.
 *
 * Unlike the ping tracker, **a first sight is not silent**. A reconnecting player being told about
 * a launch that happened three seconds ago is being told something still true — the weapon is out
 * there — where a pulse *their own boat* fired while they were away is over. What is still true
 * about a hostile pulse is the same: somebody found you, just now, from over there.
 *
 * Shared by the two hostile trackers because only the ring differs between them; the bookkeeping
 * is identical and getting it subtly different in two places is how one of them starts stuttering.
 */
abstract class HostileAlerts<T extends { readonly at: Vec2; readonly tick: number }> {
  private readonly seen = new Set<string>();
  protected live: LiveAlert[] = [];

  /** Fold in this frame's alerts, and return where each new one happened, for the audio. */
  observe(events: readonly T[], now: number): readonly Vec2[] {
    const born: Vec2[] = [];

    for (const event of events) {
      const key = keyOf(event);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      born.push(event.at);
      this.live.push({ key, x: event.at.x, y: event.at.y, bornAt: now });
    }

    if (this.live.length > MAX_ALERTS) this.live = this.live.slice(-MAX_ALERTS);
    // The dedupe set is trimmed against the frame rather than against the live list: an alert
    // that has finished animating is still being repeated on the wire for another second or so,
    // and forgetting its key would make it fire again.
    if (this.seen.size > MAX_ALERTS * 4) {
      const keep = new Set(events.map(keyOf));
      for (const key of this.seen) {
        if (!keep.has(key)) this.seen.delete(key);
      }
    }

    return born;
  }

  /** Every ring still visible. Expires as it goes, so nothing else has to. */
  abstract rings(now: number): readonly PingRing[];

  get active(): boolean {
    return this.live.length > 0;
  }
}

// ── Hostile launches ────────────────────────────────────────────────────────────────

/**
 * How long a launch alert stays on screen, milliseconds.
 *
 * Far longer than a ping ring, and slower, because the two say opposite things. A pulse ring is
 * a *beat* — it marks a rhythm the player is already tracking and gets out of the way. A launch
 * alert is an **alarm**: somebody has fired at you, the weapon is in the water for the next
 * minute or more, and the player has to notice it even if they were looking at another part of
 * the map. Three expanding rings over two and a half seconds is hard to miss and still over
 * before the weapon could reach anything.
 */
export const LAUNCH_RING_MS = 2_500;

/** How far one grows, metres. Wider than a ping ring so it reads at a glance when zoomed out. */
export const LAUNCH_RING_RADIUS_M = 600;

/** The alert at its brightest. Much stronger than a ping ring — see `LAUNCH_RING_MS`. */
export const LAUNCH_RING_ALPHA = 0.85;

/** Rings per alert. Three, so it pulses rather than sweeping once and being gone. */
export const LAUNCH_RING_COUNT = 3;

/** The alarm a hostile tube firing draws on the scope and the mini-map. */
export class LaunchAlerts extends HostileAlerts<HeardLaunch> {
  /**
   * Every ring still visible, as `LAUNCH_RING_COUNT` staggered circles per alert.
   *
   * The stagger is the whole look: each ring is offset by a third of the life, so the three
   * chase each other outward and the alert reads as a repeating pulse rather than as one
   * expanding circle. Expires as it goes, so nothing else has to.
   */
  rings(now: number): readonly PingRing[] {
    const out: PingRing[] = [];
    let kept = 0;

    for (const alert of this.live) {
      const age = now - alert.bornAt;
      if (age >= LAUNCH_RING_MS || age < 0) continue;
      this.live[kept] = alert;
      kept += 1;

      for (let i = 0; i < LAUNCH_RING_COUNT; i += 1) {
        // Each ring's own life, running from when it was born to the end of the alert. A ring
        // that has not started yet has a negative life and is skipped.
        const life = age / LAUNCH_RING_MS - i / LAUNCH_RING_COUNT;
        if (life <= 0 || life >= 1) continue;
        out.push({
          x: alert.x,
          y: alert.y,
          radius: LAUNCH_RING_RADIUS_M * life,
          alpha: LAUNCH_RING_ALPHA * (1 - life),
        });
      }
    }

    this.live.length = kept;
    return out;
  }
}

// ── Hostile pulses ──────────────────────────────────────────────────────────────────

/**
 * The ring drawn where a hostile pulse that just lit one of your boats came from
 * (`match/vision.ts#HeardPing`).
 *
 * **The same animation a friendly pulse gets, in the hostile colour**, and both halves of that
 * are deliberate. The animation, because it is the same physical event — a transducer fired over
 * there, and this is the wavefront leaving it — and giving it a second shape would make the player
 * learn twice what they already know how to read. The colour, because *whose* pulse it was is the
 * only thing that changes what they do about it: your own ring says you have just told the ocean
 * where you are, and a red one says somebody else has, and has probably found you.
 *
 * It is not the launch alarm's three staggered rings on purpose. A launch means a weapon is in the
 * water for the next minute; a pulse is over the instant it lands, and the player's answer to it —
 * turn away, slow down, break the line of sight — is one they make now or not at all. A single
 * ring at the speed of sound says *now* in a way a two-and-a-half-second alarm does not.
 */
export class HostilePings extends HostileAlerts<HeardPing> {
  rings(now: number): readonly PingRing[] {
    const out: PingRing[] = [];
    let kept = 0;

    for (const alert of this.live) {
      const age = now - alert.bornAt;
      if (age >= PING_RING_MS || age < 0) continue;
      // Compacted in place rather than filtered into a new array, the same as `PingRings`.
      this.live[kept] = alert;
      kept += 1;

      out.push(pulseRingAt(alert.x, alert.y, age));
    }

    this.live.length = kept;
    return out;
  }
}
