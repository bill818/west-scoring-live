-- Migration 036: classes.is_test — class-level test flag inside real shows.
--
-- Companion to migration 035 (shows.is_test). Two flavors of "test":
--   1. is_test on shows — entire show is a sandbox (smoke-show, etc.).
--      Hidden from the public homepage, direct URL still works.
--   2. is_test on classes — individual class inside a REAL show is a test.
--      Hidden from the show's public class list / stats / entries.
--      Revealed when the page is visited with ?test=1.
--
-- Auto-detection: /v3/postCls sets is_test=1 when the class name matches
-- /test/i. Operators get this by naming a Ryegate class "TEST" or "TEST 1"
-- or "TEST scoreboard run" etc. No admin action required.
--
-- Engine bypasses the start_date/end_date mtime gate for test classes so
-- operators can run scoreboard verification anytime (including before the
-- show starts) without touching the date envelope.
--
-- Bill 2026-05-11.

ALTER TABLE classes ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
