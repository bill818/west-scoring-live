-- Migration 037: entry_*_rounds.finished_at — first-write timestamp per round.
--
-- Captures "when did this round's score first land in our database" so kiosk /
-- display surfaces can render the Seen list in chronological ring-entry order
-- (rather than place order, which conflates performance with timing). Useful
-- downstream for stats / manager report ("first to go", "average round duration",
-- replay timelines, etc).
--
-- Pattern:
--   • Set on first INSERT of a (entry_id, round) row.
--   • The worker's round writer uses a DELETE-then-INSERT pattern per .cls
--     write to handle round-data-removed edge cases. To preserve finished_at
--     across that pattern, the worker captures existing finished_at values
--     per round into a Map BEFORE the DELETE, then reuses them on INSERT.
--   • Brand-new rounds get datetime('now'). Rounds re-INSERTed from prior
--     state keep their original finished_at.
--
-- NULL-tolerant: existing rows have NULL, future writes set values. The Seen
-- sort falls back to (overall_place, entry_num) for NULL rows so historical
-- data still renders sensibly.
--
-- Bill 2026-05-13 — ring display "Seen list in ring-entry order" build.

ALTER TABLE entry_jumper_rounds ADD COLUMN finished_at TEXT;
ALTER TABLE entry_hunter_rounds ADD COLUMN finished_at TEXT;
