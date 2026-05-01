-- 027: per-show lock override.
--
-- Bill 2026-04-30: shows should auto-lock after their end_date so
-- engines on lingering scoring PCs can't mutate the historical record.
-- Operators occasionally need to correct a result the morning after a
-- show, so we expose a 3-way override:
--
--   'auto'      (default) — locked iff end_date < today
--   'unlocked'           — engine writes accepted regardless of dates
--   'locked'             — engine writes rejected regardless of dates
--
-- Enforced server-side in postCls, deleteCls, postTsked,
-- engineHeartbeat (HTTP 423 + {ok:false, locked:true}).
-- Admin-only endpoints (hardDeleteCls, recompute*, reparse*) bypass —
-- the lock is about engine writes, not operator intervention.

ALTER TABLE shows ADD COLUMN lock_override TEXT NOT NULL DEFAULT 'auto'
  CHECK (lock_override IN ('auto', 'unlocked', 'locked'));
