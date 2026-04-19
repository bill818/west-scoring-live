# West Engine — Electron Decisions (LOCKED)

### Session 28, 2026-04-19 — decisions Bill made with Claude after a teaching walk-through of the Electron choice space.

These are the architectural commitments for the v3 West Engine. They were discussed one by one. If something changes, **update this doc AND commit the change** — future-Bill, Devon, and future-Claude read this as the canonical "why we picked what we picked."

Related docs:
- `V3-ROLLOUT-SEQUENCE.md` — the 11-stage rollout plan + watcher→engine naming lock
- `CLASS-DETECTION-SCHEMAS.md` — detection logic the engine implements
- `UDP-PROTOCOL-REFERENCE.md` — two-channel architecture the engine serves
- `CENTRALIZED-JS-ARCHITECTURE.txt` — shared JS modules (engine + browser)
- Memory: `project_electron_engine.md` — architectural summary pinned for future sessions

---

## Why Electron (context)

The v3 engine replaces v2's two separate Node processes (watcher + funnel) with one packaged Windows app. Operators install one .exe, run one thing, update one thing.

Alternatives rejected:
- **Plain Node CLI** — operator has to install Node, copy files, start via .bat. Too many manual steps.
- **Windows Service** — no UI, hard to diagnose when it breaks, operators have no view into state.
- **Two processes** (v2) — two installs, two places to look when something's wrong.

Electron wins on: one install, one update, one status indicator, one log location, Windows-native look.

Bill: "I just want a windows program as the final program." That's exactly what Electron produces — operators don't know it's Electron any more than VS Code users know it is.

---

## The 14 locked decisions

### 1. Packager: **electron-builder**

- More Stack Overflow coverage than electron-forge
- Handles auto-update cleanly via `electron-updater`
- Config-driven (one `electron-builder.yml`)
- Used by VS Code

### 2. Installer format: **NSIS installer + portable .exe (dual build)**

- NSIS for normal operators (installs cleanly, shows in Add/Remove Programs, auto-start on login supported)
- Portable .exe for emergency field deploys (drag-and-drop, no install, run anywhere)
- electron-builder produces both from one config

### 3. Code signing: **Unsigned for now**

- Bill is the only user currently — first-run SmartScreen warning is acceptable ("more info → run anyway")
- Cert costs ~$200-500/yr
- **Decision to sign deferred** until public distribution
- Revisit: before engine distributes to customers / paid shows with unknown operators

### 4. Window frame: **Native Windows chrome**

- No custom title bar
- No frameless window tricks
- Operators see a normal Windows app

### 5. Config file path: **`c:\west\config.json`**

- Matches v2 path exactly
- Operators with a v2 watcher can drop the same config file into the engine
- Migration compatibility
- Could migrate to `%APPDATA%\WestEngine\` later if we ever have reason; no current reason

### 6. Log file path: **`c:\west\west_log.txt` + `c:\west\west_udp_log.txt`**

- Matches v2 pattern exactly
- Support story stays: "zip up c:\west\ and send it"
- No learning curve for operators who've dealt with v2

### 7. Auto-update source: **GitHub Releases (private repo)**

- electron-updater reads the GitHub API
- Free (we already have GitHub)
- Private repo keeps builds non-public
- On launch, engine checks for newer release; downloads if present; applies on next launch

### 8. Single-instance lock: **Yes — one engine per scoring PC, never two**

- Bill: "multi programs open on the same computer is a disaster waiting to happen"
- Different scoring PCs can each run their own engine (one per PC is correct)
- If operator tries to launch a second engine on the SAME PC, the launch is intercepted and the existing engine's tray icon flashes (or window opens)
- Prevents port conflicts, config confusion, duplicate POSTs to worker

### 9. Auto-start on Windows login: **Yes, with install-time toggle**

- Default: enabled
- Operator unchecks if they want manual launch
- Implementation: Windows registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- Electron has helper libs that handle this cleanly

### 10. Process architecture: **Single main process**

- UDP listener, filesystem watcher, parser, HTTP poster all in one
- No worker threads initially
- Funnel fan-out stays synchronous (main process receives UDP and forwards to RSServer before parsing)
- Add worker threads LATER if profiling shows the parser blocking the UDP path
- KISS — don't solve problems we don't have yet

### 11. Renderer security — `nodeIntegration`: **True**

- Status window can `require('fs')`, `dgram`, etc. directly
- Less setup than preload-script bridge
- Security trade-off: acceptable because the renderer only loads our own HTML (not user-navigable content)
- Standard choice for internal tools

### 12. Window frame: **Native** (duplicate of #4 — same decision)

### 13. Crash handling: **Global handlers + auto-restart + worker POST**

On uncaught exception or unhandled rejection:
1. Write stack trace to `c:\west\west_log.txt`
2. POST the error to the worker's observability endpoint (feeds the `parse_warnings` / anomalies table per v3 schema)
3. Relaunch the process after ~2 seconds

Bill's direction: "minimal and healing." Engine cannot stay dead during a show. Auto-restart is table stakes.

### 14. UDP fan-out order: **SYNCHRONOUS — forward FIRST, parse SECOND**

The critical path:
```
socket.on('message', (packet) => {
  outSocket.send(packet, RSSERVER_PORT, ..., () => {});  // STEP 1: fan out, FIRST
  parseAndHandle(packet);                                 // STEP 2: parse, AFTER
});
```

**Why the order matters:**
- RSServer drives the physical scoreboard. Forwarding CANNOT fail.
- Parser drives our website. Parser can fail without the audience noticing.
- If we reversed the order (parse first), any parser bug breaks the scoreboard. **Unacceptable.**

Between receive and forward, do NOTHING — no `await`, no logging, no state check, no queue. Microseconds matter.

This preserves the v1.3.1 funnel's non-critical-path guarantee inside the Electron process.

---

## Tray icon / status window design (LOCKED)

### Tray icon

- Small icon in Windows system tray (bottom-right, near clock)
- Color-coded state:
  - 🟢 Green = engine running, watcher alive, worker connected
  - 🟡 Amber = running but something unusual (stale data, reconnecting, peek classifier disagreement)
  - 🔴 Red = stopped or crashed
  - ⚪ Gray = starting up / initializing

### Hover tooltip

```
WEST Engine v3.0.1
Ring: 1 · Show: hits-culpeper
Status: running
Last event: 2s ago
Connected to: west-worker ✓
```

### Right-click menu

```
Open Status Window
View Logs
Pause / Resume
─────
Restart Engine
Quit
```

### Left-click

Opens small optional always-on-top status window. Shows tooltip info + live log scroll + link to admin page. Window can be left closed — tray icon is enough for normal operation.

### Implementation cost

Electron has built-in `Tray` and `Menu` APIs. ~50 lines of code total for the whole thing.

---

## What's NOT locked (deferred)

These come up later, during Phase 2+ of build:

- **Installer signing cert vendor** — DigiCert vs Sectigo vs SSL.com. Revisit before public distribution.
- **Status window layout details** — buttons, exact info density, font sizes. Design when we build it.
- **Worker thread split** — only if profiling shows need.
- **Crash report backend schema** — how the worker's `/admin/anomalies` endpoint stores engine crashes (part of Phase 7 DO work).
- **Migration flow from v2 watcher to v3 engine** — can v3 engine read v2's config.json directly? (Yes, per decision #5.) Can it detect a v2 watcher running and offer to take over? Design in Phase 10.

---

## Next steps (scheduled, not done yet)

### Step B — The Electron spike (~half a day)

Minimum 50-line Electron app proving:
1. Opens a UDP listener on a test port (29696 or dev equivalent)
2. Fans packets out to another local port synchronously (29697)
3. Prints each packet to console (simulates the parser)
4. Has a tray icon with basic tooltip
5. Packages as an `.exe` via electron-builder

Acceptance:
- Runs on a scoring PC during a calm moment
- UDP packets forward with <1ms measured latency
- No packet loss over ~1 hour of real show traffic
- RSServer receives every packet as if we weren't there
- Tray icon shows up and hover works

If spike succeeds → Electron architecture validated → proceed to Phase 0.
If spike fails → understand why BEFORE committing more planning to the Electron path.

### Step C — Phase 0 of V3-BUILD-PLAN (when spike succeeds)

From `V3-BUILD-PLAN.txt` Phase 0:
1. Tag current main as `v2.x-pre-rebuild` baseline
2. Create `v3-rebuild` branch for risky work
3. `/v3/` folder skeleton (already done Session 28)
4. V3_ENABLED feature flag in v2 worker
5. Vitest test harness + sample test passing
6. Page contracts (arguably covered by UI catalogs saved Session 28)
7. UDP log replay harness

### Scheduling

Bill said: "well build the app another day." These are explicitly deferred, not forgotten.

**Checklist reminder:** this deferral is tracked in `UNCERTAIN-PROTOCOLS-CHECKLIST.txt` Parts 6 and 10. Don't let it age out.

---

## Change log

- **2026-04-19 (Session 28):** initial version. All 14 decisions locked. Spike + Phase 0 deferred.
