-- Migration 016: shows.results_layout
--
-- Per-show admin setting controlling the public class results display.
-- Values: 'stacked'  → rounds collapse into one column, latest round
--                      on top (Jump Off above Round 1) — saves
--                      horizontal space, default for narrow displays
--         'inline'   → rounds rendered side-by-side as separate columns
--
-- Public class.html reads this and passes to WEST.jumperTemplates
-- .renderTable as the layout option. EQ / 1R templates ignore it
-- (no rounds to stack).

ALTER TABLE shows ADD COLUMN results_layout TEXT DEFAULT 'stacked';
