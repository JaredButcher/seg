/**
 * @seg/server/realtime/ping-handler — ping/pong keepalive.
 *
 * Implements the ping/pong protocol from planning/02 §5:
 * - Client sends `ping{ t: 'ping', clientTime }` on the control channel.
 * - Server responds with `pong{ t: 'pong', clientTime, serverTime }`.
 * - Used for latency display and interpolation smoothing.
 * - Not authoritative for anything (planning/02 §5: "It is not authoritative for anything").
 */

import { createPong, type Codec, type Message } from '@seg/shared';

import type { ChannelId, Transport } from './transport.js';

/**
 * Registers ping/pong message handling on a transport.
 *
 * When a `ping` message arrives on the control channel, the handler
 * records the RTT sample and sends back a `pong` with the server timestamp.
 */
export function registerPingHandler(transport: Transport, codec: Codec, now: () => number): void {
  transport.onMessage((channel: ChannelId, payload: Uint8Array) => {
    // Only process messages on the control channel
    if (channel !== 'control') return;

    let msg: Message;
    try {
      msg = codec.decode(payload);
    } catch {
      // Malformed message — transport layer closes it.
      transport.close('invalid message');
      return;
    }

    if (msg.t === 'ping') {
      const clientTime = msg.clientTime;
      const serverTime = now();
      const rtt = serverTime - clientTime;

      // Update RTT estimate on the transport
      if ('updateRtt' in transport) {
        (transport as { updateRtt: (sampleMs: number) => void }).updateRtt(rtt);
      }

      const pong = createPong(clientTime, serverTime);
      transport.send('control', codec.encode(pong));
    }
  });
}
