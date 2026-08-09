# SEG

A browser-based, server-authoritative, slow-paced multiplayer submarine RTS. Two teams command
small fleets through a procedurally generated cave system, seeing the world only through sonar.

The public game name is still open — `seg` is the internal namespace.

**Design documentation lives in [`planning/`](planning/).** Start with
[`planning/00-overview.md`](planning/00-overview.md); the index is
[`planning/README.md`](planning/README.md).

## Status

**M0 complete, plus the auth and lobby slices, and the first half of M1's mechanic.** Working
today: the workspace and toolchain, boundary enforcement, the test harness, the account/session
API with its SQL backend, and the whole pre-match meta — create a lobby, join it by code or
from the server browser, move between teams and spectators, kick players, change settings, host
migration, and disband. Those were pulled forward from M5 because they depend on nothing in the
simulation. The fleet editor is still a placeholder, because it needs the M3 content tables.

A match now **runs, moves, shoots, and ends**: a 20 Hz clock advances every live match, boats
travel along their orders and are stopped by rock and by each other, torpedoes run and detonate,
and the acoustic solve on every second tick gives each player a view frame carrying what their
team has heard. When a fleet is wiped out, an objective target is reached, or the half-hour runs
out, the server stops the match and sends everyone the same results — the outcome, both scores,
and a card per boat on both sides. See [`planning/11-roadmap.md`](planning/11-roadmap.md).

### The map is not given to you

A playing client is never sent the terrain (see
[ADR 0002](docs/adr/0002-uncharted-terrain.md), reversing C12). It receives the *frame* of the
world — how wide, how deep, where its own boats and the objectives are — and fills in the rock
one square metre at a time by listening.

| Threshold | What happens |
|---|---|
| Below detection | Nothing. The square is not on the wire. |
| Detected | A sonar-green 1 m square, brightness from signal excess, fading over ~1.4 s. |
| Confirmed (server-side) | Rock joins the team's chart **for the rest of the match**; a hull is revealed whole — silhouette, position, pitch. |

The band between the last two is the point: a good player reads the faint squares and acts on
them before the server is willing to agree. Confirmed contacts that slip detection do not
vanish — they leave a hollow silhouette on the scope and a hollow mark on the mini-map, frozen
at the pose that was actually measured. Vision is pooled per team, and **only spectators get
the map itself**.

### Or you can shout

Every boat carries active sonar — a switch (`Q`, or the button on its fleet row) rather than a
button you press once. While it is on, the boat pulses every second at sixty-odd decibels above
its own noise, and the difference is not subtle: a stopped boat charts *nothing* passively and
a couple of thousand squares with the switch thrown.

It is also how you get killed. The measured asymmetry is that you are heard four to six times
further than you can see — the pulse pays the distance once on its way out, and a return pays
it twice. A pinging boat is the easiest thing in the game to find.

Under the hood a pulse is nothing but a very loud transient, so no part of the solver knows what
a ping is; see [ADR 0003](docs/adr/0003-active-sonar-is-a-transient.md) for what that bought and
what it left unbuilt.

### Shooting at where he will be

**Neither torpedo is aimed at a boat.** You put the cursor on a point in the water and press
`space`, and both loads make you lead the target — the difference is what happens when the weapon gets there.

| | Standard | Super-cavitating |
|---|---|---|
| Speed / range | 22 m/s, 3 km | 55 m/s, 1.2 km |
| The point is | an **enable point** — its sonar wakes up there | a pure **aim point** |
| Seeker | active, and deaf past about 340 m | none at all |
| Pitch band | ±40° | ±12° — it cannot follow a dive |
| Times out after | 135 s | 24 s, and detonates either way |

So a homing shot is two guesses rather than one: where he will be, and where to switch the sonar
on so that he is inside 340 m when it does. A super-cavitating shot is one guess at a third of the
lead, and no second chances — it goes exactly where you point it and nowhere else.

Everything about a weapon is loud. The tube firing is the second-loudest transient in the game, the
motor runs at 62 dB (92 for the fast one, which is the price of the speed), a seeker announces
itself every second, and the detonation is louder than all of it. A torpedo reaches the acoustic
solver as the same shape a submarine does, so it lights cave walls and shows up in the enemy's
picture without one line of the solver knowing what it is. **Friendly fire is on**: a seeker has no
idea whose hull it is hearing.

Every load leaves the tube slow. A weapon comes out on the *boat's* heading and spends its first
seconds getting round onto the bearing it was sent on — and a point behind it is reached the way a
submarine reverses, by braking to a stop and mirroring rather than by sweeping a fifty-metre circle
through your own fleet. An over-the-shoulder shot costs those seconds. A shot you turned onto first
costs nothing.

### Two loads that never go off

| | Sonar drone | Active decoy |
|---|---|---|
| Costs | 20 points | 15 points |
| Runs at | 12 m/s, then stops on station | **your own flank speed**, for two minutes |
| It is | a pulse harder than a Heavy every 2 s, and better ears than any hull | a second you: your noise, off your silhouette |
| Beaten by | anything with a warhead — it is the easiest thing on the map to find | one active pulse, which measures 7 m where the passive picture promised 100 |

The drone is the only thing in the game that adds to your team's picture without adding a boat to
the water: it charts, and hears, from somewhere you are not. The decoy is the same trick played on
the enemy — a contact they confirm as a *submarine*, full silhouette on the scope and a live mark on
the mini-map, because at the level of squares and decibels there really is one there. Seekers chase
it too. Pinging it strips it, and the contact they were chasing turns into a dart in front of them —
but now everyone knows where they are, which is what pinging always costs.

Tubes reload the instant they fire, and what a tube loads *next* is chosen before the shot — click
a tube pip to pick, or `shift`+the tube's number, then the arrow keys and Enter. Changing your mind
about a weapon already loaded costs an unload and a reload; `c` pays that price on the spot, for
every armed tube holding something other than what it has queued. `ctrl`+number arms a tube for the
next shot; with none armed, the first loaded tube fires, whatever is in it.

Hearing an enemy tube fire flashes an alarm on the scope and the mini-map — but only if you were
already hearing the boat that fired. Shoot from outside detection range and nobody is told.

### Lobbies

Lobby traffic runs over the game protocol on a WebSocket at `/ws`, authenticated from the
session cookie at the upgrade. It stays on the WebSocket permanently, even after WebRTC
arrives — see [ADR 0001](docs/adr/0001-simultaneous-transports.md).

| Command | Does |
|---|---|
| `lobby.create` | Host a lobby. Name only; the rest is set inside it. |
| `lobby.join` | By 6-character code (any lobby) or by id (public lobbies only). |
| `lobby.setPosition` | Move to team 1, team 2, or the spectators. |
| `lobby.leave` / `lobby.kick` | Leave; or, as host, remove someone. |
| `lobby.modify` | Host-only: name, player cap, mode, fleet budget, visibility. |
| `lobby.list` | The server browser, with name / mode / open-slots filters. |

Lobbies live in memory and die with the process. An unlisted lobby is not joinable by id, and
says `not_found` rather than admitting it exists — otherwise a lobby id would be an oracle for
private lobbies.

### Auth API

All endpoints take and return JSON. Types and validation rules live in `@seg/shared`, so the
client enforces exactly what the server enforces.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/signup` | Create an account. Username and password only. |
| `POST` | `/api/auth/login` | Sign in. `rememberMe` controls session lifetime. |
| `GET` | `/api/auth/me` | Current account, or 401. |
| `POST` | `/api/auth/logout` | End this session. |
| `POST` | `/api/auth/logout-all` | End every session for the account. |

Sessions are opaque 256-bit tokens in an `HttpOnly; SameSite=Lax` cookie; only their SHA-256 is
stored. `rememberMe: true` gives a 30-day sliding session that survives a browser restart;
otherwise it is a 12-hour browser-session cookie.

**Configuration:** `SEG_HOST`, `SEG_PORT`, `SEG_DB`, `SEG_SECURE_COOKIES`, `SEG_TRUST_PROXY`.
`SEG_SECURE_COOKIES` defaults on when `NODE_ENV=production` and off otherwise, because `Secure`
cookies silently never arrive over plain http.

## Requirements

- Node.js >= 22.17
- pnpm 11 (`corepack enable pnpm`)

### Browser automation (optional, for UI work)

The repo registers a [Playwright MCP](https://github.com/microsoft/playwright-mcp) server in
`.mcp.json` so the sonar scope can be driven and screenshotted during development. On a fresh
Linux or WSL machine it needs a browser and its system libraries:

```bash
npx playwright install chromium
sudo npx playwright install-deps chromium   # needs a real terminal; sudo cannot prompt via a tool
```

Without the second command Chromium fails to launch with
`libnspr4.so: cannot open shared object file`.

**Under WSL there is no GPU**, so WebGL runs on SwiftShader (software). That is fine for checking
that a render is *correct*, but it cannot validate frame-rate budgets — see `planning/13 §9`.

## Getting started

```bash
pnpm install
pnpm dev          # server on :8787, client on :5173
```

Then open http://localhost:5173 — the home page. Signed out it offers sign-in and account
creation; signed in it is the main menu.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Server and client together, both watching |
| `pnpm dev:server` / `pnpm dev:client` | One at a time |
| `pnpm test` | Vitest, once |
| `pnpm test:watch` | Vitest, watching |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm lint` | ESLint, including the boundary rules |
| `pnpm format` | Prettier |
| `pnpm check` | Everything above — what CI runs |

## Packages

| Package | Responsibility |
|---|---|
| `@seg/shared` | Simulation, map generation, content tables, wire protocol. **No I/O, no Node builtins, no DOM** — runs identically in both runtimes. |
| `@seg/server` | HTTP, auth, persistence, lobby service, match hosting |
| `@seg/client` | React shell wrapping the PixiJS sonar scope |
| `@seg/tools` | Scenario runner, balance matrix, map gallery, replay, benchmarks |

Packages are consumed from source — there is no build step for `@seg/shared`. Vite bundles it for
the client and `tsx` loads it for the server.

## Enforced boundaries

Two constraints are cheap now and unenforceable later, so ESLint enforces them from the start
(see [`eslint.config.js`](eslint.config.js) and `planning/10 §3`):

1. **`@seg/shared` stays portable.** No Node builtins, no DOM, no server or client dependencies.
   Its `tsconfig.json` also provides neither `@types/node` nor the DOM lib, so a violation fails
   typecheck as well as lint.
2. **The simulation stays deterministic.** No `Math.random()`, no `Date.now()`, no `new Date()`,
   no `performance.now()` under `sim/` or `mapgen/`. Determinism is what makes replays,
   regression tests, and bug reproduction from a recorded match possible.

## License

MIT — see [`LICENSE`](LICENSE).
