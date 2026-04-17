============================================================
  WEST Scoring Live — Scoring PC Watcher
  Version 1.7.0
============================================================

WEB PAGES (PREVIEW)
-------------------
  Preview site:   https://preview.westscoring.pages.dev
  Production:     https://westscoring.live  (not in use yet)

Use the preview URL while testing. The scoring PC watcher
posts to the same Cloudflare worker either way — the URL just
selects which frontend you're looking at.


WHAT THIS IS
------------
A small Node.js program that runs on the Ryegate scoring
computer and streams live class data (entries, timing, scores,
finish events) to the WEST Scoring Live web pages.

It reads three things from Ryegate:
  - C:\Ryegate\Jumper\Classes\*.cls   (per-class data)
  - C:\Ryegate\Jumper\tsked.csv       (day's schedule)
  - C:\Ryegate\Jumper\config.dat      (show/ring/timer config)
  - UDP broadcasts on the scoreboard port (live on-course)

It posts to the west-worker on Cloudflare, which in turn
powers the live/results/stats/display/schedule pages.


WHAT'S IN THIS FOLDER
---------------------
  west-watcher.js      The watcher program (Node.js)
  install-watcher.bat  Installer — run this first
  config.json          Template config — edit the slug
  README.txt           This file


REQUIREMENTS
------------
  - Windows 10 or 11
  - Node.js LTS  (https://nodejs.org/ — pick LTS, default install)
  - Ryegate Jumper installed at C:\Ryegate\Jumper
  - Network access to https://west-worker.bill-acb.workers.dev


INSTALLATION
------------
1. Install Node.js LTS from https://nodejs.org/ if you don't
   already have it. Accept all defaults.

2. Right-click install-watcher.bat -> "Run as administrator".
   The installer will:
     - Verify Node.js is installed
     - Create C:\west\
     - Copy west-watcher.js and start-watcher.bat there
     - Create/copy config.json

3. Edit C:\west\config.json and set the "slug" to match the
   show in the WEST Scoring Live admin page
   (e.g. "hits-culpeper", "hits-saugerties", etc.).

4. Start the watcher by double-clicking
   C:\west\start-watcher.bat. It will auto-restart on crash.
   To stop it, just close the black console window.


POWER SETTINGS — IMPORTANT
--------------------------
The scoring PC cannot sleep during the show. In Windows
Settings -> System -> Power & Battery (or Power Options on
older versions), set:
  - "Put the computer to sleep"   = Never (plugged in)
  - "Turn off hard disk"          = Never
  - "USB selective suspend"       = Disabled

If the PC sleeps, the watcher stops and live data stops flowing.


LOG FILES
---------
  C:\west\west_log.txt       Main event log (everything)
  C:\west\west_udp_log.txt   UDP packet log (on-course frames)

If something looks wrong at the show, these logs are the
first place to check. Support can ask you to send them.


CONFIG FILE DETAILS
-------------------
C:\west\config.json is a plain JSON file:

  {
    "workerUrl": "https://west-worker.bill-acb.workers.dev",
    "authKey":   "west-scoring-2026",
    "slug":      "show-slug-here"
  }

  workerUrl - always the same (Cloudflare Worker URL)
  authKey   - must match the worker's expected key
  slug      - the show slug — ASK before a show if unsure.
              Must match the entry in the admin page.

Ring number is auto-detected from Ryegate's config.dat FTP
path (SHOWS/West/YYYY/ShowName/wkN/ringN).


WHAT TO VERIFY BEFORE A SHOW
----------------------------
  [ ] Node.js installed (run 'node --version' in cmd)
  [ ] C:\west\west-watcher.js exists
  [ ] C:\west\config.json has correct slug
  [ ] Windows sleep disabled
  [ ] Ryegate config.dat FTP path points at the right show
  [ ] start-watcher.bat is running (console window open)
  [ ] Open the admin page, confirm show is "active"
  [ ] Watch one class and verify the live page updates


COMMON ISSUES
-------------
"show is locked, worker rejected"
  - The show's end_date has passed or it was manually marked
    complete. Go to admin -> set the show back to Active.
    (The worker auto-bumps end_date when you set active.)

"no such file or directory: config.json"
  - You didn't edit C:\west\config.json. Open it in Notepad
    and fix the slug.

Watcher window closes immediately
  - Node.js not installed, or the JS file has a syntax error.
    Try: open cmd in C:\west\ and run
      node west-watcher.js
    You'll see the actual error message.

Schedule page doesn't show new classes
  - Ryegate writes tsked.csv when you add classes. The
    watcher picks up content changes only (not mtime-only
    touches). Make a real change in Ryegate to trigger it.

"INTRO" pressed but schedule didn't update
  - Pressing Intro sends a UDP frame that marks the class
    "Live Now" in the schedule, but does not modify tsked.csv.
    The Live Now marker comes from the UDP CLASS_SELECTED
    frame (pressing Ctrl+A in Ryegate), which does post.


SUPPORT
-------
If the watcher is misbehaving, zip up:
  C:\west\west_log.txt
  C:\west\west_udp_log.txt
  C:\west\config.json
and send them. The logs tell us everything we need.


VERSION HISTORY
---------------
v1.7.0+  (2026-04-16 show-day patches)

  + Stale active class re-peek sweep: every 5 min the watcher
    checks ALL active classes against ryegate.live, not just the
    selected one. Non-selected concurrent classes that Ryegate
    shows as UPLOADED get CLASS_COMPLETE fired automatically.
    Fixes the gap where classes 213/236/245 stayed active on
    Day 1 because they were never Ctrl+A'd.
  + Fixed idleTimer reference error in handleClassComplete — was
    referencing removed variable, crashed with "Cannot access
    'idleTimer' before initialization" on every CLASS_COMPLETE.
  + Fixed ORDER_POSTED event handler — worker was returning 400
    "Unknown event type" when peek forwarded ORDER_POSTED.
  + OOG remaining entries: results.html now shows "On Deck" for
    next horse, then -1, -2, -3... countdown. Collapses numbering
    when entries compete (no gaps from original order).
  + OOG auto-recompute: when tsked JO flag arrives, worker
    automatically re-runs computeClassResults so OOG populates
    immediately without waiting for next .cls write.
  + OOG file-order fallback: Farmtek classes with rideOrder=0
    now use .cls file order instead of filtering all entries out.
  + Numeric status fallback: when .cls text-status scan (cols
    [36]-[39]) finds nothing, falls back to col[21]/col[28]/
    col[35] numeric codes (1-6 → status, >6 = scoring data).
    Catches JO WDs (col[28]=4) that Farmtek writes numerically
    but never as text.
  + Numeric status map corrected: 2=RT (not RF), 5=RF (Rider
    Fall). Confirmed from class 212 #6318 Ryegate data.
  + Farmtek status scan: cols[36]-[39] cluster scan instead of
    fixed col[38]. Ryegate shifts the column between entries.

v1.7.0  (2026-04-16)

  + 30-minute idle timer REMOVED. Was prematurely closing classes
    during scoring pauses. Primary close signals (peek, Ctrl+A,
    .tod) plus the worker's 1-hour sweep are sufficient.
  + Heartbeat adaptive: 10s when class active (carries clock
    snapshot: classNum, entry, elapsed, ta, phase, jumpFaults,
    rank), 60s when idle. Heartbeat sends real WATCHER_VERSION
    (was hardcoded '2.2').
  + Farmtek status scan: instead of reading a fixed column for the
    text status code, scans cols[36]-[39] for any recognized code
    (EL/RF/OC/HF/WD/RT/DNS/DQ/RO/EX/HC). Ryegate shifts the
    column between entries — the scan handles it.
  + Farmtek numeric status FALLBACK: when the text scan finds
    nothing, checks col[21] (R1), col[28] (R2/JO), col[35] (R3)
    for values 1-6 and maps to status codes:
      1=EL, 2=RT, 3=OC, 4=WD, 5=RF, 6=DNS (>6 = scoring data).
    This catches JO WDs (col[28]=4) that Farmtek writes numerically
    but never as text — the gap that caused manual D1 patches on
    Culpeper Day 1. See display-config.js WEST.numericStatusMap
    for the authoritative table.
  + Round label on live clock card uses oc.label from watcher's
    UDP parser (e.g. "Jump Off") instead of computed.currentRound
    which is often null with concurrent classes.
  + selectedClassNum forward-declared before heartbeat init to fix
    "Cannot access before initialization" crash on startup.

v1.6.0  (2026-04-15)
  + Dedicated peek log file: c:\west\west_peek_log.txt. Every
    ryegate.live poll writes a full-detail line: classified
    state, previous state, HTTP status, response bytes, response
    ms, and counts for all eight classifier signals
    (pleaseCheckBack, onCourse, prevExhibitor, orderOfGo,
    nOfNCompeted, table, cbody, plc). Does NOT console.log —
    kept out of main log to avoid drowning the timeline.
    State transitions and CLASS_COMPLETE fires still go to the
    main west_log.txt too.
  + Unmissable startup logging: "[PEEK] READY class=N path=X
    url=Y" when peek enables, "[PEEK] DISABLED class=N
    reason=..." when it doesn't. No more silent-disabled peek.
  + Classifier verified against real ryegate.live HTML (both
    live and completed class samples captured 2026-04-15) and
    the literal signals updated:
      NOT_STARTED   — "Please Check Back"
      ORDER_POSTED  — "Order of Go"
      IN_PROGRESS   — ON COURSE  OR  PREVIOUS EXHIBITOR
                      OR  N of N Competed
      UPLOADED      — Plc column + CBody tables AND none of
                      the above live signals
    Added PREVIOUS EXHIBITOR — previously missed, was the
    signal that sometimes left peek dormant when ON COURSE
    cleared between horses.
  + Transition trigger fix: now fires CLASS_COMPLETE on any
    "* → UPLOADED" transition where the previous state wasn't
    already UPLOADED. Previously required prev to be LIVE or
    IN_PROGRESS, which missed:
      null → UPLOADED       (watcher restart during show)
      NOT_STARTED → UPLOADED (Ryegate publishes only at upload)
      ORDER_POSTED → UPLOADED (fast class between 15-30s polls)
    shouldCommit() 5-min dedup window and idempotent worker
    markClassComplete keep restart-storms contained.
  + Dormancy is now self-healing instead of session-killing.
    3 consecutive ERRORs OR an UNKNOWN classification →
    cooldown 5 min, THEN retry. A transient internet hiccup
    at the show no longer disables peek for the whole day.

v1.5.0  (2026-04-15)
  + Farmtek (J) text status was being read from col[39]; actual
    position is col[38]. Fixed. Farmtek numeric columns
    (col[21]/col[28]) do NOT follow the TIMY 1-6 → text mapping
    (observed: col[28]=3 means "OC" in Farmtek, "HF" in TIMY),
    so Farmtek skips numeric fallback and only trusts the text
    at col[38]. Status gets attributed to r2 if the rider has
    an r1 time (status came on JO), r1 otherwise.
    TIMY logic unchanged — still reads col[82]/[83] with
    col[21]/col[28] numeric fallback as before.
  + postToWorker switched from fetch to native https.request with
    a persistent keepAlive agent. First POST to the worker pays
    the TCP+TLS handshake cost (~500ms-2s on spotty networks);
    every subsequent POST reuses the warm connection and skips
    straight to sending bytes. On Culpeper-class cell networks
    this turns a per-event 2-3s handshake tax into a one-time
    ~2s cost per idle period.
  + POST timeout bumped from 3s → 10s. Previously events that
    took 3-10s to deliver were aborted and lost; now they land
    (late but complete). Trivial memory impact — at most a few
    pending requests per minute during a total outage.
  + inferRound trusts UDP TA when the .cls header hasn't caught
    up yet. Previously, if Ryegate changed TA (e.g. round
    rolling over into JO on method 13 II.2b or a mid-class
    operator TA edit), the round label could lag by one horse
    until the .cls header flushed the new TA value.
    New logic: if UDP TA matches a header r{N}TA → use that.
    If UDP TA doesn't match any header value but differs from
    the last-seen UDP TA for this class → advance to the next
    round immediately. Label updates on the same frame.
    Per-class state (inferRoundState[classKey]) remembers the
    last TA and last inferred round so the "TA changed"
    detection is stable across frames.
  + FINISH re-fires on rank update. Ryegate sends a first
    FINISH frame with rank empty on timer stop, then a second
    after the operator presses RANK. Previously the second
    frame was ignored (same phase/entry/TA as first), so the
    rank icon never appeared on the live on-course card. Now
    tracks lastRank and re-fires FINISH when rank changes on
    the same entry.

v1.4.0  (2026-04-15)
  + Watcher UDP port is now AUTO-DERIVED from Ryegate's
    scoreboard port (config.dat col[1]):
      watcherUdpPort = 28000 + (ryegateScoreboardPort - 29696)
    e.g. Ryegate 29696 → watcher 28000.
  + Companion west-funnel uses the same formula for its
    watcher-facing output, so the two stay aligned with no
    config edits.
  + "scoreboardListenPort" config.json key removed (no longer
    needed). config.json is back to just workerUrl / authKey /
    slug.
  + Operators only ever change Ryegate's scoreboard port —
    everything else follows automatically.

v1.3.0  (2026-04-15)
  + Watcher is a pure UDP observer again. v1.2.0's in-process
    relay is removed — that approach put the watcher in the
    critical path for the physical scoreboard, which wasn't
    the original fire-and-forget design.
  + Added config.json key "scoreboardListenPort": on scoring
    PCs that run the companion west-funnel v1.0 process, set
    this to the watcher-facing output port configured in the
    funnel (typical: 29698). On dev PCs with no funnel, leave
    the key out and the watcher binds Ryegate's port directly.
  + Port 31000 (class-complete) listener unchanged — it stays
    a direct bind as before.

v1.2.0  (2026-04-14)
  + UDP RELAY: watcher binds Ryegate's scoreboard port directly,
    then forwards every packet to 127.0.0.1:<port+1> so RSServer
    still receives its feed. Solves the exclusive-bind conflict
    without npcap / native deps.
    REQUIRED ON SCORING PC:
      - Configure RSServer's listen port to (Ryegate port + 1).
        Example: Ryegate=29696, RSServer=29697.
      - Ryegate's scoreboard output port stays unchanged.
      - Start the watcher BEFORE RSServer if both are starting
        fresh — watcher needs to bind the Ryegate port first.
        If RSServer is already on the old port, stop it, start
        watcher, then start RSServer (now on +1).
  + Back to full UDP mode — v1.1.6 DEGRADED path no longer needed.

v1.1.7  (2026-04-14)
  + Logs write next to the watcher script (c:\west\west_log.txt
    and c:\west\west_udp_log.txt) instead of the user's Desktop.
    Fixes scoring PCs where Desktop is OneDrive-synced or
    otherwise non-writable — you always know where to find
    the log now.

v1.1.6  (2026-04-14)
  + v1 now runs DEGRADED unconditionally — UDP listeners are not
    started at all. Prevents any chance of the watcher racing
    RSServer.exe for port 29696. File watchers (.cls, tsked.csv,
    config.dat) still post schedule + class data to the worker.
    Use v2.0 (pcap) for live on-course / clock / finish events.

v1.1.5  (2026-04-14)
  + HOTFIX over v1.1.4: auto-detects RSServer.exe at startup and
    skips the UDP bind when present. Prevents the watcher from
    winning the port race and blocking RSServer on scoring PCs.
    Dev machines without RSServer still bind UDP normally.

v1.1.4  (2026-04-14)
  + DEGRADED MODE: when UDP ports 29696 / 31000 are held
    exclusively by RSServer.exe (Windows SO_EXCLUSIVEADDRUSE
    default), the watcher logs a warning and continues without
    UDP instead of exiting. File watchers (.cls, tsked.csv,
    config.dat) still post schedule + class data. Live pages
    lose on-course banner + clock + finish events but keep
    standings, schedule, and final results.
  + Proper fix (npcap-based capture) is in the v2.0 WIP folder.

v1.1.3  (2026-04-14)
  + HOTFIX: removed reusePort flag (Linux-only) that was
    causing ENOTSUP on Windows in v1.1.2. reuseAddr stays.
  + Note: same-PC coexistence with RSServer.exe (which holds
    UDP 29696 with SO_EXCLUSIVEADDRUSE) is not possible on
    Windows. Run the watcher on a separate PC on the same LAN,
    sharing C:\Ryegate\Jumper from the scoring PC over SMB.

v1.1.2  (2026-04-14)
  + UDP sockets now open with reuseAddr so a restart can rebind
    the port immediately instead of hitting EADDRINUSE during
    Windows TIME_WAIT.
  + If EADDRINUSE still occurs (another watcher actually running),
    watcher exits with code 1 so start-watcher.bat's restart
    loop gets a clean slate after its 5s wait.

v1.1.1  (2026-04-13)
  + saveSnapshot now auto-creates C:\west_snapshots on first call.
    Previously silently failed on fresh installs where the folder
    didn't exist, so no tsked.csv / config.dat snapshots were
    being saved.

v1.1.0  (2026-04-13)
  + Config-driven timer default: reads config.dat col[2]
    ("FARMTEK" / "FDS") to pick U→J vs U→T on import-only classes.
    Updates live on config.dat changes, no restart needed.
  + Numeric status fallback: when Ryegate leaves the text
    status columns (col[82]/col[83]) blank, falls back to
    col[21]/col[28] numeric codes (3=HF, 4=WD). Worker also
    now persists the status to D1 so it survives KV expiry.
  + Round label cleanup: method 0 (Table III) correctly
    labeled "Round 1"; method 14 (Team) uses R1/R2/JO;
    method 15 (Winning Round) uses R1/R2 (no JO); dropped
    unused methods 5 and 8.
  + TYPE HINT log spam dedup — only logs once per class.
  + Watcher logs "WEST Scoring Live Watcher vX.Y.Z" banner
    at startup so operators can see the version in the log.

v1.0.0  (2026-04-13)
  Initial tagged release.
  Supports jumper methods 0, 2, 3, 4, 6, 7, 9, 11, 13, 14, 15
  and all hunter formats (Special, Derby, Flat, Equitation).
  Farmtek + TIMY timer systems (auto-detected from config.dat).
  UDP finish-status overlay (WD/RT/EL/etc.) persists to D1.
  Adaptive schedule / class parsing with crash protection.
