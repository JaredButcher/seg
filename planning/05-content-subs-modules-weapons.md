# 05 — Content: Hulls, Modules, Weapons

> **All numbers here are first-pass placeholders for tuning.** They exist so systems can be
> built against concrete values and so the balance harness has something to chew on. Expect
> every one to move. What should *not* move without discussion is the **shape** of each class —
> its role and its trade-off.
>
> Ranges and speeds are sized for the vertical-slice world: an **8000 m × 3000 m** base map with
> detection ranges of 350 m–3.5 km (03 §9). Everything is roughly a third of what a top-down
> design would use.

## 1. Content is data

Everything here lives in `@seg/shared/content/` as typed data:

```
content/
  hulls.ts        # hull classes, slots, side-profile silhouettes
  modules.ts      # modules and their modifiers
  torpedoes.ts    # weapon variants
  acoustics.ts    # global acoustic constants (03 §11)
  map/tuning.ts   # cave generator tuning: level heights, widths, connections (14 §4)
  index.ts        # validation + content hash
```

Requirements on this layer:
- A **content hash** computed at build time and sent in `welcome` (02 §4). Client and server must
  agree on the tables.
- **Validation at startup** (13 §4): every module references a valid slot type, every cost is
  positive, no hull exceeds its slot count, silhouette polygons are closed and correctly wound,
  crush depth exceeds test depth, no hull's crush depth exceeds the deepest map's seabed by an
  unusable margin. Fail fast and loudly.
- **No behaviour in the tables** — only data. Modules describe *modifiers*; a single resolver
  applies them. If a module needs bespoke code, that is a signal to generalize the modifier
  system, not to add a special case.

### The modifier system
```ts
type ModifierOp = 'add' | 'mul' | 'set' | 'min' | 'max';
interface Modifier { stat: StatKey; op: ModifierOp; value: number; }
```
Resolution order is fixed and documented: `set` → `add` → `mul` → `min`/`max` clamp. Stacking
must be deterministic and explainable in one sentence, because players will reverse-engineer it
and the fleet builder must show the correct final numbers.

## 2. Hull classes

**The roster is being re-derived from authored silhouettes, and the previous five-class table
has been removed rather than left standing as a stale reference.** It specified Scout 55 m /
Attack 80 m / Hunter 95 m / Heavy 130 m / Special Ops 70 m with a full stat block each; those
numbers no longer describe the hulls being drawn, and a table that disagrees with the art is
worse than no table.

What replaces it is being authored silhouette-first, in `assets/hulls/`, because the shape is
the load-bearing artifact: one polygon is simultaneously the collision shape, the surface
active-sonar rays are cast against, the scope sprite, and the fleet-builder artwork (03 §6,
09 §11). Stats hang off a hull that already has a size and a profile; the reverse produces
numbers nothing can be drawn to.

| Class | Length | Authored as | File |
|---|---|---|---|
| **Heavy** | 170 m | Ohio pattern — flat missile deck, 12 hatches, tall forward sail | `heavy-ohio.svg` |
| **Medium** | 140 m | Delta pattern — raised missile casing, 8 hatches, towed-array pod | `medium-delta.svg` |
| **Light** | 73 m | Kilo pattern — stubby teardrop hull, bow planes, no hatch row | `light-kilo.svg` |

[TBD] Class count, roles, point costs, and the full stat block. Nothing below this table has
been re-fitted to the new sizes yet.

### What survives from the old roster

These are design constraints rather than numbers, and they still hold:

**Silhouettes must stay distinguishable from a partial echo arc showing only the near side.**
This is a hard constraint, not a nicety: an active return traces the near-side upper hull and
throws the rest away (03 §6). The three authored so far are separated by features that survive
that — a flat deck against a raised casing against no casing at all, hatch counts of 12 / 8 /
none, and length ratios wide enough to read before any detail resolves. Check it by stacking
the files, which is why they are all drawn at 6 px per metre on a shared centreline.

**Clearance radius is the most strategically important stat a hull has.** Maps are dense cave
systems (14) with passages from Open down to Slot, and a hull's clearance decides *which
routes exist for it* — the navmesh is filtered per hull (04 §5.1). Fleet composition is
therefore partly a *map* decision, which is why the lobby shows a map preview before fleets
lock (14 §8). Clearance values must be set together with the generator's passage-width classes,
as one table, not two (Q42).

**Max pitch and crush depth are first-class stats**, because in a vertical slice they define how
much of the board a hull can reach and how fast it can get there. Descent rate is
`speed · sin(pitch)` (04 §5), so pitch is a mobility stat and not a flavour one.

**Size should be a weakness in more than one way.** The old Heavy was slow in three separate
senses — low top speed, shallow pitch, and forced onto indirect routes — and that triple
confinement was a better weakness than any single stat penalty. Whatever the new roster is,
keep that shape: a big hull confined to the wide, open, shallow parts of the map is confined to
the loudest and most exposed ones.

### Fleet construction rules
- Fleet point budget: **default 500**, host-configurable **200–1500** (06 §3).
- Fleet size: **1–10 boats**, with **3–5 as the expected norm**. The wide range exists for niche
  strategies and unusual lobby settings, not as the standard case — see §6 and 08 §6 for what
  that implies about where UI effort goes.
- No duplicate restriction (Q25). Fix degenerate spam with cost, not rules.
- Total fleet cost = Σ(hull + modules + per-tube torpedo costs) ≤ budget.
- Fleets are validated **server-side at match start**, never trusted from the client.
- **Fleets are chosen against a known map.** The lobby shows a preview of the generated terrain
  before fleets lock (14 §8), so "this seed is a warren, bring small hulls" is a legitimate and
  intended decision. A fleet is never rejected for being a poor fit — just punished.

## 3. Modules

Four slot categories. A module fits exactly one. Costs in fleet points.

### Sensor slots

| Module | Cost | Effect |
|---|---|---|
| Improved Hydrophones | 25 | Array gain +4 dB |
| Sonar Filtering Suite | 30 | Detection threshold −3 dB; contact quality +0.15; faster classification |
| Towed Array | 40 | Baffle arc reduced to ±10°; +5 dB array gain — **but** degrades above creep and is disabled for 20 s after a hard turn or a steep pitch change. The definitive listening boat's module, and in the slice it visibly trails and sags behind the boat. |
| Powerful Active Sonar | **35, built** | `pingLevel` +8 dB, and that one number is the whole module — a pulse 8 dB stronger is a pulse heard 8 dB further away. Range and ray count are gone from the effect: there is no ray cast (ADR 0003), and the range the +8 dB actually buys is roughly a doubling of how far *terrain* joins the chart, not the +40% against hulls this row implied (03 §9.2). |
| Rapid Ping | 20 | Active sonar cooldown −50%. **Not built, and now questionable**: the pulse interval is a fixed 1000 ms and its being fixed is what makes the switch a commitment rather than a resource to spend. Revisit only with the balance harness. |
| Classification Computer | 20 | Classification confidence +0.25; shows estimated speed at lower quality; identifies torpedo launch transients |

### Machinery slots

| Module | Cost | Effect |
|---|---|---|
| Silent Running Gear | 35 | Base source level −6 dB |
| Anechoic Coating | 30 | Target strength −5 (much harder to get an active return on) |
| Improved Reactor | 30 | Max speed +2 m/s; source level +2 dB |
| Advanced Propulsor | 40 | Cavitation speed +2 m/s at all depths — the "buy speed without noise" module, and the only way to be fast in shallow water. Expensive on purpose. |
| Control Surfaces | 20 | Turn rate +30%; **max pitch +8°**. The mobility module: steeper pitch means faster diving at the same speed. |
| Noise Isolation Mounts | 25 | Flow/speed noise contribution −25% (scales with how fast you run) |

### Hull slots

| Module | Cost | Effect |
|---|---|---|
| Armor Plating | 30 | Max HP +40%; max speed −1 m/s; target strength +2 |
| Titanium Hull | 45 | Test depth +150 m, crush depth +180 m; HP +10%. On a 1200 m map this is what unlocks the deep, fast, quiet water — a strategic module, not insurance. |
| Damage Control | 25 | Removes the post-damage noise penalty; halves the post-damage speed penalty |
| Ballast Refit | 15 | Ballast rate +80%; depth-change transient noise −50%. Lets a stopped boat reposition vertically while staying silent — the hovering ambusher's module. |

### Weapon slots

| Module | Cost | Effect |
|---|---|---|
| Extra Torpedo Tube | 35 | +1 tube |
| Rapid Loader | 30 | Reload time −25% |
| Quiet Launch System | 25 | Launch transient −12 dB (from +25 to +13). Firing without immediately advertising your position. |
| Wire Guidance Upgrade | 20 | Wire range +80%; wire survives harder manoeuvres and steeper pitch |
| Deep Launch Adapter | 15 | Allows launch below test depth; +150 m torpedo max operating depth |

### Balance intent
Module spend on a fully-fitted Hunter (8 slots) can exceed the hull cost several times over.
That is intentional: the interesting decision is not "which hull" but **"how much do I invest in
this hull versus buying another one."** A 130-point Hunter with 240 points of modules is a
scalpel; three bare Attack boats for the same 370 are a net. Both must be viable, and the balance
matrix (03 §11) is how we check.

## 4. Torpedoes

**Torpedoes are unlimited.** The constraints are tube count, reload time, and the noise of
firing. Each boat's tubes are assigned a variant **at fleet-build time** (Q6) — a real
composition decision, one less in-battle UI, and "which tube do I use" becomes tactical.

Costs are per tube, added to fleet cost. Ranges are sized for an 8000 m base map.

| Variant | Cost/tube | Speed | Range | Turn rate | Circle | Seeker | Damage | Notes |
|---|---|---|---|---|---|---|---|---|
| **Standard** | 0 | 22 m/s | 3000 m | 25 °/s | 50 m | Active, from the enable point | 100 | The baseline. Quiet enough to sneak, slow enough to evade, agile enough to follow a target that manoeuvres. |
| **Super-cavitating** | 25 | 55 m/s | 1200 m | 10 °/s | 315 m | **None** | 90 | Nearly unavoidable inside 800 m; useless as a long shot. Its circle is a quarter of its range, so **it cannot be talked out of the line it left the tube on** — that is its designed counter. Announces itself and its firing point map-wide. |
| **Active Decoy** | 15 | 12 m/s | 1000 m | 15 °/s | 46 m | — | 0 | Swims out, then emits a loud boat-like signature for 60 s. Creates a false track; seduces seekers. |
| **Active Sonar Drone** | 20 | 12 m/s | 2000 m | 20 °/s | 34 m | — | 0 | Transits to a chosen point and depth, loiters, pings on an interval for ~4 min. Illuminates an area from somewhere that is not you. |
| **Passive Sonar Drone** | 20 | 10 m/s | 2000 m | 20 °/s | 29 m | — | 0 | Silent listener at a chosen point and depth for ~6 min. The single most important tool for watching a flank — or for **listening below the layer while you stay above it**. |
| **Mine** | 10 | 8 m/s | 800 m | 20 °/s | 23 m | Proximity | 130 | Transits to a point, holds depth, waits ~10 min. Detonates on a hostile within ~80 m. Detectable by active sonar at short range. Several at staggered depths form a **vertical curtain** across a chokepoint (04 §7). |

**One envelope, and it is the turning circle.** `r = v/ω`, quoted above at cruise. This table
used to carry two pitch columns instead — a *cruise* band capping how steeply a weapon could
climb once the throttle was open, and a wider *launch* band it was allowed to point at while
creeping, which it gave back on opening the throttle. Both are gone; see "Pitch limits are not a
balance dimension" under Tuning notes. A weapon now turns onto whatever bearing it is steering at,
up, down or astern, at one rate, and how tightly it can do that is the whole of what separates the
loads' ability to follow anything.

### Status: the two torpedoes are built, the four utility loads are not

`content/weapons.ts` carries all six rows, and each one declares `deployable`. Only the two
torpedoes are true, and that flag is the single place the distinction lives — the fire path, the
in-battle tube picker, and the server's `weapon.load` all read it, so a player is never offered a
load that will not fire. The other four each need a *loitering* behaviour the run-out does not
have: pretend to be a boat, ping on a timer, listen, or wait for a proximity fuze.

Three changes to the table above were made during the build and are deliberate:

- **Torpedoes have no pitch limit**, where this table gave every load two. Removed after play
  testing: see "Pitch limits are not a balance dimension" below. The columns were replaced with
  the turn rate, which is what the removal leaves carrying the design.
- **Super-cavitating has no seeker at all**, where this table said "active only". A weapon that
  was both the fastest in the game *and* self-guiding leaves the standard torpedo with no role,
  and "unavoidable inside 800 m, useless as a long shot" describes an unguided sprint rather than
  a homing weapon. The pair now differs in kind rather than in degree: the standard torpedo's
  click is an **enable point** and the skill is putting it ahead of the target; the
  super-cavitating one's click is a pure aim point and the skill is the lead itself, at a third of
  the distance because it is three times the speed. Both demand a lead; neither is aimed at a boat.
- **Standard is active rather than "passive, switchable"**, because there is no in-battle control
  to switch it with and a passive seeker would need the tracker (03 §7) that does not exist. Its
  seeker is deaf on purpose — 95 dB against a boat's 108–124, and 20 dB of its own machinery to
  hear over, which puts acquisition at roughly 340 m. That number *is* the enable-point mechanic;
  a generous seeker would make the aim point decoration.

Both **time out and detonate** rather than fizzling (135 s and 24 s), both are audible while they
run (62 dB and 92 dB — the price of the speed), and a homing seeker's pulse is another 95 dB every
second. Reloading begins on the tick a tube fires, and a tube's *next* load is chosen in advance;
changing your mind about a weapon already loaded costs an unload and a reload. §4's wire guidance
(Q5) is not built — a weapon is committed the moment it leaves the tube.

### Tuning notes
- Standard torpedo speed (22 m/s) versus boat max speed (13–18 m/s) is a deliberately narrow
  margin. A boat that detects a torpedo early and runs *can* outlast it on fuel. Evasion should
  be a skill, not a dice roll. If playtests show torpedoes are unavoidable, lower speed before
  lowering damage.
- **Pitch limits are not a balance dimension — they were removed.** They were meant to be the
  headline one: evading vertically as a distinct skill from evading horizontally, with each
  torpedo's cruise band defining what it could chase, and a wider launch band deciding how steep
  a solution it could be *given* before giving the climb back. Play testing found it simply
  un-fun. What it actually produced was an escape hatch rather than a dimension — a target that
  swam upward beat a weapon outright, with no read, no timing and no counter-play on either side,
  and the weapon's failure looked like a bug rather than like being out-manoeuvred. It also cost
  more than it earned in the code: the cruise band, the launch band, the rule for which side of
  the vertical a near-vertical demand belonged to, and the brake-and-mirror reversal that existed
  only because a banded weapon could not rotate through the vertical, all interacting, and every
  steering bug the weapons phase ever had came out of that interaction.

  **Vertical and horizontal movement are now the same movement.** A weapon turns toward the
  bearing of what it is steering at, whatever that bearing is, at `turnRate`. Nothing is clamped
  and nothing is mirrored. Evading is one skill again, and the counter to a torpedo is to make it
  turn — a target that changes course passes through a circle the weapon cannot leave, which is
  a read and a piece of timing rather than a stat check.

  **This is a torpedo rule, not a world rule.** Submarines keep `maxPitch`: a hull is
  pitch-limited, `descentRate = speed · sin(pitch)` still governs how fast it changes depth, and
  boats still reverse by flipping (04 §5). The asymmetry is deliberate — the vertical is a
  constraint on the thing a player *steers*, and stopped being one on the thing they *shoot*.
- **The turning circle is the balance dimension it left behind.** With the band gone it is the
  only thing separating what the loads can follow, so it is where the tuning attention goes:
  50 m for the standard torpedo against 315 m for the super-cavitating one is the whole of the
  difference between a weapon that hunts and a weapon that is a bullet. Expect this to need the
  most tuning of anything in the table.
- Damage versus HP: a Standard torpedo kills a Scout outright, nearly kills an Attack, and takes
  two hits on a Heavy (three if armored). Verify in playtest.
- Mines and drones share the tube system, so a boat that loads utility gives up offense. Special
  Ops with two drone tubes is a sensor platform that cannot fight — legitimate and interesting.

## 5. Content pipeline and balance workflow

1. Designer edits a table in `@seg/shared/content/`.
2. `pnpm content:validate` — schema, cost sanity, slot arithmetic, silhouette geometry, depth
   invariants (13 §4).
3. `pnpm balance:matrix` — regenerates the detection-range matrix (03 §11) and diffs against the
   committed baseline. **The diff goes in the PR.** A content change with a surprising matrix
   diff is the cheapest balance bug to catch.
4. `pnpm replay:corpus` — replays the recorded match corpus (13 §5). Content changes will
   legitimately change outcomes; the point is that the change is *seen and acknowledged*.
5. Merge → content hash changes → clients reload on next connect.

**Freeze the 1.0 content table at M3.** After that, additions go to a post-launch list. The
data-driven pipeline makes new content cheap *later*; it is scope creep *now*.

## 6. Fleet size expectations

The supported range is 1–10 boats; the **expected range is 3–5**. This distinction should drive
effort allocation:

- **3–5 boats is the design target.** Balance, map scale, objective placement, tutorial content,
  and default presets are all tuned for it. A player at 4 boats should feel like the game was
  built for exactly that.
- **1–2 boats** is a valid niche — a duel-style lobby, or a heavily-fitted single Hunter under a
  low budget. It must work and feel deliberate, not like a degraded version of the game.
- **6–10 boats** is for unusual lobby settings and swarm strategies. It must be *playable* and
  not crash, but it does not need to be the smoothest experience in the game. Standing orders and
  formations carry it (04 §5, 08 §6).

Presets ship at 3, 4, and 5 boats. The fleet builder opens with a 4-boat preset.

## 7. Post-launch content directions (not 1.0)

Recorded so they are not re-litigated during the launch build:
- Narrowband/tonal passive detection and hull identification (03 §12).
- Convergence zones and surface ducts as advanced-map features — much more attractive now that
  ray paths are drawable in the slice.
- Countermeasure launchers as a system distinct from torpedo tubes.
- A sixth hull: a dedicated minelayer, or a deep-diving bathyscaphe-style sensor platform.
- Torpedo variants: wake-homing, bottom-crawling, a slow "swim-out" torpedo with a very late
  enable point.
- Module rarity or unlock progression — **only if** it avoids pay-to-win and grind. Default
  position: no progression, everything available to everyone, forever.
