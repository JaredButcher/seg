/**
 * @seg/shared/match/vision — the picture a team has built, and the map it has not been given.
 *
 * A playing client starts a match knowing the size of the ocean, where its own boats are, and
 * where the objectives are. It is never told where the rock is. Everything else on its screen
 * it earned, one square at a time, by listening (ADR 0002, planning/03 §5.3).
 *
 * ## Three products, and why they are different shapes
 *
 * **The chart.** Rock squares whose return cleared the confirmation threshold. A square that
 * confirms is confirmed *for the rest of the match* — rock does not move, so there is nothing
 * for a second look to correct. The chart is therefore append-only, and the wire carries the
 * appendix rather than the book: each square is sent once, ever.
 *
 * **The transient picture.** Every square lit this solve that is not already on the chart —
 * the frontier of discovery, plus whatever squares are sitting on somebody's hull. It is
 * re-sent every frame because it is *about* this frame, and it carries a signal excess so the
 * client can draw a strong return differently from a faint one. This is the sonar-green shimmer
 * the player reads ahead of the server's verdict.
 *
 * **Contacts.** Hostile hulls whose squares confirmed. Unlike rock, a boat moves, so a contact
 * is a belief with an age: live while it is still being confirmed, and a hollow last-known
 * outline once it slips detection.
 *
 * ## The thresholds are the game
 *
 * `detectionThreshold` decides whether a square appears at all. `confirmationThreshold` decides
 * whether the server is willing to *commit* to it. Between them sits a band where the player
 * can see something the game has not agreed to yet, and acting on that band before it resolves
 * is the skill this whole file exists to make possible (planning/03 §5.3).
 *
 * A third, `identificationThreshold`, sits above both and answers a different question: not
 * *where* but *what*. It applies to weapons alone, because a boat's class is already given away
 * by the silhouette confirmation reveals, and a torpedo has no silhouette worth the name — every
 * load in the table is the same three squares. So the extra band is where "a torpedo" becomes
 * "a super-cavitating torpedo", which is the difference between knowing you have to move and
 * knowing how long you have to do it in.
 *
 * The client is never told which faint square is rock and which is a hull; it draws them all the
 * same green. What resolves the ambiguity is what arrives *alongside* the green — a chart
 * append under it, or a contact over it — so a square appears to fade into a wall, into a
 * submarine, or into nothing, without the picture ever having carried a label. That is
 * planning/03 §6's "read the shape" surviving contact with a fog of war.
 *
 * ## Confirmation is server-side, and independent of the wire
 *
 * The confirmation passes below run over **every** square the solve produced, while the
 * transmitted set is capped (`maxWireVisionCells`). A team's chart therefore does not depend on
 * how much of its picture fitted in a packet, which it absolutely would if the client were
 * deciding. It is also the anti-cheat position: a client that never receives a square cannot be
 * made to forget one it was not sent.
 */

import { ACOUSTICS, type AcousticTuning } from '../content/acoustics.js';
import type { HullId } from '../content/hulls.js';
import type { WeaponId } from '../content/weapons.js';
import type { MapSize, MapType } from '../lobby/settings.js';
import type { GeneratedMap, MapExtents, Terrain, Vec2 } from '../map/types.js';
import type { Ghost } from '../sim/acoustics/ghosts.js';
import { visionGridFor, type VisionGrid } from '../sim/acoustics/skin.js';
import type { TeamVision } from '../sim/acoustics/solve.js';
import type { EntityId } from './world.js';

// ── The map, as a player is allowed to have it ──────────────────────────────────────

/**
 * What a client is told about the world's shape before it has heard anything.
 *
 * **`seed` is deliberately absent**, and that absence is the whole point of the type. Map
 * generation is pure and lives in `@seg/shared`, which the client bundles — so a seed plus a
 * `generatorVersion` *is* the terrain, reproducible in a devtools console in one line. Shipping
 * a redacted `terrain` beside a seed would have been fog of war as a suggestion.
 *
 * `terrain` is non-null only for a recipient entitled to ground truth: today a spectator, and
 * eventually whichever spectators the host's vision policy allows (planning/07 §5).
 */
export interface MapChart {
  /** Which generation logic produced it. Harmless without the seed, and useful in a bug report. */
  readonly generatorVersion: number;
  readonly mapType: MapType;
  readonly mapSize: MapSize;
  /** The arena's physical bounds. Known from the start — the ocean's size is not a secret. */
  readonly extents: MapExtents;
  /** How much game depth one Y metre is worth (`map/sizes.ts`). */
  readonly depthScale: number;
  /** Ground truth rock, or `null` for anyone who has to find it themselves. */
  readonly terrain: Terrain | null;
}

/** The chart one recipient gets. `revealTerrain` is the vision policy, decided by the caller. */
export function chartOf(map: GeneratedMap, revealTerrain: boolean): MapChart {
  return {
    generatorVersion: map.generatorVersion,
    mapType: map.mapType,
    mapSize: map.mapSize,
    extents: map.extents,
    depthScale: map.depthScale,
    terrain: revealTerrain ? map.terrain : null,
  };
}

/** The grid a chart's square ids are numbered on. Derivable from extents alone, so the
 * client can unpack a frame without being told anything extra. */
export function chartGridFor(extents: MapExtents): VisionGrid {
  return visionGridFor(extents);
}

// ── The wire ────────────────────────────────────────────────────────────────────────

/**
 * A team's handle on one hostile boat.
 *
 * **Minted by the contact book, never the entity id.** planning/03 §7 is explicit that a
 * tracker must not see entity identity, because a tracker that cannot be wrong is not a
 * tracker. Today the association is trivial — the solve knows exactly which hull a square sits
 * on — but the *number the player sees* is still the book's own, so a contact that expires and
 * is re-acquired comes back as a different one. That is track splitting, and it is free here
 * and expensive to retrofit.
 */
export type ContactId = number;

/**
 * What kind of thing a contact turned out to be.
 *
 * Two, and the split is *not* a classification skill being handed to the player for free — it
 * falls out of confirmation. A confirmed contact reveals the object whole (ADR 0002), and a
 * seven-metre thing doing 55 m/s is not a submarine by any reading of the squares. What the
 * player still has to work out is everything that matters: where it is going, whether it is
 * theirs, and whether they are inside its turn.
 *
 * The faint band below confirmation carries no kind at all, like everything else in it — an
 * incoming weapon and a cave wall are the same green until the server commits.
 */
export type ContactKind = 'boat' | 'torpedo';

/** One hostile object, as far as a team can prove it. */
export interface RevealedContact {
  readonly id: ContactId;
  readonly kind: ContactKind;
  /**
   * The hull class, or `null` for a torpedo. Sent because confirmation reveals the whole boat
   * (ADR 0002) and the silhouette *is* the hull — planning/03 §6's recognition skill needs a
   * shape to recognize. Classification being fallible is a tracker problem and arrives with the
   * tracker.
   */
  readonly hull: HullId | null;
  /**
   * Which load it is, or `null` for a contact that has not been classified — which is every
   * boat, and every weapon heard below `identificationThreshold`.
   *
   * The one field on this shape that a *second* threshold gates, and the reason it is separate
   * from `kind` rather than folded into it. `kind` falls out of confirmation and costs nothing
   * extra (`ContactKind` says why); this is bought, at a signal excess a team only reaches by
   * being closer or quieter than the weapon's owner would like. Below it a player knows a weapon
   * is in the water and no more, which is the state the generic dart draws.
   *
   * **Never set for a decoy still passing as a boat.** `server/match/runtime.ts#sightingFor`
   * reports an unpinged decoy as the submarine it is imitating, and a `weapon` field arriving
   * beside that would hand the player the answer the pulse is supposed to cost them.
   */
  readonly weapon: WeaponId | null;
  /** Where it was when it was last confirmed. Never extrapolated (planning/02 §5). */
  readonly pos: Vec2;
  readonly facing: number;
  /** The tick that pose was measured at. What the client's fade is anchored to. */
  readonly seenTick: number;
  /** Confirmed recently enough to still be a reading. False means it slipped — draw it hollow. */
  readonly live: boolean;
}

/**
 * A hostile tube firing, heard.
 *
 * The one *event* in the vision frame, and it needs to be one: everything else here is a state
 * the next frame will restate, but a launch happens once and the player has to be told at the
 * moment it does. It is what the scope and the mini-map flash for.
 *
 * **It is not free information.** A team is told about it only when it was already hearing the
 * boat that fired — the launch transient is 85 dB and lights the firer's own hull squares, so
 * "did we hear the shot" is answered by the ordinary detection machinery rather than by a rule
 * of its own (`server/match/runtime.ts`). A boat that fires from outside detection range fires
 * unannounced, which is the whole point of firing from out there.
 *
 * `at` is the firing boat's position, which the team has by then measured anyway. What the alert
 * adds is not *where he is* but *that a weapon is now in the water* — and the player still has
 * to find it themselves.
 */
export interface HeardLaunch {
  readonly at: Vec2;
  /**
   * The tick the tube fired on — not the tick it was heard on.
   *
   * The client's key for "have I already flashed this one", and it has to be the *event's* own
   * number rather than the observation's: the frame repeats an alert across several solves, and
   * a key that changed with the solve would flash the same shot three times.
   */
  readonly tick: number;
}

/**
 * Seconds a heard launch keeps being reported.
 *
 * It is repeated across several frames on purpose. The `view` channel is unreliable once WebRTC
 * lands (planning/02 §3.3), and an alert carried by exactly one frame is an alert a dropped
 * packet deletes — for the one event in the game where missing it costs a boat. Repeating it and
 * letting the client dedupe on `tick` is the same trick `transients` plays, for the same reason.
 */
export const LAUNCH_ALERT_SECONDS = 3;

/**
 * A hostile active pulse that washed over one of your boats, heard.
 *
 * The second *event* in the vision frame, and it is one for the same reason a launch is: a pulse
 * happens, it does not persist, and the player has to be told at the moment it does.
 *
 * **It is not free information either, and it is bought differently.** A launch reaches a team
 * that was already hearing the boat that fired; this reaches a team whose own hull was
 * *illuminated* hard enough to place the transducer — a one-way path from a very loud tone, measured
 * per listener against that listener's own floor (`sim/acoustics/pings.ts`). So the two alerts fail
 * in opposite directions, which is right: a boat can fire unannounced from beyond detection, but a
 * boat cannot ping anybody without telling them roughly where it is standing. That is the cost of
 * the switch (planning/03 §3), and this is the first time the player is shown it directly rather
 * than being left to infer it from a picture that suddenly filled in.
 *
 * `at` is the pinger's position — a submarine's or a weapon's, because a seeker's pulse and a
 * boat's are the same event to whoever it lands on.
 */
export interface HeardPing {
  readonly at: Vec2;
  /**
   * The tick the pulse fired on — not the tick it was heard on, and for the same reason
   * `HeardLaunch.tick` is the firing tick: the frame repeats an alert across several solves, and
   * a key that moved with the observation would flash one pulse three times.
   */
  readonly tick: number;
}

/**
 * Seconds a heard ping keeps being reported. The same window a launch gets, for the same
 * unreliable-channel reason, and comfortably inside `pingIntervalMs` so consecutive pulses from
 * one boat never sit on the wire together.
 */
export const PING_ALERT_SECONDS = LAUNCH_ALERT_SECONDS;

/**
 * One team's sonar picture for one frame.
 *
 * Both square lists are **ascending packed square ids, delta-encoded** (`packCells`): the ids
 * run into the tens of millions on a large map, and consecutive squares on a wall differ by
 * one. Sending the differences turns eight-digit numbers into one-digit ones, which is most of
 * what makes the picture affordable in JSON at all (planning/02 §6, and see ADR 0002 on the
 * tension that remains).
 */
export interface VisionFrame {
  /**
   * Squares newly confirmed as terrain, appended to the recipient's chart and never re-sent.
   *
   * A frame's worth of the team's chart backlog, not the whole chart: `chartSeen` says how far
   * through it the recipient now is, so a burst catches up over the frames that follow.
   */
  readonly charted: readonly number[];
  /** How many chart squares the recipient has now been told about, in total. */
  readonly chartSeen: number;
  /** Squares lit this solve that are not on the chart. Faint returns and hull squares. */
  readonly cells: readonly number[];
  /** Signal excess per square, in half-decibel steps, parallel to `cells`. */
  readonly strength: readonly number[];
  /** Squares that cleared the threshold and did not fit. Drives the "picture truncated" tell. */
  readonly dropped: number;
  /** Every contact the team holds, live and last-known alike. */
  readonly contacts: readonly RevealedContact[];
  /** Hostile launches heard in the last `LAUNCH_ALERT_SECONDS`. Empty almost always. */
  readonly launches: readonly HeardLaunch[];
  /** Hostile pulses that lit one of the team's boats in the last `PING_ALERT_SECONDS`. */
  readonly pings: readonly HeardPing[];
}

/** A frame that says "nothing yet" — what a spectator with no team is sent. */
export const NO_VISION: VisionFrame = {
  charted: [],
  chartSeen: 0,
  cells: [],
  strength: [],
  dropped: 0,
  contacts: [],
  launches: [],
  pings: [],
};

/** Signal excess is quantized to half a decibel on the wire (planning/02 §6). */
export const EXCESS_STEP = 0.5;

/** The loudest excess the wire can express, dB. Anything above reads as "off the scale". */
export const MAX_WIRE_EXCESS = 127;

export function quantizeExcess(db: number): number {
  const steps = Math.round(db / EXCESS_STEP);
  return steps < 0
    ? 0
    : steps > MAX_WIRE_EXCESS / EXCESS_STEP
      ? MAX_WIRE_EXCESS / EXCESS_STEP
      : steps;
}

export function dequantizeExcess(steps: number): number {
  return steps * EXCESS_STEP;
}

/**
 * Delta-encode an **ascending** run of packed cell ids: the first absolute, the rest gaps.
 *
 * Ascending is a precondition, not a suggestion — the caller sorts, because it is the only one
 * that knows whether it already had the list in order. A gap of zero is a duplicate and is
 * dropped rather than encoded, so a decoder never has to deal with one.
 */
export function packCells(ascending: readonly number[]): number[] {
  const out: number[] = [];
  let previous = 0;
  for (const cell of ascending) {
    const gap = cell - previous;
    if (out.length > 0 && gap <= 0) continue;
    out.push(gap);
    previous = cell;
  }
  return out;
}

/** The inverse. Tolerant of a malformed run: a negative gap ends the list rather than throwing. */
export function unpackCells(packed: readonly number[]): number[] {
  const out: number[] = [];
  let running = 0;
  for (const gap of packed) {
    if (!Number.isFinite(gap) || gap <= 0) break;
    running += gap;
    out.push(running);
  }
  return out;
}

// ── The chart ───────────────────────────────────────────────────────────────────────

/**
 * One team's confirmed terrain: a set to test against, and the order it was learned in.
 *
 * The log is what makes the wire cheap. Every recipient tracks how far through it they are, so
 * "what does this player still owe" is a slice rather than a diff, and a reconnecting player is
 * simply set back to zero and caught up over the next few frames.
 */
export class TeamChart {
  private readonly confirmed = new Set<number>();
  private readonly log: number[] = [];

  /** Squares confirmed so far. The denominator of any "how much of the map do we know" readout. */
  get size(): number {
    return this.log.length;
  }

  has(cell: number): boolean {
    return this.confirmed.has(cell);
  }

  /** Record a confirmation. `true` if it was new — which is what puts it on the wire. */
  add(cell: number): boolean {
    if (this.confirmed.has(cell)) return false;
    this.confirmed.add(cell);
    this.log.push(cell);
    return true;
  }

  /** The squares a recipient that has seen `from` of them is still owed, capped at `limit`. */
  since(from: number, limit: number): readonly number[] {
    const start = Math.max(0, Math.min(from, this.log.length));
    return this.log.slice(start, start + Math.max(0, limit));
  }
}

// ── Contacts ────────────────────────────────────────────────────────────────────────

/** What the picture needs to know about an object it has just confirmed. */
export interface ContactSighting {
  readonly id: EntityId;
  readonly kind: ContactKind;
  /** `null` for a torpedo, which has no class to recognize. */
  readonly hull: HullId | null;
  /**
   * Which load this is, for a weapon the team has heard well enough to classify — `null` for a
   * boat, and for anything the caller does not want classified at all.
   *
   * Supplied unconditionally by the caller; **whether it reaches the wire is decided here**,
   * against `identificationThreshold`. The caller knows what the object is and has no idea how
   * loudly this team heard it, which is exactly the split the two halves of `look` already make.
   */
  readonly weapon: WeaponId | null;
  /**
   * Whether `weapon` is already known to this team by some route other than hearing it loudly,
   * and so must not be gated on `identificationThreshold`.
   *
   * Defaults to false, which is the ordinary case: a weapon in the water is named when the
   * squares are loud enough to name it and not before. The exception is the unmasked decoy. A
   * team that pinged one has *measured* it — the whole point of the reveal is that the return
   * came back seven metres long instead of a hundred — so the load is a thing they established,
   * not a thing they are still straining to hear. Making them then hear it loudly enough to
   * re-learn what they already proved would put the player in the one state this file works to
   * avoid: told the silhouette they were chasing is a weapon, and not told which, on the
   * strength of a pulse that answered exactly that question.
   *
   * It cannot be folded into `weapon` being non-null, because the two carry different claims.
   * `weapon` is *what the object is*, supplied unconditionally so the picture can decide; this
   * is *whether this team is entitled to know it*, which only the caller can answer.
   */
  readonly classified?: boolean;
  readonly pos: Vec2;
  readonly facing: number;
  /**
   * Whether the object may be *confirmed* as a contact, rather than merely seen.
   *
   * Defaults to true. A spent torpedo keeps lighting the water while its bang rings down but is
   * no longer a contact: the runtime drops its blip the tick it went off (`ContactBook.drop`),
   * and a false here is what stops the next solve re-minting it while the corpse is still there.
   */
  readonly confirm?: boolean;
}

interface ContactRecord {
  readonly id: ContactId;
  kind: ContactKind;
  hull: HullId | null;
  /** Set once, by a solve that cleared `identificationThreshold`, and never cleared. */
  weapon: WeaponId | null;
  pos: Vec2;
  facing: number;
  seenTick: number;
  seenSeconds: number;
}

/**
 * One team's contacts, keyed by the entity behind them.
 *
 * Keyed that way because association is not a problem the game has yet — the solve knows which
 * hull a square sits on — but the key is private and the `ContactId` it maps to is not, so the
 * day an association step exists it replaces this map and nothing above it changes.
 */
export class ContactBook {
  private readonly byEntity = new Map<EntityId, ContactRecord>();
  private next: ContactId = 1;

  constructor(private readonly tuning: AcousticTuning = ACOUSTICS) {}

  get size(): number {
    return this.byEntity.size;
  }

  /**
   * An object's squares confirmed this solve: open a contact, or refresh the one that exists.
   *
   * `identified` is whether this solve also cleared `identificationThreshold`, and it is the one
   * argument here that does not simply overwrite. **Classification is sticky**: once a team has
   * heard a weapon well enough to name it, it stays named for the life of the contact, because a
   * type that flickered back to *generic torpedo* on every marginal solve would read as the
   * display failing rather than as the sonar being at its limit. Nothing is lost by holding it —
   * a contact that genuinely slips detection ages out and comes back with a fresh `ContactId`,
   * which is where a stale classification would have been dropped anyway.
   *
   * `sighting.classified` is the other way in, for a load the team established rather than
   * overheard — the unmasked decoy. It reaches exactly the same field by exactly the same
   * sticky rule, so a decoy stripped at the edge of pulse range names itself once and stays
   * named on the quiet solves after.
   */
  confirm(
    sighting: ContactSighting,
    tick: number,
    seconds: number,
    identified: boolean = false,
  ): ContactId {
    const named = identified || sighting.classified === true;
    const existing = this.byEntity.get(sighting.id);
    if (existing !== undefined) {
      existing.kind = sighting.kind;
      existing.hull = sighting.hull;
      // Only ever set, never cleared — and only from a sighting that has a load to name, so a
      // decoy that reverts to passing as a boat cannot overwrite what a pulse already proved.
      if (named && sighting.weapon !== null) existing.weapon = sighting.weapon;
      existing.pos = sighting.pos;
      existing.facing = sighting.facing;
      existing.seenTick = tick;
      existing.seenSeconds = seconds;
      return existing.id;
    }

    const record: ContactRecord = {
      id: this.next++,
      kind: sighting.kind,
      hull: sighting.hull,
      weapon: named ? sighting.weapon : null,
      pos: sighting.pos,
      facing: sighting.facing,
      seenTick: tick,
      seenSeconds: seconds,
    };
    this.byEntity.set(sighting.id, record);
    return record.id;
  }

  /**
   * Remove a contact outright, rather than leaving it to fade.
   *
   * For the torpedo that just went off: the thing the blip stood for is gone — what remains is a
   * corpse ringing a bang down — so the marker leaves the tick it happens, for both teams. A
   * no-op when this team never confirmed it.
   */
  drop(entity: EntityId): void {
    this.byEntity.delete(entity);
  }

  /**
   * Every contact the team holds, with the expired ones dropped on the way past.
   *
   * `live` is the whole of the fade: within `contactFadeSeconds` of its last confirmation a
   * contact is a reading, and after it the boat has slipped detection and what is left is a
   * marker at the place it was. Nothing here moves a contact that is not being re-confirmed.
   */
  snapshot(seconds: number): readonly RevealedContact[] {
    const { contactFadeSeconds, contactHoldSeconds } = this.tuning;
    const out: RevealedContact[] = [];

    for (const [entity, record] of this.byEntity) {
      const age = seconds - record.seenSeconds;
      if (age > contactFadeSeconds + contactHoldSeconds) {
        this.byEntity.delete(entity);
        continue;
      }
      out.push({
        id: record.id,
        kind: record.kind,
        hull: record.hull,
        weapon: record.weapon,
        pos: record.pos,
        facing: record.facing,
        seenTick: record.seenTick,
        live: age <= contactFadeSeconds,
      });
    }

    // By contact id, so the order a `Map` happens to iterate in never reaches the wire — the
    // frame has to be the same bytes for the same state or a delta encoder will disagree with
    // itself later (planning/02 §3.4).
    return out.sort((a, b) => a.id - b.id);
  }
}

// ── Folding a solve into the picture ────────────────────────────────────────────────

/** The transient half of a team's frame: what is lit right now, and who is held. */
export interface VisionSnapshot {
  /** Uncharted lit squares, ascending. Capped at `maxWireVisionCells`, brightest kept. */
  readonly cells: readonly number[];
  /** Signal excess, dB, parallel to `cells`. */
  readonly excess: readonly number[];
  /**
   * The ambient ghosts that survived the fold into this frame (planning/15 §5).
   *
   * Also present in `cells`/`excess` — under Option A the wire cannot and must not tell them
   * apart — so this list is for the runtime and the test harness to count, not for the client.
   */
  readonly ghosts: readonly Ghost[];
  /** Lit squares that did not fit the cap. */
  readonly dropped: number;
  readonly contacts: readonly RevealedContact[];
  readonly launches: readonly HeardLaunch[];
  readonly pings: readonly HeardPing[];
}

/**
 * The recent events of one kind a team has heard, and the two rules every such list needs.
 *
 * **Idempotent on `(tick, position)`**, because an event is reported by more than one solve — a
 * launch falls inside two consecutive windows, a pulse is heard by three of your boats at once —
 * and a key that moved with the observation would turn one event into several. Two boats firing
 * on the same tick are still two alerts, which is why position is part of the key.
 *
 * **Repeated for `window` seconds**, so a dropped `view` frame cannot delete an alert. The client
 * dedupes on the same key and animates each one once (`client/render/pings.ts`).
 */
class HeardEvents<T extends { readonly at: Vec2; readonly tick: number }> {
  private entries: { readonly event: T; readonly seconds: number }[] = [];

  constructor(private readonly window: number) {}

  note(event: T, seconds: number): void {
    const already = this.entries.some(
      (entry) =>
        entry.event.tick === event.tick &&
        entry.event.at.x === event.at.x &&
        entry.event.at.y === event.at.y,
    );
    if (already) return;
    this.entries.push({ event, seconds });
  }

  /** The ones still worth repeating, dropping the ones that have aged out on the way past. */
  fresh(seconds: number): readonly T[] {
    if (this.entries.length === 0) return [];
    this.entries = this.entries.filter((entry) => seconds - entry.seconds <= this.window);
    return this.entries.map((entry) => entry.event);
  }
}

/**
 * Everything one team knows, and the fold that grows it.
 *
 * Held per team rather than per player because vision is a property of the team (C17): the
 * chart, the contacts, and the solve behind them are computed once and every player on the side
 * reads the same copy.
 */
export class TeamPicture {
  readonly chart = new TeamChart();
  readonly contacts: ContactBook;

  private readonly tuning: AcousticTuning;
  private latest: VisionSnapshot = {
    cells: [],
    excess: [],
    ghosts: [],
    dropped: 0,
    contacts: [],
    launches: [],
    pings: [],
  };

  /**
   * Hostile launches heard recently, with the wall-clock seconds each was heard at.
   *
   * Held here rather than emitted straight into one frame so that a dropped packet cannot delete
   * an alert — see `LAUNCH_ALERT_SECONDS`. Never more than a handful: it is bounded by how many
   * tubes the enemy has and by three seconds.
   */
  private readonly heardLaunches = new HeardEvents<HeardLaunch>(LAUNCH_ALERT_SECONDS);
  /**
   * And the hostile pulses that lit one of this team's boats. Bounded by how many transducers the
   * enemy has in the water and by `PING_ALERT_SECONDS`, which is shorter than a pulse interval —
   * so in practice it holds at most one entry per enemy pinger.
   */
  private readonly heardPings = new HeardEvents<HeardPing>(PING_ALERT_SECONDS);

  constructor(tuning: AcousticTuning = ACOUSTICS) {
    this.tuning = tuning;
    this.contacts = new ContactBook(tuning);
  }

  /**
   * Record that this team heard a hostile tube fire.
   *
   * Called by the runtime, which is the only thing that knows both who fired and whose picture
   * the firer appeared in. `tick` is the tick the *launch* fired on, and idempotence on
   * `(tick, position)` is why it has to be: a shot is reported by more than one solve, and a key
   * that moved with the observation would turn one launch into three.
   */
  noteLaunch(at: Vec2, tick: number, seconds: number): void {
    this.heardLaunches.note({ at, tick }, seconds);
  }

  /**
   * Record that a hostile pulse lit one of this team's boats.
   *
   * Called by the runtime, for the same reason `noteLaunch` is: it is the only thing that holds
   * both the pulse and the fleet it might have washed over. `tick` is the tick the *pulse* fired
   * on, and idempotence on `(tick, position)` is what makes one pulse heard by four of your boats
   * one alert rather than four.
   */
  notePing(at: Vec2, tick: number, seconds: number): void {
    this.heardPings.note({ at, tick }, seconds);
  }

  /** The last frame's transient half, for a recipient who joined between solves. */
  get current(): VisionSnapshot {
    return this.latest;
  }

  /**
   * Fold one team's solve into the picture.
   *
   * Two passes over the squares, and **the order matters**. Selection runs first, against the
   * chart as it stood *before* this solve, so a square that confirms this tick is still sent as
   * a bright transient — which is what makes it appear to flash green and settle onto the wall
   * that arrives underneath it in the same frame. Confirmation runs second and is uncapped, so
   * the chart records everything the team heard rather than everything that fitted.
   *
   * Ambient ghosts (`sim/acoustics/ghosts.ts`) are folded in **after both passes**, and never
   * run through confirmation — a ghost that confirmed would put a permanent fake rock square on
   * the chart for the rest of the match (planning/15 §5). Their excess is capped well below the
   * confirmation threshold as a second belt, but the structural separation is the real guarantee.
   */
  observe(
    vision: TeamVision,
    tick: number,
    seconds: number,
    look: (entity: EntityId) => ContactSighting | undefined,
    ghosts: readonly Ghost[] = [],
  ): VisionSnapshot {
    // Resolve each distinct hull once rather than per square. `look` returning nothing means
    // "this team learns nothing from a square on that object" — which is how a team's own
    // boats and its allies' stay out of the picture. They reflect a teammate's noise as
    // readily as an enemy does (`solve.ts` is deliberately blind to whose hull it lights), and
    // drawing them as detections would put a shimmer over boats the HUD already knows exactly
    // where to find.
    const sightings = new Map<EntityId, ContactSighting>();
    const opaque = new Set<EntityId>();
    for (let i = 0; i < vision.owners.length; i += 1) {
      const owner = vision.owners[i] ?? -1;
      if (owner < 0 || sightings.has(owner) || opaque.has(owner)) continue;
      const sighting = look(owner);
      if (sighting === undefined) opaque.add(owner);
      else sightings.set(owner, sighting);
    }

    const selected = this.select(vision, sightings);

    // ── Confirmation, over every square the solve produced ────────────────────
    const loudest = new Map<EntityId, number>();
    for (let i = 0; i < vision.cells.length; i += 1) {
      const excess = vision.excess[i] ?? 0;
      if (excess < this.tuning.confirmationThreshold) continue;

      const owner = vision.owners[i] ?? -1;
      if (owner < 0) {
        this.chart.add(vision.cells[i] ?? 0);
        continue;
      }
      // A square that may be seen but not confirmed — the corpse of a torpedo ringing its bang
      // down (`ContactSighting.confirm`) — still transmits, but never re-mints the blip that
      // was dropped the tick it went off.
      const sighting = sightings.get(owner);
      if (sighting === undefined || sighting.confirm === false) continue;
      // A hull confirms on its best square, not on a count of them: a boat seen edge-on
      // presents a handful of squares and is no less confirmed for it.
      const best = loudest.get(owner);
      if (best === undefined || excess > best) loudest.set(owner, excess);
    }

    // Sorted so two servers folding the same solve mint contact ids in the same order — the
    // ids are player-visible, and a replay that renamed them would not be a replay.
    //
    // Classification is decided off the same best-square figure confirmation was, against the
    // higher threshold. One number, two questions — which is what keeps "confirmed but not
    // classified" a band rather than a race between two separate measurements of the same hull.
    for (const entity of [...loudest.keys()].sort((a, b) => a - b)) {
      const sighting = sightings.get(entity);
      if (sighting === undefined) continue;
      const best = loudest.get(entity) ?? 0;
      this.contacts.confirm(sighting, tick, seconds, best >= this.tuning.identificationThreshold);
    }

    this.latest = {
      ...this.foldGhosts(selected, ghosts),
      dropped: selected.dropped + vision.dropped,
      contacts: this.contacts.snapshot(seconds),
      launches: this.heardLaunches.fresh(seconds),
      pings: this.heardPings.fresh(seconds),
    };
    return this.latest;
  }

  /**
   * Age out contacts on a tick with no solve for this team, so a fade is not frozen by silence.
   *
   * Ghosts ride along for the same reason the parameter exists on `observe`: a team with every
   * hydrophone destroyed produces none, but a team mid-solve-gap should not have its halo stutter
   * (planning/15 §5).
   */
  settle(seconds: number, ghosts: readonly Ghost[] = []): VisionSnapshot {
    this.latest = {
      ...this.foldGhosts({ cells: [], excess: [] }, ghosts),
      dropped: 0,
      contacts: this.contacts.snapshot(seconds),
      launches: this.heardLaunches.fresh(seconds),
      pings: this.heardPings.fresh(seconds),
    };
    return this.latest;
  }

  /**
   * Fold the ambient ghosts into the selected picture, strictly ascending and unique.
   *
   * A real return always wins: a ghost on a square already lit this frame is dropped, and a
   * ghost on charted rock is dropped outright — the chart has already settled that square, and a
   * green flicker over known wall would read as a false "something moved against that wall".
   * Ghosts are appended after the `maxWireVisionCells` selection rather than competing in it, so
   * a noisy boat's clutter cannot evict its own real returns — the penalty should be clutter, not
   * blindness (planning/15 §5). `cells`/`strength` travel parallel, so the merged run must be
   * unique as well as ascending, or the delta encoder would drop a square and shift every
   * strength after it.
   */
  private foldGhosts(
    selected: { readonly cells: number[]; readonly excess: number[] },
    ghosts: readonly Ghost[],
  ): { cells: number[]; excess: number[]; ghosts: Ghost[] } {
    if (ghosts.length === 0) return { cells: selected.cells, excess: selected.excess, ghosts: [] };

    // Generation does not deduplicate and emits per source (planning/15 §4), so neither
    // ascending nor unique is promised here; sort once, then merge. Both lists are tiny next to
    // the solver's output, so the cost is nothing.
    const sorted = ghosts.slice().sort((a, b) => a.cell - b.cell);
    const cells: number[] = [];
    const excess: number[] = [];
    const kept: Ghost[] = [];
    let i = 0;
    let g = 0;
    let last = -1;

    /** Append a cell if it is new; `false` means a real return already claimed it. */
    const push = (cell: number, db: number): boolean => {
      if (cell === last) return false;
      last = cell;
      cells.push(cell);
      excess.push(db);
      return true;
    };

    while (i < selected.cells.length || g < sorted.length) {
      const selectedCell =
        i < selected.cells.length ? (selected.cells[i] as number) : Number.POSITIVE_INFINITY;
      const ghost = g < sorted.length ? (sorted[g] as Ghost) : undefined;
      if (ghost === undefined || selectedCell <= ghost.cell) {
        push(selectedCell, selected.excess[i] as number);
        i += 1;
        continue;
      }
      if (!this.chart.has(ghost.cell) && push(ghost.cell, ghost.excess)) kept.push(ghost);
      g += 1;
    }

    return { cells, excess, ghosts: kept };
  }

  /**
   * The uncharted squares worth sending, brightest first, then put back into ascending order.
   *
   * Selected by histogram rather than by sorting: early in a match nothing is charted, so this
   * runs over the solver's whole output — tens of thousands of squares, ten times a second —
   * and a comparison sort of that at 10 Hz is real money. The excess is already being quantized
   * for the wire, so the buckets are free.
   */
  private select(
    vision: TeamVision,
    sightings: ReadonlyMap<EntityId, ContactSighting>,
  ): {
    cells: number[];
    excess: number[];
    dropped: number;
  } {
    const cap = this.tuning.maxWireVisionCells;
    const buckets = new Int32Array(MAX_WIRE_EXCESS / EXCESS_STEP + 1);
    let candidates = 0;

    /**
     * Rock already on the chart is already on screen as a solid square, so re-sending it every
     * frame would be most of the bandwidth and none of the information. Squares on a hull this
     * team may not learn from are dropped outright.
     */
    const worthSending = (i: number): boolean => {
      const owner = vision.owners[i] ?? -1;
      if (owner < 0) return !this.chart.has(vision.cells[i] ?? 0);
      return sightings.has(owner);
    };

    for (let i = 0; i < vision.cells.length; i += 1) {
      if (!worthSending(i)) continue;
      const bucket = quantizeExcess(vision.excess[i] ?? 0);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
      candidates += 1;
    }

    if (candidates === 0) return { cells: [], excess: [], dropped: 0 };

    // Walk down from the loudest bucket until the budget is spent. `cutoff` is the quietest
    // bucket that is taken at all, and `partial` is how many of that bucket fit.
    let cutoff = buckets.length - 1;
    let taken = 0;
    while (cutoff > 0 && taken + (buckets[cutoff] ?? 0) <= cap) {
      taken += buckets[cutoff] ?? 0;
      cutoff -= 1;
    }
    let partial = Math.max(0, Math.min(cap - taken, buckets[cutoff] ?? 0));

    const picked: { cell: number; excess: number }[] = [];
    for (let i = 0; i < vision.cells.length; i += 1) {
      if (!worthSending(i)) continue;
      const bucket = quantizeExcess(vision.excess[i] ?? 0);
      if (bucket < cutoff) continue;
      if (bucket === cutoff) {
        if (partial <= 0) continue;
        partial -= 1;
      }
      picked.push({ cell: vision.cells[i] ?? 0, excess: vision.excess[i] ?? 0 });
    }

    // Ascending, because `packCells` encodes gaps and a gap is only small if the run is sorted.
    picked.sort((a, b) => a.cell - b.cell);
    return {
      cells: picked.map((entry) => entry.cell),
      excess: picked.map((entry) => entry.excess),
      dropped: candidates - picked.length,
    };
  }

  /**
   * One recipient's frame: their share of the chart backlog, plus the whole transient picture.
   *
   * The chart slice is per recipient and the transient half is not, which is the split the
   * `view` channel's delivery guarantees force. A transient frame is superseded 100 ms later and
   * losing one costs nothing; a chart append is the only copy of a fact, and a recipient's
   * watermark is what lets the next frame notice it never arrived (planning/02 §3.4).
   */
  frameFor(chartSeen: number): VisionFrame {
    const owed = this.chart.since(chartSeen, this.tuning.maxChartCellsPerFrame);
    // The log is in confirmation order, which is not ascending; the encoder needs ascending.
    const ascending = [...owed].sort((a, b) => a - b);

    return {
      charted: packCells(ascending),
      chartSeen: Math.min(chartSeen, this.chart.size) + owed.length,
      cells: packCells(this.latest.cells),
      strength: this.latest.excess.map(quantizeExcess),
      dropped: this.latest.dropped,
      contacts: this.latest.contacts,
      launches: this.latest.launches,
      pings: this.latest.pings,
    };
  }
}
