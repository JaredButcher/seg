# 12 — Open Questions

Every `[TBD]` in the planning documents appears here. Each has a recommendation, a decision
point (the milestone by which it must close), and a note on what it blocks.

**Process:** when a question closes, update this table, update the source document, and — if the
decision reverses an earlier one or has consequences worth explaining — write a one-page ADR in
`docs/adr/`.

---

## Closed

Decisions made since the first draft. Kept here so they are not re-litigated, and because
several of them invalidated earlier open questions.

| # | Question | Decision | Consequence |
|---|---|---|---|
| C1 | Dimensionality | **Strictly 2D in a vertical plane.** `x` horizontal, `y` depth. Boats and camera translate in those axes only; the camera never rotates. | Replaced the earlier "2.5D with depth as a scalar" design. Rewrote 03, 04, 05, 06, 08, 09. Depth became geometry rather than a stat: the layer is a line, crush depth is a line, terrain shadow is a shape, and diving is movement. |
| C2 | Sim tick rate | **20 Hz sim, 10 Hz acoustics, 10 Hz network.** | Torpedo terminal geometry and collision drive the sim rate; acoustics does not benefit from 50 ms resolution and is the expensive phase. Bandwidth is unchanged from a 10 Hz design. See 04 §1. |
| C3 | Bots | **Out of scope for 1.0**, designed for. | The `Controller` interface (01 §4.5, 04 §10) and the lobby's generic occupant slot (07 §4) exist now so bots are additive later. `ScriptedController` ships as a test fixture only. Sharpens risk R4 — see Q17. |
| C4 | Expected fleet size | **3–5 typical**, 1–10 supported. | Balance, map scale, default zoom, alert volume, and presets are tuned for 3–5. The 6–10 range must be playable, not polished. Lobby default cap is 5, not 10. See 05 §6, 08 §6. |
| C5 | Testing posture | **Integrated from M0**, with scenario tests as the load-bearing layer. | New document [13-testing.md](13-testing.md). M1 now carries a substantial test deliverable. |
| C6 | Contact depth discovery (was Q4) | **Dissolved by C1.** | A bearing in a vertical plane carries depth implicitly — a contact at −40° is deep. The problem no longer exists. |
| C7 | Max team size (was Q14) | **8v8**, expecting 2v2–4v4 in practice. | Verify server cost at 16 players × 10 boats before committing; that worst case is now bounded by the 50 ms tick budget. |
| C8 | Number of launch maps (was Q15) | ~~Three authored maps.~~ **Superseded by C10** — maps are generated, so the count is unbounded. | — |
| C9 | Scope orientation (was Q13) | **Fixed. No rotation, no flipping, uniform scale.** | Reinforced by C1: the world plane and the screen plane are identical, so any transform would be a lie. Explicitly includes *no vertical exaggeration* — it would distort every bearing angle and break TMA (08 §3). |
| C10 | Map authoring | **Procedurally generated dense cave systems**, replacing three authored maps. New document [14-map-generation.md](14-map-generation.md). | Terrain became the dominant system. Retires Q9 (map scaling — extents are now a generation parameter, so there is nothing to stretch) and Q15 (map count — unbounded). Moved map generation into M1. The planned downstream consumers of the sector decomposition were deferred: acoustics consumes the **water lattice** instead (14 §6), and the navmesh is not built yet (14 §5). |
| C11 | Terrain occlusion model | **A water lattice + 1 m reflector skin, not raycasting** — supersedes the earlier decision of portal propagation over a sector graph. Sound follows the shortest geodesic through water; there is no relayed bearing. | The lattice makes dense terrain affordable at runtime with cost linear in entities, bounded by `maxRange`/`maxFieldCells` (03 §4–5, 14 §6). The sector/portal model's signature mechanic — "bearings point at cave mouths" — is not built; the misdirection it promised is parked as a future layer (03 §5.1). Retires the UI risk Q41 in its original form (see Q41). |
| C12 | Terrain knowledge (was Q12) | **Charted from match start**, drawn dim; sonar makes local geometry crisp. | Cave navigation makes route planning impossible without known geometry, and a match spent bumping into walls is not the game. What stays unknown is what is *in* the caves. |
| C13 | Hull size as a navigation constraint | **`clearanceRadius` per hull**, navmesh filtered per hull. | Size became a strategic property, not just a stealth/durability stat. A Heavy is confined to wide, open, shallow routes — the loudest parts of the map. Strongest single argument for the lobby map preview. |
| C14 | Scope renderer (was Q27) | **PixiJS v8.** | Confirmed rather than prototyped-then-chosen. The M2 performance prototype still runs (800 glowing segments + 400 instanced decaying points + several thousand static terrain edges + bloom, at 60 fps on integrated graphics) — but as a *validation with a fallback to custom shaders for hot paths*, not as a technology bake-off. |
| C15 | Database (was Q28) | **Generic SQL, SQLite first**, Postgres as the growth path. | Portability is now a build-time property rather than a promise: no ORM, a documented portable SQL subset, a thin `SqlDialect` shim for placeholders and DDL types, and **the repository suite running against both engines in CI from M5** (01 §3.1, 07 §6.1, 13 §8). |
| C16 | Frontend stack | **React + TypeScript + PixiJS**, with Zustand for state. | React owns the shell only; Pixi owns the canvas and its own RAF loop; the two never share a render path (08 §1). |
| C17 | Team vision (was Q2) | **Teammates share all vision automatically** — contacts, tracks, echo returns, revealed terrain. No intra-team fog of war, no selective sharing. | Vision becomes a property of the *team*. `PlayerView = TeamView + PlayerPrivateView`, with the expensive half computed once per team (01 §5, 03 §10). Largest constant-factor saving in the server, and it makes team-limited spectating nearly free. Bandwidth per player is unchanged. |
| C18 | Namespace | **`seg`** — packages are `@seg/shared`, `@seg/server`, `@seg/client`, `@seg/tools`. | The *game's* public name remains open (Q31) and is deliberately decoupled from the internal namespace. Renaming the product later costs nothing in code. |
| C19 | License | **MIT.** | Permissive, no copyleft obligations on contributors or on anything built against the sim. `LICENSE` lands in M0. |
| C20 | Transport model | **Both transports run at once, permanently, with routing per channel.** WebRTC is an *addition*, not a swap. `control` — handshake, auth, all lobby traffic, chat, signalling — is **pinned to the WebSocket forever**; `commands` and `view` prefer WebRTC and fall back. | Reverses the "swap WebSocket for WebRTC" framing in the first draft of 01 §4.1 and 02 §9. Adds a `Link` layer above `Transport` that owns a channel→transport routing table (01 §4.1a), makes the post-launch rollout four independently revertable steps instead of one, and introduces a new standing constraint: **no message may depend on the arrival order of a message on a different channel** (02 §3.3). Also widens the ground-truth test, which must now tap the Link rather than a socket (13 §8). See [ADR 0001](../docs/adr/0001-simultaneous-transports.md). |

## Blocking — must close during M1

| # | Question | Recommendation | Decide by | Blocks |
|---|---|---|---|---|
| Q3 | **Manual TMA only, or automated assist?** (03 §12, 08 §4) | **Manual, with excellent tools** — a strong TMA UI, automatic cross-fix highlighting when two boats hold a track, no single-observer auto-solutions. C1 makes this easier than it was: a wedge in a cross-section already implies depth, so the player gets more from less work. Only the design half matters at M1; the UI decision waits for M5. Revisit if M4 playtests show frustration. | M1 (design), M5 (UI) | UI scope, difficulty curve |
| Q32 | **Map extents and the range scale.** 8000 m × 3000 m base (medium), with a fixed 1200 m game depth, is the current constant set — and every detection and weapon range in 05 hangs off it. (03 §9) | Prototype it in the M1 harness before the content tables are written. The aspect ratio (~2.7:1) and the ratio of detection range to map width are the numbers that matter, not the absolutes. Getting this wrong makes everything downstream wrong. | M1 | All content ranges, map authoring, camera |
| Q33 | **Max pitch band.** ±25–35° per hull is asserted, untested. (04 §5) | Prototype. Too shallow and depth changes are unusably slow; too steep and boats stop reading as submarines and vertical evasion trivializes torpedoes. Tune alongside torpedo pitch limits — they are one balance problem, not two. | M1 | Movement feel, torpedo balance |
| Q41 | **Do relayed bearings read as a puzzle or as broken sensors?** (03 §5.1, 08 §4) | **Dormant.** The bearing output the question depends on is not built — the lattice reports square positions, not bearings, so there is no relayed bearing to misread (03 §5.1). The original risk (a bearing pointing at a cave mouth reading as a bug) returns the day bearings land; if the tracker layer is added, prototype the UI before shipping it, with the fallback of range-only contacts rather than a misleading bearing. | when bearings are built | TMA design, contact rendering |
| Q42 | **Passage width distribution versus hull clearance.** (05 §2, 14 §4) | The content table and the generator's tuning are now coupled — changing either can invalidate the other. Decide the width classes and the hull clearances *together*, and treat them as one table. The per-archetype balance matrix exists to keep the coupling visible. | M1 | Content table, generator tuning |

## Important — close during M2–M4

| # | Question | Recommendation | Decide by | Blocks |
|---|---|---|---|---|
| Q5 | **Wire-guided torpedoes at launch?** (04 §7) | **Yes.** The best answer to "firing on a bearing feels like a coin flip," and it converts a shot into an ongoing decision. In the slice the wire is drawable as a literal line. | M3 | Weapon UI, torpedo control |
| Q6 | **Tube loadouts fixed at build time, or swappable in battle?** (05 §4) | **Fixed at build time.** A real composition decision, one less in-battle UI, and "which tube" becomes tactical. | M3 | Fleet builder, weapon UI |
| Q7 | **IFF on torpedo seekers?** (04 §7) | **No IFF.** Friendly fire is a fair consequence of the acoustic model, and IFF would make decoys incoherent. Mitigate with a clear warning when a friendly sits in a torpedo's likely search cone. | M3 | Weapon logic, UI warnings |
| Q8 | **"Running silent" as a distinct mode, or just low speed?** (03 §8) | **Distinct mode.** More legible, gives the UI something concrete to show, makes a stealth posture a visible choice. | M3 | Movement, HUD |
| Q34 | **Bottoming — settling on the seabed?** (03 §8) | **Yes.** Near-zero source level and target strength merged into bottom clutter, at the cost of total immobility and grounding risk. Nearly free given terrain already exists, and it is a distinctly vertical-slice tactic. | M3 | Movement, acoustics, terrain |
| Q36 | **Asymmetric map option for casual lobbies?** (14 §7) | **Yes, off by default, clearly labelled.** Mirrored maps guarantee fairness exactly and are correct for competitive play; some players will prefer the character of an asymmetric cave system, and the cost is a checkbox. | M4 | Lobby settings, generator |
| Q37 | **Boat-versus-boat collision in narrow passages?** (14 §10) | **Soft separation forces, not hard collision.** In a Slot barely wider than one hull, boats passing through each other looks wrong — but hard collision risks two boats deadlocking in a corridor with no way out, which is worse. | M3 | Movement, navigation |
| Q38 | **Do mines become oppressive in Chokes?** (04 §7, 14 §13) | Watch it. A vertical curtain across a three-passage choke may be unbeatable. Levers in order of preference: raise mine cost, cap mines per fleet, increase active-sonar detection range on mines. **Do not remove the tactic** — it is one of the best things dense terrain enables. | M4 | Weapon balance |
| Q39 | **Terrain collision damage, given boats now routinely operate near walls?** (04 §5.1) | **Keep it, with a grazing threshold.** Brushing a wall at creep is harmless; hitting one at flank is not. Without a threshold, cave navigation becomes punishing rather than tense. | M1 | Movement, damage |
| Q40 | **Guarantee a minimum number of Open Column regions?** (14 §13) | **Yes — at least one Column or Cathedral per map half.** Without it a seed could be entirely tight terrain, which invalidates long-range hulls and every module that buys detection range. | M4 | Generator invariants |
| Q10 | **Objective zones have an active sonar beacon?** (06 §2.2) | **Yes.** The single feature that makes Objective Capture play differently from Deathmatch, and in a cross-section the expanding ring is a genuinely dramatic thing to watch approach. | M4 | Objective mode design |
| Q11 | **Is the closing map visible to players?** (06 §2.1) | **No closing map — removed.** Score-on-timer already makes hiding a losing strategy, and a contracting boundary on a procedural cave map could strand a boat in a pocket through no fault of its own. Pressure comes from the clock (06 §2.1). | — | Deathmatch pacing |
| Q35 | **How many layers per map?** (03 §4) | **Two by default, host-settable 1–3.** With dense terrain already providing horizontal structure, layers add the vertical banding that keeps depth meaningful. Now a generation parameter rather than an authored choice, so this is cheap to tune from playtest data. | M4 | Generator, renderer |
| Q21 | **Reconnect window length?** (01 §7) | **90 s.** Long enough for a refresh or a brief drop, short enough not to hold a match hostage. | M4 | Match host |
| Q22 | **Can a teammate adopt an abandoned player's boats?** (01 §7) | **No for 1.0.** A griefing lever and a scope addition. Boats hold their last orders. | M4 | Match host |
| Q24 | **Wreck lifetime?** (04 §8) | **Permanent for the match.** Accumulating confusion is a feature, and a hull sinking to the seabed is good drama in a side view. | M3 | Sim, tracker |
| Q25 | **Per-hull-class cap in a fleet?** (05 §2) | **No cap.** Fix degenerate spam with point cost, not rules. Revisit only if a specific build proves untunable. | M4 | Fleet validation |
| Q26 | **Keep the friendly-fire toggle at all?** (06 §3) | **Removed.** Friendly fire is structural (Q7); a toggle that breaks decoy logic is a trap for hosts. Already struck from the settings table. | M4 | Lobby settings |

## Meta and platform — close during M5–M7

| # | Question | Recommendation | Decide by | Blocks |
|---|---|---|---|---|
| Q16 | **Recovery codes for accounts?** (07 §2) | **Yes.** ~40 lines; converts risk R7 from angry users into users who ignored a warning, while preserving the no-email, no-PII posture. | M5 | Auth, signup UX |
| Q17 | **Guest accounts?** (07 §2) | **Yes**, and more urgently than before. With bots out of scope (C3), the Practice Range is weaker as a solo draw and risk R4 rests almost entirely on the server browser. Requiring signup before a player can even see whether anyone is online is a funnel loss we cannot afford. | M5 | Auth, lobby, stats |
| Q18 | **Delayed god view for spectators at launch?** (07 §5) | **Post-launch.** Requires buffering the view stream. Team-limited and god view cover 1.0. | M5 | Spectator scope |
| Q19 | **Saved fleet limit per account?** (07 §3) | **30.** Generous for players, bounded for storage and UI. | M5 | Fleet builder |
| Q20 | **Spectator cap per lobby?** (07 §5) | **16.** Each spectator costs a view stream; revisit against measured cost. | M5 | Server capacity |
| Q23 | **Replay retention period?** (07 §6) | **30 days**, with an explicit "save permanently" action on the results screen. | M5 | Storage |

## Technology selections — validate by prototype

| # | Question | Recommendation | Decide by | Validation |
|---|---|---|---|---|
| Q29 | **Fixed-point vs floating-point sim?** (01 §6) | **Floating point.** Only the server simulates, and replays run on the same architecture. Revisit only if cross-platform replay determinism is ever needed. | M1 | The determinism corpus (13 §6) |
| Q43 | **Does PixiJS hold up under dense generated terrain?** (01 §3, 08 §3) | Not a technology question any more (C14) — a budget question. Several thousand static terrain edges plus the acoustic layer plus post-processing is well beyond what the original open-water renderer had to carry. Validate on a **Warren seed**, not a sparse one, and be ready to hand-roll the terrain pass specifically while keeping Pixi for everything else. | M2 | Renderer architecture |
| Q30 | **Match hosts in worker threads at launch?** (01 §1) | **No** — single process for 1.0. The `MatchHost` seam makes it a later swap. Note the 20 Hz tick makes this more pressing than at 10 Hz. | M7 | Load test: how many concurrent matches fit in one process inside the 50 ms tick budget? |

## Naming and identity

| # | Question | Recommendation | Decide by |
|---|---|---|---|
| Q31 | **The game's public name.** | Still open, and now safely so — the internal namespace is fixed as `seg` (C18), so the product name is a marketing decision rather than a refactor. It affects the landing page, the domain, and the M6 visual identity work. | M6 |

---

## Assumptions worth challenging early

Recorded separately from the TBDs because these are *assumed* rather than deliberately deferred.
If any is wrong, better to know at M1 than at M6.

1. **Sonar-only vision is fun.** The entire product rests on this. M1 exists to test it.
2. **Dense cave terrain restores positional play** to a game with no lateral axis (risk R9). With
   three-plus routes guaranteed at every `x`, flanking becomes "take the lower warren while he
   watches the column." This is the intended fix and it should be confirmed — or refuted — in the
   M1 harness. If it fails, the remaining levers are more layers and more depth-differentiated
   objectives, **not** another axis, which would discard the entire display design.
3. **Procedural maps are good enough to play competitively.** Authored maps are a known quantity;
   generated ones are not. The invariants (14 §3) guarantee *fairness and playability*, not
   *quality*. The seed gallery and a dozen played seeds at M4 are the real test, and there is no
   authored-map fallback in the plan if generation disappoints.
3. **Slow pace is a feature**, for the target audience. Playtest early with people who are not
   already submarine enthusiasts.
4. **3–5 boats is the right target and 10 is a workable ceiling.** Validated at M4 (08 §6). If 10
   is unmanageable the honest fix is lowering the cap, not adding automation that plays for the
   player.
5. **Players will tolerate — and enjoy — being wrong** about track identity (03 §7). Ghost tracks
   and misclassification are the intended texture. If playtesters read them as bugs, the
   presentation is wrong, not the mechanic.
6. **A server browser is enough** without matchmaking at launch scale. Risk R4, and the assumption
   most likely to be wrong — now more so, since bots are out of scope (C3).
7. **The 20/10/10 rate split holds under load.** Assumed on paper; `bench-tick` at M2 is the first
   real evidence.
