-- Migration 014: show_flags + country_code
--
-- Why: Jumper class headers carry H[26] ShowFlags (jumper lens only —
-- hunter's H[26] is Phase2Label). When true, the public results render
-- a flag emoji next to the rider name using the FEI 3-letter country
-- code stored on the entry (col[4]).
--
-- Both columns are nullable / default-zero — no backfill required at
-- migration time. The next /v3/postCls re-parse populates them.

ALTER TABLE classes ADD COLUMN show_flags INTEGER DEFAULT 0;
ALTER TABLE entries ADD COLUMN country_code TEXT;
