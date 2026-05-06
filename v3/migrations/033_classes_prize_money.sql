-- Migration 033: classes.prize_money — JSON array of dollar amounts
-- per finishing place ([place1, place2, place3, ...]). Parsed from
-- the .cls file's @money row on every /v3/postCls write. NULL when
-- the class has no prize money allocation.
--
-- Used by class.html (results page) to render the prize amount
-- under each ribbon SVG when the class is FINAL (Bill 2026-05-06:
-- "put the prize money per place under the ribbons but only on
-- final"). Reuses the same isFinal gate as the ribbon rendering.
--
-- Stored as JSON text rather than a relational table since a class's
-- prize allocation is read together with the class meta — no need
-- for cross-class joins or per-place queries.

ALTER TABLE classes ADD COLUMN prize_money TEXT;
