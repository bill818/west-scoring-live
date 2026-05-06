-- Migration 032: classes.finalized_at — when the operator marked
-- the class FINAL (Channel B {29}=F, or engine right-click "Make
-- Final"). NULL = not finalized.
--
-- Used by the public results page (class.html) to render ribbon SVGs
-- on placings 1-12 once the class is officially complete (Bill
-- 2026-05-06: ribbons are reserved for finalized classes — they're
-- the visual "this is settled" cue).
--
-- v3 already has parse_status for .cls-parse outcome; that's a
-- different concept (file ingest health). finalized_at is operator-
-- intent: "this class is done."
--
-- The DO mirrors the byClass[id].finalized_at it tracks in memory
-- onto this column on every FINAL transition. Un-finalize (B+intro
-- pair on a FINAL'd class) sets it back to NULL.

ALTER TABLE classes ADD COLUMN finalized_at TEXT;
