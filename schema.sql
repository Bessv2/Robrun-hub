-- Base schema. Safe to re-run (IF NOT EXISTS). Changes after first deploy go in migrations/NNNN_*.sql.

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,                -- Discord user id ("dev" for local dev login)
  name TEXT NOT NULL,
  avatar TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,        -- sha-256 of the cookie value; the raw token is never stored
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id);

CREATE TABLE IF NOT EXISTS wipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,            -- when the new server opened (ISO 8601, UTC)
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status (
  wipe_id INTEGER NOT NULL REFERENCES wipes(id),
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wipe_id, member_id)
);

CREATE TABLE IF NOT EXISTS progress (
  wipe_id INTEGER NOT NULL REFERENCES wipes(id),
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wipe_id, member_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wipe_id INTEGER NOT NULL REFERENCES wipes(id),
  title TEXT NOT NULL,
  item_id TEXT,
  assignee TEXT REFERENCES members(id) ON DELETE SET NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS plan_wipe ON plan(wipe_id);

-- Larry's Tree nodes (kind 'node') and business goods (kind 'product').
-- Seed columns are overwritten on every re-seed; price_override* columns are set on the site and kept.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,             -- tree branch, or business group for products
  tier INTEGER,
  rarity TEXT,
  requires TEXT NOT NULL DEFAULT '',
  research_cost INTEGER,
  price INTEGER,                      -- Trade Laptop price for nodes; main price for products
  price_source TEXT,                  -- 'laptop' | 'smuggler' | 'fence' | 'hub_buy'
  smuggler INTEGER,
  fence INTEGER,
  hub_buy INTEGER,
  seized INTEGER,
  sentence_years INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0, -- 1 when the latest seed no longer has this item
  price_override INTEGER,
  price_override_by TEXT,
  price_override_at TEXT
);

CREATE TABLE IF NOT EXISTS model_inputs (
  key TEXT PRIMARY KEY,
  business TEXT NOT NULL,
  label TEXT NOT NULL,
  value REAL,
  unit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  how_to_measure TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS raids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wipe_id INTEGER NOT NULL REFERENCES wipes(id),
  kind TEXT NOT NULL,                 -- 'defend' | 'attack' | 'info'
  target TEXT NOT NULL,
  at_time TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,                    -- member id, or NULL when sent through the ingest hook
  source TEXT NOT NULL DEFAULT 'site',
  pinged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS raids_wipe ON raids(wipe_id);
