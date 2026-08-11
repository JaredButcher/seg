# 08 — Client, UI & Screens

## 1. Client architecture

```
┌─ React shell ──────────────────────────────────────────────┐
│  Routing, menus, lobby, fleet builder, results, overlays    │
│  ┌─ Scope host (single <canvas>) ─────────────────────────┐ │
│  │  WebGL renderer. Owns its own RAF loop.                │ │
│  │  Reads from the view store. React never re-renders it. │ │
│  └────────────────────────────────────────────────────────┘ │
│  HUD layers (React, absolutely positioned over the canvas)  │
└─────────────────────────────────────────────────────────────┘
        ▲                        ▲
   view store (Zustand)     net client (Transport + Codec)
```

**The hard rule: React never touches the scope's render loop.** View frames land in a plain
mutable store that the renderer polls each frame. React subscribes only to slow-changing,
low-frequency slices — selected boat, throttle notch, contact list, alerts. A 10 Hz view frame
must not trigger a React render of anything on the hot path.

Why: the scope draws hundreds of glowing line segments with per-segment alpha at display
refresh. Any per-frame React involvement makes that budget impossible.

## 2. Screen inventory

| Screen | Notes |
|---|---|
| Title / Auth | Sign in, sign up (with the no-recovery warning flow, 07 §2), guest entry |
| Main Menu | Server browser, Fleet Builder, Practice Range, Profile/Stats, Settings |
| Server Browser | The load-bearing screen (07 §4) |
| Lobby | Team slots, settings panel (host-editable), fleet selection, chat, ready |
| Fleet Builder | Full-screen overlay, reachable from menu and lobby |
| Deployment | The scope, with placement UI, before acoustics start |
| Match HUD | The game |
| Results | Reveal player + statistics (06 §5) |
| Settings | Audio, video quality, keybinds, accessibility, account |

## 3. The scope — a vertical slice, not a PPI

**This is the biggest single departure from a conventional sonar game.** The display is not a
top-down radar scope with a rotating sweep; it is a **side-on cross-section of the ocean**, with
the surface across the top, the seabed across the bottom, and depth increasing downward. The
world plane and the screen plane are identical (04 §2), so the renderer is a direct, unrotated,
uniformly-scaled projection of simulation coordinates.

This is a better-looking and more distinctive display than a PPI, and it is also *more legible*:
depth relationships are read at a glance instead of inferred from numbers.

### Layers, back to front
1. **Background** — a deep field colour with a subtle vertical gradient (lighter near the
   surface, near-black in the deep) plus animated grain. The gradient alone communicates depth
   before a single line is drawn.
2. **Fixed markings** — the instrument housing. A **depth scale** up the left edge with major
   and minor graticule; a **range scale** across the top; a fine grid. These never move and never
   fade.
3. **The frame, and whatever rock has been earned** — most of the screen once a match is under
   way, and the layer that has to work hardest without stealing attention:
   - **Surface line** across the top and the **seabed** across the bottom: the two hard
     boundaries, known from the start because the size of the ocean is not a secret.
   - **The cave system**, one square metre at a time. **A player is not sent the map**
     (C21, [ADR 0002](../docs/adr/0002-uncharted-terrain.md)): what they get is a `MapChart`
     with extents, scale, and no obstacles at all. Rock appears only where their team's sonar
     confirmed it, and a confirmed square stays for the rest of the match. Drawn as filled 1 m
     squares in the `terrain` tone — a sonar reading, not a survey.
   - **A spectator's ground truth**, where the vision policy allows it, drawn in
     `terrain-charted` — the dim token. Both tones are honest about provenance: crisp means a
     team confirmed it, dim means it was simply given.
   - **Layer line(s)**: horizontal, drawn full-width across chambers and rock alike, labelled.
     A player should never be in doubt which side of the layer they are on.
   - **Objective zones** and the **map boundary**.

   **Terrain is uncharted at match start** (C21, reversing C12). Route planning still works:
   the server pathfinds against ground truth, and "no route" is already a first-class explained
   refusal (§5). What the player loses is the ability to plan against geometry they have not
   earned — which is the game. What they gain is a map worth scouting.

   *Implementation note:* the chart is append-only and drawn in sealed chunks — a chunk of
   ~2000 merged runs is tessellated once and never rebuilt — so the per-frame cost is bounded
   by the chunk size rather than by how long the match has been going
   (`client/render/sonar.ts`).
4. **Own forces** — boats as filled side-profile silhouettes at true position and true pitch,
   with a facing/velocity vector, order routes, and **baffle cones** drawn as subtle dead wedges
   astern. Drawing the baffle cone permanently teaches the mechanic passively and constantly —
   and in a side view the player can literally *see* whether one boat's cone is covered by
   another's coverage.
5. **Own weapons** — torpedoes as bright fast marks with trailing tracks and drawn search cones;
   wire-guided torpedoes drawn with a literal wire back to the firing boat.
6. **Acoustic products** — the heart of the screen:
   - **The vision picture** *(what is built — 03 §5–6)*: a pooled, per-team picture of 1 m
     squares in the `sonar` accent, brightness from signal excess, fading over ~1.4 s — cave
     walls lit by whatever is making noise near them, hulls lit by their own noise or by yours.
     Nothing is labelled; the player reads the shape.

     **The picture and the chart are separate layers, and their interaction is the mechanic**
     (03 §5.3). A square that the server confirms gets its chart rectangle in the *same frame*
     as its green flash, so the green fades and reveals rock underneath. A square that was a
     fluke has nothing under it and fades to water. A square on a hull gets a silhouette over
     it. The wire never says which of the three a square is — the client draws three
     independent things that happen to overlap.
   - **Confirmed hostile contacts**: the boat's full side-profile silhouette in `hostile`, at
     the pose it was measured at, dimming with the age of the last confirmation. Once it stops
     being re-confirmed it becomes a **hollow outline** and never moves again. Solid means
     measured now; hollow means "he was here" (§4, the line-style rule).
   - **Bearing wedges** from passive contacts *(pending — the bearing output is not built,
     03 §5.1)*: an angular sector from the detecting boat, width = bearing uncertainty, fading
     with range, **visibly clipped by terrain**. A wedge that terminates against a cave wall is
     telling the player something true and useful.
   - **Portal-origin indicators** *(pending, with the wedges)*: when a contact was heard through
     an opening rather than directly (03 §5.1), the wedge originates *at the portal* with a
     distinct marker showing it is a relayed bearing, not a direct one. This is essential and
     non-optional — a relayed bearing that renders identically to a direct one is a lie, and
     players will file it as a bug when their triangulation fails.
   - **Echo returns** *(pending with active ping — 03 §6)*: bright points and short arc segments
     where an active ping struck a hull, tracing a recognizable submarine profile, decaying over
     8–20 s from hot white-cyan through the accent colour to nothing.
   - **Ping rings**: your own expanding wavefront, a thin bright ring travelling outward through
     the water and **visibly interacting with the seabed and terrain**. The drama of waiting.
   - **Track markers**: the tracker's belief, with designation, quality ring, staleness fade.
7. **Per-boat reference lines** — for the selected boat only: its **crush depth** and **test
   depth** as horizontal lines, and the **cavitation-limited speed region** as a subtle shaded
   band. These are the three constraints the player is always managing, and in a side view they
   are all just lines on the same picture.
8. **Player annotations** — TMA lines, manual marks, drawn range circles.
9. **Post-processing** — bloom on bright elements, subtle scanlines, phosphor persistence on
   returns, vignette. A shader pass, tunable, **fully disableable** for accessibility (§7).

### Camera and aspect
Pan in x and y (drag / edge / WASD), zoom (wheel), snap-to-boat, fit-fleet, jump-to-alert. The
camera **never rotates** (Q13) and never flips.

The base map is 8000 m × 3000 m — roughly 2.7:1 — while a typical screen is 16:9. Fitting the full
map width therefore shows more vertical extent than the ocean contains.

**Do not apply vertical exaggeration to fix this.** Non-uniform scale would distort every bearing
angle on screen, which breaks TMA, breaks the intuition that a wedge is a real direction, and
makes the display lie about the one thing it must be honest about. Instead: keep uniform scale,
accept dead space above the surface and below the seabed at maximum zoom-out, and **use that
dead space for the instrument** — the fixed markings, the corner blocks, panel bleed. The
strategic view then fits the whole world on one screen with the housing framing it, and tactical
work happens zoomed in. This is a feature, not a compromise.

### Performance budget
60 fps at 1440p with ~800 active line segments, ~400 decaying echo points, **several thousand
static terrain edges**, and the post-process chain. Techniques: terrain in a static buffer built
once at match start and never re-tessellated (charted/sensed state is a per-edge attribute);
dynamic lines batched into one buffer updated per frame; echo points as instanced quads with age
in a vertex attribute so decay is computed on the GPU with zero per-point CPU work; fixed markings
static, redrawn only on zoom change.

### Terrain legibility — the biggest visual risk
A dense warren rendered in glowing lines is unreadable noise, and the acoustic layer has to stay
readable *on top of it*. Terrain must sit clearly behind everything else in the visual hierarchy:
dimmer, cooler, thinner, and **not glowing** (09 §4 has dedicated `terrain` tokens for exactly
this). Consider rendering terrain as a filled silhouette with a stroked edge rather than as
line-art, so rock reads as solid mass and the eye stops trying to parse it.

Validate this early with a genuinely dense generated map, not a sparse test case. This is the most
likely place the art direction fails, and it fails quietly — a build that looks great on a
Cathedral seed and is unplayable on a Warren seed.

## 4. Reading uncertainty — the central UI problem

Everything the player knows is uncertain, and conveying uncertainty without visual mush is the
hardest design work in the client.

**Principles:**
- **Uncertainty has a shape, not a label.** A wide bearing wedge *is* the error bar. Draw the 8°;
  do not print "±8°" as the primary signal.
- **Age is fade and desaturation**, consistently, everywhere, without exception. If it is dim, it
  is old. This one rule does most of the work.
- **Confirmed versus inferred is a line-style distinction.** Solid = measured this instant.
  Dashed = tracker belief. Dotted = player annotation. An inference must never render like a
  measurement.
- **Never draw a position the player has not earned.** A passive-only contact has no position and
  gets no marker — only a wedge. A helpful dot in the middle of the wedge would quietly destroy
  the game.

**The TMA tool** turns bearing-only contacts into firing solutions and deserves to be
first-class:
- Select a track → its bearing history draws as a fan of historical lines from the (moving)
  observing boat.
- The player drags a proposed target course, speed, **and depth**; the tool draws the bearing
  history that solution *would* have produced against the actual history. Matching them is the
  puzzle — a direct translation of real TMA, and genuinely fun.
- A deliberately coarse goodness-of-fit indicator.
- An accepted solution becomes a dashed estimated-position marker usable for firing — and it can
  be **wrong**, which is the point.
- Two or more boats holding the same track → the wedge intersection is highlighted automatically.
  Automatic cross-fixes are fine; automatic single-observer solutions are not (Q3).

**The vertical slice helps here more than anywhere else.** A bearing wedge in a side view carries
depth information implicitly (03 §2) — a contact at −40° is *deep*, and the player sees that
without computing it. Two crossing wedges give a full position, including depth, in one glance.

**Cave terrain then makes it hard again, in the right way — when bearings exist.** Today there
is no bearing layer: the vision picture is positional, so there is no wedge and no relayed
bearing (03 §5.1). The plan below is the design for when the bearing output lands (with the
contact/tracker layer), and it is the reason the misdirection mechanic is worth keeping:

A contact heard through a passage produces a bearing to the passage mouth, not to the boat
(03 §5.1), so two observers hearing through different openings get wedges that cross where
nothing is. The TMA tool must handle this explicitly:
- Relayed bearings are visually distinct from direct ones, always (§3, layer 6).
- Selecting a relayed bearing highlights the portal it came through and the volume beyond it —
  turning "the target is somewhere past that opening" into a drawn region rather than an
  inference the player has to hold in their head.
- The auto cross-fix must **refuse to fix** two bearings relayed through different portals, and
  say why. A confident wrong answer here is far worse than no answer.

This is the highest-risk piece of UI in the project: handled well it is the game's most
distinctive puzzle, handled badly it reads as broken sensors. Prototype it at M2 with the ugly
renderer, not at M5 with the pretty one.

## 5. Command interface

**Selection:** click a boat, drag a box, number keys 1–10, `Tab` to cycle, double-tap to focus.
*Built:* clicking a boat, clicking its fleet row, and the number keys 1–10 — three ways to the
one command, which is the point rather than duplication: the row is how you pick a boat you are
not looking at, the hull is how you pick the one you are, and the key is how you do either
without the mouse. Each takes the camera with it, except a click on the hull (the boat is
already under the cursor) and a keypress made while the pointer is mid-drag on the scope, where
the selection lands and the camera is left where the player's hand put it. A click on the scope
picks the boat under it if there is one — own boats only, and no wrecks, since neither takes an
order — and otherwise means the movement order below; the pick tolerance is a few screen pixels
around the drawn silhouette, so it holds at every zoom. *Not built:* box drag, `Tab` to cycle,
double-tap to focus, and multi-select of every kind.

**Postures:** `Q` switches the selected boat's **active sonar** on or off, and each fleet row
carries the same switch as a button (03 §3, ADR 0003). It is a command with the shape the
movement orders below take: it names a boat, it is idempotent, it gets no acknowledgement, and
the view frame the player is already receiving is what tells them it worked.

**Ordering:** with a boat selected —
- **Left-click** on the scope: transit to that **point** — an `(x, depth)` position, so a single
  click sets both destination and depth. **Shift + left-click** queues a waypoint onto the same
  route. **Right-click** cancels the boat's orders and stops it. A pointer travel longer than a
  4 px slop turns the click into a camera pan, so a small tremor does not issue an order.
- The **planned route is drawn immediately** as the boat's plan line — a polyline through its
  waypoints, dotted at each one, under the boats layer. The route is owned by the **server**: the
  client only asks (a `queue` flag appends a leg), and the next view frame carrying the transit
  order is the receipt — there is no ack message. Today the line is straight; once navigation
  exists (04 §5.1) it is the pathfind through the cave system for that hull's clearance, and with
  multi-select each boat gets its own route and the divergence is visible — the moment a player
  learns their Heavy is taking the long way.
- **"No route" is not yet a visible refusal** (pending navigation): routes are never evaluated
  against terrain, so an order straight through rock is obeyed, not refused. The design stands —
  with per-hull clearance this case is common, not exotic, and silent failure would be maddening.
- The **throttle notch** is set per boat from the fleet list (§11) — three absolute notches,
  **SLOW** (5 kt), **FULL** (one knot under the cavitation threshold), **FLANK** (max speed).
  The bottom-bar throttle control with the **cavitation threshold marked at the boat's current
  depth**, moving as the boat's depth changes, is still to come (§11, 09 §9). That control is
  where pillar P2 lives and it deserves prominent, permanent real estate.
- A **depth-and-pitch readout** rather than a depth slider: since depth is now set by clicking in
  the world, the panel shows current depth, ordered depth, current pitch, and the distance to
  test and crush depth. Plus the two standing orders that need dedicated buttons: **Hug Layer**
  and **Follow Bottom** (04 §5).
- Standing-order menu via a radial or panel.
- Weapon panel: tube status (loaded / reloading with timer), variant per tube, firing solution
  source, enable-point setting, fire.

**Firing** is a two-step commit: designate a solution (a track, a bearing, or a point), review the
projected run **including its depth profile and its turning circle**, then fire. No accidental
launches — a launch is loud and consequential and the UI should make it feel like one. The
projected-run preview is more informative here than it could be top-down: the player can see the
arc the weapon has to fly to get onto the solution and the circle it will be stuck with once it
does. It is *not* a reachability check against a pitch limit — torpedoes have none (05 §4), so
depth is never on its own the thing that puts a target out of reach.

**Fleet list** down the right edge (§11): one row per boat in **fixed fleet order** — name, class,
HP, **depth**, throttle notch, test/crush proximity, cavitation state, per-tube status (loaded
variant and reload countdown), an alert badge, and a current-order summary. Depth belongs in the
row — it is the fastest way to read fleet posture at a glance. Colour-coded status; a click
selects the boat and snaps the camera to it. The **throttle notch is set from the row** — a
SLOW / FULL / FLANK button group per boat (§5). At 3–5 boats it is a readout; at 6–10 it becomes
the command surface (§6).

**Alerts** appear as a stack of dismissible items with jump-to: torpedo in the water, new contact,
contact lost, cavitating, approaching crush depth, hull stress, waypoint reached, tube loaded,
wire severed, terrain proximity. Alert design must be ruthless — an alert that fires constantly
gets ignored, taking the important ones with it. Every alert type needs an on/off in settings.

## 6. Fleet-size scaling: 3–5 typical, 1–10 supported

The interface must serve the common case well and the extremes acceptably. Per 05 §6, **3–5 boats
is the design target** and effort should be allocated accordingly.

**At 3–5 boats (the target):** the scope is the primary interface. Every boat is visible on
screen most of the time, individual attention is affordable, and the fleet list is a status
readout rather than a control surface. Tune everything here: default zoom levels should frame
3–5 boats comfortably, selection ergonomics should assume this count, and the alert volume should
be calibrated so a 4-boat fleet produces a manageable stream.

**At 1–2 boats:** must feel deliberate, not degraded. A single boat gets a closer default zoom
and more per-boat detail — richer tube status, a bigger TMA panel. The player has attention to
spare, so give them more to look at.

**At 6–10 boats:** must be playable, and does not need to be the smoothest experience in the
game. The load-bearing features are:
- **Standing orders** (04 §5) so repeated actions do not need repeating. "Hug Layer" and "Follow
  Bottom" carry most of the vertical management by themselves.
- **Multi-select orders** — "all creep," "all to 400 m," "all clear baffles."
- **Formations** — station-keeping presets (line abreast, stacked at staggered depths, trail).
  A **depth-staggered formation** is uniquely valuable here: it covers multiple strata and gives
  overlapping wedges that triangulate well. This is the highest-value quality-of-life feature in
  the game at high boat counts, and it should be prototyped early rather than treated as polish.
- The **fleet list becomes the primary interface**, and it must be complete enough to command
  from without touching the scope.

**Validate at M4** with a 10-boat lobby. If it is unmanageable, the honest fix is lowering the
cap or improving formations — not adding automation that plays the game for the player.

## 7. Accessibility

The chosen aesthetic — thin neon lines on a dark field, colour-coded, with bloom and scanlines —
is one of the least accessible visual styles available. Address it by design, not by apology.

- **Never encode meaning in colour alone.** Friend/foe/neutral differ in shape and line style as
  well as hue. Contact quality is ring thickness as well as brightness.
- **High-contrast mode**: post-processing off, heavier line weights, no glow, pure black field,
  higher-luminance palette.
- **Colourblind palettes**: deuteranopia, protanopia, tritanopia variants, validated against the
  friend/foe/torpedo/objective/terrain distinctions specifically.
- **Motion and effects**: independent toggles for bloom, scanlines, persistence, grain, and
  screen shake. Respect `prefers-reduced-motion` by default.
- **UI scale** 80–150%; 14 px body minimum at 100%; no text baked into textures.
- **Full keyboard access** for all menus; every in-match action reachable without a mouse where
  sensible; fully remappable keys.
- **Audio is informative, not decorative** (§9) — every audio cue has a visual counterpart,
  because the game must be fully playable with sound off.

## 8. Results screen presentation

Per 06 §5. Client specifics:

- **The Reveal is a first-class player**: full transport controls (play/pause, scrub, 0.25×–8×),
  a timeline with event markers (kills, launches, pings, captures, layer crossings), and a
  perspective toggle — Ground Truth / My Picture / Their Picture — using the **same renderer as
  the live scope**. Building the results view on the live renderer is what makes this affordable.
- The **depth trace** small-multiples chart (06 §5) is the signature statistic visual: one line
  per boat, depth on the y-axis matching the scope's orientation, layer depths drawn as
  horizontal rules, detection events and kills marked. It reads as a story and it is unique to
  this game's geometry. Follow the project's data-viz conventions; no chart that needs a legend
  to be understood.
- The Acoustic Report's headline — time detected by the enemy — gets the largest treatment on the
  screen, because it is the number that teaches the game.

## 9. Audio direction

Audio is a sensor, not a soundtrack. It carries real information and is part of the sonar model's
output.

- **Passive audio**: a continuous ambient bed whose character shifts with your contact picture.
  Loud contacts produce audible signatures **panned by relative bearing** — and in a vertical
  slice, panning is horizontal while *pitch* (frequency) can encode whether a contact is above or
  below you. That mapping is intuitive and free, and it means a player can sense the vertical
  situation by ear. Worth prototyping early.
- **Transients get distinct, sharp cues**: torpedo launch, hull damage, cavitation onset (a
  rising, unpleasant hiss that should feel like exposure), hull stress groaning near crush depth,
  bottoming.
- **Your own active ping** is the signature sound of the game: the outgoing pulse, silence, then
  returns arriving as discrete pips at their true delays — including the seabed return, which
  arrives on a schedule the player learns to expect. Worth disproportionate effort.
- **UI sounds** are sparse, mechanical, quiet. Switches and relays, not synthesized blips.
- Music: minimal to none during a match. Ambient tension only. Silence is the point.
- Mix: separate sliders for master, sonar/informative, transients, UI, ambient. Informative audio
  must stay audible when everything else is turned down.

## 10. Client performance and quality settings

| Setting | Options | Affects |
|---|---|---|
| Post-processing | Off / Low / Full | Bloom, scanlines, persistence |
| Echo persistence detail | Reduced / Full | Max simultaneous decaying echo points |
| Render scale | 50–100% | Canvas resolution vs display |
| Frame cap | 30 / 60 / 120 / Uncapped | |
| Trail length | Short / Normal / Long | Torpedo and boat track history |

Auto-detect on first run with a conservative default. "Runs in a browser" implies "runs on a
laptop," so integrated graphics is a first-class target, not a fallback.

## 11. The assembled match HUD

The scope is a **full-window canvas**; every HUD element is an absolutely-positioned layer
floating over it (§1). HUD elements **block pointer input** — the camera pans and drags across the
whole viewport, but never through a panel. The fixed instrument (depth scale up the left edge,
range scale across the top, the grid) is an overlay of the scope edge, per §3.

```
┌──────────────────────────────────────────────────────────────┐
│  ▮▮▮▮▮▯▯▯ 640 : 380  (first to 1000)              ◷ 08:24    │
│  ─────────── range scale ──────────────────────────          │
│ 0m ════════════════════ surface ═══════════════   ╭────────╮ │
│100       ◣                     ◣                 │ FLEET  │ │
│200       │                   ·  ·                │▸S-01 ▾ │ │
│300 ─────────────── layer ──────────────          │ 180m   │ │
│400       ◤                      ·  ·             │▸S-02 ▾ │ │
│500       ◤                    ·                 │ 420m   │ │
│600 ─ ─ ─ ─ crush (S-01) ─ ─ ─ ─ ─ ─ ─          │▸S-03 ▮ │ │
│700        ◥                                     │ 610m   │ │
│800   ╱╲              ╱────╲                     │▸S-04 ▾ │ │
│900 ──╱  ╲────────────╱      ╲────────          │ 240m   │ │
├───────────────────────────────────────────────╰────────╯──┤
│ CHAT ▸ all · "go here"…        ▒ MINI-MAP ▒   ▒ ALERTS ▒   │
│ THROTTLE ▮▮▮▯▯▯ CREEP │ DEPTH 180m ▾4° │ TUBES ①②③④ │ FIRE │
└──────────────────────────────────────────────────────────────┘
```

The seven elements:

1. **Main viewport.** The scope itself (§3). Full-window canvas; the instrument overlays its
   edges; the HUD floats above and blocks input beneath it.
2. **Mini-map.** **Side-on, same orientation as the scope** — a tiny whole-map camera, fixed in
   the bottom-right corner. Draws what the team has **proved**: the accumulated chart, the
   surface and seabed, layer lines, objective zones, own boats, and a mark per confirmed
   contact — filled while live, hollow once it has slipped detection.

   It deliberately does **not** draw the transient green picture. A faint return is a maybe,
   and a maybe rendered at thirty metres per pixel is a lie: it would put a definite-looking
   speck on the strategic view for something the server has not committed to. The scope is
   where you read the shimmer; the mini-map is where you read what is settled. Raw sensing
   products never appear here, so it cannot leak a position the player hasn't earned.

   A click jumps the main camera to that point. Always visible; not toggleable. At tactical
   zoom it is the orientation anchor; at full zoom-out the scope already shows everything and
   the mini-map is redundant but harmless. *Implementation note:* the chart half is painted
   incrementally into a canvas that is never cleared, one pixel per newly confirmed square, so
   a hundred-thousand-square chart costs nothing per frame.
3. **Fleet list.** Right edge, above the mini-map (§5). Full per-boat status rows in fixed fleet
   order; click-to-select. Each row carries its boat's **active sonar switch**, beside the row
   rather than under it so ten boats still fit the column, pulsing at the pulse interval when it
   is on — a player has to be able to see which of their boats is shouting without reading a word.
   It also carries the per-boat **throttle buttons** for now — until the bottom control strip
   lands, this is where the throttle lives (§5).
4. **Score.** **Top-centre matchup.** Mode-aware (06 §2): Objective Capture shows each team's
   points with a progress bar toward the score target; Deathmatch shows surviving fleet points
   with boat-alive tick marks so a wipe reads instantly. Under each team, a small line: boats
   alive, and the tiebreak stat (time detected by the enemy) revealed only when it can decide the
   match — DM timer expiry, or an OC tie.
5. **Timer.** **Countdown** from the match timer, beside or just below the score. Neutral until
   the last five minutes, amber to the last minute, red with a subtle tick for the final minute;
   the last ten seconds count in tenths. There is **no closing-map marker — there is no closing
   map** (06 §2.1).
6. **Chat.** Bottom-left, **collapsed to the last line by default**, expanding on click or Enter.
   **Team** (default) and **all** channels. Free text plus **scope-bound quick pings** — "contact
   at X,Y(D)", "go here", "listen here", "objective: N" — which render as markers on the scope
   *and* as chat entries, so the two channels reinforce. Unread all-chat dims until opened.
   Spectators read team/all but cannot type; a separate spectator-only channel exists for
   observers.
7. **Esc window.** A thin overlay, **not a pause** — in a live match the simulation keeps running
   on standing orders while it is open; in the single-player Practice Range it pauses the
   scenario. Contents: **Resume, Settings, Controls, Leave**. No surrender or concede in 1.0.
   Leaving keeps your boats on their standing orders until the match ends, and you can reconnect
   within the 90 s window (01 §7).

The bottom bar (throttle with the cavitation mark, depth/pitch readout, weapons) is the permanent
control strip, still to come (09 §9) — until it exists, the throttle lives in the fleet list
(§5). Panels collapse; the scope can go full-bleed with everything on hotkeys.
