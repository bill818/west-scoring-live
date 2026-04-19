============================================================
  RYEGATE UDP PROTOCOL — AUTHORITATIVE REFERENCE
  Version 1.0 — 2026-04-18
  Status: AUTHORITATIVE — single source of truth for v3
============================================================

This document consolidates ALL Ryegate UDP frame documentation
from CLS-FORMAT.md, session notes 16-27, the watcher code, the
funnel code, and CLASS-DETECTION-SCHEMAS.md into one reference.

If this doc and another file disagree, THIS DOC WINS.
Update this doc when new frames or tags are discovered.


============================================================
  PROTOCOL BASICS
============================================================

PACKET FORMAT:
  {RYESCR}{fr}N{tag}value{tag}value...

  - {RYESCR} = literal header, always present
  - {fr} = frame number (0-16 observed)
  - {tag} = curly-brace-wrapped integer, e.g. {1}, {17}, {23}
  - Values are plain text between tags (no delimiters)

TWO SEPARATE UDP CHANNELS (independent, DO NOT CONFLATE):

  Channel A — "UDP IN" (ring scoring telemetry)
     - Ryegate outbound port (default 29696, configurable in
       Ryegate config.dat)
     - Funnel/engine receives on this port, fans out to:
         - "UDP in" (port 28000) → engine's input
         - RSServer feed (Ryegate-port + 1, e.g. 29697) → drives
           the physical scoreboard hardware
     - Broadcasts ~1Hz during active class
     - Carries frames 0-16 (live ride telemetry: clock, entry,
       faults, phase, finish)
     - Semantics: WHAT'S HAPPENING IN THE RING RIGHT NOW

  Channel B — "FOCUS SIGNAL" (operator intent)
     - Port 31000, fixed, not configurable
     - Fires on:
         · 1× Ctrl+A → CLASS_SELECTED (focus change)
         · 3× Ctrl+A within 2s → CLASS_COMPLETE (confirmation)
         · HUNTER On Course click → coincident with {fr}=11 INTRO
         · JUMPER On Course click → NOT RELIABLY FIRED on 31000
     - Semantics: WHAT THE OPERATOR IS DOING with Ryegate's
       class management

  These two channels are INDEPENDENT. The engine consumes each
  as its own event stream. Do not use one to validate or
  augment the other's semantics. State machine composition
  happens at a higher level, not at the port-correlation level.

  Naming:
    - "scoreboard" refers ONLY to the PHYSICAL scoreboard in
      the ring (and RSServer's job of driving it).
    - "UDP in" = engine input (port 28000 after funnel fan-out).
    - Never call 28000 the "scoreboard port" — it's the engine
      feed, not a scoreboard driver.

TRANSPORT:
  - Broadcast UDP on the local network
  - 1Hz cadence confirmed (Session 27): zero jitter, zero
    missed frames in 3.0 MB log analysis on Channel A
  - RSServer.exe binds the Ryegate outbound port exclusively
    on Windows (SO_EXCLUSIVEADDRUSE) — the funnel resolves this
    by binding first and fanning out (v2 behavior, continues in
    v3 engine via the Electron-bundled funnel module)


============================================================
  FRAME MAP — UDP IN (Channel A, ring telemetry)
============================================================

────────────────────────────────────────────────────────────
  FRAME 0 — CLEAR SCOREBOARD
────────────────────────────────────────────────────────────
  Type:     Both (jumper + hunter)
  Purpose:  Operator blanked the scoreboard display
  Packet:   {RYESCR}{fr}0{1}[entry]

  Tags:
    {1}  entry number (minimal, may be empty)

  Watcher action:
    - Posts CLEAR_ONCOURSE event to worker
    - Clears lastPhase, lastEntry, lastTa state

  Confirmed: 2026-03-30


────────────────────────────────────────────────────────────
  FRAME 1 — JUMPER PACKET (all jumper class data)
────────────────────────────────────────────────────────────
  Type:     Jumper only (the ONLY frame jumper classes use)
  Purpose:  Carries all live jumper scoring data at ~1Hz

  Tags:
    {1}   entry number
    {2}   horse name
    {3}   rider name
    {8}   rank/place (FINISH signal — strip "RANK" prefix)
    {13}  time allowed TA (strip "TA:" prefix)
    {14}  jump faults (strip "JUMP" prefix)
    {15}  time faults (strip "TIME" prefix)
    {17}  elapsed seconds (ONCOURSE signal)
    {18}  TTB — time to beat (unreliable, disappears mid-round)
    {23}  countdown (CD signal, negative e.g. "-44")

  Phase inference (from tag presence):
    IDLE      → no active horse (no {1})
    INTRO     → {1} present, no {23}/{17}/{8}
    CD        → {23} countdown present
    ONCOURSE  → {17} elapsed present AND numeric, no {8}
    FINISH    → {8} rank present

  Clock behavior:
    - {17} increments 1Hz: el=1, el=2, el=3...
    - {23} decrements 1Hz: CD:-45, -44, -43...
    - Zero jitter, zero missed frames (confirmed S27 log)
    - Clock stop detection: 2.5s timer if {17}/{23} stops
    - v1.11: heartbeat carries full snapshot, browser trusts

  Equitation quirk (Method 7/11):
    - {14} sends text "TIME" (not a number)
    - {15} sends text "FLTS" (not a number)
    - Watcher sanitizes both to '0'
    - {17} in equitation = equitation score on Display Scores
      frame, NOT elapsed time
    - {19} = actual equitation score on DISPLAY_SCORES

  CRITICAL RULE:
    {17} is elapsed time ONLY when {fr}=1 AND value is numeric.
    Hunter {fr}=11 sends {17} as scoreboard message text.
    Always check frame number before interpreting {17}.

  Confirmed: 2026-03-22, refined through S27


────────────────────────────────────────────────────────────
  FRAMES 2–10 — NOT USED
────────────────────────────────────────────────────────────
  Never observed at any show through Culpeper 2026.
  Assumed reserved or unused by Ryegate.
  If any of these appear, LOG IMMEDIATELY and update this doc.


────────────────────────────────────────────────────────────
  FRAME 11 — HUNTER INTRO / ON COURSE
────────────────────────────────────────────────────────────
  Type:     Hunter only (all hunter types incl. equitation)
  Purpose:  Horse goes on course signal

  Cycles between three page layouts (same {fr}=11, different
  tag sets). Ryegate rotates automatically every few seconds.

  PAGE A — Horse / Rider / Owner:
    {1}   entry number
    {2}   horse name
    {3}   rider name
    {4}   owner name
    {5}   (always empty — ignore)
    {14}  H:XX.XXX = current class HIGH score (not this horse)
    {15}  (empty)
    {17}  scoreboard message text (NOT elapsed — IGNORE)

    Example:
    {RYESCR}{fr}11{1}3448{2}BALLPARK{3}TATUM BOOS{4}MARY
    EUFEMIA{5}{14}{15}{17}SB message

  PAGE B — Pedigree:
    {1}   entry number
    {2}   horse name
    {18}  sire name
    {19}  "X" (breeding nomenclature filler)
    {20}  dam name

    Example:
    {RYESCR}{fr}11{1}3448{2}BALLPARK{18}ULYSS MORINDA{19}X
    {20}GHANA VAN'T ZONNEVELD

  PAGE C — Equitation (Method 7):
    {1}   entry number
    {2}   (EMPTY — no horse name in equitation)
    {3}   (EMPTY — not used in equitation)
    {6}   city, state (e.g. "MADISON, NJ")
    {7}   rider name (rider is in {7}, NOT {3})
    {4}   (empty)
    {5}   (empty)
    {14}  (empty)
    {15}  (empty)
    {17}  (empty)

    Example:
    {RYESCR}{fr}11{1}146{2}{7}WENDY CHAPOT NUNN{4}{5}
    {6}MADISON, NJ{14}{15}{17}

  Page detection rules:
    - {3} present        → Page A (horse/rider/owner)
    - {18} present       → Page B (pedigree)
    - {7} present, no {3} → Page C (equitation)

  Watcher action:
    - Page A/B: stores { entry, horse, rider, owner }
    - Page C: stores { entry, locale, rider, isEq=true }
    - Posts ON_COURSE event to worker
    - Flat classes: tracks all seen entries in flatEntriesSeen
      (entries rotate ~2s each during flat judging)

  CRITICAL RULE:
    {17} in frame 11 is ALWAYS a scoreboard message, NEVER
    elapsed time. This caused a false RIDE_START bug (S16).
    The numeric guard ({fr}=1 AND isNumeric) prevents this.

  Confirmed: 2026-03-29, equitation discovered S19 (2026-04-09)


────────────────────────────────────────────────────────────
  FRAME 12 — HUNTER DISPLAY SCORES (regular / non-derby)
────────────────────────────────────────────────────────────
  Type:     Hunter (non-derby scored classes)
  Purpose:  Operator pressed "Display Scores" after judging

  Tags:
    {1}   entry number
    {2}   horse name
    {3}   rider name
    {8}   RANK: [place] (strip "RANK:" prefix)
    {14}  T: [total score] (strip "T:" prefix, e.g. "T:   79.00")
    {21}  1: [judge 1 score] (e.g. "1: 78.00")
    {22}  2: [judge 2 score] (e.g. "2: 80.00")
    {23+} additional judges follow same pattern

  Example:
    {RYESCR}{fr}12{1}194{2}SIR WALLACE{3}WILLIAM SLATER
    {8}RANK: 3{14}T:   79.00{21}1: 78.00{22}2: 80.00

  Watcher action:
    1. Forces fresh .cls file re-read from disk FIRST
       (beats fs.watch lag — prevents stale data race)
    2. Posts /postClassData with fresh content
    3. Posts FINISH event to worker
    4. Logs frame with entry/horse/rider/rank

  NOTE: Score tags ({14}, {21}, {22}) are read for logging only.
  The .cls file is ALWAYS authoritative for actual scores.
  UDP scores are a display convenience, not a data source.

  Confirmed: 2026-04-10 (S20)


────────────────────────────────────────────────────────────
  FRAME 13 — HUNTER STANDINGS (ignored)
────────────────────────────────────────────────────────────
  Type:     Hunter
  Purpose:  Between-rounds standings view (e.g. R1→R2 in derby)

  Tags:     Not fully mapped (no production need identified)

  Watcher action: IGNORED
    - .cls file is already authoritative for standings
    - Website renders standings from .cls data, not UDP
    - No pipeline trigger needed

  Future consideration:
    Could trigger a "STANDINGS DISPLAYED" indicator on
    live/display pages if desired. Low priority.

  Confirmed: 2026-04-10 (S20)


────────────────────────────────────────────────────────────
  FRAME 14 — HUNTER RESULTS / RIBBONS
────────────────────────────────────────────────────────────
  Type:     Hunter (flat and forced classes)
  Purpose:  Operator announces ribbons one entry at a time

  Tags:
    {1}   entry number
    {2}   horse name
    {3}   rider name
    {4}   owner name
    {8}   place text ("1st", "2nd", "3rd", etc.)
    {14}  score (often empty for forced/flat classes)

  Watcher action:
    - Accumulates entries in hunterResults array
    - Deduplicates by entry number (prevents re-adding)
    - Posts HUNTER_RESULT event for each NEW entry
    - Enables live ribbon announcement rendering on website

  NOTE: One entry per frame. Operator clicks through ribbons
  sequentially. The array builds up over multiple frames, not
  all at once.

  Confirmed: 2026-04-10 (S20)


────────────────────────────────────────────────────────────
  FRAME 15 — HUNTER JOG / STANDBY (ignored)
────────────────────────────────────────────────────────────
  Type:     Hunter
  Purpose:  Jog for soundness, generic standby graphic

  Tags:     Not fully mapped (no production need identified)

  Watcher action: IGNORED

  Future consideration:
    Could trigger a JOG_IN_PROGRESS or STANDBY indicator.
    Low priority — operator typically handles this verbally.

  Confirmed: 2026-04-10 (S20)


────────────────────────────────────────────────────────────
  FRAME 16 — HUNTER DISPLAY SCORES (derby)
────────────────────────────────────────────────────────────
  Type:     Hunter (derby classes only)
  Purpose:  Operator pressed "Display Scores" for derby

  Tags:
    {1}   entry number
    {2}   horse name
    {3}   rider name
    {8}   RANK: [place] (strip "RANK:" prefix)
    {21}  [judge]:[score] + [bonus]
          e.g. "1:4.000 + 76"

  Watcher action:
    Same handler as frame 12:
    1. Forces fresh .cls file re-read from disk
    2. Posts /postClassData with fresh content
    3. Posts FINISH event to worker
    4. Logs frame with entry/horse/rider/rank

  Derby-specific:
    {21} contains hi-opt base + bonus format. Per-judge
    breakdown with bonus points. Logged but .cls is
    authoritative for actual derby scoring.

  Confirmed: 2026-03-29 (S16), refined S20


============================================================
  PORT 31000 — CLASS SELECTION / COMPLETE
============================================================

  Separate UDP port from the scoreboard. Fixed at 31000.

  Packet format:
    {RYESCR}{fr}[frame]{26}[classNum]s{27}[classNum]
    {28}[className]{ }

  Tags:
    {fr}  Ryegate internal frame number (IGNORE — not meaningful
          for class detection)
    {26}  classNum + "s" suffix (sponsor graphic filename — IGNORE)
    {27}  clean class number (USE THIS)
    {28}  class name (bonus info)

  Signals (determined by press count and timing):
    1× Ctrl+A                → CLASS_SELECTED event
    3× Ctrl+A within 2s      → CLASS_COMPLETE event
    On Course click (HUNTER) → fires simultaneously with {fr}=11
    On Course click (JUMPER) → DOES NOT RELIABLY FIRE on 31000

  Watcher behavior:
    - Tracks press count and timing window
    - CLASS_SELECTED on first press in window
    - CLASS_COMPLETE on 3rd press within 2-second window
    - 5-second cooldown after CLASS_COMPLETE prevents
      accidental re-open (4th press ignored)
    - Posts events to worker for KV/D1 state updates

  Mental model (Bill, Session 28):
    Treat port 31000 as THE OPERATOR FOCUS SIGNAL.
    It tells you what the operator is attending to in Ryegate.
    It does NOT tell you what's happening in the ring — that's
    what UDP in (Channel A) is for.

    The two channels are independent inputs. The engine reads
    31000 for focus/intent events and UDP in for ring
    telemetry. They compose at the engine's higher-level state
    machine. Do NOT conflate them at the port level. Do NOT
    use one stream to validate the other.

  HUNTER vs JUMPER On Course behavior on 31000:
    - HUNTER:  On Course click reliably produces a 31000 packet.
               31000 IS a reliable focus indicator for hunter
               classes (matches the operator's attention shift
               when they mark a horse on course).
    - JUMPER:  On Course click does NOT reliably fire on 31000.
               31000 is NOT a reliable focus indicator for
               jumpers. For jumper on-course detection, read
               UDP in's {fr}=1 frames — that's ring telemetry,
               separate channel, always reliable.

  Port 31000 history / ambiguity status:
    Port 31000 has been a mess of ambiguity in v2. We've used
    it for class opening (CLASS_SELECTED) and tried to use it
    for class closing (3× Ctrl+A). The signal set is partially
    overloaded with hunter On Course clicks, and Ryegate itself
    doesn't cleanly document the semantics. The v3 engine will
    likely need a full redesign of how it uses 31000 — approach
    it as "31000 tells us the operator's focus, nothing more"
    rather than as a backup scoring feed. FLAG as an area that
    needs exploration before v3 locks its 31000 handling.

  Confirmed: 2026-03-22, cooldown added S16. Focus-signal
  framing + hunter/jumper split + channel independence
  principle clarified Session 28.


============================================================
  BEHAVIORAL RULES (cross-frame)
============================================================

POST-FINISH LOCK (Session 26)
------------------------------
After firing a FINISH event, set finishLockUntil = now + 5000ms.
During the lock window:
  - ONCOURSE events SUPPRESSED (not re-fired)
  - TA-change events ALLOWED (phase 2 start signal)
  - After 5s, normal detection resumes

Purpose: Prevents false re-fire from Farmtek buzzer oscillation
(rapid on/off state flips after a round ends).

Farmtek two-phase pattern:
  1. Phase 1 clock runs with TA:91
  2. Phase 1 finish: decimal time (e.g. 78.456)
  3. ~5s silence (operator presses transition, "RANK:" shown)
  4. Phase 2 resumes at elapsed=5 (artifact), TA swaps (e.g. 59)

CLOCK STOP DETECTION
---------------------
  - Jumper {17} (elapsed): if value unchanged for 2.5s → clock
    stopped (horse may have refused, timer malfunction, etc.)
  - Jumper {23} (countdown): if value unchanged for 2.5s →
    countdown paused (operator held course walk, etc.)
  - These are detection signals only — no automatic action taken

HEARTBEAT CLOCK SNAPSHOT (v1.11+)
----------------------------------
Watcher heartbeat (1Hz when active, every 60s idle) carries:
  { phase, elapsed, countdown, entry, ta, jumpFaults, rank }

Browser trusts this snapshot absolutely. Local tick runs 1Hz
to fill sub-second gaps only — never extrapolates, never
interpolates across timestamps.

Key insight (Session 27): The "timestamp + browser-side
interpolation" design was built to solve jerky-UDP — a
non-problem. UDP is already a clean 1Hz stream.


============================================================
  FUNNEL ENHANCEMENTS (deploy/west-funnel-v1.0)
============================================================

The funnel sits between Ryegate and RSServer + watcher.
It modifies packets for RSServer display only; the watcher
always receives raw pass-through.

RUNNING TENTH:
  - Interpolates {17} elapsed at 10Hz between 1Hz frames
  - RSServer output shows smooth 0.1s increments
  - Watcher gets unmodified raw frames

HOLD TARGET:
  - Persists {18} target time across frames
  - Farmtek drops {18} during on-course phases
  - Funnel re-injects last-known {18} so scoreboard always
    shows the target
  - Watcher gets raw (may see {18} disappear)


============================================================
  WATCHER CODE LOCATIONS (west-watcher.js v1.11)
============================================================

  parseUdpPacket()        → line ~1714
  Port 31000 handler      → lines ~1730-1818
  Scoreboard handler      → lines ~2430-2650
    Frame 0 (clear)       → lines ~2547-2557
    Frame 1 (jumper)      → lines ~2559-2650
    Frame 11 (hunter)     → lines ~2442-2484
    Frame 12/16 (scores)  → lines ~2509-2545
    Frame 14 (ribbons)    → lines ~2483-2507


============================================================
  SESSION DISCOVERY LOG
============================================================

  S13 (2026-03-22)  Full column mapping, UDP collision detection
                    (later removed — false positives)
  S16 (2026-03-29)  Hunter UDP architecture decision: .cls is
                    authoritative, UDP only for on-course signal.
                    {17} bug identified (scoreboard msg, not elapsed).
                    {fr}=16 confirmed = derby FINISH.
  S17 (2026-04-07)  {17} numeric guard implemented
  S19 (2026-04-09)  Equitation UDP discovered: {7}=rider,
                    {6}=city/state, no {3} in equitation
  S20 (2026-04-10)  fr=12/14/16 confirmed and handled in pipeline.
                    fr=13 confirmed = standings (ignored).
                    fr=15 confirmed = jog/standby (ignored).
  S21 (2026-04-11)  Equitation full detail: Page C of frame 11,
                    {19}=equitation score on Display Scores
  S26 (2026-04-16)  Post-FINISH lock (5s suppress). Farmtek
                    two-phase pattern documented. Status codes
                    verified on live hardware: 2=RT, 3=OC, 4=WD,
                    5=RF
  S27 (2026-04-17)  Clock crisis resolved. UDP confirmed as
                    clean 1Hz stream (3MB log analysis). Heartbeat-
                    as-authority design shipped (v1.11).


============================================================
  OPEN QUESTIONS / FUTURE WORK
============================================================

  - Frames 2-10: truly unused or just never triggered at
    shows we've attended? Monitor logs at future events.
  - Frame 13 tags: map if needed for "standings displayed"
    indicator.
  - Frame 15 tags: map if needed for jog/standby indicator.
  - Frame 14 score field ({14}): always empty for forced?
    Verify at scored classes that use ribbon announcement.
  - {18} TTB on jumper frame 1: document when it appears
    and disappears (currently "unreliable").
  - Port 31000 frame number ({fr}): is it always the same
    value, or does it vary? Currently ignored.


============================================================
  VERSION HISTORY (this document)
============================================================

  v1.0  2026-04-18  Initial consolidation from CLS-FORMAT.md,
                    session notes 13-27, west-watcher.js v1.11,
                    west-funnel.js v1.3.1, CLASS-DETECTION-SCHEMAS.md
