-- Migration 015: entries.sire + entries.dam
--
-- Why: public results page wants a "Sire × Dam — Owner" subtitle line
-- under each entry. The columns exist in the .cls (col[6] = sire,
-- col[7] = dam per west-cls-jumper.js) but aren't persisted yet.
-- Both nullable — many entries leave the fields blank in Ryegate.

ALTER TABLE entries ADD COLUMN sire TEXT;
ALTER TABLE entries ADD COLUMN dam TEXT;
