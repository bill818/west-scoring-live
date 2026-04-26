-- 022: entry-list stats on class_jumper_stats.
--
-- Bill 2026-04-26: jumper-only "entry specific stats" — populate the
-- moment entries land, no waiting for rides to start. V1 had:
--   - Unique Riders count
--   - Multi-Ride Riders list (rider name + their horses)
--   - Countries Represented (count + breakdown by FEI 3-letter code)
-- Source pattern: Working site mid march/stats.html:617-678.
--
-- Hunter classes are deliberately excluded (Bill: "this will stay in
-- the jumper side only"). The compute call site only fires for J/T
-- via the existing /v3/postCls jumper branch + /v3/recomputeJumperStats.

ALTER TABLE class_jumper_stats ADD COLUMN unique_riders     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE class_jumper_stats ADD COLUMN unique_horses     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE class_jumper_stats ADD COLUMN unique_owners     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE class_jumper_stats ADD COLUMN countries_json    TEXT;   -- [{code, count}] desc by count
ALTER TABLE class_jumper_stats ADD COLUMN multi_riders_json TEXT;   -- [{rider, horses:[...]}] desc by count
