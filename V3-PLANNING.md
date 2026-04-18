============================================================
  WEST Scoring Live — WATCHER v3 PLANNING
  Started: 2026-04-15 (Session 24)
  Status: PLANNING PHASE — collecting ideas
============================================================

PURPOSE OF THIS DOCUMENT
-------------------------
Brainstorm and planning doc for the next major watcher version.
Add ideas as they come up — no commitment to build order yet.
Organized by topic so multiple sessions can contribute.

This doc lives on the branch and gets merged when v3 direction
is locked. Next Claude instance: READ THIS FIRST before
proposing watcher changes.


============================================================
  ARCHITECTURAL DIRECTION (from Session 24 analysis)
============================================================

CORE PRINCIPLE: RESTORE FIRE-AND-FORGET
----------------------------------------
v1.2.0's UDP relay put the watcher in the critical path for
the physical scoreboard. v3's primary architectural goal is to
get the watcher back to being a pure observer that can crash
without affecting the show.

Two candidate approaches (see SESSION-NOTES-24.txt for full
analysis):

  OPTION A — Split relay (incremental)
  --------------------------------------
  - Tiny separate relay process (~30 lines) binds scoreboard
    port, fans out to RSServer AND watcher on different ports.
  - Watcher becomes passive observer again (binds its own port).
  - Zero install dependencies beyond what v1 already needs.
  - RSServer still needs +1 port config change.
  - Relay is in the critical path but is tiny and state-free.

  OPTION B — tshark subprocess (clean break)
  -------------------------------------------
  - Watcher spawns tshark (Wireshark CLI) as a child process.
  - Reads raw packets from tshark stdout (-T json, BPF filter).
  - RSServer binds its port normally — no config change.
  - Nothing in the scoreboard path at all. Pure observation.
  - Requires Wireshark install on every scoring PC (ships npcap).
  - Zero npm native deps (no node-gyp, no Python, no VS tools).

  OPTION C — (if discovered) some other approach
  -----------------------------------------------
  (placeholder — add here if a new idea surfaces)

DECISION: Not yet made. Depends on Culpeper launch feedback and
operator appetite for Wireshark install.


============================================================
  WATCHER v3 — IDEAS LIST
============================================================
Add ideas below in the relevant section. Format:
  - [idea] (source: session N / Bill / field observation)
  - Mark with ✅ when committed to, ❌ when rejected

--- RELIABILITY / RESILIENCE ---

- [ ] Split relay into separate process (Session 24)
- [ ] OR: tshark subprocess for passive packet capture (S23/S24)
- [ ] Local queue for Worker posts — persist to disk if Worker
      unreachable, drain when connection returns (gap identified
      in codebase survey)
- [ ] Watchdog timer — if watcher event loop hangs (no file
      events AND no UDP for N minutes while show is active),
      auto-restart (Session 24 failure mode 'b')
- [ ] Health endpoint — simple HTTP server on localhost so an
      external monitor (or the relay) can check watcher liveness
- [ ] Graceful shutdown — flush pending posts on SIGTERM/SIGINT
      before exit

--- UDP / SCOREBOARD ---

- [ ] 127.0.0.1 vs 255.255.255.255 — test on hardware
      scoreboards that expect broadcast (S23 open item)
- [ ] Port-grab race at startup — document required startup
      order (relay/watcher first, then RSServer?) or make it
      order-independent
- [ ] Support multiple scoreboard ports (some venues run
      multiple Ryegate instances?)

--- INSTALL / DEPLOYMENT ---

- [ ] Single .exe packaging (mentioned S12 — revisit for v3)
- [ ] Auto-updater — check for new version on startup, pull
      from GitHub release
- [ ] Install script that handles RSServer port reconfiguration
      automatically (S23 open item)
- [ ] Windows Service registration (vs .bat auto-restart loop)
- [ ] Tray icon / system notification on watcher status changes

--- DATA / PARSING ---

- [ ] Remaining unknown columns: H[58], H[65-67], jumper
      H[16]/H[24] (CLS-FORMAT.md "Still Unknown" section)
- [ ] Method 6 (Optimum Time IV.1) — test pending since S22
- [ ] H[3]=2 value unverified (S20)
- [ ] H[6] ScoreMethod for H&G + Special unknown (S14/S20)
- [ ] col[45] CombinedTotal in 3-round classes unverified (S20)
- [ ] TIMY entry block 3 — unmapped columns (CLS-FORMAT)

--- FINALIZE DETECTION ---

- [ ] Current 5-layer system works but is complex — simplify
      if possible in v3
- [ ] ryegate.live peek depends on internet — consider making
      it optional (operator toggle in config.json)
- [ ] .tod file detection only works on AlgeTimy/FDS — extend
      or document limitation

--- MONITORING / OBSERVABILITY ---

- [ ] Structured logging (JSON lines) instead of free-text
      west_log.txt — easier to parse, search, alert on
- [ ] Remote log shipping — post critical events (errors, class
      complete, watcher restart) to Worker for admin visibility
- [ ] Admin page "watcher health" panel — show last heartbeat,
      error count, classes processed, uptime


============================================================
  WORKER v3 — IDEAS LIST
============================================================

--- API / ENDPOINTS ---

- [ ] WebSocket or SSE push for live pages (replace polling)
- [ ] Pagination on admin list endpoints
- [ ] CSV/PDF export for completed show results
- [ ] Rate limiting on public endpoints
- [ ] Proper auth system (beyond X-West-Key header) for admin

--- DATA / COMPUTATION ---

- [ ] Stats Phase B: cross-show career stats, rider/horse
      profiles, venue analytics (see STATS-BRAINSTORM.md)
- [ ] Show archival — move completed shows to cold storage
      after N months?
- [ ] Multi-show leaderboards / series standings
- [ ] Weather data refresh during show (currently static)

--- RELIABILITY ---

- [ ] Worker error monitoring — log to external service?
- [ ] D1 backup strategy
- [ ] KV TTL tuning based on observed access patterns


============================================================
  FRONTEND — IDEAS LIST
============================================================

- [ ] Mobile-friendly admin page
- [ ] Push notifications (via service worker) when class goes
      live or results posted
- [ ] Printable results view (clean CSS for print)
- [ ] Dark mode toggle for non-display pages
- [ ] Accessibility audit (screen reader, keyboard nav)
- [ ] Offline-capable results viewing (service worker cache)


============================================================
  FIELD OBSERVATIONS / POST-LAUNCH NOTES
============================================================
(Add notes from real show deployments here)

CULPEPER 2026-04-15:
  - (Bill to fill in — what worked, what broke, what was
    annoying, what operators/spectators said)


============================================================
  DECISIONS LOG
============================================================
Record decisions here so future sessions don't re-litigate.

2026-04-15 (Session 24):
  - Fire-and-forget regression in v1.2.0 identified and
    analyzed. Two fix paths proposed (split relay vs tshark).
    Decision deferred pending Culpeper field data.
  - v2.0 `cap` package path likely dead (build-tool pain).
    tshark subprocess is the v2.0 direction if pcap is pursued.


============================================================
  VERSION HISTORY (planning doc itself)
============================================================
v0.1  2026-04-15  Session 24 — initial brainstorm, architectural
                  direction from fire-and-forget analysis
