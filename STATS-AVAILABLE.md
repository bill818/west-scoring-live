# WEST Scoring Live — Available Data & Stats Inventory
# Last updated: 2026-04-09 (Session 19 — per-round stats, show stats/search/weather endpoints,
#   hunterSeen tracking, equitation UDP, display page, show_weather D1 table)

Everything we currently collect, store, and can compute from.
This is what we HAVE — not aspirational. Reference this before building stats features.

---

## D1 DATABASE TABLES

### shows
- slug, name, venue, dates, location, year
- status (pending/active/complete)
- rings_count, stats_eligible
- created_at, updated_at

### rings
- ring_num, ring_name, sort_order, status
- Per show

### ring_activity
- date (YYYY-MM-DD per day per ring)
- first_post_at — operator started software / uploaded classes
- first_horse_at — first INTRO UDP signal (first horse entered ring)
- last_post_at — last .cls file change (last score posted)

### classes
- class_num, class_name, class_type (H/J/T/U)
- scoring_method — JUMPER: (2=II.2a, 3=3rounds, 4=speed, 6=speedII, 9=two-phase, 13=II.2b)
                   HUNTER: H[2] ClassMode (0=Over Fences, 1=Flat, 2=Derby, 3=Special)
- clock_precision — JUMPER: (0=thousandths, 1=hundredths, 2=whole)
                    HUNTER: H[5] ScoringType (0=Forced, 1=Scored, 2=Hi-Lo)
- is_fei, show_flags, sponsor
- scheduled_date, schedule_order, schedule_flag (S=scored, JO=jump order)
- hidden, stats_exclude
- status (active/complete)
- cls_raw — full raw .cls file content (re-parseable for any future need)
- final_results — pre-computed JSON frozen on CLASS_COMPLETE (rankings, per-judge, stats)
- created_at, updated_at

### entries
- entry_num, horse, rider, owner
- country (FEI 3-letter code from .cls col[4])
- sire, dam, city, state
- horse_fei, rider_fei (FEI/USEF registration numbers)
- Per class

### results
- round (1, 2, 3)
- time, jump_faults, time_faults, total
- place, status_code (EL, RF, WD, SC, DNS, DNF, OC)
- Per entry per round

---

## KV LIVE STATE (real-time, ephemeral)

### Per ring:
- active classes array (which classes are open in the ring)
- selected class (most recent Ctrl+A)
- on-course horse (entry, horse, rider, phase, elapsed, TA, round, label, faults, fpi/ti/ps)
- heartbeat (watcher alive signal, 120s TTL)
- latest UDP event

### Per class:
- classData (full parsed .cls with all entries and scores — live standings)
- results (pre-computed by Worker on every postClassData):
  - Hunter derby: per-judge phase cards {base, hiopt, bonus, phaseTotal}, per-judge
    ranks, judge card totals/ranks, movement, split decision flag
  - Hunter non-derby scored: per-judge scores {score, phaseTotal}, per-judge ranks
  - Jumper: structured round data + stats (clear count, fault buckets, leaderboard)
  - Table III / Faults Converted: isFaultsConverted flag, r1FinalTime (clock+jf+ps)
  - Frozen into D1 final_results on CLASS_COMPLETE
- orderOfGo (persisted to D1 when JO flag set in tsked, also in KV for live access)

### Pre-show stats (cached):
- prestats:slug:ring:classNum — cross-class horse data (5 min TTL)
  - Per horse: prior results at this show, total prize money, top 3 placings

### Recent completions:
- recent:slug:ring — classes completed within last 30 min (30 min TTL)

---

## WHAT WE CAN COMPUTE TODAY

### Ring Operations
- Ring daily schedule: first operator login, first horse, last score
- Ring duration per day (first_horse_at to last_post_at)
- Ring setup time (first_post_at to first_horse_at)
- Days of operation per ring per show
- Ring utilization patterns across show week

### Jumper Class Stats (pre-computed by Worker, stored in KV + D1 final_results)
- Total entries, competed, eliminated counts
- Clear round count and percentage
- Average faults per round
- Time fault count
- Average time (all entries), average clear time
- Fault distribution buckets (0-8 individual, 9-11 grouped, 12+, eliminated)
- Fastest 4-fault entry (horse, rider, time)
- TA values per round (from header)
- Optimum time + distance (method 6 / IV.1)
- Leaderboard with gap from leader (faults asc, time asc)
- Table III / Faults Converted: final time (clock + jump faults + penalty seconds), isFaultsConverted flag
- Per-round elimination status display (per scoring method rules)

### Hunter Class Stats (pre-computed by Worker)
- Per-judge per-round rankings (1-7+ judges confirmed)
- Judge card totals + ranks (R1+R2 per judge)
- R1/R2 overall ranks (aggregate across judges)
- Movement arrows (R1 rank vs final place)
- Split decision detection (top 3 positional disagreement)
- Derby: base + hiopt + bonus breakdown per phase per judge
- Non-derby scored: sequential judge scores per phase

### General Class Stats (from D1)
- DNS / DNF / WD / RF / EL / OC counts and percentages
- Prize money (from cls_raw @money rows)
- Class duration estimate (updated_at - created_at, rough)
- Entries per class
- Competed vs total (hasGone count)

### Scoring Method Analytics
- Performance by class type (speed vs JO vs two-phase vs optimum)
- Clear rates by scoring method
- Time fault rates by scoring method
- Optimum time distance (method 6 / IV.1): abs(time - (TA - 4)) per entry
- Average distance from optimum per class

### Entry/Horse/Rider Data (from D1 entries)
- Unique riders per class, per show
- Multi-ride riders (same rider, multiple horses)
- Horse breeding (sire x dam from .cls)
- Rider nationality (country code when available)
- City/State geography
- FEI/USEF registration numbers (horse_fei, rider_fei)
- Owner information
- Entry number (bib) — consistent across classes within a show

### Cross-Class Stats (from D1 — same show)
- Rider win record across classes at a show
- Horse appearances across classes
- Rider clear round % across all classes at show
- Most active riders (by class count)
- Owner activity (entries across classes)

### Show-Level Stats
- Total classes, entries, results
- Classes by type (jumper/hunter/unformatted)
- Classes by scoring method
- Completion rate (complete / total classes)
- Show duration (first ring_activity to last)
- Per-ring class counts and completion

### Schedule Data (from tsked)
- Classes per day
- Class order within each day (ring order)
- Schedule flags (S=scored, JO=jump order)

---

## WHAT WE HAVE BUT DON'T COMPUTE YET

### cls_raw — goldmine for future stats
The full .cls file is stored per class. This contains:
- All header settings (TA, faults per interval, penalty seconds, etc.)
- TIMY timestamps (CD start, ride start, ride end — per round per entry)
  NOTE: TIMY clock may not be synced to real time — use for relative timing only
- Precise fault formula parameters per round
- California split settings
- FEI class designation
- Ribbon counts, derby types
- All entry data including entries that haven't gone

### Things we can parse from cls_raw on demand:
- Exact ride duration per horse per round (TIMY ride_end - ride_start)
- Countdown duration (CD_start to ride_start)
- Pause/resume events during rides
- Time between horses (ride_end of one to CD_start of next)
- Course walk time estimate (gap between last horse of one class and first of next)
- Derby bonus points per judge (hunter)
- Multi-judge score breakdown (hunter)
- Two-round classic scoring (hunter)

### Weather (not stored yet)
- Open-Meteo API available (free, no key)
- show.html already fetches and caches in sessionStorage
- Could store daily weather snapshots in D1 for historical correlation

---

## WHAT WE CANNOT DO YET (needs new data sources)

### Needs manual admin input:
- Course designer name
- Judge name(s)
- Fence count per course
- Show-specific notes

### Needs USEF/FEI data:
- Horse age / birthyear
- Career history outside WEST shows
- Division classification
- National ranking

### Needs multiple shows:
- Rider career stats across shows
- Horse career stats across venues
- Venue comparison
- Season leaderboards
- Year-over-year trends
- Series points standings

### Needs per-fence data (not in Ryegate):
- Which fence causes most faults
- Fault patterns by position in course
- Individual fence timing

---

## DATA SECURITY NOTES

### Public (no auth):
- /getShows — show list (respects hideUpcoming setting)
- /getShow — show info + rings + start_date/end_date
- /getClasses — class list (hidden classes filtered)
- /getResults — pre-computed results (cls_raw NEVER sent to client)
  Priority: KV pre-computed → D1 final_results → D1 computed-fallback → D1 raw entries
- /getLiveClass — live state + pre-computed results + hunterSeen per active class
- /getShowStats — top riders, top horses, champions (from cls_raw), prize money leaders, entries per day
- /searchShow — search rider or horse across all classes at a show
- /getShowWeather — per-day weather for show dates (historical from Open-Meteo, cached in D1 show_weather table)
- /admin/settings — global settings (read only)

### Auth required:
- All /admin/* write endpoints
- /admin/shows — show list with admin fields
- /admin/dbStats — database counts

### RESOLVED:
- ✅ cls_raw stripped from /getResults — computation is server-side now
- Entry PII (city, state, FEI numbers) — currently public, decide if needs restricting
- ring_activity data — admin only or public?
- Business intelligence stats (show growth, retention) — admin only
