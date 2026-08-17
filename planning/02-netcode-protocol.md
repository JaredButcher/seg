# 02 — Netcode & Protocol

## 1. Goals

1. Ship on **WebSocket + JSON**, because it is debuggable in browser devtools and costs
   nothing to build.
2. Make **adding WebRTC data channels + binary** a matter of implementing two more classes
   behind the existing seams, touching no game code.
3. Run **both transports at once**, permanently. WebRTC is not a replacement for the
   WebSocket — it is a second path that some channels prefer. The WebSocket never goes away
   and is never merely a fallback: the control channel lives on it by design (§3.1).
4. Keep per-player bandwidth bounded even with 10-boat fleets and a busy acoustic picture.
5. Never put ground truth on the wire (see 01 §5, rule 2).

## 2. The four-layer stack

```
   game code  ──►  Messages (typed, schema'd)
                        │
                   Codec  ──►  Uint8Array        (JsonCodec today, BinaryCodec later)
                        │
                    Link   ──►  picks a transport per channel   (§3.1)
                     ╱  ╲
            WsTransport   RtcTransport            (both live at once, post-launch)
                 │             │
            the network   the network
```

The critical discipline: **game code never sees bytes, and the transport never sees
messages.** The codec is the only place that knows both.

The **Link** is the fourth layer and the one this document's post-launch half turns on. Game
code sends on a *channel*; the Link decides which transport carries it, and that decision can
change during a session. A transport is a dumb pipe with an identity and a set of delivery
guarantees; it does not know what a channel means. See 01 §4.1a.

Ship the Link at launch with exactly one transport registered. A Link that has only ever had
one transport is a few dozen lines and it is the difference between "add WebRTC" and
"rewrite the send path".

### Why `Uint8Array` and not `string` at the transport seam
WebSocket happily sends strings, and it is tempting to type the transport as
`send(channel, json: string)`. That types the JSON era into the interface and forces a
signature change — and therefore a change at every call site — the day binary arrives.
`JsonCodec` does `TextEncoder.encode(JSON.stringify(msg))`; `WsTransport` sends the buffer.
Costs one encode pass, saves a refactor.

## 3. Channels

Three logical channels, distinguished by delivery requirements **and by which transport
carries them**. At launch all three are multiplexed over one reliable ordered WebSocket (the
guarantees are a superset, so this is correct, just wasteful). Once WebRTC exists, the
channels split across two transports that are both live at the same time.

| Channel | Delivery | Carries | Transport policy |
|---|---|---|---|
| `control` | reliable, ordered | Handshake, auth, **all lobby traffic** (create, join, modify, browse), match start/end, chat, errors, WebRTC signalling, route changes | **Pinned to WebSocket. Permanently.** |
| `commands` | reliable, ordered | Client → server player commands | Prefer WebRTC (`{ ordered: true }`); fall back to WebSocket |
| `view` | unreliable, sequenced (drop stale) | Server → client per-tick view frames | Prefer WebRTC (`{ ordered: false, maxRetransmits: 0 }`); fall back to WebSocket |

`view` being droppable is the whole reason for the channel split. A view frame is a snapshot
superseded 100 ms later; retransmitting a stale one behind head-of-line blocking is strictly
worse than dropping it. This is the single biggest win available from adding WebRTC, and it
is why the abstraction exists from day one.

### 3.1 Why `control` is pinned to the WebSocket

This is a decision, not an implementation detail, and it does not expire when WebRTC lands.
Five reasons, in descending order of how much they matter:

1. **The lobby is upstream of the negotiation.** WebRTC needs signalling, and the WebSocket
   is the signalling channel. Creating, browsing, and joining a lobby all happen *before*
   there is a match to have a data channel for. A design that moved lobby traffic to WebRTC
   would have to negotiate a data channel in order to ask which lobbies exist.
2. **It is the transport of last resort, and a session needs one.** If the data channel fails
   to establish, degrades, or dies mid-match, something has to survive to say so and to
   renegotiate. A session where every channel can fail at once has no way to report its own
   failure. Pinning `control` means there is always one path known to be up.
3. **Restrictive networks break WebRTC, not WebSockets.** A player behind a hostile NAT or a
   corporate proxy keeps a working product — sign in, browse, join, chat, play on the
   WebSocket — instead of a broken one. The failure is a worse match transport, never a
   locked door.
4. **Moving it buys nothing.** Lobby traffic is a handful of messages per minute at human
   speed, and it is client↔server request-response. There is no bandwidth to save and no
   latency anyone can perceive. Unreliable delivery would be actively wrong: a dropped
   `lobby.join` is a player staring at a screen that did not change.
5. **Reconnection depends on it.** The 90 s reconnect window (Q21) is driven entirely by
   control-channel traffic. Keeping it on the transport with the simplest reconnect
   semantics is what makes that window dependable rather than a second thing to debug.

The rule to hold onto: **`control` never migrates.** Every other routing decision in §3.2 is
allowed to change at runtime; this one is fixed at compile time.

### 3.2 Routing and handover

Each channel has a policy — `pinned` to a named transport, or `preferred` with a fallback
list. The Link resolves the policy against the transports currently registered and healthy.

**Fallback is always safe; promotion needs a handshake.** Reliable-ordered is a superset of
every other guarantee, so dropping a channel back onto the WebSocket can happen at any moment
with no coordination. Moving a channel *up* onto WebRTC cannot: both sides have to agree on
where the boundary is, or messages get duplicated or lost across the seam.

The handover protocol, therefore:

1. Every channel starts on the WebSocket. A session is fully functional before WebRTC is
   attempted, which is also what makes the WebRTC step independently revertable (§9).
2. The data channel is established and validated (a round trip on it, not merely `open`).
3. The server announces the move on `control`: `channel.route { channel, transport, fromSeq }`.
4. The sender switches after `fromSeq`. The receiver accepts that channel on **either**
   transport during a grace window, deduplicating by sequence number.
5. On WebRTC failure or degradation, the server announces the reverse move and the channel
   is back on the WebSocket immediately. No grace window is needed in this direction.

Note how much of this leans on `control` being reliable, ordered, and always up: the
announcement itself cannot be lost or reordered relative to the other control traffic. That
is §3.1 reason 2 doing real work rather than being a nice sentiment.

### 3.3 The constraint this introduces: no cross-channel ordering

Today all three channels share one socket, so every message is globally ordered — a
`match.start` on `control` provably arrives before any `view` frame sent after it. **Two
transports destroy that property**, and it will not announce itself: the code keeps working
until a data channel is fast and a WebSocket is briefly slow, and then a client renders a
frame for a match it has not been told about.

The rule, which applies to schema design and not just to implementation:

> **No message may depend on the arrival order of a message on a different channel.**

Consequences to build in from the start, while there is only one transport and violations are
invisible:

- Every `view` and `commands` message carries the identity it needs to be interpreted alone —
  `tick`, `seq`, and the match id. A view frame is self-describing or it is a bug.
- A client that receives `view` for a match it has no `match.start` for **buffers briefly,
  then discards** — it never guesses. The reverse (dropping frames that arrive during the
  gap) is what the baseline-ack keyframe path already handles.
- The same rule binds the server: a command that arrives on `commands` referring to a lobby
  state the client has not yet been told about is rejected with `cmdAck.rejected`, not
  speculatively applied.

This is the single most likely source of a subtle post-WebRTC bug, which is why it is written
down now rather than discovered later.

### 3.4 Delta encoding and unreliable delivery interact

Design decision: view frames are delta-encoded against the **last frame the client
acknowledged**, not against the immediately preceding frame. Client acks the highest view
sequence it has applied on the `commands` channel (piggybacked, one integer). If no ack is
outstanding within `N` ticks, the server sends a keyframe. This is a standard baseline-ack
scheme and it is what lets `view` tolerate loss without desync. Build it now even though
WebSocket never drops — otherwise adding WebRTC stops being additive.

Note that the ack loop **deliberately crosses channels**: frames go out on `view`, acks come
back on `commands`, and after §3.2 those may be on different transports mid-handover. That is
safe precisely because of §3.3 — an ack names an absolute view sequence rather than meaning
"the last thing you sent me" — but it is the clearest example of why that rule exists.

## 4. Message schema

Single source of truth: `@seg/shared/protocol/schema.ts`. Every message is a discriminated
union on `t` (type tag).

```ts
type Message = ClientMessage | ServerMessage;

interface Envelope { t: string; }

// ── client → server ────────────────────────────────────────────────
type ClientMessage =
  | { t: 'hello';        protocolVersion: number; codecs: CodecId[]; transports: TransportId[] }
  | { t: 'auth';         token: string }
  | { t: 'lobby.create'; settings: LobbySettings }
  | { t: 'lobby.join';   code: string; asSpectator: boolean }
  | { t: 'lobby.setFleet'; fleetId: FleetId }
  | { t: 'lobby.setSettings'; patch: Partial<LobbySettings> }   // host only
  | { t: 'lobby.ready';  ready: boolean }
  | { t: 'lobby.start' }                                        // host only
  | { t: 'lobby.leave' }  | { t: 'cmd';          seq: number; viewAck: number; cmd: PlayerCommand }
  | { t: 'chat';         scope: 'team' | 'all'; text: string }
  | { t: 'ping';         clientTime: number }
  //   WebRTC signalling. Always on `control`, therefore always on the WebSocket (§3.1).
  | { t: 'rtc.answer';   sdp: string }
  | { t: 'rtc.ice';      candidate: string }
  | { t: 'rtc.failed';   reason: string };                      // give up; stay on WebSocket

// ── server → client ────────────────────────────────────────────────
type ServerMessage =
  //   `routes` is the initial channel→transport map. At launch, and at the start of every
  //   session thereafter, it is every channel on 'ws' (§3.2 step 1).
  | { t: 'welcome';      protocolVersion: number; codec: CodecId; contentHash: string;
                         routes: Record<ChannelId, TransportId> }
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
  | { t: 'error';        code: ErrorCode; message: string; fatal: boolean }
  //   Handover (§3.2 step 3). `fromSeq` is the boundary: messages on `channel` numbered
  //   above it travel on `transport`. Never sent for `control`.
  | { t: 'channel.route'; channel: ChannelId; transport: TransportId; fromSeq: number }
  | { t: 'rtc.offer';    sdp: string; iceServers: IceServer[] }
  | { t: 'rtc.ice';      candidate: string };

type TransportId = 'ws' | 'rtc';
```

**`LobbySettings`** (the full shape in §4's schema) includes the map configuration — `mapType` is
`'empty' | 'sparse' | 'dense'` and `mapSize` is `'small' | 'medium' | 'large'` (06 §3, 14 §1).
`lobby.create` sends the full settings object, so the map fields travel with it; later changes go
through `lobby.setSettings` as a partial patch. The shared type is the single source of truth
(`@seg/shared/lobby/state.ts`), so adding a field to the type is all it takes to add it to the wire.

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
   vertical-slice map is 8000 m × 3000 m at base scale (03 §9), so a 0.5 m grid needs only 14 bits
   for `x` and 13 for `y` — quantized positions are cheaper than they would have been on a 16 km
   map.
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

> Neither exists yet, and none of the estimates above has been measured. The benchmarks,
> the instrumentation they need, the build order for the levers, and the server-side cost of
> §9's WebRTC steps — which this document deliberately does not cost out — are in
> [17-netcode-performance.md](17-netcode-performance.md).

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

## 9. Adding binary and WebRTC

Not a migration — an **addition**. At the end of this plan the system speaks two codecs over
two transports simultaneously, and the WebSocket carries more traffic than it did at launch,
not less. Sequenced so each step is independently shippable and revertable.

1. **Now:** build against `Link` + `Transport` + `Codec`. Ship one transport (`WsTransport`)
   and one codec (`JsonCodec`), with the Link's routing table present and trivial.
2. **Now:** build channel separation, view sequencing, baseline-ack deltas, and quantization
   into the schema — even though WebSocket makes some of it redundant. Build the §3.3
   self-describing-message rule in from the start, because a violation is invisible while
   there is one transport. *This is the step that is expensive to retrofit.*
3. **Post-launch, step 1:** implement `BinaryCodec` from the field descriptors. Negotiate via
   `hello.codecs` / `welcome.codec`. Ship it over the existing WebSocket. Independently testable
   by the property and differential tests described in 13 §7 — which are **written at M2 against
   `JsonCodec` alone** and simply activated for the second codec when it arrives. That is what
   makes this step safe rather than terrifying.
4. **Post-launch, step 2:** implement `RtcTransport` and register it alongside `WsTransport`.
   The WebSocket carries the signalling and keeps `control` forever (§3.1). Move `commands`
   first — it is low-volume and reliable-ordered on both transports, so the handover logic
   gets exercised where a mistake is cheap and obvious.
5. **Post-launch, step 3:** move `view` to WebRTC, still reliable-ordered. This isolates
   "does handover work for a high-volume channel" from "does unreliable delivery work".
6. **Post-launch, step 4:** enable unreliable delivery on `view`. Only safe once the
   baseline-ack scheme is verified under induced packet loss (13 §7).

Steps 4–6 are each revertable by changing one channel's policy back, with no schema change
and no client deploy — which is the practical payoff of routing being data rather than
structure.

**Keep `JsonCodec` forever**, selectable by a dev flag, and **keep an all-WebSocket routing
mode forever** on the same footing. Debugging a binary protocol without the ability to flip
back to human-readable frames is a self-inflicted wound; debugging a two-transport session
without the ability to collapse it onto one is the same wound twice.
