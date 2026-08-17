/**
 * @seg/shared/protocol/binary/codec — `BinaryCodec`.
 *
 * [planning/02 §9](../../../../../planning/02-netcode-protocol.md) step 3: a second codec, shipped
 * over the existing WebSocket, negotiated in the handshake, with `JsonCodec` kept forever behind a
 * flag. Nothing above the codec seam changes — game code still hands over messages and the
 * transport still receives `Uint8Array`s (planning/02 §2).
 *
 * ## The envelope, and why a partial conversion is safe
 *
 * ```
 *   [varint id][body]
 * ```
 *
 * `id` is the message's stable number (`messages.ts`). Id **0** means "the body is JSON" and is
 * what every message without a schema uses. So this codec is *complete* from the first commit —
 * it can carry every message on the wire — while being *binary* only for the ones that have been
 * described. Converting one more type is one schema and one id, with no flag day and no version
 * bump, and the type that was converted is the only one whose bytes move.
 *
 * That matters because of what the measurements say. `bench:netcode:bandwidth` puts `match.view`
 * at **100% of bytes on the wire**; everything else is control-plane traffic at human pace. A
 * conversion effort spread evenly over 43 message types would spend most of itself on messages
 * that are sent once a match.
 *
 * ## What it does not do
 *
 * **It does not compress.** `permessage-deflate` (`server/realtime/compression.ts`) sits below the
 * codec and does that, and the two are largely substitutes rather than complements — measured on
 * the worst case they land within 3% of each other (planning/17 §5.2). This codec's clearer win is
 * CPU: `JSON.stringify` is 71% of a publish (planning/17 §2.1), and the encode below never builds
 * a string.
 *
 * **It is lossy where it says it is.** Quantized fields (`types.ts#fixed`) round to a declared
 * step, at most `step / 2` of error. Everything else round-trips exactly, and re-encoding a
 * decoded message is byte-identical to the original — `binary-codec.test.ts` pins both.
 */

import type { Codec, Message } from '../schema.js';
import { IDS_TO_TYPE, JSON_FALLBACK_ID, MESSAGE_IDS, MESSAGE_SCHEMAS } from './messages.js';
import { readValue, writeValue } from './walk.js';
import { BinaryError, ByteReader, ByteWriter } from './wire.js';

export class BinaryCodec implements Codec {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  encode<T extends Message>(msg: T): Uint8Array {
    const id = MESSAGE_IDS[msg.t];
    const schema = id === undefined ? undefined : MESSAGE_SCHEMAS[msg.t];
    const w = new ByteWriter();

    if (id === undefined || schema === undefined) {
      w.varint(JSON_FALLBACK_ID);
      w.raw(this.encoder.encode(JSON.stringify(msg)));
      // A copy, not the writer's own view: `finish()` hands back a window onto a buffer this
      // method is about to drop, and the transport may hold it past the next call.
      return Uint8Array.from(w.finish());
    }

    w.varint(id);
    writeValue(w, schema, msg);
    return Uint8Array.from(w.finish());
  }

  decode(bytes: Uint8Array): Message {
    const r = new ByteReader(bytes);
    const id = r.varint();

    if (id === JSON_FALLBACK_ID) {
      const parsed: unknown = JSON.parse(this.decoder.decode(r.raw()));
      if (parsed === null || typeof parsed !== 'object' || !('t' in parsed)) {
        throw new BinaryError('invalid message: missing type tag');
      }
      return parsed as Message;
    }

    const type = IDS_TO_TYPE.get(id);
    const schema = type === undefined ? undefined : MESSAGE_SCHEMAS[type];
    if (type === undefined || schema === undefined) {
      // A newer peer sending a type this build has no schema for. Loud, because a silently
      // skipped message is a match that quietly stops updating.
      throw new BinaryError(`unknown message id ${id}`);
    }

    const body = readValue(r, schema) as Record<string, unknown>;
    // Trailing bytes mean the two sides disagree about this type's field list, which is exactly
    // the failure planning/02 §4's "field order is declared" rule exists to prevent. Better a
    // closed connection than a message decoded against the wrong schema version.
    if (r.remaining !== 0) {
      throw new BinaryError(`${r.remaining} trailing bytes after ${type}`);
    }
    return { ...body, t: type } as Message;
  }
}

/** Whether a message travels as binary or falls back to JSON. For tests and the dev overlay. */
export function isSchemad(type: string): boolean {
  return MESSAGE_IDS[type] !== undefined && MESSAGE_SCHEMAS[type] !== undefined;
}
