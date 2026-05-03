---
name: Jumper stats pipeline (compute + endpoint + page)
description: class_jumper_stats table + computeJumperStats + /v3/listJumperStats + stats.html. Pre-computed per-class jumper aggregations including server-rendered standings. Cherry-pickable — every display string comes pre-formatted from SQL so future pages drop in rows without re-implementing logic.
type: reference
originSessionId: 9024d026-0951-451f-8a07-0033a87c38ac
---
Full pipeline shipped session 39. Mirror of the hunter judges-grid
pattern — server pre-computes on every /v3/postCls, page reads
ETag-aware.

**Schema:** `class_jumper_stats` (one row per class)
- counts: total_entries, scratched, eliminated
- per-round R1/R2/R3: competed, clears, time_faults, avg_total_time,
  avg_clear_time, fastest_4fault_entry_id, fastest_4fault_time,
  fault_buckets (TEXT JSON)
- entry-list (jumper-only): unique_riders/horses/owners,
  countries_json, multi_riders_json
- computed_at metadata

Migrations: 020 (table), 021 (fastest_clear → fastest_4fault rename),
022 (entry-list columns).

**Compute:** `computeJumperStats(env, classDbId)` in west-worker.js,
next to `computeJudgeGridRanks`. Hooked into `/v3/postCls` jumper
branch synchronously after entry UPSERTs. Failures log + entriesStatus,
never fail the POST.

Bucket schemes (method-aware):
- `standard` — 8 buckets (Clear / 1-3 / 4 / 5-7 / 8 / 9-12 / 13+ /
  EL-RF-OC) for II.2 family + 3R + Two-Phase + Winning Round
- `speed` — 5 buckets keyed on jump_faults for Table III / II.1
- `optimum` — distance-from-(TA-4) buckets for IV.1 method 6
- `none` — gamblers / equitation skip the histogram (NULL)

**Read endpoint:** `/v3/listJumperStats?class_id=N`
- ETag-wrapped via `jsonWithEtag` for cheap polling
- Returns ONE envelope: `{ ok, class:{...}, stats:{ counts, rounds:[...
  with standings:[]], entry_stats:{...} } }`
- Standings are FULLY server-rendered — every display string comes
  pre-formatted: `place_display`, `place_class`, `fault_class`,
  `fault_display`, `time_display`, `gap_class`, `gap_display`,
  `gap_label`. Future pages drop in row HTML without re-implementing
  any logic.

Two SQL paths picked per round in the endpoint:
- **R1 of multi-round methods** (II.2 family + 3R + Two-Phase +
  Winning Round + Optimum 2R) — JO mode: `gap_label = "Gap from TA -
  73s"`, JO chip for entries at min_faults, qualifiers sorted by
  ride_order (Bill: "keep R1 Clears in the order they went in"),
  faulted by faults+time. ROW_NUMBER over non-killed gives stable
  position numbers.
- **Everything else** — default mode: gap-from-leader, RANK with
  PARTITION to keep killed out of the rank pool.

**Safety valve:** `/v3/recomputeJumperStats`
- `{}` recomputes every J/T class
- `{ slug: 'X' }` scoped to a show
- `{ class_id: N }` single class

**Frontend:** `v3/pages/stats.html`
- Linked from class.html jumper hero via `📊 Class Stats` button
  (jumper-only; hunter classes don't get the button)
- Polls `/v3/listJumperStats` every 10s with ETag (see
  `reference_etag_polling_pattern.md`)
- Lens-tinted hero, entry summary section, per-round detail with
  chip strip + fastest-4faulter callout + fault histogram +
  standings table

**Architectural rule:** entry-list stats are jumper-only per Bill
2026-04-26. Hunter classes never compute or serve these fields;
endpoint returns 400 for non-J/T classes. Hunter analog (when
wanted) would land on a parallel hunter table.
