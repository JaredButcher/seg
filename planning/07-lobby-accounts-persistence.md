# 07 — Lobbies, Accounts & Persistence

## 1. Scope

The meta-game is deliberately thin: an account exists so your fleets and your stats persist.
There is no progression, no unlocks, no currency, no friends list, no matchmaking.

## 2. Accounts

**Username + password only. No email. No recovery. Ever.**

This is a real product decision with real consequences, and the UX has to be honest about it:

- Signup shows the warning **before** the form, not in fine print: *"There is no password
  reset. There is no email on file. If you forget your password, your account and your saved
  fleets are gone permanently."*
- A confirmation checkbox — "I understand my account cannot be recovered" — is required.
- After signup, offer a **downloadable recovery code**: a high-entropy string, stored server-
  side as an argon2 hash alongside the password hash, single-use, which permits a password
  reset. [TBD — see 12.] This preserves "no email, no PII, no support burden" while giving
  the diligent player an out. Recommended: include it. It is ~40 lines of code and it converts
  risk R7 from "angry users" to "users who ignored the warning."
- Never surface "user not found" versus "wrong password" — one generic failure message, and a
  constant-time path (02 §7).

### Rules
| Field | Rule |
|---|---|
| Username | 3–20 chars, `[A-Za-z0-9_-]`, case-insensitive-unique, case-preserving for display |
| Password | Minimum 10 chars, no composition rules, rejected if in a bundled top-10k list |
| Sessions | Opaque 256-bit token in DB; 30-day sliding expiry; `HttpOnly; Secure; SameSite=Lax` |
| Multiple sessions | Allowed. A "sign out everywhere" action exists. |
| Deletion | Self-service, immediate, irreversible. Fleets deleted; match results anonymized (kept for the other participants' history). |

### Guests [TBD — recommend yes]
Given risk R4, requiring signup before a player can even *look* at the server browser is a
meaningful funnel loss. Proposal: a guest can browse lobbies and play, with a session-scoped
temporary identity and no fleet saving (preset fleets only). Converting to a real account
carries the stats forward. Decide by M5.

## 3. Fleet compositions

A **fleet** is a named, saved list of boats, each with a hull class, module loadout, and
tube loadout. Edited in an overlay accessible from the main menu and from the lobby — never
mid-match.

```ts
interface Fleet {
  id: FleetId;
  ownerId: AccountId;
  name: string;              // 1–32 chars
  boats: BoatTemplate[];     // 1–10, typically 3–5
  pointBudgetTargeted: number; // what budget the player built for
  contentVersion: string;    // content hash at save time
  createdAt: number; updatedAt: number;
}

interface BoatTemplate {
  name: string;              // 1–20 chars, player-chosen, appears on the scope
  hull: HullId;
  modules: Array<{ slot: SlotIndex; module: ModuleId }>;
  tubes: Array<{ tube: TubeIndex; torpedo: TorpedoId }>;
}
```

### Behaviours the builder must get right
- **Budget-relative validity.** A fleet is saved with the budget it was built for. In a lobby
  with a different budget, it is shown as valid, over-budget, or under-budget with the delta.
  Under-budget is legal (you just wasted points) and should be flagged, not blocked.
- **Content drift.** When the content tables change, a saved fleet may reference a removed
  module or become over-budget after a cost change. On load: repair what can be repaired
  (dropped module → empty slot), flag what cannot, and **never silently alter a fleet**. Show
  the player exactly what changed and make them re-save.
- **Presets.** Ship 4–6 designer-authored fleets at common budgets, always available,
  non-deletable, cloneable. **Presets are 3, 4, and 5 boats** — the design target (05 §6) — and
  the builder opens on a 4-boat preset. A new player should never have to decide how many boats
  to bring before they know what a boat does. This is the new-player path (06 §7) and the
  fallback when a saved fleet is invalid.
- **Import/export as a text code.** Cheap to build, enormously useful for sharing builds and
  for playtesting. A base64url-encoded compact binary of the `Fleet` structure.
- **Live stat preview.** Selecting a hull and modules shows the resolved final stats and — the
  important part — a **detection-range readout** against a reference target at reference
  conditions. "How far away can a standard Attack hear this boat at creep?" is the question
  every module choice is really answering, and the builder should answer it directly.
- **Depth-envelope preview.** A vertical bar showing this boat's test and crush depth against a
  reference map profile and the layer (09 §10). In a vertical-slice game "how much of the ocean
  can this hull use" is a primary build question, and it is one that only a picture answers well.

Limit: **30 saved fleets per account** [TBD], to bound storage and the UI.

## 4. Lobbies

Player-created, host-configured, no matchmaking.

### Lifecycle
```
create ──► configure ──► players join & ready ──► start ──► (match) ──► return to lobby
```

- Lobbies live **in memory** on the server. Not persisted; a server restart clears them. This
  is correct — a lobby has no value once its members are disconnected.
- **All lobby traffic — create, join, modify, browse — runs over the game protocol on the
  `control` channel, which is pinned to the WebSocket permanently** (02 §3.1). This does not
  change when WebRTC arrives. Lobby operations happen before a match exists, and therefore
  before there is anything to negotiate a data channel for; they are also the traffic that must
  keep working for a player whose network blocks WebRTC outright. Reliable, ordered delivery is
  a requirement here and not a preference: a dropped `lobby.join` is a player looking at a
  screen that did not change.
- Each lobby has a short **join code** (6 chars, unambiguous alphabet, no vowels to avoid
  accidental words) and a `public`/`unlisted` visibility flag. The alphabet is
  `BCDFGHJKMNPQRTVWXYZ2346789` — 26 symbols, ~309 M codes. Note that *both* members of every
  lookalike pair are excluded (0/O, 1/I/L, 5/S) rather than one being folded onto the other, so
  a mistyped character is simply invalid and there is no normalization ambiguity. Rules live in
  `@seg/shared/lobby/join-code.ts` so the client validates exactly what the server enforces.
- Host holds configuration authority (06 §3), can kick players, move players between teams,
  and start the match. Host leaving pre-match migrates the role; host leaving mid-match does
  nothing (01 §7).
- **Player slots model a generic occupant**, not specifically a human account: `{ slotId, team,
  occupant: { kind: 'human', accountId } | { kind: 'empty' } }`. Bots are out of scope for 1.0
  (04 §10), but shaping the slot as a tagged union now means adding a `'bot'` occupant later is
  a UI change rather than a data-model migration. Costs nothing today.
- The lobby is where fleet selection happens. Every player must have a valid fleet for the
  configured budget before Start is enabled — with a clear per-player indicator of *why*
  someone is not ready.

### Server browser
Given risk R4, this screen is load-bearing and deserves more care than a table usually gets.

- Lists public lobbies: name, host, mode, map, players/capacity, budget, ping, password flag.
  The **map** column shows type and size (e.g. "Dense · Medium", 06 §3); browsing filters on
  them are a later nicety, not a 1.0 requirement.
- Filters: mode, has-space, no-password, budget range.
- **Sorted by "most likely to start soon"** rather than by creation time — a lobby with 5/6
  players and everyone ready should be at the top. Filling nearly-full lobbies is the single
  highest-leverage thing this screen can do for a small player base.
- Shows total players online and total in-match, prominently. An empty browser with "0 players
  online" is honest; an empty browser with no context reads as broken.
- Auto-refresh, and a one-click "create a lobby" fallback when the list is empty.

## 5. Spectators

- Join a lobby as a spectator (host toggle to allow), or convert from player pre-match.
- Do not occupy a team slot; capped at 16 per lobby [TBD].
- Can chat in an `all` scope, cannot chat to a team.

### Vision policy — host-selected, defaults to the safe option

| Policy | Behaviour | Risk |
|---|---|---|
| **Team-limited** (default) | Spectator picks a team and receives that team's `TeamView` with an empty private half — the same object the players get (01 §5). Nearly free to implement. | None |
| **God view** | Full ground truth | A spectator on voice comms is a maphack. Only for private/organized play. |
| **Delayed god view** | Full ground truth on a 60–120 s delay | Good for tournaments/streaming. Requires buffering the view stream — modest cost, high value. [TBD: 1.0 or post-launch.] |

The default must be Team-limited, and switching to God view should carry a visible warning in
the lobby for all players. Players deserve to know who is watching what.

Implementation note: a spectator view is generated by the **same** per-player view generator
with a different vision source — team picture, or the ground-truth source for god view. There
is no second code path.

## 6. Data model

**Generic SQL, SQLite first.** The schema below is written to the portable subset defined in
01 §3.1 — it runs unmodified on SQLite and Postgres apart from DDL type names, which the dialect
shim substitutes. Repositories are written once and tested against both engines (§6.1).

```sql
CREATE TABLE account (
  id             TEXT PRIMARY KEY,          -- uuid
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,             -- argon2id
  recovery_hash  TEXT,                      -- argon2id of the recovery code, nullable, single-use
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  deleted_at     INTEGER
);

CREATE TABLE session (
  token_hash  TEXT PRIMARY KEY,             -- sha256 of the opaque token; never store the token
  account_id  TEXT NOT NULL REFERENCES account(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_session_account ON session(account_id);

CREATE TABLE fleet (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id),
  name            TEXT NOT NULL,
  data            TEXT NOT NULL,            -- JSON BoatTemplate[]
  point_budget    INTEGER NOT NULL,
  content_version TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_fleet_account ON fleet(account_id);

CREATE TABLE match_result (
  id           TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,
  map          TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  winning_team INTEGER,
  settings     TEXT NOT NULL,               -- JSON
  summary      TEXT NOT NULL                -- JSON: per-team scores
);

CREATE TABLE match_participant (
  match_id   TEXT NOT NULL REFERENCES match_result(id),
  slot       INTEGER NOT NULL,              -- part of the key: account_id may be NULL for guests
  account_id TEXT REFERENCES account(id),   -- nullable: guest, or deleted account
  team       INTEGER NOT NULL,
  stats      TEXT NOT NULL,                 -- JSON, the full per-player stat block
  PRIMARY KEY (match_id, slot)
);
CREATE INDEX idx_participant_account ON match_participant(account_id);

CREATE TABLE account_stats (                -- denormalized lifetime rollup
  account_id      TEXT PRIMARY KEY REFERENCES account(id),
  matches_played  INTEGER NOT NULL DEFAULT 0,
  matches_won     INTEGER NOT NULL DEFAULT 0,
  kills           INTEGER NOT NULL DEFAULT 0,
  deaths          INTEGER NOT NULL DEFAULT 0,
  torpedoes_fired INTEGER NOT NULL DEFAULT 0,
  torpedoes_hit   INTEGER NOT NULL DEFAULT 0,
  seconds_played  INTEGER NOT NULL DEFAULT 0,
  seconds_detected INTEGER NOT NULL DEFAULT 0
);
```

**Design notes:**
- Stat blobs are JSON in `TEXT`, not columns, and **nothing queries inside them**. That is what
  keeps them portable — the moment something needs `json_extract` or a `JSONB` operator, the
  schema stops being engine-neutral. Promote a field to a real column instead.
- Timestamps are epoch-millisecond `INTEGER`, not `TIMESTAMP`. Portable, unambiguous, and it
  sidesteps the SQLite/Postgres divergence on time zones entirely.
- Ids are application-generated UUIDs in `TEXT`. No `AUTOINCREMENT`, no `SERIAL`.
- `username_lower` exists so case-insensitive uniqueness is a plain unique index rather than
  `COLLATE NOCASE` (SQLite) or `CITEXT` (Postgres).
- `account_stats` is a rollup maintained transactionally with match insertion, because
  aggregating `match_participant` JSON on every profile view is a trap.
- Replays are **files on disk**, keyed by match id, not blobs in the database. Retention 30 days
  (Q23). The DB stores a path and a size.
- All writes happen outside the tick loop. A match host never touches the database (01 §1); it
  emits `MatchResult` and the server persists it.

### 6.1 Staying portable

The rules are in 01 §3.1. What matters here is that they are **verified rather than asserted**:

- **The repository test suite runs against both engines in CI** from M5 — a real SQLite file and
  a Postgres container, same tests, same repository code. This is the entire portability
  guarantee; without it, "we can move to Postgres later" is a hope.
- **Migrations are numbered `.sql` files** in the portable subset, executed by a small runner
  that substitutes DDL type names per dialect. No migration framework.
- **SQLite operational settings** are not optional: WAL mode, a busy timeout, foreign keys on,
  and `BEGIN IMMEDIATE` for write transactions. SQLite's single-writer model is fine at this
  write volume, but only with WAL — the default rollback journal will produce lock contention the
  first time two players save fleets at once.
- **The trigger to actually migrate** is concurrent write contention or a need for more than one
  server process — not table size. Six tables of text will not outgrow SQLite on volume.

## 7. Privacy

- Data held: username, password hash, optional recovery hash, session records, fleets, match
  history. **No email, no IP retention beyond transient rate-limiting state, no analytics
  identifiers tied to accounts.**
- The minimal-data posture is a genuine feature and should be stated plainly on the signup
  page, alongside the no-recovery warning. It makes the warning read as a principled choice
  rather than as missing functionality.
- Deletion is immediate and complete for personal data; match participation is anonymized
  rather than deleted so other players' histories stay coherent.
