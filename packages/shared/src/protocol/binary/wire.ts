/**
 * @seg/shared/protocol/binary/wire — bytes in, bytes out.
 *
 * The bottom of the binary codec: a growable writer and a bounds-checked reader, and nothing that
 * knows what a message is. Everything above this file describes *shapes*; this file is the only
 * place that knows what a `u16` is made of.
 *
 * ## Little-endian, and a varint for anything counted
 *
 * Little-endian because every machine this runs on is, and `DataView` makes the choice explicit
 * rather than accidental. Lengths and ids are **LEB128 varints** rather than fixed widths: a view
 * frame is a few hundred short arrays and a fixed `u32` length on each would cost more than the
 * data. One byte covers every count under 128, which is almost all of them.
 *
 * ## The reader refuses rather than guesses
 *
 * Every read is bounds-checked and throws `BinaryError` past the end. A decoder that ran off the
 * end of a buffer and returned `undefined` would hand the game a half-built message that looks
 * like a real one — the failure has to be loud, because the caller (`realtime/gateway.ts`) already
 * knows what to do with a throw: close the connection and do not attempt recovery.
 */

/** A malformed or truncated buffer. Distinct from a `TypeError` so callers can tell them apart. */
export class BinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryError';
  }
}

/** Initial capacity, bytes. A `typical` view frame encodes to ~400 B, `worst` to ~3 KB. */
const INITIAL_CAPACITY = 1024;

export class ByteWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(capacity = INITIAL_CAPACITY) {
    this.buffer = new ArrayBuffer(capacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  /** How many bytes have been written. */
  get length(): number {
    return this.offset;
  }

  /**
   * Everything written so far, as a view **onto the writer's own buffer**.
   *
   * A subarray rather than a copy: the caller is the codec, which hands it straight to a transport
   * that copies it into a socket. Do not keep it past the next write.
   */
  finish(): Uint8Array {
    return this.bytes.subarray(0, this.offset);
  }

  private need(extra: number): void {
    const required = this.offset + extra;
    if (required <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength * 2;
    while (capacity < required) capacity *= 2;
    const grown = new ArrayBuffer(capacity);
    new Uint8Array(grown).set(this.bytes);
    this.buffer = grown;
    this.view = new DataView(grown);
    this.bytes = new Uint8Array(grown);
  }

  u8(value: number): void {
    this.need(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  i8(value: number): void {
    this.need(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }

  u16(value: number): void {
    this.need(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  i16(value: number): void {
    this.need(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.need(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  i32(value: number): void {
    this.need(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  f32(value: number): void {
    this.need(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  f64(value: number): void {
    this.need(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  /** Unsigned LEB128. Seven bits a byte, high bit set while more follow. */
  varint(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new BinaryError(`varint expects a non-negative integer, got ${value}`);
    }
    let remaining = value;
    while (remaining >= 0x80) {
      this.u8((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.u8(remaining);
  }

  /**
   * Zig-zag then varint, so small negatives are as cheap as small positives.
   *
   * The gap-delta cell lists (`match/vision.ts`) are ascending and never need this, but entity
   * deltas will, and a signed varint that only exists once the first negative appears is a bug
   * waiting for a boat to reverse.
   */
  svarint(value: number): void {
    this.varint(value < 0 ? -2 * value - 1 : 2 * value);
  }

  /** Length-prefixed UTF-8. */
  str(value: string): void {
    const encoded = ENCODER.encode(value);
    this.varint(encoded.byteLength);
    this.need(encoded.byteLength);
    this.bytes.set(encoded, this.offset);
    this.offset += encoded.byteLength;
  }

  /** Raw bytes, length-prefixed. The JSON fallback body (`binary/codec.ts`) is the only user. */
  raw(value: Uint8Array): void {
    this.varint(value.byteLength);
    this.need(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }
}

export class ByteReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Bytes not yet read. Zero at a clean end of message. */
  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.byteLength) {
      throw new BinaryError(
        `truncated: wanted ${count} bytes at ${this.offset}, buffer is ${this.bytes.byteLength}`,
      );
    }
  }

  u8(): number {
    this.need(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  i8(): number {
    this.need(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    this.need(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 8; i += 1) {
      const byte = this.u8();
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new BinaryError('varint too long');
  }

  svarint(): number {
    const raw = this.varint();
    return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
  }

  str(): string {
    const length = this.varint();
    this.need(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return DECODER.decode(slice);
  }

  raw(): Uint8Array {
    const length = this.varint();
    this.need(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
