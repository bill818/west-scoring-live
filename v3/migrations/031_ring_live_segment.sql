-- Migration 031: ring_live_segment — per-ring continuous live span log.
--
-- A ring "goes live" when the operator sends Channel B {29}=<class_id>
-- AND a matching intro frame arrives within ~1 second:
--   * Jumper: fr=1 with phase=intro (or countdown)
--   * Hunter: fr=11 (entry rotation = on-course card)
--
-- A ring "goes un-live" when ALL classes on it are no longer live:
--   * 'final'   — operator sent Channel B {29}=F for the last live class
--   * 'timeout' — last live class went 30min without UDP (abandoned)
--   * 'recovery_close' — DO warmup found a stale open segment (last_event_at
--                        > 30min) and closed it forensically
--
-- One row per CONTINUOUS span. A ring that runs 8am-10am, breaks, then
-- runs 10:45am-12:30pm produces TWO rows. Manager report sums (ended_at
-- - started_at) per ring per day for accurate active-time without
-- double-counting overlapping classes (segments are already merged by
-- definition — multiple classes during one segment don't open new rows).
--
-- ended_at is the TRUE end (timestamp of the closing FINAL or the
-- last_event_at when timeout fired) — NOT the wall-clock when the worker
-- noticed. Same for started_at: the received_at of the B+intro pair.
--
-- last_event_at is the ring-wide UDP heartbeat — updated on every event
-- during the segment, used as the timeout backstop and as the ended_at
-- when the segment closes via timeout.

CREATE TABLE IF NOT EXISTS ring_live_segment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  show_slug     TEXT NOT NULL,
  ring_num      INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  ended_reason  TEXT,
  classes_run   INTEGER NOT NULL DEFAULT 1,
  last_event_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ring_live_segment_lookup
  ON ring_live_segment(show_slug, ring_num, started_at);

CREATE INDEX IF NOT EXISTS idx_ring_live_segment_open
  ON ring_live_segment(show_slug, ring_num) WHERE ended_at IS NULL;
