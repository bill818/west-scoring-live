-- Phase 2c.5: schedule info from tsked.csv.
-- Classes already exist in the DB (populated by .cls POSTs). tsked tells us
-- when each class runs and what schedule state it's in.
--
--   scheduled_date  ISO "YYYY-MM-DD" — normalized from tsked's M/D/YYYY col[2]
--   schedule_flag   raw col[3] flag. Observed values: (empty) | JO | S | L
--                   JO = Jump Order posted
--                   S  = Scored/Finished (confirmed 2026-03-31)
--                   L  = live-badge (less well confirmed)
--
-- Both NULL until a tsked.csv POST mentions this class_id.
-- NULL/unscheduled classes group under "Unscheduled" in the admin.

ALTER TABLE classes ADD COLUMN scheduled_date TEXT;
ALTER TABLE classes ADD COLUMN schedule_flag  TEXT;
