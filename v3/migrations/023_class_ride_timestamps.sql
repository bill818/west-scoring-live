-- 023: ride-level timestamp rails on classes.
--
-- Bill 2026-04-27: hybrid show-stats build — public stats ship today,
-- show-manager operational report deferred until engine UDP connects.
-- These columns lay the rails so when engine RIDE_START / FINISH UDP
-- events start flowing, the data has somewhere to land without a
-- migration on the day.
--
-- Today: all NULL. Populated when engine + UDP wiring lands.
-- Consumer: future /v3/listShowReport endpoint + manager UI.
-- Design: docs/v3-planning/SHOW-MANAGER-REPORT.md.

ALTER TABLE classes ADD COLUMN first_ride_at    TEXT;   -- ISO timestamp of first RIDE_START in this class
ALTER TABLE classes ADD COLUMN last_finish_at   TEXT;   -- ISO timestamp of last FINISH in this class
ALTER TABLE classes ADD COLUMN duration_seconds REAL;   -- last_finish_at - first_ride_at, populated by engine
