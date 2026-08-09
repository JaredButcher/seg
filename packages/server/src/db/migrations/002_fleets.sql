-- 002 — saved fleets.
--
-- Portable subset only (planning/01 §3.1). Same rules as 001: TEXT / BIGINT / INTEGER,
-- epoch-millisecond timestamps, application-generated ids.

CREATE TABLE fleet (
  id         TEXT   PRIMARY KEY,
  account_id TEXT   NOT NULL REFERENCES account(id),
  name       TEXT   NOT NULL,
  -- The boat list as JSON in TEXT, and **nothing queries inside it** (planning/07 §6).
  -- That restraint is what keeps the schema engine-neutral: the moment something needs
  -- json_extract (SQLite) or a JSONB operator (Postgres), it stops being portable. If a
  -- field ever needs querying, promote it to a real column instead.
  data       TEXT   NOT NULL,
  -- Denormalised so the load list — name, boat count, points — is one indexed read and
  -- never has to parse every fleet's JSON. They are recomputed from `data` on every write,
  -- so they cannot drift.
  boat_count INTEGER NOT NULL,
  points     INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX idx_fleet_account ON fleet(account_id);
