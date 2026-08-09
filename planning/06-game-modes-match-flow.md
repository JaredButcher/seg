# 06 — Game Modes & Match Flow

## 1. Match lifecycle

```
Lobby ──► Fleet Lock ──► Loading ──► Deployment ──► Active ──► Resolution ──► Results
```

| Phase | Duration | What happens |
|---|---|---|
| **Lobby** | Untimed | Host configures; players pick teams and fleets; ready up |
| **Fleet Lock** | ~10 s | Server validates every fleet against the budget. Invalid → back to lobby with a specific error. This is the anti-cheat gate. |
| **Loading** | Until all clients ready, 30 s timeout | Client fetches map data, warms the renderer |
| **Deployment** | 60 s, host-configurable, skippable when all ready | Players place boats within their team's deployment zone, **at a chosen depth**, and set initial speed and standing orders. Acoustics are off — nobody can sense anyone. |
| **Active** | Until win condition or timer | The match |
| **Resolution** | ~5 s | Sim stops; ground truth revealed to all clients for the reveal flourish (§6) |
| **Results** | Untimed | Statistics screen; rematch / return to lobby |

**Deployment matters more in a vertical slice than it would top-down.** A deployment zone is a
vertical band, so placement is a choice of *depth* as much as position: do you start deep and
quiet but far from the objective, shallow and fast, or split your fleet across strata? With
sonar-only vision your starting arrangement determines your opening picture.

With cave terrain it becomes a **route commitment** as well. Each deployment zone touches at least
three distinct routes (invariant I3, 14 §3), and where a boat starts largely determines which
route it takes — and route choice is difficult to reverse once a boat is committed to a passage
(04 §5). Deployment is therefore the match's first real strategic decision, made with full
knowledge of the terrain and none of the enemy.

## 2. Modes

### 2.1 Deathmatch

**Win:** destroy every enemy boat. **Timer:** 30 minutes — fixed for 1.0, not configurable.

The pure expression of the core mechanic, and the mode at risk of stalling — two cautious fleets
can refuse to engage, and the deep water gives them somewhere comfortable to refuse from. Two
mechanisms, in increasing order of intervention:

1. **Score on the timer.** If time expires, the team with more surviving fleet points wins. Boats
   damaged below 50% count at half value. "Hide and survive" is therefore a *losing* strategy for
   whoever is behind, forcing the trailing team to seek contact.
2. **Tiebreak.** Equal points at expiry → the team with less total "time detected by the enemy"
   wins. A real skill measure, already tracked (04 §11), rewarding the game's central pillar.

A **closing map was considered and rejected** (Q11): score-on-timer already makes hiding a losing
strategy, and a contracting boundary on a procedural cave map risks stranding a boat in a pocket
through no fault of its own. Pressure comes from the clock, not from the walls.

### 2.2 Objective Capture

**Win:** first team to `N` capture points, or the most points at the timer.
**Timer:** 30 minutes — fixed for 1.0, not configurable.

Up to three **capture zones** on the board at once, each a circle of **200 m radius** placed at
random in the **middle third of the map**, never overlapping terrain and never overlapping each
other. Both teams see all three from the first tick, on the scope and on the mini-map, *whether
or not the water they sit in has been charted* — an objective is the one thing on a player's
screen their fleet did not earn, and that is the point of the mode: the enemy must come to known
places, so the game becomes about *how* you approach rather than *whether* you can find anyone.

Zone mechanics:
- A zone is captured by having a boat inside it, with no enemy boat inside, for **30 seconds**.
  The circle blends steadily toward the capturing side's colour as the count runs, so its state
  is readable at a glance from across the map.
- **Progress does not scale with boat count.** Ten boats capture exactly as fast as one. A
  deathball buys survivability on the point and nothing else — the strongest possible form of
  the diminishing returns an earlier draft asked for, and one fewer number to tune.
- **Leaving loses everything.** The moment the capturing team's last boat is outside the circle,
  progress resets to zero. Twenty-nine seconds is worth exactly what none is.
- **Contested** (both teams inside) *freezes* progress rather than draining it. An interloper
  cannot undo the work by arriving — they have to stay, or kill. The zone becomes a knife fight.
- A completed capture is worth **one point**. The zone then disappears, and a replacement spawns
  at a different random empty location in the middle third — **grey and untakeable for 60
  seconds** after appearing, so a team that just captured cannot simply capture again where they
  stand. The score target is single figures accordingly (§3).

Three bounds keep random placement honest.

- **The middle third of the width** makes it fair. Deployment bands are the outer 12% of each end
  (§1), so confining every objective to the centre keeps the travel cost symmetric whatever the
  generator did, without anyone hand-placing anything.
- **A ceiling of 800 m depth** keeps it contestable. Game depth is 1000 m and the deepest a boat
  can be built to go is 860 m (05 §2, with a pressure hull), so a zone on the seabed would be one
  nobody could reach at all.
- **At most one objective below 600 m** keeps the depth tax a question rather than a verdict.
  Every *base* hull crushes between 580 and 680 m, so a deep zone is takeable only by a fleet that
  paid for pressure hulls — the composition axis this mode wants, arrived at through the depth
  limit rather than through hand-placement. One of those is a real decision, because there are two
  other objectives to have instead. Two at once would mean a side that brought no deep hulls is
  playing for one objective in three, which is a match decided in the lobby.

**A spawn that cannot satisfy all of that does not happen.** There is no fallback position and no
relaxation: the slot stays empty, and is tried again the next time an objective is captured —
which is the only event that can make a position legal that was not, since the terrain and the
band do not move and the two constraints that *can* free one are the standing zones' separation
and the deep quota. A match can therefore run with two objectives, or one, or none. That is the
honest outcome; the alternative is a circle somewhere the rules said it must not be.

**Still to come.** Two things this mode was specified with and does not yet have:

- **Placement by region** (invariant I6, 14 §3) — a shallow zone in an Open Column, a deep one in
  a Cathedral below a Heavy's crush depth, a mid-depth one behind a Choke that only a small hull
  can reach. That is what would make *composition* decide which objectives you can even contest,
  on the two independent axes of crush depth and clearance radius, and it is the strongest
  argument for the map preview in the lobby (14 §8). Random placement in open water is fair and
  legible; it is not yet that.
- **The active sonar beacon** (Q10) — a slow pulse from each zone illuminating everything nearby
  for both sides, so that holding a zone means being seen. In the slice its expanding ring is a
  beautiful, ominous, perfectly legible thing to watch approach.

**This is the better mode for this game** and should be the lobby default and the first mode a
new player sees. It solves the discovery problem structurally: the enemy must come to known
places, so the game becomes about *how* you approach rather than *whether* you can find anyone.

Mines around a zone are extremely strong, especially as a vertical curtain across the approach
(04 §7). That is intended — area denial is the counter to a deathball — but it needs watching in
playtest, and mine cost is the lever.

## 3. Host-configurable settings

Defaults chosen so a host can press Start immediately.

| Setting | Default | Range / options |
|---|---|---|
| Mode | Objective Capture | Deathmatch, Objective Capture |
| Map seed | Random | Editable and shareable; re-roll regenerates the preview (14 §8) |
| Map type | Dense | Empty / Sparse / Dense (14 §1.1) |
| Map size | Medium | Small / Medium / Large (14 §1.2) |
| Map symmetry | Mirrored | Mirrored / Asymmetric (Q36) |
| Layer count | 2 | 1–3 |
| Team size | 3v3 | 1v1 up to 8v8 |
| Fleet point budget | 500 | 200–1500 |
| Max boats per player | 5 | 1–10 |
| Deployment time | 60 s | 0–180 s |
| Score target (OC) | 10 | 5–20 |
| Spectators allowed | On | On / Off |
| Spectator vision | Team-limited | Team-limited / God view |
| Team assignment | Manual | Manual / Auto-balance |
| Password | None | Optional lobby password |
| Visibility | Public | Public (in browser) / Unlisted (code only) |

**Note the boat cap default is 5, not 10.** The supported range is 1–10 (05 §6) but the expected
experience is 3–5, and the default should reflect the game we are actually tuning. A host who
wants a 10-boat swarm lobby raises it deliberately, which is exactly the "unusual lobby settings"
use case the range exists for.

**The match timer is fixed at 30 minutes and is not host-configurable in 1.0** — there is no
timer row above. Both modes end at 30:00 unless won early (06 §2); tune the score target and
match design against that clock, not against a per-lobby slider.

Friendly fire is **not** a setting — it is structural to the acoustic model and a toggle would
break decoy logic (Q26).

## 4. Map scaling

Total boat count varies from 2 (a 1v1 with one boat each) to 160 (an 8v8 with ten each). Map
extents are a **generation parameter** rather than a post-hoc scale factor — see 14 §9 for the
formula.

Width **and height** scale with the map size, because depth is no longer the map's height (14 §1.2,
§9): it is a fixed game depth reached through each map's `depthScale`, so scaling the Y field never
changes what a given depth means for a hull. A large match is a *bigger* cave system on both axes,
and every map still tops out at the same full depth range.

The key advantage over the earlier authored-map approach: because regions are **generated to fill
the width** rather than stretched to it, there is no distortion at any scale. A Choke in a
10-boat map is physically the same size as a Choke in a 2-boat map; there are simply more regions
between the deployment zones. This resolves Q9 outright — the question of "procedural scaling
versus authored size variants" disappears when the map is procedural to begin with.

## 5. Results screen

Shown to everyone including spectators. Presentation in 08 §8.

**Panel 1 — Outcome.** Winner, mode, duration, final score, per-team surviving fleet points.

**Panel 2 — The Reveal.** The whole match replayed at high speed with **full ground truth**, both
fleets visible, torpedo tracks and ping rings drawn. This is the payoff for a match spent
half-blind and it is where players learn. It is the **default view**, not a hidden tab.
Scrubbable, pausable, with a toggle overlaying "what I could see" against "what was actually
there."

The vertical slice makes this dramatically better than a top-down replay would be: the whole
engagement reads as a single diagram — who was above whom, who crossed the layer and when, which
torpedo dived and which one could not. A player watching the Reveal will understand their death
in about two seconds.

**Panel 3 — Player table.** Sortable: kills, deaths, assists, damage dealt/taken, torpedoes
fired/hit with hit rate, objective time, boats surviving.

**Panel 4 — Boat cards.** One per boat brought: class, loadout, fate (survived / killed by whom /
lost to terrain / crushed), distance travelled, its own kills and damage.

**Panel 5 — Acoustic report.** The distinctive panel, and the reason to build a results screen
rather than a scoreboard:
- **Time detected by the enemy** — total and as a percentage, per player, with a team comparison
  bar. Low is good. The headline stat.
- A **depth trace**: each of your boats' depth over the match as a small multiple, with layer
  crossings and detection events marked. This is a genuinely new and very readable chart that
  only a vertical-slice game can produce, and it tells the story of a match at a glance.
- Time spent cavitating; time spent below test depth.
- Active pings emitted, and how many enemy contacts each produced.
- Longest-held track; longest time holding a firing solution without firing.
- "First blood" — who detected whom first, and by how long.

**Awards** — cheap, meaningful callouts: *Ghost* (least time detected), *Bloodhound* (most
contacts held), *Sniper* (best hit rate, min 4 shots), *Loud* (most time cavitating), *Abyssal*
(most time below 800 m), *Own Goal* (friendly-fire damage).

**Actions:** Rematch, Return to Lobby, Save Replay, Leave.

## 6. Pacing

Risk R2 is that slow reads as boring. Tools, softest to hardest:

1. **Always a pending decision.** Standing orders (04 §5) surface as a queue of attention-worthy
   items — "Boat 3 reached its waypoint," "Boat 5 has held this track for 40 s and has a
   solution," "Boat 2 will cavitate at the ordered speed at this depth." There should always be
   something worth doing.
2. **Contact events are loud, in the UI sense.** New track, lost track, torpedo in the water,
   transient — audio stings and clear visual treatment. The texture of the game is *events on
   the scope*.
3. **Objectives force proximity**, which is why Objective Capture is the default.
4. **The clock** is the blunt instrument, used late.

**Anti-pattern:** filling quiet time with busywork — manual sweeps, tuning dials, minigames. The
quiet is the product. It should be *tense*, not empty, and tension comes from the player knowing
something out there might already have them.

## 7. Onboarding

Risk R4 (cold start) makes this necessary, not polish. **Bots are out of scope for 1.0**
(04 §10), which constrains what onboarding can be — it cannot lean on a competent AI opponent.

- **Practice Range.** Single-player, against **static and scripted targets** rather than an AI
  opponent: a stationary boat to detect and kill, a boat transiting a fixed route to intercept, a
  scripted opponent that runs a canned evasion when pinged. This is deliberately not a bot —
  it is a set of authored scenarios using the `ScriptedController` test fixture (04 §10), which
  already exists for testing. Teaches: throttle versus noise, the layer, the baffles, pitch and
  depth, firing a torpedo, reading an echo return.
- **Scenario list rather than a match.** Six to eight short authored scenarios beat one open
  sandbox, and they are far cheaper than an AI. Each is a single lesson with a clear success
  condition.
- **Progressive disclosure in the fleet builder.** A first-time player gets a 4-boat preset and
  can press Start without ever opening the builder.
- **In-match contextual hints**, dismissible and disabled after a few matches: "You are
  cavitating at this depth — go deeper or slow down."
- **The results screen is the teacher.** The Reveal does more for player understanding than any
  tutorial, because it answers the question the player is actually asking: *how did that happen?*

When bots arrive post-launch they slot into the Practice Range as an additional opponent type
without changing its structure — which is the point of the controller seam in 04 §10.
