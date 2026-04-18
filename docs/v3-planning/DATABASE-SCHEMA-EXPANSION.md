# WEST v3.0 Database Schema — Expansion Plan

## Context

Bill is designing the v3.0 database schema during plan mode. This is part of the larger v3 rebuild (WebSocket + Durable Objects + centralized modules) documented in `docs/v3-planning/`. The current D1 has the operational core (shows, classes, rings, entries, results, ring_activity, show_weather) but is missing everything historical, canonical, and observable.

This plan expands Bill's starting mental model:

```
WEST Database
  - Shows Table
    * Show Spec Table (slugs, show info)
    * Show Stats, Start Times, Stats per show
  - Classes Table (sub of shows)
  - Class stats Table
```

...into the full v3 schema. Every addition is grounded in a real project need surfaced in the planning docs or the exploration of the current code.

**Principle:** same D1 database, new tables. No changes to existing tables. All reads of today's endpoints keep working throughout the rebuild.

---

## Current state (for anchoring)

**D1 binding:** `WEST_DB` → database `west-scoring` (ID `085ce299-f591-441b-8edf-b4327b924422`)

**Tables today:**
- `shows` — event metadata (slug, name, venue, dates, status)
- `classes` — per-ring class (FK to shows, class_num, type, scoring_method, cls_raw dump, final_results)
- `rings` — per-ring metadata (FK to shows)
- `entries` — per-class horse/rider (FK to classes, NOT canonical — names as typed)
- `results` — per-round score (FK to entries + classes, **already has `round` column** — it's per-round, not per-entry-final)
- `ring_activity` — ring activity per day (first_post_at, last_post_at, first_horse_at)
- `show_weather` — open-meteo weather per day

**Migration pattern:** `west-worker.js:1282-1292`. Idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` array, run via `/admin/migrate` endpoint. Add new CREATEs to that array — no standalone migration tool needed.

**KV keys holding "could be a table" data:**
- `heartbeat:{slug}:{ring}` — watcher alive + clock
- `oncourse:{slug}:{ring}` — current ride state
- `event:{slug}:{ring}` — last UDP event
- `results:{slug}:{ring}:{classNum}` — pre-computed class results
- `prestats:{slug}:{ring}:{classNum}` — OOG cross-class pre-fetch

---

## Proposed new tables (grouped by purpose)

### A. Canonical identity

Today `entries` stores names as Ryegate typed them. Same rider across shows = different rows. Can't compute "Kendra Pierce's YTD earnings" without a canonical layer.

| Table | Purpose | Key columns |
|---|---|---|
| `riders` | Canonical rider (one row per real person) | `id`, `usef_id` (UNIQUE where not null), `display_name`, `normalized_name`, `city`, `state`, `public_stats` (default 1), `merged_into_rider_id` (soft-merge pointer) |
| `horses` | Canonical horse | `id`, `usef_id`, `display_name`, `normalized_name`, `owner_rider_id`, `public_stats`, `merged_into_horse_id` |
| `entry_identity_links` | Joins raw `entries` → canonical | `entry_id` (PK), `rider_id`, `horse_id`, `confidence` ('exact-usef' \| 'name-city-match' \| 'fuzzy' \| 'manual'), `linked_by` ('auto' \| 'manual' \| 'cron') |
| `identity_review_queue` | Unresolved/ambiguous matches (Alley 4) | `id`, `kind`, `entry_id`, `candidate_canonical_ids` (JSON), `reason`, `resolved_at`, `resolution` |

**Why a join table (`entry_identity_links`) instead of a FK on `entries`:** never mutate operator-facing truth. Raw `entries` stays what Ryegate typed; identity lives in the join.

**Privacy:** `public_stats` column in `riders` and `horses` now even though default is 1 (Alley 5 — costs nothing to have, painful to add later).

---

### B. Normalized class descriptor (.cls parser output)

Per V3-BUILD-PLAN Addendum A: the .cls file is source of truth. The parser normalizes it into a descriptor every page consumes.

| Table | Purpose | Key columns |
|---|---|---|
| `class_descriptors` | Parser output, one row per class | `class_id` (PK/FK), `descriptor_json`, `scoring_method`, `class_type`, `time_allowed`, `round_count`, `is_two_phase`, `is_equitation`, `is_optimum`, `is_faults_converted`, `primary_identity`, `cls_version`, `parse_warnings_json`, `cls_source_hash`, `parser_version`, `parsed_at` |

**Decision: new table, not a JSON column on `classes`** — re-parseable without mutating source, enables parser-version history, avoids write-race with admin edits. Hot fields (`scoring_method`, `class_type`) denormalized as columns too so filters don't need JSON functions.

---

### C. Show-level rollup stats

Maps to Bill's "Show Stats, Start Times, Stats per show" branch.

| Table | Purpose | Key columns |
|---|---|---|
| `show_summary_stats` | Per-show aggregate | `slug` (PK), `total_entries`, `total_rides`, `total_classes`, `classes_complete`, `scratches`, `clear_rate`, `avg_classes_per_rider`, `money_paid_out_cents`, `day_count`, `first_ride_at`, `last_ride_at`, `computed_at` |

Writer: rollup cron (single writer, Alley 3). Reader: index.html, stats.html, post-show manager reports.

*Note:* `ring_activity` already captures start times per ring per day — can stay as-is, show_summary_stats joins it for show-wide start/end.

---

### D. Class-level rollup stats

Maps to Bill's "Class stats Table."

| Table | Purpose | Key columns |
|---|---|---|
| `class_summary_stats` | Per-class aggregate | `class_id` (PK), `entries_count`, `completed_count`, `clear_count`, `four_fault_count`, `eight_fault_count`, `el_count`, `wd_count`, `rt_count`, `dns_count`, `fastest_clear_time`, `fastest_clear_entry_id`, `avg_round_time`, `money_paid_cents`, `computed_at` |

Writer: event-driven on class-complete + nightly full rebuild. Reader: classes.html, `WEST.stats.history.*` frontend module.

---

### E. Rider / horse season rollups

The big historical-stats tables. Power "Kendra's YTD earnings," "Crunchie's best classes this season."

| Table | Purpose | Key columns |
|---|---|---|
| `rider_season_stats` | Per-rider per-season | PK (`rider_id`, `season`), `classes_entered`, `rides_completed`, `wins`, `top3`, `top5`, `clear_rounds`, `earnings_cents`, `avg_rank`, `last_show_slug`, `last_competed_at`, `updated_at` |
| `horse_season_stats` | Per-horse per-season | Same shape, keyed on `horse_id` |

Writer: nightly cron + 15-min incremental for active competitors. Never computed at query time (Alley 2).

---

### F. Class-type leaderboards (cross-show)

Circuit standings across shows. E.g. "top riders in Low Child/Adult Jumpers this season."

| Table | Purpose | Key columns |
|---|---|---|
| `class_leaderboard` | Cross-show standings | PK (`class_type_key`, `season`, `rider_id`), `points`, `entries`, `wins`, `updated_at` |

**Open question — what defines `class_type_key`:** scoring method alone is not enough (a 1.0m jumper and a 1.40m jumper are both method 2). Options: (1) manual division label Bill tags per class in admin; (2) USHJA/USEF division code parsed from class name; (3) a computed key from method + height + section. Needs Bill's call.

---

### G. Audit / observability

These feed Bill's "what new quirk did we hit?" post-show review workflow.

| Table | Purpose | Key columns |
|---|---|---|
| `parse_warnings` | Structured parser log | `id`, `class_id`, `cls_source_hash`, `warning_code`, `raw_context_json`, `parser_version`, `reviewed_at`, `resolution` ('codified' \| 'ignored' \| 'pending') |
| `unknown_quirks` | Distinct quirks rolled up from warnings | `quirk_key` (PK), `first_seen_at`, `last_seen_at`, `occurrence_count`, `status` ('new' \| 'triaged' \| 'fixed') |
| `stats_rebuild_log` | Audit of rollup runs (cost control, Alley 6) | `id`, `run_type`, `table_rebuilt`, `rows_read`, `rows_written`, `duration_ms`, `d1_cost_rows`, `started_at`, `error_text` |
| `udp_anomalies` | Semantic anomalies during ingest | `id`, `show_slug`, `ring`, `class_id`, `anomaly_code` ('duplicate-finish' \| 'elapsed-regression' \| 'phase-skip' \| 'unknown-status-code'), `raw_event_json`, `observed_at` |

This is the observability roadmap's "Phase 2" landing spot — the `audit_events + anomalies view` from MEMORY.md becomes these tables.

---

### H. R2 (not D1) — raw archival

Not D1 tables — but belongs in the plan so it doesn't get missed.

| What | Where | Key |
|---|---|---|
| Raw UDP logs (daily gzipped) | R2 bucket | `{slug}/{ring}/{YYYY-MM-DD}.log.gz` |
| Original `.cls` files | R2 bucket | `cls/{cls_source_hash}` |

Paired with one tiny D1 index table: `udp_log_shipments (slug, ring, date, r2_key, line_count, uploaded_at)`.

**Why R2, not D1:** 30k UDP lines × 8 rings × show day = ~240k rows/day. That's fast exhaustion of D1 per-row billing. R2 is byte-priced, perfect for append-on-close log shipping. Replay harness (see V3-BUILD-PLAN Phase 0.7) reads from R2 by the index. Archiving .cls files lets us re-parse ANY historical class with a future parser version — massively useful for quirk discovery.

---

## Storage split (the rule that applies going forward)

| Data kind | Storage | Rationale |
|---|---|---|
| Live clock / oncourse / heartbeat | DO memory + KV backup | Ephemeral, sub-second; KV only for watcher-reconnect fallback |
| Last UDP event | DO memory | Only live consumers care |
| Pre-computed class results (hot path) | KV 5-min cache in front of D1 | Edge-cached, D1 is source of truth |
| OOG prestats | KV | Computed cache, regenerable |
| Canonical rollups / descriptors / warnings | D1 | Stats fact tables, the whole point |
| Raw UDP logs / archived .cls | R2 | High volume, blob-shaped |

**Principle:** D1 holds facts we query. KV holds pre-shaped answers that expire. R2 holds blobs.

---

## Decisions already made (rationale)

1. **Class descriptor = new table** (not JSON column on `classes`). Re-parseability + parser versioning + no write races.
2. **Identity reconciliation = hybrid auto + queue.** Only `exact-usef` auto-links; everything else to `identity_review_queue`. Alley 4: identity wrong is exponentially harder to fix later.
3. **Raw UDP archive = R2, yes ship it.** Replay testing + forensic debugging needs raw data. D1 is wrong storage for this volume.
4. **Stats rebuild cadence = nightly full + 15-min incremental + event-driven on class-complete.** Single `rebuildStats()` function called from all three paths (Alley 3, one writer).
5. **Prize money = integer cents.** Avoid float. Confirm Ryegate emits cents-precision.
6. **Privacy default = `public_stats = 1`.** Matches current public behavior. Column exists so Bill can flip individuals.
7. **`entry_identity_links` written by resolver only.** Not by watcher on entry-create. Keeps single-writer discipline.
8. **Descriptor = one row per `class_id`.** Overwrite on re-parse. If diffs ever needed, add `class_descriptor_history` later (not Phase 9 blocker).
9. **`class_runs` table NOT NEEDED.** Existing `results` table is already per-round (confirmed — has `round` column). Rollups build directly from `results` + `entry_identity_links`.

---

## Open questions needing Bill's input

1. **`class_type_key` definition** — what makes two classes "the same" across shows for cross-show leaderboards? Manual division label, USHJA/USEF division code, or computed from method+height?
2. **Identity auto-match threshold** — only `exact-usef`, or also `same normalized name + same city`? Recommend USEF-only first pass; loosen after observing false-positive rate.
3. **Retention cutoff for D1** — when does a season move to R2 cold archive? Recommend 2 active seasons hot in D1, older to R2. Not a blocker until 2028.
4. **Parse-warning triage workflow** — where does Bill review `unknown_quirks` after a show? Built into admin dashboard, or separate tool?
5. **`merged_into_*_id` recovery** — if Bill merges two riders and later realizes it was wrong, is there an un-merge path? Recommend: soft-merge preserves original rows so it's reversible. Needs UX thought but not schema change.

---

## Migration strategy (additive, live-site-safe)

Use the existing `migrations` array pattern in `west-worker.js:1282-1292`:

1. **Append all new `CREATE TABLE IF NOT EXISTS` statements.** Include indexes:
   - `(class_id)` on descriptors + class_summary_stats
   - `(rider_id, season)` on rider_season_stats (implicit via PK)
   - `(slug, ring, date)` on udp_log_shipments
   - `(resolved_at)` on identity_review_queue
   - `(status)` on unknown_quirks
2. **Ship tables empty.** Nothing reads from them until writer code ships.
3. **Ship writers behind `V3_ENABLED` flag** (V3-BUILD-PLAN Phase 0.4). Dual-write — old paths untouched, new tables populated alongside.
4. **Ship readers gradually.** New `/api/stats/*` endpoints read from rollups. Existing endpoints keep returning existing data.
5. **Backfill separately.** `/admin/backfill` script seeds canonical identity + rollups from historical `entries`/`results`. Run off-hours.
6. **Verification gate** before stats UI goes live: Bill reviews `identity_review_queue` and `parse_warnings` from 1-2 shows. Alley 4 rule — never ship stats UI with a broken identity layer.

**Absolutely forbidden during rebuild:** no column added/dropped/renamed on existing `entries`, `results`, `classes`, `shows`, `rings`, `ring_activity`, `show_weather` tables. Identity and descriptors live in side tables. Legacy schema preserved.

---

## Where schema lands in the v3 phase plan

| Phase | Tables created |
|---|---|
| Phase 2 (.cls parser) | `class_descriptors`, `parse_warnings`, `unknown_quirks` |
| Phase 7 (Durable Objects) | `udp_anomalies`, `udp_log_shipments` + R2 bucket |
| Phase 9 (Historical stats) | `riders`, `horses`, `entry_identity_links`, `identity_review_queue`, `show_summary_stats`, `class_summary_stats`, `rider_season_stats`, `horse_season_stats`, `class_leaderboard`, `stats_rebuild_log` |
| Phase 10 (polish) | Retention cutoff job, R2 .cls archival |

Sequencing matches the build plan's risk gradient — schema lands with the code that writes it, never ahead.

---

## Verification (how to test after each addition)

Per-phase end-to-end verification:

1. **After Phase 2 schema adds:** run `/admin/migrate`, verify `SELECT name FROM sqlite_master` lists the new tables, run the parser against 5 known `.cls` files from `/tests/fixtures/cls/`, confirm one row each in `class_descriptors` with expected `scoring_method` and `class_type`.
2. **After identity tables:** run `/admin/backfill --dry-run` against a past show, confirm confidence distribution is sane (mostly `exact-usef` or queued, not mass-fuzzy-merges).
3. **After rollup tables:** run rebuild cron manually, confirm `stats_rebuild_log` shows expected row counts, spot-check `rider_season_stats` for 3 known riders against their actual show history.
4. **After R2 archival:** run a week of shows, confirm one `.log.gz` per ring per day in R2 and matching row in `udp_log_shipments`, re-parse one archived `.cls` with `/admin/reparse-from-r2`.
5. **Shadow compare before readers cut over:** new stats endpoints run in parallel with the existing KV-computed stats for 1 week, any divergence >1% logged for review.

---

## Critical files

- `c:\Users\bwort\OneDrive\Documents\OneDrive\Desktop\westscoringrepo\west-scoring-live\west-worker.js` — migration array at ~line 1282, all new writers land here
- `c:\Users\bwort\OneDrive\Documents\OneDrive\Desktop\westscoringrepo\west-scoring-live\wrangler.toml` — R2 bucket binding to add when Phase 7 lands
- `c:\Users\bwort\OneDrive\Documents\OneDrive\Desktop\westscoringrepo\west-scoring-live\docs\v3-planning\V3-BUILD-PLAN.txt` — Addendum B (same D1, new tables) authoritative
- `c:\Users\bwort\OneDrive\Documents\OneDrive\Desktop\westscoringrepo\west-scoring-live\docs\v3-planning\STATS-MODULE-ADDENDUM.txt` — Alleys 1-7 drive every table design decision here
- `c:\Users\bwort\OneDrive\Documents\OneDrive\Desktop\westscoringrepo\west-scoring-live\docs\v3-planning\CLASS-RULES-CATALOG.txt` — quirk taxonomy feeds `parse_warnings.warning_code`
- `c:\Users\bwort\OneDrive\Documents\OneDrive\Desktop\westscoringrepo\west-scoring-live\CLS-FORMAT.md` — parser column spec, input to `class_descriptors`

---

## Summary — 14 new tables + 1 R2 bucket

**Identity (4):** `riders`, `horses`, `entry_identity_links`, `identity_review_queue`

**Descriptor (1):** `class_descriptors`

**Rollups (5):** `show_summary_stats`, `class_summary_stats`, `rider_season_stats`, `horse_season_stats`, `class_leaderboard`

**Observability (4):** `parse_warnings`, `unknown_quirks`, `stats_rebuild_log`, `udp_anomalies`

**Archival index (1):** `udp_log_shipments` (the D1 side of R2 archive)

**R2 bucket:** raw UDP logs + archived .cls files

Zero changes to existing 7 tables. One migration batch, staged writers, gradual reader cutover. All decisions trace back to the project's planning docs.
