-- 025: per-round avg total faults + time-fault rate on class_jumper_stats.
--
-- Bill 2026-04-27: small batch of additional stats. Both derive
-- cheaply from existing entry_jumper_rounds data; computeJumperStats
-- gets two more aggregations in the per-round SQL pass.
--
-- avg_total_faults — AVG(total_faults) across competed entries (NULL
--                    when nobody competed). Difficulty gauge — "Avg
--                    5.2 flts/horse" reads at a glance.
-- time_fault_pct  — % of competed entries that incurred ANY time
--                    fault. Together with avg jump-fault breakdown
--                    later, separates "course difficulty" from "TA
--                    pressure." 0-100, NULL when nobody competed.

ALTER TABLE class_jumper_stats ADD COLUMN r1_avg_total_faults REAL;
ALTER TABLE class_jumper_stats ADD COLUMN r1_time_fault_pct   REAL;
ALTER TABLE class_jumper_stats ADD COLUMN r2_avg_total_faults REAL;
ALTER TABLE class_jumper_stats ADD COLUMN r2_time_fault_pct   REAL;
ALTER TABLE class_jumper_stats ADD COLUMN r3_avg_total_faults REAL;
ALTER TABLE class_jumper_stats ADD COLUMN r3_time_fault_pct   REAL;
