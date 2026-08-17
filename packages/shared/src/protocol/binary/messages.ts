/**
 * @seg/shared/protocol/binary/messages — the wire schema: stable ids, declared field order.
 *
 * The other two things [planning/02 §4](../../../../../planning/02-netcode-protocol.md) asks for.
 * `types.ts` is the language; this is the document written in it.
 *
 * ## Two rules that outrank readability
 *
 * 1. **Ids are never reused after removal.** A number here is a promise to every client build that
 *    has ever spoken to this server. Deleting a message type leaves a hole; the next type takes the
 *    next free number, not the hole.
 * 2. **Field order is the wire format.** Reordering the fields of a struct is a breaking protocol
 *    change even though TypeScript will not notice, because the decoder reads positionally. Adding
 *    a field at the *end* is the only additive edit; anything else needs a `protocolVersion` bump.
 *
 * ## Enum lists are written out here rather than imported
 *
 * `WEAPON_IDS` is `Object.keys(WEAPONS)`, and object key order is a thing somebody could
 * reasonably reorder while tidying a content table. On the wire an enum is its **index**, so that
 * tidy-up would silently redefine what a `2` means. The lists below are therefore explicit and
 * ordered, and `binary-schema.test.ts` asserts each one still covers its runtime set exactly —
 * which catches the opposite mistake, a new weapon that nobody added here.
 *
 * ## What is schema'd, and what is not
 *
 * `match.view` and the ping pair. That is a deliberate stopping point rather than an unfinished
 * one: `bench:netcode:bandwidth` measures `match.view` at **100% of bytes on the wire**, and every
 * other message is control-plane traffic at human pace. Everything unlisted falls back to JSON
 * through `JSON_FALLBACK_ID` (`codec.ts`), losslessly and automatically. Adding a type later is one
 * entry in `MESSAGE_SCHEMAS` and one id — see `codec.ts` for the envelope that makes the mixture
 * safe.
 */

import {
  array,
  bool,
  enumOf,
  field as f,
  fixed,
  nullable,
  struct,
  u8,
  union,
  varint,
  variant,
  type WireType,
} from './types.js';

// ── Enum orderings. Append only; never reorder. ───────────────────────────────────────

export const TEAM_VALUES = ['team1', 'team2'] as const;
export const HULL_VALUES = ['light', 'medium', 'heavy'] as const;
export const WEAPON_VALUES = [
  'active-torpedo',
  'passive-torpedo',
  'super-cavitating',
  'active-decoy',
  'noisemaker',
  // Appended, not inserted — every name above keeps the index it already had. `improved-*` are the
  // module substitutions (`view.ts#BoatProfile.weaponSubstitutions`), which reach a tube state like
  // any other load and would otherwise fail to encode the first time somebody fitted one.
  'improved-active-torpedo',
  'improved-passive-torpedo',
  'improved-super-cavitating',
  'mine',
  'drone',
] as const;
export const THROTTLE_VALUES = ['slow', 'full', 'flank'] as const;
export const BOAT_STATUS_VALUES = ['active', 'destroyed'] as const;
export const TUBE_STATUS_VALUES = ['loaded', 'reloading', 'unloading', 'empty'] as const;
export const COUNTERMEASURE_STATUS_VALUES = ['ready', 'reloading'] as const;
export const MATCH_PHASE_VALUES = ['deployment', 'active', 'resolution', 'complete'] as const;
export const TORPEDO_PHASE_VALUES = ['launch', 'running', 'enabled', 'spent'] as const;
export const CONTACT_KIND_VALUES = ['boat', 'torpedo'] as const;
export const TRANSIENT_KIND_VALUES = [
  'torpedo-launch',
  'countermeasure-drop',
  'torpedo-detonation',
  'emergency-blow',
  'hard-turn',
  'hull-damage',
  'hull-destroyed',
  'bottoming',
  'collision',
  'surface-breach',
] as const;

// ── Quantization steps, named so the loss is legible ──────────────────────────────────

/**
 * Metres. Positions to half a metre, which planning/02 §6 picked and the map extents make cheap:
 * a `u16` of half-metres reaches 32 767 m, and the largest map is a fraction of that.
 *
 * Worst-case error is 0.25 m on a boat that is 60 m long and rendered on a scope where one pixel
 * is several metres. Nothing in the game can see it.
 */
const POS_STEP = 0.5;
/** Degrees. `facing` is normalized to [0, 360) (`kinematics.ts#normalizeDeg`). */
const ANGLE_STEP = 0.01;
/** Metres per second. The fastest thing in the water is a 55 m/s super-cavitating torpedo. */
const SPEED_STEP = 0.01;
/** Decibels, matching the half-decibel the vision frame already quantizes excess to. */
const DB_STEP = 0.1;
/** Seconds. One sim tick, so tick-derived clocks are exact rather than merely close. */
const SECONDS_STEP = 0.05;
/** Hit points. */
const HP_STEP = 0.1;
/** Capture progress, 0..1. */
const PROGRESS_STEP = 0.001;

// ── Shared shapes ─────────────────────────────────────────────────────────────────────

const vec2: WireType = struct(f('x', fixed(POS_STEP, 'u16')), f('y', fixed(POS_STEP, 'u16')));

const transient: WireType = struct(f('kind', enumOf(...TRANSIENT_KIND_VALUES)), f('tick', varint));

/**
 * `StandingOrder`, as a union rather than as an object with an optional array.
 *
 * A holding boat costs one byte here. Flattened, it would carry a `waypoints: null` — and on a
 * `worst` frame that is 80 boats' worth of nothing (planning/17 §5.4 measures `order` at 4.5 KB a
 * frame in JSON, none of which changes).
 */
const standingOrder: WireType = union(
  'kind',
  variant('hold'),
  variant('transit', f('waypoints', array(vec2))),
);

const boatSnapshot: WireType = struct(
  f('id', varint),
  f('pos', vec2),
  f('facing', fixed(ANGLE_STEP, 'u16')),
  f('speed', fixed(SPEED_STEP, 'u16')),
  f('throttle', enumOf(...THROTTLE_VALUES)),
  f('hp', fixed(HP_STEP, 'u16')),
  f('cavitating', bool),
  f('order', standingOrder),
  f('status', enumOf(...BOAT_STATUS_VALUES)),
  f('activeSonar', bool),
  f('lastPingTick', varint),
  f('transients', array(transient)),
  f('noiseLevel', fixed(DB_STEP, 'i16')),
);

const wreckView: WireType = struct(
  f('id', varint),
  f('hull', enumOf(...HULL_VALUES)),
  f('pos', vec2),
  f('facing', fixed(ANGLE_STEP, 'u16')),
);

const torpedoSnapshot: WireType = struct(
  f('id', varint),
  f('weapon', enumOf(...WEAPON_VALUES)),
  f('firedBy', varint),
  f('pos', vec2),
  f('facing', fixed(ANGLE_STEP, 'u16')),
  f('speed', fixed(SPEED_STEP, 'u16')),
  f('phase', enumOf(...TORPEDO_PHASE_VALUES)),
  f('aim', vec2),
  f('lastPingTick', varint),
  f('transients', array(transient)),
);

const tubeState: WireType = struct(
  f('index', u8),
  f('weapon', enumOf(...WEAPON_VALUES)),
  f('next', enumOf(...WEAPON_VALUES)),
  f('status', enumOf(...TUBE_STATUS_VALUES)),
  f('readyInSeconds', fixed(SECONDS_STEP, 'u16')),
);

const ownBoatDetail: WireType = struct(
  f('id', varint),
  f('tubes', array(tubeState)),
  f(
    'countermeasure',
    struct(
      f('status', enumOf(...COUNTERMEASURE_STATUS_VALUES)),
      f('readyInSeconds', fixed(SECONDS_STEP, 'u16')),
    ),
  ),
);

const revealedContact: WireType = struct(
  f('id', varint),
  f('kind', enumOf(...CONTACT_KIND_VALUES)),
  f('hull', nullable(enumOf(...HULL_VALUES))),
  f('weapon', nullable(enumOf(...WEAPON_VALUES))),
  f('pos', vec2),
  f('facing', fixed(ANGLE_STEP, 'u16')),
  f('seenTick', varint),
  f('live', bool),
);

const heardEvent: WireType = struct(f('at', vec2), f('tick', varint));

/**
 * The vision frame.
 *
 * `cells` and `charted` are already gap-delta encoded by `match/vision.ts`, so their entries are
 * small ascending differences and a varint is close to optimal — this is the one place the wire
 * format was designed before the codec existed, and it pays here. `strength` is already quantized
 * to half-decibel steps by `quantizeExcess` and capped at `MAX_WIRE_EXCESS`, so it is exactly a
 * `u8` and is stored as one rather than re-quantized.
 */
const visionFrame: WireType = struct(
  f('charted', array(varint)),
  f('chartSeen', varint),
  f('cells', array(varint)),
  f('strength', array(u8)),
  f('dropped', varint),
  f('contacts', array(revealedContact)),
  f('launches', array(heardEvent)),
  f('pings', array(heardEvent)),
);

const matchViewState: WireType = struct(
  f('phase', enumOf(...MATCH_PHASE_VALUES)),
  f(
    'clock',
    struct(
      f('tick', varint),
      f('elapsedSeconds', fixed(SECONDS_STEP, 'u32')),
      f('remainingSeconds', fixed(SECONDS_STEP, 'u32')),
    ),
  ),
  f(
    'teams',
    array(
      struct(
        f('team', enumOf(...TEAM_VALUES)),
        f('score', varint),
        f('survivingPoints', varint),
        f('boatsAlive', varint),
        f('boatsTotal', varint),
      ),
    ),
  ),
  f(
    'zones',
    array(
      struct(
        f('id', varint),
        f('label', { k: 'str' }),
        f('centre', vec2),
        f('radius', fixed(POS_STEP, 'u16')),
        f('armingTicks', varint),
        f('capturing', nullable(enumOf(...TEAM_VALUES))),
        f('progress', fixed(PROGRESS_STEP, 'u16')),
        f('contested', bool),
      ),
    ),
  ),
  f('boats', array(boatSnapshot)),
  f('wrecks', array(wreckView)),
  f('torpedoes', array(torpedoSnapshot)),
  f('own', array(ownBoatDetail)),
  f('vision', visionFrame),
);

// ── The message table ─────────────────────────────────────────────────────────────────

/**
 * Reserved. A message with this id carries a JSON body and nothing else (`codec.ts`).
 *
 * Zero on purpose: it is the id an all-zero or truncated buffer would decode to, and "this is
 * JSON" is a far better guess to be wrong about than any real message type.
 */
export const JSON_FALLBACK_ID = 0;

/**
 * Type tag → stable numeric id. **Append only.**
 *
 * The gap between this and `MESSAGE_SCHEMAS` is intentional: an id may exist before a schema does,
 * which is how a type gets converted from JSON to binary in one commit without renumbering
 * anything.
 */
export const MESSAGE_IDS: Readonly<Record<string, number>> = {
  ping: 1,
  pong: 2,
  'match.view': 3,
};

/** Numeric id → type tag, derived so the two can never disagree. */
export const IDS_TO_TYPE: ReadonlyMap<number, string> = new Map(
  Object.entries(MESSAGE_IDS).map(([type, id]) => [id, type]),
);

/**
 * The body schema for each message that has one, **excluding the `t` tag**.
 *
 * `t` is not a field: it is recoverable from the id, and writing it twice would put the string
 * `"match.view"` back on a wire the whole exercise exists to take it off.
 */
export const MESSAGE_SCHEMAS: Readonly<Record<string, WireType>> = {
  ping: struct(f('clientTime', { k: 'f64' })),
  pong: struct(f('clientTime', { k: 'f64' }), f('serverTime', { k: 'f64' })),
  'match.view': struct(
    f('matchId', { k: 'str' }),
    f('seq', varint),
    f('tick', varint),
    f('baseSeq', nullable(varint)),
    f('view', matchViewState),
  ),
};
