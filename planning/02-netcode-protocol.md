# 02 — Netcode & Protocol

## 1. Goals

1. Ship on **WebSocket + JSON**, because it is debuggable in browser devtools and costs
   nothing to build.
2. Make the eventual move to **WebRTC data channels + binary** a swap of two implementations,
   touching no game code.
3. Keep per-player bandwidth bounded even with 10-boat fleets and a busy acoustic picture.
4. Never put ground truth on the wire (see 01 §5, rule 2).

## 2. The three-layer stack

```
   game code  ──►  Messages (typed, schema'd)
                        │
                   Codec  ──►  Uint8Array        (JsonCodec today, BinaryCodec later)
                        │
                 Transport  ──►  the network      (WsTransport today, RtcTransport later)
```

The critical discipline: **game code never sees bytes, and the transport never sees
messages.** The codec is the only place that knows both.

### Why `Uint8Array` and not `string` at the transport seam
WebSocket happily sends strings, and it is tempting to type the transport as
`send(channel, json: string)`. That types the JSON era into the interface and forces a
signature change — and therefore a change at every call site — the day binary arrives.
`JsonCodec` does `TextEncoder.encode(JSON.stringify(msg))`; `WsTransport` sends the buffer.
Costs one encode pass, saves a refactor.

## 3. Channels

Three logical channels, distinguished by delivery requirements. Under WebSocket all three
are multiplexed over one reliable ordered socket (the guarantees are a superset, so this is
correct, just wasteful). Under WebRTC each maps to a data channel with matching config.

| Channel | Delivery | Carries | WebRTC config |
|---|---|---|---|
| `control` | reliable, ordered | Handshake, auth, lobby state, match start/end, chat, errors | `{ ordered: true }` |
| `commands` | reliable, ordered | Client → server player commands | `{ ordered: true }` |
| `view` | unreliable, sequenced (drop stale) | Server → client per-tick view frames | `{ ordered: false, maxRetransmits: 0 }` |

`view` being droppable is the whole reason for the channel split. A view frame is a snapshot
superseded 100 ms later; retransmitting a stale one behind head-of-line blocking is strictly
worse than dropping it. This is the single biggest win available from the WebRTC migration,
and it is why the abstraction exists from day one.

**Delta encoding and unreliable delivery interact.** Design decision: view frames are
delta-encoded against the **last frame the client acknowledged**, not against the immediately
preceding frame. Client acks the highest view sequence it has applied on the `commands`
channel (piggybacked, one integer). If no ack is outstanding within `N` ticks, the server
sends a keyframe. This is a standard baseline-ack scheme and it is what lets `view` tolerate
loss without desync. Build it now even though WebSocket never drops — otherwise the WebRTC
migration is not a swap.

## 4. Message schema

Single source of truth: `@seg/shared/protocol/schema.ts`. Every message is a discriminated
union on `t` (type tag).

```ts
type Message = ClientMessage | ServerMessage;

interface Envelope { t: string; }

// ── client → server ────────────────────────────────────────────────
type ClientMessage =
  | { t: 'hello';        protocolVersion: number; codecs: CodecId[] }
  | { t: 'auth';         token: string }
  | { t: 'lobby.create'; settings: LobbySettings }
  | { t: 'lobby.join';   code: string; asSpectator: boolean }
  | { t: 'lobby.setFleet'; fleetId: FleetId }
  | { t: 'lobby.setSettings'; patch: Partial<LobbySettings> }   // host only
  | { t: 'lobby.ready';  ready: boolean }
  | { t: 'lobby.start' }                                        // host only
  | { t: 'lobby.leave' }
  | { t: 'cmd';          seq: number; viewAck: number; cmd: PlayerCommand }
  | { t: 'chat';         scope: 'team' | 'all'; text: string }
  | { t: 'ping';         clientTime: number };

// ── server → client ────────────────────────────────────────────────
type ServerMessage =
  | { t: 'welcome';      protocolVersion: number; codec: CodecId; contentHash: string }
  | { t: 'authResult';   ok: boolean; account?: AccountSummary; error?: ErrorCode }
  | { t: 'lobby.state';  lobby: LobbyState }
  | { t: 'match.start';  matchId: MatchId; setup: MatchSetup }
  | { t: 'view';         seq: number; tick: Tick; baseSeq: number; delta: ViewDelta }
  //   ViewDelta covers TeamView (shared, computed once per team) + PlayerPrivateView.
  //   Both travel on every connection; only the computation is shared. See 01 §5.
  | { t: 'cmdAck';       seq: number; tick: Tick; rejected?: ErrorCode }
  | { t: 'match.end';    result: MatchResult }
  | { t: 'chat';         from: PlayerId; scope: 'team' | 'all'; text: string }
  | { t: 'pong';         clientTime: number; serverTime: number; tick: Tick }
  | { t: 'error';        code: ErrorCode; message: string; fatal: boolean };
```

### Schema rules that make the binary migration mechanical
- Every message type has a **stable numeric id** declared alongside it. The binary codec uses
  the number; JSON uses the string. Ids are never reused after removal.
- Field order within a message is **declared** (an array of field descriptors), because a
  binary codec needs a canonical order and hand-maintaining two orderings is a bug factory.
- Every field has a **declared wire type** (`u8`, `i16`, `f32`, `str`, `bool`, `array<T>`,
  `optional<T>`, plus fixed-point quantized types — see §6).
- No `any`, no free-form objects, no `Record<string, unknown>` on the wire. If it cannot be
  described in the field-descriptor language, it does not go on the wire.

`contentHash` in `welcome` is the hash of the content tables (hulls, modules, torpedoes). A
client with a mismatched hash is told to hard-reload. This prevents a stale cached client from
computing point costs the server disagrees with.

## 5. Tick and timing model

| Parameter | Value | Notes |
|---|---|---|
| Sim tick rate | **20 Hz** (50 ms) | Set by torpedo terminal geometry and collision, not by boat movement — see 04 §1 |
| Acoustic solve rate | **10 Hz** (every second tick); 2 Hz for "cold" pairs (03 §10) | Detection state does not change meaningfully in 50 ms, and acoustics is the expensive phase |
| View frame rate | **10 Hz**, one per acoustic solve | May drop to 5 Hz for distant/idle content post-1.0 |
| Client render rate | Display refresh (60–144 Hz), interpolating | |
| Command handling | Applied at the first sim tick boundary after arrival | 20 Hz, so up to 50 ms of quantization |

**The 20/10/10 split is deliberate.** The simulation gets the precision it needs where it
matters (movement, collision, torpedo fuzing) without paying for it where it does not
(acoustics, bandwidth). Each view frame carries exactly one fresh acoustic solve — no waste in
either direction — and the network rate is unchanged from a 10 Hz-everything design, so none of
the bandwidth analysis below is affected by the higher sim rate.

**No client-side prediction of the world.** The client applies commands optimistically only
to *local UI affordances* — the order marker appears on the scope immediately, drawn in a
"pending" style, and switches to "confirmed" on `cmdAck`. The boat itself does not move until
the server says so. At this pace nobody notices, and it removes reconciliation entirely.

**Clock sync** is `ping`/`pong` with the standard offset estimate. Its only jobs are: showing
the player their latency, and letting the client interpolate view frames on a smooth timeline
instead of jittering with packet arrival. It is not authoritative for anything.

### Interpolation policy
Render 1.5 **view frames** behind (150 ms buffer). Interpolate own-boat position, facing, and
pitch between frames — pitch interpolation matters visually, since a diving boat visibly noses
down (09 §8). **Never extrapolate contacts** — a contact's rendered position is the last sensed
position, aging visually (03 §7). Extrapolating a contact would be the client inventing
information, which violates pillar P3.

## 6. Bandwidth budget

Target: **≤ 8 KB/s down per player** at JSON-era p95, in the worst realistic case (10 boats,
dense contact list, active engagement). Comfortable for any connection, and it keeps the
JSON era viable long enough that the binary migration stays a post-launch optimization.

Worst-case content of one view frame for a 10-boat player:

| Item | Count | JSON bytes (est.) | Binary (est.) |
|---|---|---|---|
| Own boats (full state) | 10 | ~180 ea = 1800 | ~28 ea = 280 |
| Own torpedoes in water | 12 | ~90 ea = 1080 | ~16 ea = 192 |
| Contacts (tracked) | 30 | ~120 ea = 3600 | ~20 ea = 600 |
| Echo returns (new this tick) | 60 | ~40 ea = 2400 | ~6 ea = 360 |
| Frame overhead | — | ~120 | ~12 |
| **Total per frame** | | **~9 KB** | **~1.4 KB** |
| **At 10 Hz** | | **90 KB/s** ✗ | **14 KB/s** |

That fails the budget by an order of magnitude, which is exactly why these levers exist and
must be built at launch, not retrofitted:

1. **Delta encoding** (§3). Most boat fields don't change between ticks; a boat cruising
   straight and level sends a small facing correction and nothing else. Realistic reduction:
   **6–10×**.
2. **Quantization.** Positions to 0.5 m fixed-point over the map extent, facing to 0.5°, speeds
   to 0.1 m/s, acoustic levels to 0.5 dB. Applied in the *schema*, so JSON benefits too (shorter
   numbers) and binary benefits enormously. Reduction: **~2×** on JSON, more on binary. Note the
   vertical-slice map is 5000 m × 1200 m (03 §9), so a 0.5 m grid needs only 14 bits for `x` and
   12 for `y` — quantized positions are cheaper than they would have been on a 16 km map.
3. **Contact caps.** Hard limit of 48 tracked contacts per player; beyond that, merge weakest
   into a low-fidelity "clutter" representation. Also a *design* win — an unbounded contact
   list is unreadable anyway.
4. **Echo decimation.** Echo returns are the biggest and burstiest item. Cap new returns per
   frame per player; prefer returns that change the picture (see 03 §6).

With 1 + 2 applied, JSON lands near **7–12 KB/s** in the worst case and under 2 KB/s in the
common case. Acceptable. Binary + WebRTC later takes it to ~1–2 KB/s worst case.

Note that the worst case above assumes a **10-boat** fleet, which is the supported maximum
rather than the expected case. At the design-target 3–5 boats (05 §6) the frame is roughly half
the size, so the budget has real headroom in normal play and the 10-boat case is the one that
must merely *fit*.

**Measure this from M2.** A dev overlay showing bytes/s per channel, and `bench-bandwidth` in CI
failing if the worst case exceeds budget (13 §9). Bandwidth regressions are invisible until they
are catastrophic.

## 7. Abuse and rate limiting

| Vector | Control |
|---|---|
| Command flooding | Token bucket: 20 commands/s burst, 5/s sustained per connection. Excess dropped with `cmdAck.rejected`; sustained excess closes the connection. Note the *game* never needs more than ~1 command/s. |
| Oversized messages | Hard cap 8 KB inbound per message; exceeded → close. |
| Chat spam | 3 messages / 5 s, 200 char cap, per-lobby mute available to host. |
| Auth brute force | Per-IP and per-username exponential backoff; 10 failures → 15 min lockout on that username. |
| Lobby spam | Max 1 active hosted lobby per account; creation rate-limited. |
| Reconnect thrash | Exponential backoff enforced server-side; repeated fast reconnects get a cooldown. |
| Timing attacks on auth | Constant-time compare; always run the argon2 verify even for unknown usernames (against a dummy hash). |

## 8. Versioning

`protocolVersion` is an integer, bumped on any breaking schema change. Mismatch → the server
replies with `error{ code: 'PROTOCOL_MISMATCH', fatal: true }` and the client shows a
"reload required" screen. No backward compatibility shims for 1.0 — client and server deploy
together and the client is served by the same origin. Revisit if a native/standalone client
ever exists.

## 9. Migration plan: JSON+WS → binary+WebRTC

Sequenced so each step is independently shippable and revertable.

1. **Now:** build against `Transport` + `Codec`. Ship `WsTransport` + `JsonCodec`.
2. **Now:** build channel separation, view sequencing, baseline-ack deltas, and quantization
   into the schema — even though WebSocket makes some of it redundant. *This is the step that
   is expensive to retrofit.*
3. **Post-launch, step 1:** implement `BinaryCodec` from the field descriptors. Negotiate via
   `hello.codecs` / `welcome.codec`. Ship it over the existing WebSocket. Independently testable
   by the property and differential tests described in 13 §7 — which are **written at M2 against
   `JsonCodec` alone** and simply activated for the second codec when it arrives. That is what
   makes this step safe rather than terrifying.
4. **Post-launch, step 2:** implement `RtcTransport`. WebSocket becomes the signalling channel
   for the WebRTC handshake, then persists as fallback for clients where the data channel
   fails to establish. Both transports must remain supported indefinitely — restrictive
   networks will break WebRTC for some players.
5. **Post-launch, step 3:** enable unreliable delivery on `view`. Only safe once step 2 of
   this plan and the baseline-ack scheme are both verified under induced packet loss.

**Keep `JsonCodec` forever**, selectable by a dev flag. Debugging a binary protocol without
the ability to flip back to human-readable frames is a self-inflicted wound.
