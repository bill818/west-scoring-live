# 🚀 Next Session — Start Here

**Last updated:** end of Session 28, 2026-04-19
**First action this session:** Electron spike (half day)

If you're a fresh Claude instance or human collaborator walking in cold to v3 work — read this doc first. It's designed to orient you in ~5 minutes and point you at the right specific docs.

---

## Where things stand

**v2 is LIVE in production.** Watcher v1.11 deployed at scoring PCs. Shows continue through April/May 2026. Do NOT touch v2 production code unless it's a live-show patch with explicit operator ask.

**v3 is PLANNED, not yet built.** 21 planning docs in this folder describe what v3 is, how it's structured, what to preserve from v2, and what to test. No v3 code exists beyond skeleton module stubs in `/v3/js/`.

**You are here:** Session 29 (or later). Bill has decided to start actual v3 work. First action is the Electron spike.

---

## 📌 Article 1 — non-negotiable (read before doing anything)

**classType at col[0] of .cls row 0 is THE LENS.**
- `H` → Hunter lens. Every field means hunter stuff.
- `J` → Farmtek Jumper lens. Every field means jumper stuff.
- `T` → TOD Jumper lens. Same as J, different hardware quirks.
- `U` → No lens yet. Must infer before reading other fields.

Hunter and jumper data NEVER coexist in the same file. The same column number means different things under different lenses. NEVER translate field meanings across lenses.

Every new Claude on this project has broken this rule. Bill is done having the conversation.

**Full detail:** Claude memory `feedback_class_type_commandment.md` (pinned at top of MEMORY.md).

---

## 🎯 Session 29 goal — the Electron spike

A ~50-line throwaway Electron app that validates the v3 engine's core architectural assumption: **synchronous UDP fan-out inside Electron's main process works reliably.**

### What the spike does

```
Ryegate UDP (port 29696 or test port)
       │
       ▼
  Electron main process
       │
       ├─→ dgram.send() to 127.0.0.1:29697  (RSServer's port + 1)
       │   SYNCHRONOUS. No await. No parsing. Microseconds.
       │
       └─→ AFTER send() returns: console.log("received packet")
           (simulates the future parser)

Tray icon in system tray showing "engine alive" with hover tooltip.
```

That's it. Five things:
1. dgram UDP listener on an input port
2. dgram UDP sender forwarding every packet synchronously to an output port
3. console.log of each packet AFTER forwarding (never before)
4. Tray icon + tooltip
5. Packaged as `.exe` via electron-builder

### Acceptance criteria

- Runs on a Windows scoring PC
- Packet-to-forward latency stays under 1ms 99%+ of the time
- No packet loss over ~1 hour of real show traffic
- RSServer receives every packet as if the engine weren't there
- Tray icon appears and hover tooltip works
- Engine can crash / be restarted without affecting RSServer

### If spike SUCCEEDS

Electron architecture validated. Proceed to Phase 0 of V3-BUILD-PLAN. Real engine build can begin.

### If spike FAILS

Don't commit more work to the Electron path without understanding why. Possible fixes:
- Move the fan-out to a worker thread if main loop introduces latency
- Use Node's `cluster` module instead of Electron (loses the UI but keeps everything else)
- Switch packaging to plain Node + NSSM service wrapper

---

## 📚 Critical reads before starting the spike (~30 min)

In this order:

1. **Claude memory `project_v3_rebuild.md`** — master v3 state. "v2 still live" rule. Planning doc inventory. Sequencing when coding starts.

2. **`ENGINE-ELECTRON-DECISIONS.md`** (this folder) — 14 Electron choices already locked. READ BEFORE WRITING ANY ELECTRON CODE. Don't re-debate these.

3. **`UDP-PROTOCOL-REFERENCE.md`** (this folder) — two-channel architecture. UDP in (29696 → funnel → 28000 engine + 29697 RSServer) + port 31000 focus signal. The spike validates the fan-out pattern for the scoring-telemetry channel (not 31000).

4. **`CLOUDFLARE-RESOURCES.md`** (this folder) — not needed for the spike specifically, but tells you Cloudflare work can happen in parallel later.

If you have 15 minutes for deeper context:

5. **`README.md`** (this folder) — reading order for all 21 planning docs
6. **`V3-BUILD-PLAN.txt`** — 11-phase playbook
7. **`SESSION-NOTES-28.txt`** (in `/session-notes/`) — detailed Session 28 handoff

---

## What the spike is NOT

- ❌ NOT the real engine. Don't build production features.
- ❌ NOT a testbed for WebSocket to Durable Objects (that's Phase 7).
- ❌ NOT a test of the full watcher functionality (no .cls parsing, no POST to worker).
- ❌ NOT committed to `main` as anything other than a `/v3/spike/` subfolder.
- ❌ NOT code that gets preserved. Throw it away after validation.

The spike's only job is to prove the UDP fan-out pattern works inside Electron. Nothing else.

---

## Workflow for Session 29

1. **Orient** (10 min):
   - Read this doc (done)
   - Read `project_v3_rebuild.md` memory
   - Read `ENGINE-ELECTRON-DECISIONS.md`

2. **Set up spike project** (30 min):
   - `/v3/spike/` subfolder
   - `npm init -y` + `npm install electron electron-builder --save-dev`
   - Minimal `package.json`, `main.js`, `electron-builder.yml`

3. **Write the 50 lines** (1-2 hours):
   - `main.js` creates main window (hidden), Tray icon, UDP listener, UDP sender
   - Fan-out pattern: `socket.on('message', packet => { outSocket.send(packet, 29697, '127.0.0.1'); console.log('rx', packet.length); });`
   - Never put `console.log` BEFORE the `outSocket.send` call

4. **Package it** (15 min):
   - `npx electron-builder --win`
   - Output: `dist/WestEngineSpike-0.0.1.exe` (or similar)

5. **Test** (half hour of show time or simulated):
   - Run on a Windows machine
   - Simulate UDP traffic or wait for real show
   - Measure latency (console timestamps are fine for spike)
   - Confirm RSServer behavior unchanged

6. **Report back to Bill:**
   - Did it work?
   - Any surprises?
   - What's the measured latency distribution?

7. **If pass:** mark spike complete, propose Phase 0 next.
8. **If fail:** open a diagnostic session — understand WHY before recommending next step.

---

## Key decisions already locked (don't re-debate)

From `ENGINE-ELECTRON-DECISIONS.md`:

- electron-builder (not electron-forge)
- NSIS installer + portable .exe dual build
- Unsigned for now
- Native Windows chrome (no custom title bar)
- Config at `c:\west\config.json` (spike doesn't use it, but future engine will)
- Log at `c:\west\west_log.txt`
- Auto-update: GitHub Releases (spike doesn't need it)
- Single-instance lock: yes (spike should too, to test)
- Auto-start on login: yes (spike doesn't need it)
- Single main process (no workers in spike)
- nodeIntegration: true
- Global crash handlers + auto-restart (spike should have minimal version)
- **UDP fan-out: SYNCHRONOUS, forward BEFORE parse** ← the thing the spike validates
- Tray icon + optional status window (spike includes tray only, no status window)

---

## If you're about to write code that violates the locked decisions

**Stop.** Either the decision was wrong and you should propose a change (backed by evidence), or you're missing context and should re-read `ENGINE-ELECTRON-DECISIONS.md`. Don't silently override.

Example of a valid override: "the spike showed that synchronous fan-out inside the main process introduces 3ms latency jitter. We need to move fan-out to a worker thread." That's a real finding, and decisions update.

Example of an invalid override: "I don't like the tray icon UX and want to use a full window instead." That's preference, not evidence. Leave it.

---

## What to do if the spike reveals a problem

The whole point of a spike is to find problems early. If you find one:

1. Document what you found. Exact behavior, reproduction steps, latency numbers, OS + Node + Electron versions.
2. Don't abandon Electron without evidence. Try 1-2 fixes first (worker thread, different API).
3. If Electron fundamentally doesn't fit, alternatives exist (plain Node + NSSM service is the fallback — works, no UI).
4. Update `ENGINE-ELECTRON-DECISIONS.md` with the finding in the "Change log" section.
5. Update `UNCERTAIN-PROTOCOLS-CHECKLIST.txt` Part 6 with the outcome.
6. Before committing a pivot, propose to Bill with the evidence.

---

## After the spike succeeds

Mark complete:
- `ENGINE-ELECTRON-DECISIONS.md` change log
- `UNCERTAIN-PROTOCOLS-CHECKLIST.txt` Part 6 first item
- Memory `project_v3_rebuild.md` "Pending work" section

Next action choices:

**Option A — Phase 0 setup** (couple hours)
- Git tag `v2.x-pre-rebuild` baseline
- Install Vitest, write sample test
- Populate `/v3/tests/fixtures/cls/{H,J,T,U}/` with real fixtures from past shows
- Build the UDP log replay harness

**Option B — Start real engine code**
- Begin Electron engine proper (Track A in V3-BUILD-PLAN)
- Uses the spike's fan-out pattern but adds parsing, HTTP posting, configuration

**Option C — Start shared JS module extraction**
- Phase 1 of V3-BUILD-PLAN
- Extract `west-format.js` from display-config.js
- Begin the discipline-split module migration

Any of the three is valid next. Bill picks based on what feels right.

---

## Files you might create during the spike (all throwaway)

```
/v3/spike/
  ├── package.json
  ├── electron-builder.yml
  ├── main.js                 (the 50-line Electron app)
  ├── icon.ico                (can be a placeholder PNG)
  └── README.md               (what this is, how to run)
```

After spike: these can be committed to main for historical record, or deleted. Bill's preference — probably keep for 1 sprint then archive to `/files old/`.

---

## Quick reference card

| What | Where |
|---|---|
| v2 production code | repo root (untouched) |
| v3 planning docs | `docs/v3-planning/` (this folder) |
| v3 code skeleton | `/v3/js/` (module stubs only) |
| v3 spike will live at | `/v3/spike/` (to be created) |
| Session notes | `/session-notes/` |
| Memory | Claude memory folder (not in repo) |
| v2 watcher deploy target | `c:\Users\bwort\OneDrive - Worthington Event Solutions & Technology LLC\Live Scoring Deployment\west-watcher-v1.0\` |
| Preview Pages | `preview.westscoring.pages.dev` |
| Production Pages | `westscoring.pages.dev` |
| Worker | `west-worker.bill-acb.workers.dev` |

---

## If you get stuck

- **Article 1 violation** (mixing hunter/jumper fields) — re-read `feedback_class_type_commandment.md` memory. Stop, restate which lens you're on, resume.
- **Tempted to refactor v2** — don't. "We're not going to optimize v2" is a Bill directive. Consolidation happens during v3 module extraction.
- **Unclear which doc is authoritative** — if two docs disagree, `*-METHODS-REFERENCE.md` beats `CLASS-RULES-CATALOG.txt` (pre-Session 28), and `ENGINE-ELECTRON-DECISIONS.md` beats any earlier hand-wave about Electron.
- **Bill's tired / short** — respect it. Ship the smallest complete thing. Defer detail. Save to docs.
- **Stuck on a quirk** — log it as a `parse_warning` candidate, add to `UNCERTAIN-PROTOCOLS-CHECKLIST.txt`, move on. Never patch in place without documenting first.

---

## One last reminder

Bill, Session 27: "a lot is riding on this working."

This platform is business-critical. Reliability > cleverness. Every architectural decision should favor boring, debuggable, rollback-friendly choices. The spike is a gate specifically because we'd rather find Electron problems in 50 lines of throwaway code than 5000 lines of production engine.

Good luck with the spike. Report back after.
