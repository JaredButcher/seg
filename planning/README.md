# Planning Index

**Namespace:** `seg` — packages are `@seg/shared`, `@seg/server`, `@seg/client`, `@seg/tools`.
**Public game name:** still open (Q31), and deliberately decoupled from the namespace, so naming
the product later costs nothing in code.
**License:** MIT.

Read [00-overview.md](00-overview.md) first. Everything else expands one slice of it.

| File | Covers |
|---|---|
| [00-overview.md](00-overview.md) | Vision, pillars, launch scope, non-goals, risk register |
| [01-architecture.md](01-architecture.md) | Process topology, package layout, tech stack choices + TBDs |
| [02-netcode-protocol.md](02-netcode-protocol.md) | Transport/codec abstraction, message schema, tick & sync model |
| [03-sonar-model.md](03-sonar-model.md) | The core mechanic: acoustics, detection, contacts, echo outlines |
| [04-simulation-core.md](04-simulation-core.md) | Fixed-step sim loop, movement, depth, damage, torpedo guidance |
| [05-content-subs-modules-weapons.md](05-content-subs-modules-weapons.md) | Hull classes, slots, modules, torpedo variants, point costs |
| [06-game-modes-match-flow.md](06-game-modes-match-flow.md) | Deathmatch, objective capture, match lifecycle, results/stats |
| [07-lobby-accounts-persistence.md](07-lobby-accounts-persistence.md) | Accounts, lobbies, spectators, fleet saves, data model |
| [08-client-ui-screens.md](08-client-ui-screens.md) | Screen inventory, scope rendering, command input, HUD |
| [09-art-direction.md](09-art-direction.md) | Palette, line language, typography, motion, audio direction |
| [10-repo-structure-tooling.md](10-repo-structure-tooling.md) | Monorepo layout, build, test, CI, deployment |
| [11-roadmap.md](11-roadmap.md) | Milestones M0–M8 with exit criteria |
| [12-open-questions.md](12-open-questions.md) | Decisions still open, with owners and deadlines |
| [13-testing.md](13-testing.md) | Test strategy, the scenario corpus, what gets tested when |
| [14-map-generation.md](14-map-generation.md) | Procedural cave systems: invariants, archetypes, the pipeline |
| [15-ambient-ghost-returns.md](15-ambient-ghost-returns.md) | Own-noise ghost returns: why, how faint, and how they fade |
| [16-acoustic-performance.md](16-acoustic-performance.md) | What the field sweep costs, why, and the optimizations ranked |
| [17-netcode-performance.md](17-netcode-performance.md) | Netcode benchmarks, bandwidth budget, parallelization, and the WebRTC gate |

## The six facts that shape everything else

1. **The world is a vertical slice.** `x` is horizontal distance, `y` is depth. There is no third
   dimension, hidden or otherwise. The simulation plane and the display plane are the same plane
   at the same scale — see [04 §2](04-simulation-core.md).
2. **Maps are procedurally generated dense cave systems**, guaranteed to offer at least three
   traversable routes at every `x`. Terrain is the dominant system in the game: it decides most
   detections, gates which hulls can go where, and fills most of the screen — see
   [14](14-map-generation.md).
3. **Sound travels through openings, not through rock.** Propagation is a geodesic over the
   **water lattice**, so a contact around a corner is heard — if at all — via the path the sound
   actually took. The earlier plan's "bearings point at cave mouths" is not built; the vision
   picture is positional (03 §4–5).
4. **The server never sends a client anything that client's *team* has not sensed.** Vision is
   shared completely within a team, so `PlayerView = TeamView + PlayerPrivateView` and the
   expensive half is computed once per team. This is simultaneously the fog of war and the entire
   anti-cheat story — see [01 §5](01-architecture.md).
5. **Simulation at 20 Hz, acoustics and networking at 10 Hz.** Movement and weapons need the
   precision; detection does not — see [04 §1](04-simulation-core.md).
6. **Fleets are 3–5 boats in practice**, 1–10 supported for niche strategies and unusual lobby
   settings — see [05 §6](05-content-subs-modules-weapons.md).

## Conventions used in these docs

- **MUST / SHOULD / MAY** are requirement strength, not flavor text.
- **[TBD]** marks a decision deliberately deferred — every one of these is tracked in
  [12-open-questions.md](12-open-questions.md).
- **[ASSUMPTION]** marks something inferred rather than specified. Challenge these early;
  they are load-bearing.
- Numbers in balance tables are **first-pass placeholders** for tuning, not design intent.
  They exist so systems can be built against concrete values.
- Units: metres, seconds, metres/second, degrees (bearings, 0° = north, clockwise).
  Acoustic levels in **dB-arbitrary** — an internal logarithmic scale, not real-world SPL.
