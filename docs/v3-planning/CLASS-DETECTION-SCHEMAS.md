# Class Detection Schemas — v3
### The logic for knowing when a class is live, when to peek, how to classify state

---

> # ⚠️ ARTICLE 1 — classType IS THE GATEKEEPER (applies to ALL .cls parsing, including detection)
>
> **Before any detection logic runs, the parser reads `classType` at col[0] of row 0. That value — `H`, `J`, `T`, or `U` — determines the LENS for every subsequent field read.**
>
> - `H` → Hunter lens. Go to `HUNTER-METHODS-REFERENCE.md` for field meanings.
> - `J` → Farmtek Jumper lens. Go to `JUMPER-METHODS-REFERENCE.md` for field meanings.
> - `T` → TOD Jumper lens. Same field meanings as J, different hardware quirks.
> - `U` → No lens yet. See Part 1 below for resolution logic.
>
> A .cls is STRICTLY TYPED by classType. Hunter data and jumper data NEVER coexist in the same file. Any detection rule that reads a .cls field must first commit to a lens via classType.
>
> If you catch yourself (or another Claude) saying "col[10] usually means X" without specifying the lens — stop. Ask: what's the classType? Then apply the correct lens.
>
> See memory `feedback_class_type_commandment.md` for the full rationale.

---

v2 built up a complex class-lifecycle detection system across ~10 sessions. Every rule was earned from observation — classes appearing as live when they weren't, classes disappearing from live when they still were, phantom on-courses, buzzer noise, phase transitions fooling the watcher. **All of it must carry into v3.**

This doc catalogs every detection trigger, every state transition, every "when to peek" rule, and the reasoning behind each. v3's push architecture changes nothing about class detection — it all happens on the watcher, driven by filesystem watches + UDP events + periodic HTTP peeks. What changes is the DELIVERY of detected events (they publish to a Durable Object instead of the worker's KV).

---

## Part 1 — The Class Lifecycle State Machine

Every class passes through a sequence of states. The watcher's job is to detect which state a class is in and communicate that to the worker/DO accurately.

```
    NONE ─────────► SCHEDULED ─────► OOG POSTED ─────► IN PROGRESS ─────► COMPLETE
     ▲                  │                 │                    │               │
     │                  │                 │                    │               │
     └──────── (class deleted in Ryegate / tsked)──────────────┴───────────────┘
```

**Detection signals per state:**

| State | Detection signal | Source |
|---|---|---|
| NONE | Class has no `.cls` file, no tsked entry, no UDP activity | default |
| SCHEDULED | Class appears in `tsked.csv` with a scheduled date | filesystem watch on tsked.csv |
| OOG POSTED | `OrderOfGo.jpg` appears on ryegate.live for the class | HTTP peek or tsked flag `JO` |
| IN PROGRESS | Watcher sees ON_COURSE UDP event OR `live.jpg` badge on ryegate | UDP + peek |
| COMPLETE | tsked.csv shows class gone from LIVE badge OR ryegate peek classifier says UPLOADED | tsked gate-drop OR peek |

**State transitions can be EVIDENCE-BASED or INFERRED.** The watcher prefers evidence (real UDP event, real file change) over inference. When they conflict, evidence wins — but a stale evidence is worse than a fresh inference.

---

## Part 2 — Detection Trigger Sources

The watcher detects class state changes from 5 independent sources. Each trigger has a cadence and a scope.

### 2.1 — `.cls` File Watch (per-class, instant)

- **Source:** Filesystem watcher on `C:\Ryegate\Jumper\Classes\*.cls`
- **Cadence:** Instant on file change (fs.watch)
- **Scope:** One class at a time
- **Fires:** Class metadata parsed → POST /postClassData with full standings snapshot
- **Signals:** Operator opened the class in Ryegate, OR a round was scored
- **What it doesn't tell us:** Whether the class is live RIGHT NOW (file doesn't update during on-course, only after scoring)

### 2.2 — UDP Scoreboard Feed (per-ring, continuous)

- **Source:** UDP listener on the scoreboard port (typically 28000)
- **Cadence:** Continuous, ~1Hz during active classes
- **Scope:** Currently-selected class for the ring (one at a time)
- **Fires:** Parsed events — INTRO, CD_START, RIDE_START, FAULT, FINISH, CLASS_SELECTED, CLASS_COMPLETE
- **Signals:** Real-time class activity
- **What it doesn't tell us:** Anything about classes the operator isn't currently running

### 2.3 — `tsked.csv` File Watch (ring-level, frequent)

- **Source:** Filesystem watcher on `C:\Ryegate\Jumper\tsked.csv`
- **Cadence:** Instant on file change
- **Scope:** All classes in the ring
- **Fires:** POST /postSchedule with full schedule (class_num, date, order, flag)
- **Signals:** Operator added/modified/completed a class; JO flag posted; LIVE badge transitioned
- **Authoritative for:** Schedule, OOG posting (JO flag), class completion (LIVE badge dropped)

### 2.4 — `ryegate.live` HTTP Peek (per-class or per-ring, periodic)

- **Source:** HTTPS fetch of Ryegate's public class pages
- **Cadence:** Adaptive — see Part 4 for rules
- **Scope:** Per-class peek OR ring-level `tsked.php` peek
- **Fires:** Classification of current state (4 states — see reference memory)
- **Signals:** What Ryegate is publishing publicly (source of truth for spectator-facing state)
- **Used for:** Detecting OOG posted, IN_PROGRESS, UPLOADED, NO_DATA states when UDP is silent

### 2.5 — Operator Ctrl+A in Ryegate (watcher inference)

- **Source:** The `selected` class in Ryegate changes → UDP `CLASS_SELECTED` event
- **Cadence:** On operator action
- **Scope:** One class at a time
- **Fires:** POST /postClassEvent CLASS_SELECTED
- **Signals:** Operator is setting up a new class (not yet actually running horses)
- **v2 lesson (SESSION-25):** Ctrl+A alone is NOT enough to mark a class LIVE — it's just operator prep. The tsked.csv gate must also confirm (class is in tsked AND either OOG-posted or first-horse intro'd) before we advertise it as live on the public site. This avoided phantom "live" classes while operators were configuring.

---

## Part 3 — tsked.csv Interpretation Rules

The tsked.csv file is the RING-LEVEL schedule. Every operator action that affects class scheduling flows through here.

### 3.1 — File format (confirmed 2026-03-31 from Devon Fall Classic data)

```
Row 0: ShowName,"DateRange"
Row 1+: ClassNum,ClassName,Date(M/D/YYYY),Flag
```

Example:
```
2025 Devon Fall Classic,"September 11-14, 2025"
48,"$1,000SUMMER CLASSIC METER .90 JUMPER II.2B",9/14/2025,
48C,METER .90 JUMPER Championship,9/14/2025,S
9,"$25,000 DEVON FALL CLASSIC 1.35-1.40m II.2a",9/13/2025,
```

### 3.2 — Flag column values

| Flag | Meaning | v3 rule |
|---|---|---|
| (empty) | Normal class (scheduled) | SCHEDULED state |
| `S` | Championship class (hunter only, when finalized) | Overlay: class is a championship. Display treats it as a hunter championship. |
| `JO` | Jump Order posted — display order of go on website | Transition: class → OOG POSTED. Peek class page to enrich with actual OOG if needed. |
| `L` or live-badge implied | Class is live (horses are going) | Transition: class → IN PROGRESS |
| Gone from file | Class completed or deleted | Transition: class → COMPLETE (if previously LIVE) or removed |

### 3.3 — Change detection (SESSION-25 — the "no-op touch" problem)

Ryegate's "Upload Results" button touches tsked.csv's mtime WITHOUT changing its content. Early watcher versions treated every mtime bump as a schedule change and spam-posted /postSchedule — worker logs flooded, KV writes wasted.

**Rule:** Watcher caches last-posted tsked.csv content. Only post /postSchedule when the PARSED CONTENT actually differs, not on mtime alone.

**v3 carries this forward:** content-hash diffing in the watcher, same as v1.8+.

### 3.4 — tsked mode states (watcher-side SESSION-22+)

The watcher has an internal mode for tsked polling:
- **IDLE:** No recent changes, poll every 45s
- **ACTIVE:** Recent change detected, poll every 5-15s
- **WAKE_UP:** Cold start or suspicious silence, immediate poll

Transitions:
- Startup → WAKE_UP → (poll) → ACTIVE (if change found) or IDLE (if clean)
- ACTIVE → (3 clean polls in a row) → IDLE
- IDLE → (file change detected) → ACTIVE

**v3 rule:** preserve this state machine. Reduces ryegate.live server load while keeping detection snappy during operator activity.

---

## Part 4 — ryegate.live Peek Rules

The watcher peeks ryegate.live for two reasons:
1. **Classifier** — determine current class state (4-state classifier per reference memory)
2. **Enrichment** — pull OOG data from the web page when tsked JO flag is set

### 4.1 — The 4 class-page states (per `reference_ryegate_web_states.md` memory)

Bill confirmed these definitively 2026-04-15. They are the AUTHORITATIVE states:

| State | Visual evidence | Meaning |
|---|---|---|
| `NO_DATA` | Class page returns 404 or blank | Class not yet created on ryegate.live (Ryegate hasn't uploaded) |
| `OOG_POSTED` | `OrderOfGo.jpg` banner visible | Operator pressed "Post Jump Order" — public sees the order of go but class hasn't started |
| `IN_PROGRESS` | `live.jpg` badge visible + result rows present | Class is actively scoring (horses going, results being posted in real-time) |
| `UPLOADED` | Result rows present, no `live.jpg` badge | Class finished, final results uploaded to Ryegate |

### 4.2 — When to peek (adaptive cadence)

Peeking ryegate.live is the MOST EXPENSIVE signal source — HTTPS fetch, HTML parse. Keep it scoped.

**DON'T peek:**
- Every class, every few seconds (overkill, rate-limiting risk)
- Classes not in tsked.csv (they don't exist)
- Classes already in UPLOADED state (no new data possible)

**DO peek:**
- On tsked JO flag transition (class just got OOG-posted) — one-shot confirmation
- On tsked LIVE badge drop (class just finished) — confirm UPLOADED before marking COMPLETE
- During stale-peek sweep (every 5 min) — ALL active classes, sanity check
- On UDP silence for >15 min during expected class-active window — "is this class actually still live?"
- On cold-start — initial classification of every active class

### 4.3 — Ring-level peek (tsked.php) — SESSION-22+

Instead of peeking every class individually, watcher fetches the RING'S tsked.php page once and classifies all classes in one request.

**When to use ring-level peek:**
- Every 45s during ACTIVE mode
- Every 2-3 min during IDLE mode
- Cheap signal: one HTTP, N classes classified

**When to fall back to per-class peek:**
- Ring peek shows ambiguous badge state for a specific class
- Per-class data enrichment (pull actual OOG order from web page)

### 4.4 — Stale-peek sweep (SESSION-25/26)

Every 5 minutes, the watcher sweeps ALL active classes (any class that's been posted to worker in the last 24h) and peeks ryegate.live. Catches classes where:
- UDP stopped silently (watcher missed a CLASS_COMPLETE event)
- tsked.csv didn't get the LIVE-badge-drop signal
- Operator moved to a different ring without closing the class cleanly

**v3 rule:** preserve the 5-min sweep. It's the safety net that catches "class is done but we didn't notice."

---

## Part 5 — Phase Transition Detection

Two-phase classes (Method 9 II.2d + Method 11 II.2c) have a specific detection challenge: the buzzer fires TWICE per ride (once at phase-1 end, once at phase-2 end). Without special logic, the watcher would fire a false ONCOURSE event at phase-1-end because the horse is "still on course" but the UDP briefly flickers FINISH → silence → ONCOURSE again.

### 5.1 — FINISH_LOCK (SESSION-26)

**Mechanism:** After firing a FINISH event, the watcher sets `finishLockUntil = Date.now() + 5000` (5 seconds). During this window:
- ONCOURSE events are SUPPRESSED (not re-fired)
- TA-change events that accompany phase-2 start ARE allowed through
- After 5s, normal detection resumes

**Tuning (per JUMPER-METHODS-REFERENCE.md):**
- Farmtek hardware: 5s lock matches the automatic 5-second hold. Correct.
- TOD hardware: operator-gated transition, variable duration. 5s may be too short. **v3 should make the lock duration adaptive or operator-gated for TOD.**

### 5.2 — Phase transition signals

During Method 9 or Method 11 phase transition:
- Phase 1 `FINISH` event fires with decimal elapsed time
- UDP goes silent briefly
- Phase 2 UDP resumes with TA change (e.g. TA:90 → TA:55)
- Elapsed resets visually (Farmtek hold artifact — elapsed shows ~5 on resume)

**Detection rule:** a new ONCOURSE after a FINISH within FINISH_LOCK window + TA change = phase 2 start, not a new horse. Watcher treats this as PHASE_2_START, not RIDE_START.

**v3 rule:** encode this in the watcher as a first-class state machine, not just a boolean lock. The state machine is: `ONCOURSE → FINISH → FINISH_LOCK → (PHASE_2_ONCOURSE | RIDE_START)` where the decision depends on class metadata (is this a two-phase class?) and TA change.

---

## Part 6 — Class-Active Detection (What Goes on the Public Site)

A class appearing as "LIVE" on live.html or classes.html is a UX commitment: viewers tune in expecting actual activity. False positives (class shown live when nothing is happening) hurt credibility more than false negatives (class not shown live when it actually is).

### 6.1 — The gate (SESSION-25 + SESSION-26)

A class is marked LIVE on the public site ONLY when ALL of:

1. Class is in `tsked.csv` for the current ring
2. Class has either (a) OOG flag `JO` posted OR (b) a horse has actually intro'd (UDP ON_COURSE fired)

Just operator Ctrl+A is NOT enough. Just a CLS file existing is NOT enough.

### 6.1.1 — The Culpeper 2026-04-17/18 gap — MUST FIX IN v3

**Observation (Bill, Session 28):** At Culpeper Day 3/4, live classes did NOT display as live when the operator hit Ctrl+A anymore.

**Root cause (most likely):** The Session 25 tsked-gate rule over-corrected. When tsked.csv doesn't transition cleanly (Ryegate tsked write lagged, JO flag didn't post before horses started running, or operator forgot to hit Post Jump Order), the class fails the gate forever and never shows live publicly — even while the operator is actively running horses through it in Ryegate.

**The v3 fix — additional activation path (Bill's proposal):**

A class is marked LIVE on the public site when ALL of:

1. Class is in `tsked.csv` for the current ring
2. Class has ANY of:
   - (a) OOG flag `JO` posted in tsked, OR
   - (b) a horse has actually intro'd (UDP ON_COURSE fired), OR
   - (c) **NEW:** class is currently SELECTED in Ryegate (Ctrl+A'd) AND the class's `.cls` file was written/changed within the last 5 minutes

The (c) rule creates a second path to LIVE that catches the Culpeper case: operator Ctrl+A's a class, the .cls gets written when they enter the first horse, and the watcher marks LIVE without waiting for tsked to catch up.

**Safety constraint — why this doesn't reintroduce phantom live:**
- Only a SELECTED class can trigger path (c). Random .cls changes to scheduled-but-unselected classes don't mark anything live.
- Still requires tsked.csv to contain the class (rule 1). A class nobody scheduled can't go live.
- 5-minute window keeps the signal fresh — stale .cls writes from old scorings don't trigger activation.

**Logging for learning:** When path (c) triggers (i.e., a class went LIVE via .cls-change instead of tsked JO), log as a `parse_warning` with type `'class-activation-via-cls-change'`. Tells us how often the Culpeper gap was the actual path. If it's common, consider relaxing rule 1 or adding more fallbacks. If it's rare, we caught something real without side effects.

**Priority:** HIGH. First detection rule to implement in the v3 watcher. v3 cannot ship reproducing this gap.

**ACCEPTANCE TEST PROCEDURE (run at first show v3 engine deploys):**

> Run before the engine goes live for the full show. Schedule for a morning warm-up class or early division.

### Pre-test setup (the day before / morning of)
1. Confirm the scoring PC has v3 engine installed + running
2. Confirm engine version includes the .cls-change activation path (check `ENGINE-ELECTRON-DECISIONS.md` release notes for "v1.0 includes Culpeper fix")
3. Open `parse_warnings` query tab in admin: `SELECT * FROM parse_warnings WHERE warning_code='class-activation-via-cls-change' ORDER BY created_at DESC LIMIT 20`
4. Open public live.html for the ring on a separate device (phone or second laptop)
5. Open watcher/engine log tail: `c:\west\west_log.txt`

### Test A — Normal tsked path still works (regression check)
1. Operator selects a class normally (Ctrl+A) where tsked.csv has already been updated with JO flag
2. **Expected:** class appears LIVE on public site within ~2 seconds of Ctrl+A
3. **Expected:** parse_warnings has NO new `class-activation-via-cls-change` entry — it activated via the normal tsked path
4. **If fail:** regression — the tsked gate is broken. Roll back engine.

### Test B — The Culpeper gap (the actual acceptance test)
1. Operator selects a class via Ctrl+A BEFORE posting JO in Ryegate
   (To simulate: either deliberately skip the JO post, or pick a class where tsked hasn't yet reflected any activity)
2. **Immediately observe:**
   - Class does NOT appear LIVE on public site (gate blocks it — correct)
   - Log shows: "[CLASS_SELECTED] class N — WAITING for tsked/cls evidence"
3. Operator enters the first horse into the class in Ryegate (causes .cls file write)
4. **Within 5 seconds after .cls write, expect:**
   - Class appears LIVE on public site
   - Log shows: "[CLASS_LIVE] class N — activated via .cls-change path (c)"
   - `parse_warnings` has new row: `warning_code='class-activation-via-cls-change'` with class metadata
5. **If fail at step 4:**
   - Class stayed NOT-LIVE: the .cls path isn't activating. Check engine code for the path-(c) branch.
   - Class went LIVE but via wrong path logged: activation attribution bug. Worth fixing but not critical.

### Test C — Safety check (phantom live protection)
1. Take a class that is in tsked.csv but NOT currently selected (no Ctrl+A)
2. Trigger a .cls write on it (e.g., operator opens it briefly in Ryegate, no scoring)
3. **Expected:** class does NOT go LIVE on public site
4. **Expected:** log shows: "[CLS_CHANGE] class N — not selected, ignoring activation signal"
5. **If fail:** the .cls-change path is too loose. Unselected classes shouldn't activate. Tighten the "class is currently SELECTED" condition.

### Pass criteria for the overall fix
- Test A pass (no regression) AND
- Test B pass (Culpeper gap closed) AND
- Test C pass (no phantom live)

### Data to capture
- Screenshots of live.html at each step (before activation, after activation)
- `c:\west\west_log.txt` covering the test window
- `parse_warnings` rows created during the test (via admin query)
- Timing observations: how long from Ctrl+A to tsked update? How long from .cls write to public-site LIVE?

### If the fix passes
- Mark Test B item complete in `UNCERTAIN-PROTOCOLS-CHECKLIST.txt` Part 3 with date + show name
- Update this doc: change "MUST FIX IN v3" header to "FIXED IN v3 — verified at [show name] [date]"
- Update memory `project_class_detection.md` with verification result

### If the fix fails
- Capture all data above
- Do NOT roll the engine back unless it's actively causing harm
- Open a diagnostic session to understand why
- Consider rolling back to v2 watcher for remaining show days if unstable

### Who runs this test
Bill, with the engine developer (possibly Devon) on standby via text/call. First show the engine deploys to should be a smaller venue or a ring where a regression is recoverable.

### 6.2 — Adding a class to the active array

Worker KV maintains `active:{slug}:{ring}` — array of currently-live classes. A class is added via:

- POST /postClassEvent `CLASS_SELECTED` AFTER tsked gate passes (operator Ctrl+A while tsked agrees)
- Auto-added from ON_COURSE event (worker handler auto-adds the class to active if a horse goes on course — evidence-based)

### 6.3 — Removing a class from the active array

A class is removed when:
- tsked.csv LIVE badge drops for that class + peek confirms UPLOADED
- POST /postClassEvent `CLASS_COMPLETE` fires (operator pressed "Class Complete")
- Class hasn't had UDP activity in >30 min AND peek confirms UPLOADED or NO_DATA

### 6.4 — Numeric status fallback

When a class completes, status codes may live in the .cls at cols[21]/[28]/[35] as numerics (1=EL, 2=RT, 3=OC, 4=WD, 5=RF, 6=DNS) even if the text field is empty. Watcher falls back to numeric when text is missing — the class can be marked complete without UDP FINISH events for every entry (especially WDs).

---

## Part 7 — v3 Changes (Same Detection, New Delivery)

The detection logic described above LIVES ON THE WATCHER in v3, same as v2. The watcher is the only component with filesystem access, UDP socket, and ryegate.live access. No detection runs on the worker side.

**What changes in v3:**

- **Watcher POSTs go to the Durable Object for the ring instead of the worker's general handler.** Same payloads, different endpoint. The DO fans out to connected clients.
- **Schedule events become structured.** `/postSchedule` evolves into typed events: `SCHEDULE_UPDATED`, `OOG_POSTED`, `CLASS_LIVE`, `CLASS_COMPLETE`. Each event is handled independently by the DO.
- **Peek results get logged to `udp_anomalies` / `parse_warnings` tables.** When a peek classifier disagrees with watcher internal state, that's observability data. v3 captures it.
- **Stale-peek sweep becomes a scheduled DO task.** The DO can run its own cron-like sweep instead of relying solely on watcher timing. Useful because watchers can restart and lose in-memory state; the DO persists it.
- **The 4 ryegate.live states become first-class event types.** Each state transition emits a structured event the DO can reason about.

**What doesn't change:**

- tsked.csv is still watched via fs.watch on the scoring PC.
- UDP is still listened on port 28000.
- ryegate.live is still peeked via HTTPS.
- The 5s FINISH_LOCK stays (though maybe adaptive for TOD).
- The 5-min stale-peek sweep stays.
- The evidence-over-inference rule stays.
- The tsked-gate rule for class-active stays.

**All the detection WISDOM stays.** Only the communication layer changes.

---

## Part 8 — Detection Events the DO Must Handle

For v3's Durable Object implementation, here's the canonical set of events the watcher emits that change ring state. The DO must handle all of these and broadcast appropriately.

### Schedule events
- `SCHEDULE_UPDATED` — full tsked.csv posted; DO reconciles active classes
- `OOG_POSTED` — class moved to OOG_POSTED state (JO flag or peek)
- `CLASS_LIVE` — class passed the gate (in tsked + OOG or intro fired)
- `CLASS_COMPLETE` — class left LIVE state (tsked drop + peek UPLOADED)

### UDP action events
- `CLASS_SELECTED` — operator Ctrl+A (note: may not be LIVE yet)
- `INTRO` — rider enters ring, class is live if gate passes
- `CD_START` — countdown begins
- `RIDE_START` / `ONCOURSE` — horse crosses start beam
- `FAULT` — penalty added during ride
- `FINISH` — horse crosses finish (enters FINISH_LOCK)
- `PHASE_2_START` — phase-2 began (two-phase methods only)
- `CLOCK_STOPPED` / `CLOCK_RESUMED` — clock paused mid-ride (rare)
- `HUNTER_RESULT` — hunter score posted

### Peek events (from ryegate.live classifier)
- `PEEK_NO_DATA` — class page blank
- `PEEK_OOG_POSTED` — class page shows OOG
- `PEEK_IN_PROGRESS` — class page has live.jpg badge
- `PEEK_UPLOADED` — class page has results, no live badge

### Meta events
- `HEARTBEAT` — watcher alive + clock snapshot (every 1s during active, 60s idle)
- `CLASS_DATA` — full .cls parsed standings (on every .cls change)

**These event names become the canonical v3 schema.** Any future work that touches detection should reference this list; any addition should go here first before code ships.

---

## Part 9 — Open Questions for v3 Implementation

These are decisions Bill should weigh in on before the v3 watcher/DO detection code is written:

1. **Should FINISH_LOCK be adaptive for TOD?** Operator-gated transitions mean the 5s hardcode may be too short. Options: (a) use a longer TOD-specific lock (15s), (b) operator signals phase-2 start explicitly, (c) ignore ONCOURSE during lock regardless of duration.

2. **Should peek classifier results be persisted per-class?** Could store last-known-state + last-peek-time in a `class_state_snapshots` table for audit. Useful for "when did class X transition to complete?" forensics.

3. **Should tsked.csv IDLE/ACTIVE mode be merged with peek cadence?** Currently they're independent. Merging could optimize both together.

4. **Should the DO run its own stale-peek sweep OR rely on the watcher?** DO-side is more reliable (watcher can restart). Watcher-side is already implemented. Could do both with conflict-resolution logic.

5. **Should CLASS_SELECTED events that don't pass the gate be logged?** If operator Ctrl+A's a class but never runs a horse in it, we silently ignore it today. Logging as `class_activation_attempt` might be useful observability.

---

## Part 10 — References

- `reference_ryegate_web_states.md` in Claude memory — authoritative 4-state classifier rules (Bill-confirmed 2026-04-15)
- `CLS-FORMAT.md` (sibling doc in this folder, moved here from repo root in Session 28) — full .cls + tsked.csv column specs
- `SESSION-NOTES-22.txt` — tsked mode state machine introduced
- `SESSION-NOTES-25.txt` — tsked gate rule for class-live + numeric status fallback
- `SESSION-NOTES-26.txt` — FINISH_LOCK for two-phase transitions
- `project_ticking_clock.md` memory — Session 27 arc (the UDP log analysis confirming 1Hz clean source, Farmtek 5s hold artifact)
- `JUMPER-METHODS-REFERENCE.md` — per-method phase transition details
- `project_observability_roadmap.md` — the "Phase 2 audit_events" that will capture peek disagreements
