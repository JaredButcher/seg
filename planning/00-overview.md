# 00 — High Level Plan

## 1. The game in one paragraph

A browser-based, server-authoritative, slow-paced multiplayer RTS. Two teams. Each player
commands a small fleet of submarines — typically 3–5, up to 10 — brought into the match as a
saved composition. There is no production, no economy, and no reinforcement. What you spawn with
is what you have. The world is a **vertical slice of the ocean**: the map is a cross-section,
horizontal distance across and depth down, so depth is half the battlefield rather than a stat.
Maps are **procedurally generated cave systems** — dense rock threaded with chambers, passages,
and open columns, always with at least three ways through. The entire game is played through a
sonar display: you never see the world directly, only what your boats can hear, what your pings
bounce back, and what echoes to you around a corner from somewhere you cannot see. Winning is a
matter of building an acoustic picture of the map faster than the enemy builds one of you, and
shooting first without giving yourself away.

## 2. Design pillars

Every feature should be justifiable against at least one of these. Features that fight a
pillar get cut.

### P1 — Information is the resource
Fixed ships and unlimited torpedoes mean the scarce commodity is *knowledge*. Position,
course, class, and depth of the enemy are the things players spend effort to acquire and
effort to deny. Every mechanic should be readable as "this trades noise for information" or
"this trades information for safety."

### P2 — Every action has an acoustic price
Speed makes noise. Pinging makes noise and hands the enemy a bearing. Firing makes noise.
Even a torpedo in the water is a beacon pointing at where it came from. There should be no
free action of consequence.

### P3 — The display is the game
The sonar scope is not a UI skin over a top-down shooter — it *is* the fog of war, and the
server never sends the client anything the player's boats haven't sensed. Uncertainty is
rendered honestly: smeared bearings, stale contacts fading, ghost returns.

### P4 — Slow is deliberate, not idle
Engagements unfold over minutes. Low APM, high decision weight. A player should be able to
think, but never be bored — the map should always contain a decision worth making.

### P5 — Legible complexity
Deep systems, shallow interface. A new player commands 3 boats and understands "loud = seen."
An experienced player is doing target motion analysis off bearing rate and layer depth.

### P6 — Terrain is the map, not the backdrop
Maps are dense cave systems, and rock decides more than any stat does. It blocks sound, gates
which hulls can go where, provides the only reliable escape, and bends bearings so a contact
appears in a doorway rather than where it is. A player's mental model should be *routes through
rock*, not *positions in water*. Every map has at least three ways through at every point, so
there is never one line to hold — and never one line to push.

### P7 — Depth is a place, not a number
Because the map is a cross-section, every depth mechanic is geometry the player can see: the
thermocline is a line across the screen, crush depth is a line near the seabed, a terrain shadow
is a shape. Diving is movement — a boat descends by pointing down and going, so changing depth
quickly means going fast, which means being loud. No depth mechanic should require the player to
read a number when it could be a line on the display.

## 3. Launch scope

### In scope for 1.0

| Area | Commitment |
|---|---|
| Modes | Deathmatch, Objective Capture |
| Team structure | 2 teams, 1–8 human players per team |
| Maps | Procedurally generated cave systems, mirrored for fairness, host-seeded |
| Fleet size | **3–5 submarines typical**, 1–10 supported, point-limited |
| Hull classes | 5 |
| Weapons | Torpedoes only, 6 variants |
| Modules | ~14 modules across 4 slot categories |
| Sensors | Passive sonar, active sonar, deployable sonar drones |
| Sessions | Player-created lobbies, host-configured settings, no matchmaking |
| Spectators | Supported, with host-controlled vision policy |
| Accounts | Username + password, no recovery, no email |
| Persistence | Account, saved fleet compositions, lifetime aggregate stats |
| Post-match | Results screen with per-player and per-boat statistics |
| Transport | WebSocket + JSON, behind an abstraction that routes per channel and is ready to add WebRTC + binary alongside it |
| Platform | Desktop browser (Chrome/Edge/Firefox/Safari, current − 1) |

### Explicitly out of scope for 1.0

Not "never" — just not at launch. Listing them protects the schedule.

- Matchmaking, ranked play, ELO, seasons
- Surface ships, aircraft, helicopters, land features beyond static terrain
- Guns, missiles, ASROC, countermeasure launchers beyond the decoy torpedo
- Campaign, PvE, and **bots** — see the note below
- Mobile / touch input, controller support
- Voice chat, friends lists, clans, party persistence
- Cosmetics, monetization, progression unlocks
- Map editor, mods, replay sharing (replay *recording* is in — see 04)
- Localization beyond English strings being externalized

**On bots specifically:** out of scope for 1.0, but the game is *designed to accept them later*.
The simulation consumes commands through a `Controller` interface that receives a `PlayerView`
rather than world state (04 §10), so a future bot must play the same half-blind game a human
does. That seam costs nothing now and is expensive to retrofit. A `ScriptedController` exists
from M1 as a **test fixture** — it drives automated tests and the Practice Range's authored
scenarios (06 §7), and it is not exposed as an opponent in the lobby.

### Non-goals (design-level, not schedule-level)

- **Not a simulator.** Acoustics are modelled to be *legible and fun*, not accurate. Where
  realism and readability conflict, readability wins.
- **Not twitchy.** No direct manual steering of a boat as the primary control scheme. Orders
  are issued and executed. [TBD: whether a "take direct control" mode exists for one boat.]
- **Not a persistent world.** Matches are self-contained. Nothing carries between them except
  saved fleet templates and vanity statistics.

## 4. Target experience

**Session length:** 12–25 minutes per match. Objective Capture should terminate faster than
Deathmatch; Deathmatch needs a hard timer plus a tiebreak (see 06).

**Player count sweet spot:** 3v3 with 3–5 boats each. That is the case everything is tuned for.
1v1 with 10 boats each must also *work* — the range exists for niche strategies and unusual
lobby settings, and the map scales to it (see 06 §4) — but it is not the case that gets the
polish budget (see 05 §6, 08 §6).

**Skill expression, in order of impact:**
1. Noise discipline — knowing when to be slow.
2. Terrain reading — knowing which route is quiet, which is fast, which your hulls can even fit
   through, and where a bearing is pointing at a doorway rather than at a boat.
3. Depth play — using the layers and the deep water to break contact and to ambush.
4. Target motion analysis — converting bearing history into a firing solution, and recognizing
   when a crossing fix is a lie because the two bearings came through different openings.
5. Screen geometry — spreading boats across routes and strata so their arcs cover each other's
   baffles and their wedges cross usefully.
6. Fleet composition — build-time decisions made against a known map, including which objectives
   your hulls can physically reach and which passages they can physically enter.

**The moment we are selling:** you have three bearing wedges from three boats over 90 seconds,
they cross deep and to the left, you fire a spread from a boat that has never pinged, and the
enemy's first indication of your existence is a torpedo already inside their baffles — and on
the results screen they watch it happen and finally understand.

## 5. Technical shape (summary — detail in 01)

- TypeScript end to end. One shared package holds the simulation, the content tables, and the
  wire schema; both server and client import it.
- Node.js authoritative server. Fixed-step simulation at **20 Hz**, with the acoustic solve and
  the network view stream both at **10 Hz** — movement and weapons need the precision, detection
  does not, and acoustics is the expensive phase (04 §1, 03 §10).
- The server **never transmits ground truth** to a playing client. Clients receive *contacts*
  and *echo returns*, which are already lossy, already stale, and already wrong in the ways the
  design wants them to be wrong. This is both the fog-of-war implementation and the entire
  anti-cheat story.
- Client is a React shell (menus, lobby, fleet builder, results) wrapping a WebGL canvas that
  renders the scope.
- The simulation is **strictly 2D in a vertical plane**: `x` is horizontal distance, `y` is
  depth. Boats and the camera translate in those two axes only; the camera never rotates. The
  simulation plane and the display plane are identical, so the scope is a direct unrotated
  projection of world coordinates. See 04 §2.

## 6. Development strategy

**Build the mechanic before the game.** The sonar model is the entire product risk. M1 is a
non-networked, non-pretty harness where two boats move through a generated cave system and one
hears the other. If that is not fun to *listen to*, no amount of lobby polish saves it.

**Map generation is part of M1, not a later content task.** Acoustics consumes the generator's
sector decomposition and navigation consumes its navmesh, so building the simulation against open
water and retrofitting caves afterwards would mean rewriting the expensive half of it. A rough
generator early beats a polished one late — which is why M1 grew from ~3 weeks to ~5.

**Order of construction:**
1. Map generation + shared sim + acoustics, headless, unit-tested. (M1)
2. Server loop + transport + one client that renders the scope ugly. (M2)
3. Content: hulls, modules, torpedoes, damage. (M3)
4. Match structure: modes, win conditions, results. (M4)
5. Meta: accounts, lobbies, fleet builder, spectator. (M5)
6. Art pass, audio pass, tuning. (M6–M7)

Full breakdown in [11-roadmap.md](11-roadmap.md).

**Testing posture:** testing is built in from M0 and planned in [13-testing.md](13-testing.md),
not bolted on at the end. The reason it earns that investment here specifically: the simulation
is pure and deterministic given `(initial state, seed, ordered command stream)`, so a test can
assert on an entire 20-minute match — and the failure modes are *silent*. A bug in transmission
loss does not crash; it quietly makes one hull class undetectable and nobody notices for weeks.
Those are exactly the bugs automated tests catch and playtesting does not.

The load-bearing layer is **scenario tests**: declarative fixtures that run the real simulation
for hundreds of ticks and assert on emergent behaviour ("a creeping Special Ops is not detected
by a cruising Attack at 800 m"). They double as executable documentation of design intent. The
determinism constraint that makes them possible costs discipline — no `Math.random()`, no
`Date.now()` inside the sim, enforced by lint — and pays for itself repeatedly.

## 7. Risk register

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Sonar-only vision is *frustrating* rather than tense — players feel blind, not clever | Fatal | Medium | M1 playable harness before anything else; be willing to add generous "assumed contact" projection and strong UI affordances for TMA |
| R2 | Slow pace reads as boring in a browser F2P context where sessions are short | High | Medium | Hard match timers; objective mode drives contact; always give the player a pending decision (see 06 §6) |
| R3 | Per-player sensor solve is O(players × entities × emitters) and does not scale | High | Medium | Spatial hashing, tiered update rates, acoustics at 10 Hz not 20 Hz, cap total entities per match (see 03 §10) |
| R4 | Nobody is in the lobby — a no-matchmaking multiplayer game with a cold start has no players | Fatal | **High** | Server browser must be excellent; guest accounts remove the signup barrier; Practice Range with authored scenarios gives a solo player *something*. Note that bots — the strongest mitigation — are out of scope for 1.0, which makes this risk sharper than it would otherwise be. The controller seam (04 §10) keeps the door open. |
| R9 | Without a lateral axis, positioning feels one-dimensional and the game reads as a tug-of-war on a line | High | **Low** (was Medium) | Largely addressed by dense cave terrain (14): three-plus routes guaranteed at every `x`, each with different clearance and exposure, so flanking becomes "take the lower warren while he watches the column." Confirm in the M1 harness, then retire. |
| R10 | Procedural maps are fair and playable but *boring* — the invariants guarantee correctness, not quality | High | Medium | Region archetypes give authored rhythm rather than uniform noise (14 §4); the seed gallery puts a hundred maps in front of a human on every generator change; M4 has a dedicated generator tuning pass. No authored-map fallback exists in the plan, which is the uncomfortable part. |
| R11 | Relayed bearings (contacts appearing at cave mouths) read as broken sensors rather than as a puzzle | Medium | Medium | Distinct visual treatment for relayed bearings, auto cross-fix refusing to fix across different portals, prototyped at M2 on the ugly renderer. Fallback: mark relayed contacts as range-only rather than showing a misleading bearing (Q41). |
| R5 | Fleet builder becomes a solved-meta trap where one composition dominates | Medium | High | Point costs tunable from a data file with no code change; ship a balance-patch pipeline from day one |
| R6 | JSON/WebSocket bandwidth blows up with 10-boat fleets and dense contact lists | Medium | Medium | Delta encoding and contact-count caps from the start; binary codec is the designed escape hatch |
| R7 | Passwords with no recovery generate support load and account loss anger | Low | High | Say it loudly at signup, twice; offer local recovery-code download [TBD] |
| R8 | Scope creep from "one more torpedo type" | Medium | High | Content tables are data-driven, so new content is cheap *after* launch. Freeze the 1.0 table at M3. |

## 8. Success criteria for 1.0

- A 3v3 match with 4 boats per player runs at a stable 20 Hz server tick with < 120 ms
  p95 command-to-acknowledgement on a single mid-tier VM.
- A new player completes signup → lobby → fleet select → match start in under 3 minutes
  without reading documentation.
- Median match duration lands in the 12–25 minute band across both modes.
- Playtesters, unprompted, describe at least one match in terms of a *deduction* they made
  ("I knew he was slow because…"). That is the pillar-1 acceptance test.
