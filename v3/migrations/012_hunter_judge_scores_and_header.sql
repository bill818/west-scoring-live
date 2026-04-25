-- Phase 2d hunter completion — per-judge score capture + header expansion.
--
-- Session 33/34 scope: "collect the data now, extrapolation + display later."
-- All fields captured at ingest; admin display polish (ribbons, Ch/Res
-- graphics, sponsor rendering, derby component formatting) comes later.
--
-- NEW TABLE — entry_hunter_judge_scores (per judge per round)
--   Single table handles both layouts via nullable cols:
--     Standard scored (classMode=0/1/3): base_score per judge per round
--     Derby (classMode=2): base_score + high_options + handy_bonus
--   Forced (scoring_type=0): no rows (no judge scores to capture)
--   Absence of row = that judge didn't score that round.
--
-- NEW CLASSES COLUMNS — from hunter header positions:
--   num_rounds      H[03]  1, 2, or 3 — class's round count
--   score_method    H[06]  0=Total, 1=Average
--   ribbon_count    H[08]  8 standard, 12 derby/special — graphic placement
--   is_championship H[11]  0/1 — Ch/Res graphics on 1st and 2nd
--   sponsor         H[29]  text — public page display
--   ihsa            H[38]  0/1 — IHSA mode (hide rider on scoreboard)
--   derby_type      H[37]  0-8 — Intl/Natl/H&G/USHJA Pony/Junior/WCHR variants
--
-- Jumper header captured scoring_method/scoring_modifier already; hunter
-- has parallel richness that we simply hadn't been reading.

CREATE TABLE IF NOT EXISTS entry_hunter_judge_scores (
  entry_id      INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,       -- 1, 2, or 3
  judge_idx     INTEGER NOT NULL,       -- 0-based: 0=judge 1, 1=judge 2, ...
  base_score    REAL,                   -- judge's round score (or derby base)
  high_options  REAL,                   -- Derby only — NULL for non-derby
  handy_bonus   REAL,                   -- Derby R2 only typically — NULL elsewhere
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, round, judge_idx)
);
CREATE INDEX IF NOT EXISTS idx_ehjs_entry ON entry_hunter_judge_scores(entry_id);
CREATE INDEX IF NOT EXISTS idx_ehjs_round ON entry_hunter_judge_scores(round);

ALTER TABLE classes ADD COLUMN num_rounds      INTEGER;
ALTER TABLE classes ADD COLUMN score_method    INTEGER;
ALTER TABLE classes ADD COLUMN ribbon_count    INTEGER;
ALTER TABLE classes ADD COLUMN is_championship INTEGER;
ALTER TABLE classes ADD COLUMN sponsor         TEXT;
ALTER TABLE classes ADD COLUMN ihsa            INTEGER;
ALTER TABLE classes ADD COLUMN derby_type      INTEGER;
