============================================================
  WEST Scoring Live — Scoring PC Watcher
  Version 1.0.0
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
