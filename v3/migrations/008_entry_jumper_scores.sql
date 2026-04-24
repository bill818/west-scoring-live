-- Phase 2d Piece 1: jumper-lens scoring data in its own table.
--
-- Design rationale (SESSION-32-JUMPER-STATUS-FINDINGS.md §schema pivot):
-- Entries table stays identity-only (14 cols). Lens-specific scoring
-- lives in per-lens linked tables:
--   entry_jumper_scores (this file) — populated for J, T class_types
--   entry_hunter_scores (future migration 010) — populated for H
--
-- Why separate tables per lens:
-- 1. Article 1 at schema level — jumper table literally cannot hold
--    hunter columns, hunter table literally cannot hold jumper columns.
-- 2. Stats correctness — lens-aware aggregates are expressed as
--    JOINs to a specific lens table, so you cannot accidentally
--    average fault totals across hunter entries (which would silently
--    drop them via NULL-ignoring AVG on a wide-table design).
-- 3. Independent evolution — adding hunter-only fields touches hunter
--    table only; adding jumper-only fields touches jumper table only.
--
-- Per-round status is stored INDEPENDENTLY PER ROUND. No overall
-- statusCode at parse time. No copying/propagating one round's status
-- to another. That's the v2 parser bug we are NOT repeating.
--
-- Column map from Farmtek (J) and TOD (T) raw .cls:
--   R1 block: col[15] time .. col[20] total_faults
--   R2 block: col[22] time .. col[27] total_faults
--   R3 block: col[29] time .. col[34] total_faults  (unconfirmed — no 3-round jumper data ever scored)
--   Per-round numeric status: col[21] R1, col[28] R2, col[35] R3 (R3 unconfirmed)
--   Per-round text status:
--     T: col[82]/col[83]/col[84] direct (R3 unconfirmed)
--     J: tail-scan cols 37-39, attributed to the round whose numeric fired
--   Ride metadata:
--     ride_order: col[13]
--     overall_place: col[14]
--
-- has_gone is INTENTIONALLY NOT STORED. Col[36] is an unreliable binary
-- flag (proven 2026-04-23 across 1,398 v2 rows + 959 local rows —
-- 7 entries had col[36]=1 with zero scoring evidence). Display layer
-- derives "did they ride" from (time > 0 OR status != null) at render time.

CREATE TABLE IF NOT EXISTS entry_jumper_scores (
  entry_id          INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,

  -- R1 scoring
  r1_time           REAL,
  r1_penalty_sec    REAL,
  r1_total_time     REAL,
  r1_time_faults    REAL,
  r1_jump_faults    REAL,
  r1_total_faults   REAL,
  r1_status         TEXT,
  r1_numeric_status INTEGER,

  -- R2 scoring
  r2_time           REAL,
  r2_penalty_sec    REAL,
  r2_total_time     REAL,
  r2_time_faults    REAL,
  r2_jump_faults    REAL,
  r2_total_faults   REAL,
  r2_status         TEXT,
  r2_numeric_status INTEGER,

  -- R3 scoring (structural; positions unconfirmed for both hardware types)
  r3_time           REAL,
  r3_penalty_sec    REAL,
  r3_total_time     REAL,
  r3_time_faults    REAL,
  r3_jump_faults    REAL,
  r3_total_faults   REAL,
  r3_status         TEXT,
  r3_numeric_status INTEGER,

  -- Ride metadata
  ride_order        INTEGER,
  overall_place     INTEGER,

  -- Parse meta (populated by parseEntriesScoreJ)
  score_parse_status TEXT,
  score_parse_notes  TEXT,

  -- Timestamps
  first_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
