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

**Win:** destroy every enemy boat. **Timer:** 20 minutes default.

The pure expression of the core mechanic, and the mode at risk of stalling — two cautious fleets
can refuse to engage, and the deep water gives them somewhere comfortable to refuse from. Three
mechanisms, in increasing order of intervention:

1. **Score on the timer.** If time expires, the team with more surviving fleet points wins. Boats
   damaged below 50% count at half value. "Hide and survive" is therefore a *losing* strategy for
   whoever is behind, forcing the trailing team to seek contact.
2. **Closing map.** From the 12-minute mark the playable area contracts **horizontally toward the
   map centre and upward from the seabed** — the deep, quiet water closes first, pushing both
   teams into the shallow, loud, cavitation-prone water where they cannot hide. Boats outside the
   boundary take escalating damage.
   With cave terrain this needs one extra rule: the closing boundary must never strand a boat
   in a pocket with no route to the remaining area. The generator's connectivity invariants make
   this checkable — validate at contraction time that every surviving boat retains a route
   inward for its hull class, and pause the contraction rather than kill someone for terrain.
3. **Tiebreak.** Equal points at expiry → the team with less total "time detected by the enemy"
   wins. A real skill measure, already tracked (04 §11), rewarding the game's central pillar.

The boundary is **drawn on the scope** as hard lines with a warning before it moves (Q11).
Surprise damage is unfair; visible closing pressure is good design.

### 2.2 Objective Capture

**Win:** first team to `N` capture points, or the most points at the timer.
**Timer:** 18 minutes default.

Three **capture zones**, placed by the generator (invariant I6, 14 §3) at deliberately different
depths and in deliberately different terrain. A typical layout:

- A **shallow zone in an Open Column**: contested, loud, cavitation-prone, no cover, no layer
  protection. Whoever holds it is seen by everyone.
- A **deep zone in a Cathedral near the seabed**: quiet and defensible, with pillars for cover,
  but out of reach for hulls without the crush depth (a Heavy simply cannot hold it — 05 §2).
- A **mid-depth zone behind a Choke**: reachable by three passages, only one of which admits a
  large hull. Approach is the whole problem.

Composition therefore determines *which objectives you can even contest*, on two independent axes
— crush depth and clearance radius. A Heavy fleet cannot take the deep zone and cannot easily
reach the choked one; a Special Ops fleet can reach everything and hold nothing under pressure.
That is a far more interesting constraint than "who gets there first," and it is the strongest
argument for the map preview in the lobby (14 §8).

Zone mechanics:
- A zone is a circle (radius ~400 m) captured by having boats inside it with no enemy boats
  inside.
- Progress scales with capturing boat count with **strongly diminishing returns** — two capture
  faster than one, five are barely better than three. Prevents "deathball onto the point."
- A held zone generates points per second.
- **Contested** (both teams present) freezes progress. The zone becomes a knife fight.
- Each zone has an **active sonar beacon** (Q10) pinging on a slow interval, illuminating
  everything nearby for both teams. Holding a zone means being seen. This is the single feature
  that makes the mode play differently from deathmatch, and in the slice the beacon's expanding
  ring is a beautiful, ominous, perfectly legible thing to watch approach.

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
| Terrain density | Standard | Sparse / Standard / Dense |
| Map symmetry | Mirrored | Mirrored / Asymmetric (Q36) |
| Layer count | 2 | 1–3 |
| Team size | 3v3 | 1v1 up to 8v8 |
| Fleet point budget | 500 | 200–1500 |
| Max boats per player | 5 | 1–10 |
| Match timer | Mode default | 10–40 min |
| Deployment time | 60 s | 0–180 s |
| Closing map (DM) | On | On / Off |
| Score target (OC) | 1000 | 500–2000 |
| Spectators allowed | On | On / Off |
| Spectator vision | Team-limited | Team-limited / God view |
| Team assignment | Manual | Manual / Auto-balance |
| Password | None | Optional lobby password |
| Visibility | Public | Public (in browser) / Unlisted (code only) |

**Note the boat cap default is 5, not 10.** The supported range is 1–10 (05 §6) but the expected
experience is 3–5, and the default should reflect the game we are actually tuning. A host who
wants a 10-boat swarm lobby raises it deliberately, which is exactly the "unusual lobby settings"
use case the range exists for.

Friendly fire is **not** a setting — it is structural to the acoustic model and a toggle would
break decoy logic (Q26).

## 4. Map scaling

Total boat count varies from 2 (a 1v1 with one boat each) to 160 (an 8v8 with ten each). Map
extents are a **generation parameter** rather than a post-hoc scale factor — see 14 §9 for the
formula.

**Width scales more than depth**, because the depth axis is calibrated against fixed things —
hull crush depths, layer positions, cavitation curves — that do not scale. A large match is a
*longer* cave system, not a deeper one.

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
4. **The clock and the closing map** are the blunt instruments, used late.

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
