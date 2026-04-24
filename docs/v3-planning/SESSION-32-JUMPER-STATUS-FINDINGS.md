# Session 32 — Jumper Per-Round Status: Findings + Parser Spec

**Date:** 2026-04-23
**Scope:** Jumpers only (Hunter deferred). Phase 2d preparation.
**Outcome:** Authoritative per-round status model settled. v2 parser bug root-caused. v3 parser spec written.

---

## 1. What triggered the investigation

During Phase 2d planning, Claude (me) misframed jumper status as "single value per entry."
Bill corrected: jumpers have per-round status — "check Culpeper." Raw-data dive followed.

---

## 2. The raw evidence

### Class 212 — `1.0m Jumper`, Farmtek (J), method 13 (II.2b Immediate JO), 24 entries

Source: v2 D1 `classes.cls_raw` for slug `hits-culpeper-april`, class_num `212`.
Fixture saved to `v3/tests/fixtures/cls/J/212_culpeper.cls`.

Sorted by placement, status labels at the positions Ryegate actually wrote them:

```
Pl    Entry  Horse                          R1 col          R2/JO col   col[21]  col[28]  col[37]
--    -----  -------------------------      ------------    ---------   -------  -------  -------
 1    6235   ROBERT'S FROST                 60.696          40.113       0        0        ""
 2    6269   TOUCH OF CERA DU MAILLET Z     70.038          42.684       0        0        ""
 3    6234   PERSPICACIOUS                  66.193          43.920       0        0        ""
 4    6320   ATATURK MM                     65.524          46.538       0        0        ""
 5    6176   TESTIMONY                      65.856          47.489       0        0        ""
 6    6382   CLEARWAY'S ASHFIRE             68.029          49.744       0        0        ""
 7    6126   MISTER GREY                    71.658          49.972       0        0        ""
T8    1993   EXCELLENT                      73.626           WD          0        4        ""
T8    6191   COOLEY LIMITED EDITION         72.583           WD          0        4        ""
T8    6267   NIKOLAAS RFB                   73.906           WD          0        4        ""
11    6164   FULL SEND                      4 / 58.818                   0        0        ""
 …    …      (other R1 fault placements)    …                            0        0        ""
 —    6318   SHUTTERFLY'S SHAMELESS         RT                           2        0        ""
 —    6147   ELLEN S - INB                  EL                           3        0        "EL"
 —    6192   KT ORIGI                       EL                           3        0        "EL"
 —    6211   ON THE HOOK                    (DNS)                        0        0        ""
```

### Class 264 — `$500 1.20m Jumper`, Farmtek (J), method 13, one notable entry

Entry 6056 FINAL FOCUS Z:
- R1 clean (77.75s, 0 faults)
- R2 OC (off course in JO)
- `col[21] = 0` (R1 clean)
- `col[28] = 3` (R2 numeric status)
- `col[37] = ""`, **`col[38] = "OC"`**, `col[39] = ""`

---

## 3. Farmtek (J) column layout — confirmed from Culpeper raw

```
col[00]  EntryNum
col[01]  HorseName
col[02]  RiderName
col[03]  (empty)
col[04]  CountryCode (FEI)
col[05]  OwnerName
col[06]  Sire
col[07]  Dam
col[08]  City
col[09]  State
col[10]  HorseFEI/USEF
col[11]  RiderFEI/USEF
col[12]  OwnerFEI/USEF

col[13]  RideOrder         ← confirmed from class 212 (values 0-21, unique)
                            NOTE: CLS-FORMAT.md line 489 incorrectly claims
                            this is at col[35]. col[35] is NOT RideOrder.

col[14]  OverallPlace      ← 1-20, empty when DNS

col[15]  R1 Time
col[16]  R1 Penalty Seconds (for time faults)
col[17]  R1 Total Time
col[18]  R1 Time Faults (fractional)
col[19]  R1 Jump Faults
col[20]  R1 Total Faults

col[21]  R1 NUMERIC STATUS  ← confirmed per-round status column for R1

col[22]  R2 Time
col[23]  R2 Penalty Seconds
col[24]  R2 Total Time
col[25]  R2 Time Faults
col[26]  R2 Jump Faults
col[27]  R2 Total Faults

col[28]  R2 NUMERIC STATUS  ← confirmed per-round status column for R2

col[29]  R3 Time
col[30]  R3 Penalty Seconds
col[31]  R3 Total Time
col[32]  R3 Time Faults
col[33]  R3 Jump Faults
col[34]  R3 Total Faults

col[35]  R3 NUMERIC STATUS  ← STRUCTURAL INFERENCE. Always 0 in observed data
                              because no 3-round jumper class has ever been
                              recorded. Unconfirmed.

col[36]  HasGone (0/1) — UNRELIABLE. Can stick at 1 from testing
                          (v2 watcher comment: "Ryegate may leave hasGone=1
                          stuck from testing"). Do NOT trust directly.
                          Derive from (time > 0 OR status != null) instead.

                          Cross-confirmed 2026-04-23 across BOTH hardware types:
                          - Farmtek (v2 Culpeper, 438 rows): 3 entries had
                            col[36]=1 with ZERO scoring evidence anywhere
                            (class 217 #6192, class 257 #6162, class 226 #1993).
                            Ryegate's own published results page does NOT
                            display these entries — confirming col[36] is
                            NOT a "show on results" flag, just an internal
                            HasGone flag that can go stale.
                          - TOD (local Classes/, 959 rows): same pattern, 4
                            entries (18.cls/192, 35.cls/152, 46.cls/167 and
                            /363) with col[36]=1, no evidence.
                          Takeaway: col[36] is genuinely unreliable on both
                          J and T. v3 ignores it.

col[37]  text status      ┐
col[38]  text status      │  Ryegate writes the text label in ONE of these
col[39]  text status      ┘  three positions. Position varies per entry.
                            Tail-scan cols 36-39 for any known text code.
                            Only written for incidents Ryegate has a
                            specific label for.
```

---

## 4. Per-round status — the two channels

Ryegate writes status in TWO complementary channels per round:

| Channel | Columns | Role | When written |
|---|---|---|---|
| **Numeric** | col[21] / col[28] / col[35] | Per-round incident flag | ALWAYS when an incident occurs — most reliable coverage |
| **Text** | col[37-39] (tail-scan) | Specific cause label | Only when Ryegate has a specific text label (e.g. EL, OC, HF). Not written for all numerics. |

The numeric channel is the **source of truth for per-round attribution**.
The text channel is the **richer vocabulary when present** — applies to ONE round (the round whose numeric flag fired).

---

## 5. Numeric value → display category (Farmtek, empirical)

From Culpeper observation:

| Numeric | Display category | Observed evidence | Specific text seen |
|---|---|---|---|
| `0` | none (normal ride) | every clean round | — |
| `2` | **RT** (Retired) | class 212 #6318 (col[21]=2, no text, v2 stored "RT") | none — numeric alone |
| `3` | **ELIM family** | class 212 #6147, #6192 (col[21]=3 + text "EL"); class 264 #6056 (col[28]=3 + text "OC") | "EL", "OC" |
| `4` | **WD** (Withdrew) | class 212 #1993, #6191, #6267 (col[28]=4); class 264 #1959, #6274 | none — numeric alone |

**Codes 1, 5, 6: never observed live.** Existing maps in `display-config.js:318` and `west-watcher.js:971/986` are guesses that disagree with each other. v3 treats any numeric outside {0,2,3,4} as unknown and logs `parse_warning`.

**Key rule per Bill:** we don't differentiate specific causes within the ELIM family for display. An RF, HF, OC, or generic EL all collapse to "EL" display category. If Ryegate wrote specific text (like "OC" in 6056), we render it. If they didn't, we render generic "EL" from the numeric map.

---

## 6. The v2 parser bug — confirmed

Raw .cls for class 212 entry 1993 EXCELLENT:
- col[21] = 0 (R1 clean, no status)
- col[28] = 4 (R2 WD flag)
- col[37-39] = empty

**v2 production `results` table stores r1_status="WD" AND r2_status="WD".** The R1 WD is an artifact — Ryegate never wrote any R1 status.

Same artifact repeats on:
- Class 212 entries 1993, 6191, 6267 (triple-WD after clean R1)
- Class 264 entry 6056 (R1 stored "OC", raw says R1 clean with col[28]=3 OC)

Root cause analysis: [west-watcher.js:1005](../../west-watcher.js#L1005) computes a single overall `entry.statusCode`. Downstream, either the watcher's POST payload or the worker's `/postClassData` handler replays that single value across multiple round rows. Per-round parsing is correct in isolation; duplication happens at storage.

**The public display shows correctly** because it works around the bad stored value (time-presence check) — but the underlying data is wrong. This breaks stats rollups that filter on `r1_status` directly.

---

## 7. Decision architecture — two separate decisions

Once status is parsed correctly per-round, the display layer makes TWO independent decisions:

### Decision 1 — "What goes in this round's cell?"
Per round, per entry. Status-aware only, method-unaware.
```
if round has ELIM or PARTIAL status → show status label, suppress time/faults
else if round has time data           → show time/faults
else                                   → blank
```

**Jumper-specific display rule (confirmed 2026-04-23 — Bill):**

> When a jumper round has an elimination/retirement/withdraw status
> (EL, RF, HF, OC, RO, DQ, RT, WD, HF, EX — i.e., any code with
> category ELIM or PARTIAL), the round's cell shows ONLY the status
> code. Time and faults are SUPPRESSED, even when present in the raw
> data.

Applied per round independently:

```
Entry 184 DON REGAL (class 23, method 13):
  Raw data: r1_time=31, r1_total_faults=0, r1_status='RF'
  Display R1 cell: "RF"             (time 31 and 0 faults suppressed)
  Display R2 cell: blank             (no R2 activity)

Entry 176 REMINISCENT (class 23, method 13):
  Raw data: r1_time=62.126, r1_faults=0, r1_status=null
            r2_time=29, r2_faults=4, r2_status='EL'
  Display R1 cell: "62.126"          (clean round, show the time)
  Display R2 cell: "EL"              (R2 EL — time 29 and 4 faults suppressed)
  Decision 2 on this entry: PLACED on R1 (method 13, no ladder)

Entry 129 FARFAN M (class 23, method 13):
  Raw data: r1_time=44, r1_total_faults=4, r1_status='RT'
  Display R1 cell: "RT"              (time and faults suppressed)
  Decision 2: not placed (R1's only scoreRound is killed)
```

**Why suppress rather than show alongside the status:** matches
Ryegate's own published results convention. Partial-ride times are
NOT meaningful for placement or comparison — the status is the
authoritative single display signal for that round.

**The parser still captures time/faults in the DB row** — suppression
is purely a display-layer decision. If a consumer later wants to show
partial-ride times (e.g., a "how long did they ride before stopping"
stat), the raw values remain queryable.

### Audience-aware label policy (confirmed 2026-04-23 — Bill)

> Public-facing pages COLLAPSE specific elim causes to the generic
> "EL" label, matching Ryegate's published PDF convention. Admin
> pages SHOW the richer code as captured (RF, HF, OC, RO, DQ).

Rationale: "rider fall" and "horse fall" on a public leaderboard
adds no useful information for spectators and invites unnecessary
commentary. Ryegate itself publishes "EL" for the whole elim family.
We follow that convention publicly, preserve richer codes internally.

Implementation contract (Phase 2e when public pages land):

Public renderer applies one collapse rule — any ELIM-category code
shows as "EL". No per-code `publicLabel` field, no elaborate
vocabulary. One line of display logic:

```js
function publicStatusLabel(code) {
  if (!code) return null;
  return WEST.status.TEXT_CODES[code].category === 'ELIM' ? 'EL' : code;
}
```

- Admin drill-down (Piece 4): uses the raw stored code (RF, HF, OC, etc.)
- Public results page (Phase 2e): collapses via `publicStatusLabel()` → "EL"
- Live standings (Phase 3): same as public — use `publicStatusLabel()`
- Stats rollups (Phase 3+): store the raw specific code; render-time collapse

DB captures the specific cause (RF, HF, OC, RO, DQ) so it isn't lost.
Display layer collapses at render for public audiences.

### Decision 2 — "Does this entry get a place number?"
Per entry, method-aware. Driven by the train/ladder rules.
```
effectivePlacement(method, rounds) → { placed: bool, basedOn: [round], reason: string }
```

The two decisions are independent and can disagree. Class 212 entry 1993:
- Decision 1 on R2 cell: status "WD" shown
- Decision 2 on entry: PLACED (T8) — method 13 has no ladder back from R2, so R1 survives

---

## 8. Train analogy — jumper method rules

> Each round is a train car. A rider loads their result onto each car they ride.
> Cars are linked by a "ladder" if the method declares rounds cumulative.
> - **No ladder**: each car stands alone. A crash in R2 doesn't derail R1.
> - **Ladder R1↔R2**: a crash in R2 pulls R1 off the rails too.

### Jumper method table (machine-readable)

```
METHOD       LABEL                      scoreRounds  tiebreak  wipesOnFail
 0           Table III                  [1]          null      {}
 2           II.2a R1+JO                [1]          2         {}
 3           2-round + JO               [1,2]        3         {2:[1]}      ← ladder R2→R1
 4           II.1 Speed                 [1]          null      {}
 6           IV.1 Optimum               [1]          null      {}           (modifier=1 → [1,2])
 7           Timed Equitation           [1]          null      {}
 9           II.2d two-phase            [1,2]        null      {2:[1]}      ← ladder (one ride)
11           II.2c qualifier advance    [1,2]        null      {}           (PH2 fail keeps PH1)
13           II.2b Immediate JO         [1]          2         {}
14           Team                       [1,2]        3         {2:[1]}      ← ladder
15           Winning Round              [2]          null      {}           (R2 IS the final)
```

### Algorithm — jumperPlacement(method, rounds)

```
1. killed = set of rounds with ELIM or PARTIAL status
2. For each round in killed:
     if wipesOnFail[round] exists → add those earlier rounds to killed (ladder effect)
3. If ANY round in scoreRounds is in killed → not placed (reason: score-round-failed)
4. If ANY round in scoreRounds has no time/faults data → not placed (reason: not-ridden)
5. Else → placed, basedOn=scoreRounds, tiebreak per rule
```

### Walk on class 212 (method 13)

```
Entry 1993 EXCELLENT (R1 clean 73.626, R2 status=WD)
  killed = {2}  (WD)
  wipesOnFail[2] = undefined → R1 stays alive
  scoreRounds [1] all alive → PLACED on R1 ✓

Entry 6318 SHUTTERFLY (R1 status=RT, no R2)
  killed = {1}  (RT)
  scoreRounds [1] killed → NOT PLACED ✓

Entry 6147 ELLEN (R1 status=EL, no R2)
  killed = {1}  (EL)
  scoreRounds [1] killed → NOT PLACED ✓

Entry 6235 ROBERT'S FROST (R1 clean, R2 clean)
  killed = {}
  scoreRounds [1] alive, has data → PLACED on R1
  tiebreak = R2 (40.113s) → 1st ✓
```

### Contrast — same entries under method 3 (hypothetical)

Method 3 has `wipesOnFail={2:[1]}`. A clean R1 + EL R2 would propagate:
- killed = {2, 1} (EL kills R2; ladder wipes R1)
- scoreRounds [1,2] both killed → NOT PLACED

Same data, different method → different placement. Train metaphor intact.

---

## 9. Architectural split

Two shared modules (v3, dual-env IIFE):

### `v3/js/west-status.js` — the dictionary
Pure semantic lookup. No decisions.
```
TEXT_CODES[code] = { label, full, category }
  category ∈ { 'ELIM', 'PARTIAL', 'HIDDEN' }

JUMPER_NUMERIC = { 0:null, 2:'RT', 3:'EL', 4:'WD' }
HUNTER_NUMERIC = { 0:null, 2:'EL', 3:'RT' }  (hunter fills in later)

getRoundStatus(lens, textCode, numericCode) → text code or null
categoryOf(code) → 'ELIM' | 'PARTIAL' | 'HIDDEN' | null
```

### `v3/js/west-rules.js` — the train yard
Per-method placement logic.
```
JUMPER_METHODS[method] = { scoreRounds, tiebreak, wipesOnFail }
jumperPlacement(method, rounds) → { placed, basedOn, reason }
hunterPlacement(numRounds, rounds) → { placed, basedOn, reason }  (deferred)

effectivePlacement(lens, class, rounds) → routes by lens
```

### Consumers
- `west-worker.js` — parser (Phase 2d): reads west-status for numeric→text map.
- `v3/pages/admin.html` — entry drill-down status badges.
- `v3/pages/results.html` (Phase 2e): decision 1 + decision 2 renderers.
- Future live/stats pages: same two decisions, same two modules.

**Adding a new numeric value observed live = one edit to `west-status.js` JUMPER_NUMERIC + one edit to this doc. All pages pick it up.**

---

## 10. THE CENTRAL PARSER FUNCTION — spec for Phase 2d

This is what the entire conversation's findings drive. To be written during Phase 2d Piece 2 (jumper scorer).

### Target storage

**Schema pivoted in Session 33 (2026-04-24) from wide to per-round.**
Session 32 originally landed `entry_jumper_scores` (one wide row per
entry with r1_*/r2_*/r3_* columns). On Session 33 review, Bill's
instinct that stats would want per-round prevailed — v2's D1 `results`
table, v2 `stats.html`, and `STATS-BRAINSTORM.md` all agreed per-round
is the natural analytics shape. Pivot executed. New shape:

- `entries` — identity only (unchanged from Phase 2c).
- `entry_jumper_summary` — one row per jumper entry. Entry-scoped
  fields: `ride_order`, `overall_place`, `score_parse_status`,
  `score_parse_notes`. Schema in `v3/migrations/009_entry_jumper_per_round.sql`.
- `entry_jumper_rounds` — one row per entry **per round that actually
  happened**. PK is `(entry_id, round)`. Fields: `time`, `penalty_sec`,
  `total_time`, `time_faults`, `jump_faults`, `total_faults`, `status`,
  `numeric_status`. Absence of a round row = round didn't happen.

The parser still emits a wide object per entry; the worker splits it
on write. The `/v3/listEntries` endpoint pivots back to wide shape via
three LEFT JOINs so admin code needs no changes.

### Function signature

```
// west-worker.js — jumper scoring parser (J / T lens)
//
// Reads per-entry scoring columns from a Farmtek or TOD .cls file and
// returns a per-round result array. Per-round status is attributed
// independently — no cross-round propagation, no overall-status collapse.
//
// classType: 'J' (Farmtek) or 'T' (TOD)
// Returns: array of per-entry scoring objects, one per parsed row.
// Caller splits each object into entry_jumper_summary (entry-scoped)
// and entry_jumper_rounds (per-round rows). Session 33 per-round pivot.

function parseEntriesScoreJ(text, classType) {
  // For each entry row in the CSV:
  //   parseIdentity(cols)                  // cols 0-12, already handled by parseClsEntriesV3
  //   parseRoundScoring(cols, round=1)     // cols 15-20 for R1, 22-27 for R2, 29-34 for R3
  //   parseRoundStatus(cols, round=1)      // col[21] numeric + text tail-scan
  //   parseRoundStatus(cols, round=2)      // col[28] numeric + text tail-scan
  //   parseRoundStatus(cols, round=3)      // col[35] numeric + text tail-scan (unconfirmed)
  //   parseRideMetadata(cols)              // ride_order (col[13]), overall_place (col[14])
  //
  // Returns per-row (wide shape; caller splits to summary + rounds):
  //   {
  //     entry_num,                         // used by caller to look up entry_id FK
  //     ride_order, overall_place,
  //     r1_time, r1_penalty_sec, r1_total_time, r1_time_faults, r1_jump_faults, r1_total_faults,
  //     r1_status (text), r1_numeric_status (int),
  //     r2_time, r2_penalty_sec, r2_total_time, r2_time_faults, r2_jump_faults, r2_total_faults,
  //     r2_status (text), r2_numeric_status (int),
  //     r3_time, r3_penalty_sec, r3_total_time, r3_time_faults, r3_jump_faults, r3_total_faults,
  //     r3_status (text), r3_numeric_status (int),
  //     score_parse_status, score_parse_notes
  //   }
  //
  // NOT RETURNED: has_gone. Col[36] is unreliable (sticks from testing).
  // Consumers derive "did they ride" from (r1_time>0 OR r1_status!=null OR
  // r2_* OR r3_*) at render time. No denormalized flag.
  //
  // Each round's status is INDEPENDENT. Never copy one round's status to another.
  // Never compute an "overall statusCode" that gets replayed at storage.
  // That's the v2 bug we are NOT repeating.
}
```

### parseRoundStatus — the core per-round function

This is the single function that fixes the v2 bug.

```
function parseRoundStatus(cols, round) {
  // round ∈ {1, 2, 3}
  // numericCol = {1: 21, 2: 28, 3: 35}[round]
  //
  // Step 1: read numeric
  const numericCode = parseInt(cols[numericCol], 10) || 0;
  //
  // Step 2: if numeric is 0, round has no status — return null
  if (numericCode === 0) return { text: null, numeric: 0 };
  //
  // Step 3: try to find a text code in the tail-scan area (cols 37-39)
  //         BUT: attribute it only if this round's numeric is the one that fired
  //         (else another round's text could be mis-attributed to this round)
  //
  // Step 4: if text present AND this round's numeric is the ONLY non-zero,
  //         the text belongs to this round. Return {text, numeric}.
  //
  // Step 5: if multiple rounds have non-zero numerics, text is ambiguous.
  //         Attribute text to the LATEST round with non-zero numeric
  //         (matches Ryegate's convention — later round incident "wins").
  //         Other rounds get their numeric mapped via WEST.status.JUMPER_NUMERIC.
  //
  // Step 6: no text found → derive text from numeric via JUMPER_NUMERIC map.
  //         If numeric is outside the map, set text=null and log parse_warning.
  //
  // Returns: { text: string | null, numeric: int }
}
```

### Key contracts

1. **Per-round independence.** A round's status is determined only by that round's numeric column + tail-text (when attributable). Never inherits from or copies to another round.
2. **Text wins over numeric when present and attributable.** Ryegate's specific label (OC, RF, HF, EL, etc.) is more informative than the numeric's generic category.
3. **Unknown numerics log parse_warning.** Values outside {0, 2, 3, 4} on Farmtek, or {0, 2, 3} on TOD (based on what we've seen), get raw-stored with a `score_parse_notes` entry. As new codes are observed, update `west-status.js` JUMPER_NUMERIC.
4. **No overall status.** The function does not compute or return a single collapsed status. Display layer derives what it needs at render time.

### Acceptance (parse-time, class 212 entry 1993 re-parsed through v3)

```
Expected result for entry 1993 EXCELLENT:
  r1_time = 73.626,    r1_jump_faults = 0,  r1_total_faults = 0
  r1_status = NULL,    r1_numeric_status = 0     ← CORRECT, raw had col[21]=0
  r2_time = 0,         r2_jump_faults = 0,  r2_total_faults = 0
  r2_status = 'WD',    r2_numeric_status = 4     ← CORRECT, derived from col[28]=4
  r3_* = NULL / 0

Compare to v2's incorrect storage:
  r1_status = 'WD'  ← wrong
  r2_status = 'WD'  ← right
```

### Acceptance (parse-time, class 264 entry 6056)

```
Expected result for entry 6056 FINAL FOCUS Z:
  r1_time = 77.75,     r1_total_faults = 0
  r1_status = NULL,    r1_numeric_status = 0
  r2_time = 0
  r2_status = 'OC',    r2_numeric_status = 3     ← text from col[38]="OC"
  r3_* = NULL / 0

Compare to v2's incorrect storage:
  r1_status = 'OC'  ← wrong
  r2_status = 'OC'  ← right (but storage mechanism propagated wrong)
```

---

## 10b. Method changes mid-class (operator reconfigures)

Ryegate allows an operator to change the scoring method after a class has
started (e.g., II.1 → II.2b). Our pipeline handles this naturally:

1. Operator changes method in Ryegate → Ryegate writes updated `.cls`
   with new `scoring_method` code AND recalculates `col[14]` places
   per the new method rules.
2. Engine fs.watch fires → 2-second debounce ([v3/engine/main.js:34](../../v3/engine/main.js#L34))
   absorbs any mid-write state. After 2s of quiet, engine POSTs.
3. Worker parses the new header → UPDATE `classes.scoring_method`.
   Parser re-reads all entries → UPDATE `entry_jumper_summary` +
   fresh-replace `entry_jumper_rounds` rows.
4. Display-side `effectivePlacement()` reads the CURRENT
   `class.scoring_method`, so ladder/tiebreak rules apply immediately
   from next render.

Key principle: **we never compute placement. Ryegate does. We read
`col[14]` and write whatever Ryegate wrote.** If the method changes,
Ryegate recalculates places and the new values flow through on the
next POST. No cached-placement staleness to invalidate at this layer.

The 2s debounce is the engine's safeguard against reading mid-write
files. Don't read this as a specific "wait for re-calc" timer — it's a
general file-stability safeguard that also happens to cover this case.

### Related concern — stats rollups (Phase 3 dependency)

Cached stats rollups (leaderboards, season totals) DO have a
staleness problem when method changes: a pre-computed "top 10 in class
270" could be based on method-9 rules that no longer apply.

**Fix belongs in Phase 3 — stats infrastructure work:**
- `stats_rebuild_log` table (already scoped in `DATABASE-SCHEMA-EXPANSION.md` Part F)
- Trigger: any `classes.updated_at` change enqueues that class's
  rollups for rebuild
- Rebuilds incrementally on a schedule (nightly full + 15-min
  active-class incremental)

**NOT a Phase 2d concern.** Raw scoring data flows through correctly.
The rollup-caching issue shows up later when Phase 3 builds the
aggregation layer. Note captured here so it isn't forgotten.

---

## 11. Remaining open items

- [ ] **Numeric `1`, `5`, `6` specific meaning** — never observed live. Existing maps guess. Log parse_warning on first sight; expand map from evidence.
- [ ] **`col[35]` R3 numeric status** — structural inference, unverified. No 3-round jumper class has been scored into v2. Parser reads it anyway, flags unknowns.
- [ ] **`col[84]` R3 text status (TOD)** — parallel to above for TOD hardware.
- [ ] **CLS-FORMAT.md line 489** fix: Farmtek col[35] is NOT RideOrder. RideOrder is col[13] (same position as TOD).
- [ ] **CLS-FORMAT.md master table** update: jumper numeric `3` is ELIM family, not specifically "OC" as display-config.js:318 claims.
- [ ] **west-watcher.js:971 vs :986** — two conflicting NUM_STATUS maps in the same function. Not our problem in v3, but worth a v2 patch if we touch that code.

---

## 12. Next steps in code (Phase 2d sequencing)

**Piece 1** — schema: `entry_jumper_scores` wide linked table ✓ (Session 32, migration 008). **Superseded by Session 33 pivot** to per-round — see migration 009 `entry_jumper_summary` + `entry_jumper_rounds`.
**Piece 1b** — lens module ✓ (`v3/js/west-cls-jumper.js` — centralizes column positions so Ryegate layout drift is a one-file fix)
**Piece 2 (this function)** — `parseEntriesScoreJ` + `parseRoundStatus` per the spec above. Writes to `entry_jumper_summary` + `entry_jumper_rounds` (post-Session-33).
**Piece 3** — wire into `/v3/postCls`, expose via `/v3/listEntries` (pivots per-round back to wide via 3 LEFT JOINs — admin code unchanged)
**Piece 4** — admin drill-down columns

Fixture in hand: `v3/tests/fixtures/cls/J/212_culpeper.cls` (24 entries, 11 showing per-round status patterns). Acceptance test walks through 1993, 6318, 6147, 6235, 6056 and verifies the expected result shape.

---

## Related docs + cross-refs

- [CLS-FORMAT.md — master per-round status table](./CLS-FORMAT.md#L27) — authoritative column reference
- [UNCERTAIN-PROTOCOLS-CHECKLIST.txt:446-498](./UNCERTAIN-PROTOCOLS-CHECKLIST.txt#L446) — R3 column unconfirmed items
- [JUMPER-METHODS-REFERENCE.md](./JUMPER-METHODS-REFERENCE.md) — per-method ladder rules
- [west-watcher.js:963-1020](../../west-watcher.js#L963) — v2 parser logic (bug source)
- Memory: `feedback_class_type_commandment.md` (Article 1), `reference_per_round_status_master.md`
