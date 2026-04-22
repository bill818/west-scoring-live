-- Phase 2c: entries table — identity fields per entry per class.
-- Parsed from entry rows (row 1+) of the .cls file.
-- Scoring data (times, faults, rank, status) is Phase 2d, NOT here.
--
-- Article 1 reminder: the column map below is IDENTITY-only and is
-- confirmed shared across H / J / T entry rows (cols 0-12). Scoring
-- columns diverge by lens — captured separately in 2d.
--   col[0]  entry_num   (e.g. "120", "409")
--   col[1]  horse_name  (e.g. "CC TOP 4")
--   col[2]  rider_name  (e.g. "SHANE RADIMER")
--   col[3]  (empty in all observed data)
--   col[4]  (empty in all observed data)
--   col[5]  owner_name
--   col[6]  sire        (skipped for Phase 2c, captured via raw_row)
--   col[7]  dam         (skipped for Phase 2c, captured via raw_row)
--   col[8]  city
--   col[9]  state
--   col[10] horse_usef / FEI number
--   col[11] rider_usef / FEI number
--   col[12] owner_usef / FEI number  (per CLS-FORMAT column guess — confirm live)
--
-- raw_row captures the full comma-separated line so scoring parsers
-- (Phase 2d) and future audits can re-examine without re-fetching R2.

CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id      INTEGER NOT NULL REFERENCES classes(id),
  entry_num     TEXT    NOT NULL,
  horse_name    TEXT,
  rider_name    TEXT,
  owner_name    TEXT,
  horse_usef    TEXT,
  rider_usef    TEXT,
  owner_usef    TEXT,
  city          TEXT,
  state         TEXT,
  raw_row       TEXT,
  first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(class_id, entry_num)
);

CREATE INDEX IF NOT EXISTS idx_entries_class_id ON entries(class_id);
