/**
 * @seg/client/audio/cues — which of the noises on the wire have not been heard yet.
 *
 * A view frame carries the transients still *ringing* on each friendly boat, not the ones that
 * fired since the last frame (`match/view.ts`). That is the right thing to send — a frame has to be
 * interpretable alone (planning/02 §3.3), and "what is currently making noise" is a state where
 * "what just happened" would be a diff that a dropped frame loses forever — but it means the same
 * bang appears in sixty consecutive frames, and something has to decide which appearance is the
 * event.
 *
 * That is this, and it is the same trick `render/pings.ts` plays on `lastPingTick`: remember the
 * tick, and treat a *change* as the event. A transient is identified by its `(boat, kind, tick)`, so
 * a boat that hits two walls a second apart is heard twice and a boat whose single impact is
 * reported forty times is heard once.
 *
 * **A boat seen for the first time is silent.** Its transients are whatever happened to be ringing
 * when this client started looking, which for a reconnecting player is a collision that happened
 * while they were away. Recording them without playing them is what makes the first frame after a
 * reconnect quiet instead of a barrage — the same rule, for the same reason, as the ping rings.
 */

import type { BoatTransient, EntityId, HullId, TransientKind, Vec2 } from '@seg/shared';

/** One friendly boat, as the cue tracker needs to read it. */
export interface TransientSource {
  readonly id: EntityId;
  readonly pos: Vec2;
  readonly hull: HullId;
  readonly transients: readonly BoatTransient[];
}

/** A noise event that has not been played yet, and where it happened. */
export interface TransientCue {
  readonly kind: TransientKind;
  /** The boat's position in the frame that reported it — near enough to where the bang was. */
  readonly at: Vec2;
  /** Whose hull made it, so the cue can be scaled by the size of the boat. */
  readonly hull: HullId;
}

export class TransientCues {
  /** Per boat, the tick of the latest transient of each kind this client has already played. */
  private readonly seen = new Map<EntityId, Map<TransientKind, number>>();

  /**
   * Fold in this frame's fleet and return what is new, in the order the boats were given.
   *
   * Called on the frame that reports the transient rather than per display frame: a view frame is
   * the only moment the list can have changed.
   */
  observe(boats: readonly TransientSource[]): readonly TransientCue[] {
    const cues: TransientCue[] = [];
    const present = new Set<EntityId>();

    for (const boat of boats) {
      present.add(boat.id);
      const known = this.seen.get(boat.id);
      const fresh = known === undefined;
      const ticks = known ?? new Map<TransientKind, number>();
      if (fresh) this.seen.set(boat.id, ticks);

      for (const transient of boat.transients) {
        const last = ticks.get(transient.kind);
        if (last !== undefined && transient.tick <= last) continue;
        ticks.set(transient.kind, transient.tick);
        // A boat's first frame records without playing — see the header.
        if (fresh) continue;
        cues.push({ kind: transient.kind, at: boat.pos, hull: boat.hull });
      }
    }

    // A boat that has left the frames has left the match. Dropping its record stops a long
    // session accumulating one per boat of every match the tab has seen.
    for (const id of this.seen.keys()) {
      if (!present.has(id)) this.seen.delete(id);
    }

    return cues;
  }
}
