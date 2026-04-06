# WEST Scoring Live — Stats & Analytics Brainstorm
## All ideas from Session 12 — save everything, implement over time

---

## THE BIG PICTURE

Everything here is pure interpretation of data we already own.
No copying Ryegate — they show results. We show results PLUS live data,
stats, weather, trends, analytics, and historical comparisons.
The data moat builds over time — after one season we have something
no one else has. After three seasons it's genuinely irreplaceable.

---

## LIVE / REAL-TIME STATS (during show)
- Current ring status across all rings simultaneously
- How many horses have gone today across all rings
- Average time between horses per ring (pacing — is ring running on time?)
- Estimated time to class completion based on current pace
- Live fault rate for current class
- On-deck queue across all rings
- Which rings have active watchers (heartbeat monitor)

---

## CLASS STATS
- Clear round percentage R1
- Jump off qualification rate
- Clear round percentage JO
- Average elapsed time vs TA
- Fastest clear round
- Slowest clear round
- Class duration (first RIDE_START to last FINISH — exact timestamps)
- Average time between horses (FINISH to next RIDE_START)
- Longest gap between horses (tells you when ring had a delay)
- Classes that ran over estimated time
- Classes with high scratch rate
- Classes where TA was too tight (high time fault rate)
- DNS / DNF / WD / RF / EL counts and percentages
- Prize money offered and distribution
- Sponsor display
- Number of entries scratched after drawn

---

## TA ANALYSIS — valuable for course designers
- Average elapsed vs TA across all classes at a venue
- Percentage of horses that exceeded TA by class type
- TA accuracy rating per course designer (if we track who set course)
- Optimal TA suggestions based on historical data at that venue
- Classes where >50% of horses got time faults (TA too tight)
- Classes where 0 horses got time faults (TA generous)
- Time fault rate trends over seasons

---

## JUMP OFF ANALYSIS
- JO conversion rate — clear rounds that led to JO
- Average JO time vs R1 time (how much faster do horses go?)
- JO clear percentage vs R1 clear percentage
- Time savings in JO — most aggressive riders vs most conservative
- Average time ratio JO/R1 by rider

---

## RIDER STATS
- Win record by year
- Win record by venue
- Clear round percentage overall and by class level
- Multiple rides per show (how many horses)
- Most ridden horse combinations
- Home state / country
- Year over year improvement
- Best horse partnership (consistent low times together)
- Venues competed at
- Shows per season
- Average time ratio (elapsed/TA) — aggressive vs conservative style
- Fault patterns — more faults in JO than R1?
- Head-to-head record between two riders
- Best performance by time of day
- Performance trend over season
- Home venue advantage — do they perform better at certain venues?

---

## HORSE STATS
- Win record overall and by venue
- Clear round percentage
- Average time vs TA across shows
- Best time ever (overall and per venue)
- Consistent performer score (low variance in times)
- Multiple riders — has this horse been shown by different riders?
- Performance under different riders
- Shows competed at
- Career timeline
- Age performance curve (needs birthyear field — add to schema later)
- Class level progression (moving up from 1.10m to 1.20m over time)
- Comeback metric — competed last year and this year

---

## OWNER STATS
- Horses in competition
- Win record
- Venues competed at
- Most successful horse
- Riders used
- Prize money won (proxy ROI)
- Year over year activity
- Most active owners by entries

---

## VENUE / COURSE ANALYTICS
- Average clear round percentage by venue
- Average fault rate by venue
- Fastest venue (horses consistently run faster here — quantifiable)
- Time fault rate by venue (course design tendencies)
- Ring productivity — classes per day, horses per hour
- Weather impact at that specific venue (temp vs clear round rate)
- Venue speed profiles vs other venues
- Best time at this venue ever (all time record)

---

## WEATHER CORRELATION — unique data no one else has
- Clear round % by temperature range (buckets: <60, 60-70, 70-80, 80-90, 90+)
- Fault rate on rainy days vs dry days
- Time of day performance (morning vs afternoon heat)
- Wind impact
- Seasonal performance trends
- "Horses go 4% slower when temp exceeds 85°F at this venue"
- Open-Meteo API — free, no key, historical + forecast

---

## SERIES / POINTS STANDINGS
- Automatic standings if WEST runs a points series
- Points by division
- Leading horse/rider combinations
- Qualification tracking for championships
- Year end awards projection
- Division champion tracking

---

## SHOW GROWTH / BUSINESS INTELLIGENCE (admin only)
- Entries per show over time — is the show growing?
- New exhibitors per show (first time ever in data)
- Returning exhibitor rate (retention %)
- Geographic reach — states and countries represented
- Revenue proxy — prize money total per show
- Class fill rate (entries vs capacity)
- Which divisions growing vs shrinking
- Show comparison — this week vs same week last year
- Venue comparison — same class at different venues
- Division health — is 1.10m more competitive than last year?

---

## COMPARATIVE ANALYTICS
- This show vs same show last year
- Venue comparison for same class type
- Division competitiveness over time
- National average comparison (if USEF data available later)
- Course designer comparison (TA accuracy, fault rates)

---

## THE COMPELLING PUBLIC-FACING STORIES
These are the stats that make people share the page:
- "PROMISED LAND TOO has won 7 of 12 classes this season"
- "TRACY FENNEY averages 94% of TA in jump offs"
- "Ocala Ring 1 has a 34% clear round rate this season"
- "This show is running 23% larger than same week last year"
- "Temperature above 85°F correlates with 12% more faults at this venue"
- "COPPERFIELD GHV Z is on a 5-show podium streak"
- "Ring 2 averages 47 minutes per class — fastest at this venue"

---

## DATA BEYOND THE WEBSITE
- Season-end reports for show management
- Division performance reports for course designers
- Year-end awards data — automatic from D1
- Exhibitor activity reports for show office
- Prize money distribution reports

---

## THINGS THAT NEED NEW SCHEMA FIELDS
Currently missing, needed for full stats:

| Field | Table | Source | Priority |
|-------|-------|--------|----------|
| country | entries | Ryegate .cls or USEF | High |
| state | entries | Ryegate .cls or USEF | High |
| birthyear | entries (horse) | manual or USEF | Low |
| course_designer | classes | manual admin entry | Medium |
| judge_name | classes | manual admin entry (hunter) | Medium |
| prize_money | classes | .cls @prize rows (already parsed) | High |
| scratches | classes | count WD/SC statusCodes | High |
| duration_seconds | classes | calculated from timestamps | High |
| first_ride_at | classes | RIDE_START timestamp | High |
| last_finish_at | classes | FINISH timestamp | High |
| fence_count | classes | .cls header (already have it) | Medium |

Already added to schema: country, state (entries), judge_name, prize_money,
scratches, duration_seconds, first_ride_at, last_finish_at (classes)

---

## FUTURE — NEEDS OWN SOFTWARE
- Per-fence fault statistics (which fence caused most falls)
- Individual fence timing
- Course walk data
- Video integration

---

## STATS PAGE STRUCTURE (proposed)

Two modes:
- PUBLIC: horse/rider lookups, show results, leaderboards, weather
- ADMIN: business intelligence, show growth, revenue proxies, retention

Public stats pages:
- /stats — overview, featured stats, trending horses
- /stats/horse?name=XXX — horse profile page
- /stats/rider?name=XXX — rider profile page  
- /stats/venue?slug=XXX — venue profile
- /stats/show?slug=XXX — show summary stats
- /stats/season?year=2026 — season leaderboards

---

## IMPLEMENTATION STRATEGY — decided 2026-03-31

Two phases:

### Phase A — Client-side stats (April 15 MVP)
Stats computed in the browser from `/getResults` data. Same approach as the
old scraping site's stats.html but wired to our D1-backed Worker endpoints.
Covers per-class stats: clear round %, fault distribution, course difficulty,
time analysis, standings with gap-to-leader, multi-rider detection, country flags.
Quick to build, works with existing endpoints, no new Worker code needed.
**Limitation:** single-class scope only. Cannot do cross-class, cross-show,
rider career, or historical trend stats.

### Phase B — Server-side stats (Devon / post-season)
New `/getStats` Worker endpoints with D1 queries that aggregate across classes,
shows, and seasons. Enables the big-picture stats from this brainstorm:
rider/horse career profiles, venue analytics, weather correlation, series
standings, year-over-year trends. Needs new Worker endpoints + D1 queries.
Only becomes meaningful after data accumulates over multiple shows.

**DATA SECURITY NOTE:** Phase B exposes aggregated data via public API endpoints.
Need to decide what's public vs admin-only before building. Some stats
(business intelligence, show growth, retention rates) should stay behind auth.
Public stats (rider records, class results, venue profiles) are fine.
Review this before implementing Phase B endpoints.

D1 data accumulates from day one regardless of which phase we're in —
every show scored through the watcher feeds the future stats engine.

---

Last updated: Session 17 — 2026-03-31
