-- v3 initial schema — Phase 1
-- Tables: shows, rings.
-- Runs against WEST_DB_V3 only. v2's WEST_DB is never touched from v3.
--
-- Design notes:
--   - Dates stored ISO-8601 (sortable). Display layer formats as MM-DD-YYYY.
--   - Slug validated client + server: ^[a-z][a-z0-9-]{2,59}$
--   - rings.ring_num is operator-facing (1, 2, 3...). Keyed with show_id.
--   - FK constraints declared but not enforced by D1 default; app code
--     maintains referential integrity.
--   - created_at auto-populated; updated_at set by app code on UPDATE.

CREATE TABLE IF NOT EXISTS shows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    UNIQUE NOT NULL,
  name        TEXT    NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS rings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER NOT NULL REFERENCES shows(id),
  ring_num    INTEGER NOT NULL,
  name        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  UNIQUE(show_id, ring_num)
);

CREATE INDEX IF NOT EXISTS idx_rings_show_id ON rings(show_id);
