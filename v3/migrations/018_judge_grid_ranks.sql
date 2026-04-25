-- Migration 018: Hunter judges-grid derived columns
--
-- Why: the public results page (and future stats / live / display)
-- needs per-judge ranks alongside the raw scores. Computing ranks
-- client-side would diverge across pages; computing them at .cls write
-- time and storing them gives one source of truth for every consumer.
--
-- Three additions, all linked back to entries.id via existing PKs:
--   entry_hunter_judge_scores.judge_round_rank — this entry's rank for
--                                                 a given (round, judge)
--                                                 score, vs other entries
--   entry_hunter_rounds.round_overall_rank     — this entry's rank for
--                                                 a given round's total,
--                                                 vs other entries
--   entry_hunter_judge_cards (NEW table)       — per-(entry, judge) card
--                                                 aggregate (sum across
--                                                 rounds) + rank vs other
--                                                 entries on same judge
--
-- Mode-agnostic at the storage layer: derby's high_options + handy_bonus
-- are nullable on entry_hunter_judge_scores already, so the COALESCE
-- math in the compute pass works for derby and non-derby alike.

ALTER TABLE entry_hunter_judge_scores ADD COLUMN judge_round_rank INTEGER;
ALTER TABLE entry_hunter_rounds       ADD COLUMN round_overall_rank INTEGER;

CREATE TABLE IF NOT EXISTS entry_hunter_judge_cards (
  entry_id   INTEGER NOT NULL,
  judge_idx  INTEGER NOT NULL,
  card_total REAL,
  card_rank  INTEGER,
  PRIMARY KEY (entry_id, judge_idx)
);

CREATE INDEX IF NOT EXISTS idx_judge_cards_entry ON entry_hunter_judge_cards(entry_id);
