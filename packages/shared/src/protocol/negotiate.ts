/**
 * @seg/shared/protocol/negotiate — which codec a connection speaks, and how it says so.
 *
 * [planning/02 §4](../../../../planning/02-netcode-protocol.md) sketches this as
 * `hello.codecs` / `welcome.codec`: the client offers, the server picks, the server announces.
 * The shape here is the same contract with one thing changed, and the reason is worth stating
 * because it is a departure.
 *
 * ## Why a query parameter rather than a `hello` message
 *
 * There is no `hello`. This gateway authenticates **at the upgrade**, from the session cookie
 * (`server/realtime/gateway.ts`), and sends `welcome` the instant the socket opens — deliberately,
 * because holding open sockets for unauthenticated peers is a free resource-exhaustion lever. A
 * `hello`/`welcome` exchange would mean the server had to encode `welcome` *before* it knew which
 * codec to encode it with, which is a chicken-and-egg that a round trip does not solve so much as
 * hide.
 *
 * The connection URL is the one place a preference can be stated before any byte is encoded. So:
 * `?codec=binary`, and `welcome.codec` echoes what was actually chosen. The echo is not
 * decoration — it is how a client finds out that its request was *refused*, which is the case that
 * matters and the one an unacknowledged request cannot express.
 *
 * ## JSON is the default, and stays selectable forever
 *
 * planning/02 §9: "Keep `JsonCodec` forever, selectable by a dev flag. Debugging a binary protocol
 * without the ability to flip back to human-readable frames is a self-inflicted wound."
 *
 * Defaulting to JSON also makes the rollout safe in the direction that matters: a client that
 * predates this negotiation asks for nothing and gets exactly what it got before. The *client*
 * opts in, so an old client can never be handed bytes it cannot read.
 */

/** The codecs a connection may speak. */
export type CodecId = 'json' | 'binary';

export const CODEC_IDS: readonly CodecId[] = ['json', 'binary'];

/** The query parameter a client states its preference in. */
export const CODEC_PARAM = 'codec';

export function isCodecId(value: unknown): value is CodecId {
  return value === 'json' || value === 'binary';
}

/**
 * The codec to use for a connection, from whatever the client asked for.
 *
 * Unrecognized and absent both mean `json`, and neither is an error: a newer client asking for a
 * codec this build has never heard of gets a working session in the format everything can read,
 * which is the same "fall back rather than fail" posture the transport takes (planning/02 §3.2).
 */
export function negotiateCodec(requested: string | null | undefined): CodecId {
  return isCodecId(requested) ? requested : 'json';
}
