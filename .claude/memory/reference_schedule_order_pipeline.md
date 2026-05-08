---
name: schedule_order — tsked drives class display order
description: classes.schedule_order column populated by /v3/postTsked + /v3/postCls catch-up. /v3/listClasses ORDER BY uses it. /v3/reprocessTsked is the backfill recipe.
type: reference
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Public class display order on ring.html / show.html / index ring
preview matches Ryegate's tsked schedule (operator's interleaved run
order — e.g. 325 / 925 / 930 / 330 / 335 / 935 instead of numeric
325 / 330 / 335 / 925 / 930 / 935).

**Schema:** `classes.schedule_order INTEGER` (migration 034,
2026-05-07). NULL = class not in current tsked.

**Write paths:**
- `/v3/postTsked` — engine POSTs tsked.csv. Worker iterates valid rows,
  writes `schedule_order = idx + 1` (1-indexed file position) along
  with scheduled_date + schedule_flag.
- `/v3/postCls` tsked catch-up — when a class first registers AFTER
  the operator's last tsked POST, the catch-up scans stored R2
  tsked.csv and applies the matching position. Walks once tracking
  1-indexed valid-row count so the order matches what /v3/postTsked
  would have written. Gated on `scheduled_date IS NULL` so a manual
  reorder can't get clobbered.

**Read path:**
- `/v3/listClasses` — `ORDER BY scheduled_date IS NULL, scheduled_date,
  schedule_order IS NULL, schedule_order, CAST(class_id AS INTEGER),
  class_id`. Date primary, schedule_order secondary, numeric class_id
  fallback when schedule_order is NULL.

**Backfill recipe:** `POST /v3/reprocessTsked?slug=X` (auth-gated,
takes no body). Re-runs the postTsked write logic against the
tsked.csv currently in R2. Use after schema changes that add
tsked-derived columns. Idempotent — safe to call repeatedly.

**Don't try to derive order client-side from class names** — the
heights interleave by Ryegate's logic (BR vs II.2b classes paired by
height bracket), not anything inferable from the class_id or name.
The tsked file is the source of truth.

**See also:** `reference_reparse_class_headers.md` is the cousin
recipe for class-header backfill.
