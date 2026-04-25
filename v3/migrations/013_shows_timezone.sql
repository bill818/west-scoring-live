-- Migration 013: shows.timezone
--
-- Why: end-of-show ("past 11:59pm of last day") is a local-time concept.
-- A show in Devon PA ends at midnight Eastern, not midnight UTC. Without
-- a per-show timezone the public index drops shows up to 5 hours early
-- (or late, going east). location is free text and unreliable to parse.
--
-- Default: America/New_York. Most shows are East Coast — operator can
-- change in the admin show dialog.

ALTER TABLE shows ADD COLUMN timezone TEXT DEFAULT 'America/New_York';
