-- Phase 2d pivot: jumper scoring goes per-round (migration replaces 008's design).
--
-- Rationale (Session 33, 2026-04-24):
-- Wide shape (entry_jumper_scores with r1_*/r2_*/r3_* columns) was
-- correct for parser/admin display ergonomics but wrong for stats. V2's
-- D1 results table was per-round for exactly the reasons STATS-BRAINSTORM.md
-- lays out — every primary stats query (clear-round %, R1 vs JO analysis,
-- fault buckets per round, fastest-4, TA-vs-elapsed) is naturally per-round.
-- V2's stats.html client-side unpivots wide data into per-round every
-- render; v3 fixes that at the storage layer.
--
-- Shape:
--   entries                  identity only (unchanged)
--   entry_jumper_summary     one row per jumper entry — entry-scoped fields
--                            (ride_order, overall_place, parse meta)
--   entry_jumper_rounds      one row per entry PER ROUND actually ridden
--                            (absence of row = round didn't happen)
--
-- Admin display (/v3/listEntries) pivots back to wide via LEFT JOINs on
-- round 1, 2, 3 — admin code unchanged. Stats queries (Phase 3+) read
-- entry_jumper_rounds natively with no unpivot.

DROP TABLE IF EXISTS entry_jumper_scores;

CREATE TABLE IF NOT EXISTS entry_jumper_summary (
  entry_id          INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  ride_order        INTEGER,
  overall_place     INTEGER,
  score_parse_status TEXT,
  score_parse_notes  TEXT,
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entry_jumper_rounds (
  entry_id          INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  round             INTEGER NOT NULL,     -- 1, 2, or 3
  time              REAL,
  penalty_sec       REAL,
  total_time        REAL,
  time_faults       REAL,
  jump_faults       REAL,
  total_faults      REAL,
  status            TEXT,
  numeric_status    INTEGER,
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, round)
);
CREATE INDEX IF NOT EXISTS idx_ejr_entry ON entry_jumper_rounds(entry_id);
CREATE INDEX IF NOT EXISTS idx_ejr_round ON entry_jumper_rounds(round);
