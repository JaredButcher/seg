# SEG

A browser-based, server-authoritative, slow-paced multiplayer submarine RTS. Two teams command
small fleets through a procedurally generated cave system, seeing the world only through sonar.

The public game name is still open — `seg` is the internal namespace.

**Design documentation lives in [`planning/`](planning/).** Start with
[`planning/00-overview.md`](planning/00-overview.md); the index is
[`planning/README.md`](planning/README.md).

## Status

**M0 complete, plus the auth slice.** There is no game here yet — the simulation begins at M1.
Working today: the workspace and toolchain, boundary enforcement, the test harness, the
account/session API with its SQL backend (pulled forward from M5 because it depends on nothing
in the simulation), and the menu shell around it — a home page, the auth screens, and join-by-code
validation. The four game destinations it links to (create lobby, join, browse, fleet editor) are
routed and say which milestone delivers them. See [`planning/11-roadmap.md`](planning/11-roadmap.md).

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
