/**
 * @seg/shared/protocol/binary/walk — one value, one `WireType`, in both directions.
 *
 * The interpreter. `writeValue` and `readValue` are exact mirrors of each other and must stay
 * that way: every branch added to one needs the same branch in the other, in the same order, or
 * the codec produces bytes it cannot read back. `binary-roundtrip.test.ts` walks every type in
 * every schema to prove they still agree.
 *
 * ## Nothing here validates the game
 *
 * A value that does not match its declared type throws, and that is the whole of the checking. It
 * is not this file's job to know that `hp` cannot be negative or that a boat id is in range —
 * those are the simulation's invariants and it already holds them. What *is* this file's job is
 * that a hostile buffer cannot make a decode allocate without bound or loop forever, which is why
 * every count is read through `ByteReader.varint` and every read is bounds-checked.
 */

import { dequantize, quantize, type WireType } from './types.js';
import { BinaryError, type ByteReader, type ByteWriter } from './wire.js';

export function writeValue(w: ByteWriter, type: WireType, value: unknown): void {
  switch (type.k) {
    case 'bool':
      w.u8(value === true ? 1 : 0);
      return;
    case 'u8':
      w.u8(asNumber(value, 'u8'));
      return;
    case 'i8':
      w.i8(asNumber(value, 'i8'));
      return;
    case 'u16':
      w.u16(asNumber(value, 'u16'));
      return;
    case 'i16':
      w.i16(asNumber(value, 'i16'));
      return;
    case 'u32':
      w.u32(asNumber(value, 'u32'));
      return;
    case 'i32':
      w.i32(asNumber(value, 'i32'));
      return;
    case 'varint':
      w.varint(asNumber(value, 'varint'));
      return;
    case 'svarint':
      w.svarint(asNumber(value, 'svarint'));
      return;
    case 'f32':
      w.f32(asNumber(value, 'f32'));
      return;
    case 'f64':
      w.f64(asNumber(value, 'f64'));
      return;
    case 'str':
      if (typeof value !== 'string') throw new BinaryError(`expected string, got ${typeof value}`);
      w.str(value);
      return;

    case 'fixed': {
      const steps = quantize(asNumber(value, 'fixed'), type.step);
      writeInt(w, type.as, steps);
      return;
    }

    case 'enum': {
      const index = type.values.indexOf(value as string);
      if (index < 0) throw new BinaryError(`not a member of the enum: ${String(value)}`);
      w.varint(index);
      return;
    }

    case 'nullable':
      if (value === null || value === undefined) {
        w.u8(0);
        return;
      }
      w.u8(1);
      writeValue(w, type.of, value);
      return;

    case 'optional':
      if (value === undefined) {
        w.u8(0);
        return;
      }
      w.u8(1);
      writeValue(w, type.of, value);
      return;

    case 'array': {
      if (!Array.isArray(value)) throw new BinaryError('expected an array');
      w.varint(value.length);
      for (const item of value) writeValue(w, type.of, item);
      return;
    }

    case 'struct': {
      const record = asRecord(value);
      for (const f of type.fields) writeValue(w, f.type, record[f.name]);
      return;
    }

    case 'union': {
      const record = asRecord(value);
      const tag = record[type.tag];
      const index = type.variants.findIndex((v) => v.tag === tag);
      if (index < 0) throw new BinaryError(`no union variant for ${type.tag}=${String(tag)}`);
      w.varint(index);
      // Non-null assertion is safe: `index` came from `findIndex` on this same array.
      for (const f of type.variants[index]!.fields) writeValue(w, f.type, record[f.name]);
      return;
    }
  }
}

export function readValue(r: ByteReader, type: WireType): unknown {
  switch (type.k) {
    case 'bool':
      return r.u8() !== 0;
    case 'u8':
      return r.u8();
    case 'i8':
      return r.i8();
    case 'u16':
      return r.u16();
    case 'i16':
      return r.i16();
    case 'u32':
      return r.u32();
    case 'i32':
      return r.i32();
    case 'varint':
      return r.varint();
    case 'svarint':
      return r.svarint();
    case 'f32':
      return r.f32();
    case 'f64':
      return r.f64();
    case 'str':
      return r.str();

    case 'fixed':
      return dequantize(readInt(r, type.as), type.step);

    case 'enum': {
      const index = r.varint();
      const value = type.values[index];
      if (value === undefined) throw new BinaryError(`enum index ${index} out of range`);
      return value;
    }

    case 'nullable':
      return r.u8() === 0 ? null : readValue(r, type.of);

    case 'optional':
      return r.u8() === 0 ? undefined : readValue(r, type.of);

    case 'array': {
      const length = r.varint();
      // A hostile length cannot be trusted to allocate against — but it also cannot exceed what is
      // left in the buffer, because every element costs at least one byte. Checking here turns a
      // 4-billion-element allocation into a throw before any memory is touched.
      if (length > r.remaining) {
        throw new BinaryError(`array length ${length} exceeds ${r.remaining} bytes remaining`);
      }
      const out: unknown[] = new Array<unknown>(length);
      for (let i = 0; i < length; i += 1) out[i] = readValue(r, type.of);
      return out;
    }

    case 'struct': {
      const out: Record<string, unknown> = {};
      for (const f of type.fields) {
        const value = readValue(r, f.type);
        // An `optional` that was absent stays absent rather than becoming an explicit
        // `undefined` key, so a decoded object deep-equals the one that was encoded.
        if (value === undefined && f.type.k === 'optional') continue;
        out[f.name] = value;
      }
      return out;
    }

    case 'union': {
      const index = r.varint();
      const chosen = type.variants[index];
      if (chosen === undefined) throw new BinaryError(`union variant ${index} out of range`);
      const out: Record<string, unknown> = { [type.tag]: chosen.tag };
      for (const f of chosen.fields) out[f.name] = readValue(r, f.type);
      return out;
    }
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────────────

type IntKind = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'varint' | 'svarint';

/**
 * What each fixed-width integer can hold.
 *
 * Checked on the way out, because `DataView.setUint16` **masks** rather than throws: a position
 * that drifted past the map extent would encode as a small number on the far side of the ocean and
 * decode as a boat that teleported. That is precisely the class of bug that survives a test suite
 * and shows up in a match, so it costs a comparison per field to make it a throw instead.
 */
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  u8: [0, 0xff],
  i8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  i16: [-0x8000, 0x7fff],
  u32: [0, 0xffffffff],
  i32: [-0x80000000, 0x7fffffff],
};

function writeInt(w: ByteWriter, kind: IntKind, value: number): void {
  const range = RANGES[kind];
  if (range !== undefined && (value < range[0] || value > range[1])) {
    throw new BinaryError(`${value} does not fit in ${kind} (${range[0]}..${range[1]})`);
  }
  switch (kind) {
    case 'u8':
      return w.u8(value);
    case 'i8':
      return w.i8(value);
    case 'u16':
      return w.u16(value);
    case 'i16':
      return w.i16(value);
    case 'u32':
      return w.u32(value);
    case 'i32':
      return w.i32(value);
    case 'varint':
      return w.varint(value);
    case 'svarint':
      return w.svarint(value);
  }
}

function readInt(r: ByteReader, kind: IntKind): number {
  switch (kind) {
    case 'u8':
      return r.u8();
    case 'i8':
      return r.i8();
    case 'u16':
      return r.u16();
    case 'i16':
      return r.i16();
    case 'u32':
      return r.u32();
    case 'i32':
      return r.i32();
    case 'varint':
      return r.varint();
    case 'svarint':
      return r.svarint();
  }
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BinaryError(`expected a finite number for ${what}, got ${String(value)}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new BinaryError(`expected an object, got ${value === null ? 'null' : typeof value}`);
  }
  return value as Record<string, unknown>;
}
