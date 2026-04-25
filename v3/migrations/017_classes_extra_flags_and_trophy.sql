-- Migration 017: extra hunter compositional flags + trophy text
--
-- Hunter header flags that drive display banners or chip overlays:
--   reverse_rank        H[16] — "Lower score wins (pinned low→high)"
--   ribbons_only        H[39] — "Ribbons only — no numeric scores"
--   is_jogged           H[12] — "Horses jogged for soundness"
--   is_team             H[34] — "Team class" (Special team format)
--   show_all_rounds     H[35] — affects R-column visibility for partial completers
--   print_judge_scores  H[15] — print-only flag, may drive future judges-grid default
--
-- trophy is read from a special @foot row in the .cls (not a header
-- column). v2 watcher reads cols[1] of that row. Captured here so the
-- public hero can render it as a patron / award context line.
--
-- All flags default 0 (false). trophy nullable.

ALTER TABLE classes ADD COLUMN reverse_rank       INTEGER DEFAULT 0;
ALTER TABLE classes ADD COLUMN ribbons_only       INTEGER DEFAULT 0;
ALTER TABLE classes ADD COLUMN is_jogged          INTEGER DEFAULT 0;
ALTER TABLE classes ADD COLUMN is_team            INTEGER DEFAULT 0;
ALTER TABLE classes ADD COLUMN show_all_rounds    INTEGER DEFAULT 0;
ALTER TABLE classes ADD COLUMN print_judge_scores INTEGER DEFAULT 0;
ALTER TABLE classes ADD COLUMN trophy             TEXT;
