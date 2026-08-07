# 05 — Content: Hulls, Modules, Weapons

> **All numbers here are first-pass placeholders for tuning.** They exist so systems can be
> built against concrete values and so the balance harness has something to chew on. Expect
> every one to move. What should *not* move without discussion is the **shape** of each class —
> its role and its trade-off.
>
> Ranges and speeds are sized for the vertical-slice world: a **5000 m × 1200 m** map with
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
  mapgen.ts       # generator tuning: archetype mix, width classes, detail params (14)
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

Five classes, each with a distinct **side-profile silhouette** (03 §6). Side profiles are far
more recognizable than plan views — sail height and position, hull taper, bow shape, stern plane
arrangement — so silhouette recognition is a skill worth designing for. Shapes must be
distinguishable from a partial echo arc showing only the near side.

| | **Scout** | **Attack** | **Hunter** | **Heavy** | **Special Ops** |
|---|---|---|---|---|---|
| Role | Cheap sensor picket | The default boat | Aggressive sub-killer | Torpedo platform | Utility / infiltration |
| Point cost | 60 | 100 | 130 | 180 | 120 |
| Length (silhouette) | 55 m | 80 m | 95 m | 130 m | 70 m |
| **Clearance radius** | **14 m** | **26 m** | **30 m** | **48 m** | **18 m** |
| **Smallest passage** | Slot | Narrow | Standard | Wide | Slot |
| Max HP | 60 | 100 | 110 | 180 | 70 |
| Max speed | 16 m/s | 15 m/s | 18 m/s | 13 m/s | 14 m/s |
| Cavitation speed @ 200 m | 6.0 m/s | 5.5 m/s | 6.5 m/s | 4.5 m/s | 7.0 m/s |
| Cavitation speed @ 800 m | 9.5 m/s | 9.0 m/s | 10.5 m/s | 7.5 m/s | 11.0 m/s |
| Turn rate (peak) | 4.0 °/s | 3.0 °/s | 3.2 °/s | 1.8 °/s | 3.5 °/s |
| **Max pitch** | ±35° | ±30° | ±30° | ±22° | ±35° |
| Ballast rate | 0.6 m/s | 0.5 m/s | 0.5 m/s | 0.35 m/s | 0.7 m/s |
| Test / crush depth | 400 / 550 m | 500 / 680 m | 550 / 720 m | 450 / 620 m | 700 / 900 m |
| Base source level | 42 | 48 | 50 | 58 | 40 |
| Array gain (passive) | +6 | +4 | +5 | +2 | +5 |
| Target strength | −4 | 0 | +1 | +6 | −3 |
| Baffle arc | ±25° | ±30° | ±30° | ±40° | ±25° |
| Torpedo tubes (base) | 1 | 2 | 3 | 4 | 2 |
| Base reload | 40 s | 32 s | 26 s | 30 s | 34 s |
| **Slots: Sensor** | 2 | 2 | 2 | 1 | 3 |
| **Slots: Machinery** | 1 | 2 | 2 | 2 | 2 |
| **Slots: Hull** | 0 | 1 | 1 | 2 | 1 |
| **Slots: Weapon** | 1 | 2 | 3 | 3 | 2 |
| **Slots total** | 4 | 7 | 8 | 8 | 8 |

### Reading the table

**Clearance radius is the most strategically important stat on the table.** Maps are dense cave
systems (14) with passages ranging from Open (any hull, room to manoeuvre) down to Slot (16–28 m,
Scout and Special Ops only). A hull's clearance decides *which routes exist for it*, and the
navmesh is filtered per hull accordingly (04 §5.1).

The consequences run through the whole design:
- A Scout or Special Ops can use every passage on the map, including the quiet ones nobody can
  watch. That is what their fragility buys.
- A Heavy is confined to Wide-and-better routes. The generator guarantees one such route exists at
  every `x` (invariant I2, 14 §3), but it is often a long detour — so a Heavy fleet is **slow in
  three separate senses**: low top speed, shallow pitch, and forced onto indirect routes. That is
  a strong, coherent identity, and it makes escorting a Heavy a genuine logistical problem.
- Fleet composition is now partly a *map* decision, which is why the lobby must show a map preview
  before fleets are locked (14 §8).

**Max pitch and crush depth are also first-class stats**, because in a vertical slice they define
how much of the board a hull can reach and how fast it can get there. Descent rate is
`speed · sin(pitch)` (04 §5), so a Heavy at ±22° and 13 m/s descends at 4.9 m/s while a Special
Ops at ±35° and 14 m/s descends at 8.0 m/s. The Heavy is slow *in both axes*, which is a much
sharper characterization than the top-down design gave it.

- **Scout** exists so a player can afford *coverage*, and in a cave system it also buys *access*.
  Cheap, quiet, agile, fragile, one tube, and able to go anywhere. The natural purchase for a
  player who has just learned why one boat is blind — and later, the tool for using routes the
  enemy's bigger hulls cannot even watch.
- **Attack** is the boat a new player should be handed. Nothing it does is bad.
- **Hunter** is fast, agile, well-armed, thin-skinned. It wins by finding first and firing first,
  and it dies when it does not.
- **Heavy** is slow, loud, tanky, shallow-limited, route-limited, and carries the ordnance. Its
  620 m crush depth keeps it out of the deep water where everyone else goes quiet and fast, and
  its 48 m clearance keeps it out of most of the map's passages. It is confined to the wide, open,
  shallow parts of the world — exactly the loudest and most exposed places. That triple
  confinement is a far better weakness than "it has a big baffle arc," and it makes escorting it a
  real problem rather than a formality.
- **Special Ops** is the sensor and utility hull: 900 m crush depth, best pitch, Slot-class
  clearance, quietest, frailest. It owns the deep water *and* the tight terrain — it can go
  essentially anywhere on the map and survive almost nothing. The drone and mine platform.

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
| Powerful Active Sonar | 25 | Ping source level +8 dB, range +40%, ray count +50% (fuller outlines) — and a far bigger self-broadcast |
| Rapid Ping | 20 | Active sonar cooldown −50% |
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

Costs are per tube, added to fleet cost. Ranges are sized for a 5000 m map.

| Variant | Cost/tube | Speed | Range | Max pitch | Seeker | Damage | Notes |
|---|---|---|---|---|---|---|---|
| **Standard** | 0 | 22 m/s | 3000 m | ±40° | Passive, switchable to active | 100 | The baseline. Quiet enough to sneak, slow enough to evade, agile enough in depth to chase a diving target. |
| **Super-cavitating** | 25 | 55 m/s | 1200 m | ±12° | Active only | 90 | Nearly unavoidable inside 800 m; useless as a long shot. Its narrow pitch limit means **it cannot follow a target that dives hard** — that is its designed counter. Announces itself and its firing point map-wide. |
| **Active Decoy** | 15 | 12 m/s | 1000 m | ±30° | — | 0 | Swims out, then emits a loud boat-like signature for 60 s. Creates a false track; seduces seekers. |
| **Active Sonar Drone** | 20 | 12 m/s | 2000 m | ±40° | — | 0 | Transits to a chosen point and depth, loiters, pings on an interval for ~4 min. Illuminates an area from somewhere that is not you. |
| **Passive Sonar Drone** | 20 | 10 m/s | 2000 m | ±40° | — | 0 | Silent listener at a chosen point and depth for ~6 min. The single most important tool for watching a flank — or for **listening below the layer while you stay above it**. |
| **Mine** | 10 | 8 m/s | 800 m | ±45° | Proximity | 130 | Transits to a point, holds depth, waits ~10 min. Detonates on a hostile within ~80 m. Detectable by active sonar at short range. Several at staggered depths form a **vertical curtain** across a chokepoint (04 §7). |

### Tuning notes
- Standard torpedo speed (22 m/s) versus boat max speed (13–18 m/s) is a deliberately narrow
  margin. A boat that detects a torpedo early and runs *can* outlast it on fuel. Evasion should
  be a skill, not a dice roll. If playtests show torpedoes are unavoidable, lower speed before
  lowering damage.
- **Pitch limits are the new balance dimension.** Evading vertically is now a distinct skill
  from evading horizontally, and each torpedo's pitch limit defines what it can chase. Expect
  this to need the most tuning of anything in the table.
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
