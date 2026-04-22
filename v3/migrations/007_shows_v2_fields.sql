-- Phase 2c.7: add v2's operator-facing show fields to v3's shows table.
-- Both Add Show and Edit Show dialogs surface these in the admin UI.
--
--   venue          operator-entered (e.g., "Devon Horse Show Grounds")
--   location       operator-entered city/state (e.g., "Devon, PA")
--   status         'pending' (default) | 'active' | 'complete' | 'archived'
--                  operator-chosen lifecycle marker
--   stats_eligible 0 or 1 (default 1 = include in stats).
--                  Flag test shows as 0 so they don't pollute rider/horse
--                  aggregate numbers down the line.
--
-- Skipped from v2's original schema:
--   - dates   TEXT  — v2 stored both structured (start/end) and
--                     operator-entered display string; v3 derives the
--                     display string via WEST.format instead.
--   - rings_count — v3's rings table is the source of truth. Admin
--                   can live-count via SQL; denormalized field invites
--                   drift.

ALTER TABLE shows ADD COLUMN venue TEXT;
ALTER TABLE shows ADD COLUMN location TEXT;
ALTER TABLE shows ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE shows ADD COLUMN stats_eligible INTEGER NOT NULL DEFAULT 1;
