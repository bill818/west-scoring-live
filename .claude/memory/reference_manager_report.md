---
name: Manager Report — /v3/ringActivityReport + admin drawer
description: Auth-gated ring-day rollup. Returns daily totals, live segments, holds (>=10min idle), prize money by ring, top horse riders, classes start→finalize. Surfaced in admin.html via "📋 Manager Report" drawer.
type: reference
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Backend: `/v3/ringActivityReport?slug=...&date=YYYY-MM-DD` (auth via
the same admin token as other /v3 manage endpoints).

Returns:
- `daily_totals[]` — per-ring counts of horses + classes for the day
- `live_segments[]` — per-ring contiguous live windows derived from
  `ring_live_segment` rows (start/end/duration)
- `holds[]` — gaps between live segments **>= 10 minutes** (HOLD_MIN_MINUTES).
  Anything shorter is normal pacing, not a hold.
- `money_by_ring[]` — sum of `cls.prize_money` across classes that
  finalized that day, grouped by ring. Reads JSON-string-stored prize_money
  via `json_extract`.
- `top_horse_riders[]` — riders with the most distinct horses ridden
  that day across the show; useful for catch-rider awareness.
- `classes[]` — every class on the day with `started_at`,
  `finalized_at`, ring_num, label. Drives the Classes start→finalize
  table in the drawer.

Frontend: admin.html — "📋 Manager Report" button opens a drawer.
`openManagerReport()` → date picker; `loadManagerReport()` fetches;
`renderManagerReport(report, classes, filters)` builds the sections.
Filter UI lets manager scope by ring + by class status.

**Why HOLD_MIN_MINUTES = 10?** Bill 2026-05-08: "consider a ring on
hold if it sits empty for more 10 min." Anything shorter is between-
class shuffling, not noteworthy.

**Why this lives in admin only (for now):** raw operational data
(holds, segment durations) is for the show manager, not public
spectators. If we eventually expose class start/finalize times on the
public side it'll be a curated subset, not this whole rollup.

**Reference:** commits 307f2cb (drawer), 02aa41b (prize money + horse
riders + holds endpoint additions), ecf36b3 (10-min threshold).
Related: ring_live_segment table populated by DO live-state
transitions.
