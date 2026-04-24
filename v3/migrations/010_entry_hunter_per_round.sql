-- Phase 2d hunter half — per-round storage for hunter scoring.
-- Mirrors the jumper pattern (migration 009) structurally:
--   entry_hunter_summary   entry-scoped fields
--   entry_hunter_rounds    per-entry-per-round rows (absence = didn't ride)
--
-- Hunter-specific differences vs jumper:
--   - No time/faults per round — hunter score is judge-sum "total".
--   - Combined total (col[45]) is entry-scoped (sum across completed rounds)
--     so lives on summary, not repeated on each round.
--   - Per-judge scores (col[15+j], [24+j], [33+j]) NOT captured yet —
--     deferred per Bill. Future: entry_hunter_judge_scores table keyed
--     by (entry_id, round, judge_idx).
--   - Derby components (HighOptions/Handy bonuses at cols 15-29 for
--     classMode=2) NOT captured yet — totals at col[42-45] still land.
--
-- has_gone (cols 49/50/51) intentionally NOT stored — same unreliability
-- as jumper col[36]. Derive "did they ride this round" from
-- (total IS NOT NULL OR status IS NOT NULL) at render time.
--
-- classes table gains num_judges + is_equitation (from hunter header
-- col[7] and col[10]) so admin can label display and stats can filter.

CREATE TABLE IF NOT EXISTS entry_hunter_summary (
  entry_id           INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  go_order           INTEGER,
  current_place      INTEGER,
  combined_total     REAL,
  score_parse_status TEXT,
  score_parse_notes  TEXT,
  first_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entry_hunter_rounds (
  entry_id          INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  round             INTEGER NOT NULL,
  total             REAL,          -- judge-sum score for this round (col[42]/[43]/[44])
  status            TEXT,          -- text status cols 52/53/54
  numeric_status    INTEGER,       -- numeric status cols 46/47/48
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, round)
);
CREATE INDEX IF NOT EXISTS idx_ehr_entry ON entry_hunter_rounds(entry_id);
CREATE INDEX IF NOT EXISTS idx_ehr_round ON entry_hunter_rounds(round);

-- classes table: hunter-specific header fields
ALTER TABLE classes ADD COLUMN num_judges INTEGER;
ALTER TABLE classes ADD COLUMN is_equitation INTEGER;
