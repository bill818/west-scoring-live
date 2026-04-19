# Ryegate Files — Update Semantics Quick Reference

**Purpose:** consolidated answers to "when does this file change, and can I trust the change signal?" for the three on-disk files our system reads from Ryegate. Focused on write triggers, timing lag, and known gotchas — not full column layouts (see per-file spec docs for those).

**Scope:** the engine builder should be able to answer "when do I read? how do I know it's fresh? what lies?" without chasing 27 session notes.

---

## At-a-glance table

| File | Path | Who writes | When it's written | Change-detection signal we trust | Notes |
|---|---|---|---|---|---|
| `config.dat` | `C:\Ryegate\Jumper\config.dat` | Ryegate Timing | Hardware settings change (UDP port, serial port) + clean exit | mtime bump → re-read col[1] (port) | In-memory cached mid-run; many fields lie on disk until flushed |
| `tsked.csv` | `C:\Ryegate\Jumper\tsked.csv` | Ryegate Timing | Schedule edits, Post Jump Order, Upload Results | **Parsed-content diff** (NOT mtime alone) | "Upload Results" touches mtime without changing content |
| `NNN.cls` | `C:\Ryegate\Jumper\Classes\NNN.cls` | Ryegate Timing | Jumper: after each round scored. Hunter: when score posted. | mtime bump + full re-parse | fs.watch lag up to hundreds of ms behind UDP |

---

## 1. `config.dat`

### What we use it for
Exactly one thing today: **reading col[1] to auto-discover the UDP scoreboard port.**

v2 funnel and watcher both do this at startup. v3 engine will continue to. Default falls back to 29696 if the file or column is unreadable.

**Source:** `west-funnel-v1.0/west-funnel.js:82-91` (`detectInputPort()`) and `west-watcher-v1.0/west-watcher.js:2788`.

### Write semantics (confirmed, CLS-FORMAT.md:897-922)

Ryegate reads config.dat at startup and **holds every field in memory** while running. It does NOT continuously flush to disk.

**Flush triggers (file actually gets written):**
- Changing hardware settings (UDP port, serial port) → entire in-memory snapshot written
- Clean Ryegate exit → final flush

**Does NOT flush:**
- In-UI toggles (e.g., Live Scoring checkbox) — stay in memory only
- Crash → in-memory state lost entirely

**Consequence:** if you read any column OTHER than col[1] mid-run, the value on disk may not match Ryegate's runtime state. Don't do it unless you already know the specific column is flush-triggered.

### Read strategy for v3 engine

- Read col[1] at startup → INPUT_PORT
- Watch config.dat mtime → if it bumps, re-read col[1] and re-bind UDP listener
- Do NOT assume any other column is truthful without explicit verification

### What we DON'T have mapped

The v3 planning docs do NOT contain a confirmed column-by-column map of config.dat. The funnel's sample line reads:

```
Select COM port...,29696,FDS,68.178.203.100,SHOWS/NONWEST,ftpryegate01@ryegate.com, ,True,True,0,False,False,False,4,4,6,0,2,0,1,0,0,True,False,False,925,devon,False,True,Carolina,Select COM port...,1,True,True,SMS,,False,False,False,,,False
```

Col[0]=COM port, col[1]=UDP port, col[3]=ftp IP — most of the rest is guesswork. **We don't need the rest yet.** If a future v3 feature needs another column, map it then, don't fabricate it now.

### Open questions (not blockers for v3 engine)
- Does the file ever contain non-ASCII characters? (affects encoding choice)
- Do multiple rings on one PC share one config.dat, or each write their own?

---

## 2. `tsked.csv`

### What we use it for
**Class schedule** — tells us which classes exist, which day they run, and which ones have had their Jump Order posted.

v2 watcher polls this file and POSTs `/postSchedule` to the worker when content changes. The posted schedule drives the admin page, public class list, and (critically) is part of the LIVE-gate logic for a class to show on the public site.

### Format (CLS-FORMAT.md:50-70)

```
<ShowName>,"<DateRange>"
<ClassNum>,<ClassName>,<Date M/D/YYYY>,<Flag>
<ClassNum>,<ClassName>,<Date M/D/YYYY>,<Flag>
...
```

Flags we've observed:
- (empty) = normal scheduled class
- `JO` = Jump Order has been posted → class transitioned from SCHEDULED to OOG POSTED
- `S` = **likely "results uploaded / scored" — NOT "championship."** Evidence:
  - SESSION-NOTES-21: Bill observed the S flag appearing on tsked.csv *at the same moment* the `Export/{N}.csv` was produced — i.e., when the operator clicked "Upload Results"
  - CLS-FORMAT.md:887-891 (dated 2026-03-31, marked "Confirmed"): "S = Scored/Finished (hunter classes, indicates results are finalized) ... **NOTE: S is NOT championship — championship is H[11] IsChampionship in the .cls header**"
  - Contradiction still in repo: CLS-FORMAT.md:66 and CLASS-DETECTION-SCHEMAS.md:129 still describe S as "Championship class." Outdated — the 2026-03-31 note supersedes them.
  - **Unresolved:** every S observation we have was *also* a championship class, so we haven't isolated whether S appears on non-championship classes when results are uploaded. Testing this would prove the hypothesis definitively.
- Implied `L` / live-badge on website = class is currently in progress

### Write semantics — the "mtime trap" (CLASS-DETECTION-SCHEMAS.md:134-140)

**Gotcha documented in Session 25:** Ryegate's "Upload Results" button touches tsked.csv's mtime **without changing its content**.

Early watcher versions treated every mtime bump as a schedule change → spam-posted `/postSchedule` → KV writes wasted, worker log flooded.

**The rule (v1.8+, carries into v3):**
> Watcher caches last-posted tsked.csv content. Only POST `/postSchedule` when the **parsed content** actually differs. Never trust mtime alone.

Hash or string-compare last-seen content. If match → silent drop.

### Polling cadence (v2 pattern — CLASS-DETECTION-SCHEMAS.md:142-154)

- **IDLE:** 45s poll when nothing's happening
- **ACTIVE:** 5-15s poll after a recent change
- **WAKE_UP:** immediate poll on startup or suspicious silence
- Transitions: STARTUP → WAKE_UP → ACTIVE or IDLE; ACTIVE → (3 clean polls) → IDLE

v3 engine should carry this shape forward. The cost of polling is negligible vs the cost of missing a schedule update.

### Culpeper gap — when tsked lags behind .cls

The HIGH-priority v3 fix documented in `CLASS-DETECTION-SCHEMAS.md` Part 6.1:

> Operator Ctrl+A's a class, enters a horse, .cls file is being written — but tsked.csv hasn't picked up the JO flag yet. v2's post-Session-25 gate required tsked confirmation → class failed the gate and never showed live publicly.

**v3 fix:** secondary activation path via `.cls-change` — if a class is selected AND its .cls was written recently AND it appears in tsked.csv, mark it LIVE without waiting for JO flag. See CLASS-DETECTION-SCHEMAS.md Part 6.1 for the full spec and acceptance test procedure.

### Open questions
- Does `S` appear on a **non-championship** hunter class when results are uploaded? That would prove `S` = "results posted" rather than a confounded championship correlate. Easy to test in a calm week.
- Are there flag values besides (empty), JO, S, L?
- Exact cadence: how long from operator action in Ryegate UI to tsked.csv flush?

---

## 3. `.cls` files

### What they are
**Per-class scoring files.** One file per class, named by class number (e.g., `221.cls`). Located at `C:\Ryegate\Jumper\Classes\`.

Primary data source for entries, round results, and live standings. Full format spec: `CLS-FORMAT.md` (1,326 lines).

### Write timing — hunter vs jumper DIFFER

**Jumper (classType=J or T):**
- Writes **after each round is scored** (R1, R2/JO, R3) — Ryegate writes the entire file atomically
- Does NOT write while a horse is on course
- On-course state is carried entirely by UDP frames (`{fr}=1` intro → `{fr}=4/5/6` on course → `{fr}=7/8` finish)
- `.cls` reading lets us rebuild standings AFTER rounds complete; UDP drives the live clock and on-course display

**Hunter (classType=H):**
- Does NOT write when horse goes on course (On Course click in Ryegate)
- Writes immediately when a **score is posted** (judge card entered)
- `{fr}=11` UDP INTRO is the only on-course signal for hunters
- `.cls` is authoritative for all hunter scoring — we don't need to parse FINISH UDP

**Consequence for the engine:**
- Watch `.cls` mtime → re-parse the whole file → diff against last-known state → emit change events
- Don't assume the `.cls` gives you on-course info. That's UDP's job.
- Don't assume UDP gives you final scores. That's `.cls`'s job.

### fs.watch lag (CLS-FORMAT.md:1024-1040)

Windows fs.watch can lag the actual disk write by **hundreds of milliseconds**.

**Concrete symptom:** after a hunter Display Scores UDP frame arrives, a naive re-read of `.cls` may still return the stale (pre-score) contents for ~500ms.

**v2 workaround (already in watcher, carry to v3):**
> On UDP `{fr}=12/16` (Display Scores), force a fresh `.cls` read off disk AND post that immediately, BEFORE emitting the FINISH event. Live page shows the right number instead of briefly flashing the R1-only state.

### File creation / lifecycle
- `.cls` file is created when Ryegate opens a class (operator Ctrl+A or similar)
- Subsequent writes add entry rows as operator builds the roster
- Atomic writes per round mean you never read a half-written file — but fs.watch can still lag the write event

### Culpeper gap (cross-ref with tsked.csv above)

`.cls` gets written before tsked.csv does in the Ctrl+A-then-first-entry scenario. The v3 fix uses `.cls-change` as an earlier activation signal than waiting for tsked JO. Full detail in CLASS-DETECTION-SCHEMAS.md.

### Classtype gatekeeper reminder (Article 1)

**col[0] of row 0 = classType ∈ {H, J, T, U}.** The classType determines which lens to read all other columns under. `col[7]` means `numJudges` in hunter lens and `R1_FaultsPerInterval` in jumper lens. Both are correct, SEPARATELY. Don't mix.

Full detail in `feedback_class_type_commandment.md` memory.

### Open questions
- Exact fs.watch lag distribution? (We only have "hundreds of ms" as the upper bound)
- When is the .cls file CREATED — at Ctrl+A, or at first entry?
- Does watcher need to detect `.cls` DELETION (class removed from Ryegate)?
- Is the atomic-write pattern identical across Farmtek (J) and TOD (T) hardware?

---

## Summary — engine read strategy at a glance

```
AT STARTUP:
  Read config.dat col[1] → INPUT_PORT (fallback 29696)
  Bind UDP listener → fan out to RSServer@INPUT_PORT+1
  Read tsked.csv → publish schedule
  Read all .cls files in Classes/ → publish initial class state

CONTINUOUSLY:
  Watch config.dat mtime → if bumped, re-read col[1], rebind UDP
  Watch tsked.csv mtime → on bump, re-parse + diff content → POST if changed
  Watch .cls files mtime → on bump, re-parse full file → diff → emit events
  Receive UDP → synchronous fan-out → then parse → emit events

ON DISPLAY SCORES UDP (hunter {fr}=12/16):
  Force fresh .cls re-read + post BEFORE emitting FINISH event
  (beats the fs.watch lag)
```

---

## Sources

- `docs/v3-planning/CLS-FORMAT.md` — column layouts, write semantics, fs.watch lag
- `docs/v3-planning/CLASS-DETECTION-SCHEMAS.md` — tsked state machine, Culpeper fix, polling cadence
- `docs/v3-planning/UDP-PROTOCOL-REFERENCE.md` — UDP frame definitions referenced above
- v2 source: `west-funnel-v1.0/west-funnel.js` (config.dat port auto-detect)
- v2 source: `west-watcher-v1.0/west-watcher.js` (tsked + .cls polling + hash-gate)
- Memory: `feedback_class_type_commandment.md` (Article 1 — classType is THE LENS)
- Session notes 25 (tsked no-op touch fix), 27 (heartbeat-as-authority context), 28 (Culpeper activation fix + v3 direction)

If a session note, memory, or code comment contradicts this doc, **this doc is wrong** — update it, don't change the source.
