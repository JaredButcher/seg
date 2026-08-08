# ADR 0001 — WebRTC is added alongside the WebSocket, not swapped for it

- **Status:** Accepted
- **Date:** 2026-08-07
- **Supersedes:** the "swap two implementations" framing in the first draft of
  `planning/01 §4.1` and `planning/02 §9`
- **Tracked as:** C20 in `planning/12-open-questions.md`

## Context

The original plan treated the transport as one slot holding one implementation: ship
`WsTransport`, later replace it with `RtcTransport`, keep the WebSocket around as a fallback
for players whose networks break WebRTC. Everything was to move together.

That framing does not survive contact with the lobby. Creating, joining, modifying, and
browsing lobbies all happen **before a match exists**, and therefore before there is anything
to negotiate a data channel for — the WebSocket is the signalling channel, so lobby traffic is
structurally upstream of WebRTC. A design that moved it would have to establish a peer
connection in order to ask which lobbies exist.

It is also the traffic with the least to gain. Lobby operations are a handful of messages per
minute at human speed, client↔server, and latency-insensitive. Unreliable delivery would be
actively wrong: a dropped `lobby.join` is a player staring at a screen that did not change.

## Decision

**Both transports are live for the whole session, and routing is per channel.**

- `control` — handshake, auth, all lobby traffic, chat, match start/end, errors, WebRTC
  signalling, route changes — is **pinned to the WebSocket permanently**. It never migrates.
- `commands` and `view` **prefer WebRTC** when a validated data channel exists, and fall back
  to the WebSocket whenever it does not.

A `Link` layer sits above `Transport` and owns the channel→transport routing table. Game code
addresses a channel and never a transport.

## Consequences

**Good.**

- The session always has one path known to be up. If the data channel fails to establish,
  degrades, or dies mid-match, `control` survives to report it and renegotiate. A session in
  which every channel can fail simultaneously has no way to report its own failure.
- A player on a restrictive network keeps a working product — sign in, browse, join, chat,
  play — rather than a locked door. The failure mode is a worse match transport.
- The post-launch rollout becomes four independently revertable steps (binary over the
  existing socket → `commands` onto WebRTC → `view` → unreliable `view`) instead of one large
  swap. Each reverts by changing one channel's policy, with no schema change and no client
  deploy.
- Reconnection (Q21, 90 s) stays on the transport with the simplest semantics.

**Costs, accepted.**

- Two transports mean **cross-channel ordering is gone**. Today one socket makes all traffic
  globally ordered; afterwards a `view` frame can overtake the `match.start` that logically
  precedes it. This is now a standing schema constraint — *no message may depend on the
  arrival order of a message on a different channel* — and it is enforced by making every
  `view` and `commands` message self-describing (`tick`, `seq`, match id). It will not
  announce itself when violated: the code works until a data channel is fast and a socket is
  briefly slow.
- Handover needs a protocol. Fallback is free because reliable-ordered is a superset of every
  other guarantee, but promotion needs an agreed boundary (`channel.route { fromSeq }`) and a
  grace window with sequence-based deduplication.
- The ground-truth test — the most important test in the project — must tap the `Link` rather
  than a socket. Wired to the WebSocket it would keep passing while covering none of the
  `view` traffic, which is exactly where enemy positions would leak.
- Slightly more state to reason about: the routing table is a thing that can be wrong. Held
  down by asserting on it directly, and by running the integration suite under both routings.

**Neutral.**

- Bandwidth is unaffected. The split changes which socket bytes travel on, not how many.

## Alternatives considered

**Swap everything to WebRTC, keep the WebSocket as a pure fallback.** The original plan. Fails
on the lobby ordering problem above, and makes the rollout one all-or-nothing step whose
revert is a client deploy.

**Route per message rather than per channel.** More flexible and much harder to reason about:
the ordering guarantees a message needs are a property of what kind of message it is, which is
what a channel already encodes. Per-message routing would mean every new message type is a
transport decision.

**Keep everything on the WebSocket forever.** Tempting, and it costs nothing until it does —
head-of-line blocking on a stale view frame is the one thing the WebSocket cannot fix, and
it is the reason the channel split exists at all (02 §3).
