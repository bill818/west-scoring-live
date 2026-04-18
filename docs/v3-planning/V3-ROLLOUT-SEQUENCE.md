============================================================
  WEST SCORING LIVE — V3 ROLLOUT SEQUENCE
  Operator-facing deployment stages
  Written 2026-04-18 (Session 24)
  Status: PLANNING — not yet in execution
============================================================

PURPOSE
-------
This doc describes the v3 rollout as an OPERATOR experiences
it — what gets deployed and in what order. The companion doc
V3-BUILD-PLAN.txt describes the code-architecture phases
(modules, abstractions, transport swap). This doc describes
the feature stages.

Each stage builds on the prior. Don't skip stages.


============================================================
  NAMING DECISION — LOCKED 2026-04-18
============================================================

  "watcher" is now "WEST ENGINE" (v3 forward)

  The scoring-PC component has outgrown its name. In v1 it
  watched files and reported what it saw. In v3 it:

    - Converts proprietary Ryegate formats into normalized
      web-ready data (translation)
    - Drives the entire WEST platform — Worker, Durable
      Objects, 8 frontend pages, stats (propulsion)
    - Commands the clock — heartbeat is the authority,
      browsers obey (authority)
    - Runs continuously while the show is on (engine duty cycle)
    - Pushes data upstream, never responds to requests
      (not a server)

  "Engine" is precise: it converts one form of energy into
  another and drives a larger system. The scoring PC operator
  doesn't need to understand WebSocket architecture — they
  need to know "start the engine, it drives the website."

  Naming alternatives considered and rejected:
    - "server" — wrong direction (doesn't accept connections)
    - "bridge" — sounds like passive plumbing
    - "gateway" — too enterprise
    - "source" — sounds like source code
    - "agent" — overloaded in AI context
    - "relay" — undersells the intelligence

  File rename plan:
    west-watcher.js  →  west-engine.js
    start-watcher.bat → start-engine.bat
    deploy/west-watcher-v1.0/ → deploy/west-engine-v1.0/
    (v1.x watcher files kept as-is for field-deployed
     backwards compatibility until v3 cuts over)


============================================================
  STAGE 1 — DATABASE & SHOW SETUP
============================================================

  What the operator does:
    Open admin page → Create Show → fill in name, slug,
    dates, venue, location, stats_eligible flag

  What's built:
    - D1 shows table (exists today)
    - /admin/createShow endpoint (exists, needs v3 cleanup)
    - Admin UI show creation form (exists, needs v3 polish)

  Acceptance:
    - Operator can create a show from the admin page
    - Show appears in the index with correct metadata
    - Slug is validated (no spaces, lowercase, unique)

  Maps to: V3-BUILD-PLAN.txt Phase 0 (preparation)
  Maps to: DATABASE-SCHEMA-EXPANSION.md shows table


============================================================
  STAGE 2 — RING CONFIGURATION
============================================================

  What the operator does:
    Open show in admin → Add Ring(s) → name each ring

  What's built:
    - D1 rings table (exists today)
    - /admin/upsertRing endpoint (exists)
    - Admin UI ring management (exists, needs v3 polish)

  Acceptance:
    - Operator can add 1-N rings to a show
    - Each ring has a name and maps to a physical location
    - Ring list shows on the show page

  Maps to: DATABASE-SCHEMA-EXPANSION.md rings table


============================================================
  STAGE 3 — ENGINE CONNECTION (scoring PC setup)
============================================================

  What the operator does:
    On scoring PC: install Node.js, copy west-engine folder,
    edit config.json (slug, ring, worker URL, auth key),
    start the engine

  What's built:
    - west-engine.js (renamed from west-watcher.js)
    - config.json with slug, ring, workerUrl, authKey
    - start-engine.bat with auto-restart loop
    - Heartbeat POST to worker every 10s (active) / 60s (idle)
    - Admin page shows engine status (alive/dead, last heartbeat)
    - Funnel setup if single-PC (RSServer coexistence)

  Acceptance:
    - Engine starts, connects to worker, heartbeat visible
    - Admin page shows green "Engine Alive" indicator
    - Ring correctly associated with this engine instance
    - If engine stops, admin shows warning within 60s

  Maps to: V3-BUILD-PLAN.txt Phase 7 (watcher interface unchanged)
  Maps to: deploy/west-engine-v1.0/ README


============================================================
  STAGE 4 — CLASS RESULTS PIPELINE
============================================================

  What the operator does:
    Run classes in Ryegate as normal. Results appear on website
    automatically.

  What's built:
    - Engine reads .cls files, parses hunter/jumper/equitation
    - Engine posts parsed data to worker via /postClassData
    - Worker runs computeClassResults() — pre-computes rankings,
      per-judge breakdowns, final standings
    - /getResults endpoint serves computed results
    - results.html renders standings, ribbons, breakdowns
    - D1 stores permanent results on CLASS_COMPLETE

  Acceptance:
    - Operator runs a class through Ryegate
    - Results appear on website within seconds of .cls write
    - Hunter (all modes), jumper (all 16 methods), equitation
      all render correctly
    - Completed class results persist in D1

  This is the MINIMUM VIABLE "results are online" state.

  Maps to: V3-BUILD-PLAN.txt Phase 2 (west-rules.js, .cls parser)
  Maps to: CLASS-RULES-CATALOG.txt


============================================================
  STAGE 5 — CLASS STATS PIPELINE
============================================================

  What the operator does:
    Nothing new — stats compute automatically from results data.

  What's built:
    - Worker computes per-class stats alongside results:
      clear round %, fault distribution buckets, time stats,
      fastest/slowest clear, TA accuracy, JO qualification rate
    - /getResults includes stats block
    - stats.html renders class analytics:
      difficulty gauge, fault distribution bars, gap column,
      multi-ride rider callouts, per-round separation

  Acceptance:
    - After a class completes, stats page shows full analytics
    - During a live class, stats update in real-time
    - Fault distribution, clear %, and time stats are accurate

  Maps to: V3-BUILD-PLAN.txt Phase 5 (west-stats.js live half)
  Maps to: STATS-MODULE-ADDENDUM.txt WEST.stats.live.*


============================================================
  STAGE 6 — LIVE CLOCK & ON-COURSE
============================================================

  What the operator does:
    Nothing new — live data flows automatically while engine
    runs during a class.

  What's built:
    - Engine pushes 1Hz heartbeat with full clock snapshot:
      { phase, elapsed, countdown, entry, ta, jumpFaults, rank }
    - WebSocket via Durable Object (one DO per ring):
      engine POSTs to DO, DO broadcasts to all connected browsers
    - On-course card: horse name, rider, entry number, live clock
    - Phase detection: IDLE → INTRO → CD → ONCOURSE → FINISH
    - Post-FINISH lock (5s suppress for Farmtek oscillation)
    - Browser trusts heartbeat absolutely — no interpolation

  Acceptance:
    - Horse goes on course → on-course card appears within 1s
    - Clock ticks smoothly at 1Hz, matches scoreboard exactly
    - Phase transitions (countdown → on-course → finish) are
      clean with no flicker
    - 500 connected browsers all see the same clock value

  Maps to: V3-BUILD-PLAN.txt Phase 7-8 (DO backend + WS swap)
  Maps to: WEBSOCKETS-OVERVIEW.txt
  Maps to: UDP-PROTOCOL-REFERENCE.md (clock behavior section)


============================================================
  STAGE 7 — LIVE PAGES & STATS WORKING
============================================================

  What the operator does:
    Share the website URL. Spectators open on their phones.

  What's built:
    - live.html: real-time standings, on-course card, recent
      results, OOG remaining, movement arrows, per-judge
      breakdowns. WebSocket push (polling fallback).
    - stats.html: live strip at top (mini on-course card),
      difficulty gauge, fault distribution, gap column,
      per-round separation, multi-ride callouts.
    - results.html: final results for completed classes with
      ribbons, standings, detailed breakdowns.
    - classes.html: class list with live/complete badges
    - Adaptive polling fallback for non-WS clients

  Acceptance:
    - Parent on phone sees live on-course card + clock
    - Coach at gate sees standings update as each horse finishes
    - Stats page shows difficulty gauge during live class
    - All pages degrade gracefully on bad network (stale badge)

  Maps to: V3-BUILD-PLAN.txt Phase 6 + 8 (data layer + WS swap)
  Maps to: PAGE-INTENT.md (temporal triad: live/display/stats)


============================================================
  STAGE 8 — DISPLAY PAGE
============================================================

  What the operator does:
    Open display.html on a TV/projector at the in-gate or
    spectator area.

  What's built:
    - display.html: dark theme (#0a0e1a), 3-column layout
      (OOG left, standings center, on-course/finish right)
    - Auto-scrolling standings (news ticker style)
    - Gold (#fbbf24) for active elements (not red)
    - Progress counter at top
    - Multi-ring cycling (subscribe to multiple DOs)
    - Announcer mode: hold score visible 8s while new
      on-course arrives
    - No interactivity — display only, no clicks needed

  Acceptance:
    - TV at in-gate shows live class with auto-scroll
    - On-course card dominates right column with large clock
    - Standings scroll smoothly, no flicker on updates
    - Works unattended for hours (no sleep, no timeout)

  Maps to: PAGE-INTENT.md (display intent section)


============================================================
  STAGE 9 — SHOW-LEVEL STATS
============================================================

  What the operator does:
    Open show page to see aggregate stats for the entire show.

  What's built:
    - /getShowStats endpoint: aggregates across all classes
    - Show summary: total classes, entries, completion rate,
      per-ring counts, prize money totals
    - Ring productivity: classes/day, horses/hour, setup time
    - Daily breakdown: classes per day, entries per day
    - Weather overlay (Open-Meteo integration, existing)

  Acceptance:
    - Show page displays aggregate stats
    - Stats update as classes complete throughout the show
    - Ring productivity numbers help operator plan schedule

  Maps to: V3-BUILD-PLAN.txt Phase 9 (historical stats)
  Maps to: DATABASE-SCHEMA-EXPANSION.md show_summary_stats


============================================================
  STAGE 10 — CROSS-SHOW RIDER & HORSE STATS
============================================================

  What the operator does:
    Search for a rider or horse on the platform. See career
    stats across all shows.

  What's built:
    - Rider identity resolution:
      USEF ID (primary) → normalized name+city (fallback)
      rider_aliases table for merged identities
    - Horse identity resolution (same pattern)
    - Season stats: wins, top-3 finishes, clear round %,
      earnings, average rank, best divisions
    - Career timeline: performance over time
    - Head-to-head comparisons between riders
    - Multi-show leaderboards / series standings
    - Rollup tables rebuilt nightly (2am ET cron) +
      15-min incremental during active shows

  Acceptance:
    - After 3+ shows of data: rider search returns career stats
    - Horse profile shows performance across venues
    - Head-to-head comparison works for any two riders
    - Stats are accurate across identity merges (same rider,
      different name spellings)

  REQUIRES: Multiple shows of accumulated data before this
  stage is meaningful. Build the infrastructure early, but
  the value grows with every show.

  Maps to: V3-BUILD-PLAN.txt Phase 9
  Maps to: STATS-MODULE-ADDENDUM.txt WEST.stats.history.*
  Maps to: DATABASE-SCHEMA-EXPANSION.md (riders, horses,
           rider_season_stats, horse_season_stats tables)
  Maps to: STATS-BRAINSTORM.md Phase B


============================================================
  STAGE 11 — EXTERNAL DATABASE INTEGRATION
============================================================

  What the operator does:
    Nothing — enrichment happens automatically when rider/horse
    profiles are viewed.

  What's built:
    - FEI database integration:
      Horse international records, FEI rankings, career history,
      competition results from FEI's public data
    - USEF database integration:
      National rankings, zone standings, horse registration,
      rider membership status
    - API integration layer:
      Cached lookups (don't hammer external APIs),
      TTL-based refresh (daily for rankings, weekly for career),
      Graceful degradation (external API down → show local only)
    - Enriched profiles:
      Rider/horse pages show both WEST platform stats AND
      official records from FEI/USEF side by side

  Acceptance:
    - Horse profile shows FEI ranking alongside WEST stats
    - Rider profile shows USEF zone standing
    - External data cached — doesn't slow page loads
    - If FEI/USEF APIs are unreachable, page still works
      (shows WEST data only, no error)

  Privacy considerations:
    - What FEI/USEF data is public vs restricted?
    - Do we need API keys / partnership agreements?
    - Rider opt-out for public stats (public_stats column,
      designed in Stage 10)

  Maps to: STATS-BRAINSTORM.md (external data section)
  Maps to: DATABASE-SCHEMA-EXPANSION.md (privacy columns)


============================================================
  CROSS-REFERENCE TO V3-BUILD-PLAN.TXT PHASES
============================================================

  Build Phase 0 (Preparation)      → enables Stage 1-2
  Build Phase 1 (west-format.js)   → enables Stage 4
  Build Phase 2 (west-rules.js)    → enables Stage 4
  Build Phase 3 (west-clock.js)    → enables Stage 6
  Build Phase 4 (west-display.js)  → enables Stage 7-8
  Build Phase 5 (west-stats.js)    → enables Stage 5, 9
  Build Phase 6 (west-data.js)     → enables Stage 7
  Build Phase 7 (Durable Objects)  → enables Stage 6
  Build Phase 8 (WebSocket swap)   → enables Stage 6-8
  Build Phase 9 (Historical stats) → enables Stage 10-11
  Build Phase 10 (Polish)          → all stages stable


============================================================
  DECISIONS LOG
============================================================

  2026-04-18  "watcher" renamed to "west-engine" (v3 forward)
              Reasoning: converts proprietary data into web-ready
              output, drives the entire platform, commands the
              clock, runs continuously, pushes not serves.

  2026-04-18  Rollout is 11 stages, each building on prior.
              Stages 1-8 are the core show experience.
              Stages 9-11 are platform growth features.


============================================================
  VERSION HISTORY (this document)
============================================================

  v1.0  2026-04-18  Initial rollout sequence from Session 24
                    conversation. 11 stages, west-engine naming.
