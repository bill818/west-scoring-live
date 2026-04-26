-- 020: class_jumper_stats — pre-computed per-class jumper aggregations.
--
-- Mirrors the hunter pre-compute pattern from migration 018:
--   .cls write → /v3/postCls → computeJumperStats(env, classDbId)
--   → DELETE+INSERT one row in this table
--   → /v3/listJumperStats?class_id=N reads it
-- Real-time by construction; no compute on read; never stale.
--
-- One row per class. Hunter / U classes are skipped at the call site
-- (computeJumperStats is only invoked for J/T parsed types) so this
-- table holds jumper data only.
--
-- Design doc: docs/v3-planning/JUMPER-STATS-DESIGN.md (Session 39).
-- Schema deliberately mirrors the per-round shape of
-- entry_jumper_rounds (R1/R2/R3 numbered slots) — the consumer labels
-- rounds via WEST.format.roundLabel, not anything stored here.
--
-- Fault histogram lives in r{N}_fault_buckets as method-aware JSON
-- (scheme: standard / speed / optimum / none). Buckets are static
-- within a scheme but vary across schemes; storage is plain TEXT so
-- new schemes don't require a migration.

CREATE TABLE IF NOT EXISTS class_jumper_stats (
  class_id                  INTEGER PRIMARY KEY REFERENCES classes(id),

  -- Aggregate counts (across all entries in the class)
  total_entries             INTEGER NOT NULL DEFAULT 0,
  scratched                 INTEGER NOT NULL DEFAULT 0,
  eliminated                INTEGER NOT NULL DEFAULT 0,

  -- Per-round R1 stats
  r1_competed               INTEGER NOT NULL DEFAULT 0,
  r1_clears                 INTEGER NOT NULL DEFAULT 0,
  r1_time_faults            INTEGER NOT NULL DEFAULT 0,
  r1_avg_total_time         REAL,
  r1_avg_clear_time         REAL,
  r1_fastest_clear_entry_id INTEGER REFERENCES entries(id),
  r1_fastest_clear_time     REAL,
  r1_fault_buckets          TEXT,

  -- Per-round R2 stats (mirror of R1; null on 1R classes)
  r2_competed               INTEGER NOT NULL DEFAULT 0,
  r2_clears                 INTEGER NOT NULL DEFAULT 0,
  r2_time_faults            INTEGER NOT NULL DEFAULT 0,
  r2_avg_total_time         REAL,
  r2_avg_clear_time         REAL,
  r2_fastest_clear_entry_id INTEGER REFERENCES entries(id),
  r2_fastest_clear_time     REAL,
  r2_fault_buckets          TEXT,

  -- Per-round R3 stats (mirror; null unless 3R+JO method)
  r3_competed               INTEGER NOT NULL DEFAULT 0,
  r3_clears                 INTEGER NOT NULL DEFAULT 0,
  r3_time_faults            INTEGER NOT NULL DEFAULT 0,
  r3_avg_total_time         REAL,
  r3_avg_clear_time         REAL,
  r3_fastest_clear_entry_id INTEGER REFERENCES entries(id),
  r3_fastest_clear_time     REAL,
  r3_fault_buckets          TEXT,

  -- Metadata
  computed_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
