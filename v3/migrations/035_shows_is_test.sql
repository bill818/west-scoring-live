-- Migration 035: shows.is_test — flag for sandbox / TEST shows.
--
-- TEST shows behave differently from real shows:
--   1. Hidden from the public index (filtered out of /v3/listShowsWithRings).
--      Still reachable by direct URL — operator uses this to verify
--      scoreboards / overlays without polluting the public homepage.
--   2. Engine bypasses the start_date/end_date mtime gate for uploads —
--      operator can test with any folder contents, anytime.
--   3. The /show/<slug> page renders a TEST banner so anyone who lands on
--      the page knows it's not a real show.
--
-- Auto-detection: when /v3/createShow gets a name matching /test/i, is_test
-- is auto-set to 1. Admin can flip it manually via the edit dialog.
--
-- Bill 2026-05-11. Step 1 of Phase A — stale-.cls prevention foundation.

ALTER TABLE shows ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
