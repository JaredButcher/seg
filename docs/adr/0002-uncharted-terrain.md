# ADR 0002 — Players start with an uncharted map and fill it in by sonar

- **Status:** Accepted
- **Date:** 2026-08-08
- **Supersedes:** C12 in `planning/12-open-questions.md`, and `planning/08 §3` layer 3
- **Tracked as:** C21 in `planning/12-open-questions.md`

## Context

C12 decided that terrain is **charted from match start**: every client receives the generated
map, draws it dim, and sonar makes local geometry crisp. The reasoning was navigational —
route planning through a cave system is impossible without knowing the geometry, and a match
spent bumping into walls is not the game.

Two things were wrong with it.

**The smaller one is that the argument does not hold.** Route planning is done by the *server*,
which has the map: a transit order is a click on a point and the navmesh answers it, with "no
route" as a first-class explained refusal (`planning/08 §5`). A player who cannot see the rock
can still be told their Heavy has no way through. What they lose is the ability to plan against
geometry they have not earned, which is the thing the game is about.

**The larger one is that C12 gave away the product.** The premise is that the display *is* the
fog of war (pillar P3) and that information is the resource (P1). Handing every player the
complete cave system at tick zero means the only unknown left is where the enemy is — the map
itself, which `planning/00` calls the dominant system in the game, is solved before the first
order. "Building an acoustic picture of the map faster than the enemy builds one of you" was
the one-paragraph pitch, and half of it was not implemented.

There was also a concrete leak. `MatchSetup` carried the whole `GeneratedMap`, seed included,
and map generation is pure and lives in `@seg/shared` — which the client bundles. A seed plus a
`generatorVersion` reproduces the terrain exactly, in one line, in a devtools console. Any
redaction that left the seed on the wire would have been decoration.

## Decision

**A playing client is never sent the map. It is sent the frame, and it earns the rest.**

- `MatchSetup.map` is a **`MapChart`**: extents, depth scale, size, type, generator version.
  No obstacles, **no seed**. Terrain is non-null only for a recipient entitled to ground truth
  — today a spectator, later whichever spectators the host's vision policy allows (`07 §5`).
- A `match.view` frame carries a **`VisionFrame`**: chart appends, this solve's transient
  returns with their signal excess, and the team's confirmed hostile contacts.
- **Two thresholds, not one.** `detectionThreshold` decides whether a square appears at all;
  `confirmationThreshold` decides whether the server commits to it. Between them is a band
  where the player can see something the game has not agreed to.
- **A confirmed rock square is charted for the rest of the match.** Rock does not move, so
  there is nothing for a second look to correct. The chart is append-only and each square
  crosses the wire once.
- **A confirmed hull reveals the whole boat** — silhouette, position, pitch — as a live
  reading that dims with the age of its last confirmation. When it stops being re-confirmed it
  becomes a **hollow outline at the pose that was measured**, and it never moves again.
- **Confirmation is server-side and uncapped.** It runs over every square the solve produced,
  while the transmitted set is capped. A team's chart does not depend on how much of its
  picture fitted in a packet, and a client cannot be made to forget a square it was not sent.
- Vision is pooled **per team** (C17), like the solve that produces it.

### What the player actually sees

Three layers, stacked, and none of them labelled:

1. Confirmed rock, drawn solid in the `terrain` tone. Permanent.
2. This solve's returns, drawn as sonar-green 1 m squares, brightness from signal excess,
   fading over about a second and a half.
3. Confirmed hostile silhouettes, filled while live and hollow once they slip.

The mechanic falls out of the stacking rather than out of any per-square tag. A green square
that was a wall gets its chart rectangle in the *same frame*, so the green fades and reveals
rock underneath. A green square that was a fluke has nothing under it and fades to water. A
green square on a hull gets a silhouette over it. **The wire never says which of the three a
square is** — the client is drawing three independent things that happen to overlap, which is
`planning/03 §6`'s "read the shape" surviving contact with a fog of war.

## Consequences

**Good.**

- The map becomes a thing to be *won*, which is what the pitch always claimed. Scouting is now
  a reason to move, terrain knowledge is asymmetric, and a team that has mapped a warren has
  something its opponent does not.
- The seed leak is closed structurally rather than by policy. The shape a connection can send
  has no field for it.
- The faint band is a real skill expression, and it is the cheapest one in the game to teach: a
  dim square is visibly dim from the instant it appears.
- Bandwidth got *better*, not worse, for the steady state. Because charted squares are never
  re-sent, the transient list is the frontier of discovery plus hull squares — a thin edge
  rather than every wall in imaging range.
- Spectating and playing are now genuinely different views of the same match, which makes the
  Reveal player (`08 §8`) more interesting rather than less.

**Costs, accepted.**

- **A 1 m picture at 10 Hz is in tension with the 8 KB/s budget** (`02 §6`), and the tension is
  not fully resolved. It is held down by four things: charted squares are sent once; the
  transient set is capped at `maxWireVisionCells`; cell ids are delta-encoded ascending, which
  turns eight-digit numbers into one-digit ones; and excess is quantized to half a decibel.
  What has *not* happened is a measurement under a real engagement. `bench-bandwidth` (`13 §9`)
  is the thing that will argue with the cap, and it is not built.
- **The opening screen is dark, and measurement says darker than expected.** Deployment berths
  boats stopped, and a stopped boat lights almost nothing — "going quiet makes you blind as
  well as hidden" (`03 §5`) is the model, not a bug in it. But `03 §9.1`, measured after this
  landed, found imaging range is 89–565 m rather than the `maxImagingRange` of 1200 m (a
  reflection pays transmission loss twice), and that **a teammate 500 m away collapses it to
  ~55 m for every hull at every speed**. Verified live: two Heavies berthed a few hundred
  metres apart charted nothing at all. The mechanic is sound and the tuning is not yet, and the
  tuning is deliberately left alone here — the levers that would fix it also move the passive
  detection ranges, which are currently right. It needs the balance harness (`03 §11`).

  Until the movement phase lands there is also no way for a player to fix it from inside the
  game, because there is no throttle to push. That gap belongs to M1's kinematics, not here.
- **The chart is a client-side structure that can drift.** Today the `view` channel is a
  reliable ordered WebSocket and a sent frame is a delivered frame, so the per-recipient
  watermark advances on send. When the baseline-ack scheme (`02 §3.4`) lands it must advance on
  the *ack* instead, or an unreliable `view` channel will silently lose chart squares that are
  never re-sent. The seam is one line in `MatchRuntime.visionFor` and it is marked.
- **A revealed contact discloses hull class**, which `03 §7` wanted to be a fallible tracker
  judgement. Today confirmation reveals the silhouette outright. That is deliberate — the
  silhouette *is* the recognition skill (`03 §6`) — but it means the classification layer, when
  it arrives, has to be inserted underneath a mechanic that already assumes certainty.
- The transient layer is thousands of rectangles a frame and is the one part of the renderer
  with a real per-frame budget. It is banded into eight alpha groups and redrawn on a 50 ms
  throttle rather than at display refresh. Unvalidated on integrated graphics (Q43).

**Neutral.**

- Navigation is unaffected. The server pathfinds against ground truth as it always would have;
  the player simply cannot see what it is pathfinding through.

## Alternatives considered

**Keep C12 and rely on sonar for crispness only.** The status quo. Rejected above: it solves
the map before the match starts.

**Send the map but withhold it in the client.** Structurally the same as sending it. The
project's authority model (`01 §5`, rule 2) is explicit that the bytes must not leave the
server, precisely so that "the client hides it" is never the answer.

**Chart at a coarser resolution — 5 m or 10 m squares — to buy bandwidth.** Cheaper and much
worse. The 1 m skin is what makes a submarine silhouette recognizable at all (`03 §5.2`), and a
chart at a different resolution from the contacts drawn over it would read as two unrelated
displays. If the bandwidth work forces a compromise, the honest lever is the *cap* on how many
squares are sent, not the size of a square.

> **Amended 2026-08-08.** The square is now 2 m, named as `VISION_CELL_SIZE`
> (`sim/acoustics/skin.ts`) rather than assumed. This is not the alternative rejected above:
> the two objections there were the loss of a recognizable silhouette and a chart drawn at a
> different pitch from the contacts over it. Neither applies — the knob sets the resolution of
> the *whole* picture, chart and contacts alike, and at 2 m the thinnest hull in the game is
> still seven squares in the beam (guarded by a test in `acoustics-propagation`). Everything the
> decision above says about bandwidth still holds, with a quarter as many squares in it; the cap
> remains the lever, and `bench-bandwidth` remains unbuilt.

**Confirm terrain per-region rather than per-square** — reveal a whole contour once enough of
it is heard. Tidier data and a worse game: the ragged, partial edge of a half-heard wall is the
picture, and completing it for the player is the same mistake as drawing a dot in the middle of
a bearing wedge (`08 §4`).
