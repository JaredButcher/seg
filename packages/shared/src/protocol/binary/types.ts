/**
 * @seg/shared/protocol/binary/types — the field-descriptor language.
 *
 * [planning/02 §4](../../../../../planning/02-netcode-protocol.md) asks for three things that make
 * a binary migration mechanical rather than terrifying: a stable numeric id per message, a
 * **declared** field order, and a **declared** wire type per field. This file is the third, and
 * `messages.ts` is the other two.
 *
 * It is a runtime-interpreted description rather than generated code. The schema is then a value —
 * something a test can walk, a fuzzer can generate from, and a future `BinaryCodec` v2 can diff
 * against v1 — which is worth more than the microseconds code generation would save on a path that
 * measures 0.5 ms per publish (planning/17 §2.1).
 *
 * ## On `fixed`, and where quantization belongs
 *
 * `fixed` is a quantized number: a value divided by a step, stored as an integer. It is the only
 * **lossy** thing here, and the loss is declared — `step / 2` at worst, per field.
 *
 * planning/02 §6 says quantization should live in the *schema* so that JSON benefits too. It does
 * not yet: `viewFor` still emits full floats and only this codec rounds them. That is a deliberate
 * staging decision rather than a disagreement — moving the rounding up into the view builder
 * changes what every client renders and what `netcode-budget.test.ts` records, and it is a
 * separate, independently revertable step (planning/17 §8 step 7). What matters for now is that
 * the loss is **declared per field, bounded, and idempotent**: `encode(decode(encode(x)))` is
 * byte-identical to `encode(x)`, which is the property delta encoding will need.
 */

/** A number stored as `round(value / step)`. Lossy by exactly `step / 2`, and declared. */
export interface FixedType {
  readonly k: 'fixed';
  readonly step: number;
  /** The integer type the quantized value is stored in. Decides the representable range. */
  readonly as: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'varint' | 'svarint';
}

export interface StructType {
  readonly k: 'struct';
  readonly fields: readonly WireField[];
}

/**
 * A discriminated union, keyed on a string field.
 *
 * `StandingOrder` is the one that forced this: `{ kind: 'hold' }` and
 * `{ kind: 'transit'; waypoints: Vec2[] }` are different shapes under one type, and flattening
 * them into an optional array would put a `waypoints: null` on the wire for every holding boat.
 */
export interface UnionType {
  readonly k: 'union';
  /** The field name carrying the discriminant. Written as a varint index, not as a string. */
  readonly tag: string;
  readonly variants: readonly UnionVariant[];
}

export interface UnionVariant {
  readonly tag: string;
  readonly fields: readonly WireField[];
}

export type WireType =
  | { readonly k: 'bool' }
  | { readonly k: 'u8' }
  | { readonly k: 'i8' }
  | { readonly k: 'u16' }
  | { readonly k: 'i16' }
  | { readonly k: 'u32' }
  | { readonly k: 'i32' }
  | { readonly k: 'varint' }
  | { readonly k: 'svarint' }
  | { readonly k: 'f32' }
  | { readonly k: 'f64' }
  | { readonly k: 'str' }
  | FixedType
  /** One of a closed set of strings, stored as its index. */
  | { readonly k: 'enum'; readonly values: readonly string[] }
  /** `T | null`. One byte of presence, then the value. */
  | { readonly k: 'nullable'; readonly of: WireType }
  /** `T | undefined`, for genuinely optional fields. Absent and `undefined` are the same thing. */
  | { readonly k: 'optional'; readonly of: WireType }
  | { readonly k: 'array'; readonly of: WireType }
  | StructType
  | UnionType;

export interface WireField {
  readonly name: string;
  readonly type: WireType;
}

// ── Constructors ──────────────────────────────────────────────────────────────────────
//
// Terse on purpose: `messages.ts` is a table, and a table reads better as data than as a hundred
// object literals with a `k:` on each line.

export const bool: WireType = { k: 'bool' };
export const u8: WireType = { k: 'u8' };
export const i8: WireType = { k: 'i8' };
export const u16: WireType = { k: 'u16' };
export const i16: WireType = { k: 'i16' };
export const u32: WireType = { k: 'u32' };
export const i32: WireType = { k: 'i32' };
export const varint: WireType = { k: 'varint' };
export const svarint: WireType = { k: 'svarint' };
export const f32: WireType = { k: 'f32' };
export const f64: WireType = { k: 'f64' };
export const str: WireType = { k: 'str' };

export function fixed(step: number, as: FixedType['as']): WireType {
  return { k: 'fixed', step, as };
}

export function enumOf(...values: readonly string[]): WireType {
  return { k: 'enum', values };
}

export function nullable(of: WireType): WireType {
  return { k: 'nullable', of };
}

export function optional(of: WireType): WireType {
  return { k: 'optional', of };
}

export function array(of: WireType): WireType {
  return { k: 'array', of };
}

export function struct(...fields: readonly WireField[]): WireType {
  return { k: 'struct', fields };
}

export function field(name: string, type: WireType): WireField {
  return { name, type };
}

export function union(tag: string, ...variants: readonly UnionVariant[]): WireType {
  return { k: 'union', tag, variants };
}

export function variant(tag: string, ...fields: readonly WireField[]): UnionVariant {
  return { tag, fields };
}

// ── Quantization, in one place ────────────────────────────────────────────────────────

/** The integer a `fixed` field stores, and the value it decodes back to. */
export function quantize(value: number, step: number): number {
  return Math.round(value / step);
}

export function dequantize(steps: number, step: number): number {
  // Multiply then round to the step's own decimal grid, so `3 * 0.1` is `0.3` rather than
  // `0.30000000000000004`. Without this, a decoded frame differs from a re-encoded one in the
  // sixteenth decimal place and every `toEqual` in the differential tests fails for no reason.
  const raw = steps * step;
  const decimals = decimalsOf(step);
  return decimals === 0 ? raw : Number(raw.toFixed(decimals));
}

function decimalsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const text = step.toString();
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  // `1e-7` and friends would lie here, but no step in `messages.ts` is written that way and a
  // step small enough to need exponent notation is a step that should be an f32 instead.
  return Math.min(10, text.length - dot - 1);
}
