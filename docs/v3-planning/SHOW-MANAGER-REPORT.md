# Show Manager Operational Report — Design

Status: **DEFERRED — gated on engine UDP wiring.** Migration 023 lays
the schema rails (nullable timestamp columns on `classes`) so when the
engine starts emitting RIDE_START / FINISH UDP events, the data has
somewhere to land. Endpoint + UI are sketched here for the future
session that builds them.

Date: 2026-04-27 (Session 40)
Companion to: `docs/v3-planning/JUMPER-STATS-DESIGN.md` (per-class
stats), the brainstorm in `STATS-BRAINSTORM.md`, and the inventory in
`STATS-AVAILABLE.md`.

---

## Audience

This report is for **show management** — the people running the show,
not the public. Different intent than the public-facing show stats
(top riders, championships, etc. — those ship today as
`/v3/listShowJumperStats`).

The manager wants operational intelligence:
- How are my rings running?
- Are we on schedule?
- Where are the delays?
- What's the day's throughput?

Not "who won the Grand Prix" — they were standing there.

---

## Stats sections

### Per-ring per-day operational frame
- **Ring start time** — first horse on course (UDP RIDE_START)
- **Ring end time** — last horse off course (UDP FINISH)
- **Ring active hours** — first_ride to last_finish span
- **Setup time** — operator login (first_post_at) → first horse
  (first_ride_at). Tells you how much "warming up" happens before
  competition starts.
- **Idle time** — gaps between classes (last_finish of class N →
  first_ride of class N+1). Course-walk + reset windows.
- **Throughput** — horses per hour averaged across the day.

### Per-class duration breakdown
- **Class duration** — first_ride_at → last_finish_at per class.
- **Time per horse** — class duration / horses competed.
- **Average gap between horses** — class-internal pacing (FINISH of
  ride N → RIDE_START of ride N+1).
- **Longest gap** — diagnostic for delays (mechanical issue, course
  reset, fault inquiry, etc.).
- **Estimated remaining time** — for in-progress classes, projected
  finish based on horses remaining × running average.

### Show-wide rollups
- **Show duration** — first ring activity → last ring activity across
  all rings, all days.
- **Classes per day** — completed count, aggregate horses competed.
- **Ring efficiency comparison** — horses/hour by ring, ring-day.
- **Schedule adherence** — scheduled_date vs actual completion date.
- **Late-running classes** — classes that ran X% over a baseline pace.

### Diagnostic pulls
- **Longest gaps across the show** — top N "what happened during this
  long gap?" — for retrospectives.
- **Operator activity windows** — first_post_at to last_post_at per
  ring per day (setup → teardown). Helps planning operator coverage.

---

## Schema needs

### Already in place (migration 023, today)
- `classes.first_ride_at`    TEXT (ISO timestamp) — populated by engine RIDE_START
- `classes.last_finish_at`   TEXT (ISO timestamp) — populated by engine FINISH
- `classes.duration_seconds` REAL — computed from above

### Existing fields used
- `classes.first_seen_at`    TEXT — when watcher first POSTed (rough operator-online proxy)
- `classes.parsed_at`        TEXT — last cls update (rough activity proxy)
- `classes.scheduled_date`   TEXT — operator-set schedule
- `entry_jumper_summary.ride_order` — go order, derivable per-class

### Future additions when richer UDP arrives
- `entry_jumper_rounds.ride_start_at` TEXT — per-entry per-round RIDE_START
- `entry_jumper_rounds.ride_end_at`   TEXT — per-entry per-round FINISH
  These enable per-ride pacing, time-between-horses, and exact
  per-class duration. Defer until UDP capture is solid; columns can
  be added without disturbing anything else.

---

## Endpoint sketch — `/v3/listShowReport?slug=X`

Same shape as `/v3/listShowJumperStats` but admin-flavored:

```json
{
  "ok": true,
  "show": { "slug", "name", "start_date", "end_date" },
  "report": {
    "show_duration": { "first_activity": "...", "last_activity": "...", "hours": 38.2 },
    "rings": [
      {
        "ring_num": 1,
        "ring_name": "Jumper 1",
        "days": [
          {
            "date": "2026-09-11",
            "first_ride_at": "...",
            "last_finish_at": "...",
            "active_hours": 6.3,
            "setup_minutes": 22,
            "horses_competed": 87,
            "horses_per_hour": 13.8,
            "classes": [
              {
                "class_id": 7,
                "class_name": "...",
                "first_ride_at": "...",
                "last_finish_at": "...",
                "duration_minutes": 47,
                "horses_competed": 31,
                "avg_gap_seconds": 41,
                "longest_gap_seconds": 312
              }
            ]
          }
        ]
      }
    ],
    "schedule_adherence": [...],
    "longest_gaps": [{ "class_id", "gap_seconds", "after_entry", "before_entry" }, ...]
  }
}
```

Auth: `X-West-Key` (admin path). Public endpoint stays at
`/v3/listShowJumperStats` — distinct surfaces.

Compute: on-read with ETag, same pattern as the public stats endpoint.
A few JOINs across `classes` + `entry_jumper_rounds` + `entries`.
Cached cheaply via `If-None-Match`.

---

## UI direction

Two options when this lands:

**A. Section on `admin.html`** — manager report becomes a panel inside
the existing operator tool. Auth already required. Lives next to the
show / ring management.

**B. Dedicated `report.html?slug=X`** — its own page, admin-locked.
Bookmarkable, sharable internally. Same lens-tinted hero as the public
pages so it feels consistent.

My instinct: **B** for the long form. Easier to print/export later
("year-end show summary PDF" lives one step away), keeps `admin.html`
focused on CRUD operations, and bookmarkable URLs are useful for show
management workflow. But **A** could be the v1 if the report stays
short — easy to graduate.

---

## Trigger

Build this when:

1. Engine UDP capture is solid (RIDE_START + FINISH events flowing
   reliably from a real show)
2. `classes.first_ride_at` / `last_finish_at` start populating from
   the engine's POST path
3. (Optional) `entry_jumper_rounds.ride_start_at` / `ride_end_at`
   migration lands for per-ride pacing

Until then: the columns exist, NULL is rendered as "—" by any
report-y consumer, and the design lives here.

---

## What does NOT live in the manager report

- **Public competitive stats** — top riders, top horses, championships,
  multi-ride riders. Those are at `/v3/listShowJumperStats` and render
  on `show.html` for everyone. The manager already saw the results;
  they need operational intel, not a leaderboard.
- **Cross-show / season analytics** — Phase B work in
  STATS-BRAINSTORM.md (year-over-year, exhibitor retention, growth).
  Those need multiple shows of data and an identity-resolution layer
  first.
- **Per-fence / per-jump diagnostics** — Ryegate doesn't capture this.
  Out of scope unless the data source changes.
