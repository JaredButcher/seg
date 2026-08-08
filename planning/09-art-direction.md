# 09 — Art Direction

## 1. The idea in one line

**The player is looking at an instrument, not at the ocean.** Every pixel is either part of the
instrument's fixed housing, or it is a reading the instrument produced. Nothing is decorative,
and nothing appears that the equipment did not measure.

This is the constraint that makes the aesthetic cohere and it doubles as a design tool: when in
doubt about how to present something, ask what part of the instrument would show it.

## 2. The display is a cross-section

The scope is a **side-on slice of the ocean** (08 §3), not a top-down radar picture. That single
fact carries most of the visual identity, and it is a genuine advantage: the game does not look
like every other sonar game, and the layout has natural structure that a circular PPI lacks.

The composition writes itself:

```
════════════════════════════════════ surface ═══
 ▓▓▓▓▓▓        ░░░░░░░░░░░       ▓▓▓▓▓▓▓▓▓▓▓▓▓
 ▓▓▓▓  ╭───────╮  open   ╭──────╮   ▓▓▓▓▓▓▓▓▓▓
────────╯ layer ╰────────╯ column ╰─────────────
 ▓▓▓▓▓▓▓▓   ╭──╮  ░░░░░░░░  ╭────╮  ▓▓▓▓▓▓▓▓▓▓
 ▓▓ warren ─╯  ╰──╮  ░░░  ╭─╯    ╰──╮  ▓▓▓▓▓▓▓
 ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ╰───────╯ choke  ╰─▓▓▓▓▓▓▓▓▓
─ ─ ─ ─ ─ ─ crush depth (selected boat) ─ ─ ─ ─
 ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

Two systems structure the frame and they must not fight:

**Horizontal rules** — surface, layer(s), crush depth. The instrument's most important readings,
drawn full-width across rock and water alike, and a strong graphic spine.

**Rock** — most of the screen, in dense masses with an organic ragged edge. Because maps are
procedurally generated cave systems (14), terrain is no longer a profile at the bottom of an open
field; it is the dominant mass and the water is what has been carved out of it.

**Rock must read as solid, not as line-art.** The strong recommendation is a **filled silhouette
with a stroked edge** rather than glowing contours: fill in a dark, desaturated, slightly warmer
tone than the water; a thin `terrain` stroke on the boundary. This does three things at once — it
lets the eye parse open water instantly as figure against ground, it stops a warren from becoming
unreadable noise, and it keeps every glowing element on screen meaning *a sensor reading*, which
is the entire premise of §1.

**Depth is communicated by the field itself.** A vertical gradient runs from a slightly lifted,
grainier shallow band to near-black in the deep. Before anything is drawn, the player knows which
way is down and roughly how deep they are looking. Do not fight this with a flat background.

## 3. Reference language

Sonar and depth-sounder traces, oscilloscope displays, seismic and bathymetric survey plots,
submarine control-room lighting, aviation glass cockpits, analogue instrument panels. Cold,
precise, and slightly worn — this equipment has been in service for years.

The **bathymetric survey plot** is the closest single reference and it is worth studying: a
cross-section of water with a seabed profile, depth graticule up one side, and readings plotted
in the column. That is almost exactly our screen.

Deliberately **not**: sci-fi holograms, glassy translucent panels, chrome, lens flares, or any
"future UI" idiom. The fantasy is *competence with real equipment*, not spectacle.

## 4. Palette

Placeholders, to be validated against the accessibility requirements in 08 §7 before locking.

### Field
| Token | Value | Use |
|---|---|---|
| `field-void` | `#04070A` | Outside the world, page background |
| `field-shallow` | `#0A1A22` | Water near the surface |
| `field-deep` | `#050C11` | Water below the layer |
| `field-abyss` | `#02060A` | The deepest band |
| `field-grain` | ~2% luminance noise, denser near the surface | Animated grain |

The three water tones are a vertical gradient, not hard bands. Grain density falling off with
depth reinforces "the deep is quiet" — the field literally gets stiller as you go down.

### Structure (the instrument housing)
| Token | Value | Use |
|---|---|---|
| `rule-dim` | `#0E2A33` | Grid, minor graticule |
| `rule` | `#164A55` | Depth and range scale, major graticule |
| `rule-bright` | `#1F6B76` | Surface line, active bezel |
| `label` | `#4E8A94` | Fixed markings, numerals |
| `rock-fill` | `#0A1418` | Solid rock mass — the dominant screen area |
| `terrain` | `#1B4650` | Terrain edge stroke where sonar-sensed — crisp |
| `terrain-charted` | `#0F2830` | Terrain edge stroke where only charted — dim |

Rock is a **fill**, not a glow. It is the one large area of the screen that is not a reading, and
it must stay visually inert so the acoustic layer reads on top of it. If a warren ever looks
busier than the contacts in it, this palette has failed — see 08 §3 on terrain legibility.

Structure is desaturated and dim and must never compete with a reading. If the graticule is as
bright as a contact, the display has failed.

### Accents (the readings)
| Token | Value | Meaning |
|---|---|---|
| `sonar` | `#5BF08A` | A return that cleared detection and nothing more — green |
| `own` | `#3BF0C4` | Own forces — cyan-green |
| `friendly` | `#2FB8FF` | Allied player forces — blue |
| `hostile` | `#FF3B5C` | Confirmed hostile — red |
| `unknown` | `#FFC24B` | Unclassified contact — amber |
| `echo-hot` | `#EAFFFF` | Fresh active return — near-white, decaying toward `own` |
| `weapon` | `#FF7A1A` | Torpedoes in the water — orange |
| `objective` | `#B37AFF` | Capture zones — violet |
| `layer` | `#3FA0B8` | Thermocline lines — cool, distinct from every accent |
| `alert` | `#FF1F3D` | Critical alerts — the loudest thing available, used rarely |

The palette is small on purpose. Nine accents is already a lot to distinguish at low saturation
on a dark field; adding one requires justifying it against removing another. Meaning is never
carried by colour alone (08 §7).

`sonar` is the tenth, added with the uncharted picture (C21), and it earns the slot on a
distinction no other accent makes: every one of them names a thing the game has *identified*,
and this one names the state of not having identified it yet. It is green rather than a tint of
`own` because the two are on screen together constantly — a shimmer of squares over your own
fleet has to read as a different **kind** of mark, not as a brighter boat. Its brightness
carries signal excess and its opacity carries age, so a faint square is dim from the instant it
appears and a stale one is dimmer still (03 §5.3).

`layer` gets its own token because the thermocline is neither structure nor reading — it is a
known feature of the world, permanently drawn, and it must be instantly distinguishable from both
a graticule line and a contact.

## 5. Line language

Lines are the primary visual element; the game is almost entirely strokes.

| Weight | Use |
|---|---|
| 0.5–1 px, `rule-dim` | Grid, minor marks |
| 1–1.5 px, `rule` | Depth/range scales, graticule |
| 1.5–2 px, accent | Contacts, tracks, own forces |
| 2–3 px, accent + glow | Fresh returns, active weapons, alerts |

| Style | Meaning (consistent everywhere, no exceptions) |
|---|---|
| Solid | Measured now |
| Dashed | Tracker belief / inferred / stale |
| Dotted | Player annotation, and charted-but-unsensed terrain |
| Double | Objective or structural boundary |
| Long-dash with label | Layer, crush depth, test depth — world-scale horizontal references |

**Glow** is a tight bloom — a couple of pixels of falloff, not a haze. Cheap glow looks like a
toy; tight glow looks like a phosphor tube.

**Corners are rounded** consistently: 4 px small elements, 8 px panels, 16 px major frames.
Panels are stroked outlines with a near-opaque dark fill, never translucent glass.

## 6. Fixed markings

The instrument's chrome, and a large part of what sells the aesthetic. Fixed — it does not react,
animate, or move with the world.

- **Depth scale** up the left edge: ticks every 25 m, labelled every 100 m, with test and crush
  depth for the selected boat called out as bracketed marks. The most-read element on screen.
- **Range scale** across the top, relabelled on zoom, with the interval printed.
- **Surface header band** — a distinct strip above `y = 0` carrying the range scale and reading
  as the boundary of the world.
- **Corner blocks** — small stencilled bezel panels with a slow-moving readout that reinforces
  "live equipment." The functional readouts (match time, score, boat count) live in the HUD
  itself (08 §11); the corner blocks stay decorative.
- **Etched labels** in a mono face, letterspaced, uppercase, dim, like silkscreen on a bezel.
- **Bezel screws and registration marks** at frame corners. Small, subtle, and enormously
  effective at making the display read as a physical object.

**The dead space at maximum zoom-out is a design asset, not a problem** (08 §3). Above the
surface and below the seabed, fill the frame with housing: heavier bezel, the corner blocks, the
scales, panel bleed. The world sits in an instrument rather than floating in a void.

## 7. Typography

- **Primary (data, labels, numerals):** a technical monospace — JetBrains Mono, IBM Plex Mono, or
  Roboto Mono. Uppercase, generously letterspaced for labels.
- **Secondary (menus, prose, results):** a neutral grotesque — Inter or IBM Plex Sans.
- **Tabular numerals everywhere numbers change.** Non-tabular figures on a live depth readout
  jitter and immediately look cheap.
- 11 px minimum for etched marks, 14 px body minimum, scaled by the UI scale setting.
- No decorative or "futuristic" typefaces, ever.

## 8. Motion

Motion is mechanical and purposeful. Nothing eases with a bouncy curve; nothing floats.

| Element | Behaviour |
|---|---|
| Echo decay | Exponential falloff over 8–20 s, hot → accent → gone |
| Ping ring | Expands at true acoustic speed, **visibly lighting up cave walls as it passes through the geometry**. Never sped up for feel — the wait is the drama (03 §6). This is the single best moment the renderer will ever produce and it deserves disproportionate effort. |
| Contact fade | Linear over the staleness window, with a distinct step at "lost" |
| Boat motion | True position and **true pitch** — a diving boat visibly noses down. Pitch is the most expressive animation in the game and it is free, because it is simulation state. |
| Sinking wreck | Slow, heavy descent to the seabed with a settling motion. The one piece of pure drama in the renderer, and it is worth the effort. |
| Panel transitions | 120 ms, ease-out, opacity and 4 px translation only |
| Alert entry | Fast snap in (80 ms), slow fade out (400 ms) |
| Grain / scanline | Continuous, very low amplitude, never distracting |
| Sweep | **No rotating radar sweep.** Doubly wrong here: passive sonar does not sweep, and a rotating brightener is meaningless on a cross-section. It will still be requested, because it is what people picture. It is still wrong. |

## 9. Screen composition

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

- The scope dominates. Panels are thin, dark, stroked, framing rather than crowding.
- The scope is a **full-window canvas**; the HUD floats over it and blocks input beneath it
  (08 §11).
- The **depth scale overlays the scope's left edge**, and the fleet list on the right leads with
  **depth in every row** — the two depth-relevant reads stay present on opposite sides.
- The **score matchup and timer** sit top-centre; the **mini-map** (side-on, click-to-jump) in the
  bottom-right; the **chat** collapses to the bottom-left (08 §11).
- The bottom bar holds the three controls that matter most — throttle (with the cavitation mark
  at the current depth), the depth/pitch readout, and weapons. These are the pillars of the game
  and they get permanent real estate.
- Alerts stack as a dismissible column (08 §5).
- Panels collapse; the scope can go full-bleed with everything on hotkeys.

## 10. The fleet builder's look

Distinct from the scope but the same instrument family: a **technical drawing** aesthetic rather
than a live display.

- Hull **side profiles** drawn as engineering elevations with dimension lines and callouts — and
  these are the *same polygons* the sonar returns trace (03 §6) and the same shapes seen on the
  scope. Studying a hull in the builder is directly studying what you will see in battle, and
  that link should be made explicit in the UI.
- Slots as bracketed sockets arranged over the drawing at plausible physical positions —
  sensors forward and on the sail, machinery aft, weapons at the bow, hull along the pressure
  hull. In an elevation view this reads correctly, which it would not in a plan view.
- A **depth-envelope diagram** per hull: a vertical bar showing test and crush depth against a
  reference map profile, so "how much of the ocean can this boat use" is answered visually. With
  Titanium Hull toggled on, the bar visibly extends. This is the clearest possible way to
  communicate the module's value.
- Point budget as a prominent horizontal meter, turning `alert` when over.
- The detection-range readout (07 §3) as a small horizontal range plot updating live as modules
  change — the single most useful thing on the screen.

## 11. Asset production

Almost everything is procedural — lines, rings, glyphs — which keeps the art budget small and is
a real advantage of this style.

Actual assets needed:
- **Hull side-profile polygons** (5 hulls) — authored as data, serving simultaneously as sonar
  return geometry, collision shape, scope sprite, and builder artwork. One asset, four jobs.
- A small icon set (~40 glyphs): orders, modules, torpedo variants, alerts, statuses. Single
  weight, stroke-based, 24 px grid.
- **No map art at all.** Maps are generated (14), so the "asset" is the generator's tuning
  parameters and the wall-detail noise function. This is a real saving — and it relocates the
  work from an artist authoring three maps to a programmer tuning archetype parameters, reviewed
  through the seed gallery (14 §12).
- Two type families, self-hosted and subset.
- Audio: ~30 informative cues plus ambient beds (08 §9).

Shader work is where the visual budget actually goes: the depth gradient, bloom, phosphor
persistence, grain, scanline, vignette. Budget real time for a shader pass at M6 — this is what
separates "dark theme with cyan lines" from the intended look, and it cannot be faked with CSS.
Start prototyping during M2–M3 rather than waiting (11, critical path).
