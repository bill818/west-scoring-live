# Jumper Stats — Design (Step 1)

Status: **DESIGN — paper-only**. No code changes yet. Step 2 implements
the migration + worker compute pass once Bill signs off on this shape.

Date: 2026-04-26 (Session 39)

---

## Goals

1. **Single read endpoint** — every jumper stat for a class comes from
   one call: `/v3/listJumperStats?class_id=N` returns one JSON blob.
2. **Real-time** — stats refresh inside `/v3/postCls` synchronously,
   same instant the new .cls bytes land. Pages just read.
3. **Mirrors hunter pattern** — `class_jumper_stats` table, computed
   by `computeJumperStats(env, classDbId)`, parallel to migration 018's
   `computeJudgeGridRanks` for the judges grid.
4. **Extensible** — adding new stats later is `ALTER TABLE ADD COLUMN`
   + update the compute function + run the recompute endpoint.

---

## Migration 020 — proposed schema

```sql
CREATE TABLE class_jumper_stats (
  class_id INTEGER PRIMARY KEY REFERENCES classes(id),

  -- Aggregate counts (across all entries in the class)
  total_entries             INTEGER NOT NULL DEFAULT 0,
  scratched                 INTEGER NOT NULL DEFAULT 0,
  eliminated                INTEGER NOT NULL DEFAULT 0,

  -- Per-round R1 stats
  r1_competed               INTEGER NOT NULL DEFAULT 0,
  r1_clears                 INTEGER NOT NULL DEFAULT 0,
  r1_time_faults            INTEGER NOT NULL DEFAULT 0,
  r1_avg_total_time         REAL,
  r1_avg_clear_time         REAL,
  r1_fastest_clear_entry_id INTEGER REFERENCES entries(id),
  r1_fastest_clear_time     REAL,
  r1_fault_buckets          TEXT,    -- JSON; see "Fault histogram" section

  -- Per-round R2 stats (mirror of R1; null on 1R classes)
  r2_competed               INTEGER NOT NULL DEFAULT 0,
  r2_clears                 INTEGER NOT NULL DEFAULT 0,
  r2_time_faults            INTEGER NOT NULL DEFAULT 0,
  r2_avg_total_time         REAL,
  r2_avg_clear_time         REAL,
  r2_fastest_clear_entry_id INTEGER REFERENCES entries(id),
  r2_fastest_clear_time     REAL,
  r2_fault_buckets          TEXT,

  -- Per-round R3 stats (mirror; null unless 3R+JO method)
  r3_competed               INTEGER NOT NULL DEFAULT 0,
  r3_clears                 INTEGER NOT NULL DEFAULT 0,
  r3_time_faults            INTEGER NOT NULL DEFAULT 0,
  r3_avg_total_time         REAL,
  r3_avg_clear_time         REAL,
  r3_fastest_clear_entry_id INTEGER REFERENCES entries(id),
  r3_fastest_clear_time     REAL,
  r3_fault_buckets          TEXT,

  -- Metadata
  computed_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- index already implied by PRIMARY KEY on class_id; explicit index
-- only needed if we add other lookup paths later.

```

### Why this shape

- **One row per class**, primary key on class_id. Easy single-row SELECT
  on read. UPSERT on compute (DELETE-then-INSERT pattern that
  computeJudgeGridRanks already uses).
- **Per-round numbered R1/R2/R3 columns** match how
  `entry_jumper_rounds` is structured. The label that the consumer
  shows (`R1` / `Phase 1` / `Jump Off` / `Winning Round`) comes from
  `WEST.format.roundLabel(method, modifier, n)` — same source of truth
  as everywhere else.
- **3R columns nullable** — most classes are 1R or 2R+JO. Defaults at
  0 / NULL keep the storage cheap and the consumer can detect
  "this class doesn't have an R3" by reading `cls.scoring_method` (the
  table doesn't need to know the method).
- **Fastest-clear stored as entry FK + denormalized time** — saves the
  client from a join on read. Time is denormalized so /v3/listJumperStats
  doesn't need to re-query the round row.
- **NOT NULL DEFAULT 0 on counts** — every class has a stats row even
  if no entries ever competed. Lets the read endpoint return a clean
  zeros blob instead of null/missing-row branching.

### What's NOT in v1 (extension targets)

These are deliberately deferred — easy to add later:
- **JO conversion / qualification rate** — derivable from per-round
  clears in the consumer. Could be denormalized into the table later
  if we find we want it cached.
- **Optimum-time stats** (method 6 / IV.1) — `abs(time - optimum)` per
  entry, average distance from optimum. Needs separate columns.
- **Fault distribution buckets** (0/4/8/12+/EL counts per round). Can
  add as `r1_faults_0`, `r1_faults_4`, etc. when we want the histogram.
- **Per-round place gap from leader** — needs the leader's score per
  round; either compute on read or store a per-entry derived column.
- **Two-phase specifics** (method 9) — phase 1 → phase 2 advancement
  is the same as JO conversion; no new column needed if we treat R2
  as "the next phase" generically.

---

## SQL — `computeJumperStats(env, classDbId)`

The compute function runs four queries and an UPSERT inside one
transaction-ish flow (D1 doesn't support multi-statement transactions
the way SQLite-CLI does, so we issue them serially per the existing
pattern in `computeJudgeGridRanks`).

### Query 1 — entry-level counts

```sql
-- total / scratched / eliminated for the whole class.
-- "scratched" = no entry_jumper_rounds rows, OR all rounds DNS/WD/SC
-- "eliminated" = at least one round with EL/RF/DNF status
SELECT
  COUNT(*) AS total_entries,
  SUM(CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM entry_jumper_rounds r
      WHERE r.entry_id = e.id
        AND r.status NOT IN ('DNS','WD','SC')
    ) THEN 1 ELSE 0
  END) AS scratched,
  SUM(CASE
    WHEN EXISTS (
      SELECT 1 FROM entry_jumper_rounds r
      WHERE r.entry_id = e.id
        AND r.status IN ('EL','RF','DNF')
    ) THEN 1 ELSE 0
  END) AS eliminated
FROM entries e
WHERE e.class_id = ?;
```

### Query 2 — per-round stats (run once per round 1/2/3)

Run for each round number where rounds might exist (1 always, 2 if
multi-round method, 3 if 3R+JO method). Easier just to run all three
unconditionally — empty rounds produce 0 counts, harmless.

```sql
-- competed, clears, time_faults, averages
SELECT
  COUNT(*) AS competed,
  SUM(CASE WHEN r.total_faults = 0 AND r.status IS NULL THEN 1 ELSE 0 END) AS clears,
  SUM(CASE WHEN r.time_faults > 0 THEN 1 ELSE 0 END) AS time_faults,
  AVG(r.total_time) AS avg_total_time,
  AVG(CASE WHEN r.total_faults = 0 AND r.status IS NULL THEN r.total_time END) AS avg_clear_time
FROM entry_jumper_rounds r
JOIN entries e ON e.id = r.entry_id
WHERE e.class_id = ?
  AND r.round = ?
  AND r.status NOT IN ('DNS','WD','SC');
```

### Query 3 — bucket counts per round (scheme-dependent)

Per-scheme `CASE WHEN` query. Same shape as Query 2 with one
`SUM(CASE …)` per bucket. Example for `standard` scheme:

```sql
SELECT
  SUM(CASE WHEN r.total_faults = 0 AND r.status IS NULL    THEN 1 ELSE 0 END) AS clear,
  SUM(CASE WHEN r.total_faults BETWEEN 1 AND 3             THEN 1 ELSE 0 END) AS flts1_3,
  SUM(CASE WHEN r.total_faults = 4                         THEN 1 ELSE 0 END) AS flts4,
  SUM(CASE WHEN r.total_faults BETWEEN 5 AND 7             THEN 1 ELSE 0 END) AS flts5_7,
  SUM(CASE WHEN r.total_faults = 8                         THEN 1 ELSE 0 END) AS flts8,
  SUM(CASE WHEN r.total_faults BETWEEN 9 AND 12            THEN 1 ELSE 0 END) AS flts9_12,
  SUM(CASE WHEN r.total_faults >= 13                       THEN 1 ELSE 0 END) AS flts13p,
  SUM(CASE WHEN r.status IN ('EL','RF','DNF','OC')         THEN 1 ELSE 0 END) AS elim
FROM entry_jumper_rounds r
JOIN entries e ON e.id = r.entry_id
WHERE e.class_id = ? AND r.round = ? AND r.status NOT IN ('DNS','WD','SC');
```

Worker code shapes the result into the JSON bucket object and writes
to `r{N}_fault_buckets`. Each scheme has its own SQL template and its
own bucket-label list. The column count in the SELECT can vary;
worker code is what assembles the JSON, not the schema.

### Query 4 — fastest clear (run once per round)

```sql
SELECT r.entry_id, r.total_time
FROM entry_jumper_rounds r
JOIN entries e ON e.id = r.entry_id
WHERE e.class_id = ?
  AND r.round = ?
  AND r.total_faults = 0
  AND r.status IS NULL
  AND r.total_time IS NOT NULL
ORDER BY r.total_time ASC
LIMIT 1;
```

### Query 5 — UPSERT into `class_jumper_stats`

```sql
INSERT INTO class_jumper_stats (
  class_id,
  total_entries, scratched, eliminated,
  r1_competed, r1_clears, r1_time_faults,
  r1_avg_total_time, r1_avg_clear_time,
  r1_fastest_clear_entry_id, r1_fastest_clear_time, r1_fault_buckets,
  r2_competed, r2_clears, r2_time_faults,
  r2_avg_total_time, r2_avg_clear_time,
  r2_fastest_clear_entry_id, r2_fastest_clear_time, r2_fault_buckets,
  r3_competed, r3_clears, r3_time_faults,
  r3_avg_total_time, r3_avg_clear_time,
  r3_fastest_clear_entry_id, r3_fastest_clear_time, r3_fault_buckets,
  computed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(class_id) DO UPDATE SET
  total_entries             = excluded.total_entries,
  scratched                 = excluded.scratched,
  eliminated                = excluded.eliminated,
  r1_competed               = excluded.r1_competed,
  r1_clears                 = excluded.r1_clears,
  r1_time_faults            = excluded.r1_time_faults,
  r1_avg_total_time         = excluded.r1_avg_total_time,
  r1_avg_clear_time         = excluded.r1_avg_clear_time,
  r1_fastest_clear_entry_id = excluded.r1_fastest_clear_entry_id,
  r1_fastest_clear_time     = excluded.r1_fastest_clear_time,
  r1_fault_buckets          = excluded.r1_fault_buckets,
  r2_competed               = excluded.r2_competed,
  r2_clears                 = excluded.r2_clears,
  r2_time_faults            = excluded.r2_time_faults,
  r2_avg_total_time         = excluded.r2_avg_total_time,
  r2_avg_clear_time         = excluded.r2_avg_clear_time,
  r2_fastest_clear_entry_id = excluded.r2_fastest_clear_entry_id,
  r2_fastest_clear_time     = excluded.r2_fastest_clear_time,
  r2_fault_buckets          = excluded.r2_fault_buckets,
  r3_competed               = excluded.r3_competed,
  r3_clears                 = excluded.r3_clears,
  r3_time_faults            = excluded.r3_time_faults,
  r3_avg_total_time         = excluded.r3_avg_total_time,
  r3_avg_clear_time         = excluded.r3_avg_clear_time,
  r3_fastest_clear_entry_id = excluded.r3_fastest_clear_entry_id,
  r3_fastest_clear_time     = excluded.r3_fastest_clear_time,
  r3_fault_buckets          = excluded.r3_fault_buckets,
  computed_at               = datetime('now');
```

---

## Read endpoint — `/v3/listJumperStats?class_id=N`

Returns:

```json
{
  "ok": true,
  "class": {
    "id": 7,
    "class_id": "7",
    "class_name": "$5,000 WELCOME JUMPER STAKE 1.40m II.2b",
    "class_type": "T",
    "scoring_method": 13,
    "scoring_modifier": null,
    "num_rounds": null,
    "r1_time_allowed": 79,
    "r2_time_allowed": 52,
    "r3_time_allowed": 30
  },
  "stats": {
    "total_entries": 12,
    "scratched": 1,
    "eliminated": 2,
    "rounds": [
      {
        "round": 1,
        "competed": 11,
        "clears": 5,
        "time_faults": 1,
        "avg_total_time": 70.4,
        "avg_clear_time": 67.8,
        "fastest_clear": {
          "entry_id": 102,
          "entry_num": "148",
          "horse_name": "GINOLA",
          "rider_name": "LAURA CHAPOT",
          "time": 67.46
        },
        "fault_buckets": {
          "scheme": "standard",
          "buckets": [
            { "label": "Clear",     "count": 5 },
            { "label": "1-3 flts",  "count": 1 },
            { "label": "4 flts",    "count": 2 },
            { "label": "5-7 flts",  "count": 0 },
            { "label": "8 flts",    "count": 1 },
            { "label": "9-12 flts", "count": 0 },
            { "label": "13+ flts",  "count": 0 },
            { "label": "EL/RF/OC",  "count": 2 }
          ]
        }
      },
      {
        "round": 2,
        "competed": 5,
        "clears": 2,
        "time_faults": 0,
        "avg_total_time": 32.4,
        "avg_clear_time": 31.8,
        "fastest_clear": {
          "entry_id": 102,
          "entry_num": "148",
          "horse_name": "GINOLA",
          "rider_name": "LAURA CHAPOT",
          "time": 31.20
        },
        "fault_buckets": {
          "scheme": "standard",
          "buckets": [
            { "label": "Clear",     "count": 2 },
            { "label": "1-3 flts",  "count": 0 },
            { "label": "4 flts",    "count": 2 },
            { "label": "5-7 flts",  "count": 0 },
            { "label": "8 flts",    "count": 0 },
            { "label": "9-12 flts", "count": 0 },
            { "label": "13+ flts",  "count": 0 },
            { "label": "EL/RF/OC",  "count": 1 }
          ]
        }
      }
    ]
  }
}
```

The endpoint joins `class_jumper_stats` to `entries` once for each
non-null `r{N}_fastest_clear_entry_id` to denormalize the horse/rider
into the JSON. The `class` block carries enough metadata that the
client can decide how to LABEL the rounds (R1/JO/Phase 2/etc.) via
existing `WEST.format.roundLabel`.

---

## Status code reference (for the SQL)

Status families used in the `CASE WHEN` filters:

- `'DNS'` — Did not start
- `'WD'`  — Withdrew
- `'SC'`  — Scratched

  → all three mean "didn't go"; rolls into `scratched` count;
    excluded from per-round `competed`.

- `'EL'`  — Eliminated
- `'RF'`  — Retired with fault
- `'DNF'` — Did not finish
- `'OC'`  — **Off course** (Bill 2026-04-26: treat as elimination —
  not "out of competition")

  → entry started but didn't complete cleanly; rolls into `eliminated`
    count; INCLUDED in per-round `competed` (they DID compete).

- `NULL` — clean ride.

`r.total_faults = 0 AND r.status IS NULL` → "true clear."

The SQL `eliminated` filter therefore reads:
`r.status IN ('EL','RF','DNF','OC')`

Cross-check against `v3/js/west-status.js` before step 2 to align the
SQL `IN` lists with the JS classification.

### Time-fault definition

`r.time_faults > 0` is the right filter for "this entry got time
faults." The .cls already calculated and stored the time-fault value
on each round; we don't recompute. For reference (per Bill 2026-04-26):

> Time faults = penalty for exceeding TA.
> Formula in Ryegate: `ceiling(round_time - TA) * faults_per_second`
> where `faults_per_second` comes from the .cls header.

Time-fault counting in stats is just `COUNT(*) WHERE time_faults > 0`
— jump faults can coexist (a horse can knock a rail AND exceed TA).
We're counting **entries that incurred time faults at all**, not
purely-time-fault eliminations.

---

## Hook into `/v3/postCls`

Same site as `computeJudgeGridRanks` is called today (after the
parser + UPSERTs, before the response). Branch on class_type:

```js
if (parsed.class_type === 'H' && classDbId) {
  // existing line
  await computeJudgeGridRanks(env, classDbId);
}
if ((parsed.class_type === 'J' || parsed.class_type === 'T') && classDbId) {
  await computeJumperStats(env, classDbId);
}
```

Failures log but don't fail the POST — raw data stays good, stats just
go stale until next post or a manual recompute.

---

## Safety-valve endpoint — `/v3/recomputeJumperStats`

Mirrors `/v3/recomputeJudgeRanks`:

- POST, body `{ class_id: N }` for one class
- POST, body `{ slug: 'X' }` to recompute all jumper classes in one show
- POST, body `{}` to recompute every jumper class in the DB

Used when raw rows change outside `/v3/postCls` (admin edit, direct D1
console, post-migration backfill). Idempotent.

---

## Backfill plan

Once migration 020 lands and computeJumperStats is wired:

1. Apply migration via D1 MCP.
2. Deploy worker.
3. `curl -X POST /v3/recomputeJumperStats -d '{}'` — populates all 51
   T classes (and any J classes) with stats. Hunter / U classes
   skipped automatically because the call sites only hit
   computeJumperStats for J/T parsed types.

---

## Resolved with Bill 2026-04-26

1. **`OC` = Off Course → elimination family.** Status filter
   `IN ('EL','RF','DNF','OC')` for `eliminated` count.
2. **Time faults = `r.time_faults > 0`.** Counts entries that
   exceeded TA (with or without jump faults). .cls stores the
   computed value; we don't recompute the formula.
3. **Histogram columns are IN.** Bill 2026-04-26 picked **A + C**:
   method-aware bucket definitions, JSON-column storage. Schemes
   detailed in the next section.

---

## Fault histogram — schemes + storage

### Storage

Three JSON columns added to `class_jumper_stats`, one per round:

```sql
r1_fault_buckets TEXT,   -- nullable JSON
r2_fault_buckets TEXT,
r3_fault_buckets TEXT,
```

Each holds the JSON output of the method-appropriate scheme:

```json
{
  "scheme": "standard",
  "buckets": [
    { "label": "Clear", "count": 5 },
    { "label": "4 flts", "count": 3 },
    { "label": "8 flts", "count": 1 },
    { "label": "9-12 flts", "count": 1 },
    { "label": "13+ flts", "count": 0 },
    { "label": "EL/RF/OC", "count": 2 }
  ]
}
```

Frontend reads `buckets` directly — labels + counts pre-computed; no
need to know the scheme's internal logic. NULL when the scheme is
skipped (gamblers / equitation / etc. — see below).

### Schemes

Selected by `cls.scoring_method`:

#### `standard` — methods 2, 3, 8, 9, 10, 11, 13, 14, 15
Table II / II.2 family (most jumper classes). Faults are integer-add:
4 per rail, +1 per second over TA.

| Bucket | Filter | Notes |
|---|---|---|
| Clear      | `total_faults = 0 AND status IS NULL`                | clean ride |
| 1-3 flts   | `total_faults BETWEEN 1 AND 3`                       | time faults only, no rail |
| 4 flts     | `total_faults = 4`                                   | one rail clean |
| 5-7 flts   | `total_faults BETWEEN 5 AND 7`                       | one rail + time faults |
| 8 flts     | `total_faults = 8`                                   | two rails clean |
| 9-12 flts  | `total_faults BETWEEN 9 AND 12`                      | two+ rails with TF, or three rails |
| 13+ flts   | `total_faults >= 13`                                 | tail |
| EL/RF/OC   | `status IN ('EL','RF','DNF','OC')`                   | killed off course |

The 1-3 / 5-7 split tells a richer story: time-fault-only entries are
distinguishable from clean-rail entries; rail-plus-time entries
distinguishable from clean two-rail entries. Total: 8 buckets for
standard scheme.

#### `speed` — methods 0, 4
Table III / II.1 — faults converted to time. Jump faults add time
penalty; total_faults can be 0 even with rails. Use `jump_faults` for
the histogram axis instead:

| Bucket | Filter |
|---|---|
| Clean      | `jump_faults = 0 AND status IS NULL` |
| 1 rail (4) | `jump_faults BETWEEN 1 AND 4` |
| 2 rails (8)| `jump_faults BETWEEN 5 AND 8` |
| 3+ rails   | `jump_faults >= 9` |
| EL/RF/OC   | `status IN ('EL','RF','DNF','OC')` |

#### `optimum` — method 6 (IV.1)
Score is distance from optimum time (TA − 4 per FEI). Buckets by
`abs(total_time − (r1_time_allowed − 4))`:

| Bucket | Filter |
|---|---|
| 0-1s     | `abs_dist <= 1` |
| 1-3s     | `abs_dist > 1 AND <= 3` |
| 3-5s     | `abs_dist > 3 AND <= 5` |
| 5+s      | `abs_dist > 5` |
| EL/RF/OC | `status IN ('EL','RF','DNF','OC')` |

(Method 6 with modifier=1 promotes to 2-round; in that case R1 uses
the `optimum` scheme and R2 uses `standard` — JO follows normal
fault rules.)

#### `none` — methods 5, 7
Gamblers Choice (5) and Timed Equitation (7) — fault buckets aren't
meaningful (gamblers is points-positive, equitation is subjective
score). Histogram skipped: JSON column = NULL. Frontend hides the
chip strip / shows class-appropriate stats only (clears / eliminated
counts still live in the main columns).

### Scheme dispatch (worker code sketch)

```js
function bucketSchemeFor(method) {
  if ([2,3,8,9,10,11,13,14,15].includes(method)) return 'standard';
  if ([0,4].includes(method))                    return 'speed';
  if (method === 6)                              return 'optimum';
  return 'none';   // 5, 7, anything unknown
}
```

For multi-round methods, `bucketSchemeFor` is applied per-round —
method 6+modifier=1 means R1 uses `optimum`, R2 uses `standard`.

### Adding a new scheme later

ALTER not required. New scheme = code change only:
1. Add the new id (e.g. `'pony-jumper'`) to the dispatch table.
2. Add the bucket logic to computeJumperStats.
3. Run `/v3/recomputeJumperStats` to backfill JSON for affected
   classes.

The schema (3 TEXT columns) stays the same; only the data inside
flexes.

### Rendering rule — hide zero-count buckets

Compute always writes EVERY bucket the scheme defines, even when
`count = 0`. This keeps the data consistent class-to-class and lets
us add new buckets without recomputing old ones.

**The frontend filters at render time:** when displaying the
histogram, drop any bucket where `count === 0` so the chip strip
doesn't carry empty slots ("0 with 13+ flts" / "0 EL"). Typical
intermediate-level class might end up showing only 4-5 of the 8
buckets — clutter-free.

This rule applies to every scheme. Computed JSON is canonical
(comparison-friendly across classes); display is filtered (clean
visual). One source of truth, two presentations.

---

## Step 2 checklist (do not start until step 1 signed off)

- [ ] Write `v3/migrations/020_class_jumper_stats.sql`
- [ ] Implement `computeJumperStats(env, classDbId)` in west-worker.js
- [ ] Hook into `/v3/postCls` jumper branch
- [ ] Implement `/v3/recomputeJumperStats` endpoint (single-class +
      slug + all-at-once forms)
- [ ] Apply migration to D1
- [ ] Deploy worker
- [ ] Backfill: `curl /v3/recomputeJumperStats -d '{}'`
- [ ] Spot-check: SELECT a populated row for class 7 and verify the
      math against `/v3/listEntries`.

Step 3 (read endpoint + frontend chips) only after step 2 is solid.
