-- 021: rename fastest_clear → fastest_4fault on class_jumper_stats.
--
-- Bill 2026-04-26: "show fastest 4 faulter instead of fastest clear."
-- Fastest clear is already implicit in the standings (it's the leader on
-- speed methods, near-leader on JO methods). Fastest 4-faulter is more
-- interesting — the entry that would have placed had they not pulled
-- the rail.
--
-- Compute filter changes per scheme:
--   standard scheme: total_faults = 4 AND status IS NULL  (one rail clean)
--   speed scheme:    jump_faults = 4 AND status IS NULL   (one rail; time
--                                                          penalty stays
--                                                          in total_time)
--   optimum / none:  NULL (concept doesn't apply)
--
-- SQLite RENAME COLUMN since 3.25; D1 supports it.

ALTER TABLE class_jumper_stats RENAME COLUMN r1_fastest_clear_entry_id TO r1_fastest_4fault_entry_id;
ALTER TABLE class_jumper_stats RENAME COLUMN r1_fastest_clear_time     TO r1_fastest_4fault_time;
ALTER TABLE class_jumper_stats RENAME COLUMN r2_fastest_clear_entry_id TO r2_fastest_4fault_entry_id;
ALTER TABLE class_jumper_stats RENAME COLUMN r2_fastest_clear_time     TO r2_fastest_4fault_time;
ALTER TABLE class_jumper_stats RENAME COLUMN r3_fastest_clear_entry_id TO r3_fastest_4fault_entry_id;
ALTER TABLE class_jumper_stats RENAME COLUMN r3_fastest_clear_time     TO r3_fastest_4fault_time;
