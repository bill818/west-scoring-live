-- 019: Per-round time-allowed values for jumper classes.
--
-- Captured from the J/T class header in the .cls file:
--   col[8]  = r1_time_allowed (seconds)
--   col[11] = r2_time_allowed
--   col[14] = r3_time_allowed
--
-- Hunter classes leave these NULL — TA is jumper-only. Stored on
-- `classes` (class-level metadata, not per-entry) so every public surface
-- and future stats/live page reads the same value.
--
-- Backfill of existing classes is done via /v3/reparseClassHeaders which
-- replays each class's archived .cls bytes from R2 through the same
-- parseClsHeaderV3 path /v3/postCls already uses. Hunter classes
-- harmlessly write NULL.

ALTER TABLE classes ADD COLUMN r1_time_allowed REAL;
ALTER TABLE classes ADD COLUMN r2_time_allowed REAL;
ALTER TABLE classes ADD COLUMN r3_time_allowed REAL;
