# Hunter Methods — Authoritative Reference

## Purpose

Per-class-kind reference for HUNTER classes. The v3 `.cls` parser + class descriptor codes against this doc. Companion to `JUMPER-METHODS-REFERENCE.md`.

Hunters are FUNDAMENTALLY different from jumpers:
- **Jumpers** are TIMED. Winner is the fastest (or optimum-closest) clear round, ranked by faults + time.
- **Hunters** are JUDGED. Winner is the highest-scored round by humans watching style, form, and pace.

Because of that, hunter classes don't have a single `scoring_method` code (0-15) that tells you everything. They have a **compositional header** with many flags that combine to produce very different behaviors. This doc catalogs every composition we've seen or designed for.

**When encountering a new hunter class in the wild:** capture the behavior here first, code second. Same discipline as the jumper ref.

---

## The Hunter axis system

Hunter classes have TWO primary axes and ~12 compositional flags. Getting the right layout means reading both axes + the relevant flags.

### Axis 1 — classMode (cols[2], the field we call "scoring_method" in D1)

Confusingly, the D1 column `scoring_method` for hunter classes actually stores classMode. Both axes live in the same header slot, but the interpretation diverges by `class_type`:

| classMode value | Name | Meaning |
|---|---|---|
| `0` | Over Fences | Standard jumping hunter (horse jumps courses) |
| `1` | Flat | Hunter Under Saddle / flat class (no jumping, judged on gaits) |
| `2` | Derby | Hunter Derby (high-option fences + handy bonus) |
| `3` | Special | Championships, team classes, unusual formats (catchall) |

### Axis 2 — scoringType (cols[5])

| scoringType value | Name | Meaning |
|---|---|---|
| `0` | Forced | Operator enters placings manually. No public scores shown. |
| `1` | Scored | Judges enter numeric scores. Displayed publicly. |
| `2` | Hi-Lo | Drop highest + lowest judge scores, average the rest. Requires ≥3 judges. |

### Compositional flags (the "overlays")

These combine WITH the two axes to change display behavior further. Each is independent — a class can have multiple flags.

| Flag | Column | Meaning / effect |
|---|---|---|
| `isEquitation` | H[10] | Rider is primary identity. Horse secondary. "Pinned" when placings are final. |
| `isChampionship` | H[11] | End-of-week rollup. Points from earlier classes determine winners. |
| `isJogged` | H[12] | Horses jog after class for soundness check before placings are final. |
| `onCourseSB` | H[13] | Scoreboard shows who's in the ring (rarely used). |
| `ignoreSireDam` | H[14] | Don't display sire/dam info (privacy or style choice). |
| `printJudgeScores` | H[15] | Include per-judge scores on printed reports. |
| `reverseRank` | H[16] | Lower score wins (unusual — some special formats). |
| `californiaSplit` | H[17] | Class divided into sections (mostly west-coast thing). |
| `runOff` | H[30] | Tied top placings can go to a timed run-off. |
| `avgRounds` | H[31] | Average rounds instead of summing (alternate to scoreMethod field). |
| `noCutOff` | H[32] | Ignore cutoff scores (keep low scorers in placings). |
| `isTeam` | H[34] | Team class (Special Team format — multiple riders per team). |
| `showAllRounds` | H[35] | Display all rounds even if only some competed. |
| `displayNATTeam` | H[36] | National team display mode (FEI-ish). |
| `derbyType` | H[37] | 0-8 sub-variants of Derby (1-3 common, 4-8 unverified). |
| `ihsa` | H[38] | Intercollegiate Horse Show Association rules. |
| `ribbonsOnly` | H[39] | Only ribbons shown, not numeric scores (used for grading judges). |

### Axis 3 (secondary) — scoreMethod (cols[6])

How multi-round totals combine:
- `0` = Total (sum all rounds)
- `1` = Average (divide by rounds)

### Axis 4 (secondary) — numJudges (cols[7])

- `1` — single judge (most classes)
- `2` — two judges, combined total
- `3`+ — multi-judge panels (up to 7 observed)
- With `scoringType=2` (Hi-Lo), requires ≥3 to make sense

---

## The stack model applied to hunters

Using the train/container analogy from the jumper ref:

- **1 round class** = 1 container (most common)
- **2 round class** = 1 or 2 containers stacked, depending on rules
- **3 round class** = up to 3 containers stacked (rare, championship formats)

**Key difference from jumpers:** hunter rounds are usually INDEPENDENTLY SCORED events, not cumulative progression. A rider who rides R1 and gets 72, then rides R2 and gets 85 — their R1 result is preserved (container 1 locked). R2 adds a second container. The final combined score depends on `scoreMethod` (sum or average).

This means hunters rarely have LADDERS in the jumper sense. Each round is its own container; stacking is additive, not qualifying.

**Exception:** Championships (`isChampionship=True`) — final placings depend on cumulative points from qualifying classes. The "ladder" isn't between rounds of a single class; it's between the championship and the qualifying classes. That's a whole separate structural pattern.

---

## Status-carry for hunters

Hunter status-carry is simpler than jumpers:

**Default: SINGLE-ROUND rule per round.**
- If R1 status is EL/WD/DNS, R1 hides everything for that round
- If R2 status is EL/WD/DNS, R2 hides only that round — R1 result stands
- Each round is independently rated

**Exception for some Championship formats:**
- If a Championship CARRY-BACK rule applies (entries must complete both rounds to qualify), an R2 elimination voids the whole championship entry
- This is classMode=3 Special + isChampionship=True + specific sub-rules

**Exception for Hi-Lo:**
- With `scoringType=2`, EL in any single judge's score gets dropped along with the high/low. Rider stays in placings.
- Different from jumper status-carry entirely.

---

## WRITE TIMING — Hunter vs Jumper

Critical distinction:

**Jumper `.cls` write timing:**
- Writes after each round is scored
- Does NOT write while horse is on course (on-course state = UDP {fr}=1 frame)

**Hunter `.cls` write timing (CONFIRMED 2026-03-29):**
- File does NOT write when horse goes on course (On Course click in Ryegate)
- File DOES write immediately when score is posted (result entered)
- This means:
  - `{fr}=11` UDP INTRO = hunter "on course" signal
  - `.cls` change = hunter "score posted" signal
- `.cls` is authoritative for hunter scoring — no need to parse FINISH UDP

**v3 implication:** hunter watcher logic is FUNDAMENTALLY different from jumper. Hunter uses UDP for live entry-in-ring signals, `.cls` for final scoring. v3 parser must handle both signal paths correctly.

---

## MODE 0 — OVER FENCES (the common hunter)

Standard hunting class: horse jumps a course, judge scores form/pace/obstacles.

### Header
- classMode = 0
- scoringType: 0 (Forced), 1 (Scored), or 2 (Hi-Lo)
- numRounds: usually 1 or 2
- Compositional flags: isEquitation common, isJogged common for A/AA shows

### Scoring
- Judge gives a numeric score per round (typically 60-100 scale, sometimes 0-100)
- Multi-round: summed via scoreMethod=0 (Total) or averaged via scoreMethod=1 (Average)
- Multi-judge: each judge scores independently; combined at cols[42/43/44]

### Status-carry
- SINGLE-ROUND per round

### Stack model
- 1 container per round. Up to `numRounds` containers.

### Column layout (non-derby)
- Per-judge scores sequential from col[15] for R1, col[24] for R2, col[33] for R3
- Clean +9 stride per round
- Confirmed 2026-04-08: 7 judges at cols 15-21 (R1) and 24-30 (R2)
- Confirmed 2026-04-10: R3 at cols 33-39 from class 925 Special test

### Live examples
- Test show (hits-culpeper): class 800 "New Hunter Scored" (classMode=0, scoringType=1)
- Test show: class 901 "3'3\" Green Hunter" (classMode=0, typical hunter)
- Test show: class 1002 "Test Hunter Mult Judge class" (classMode=0 multi-judge)

### Verified
- Single-judge over-fences classes: extensive field testing
- Multi-judge (up to 7) at field tests + spec-confirmed
- Hunter equitation overlay: tested

---

## MODE 0 + isEquitation=True — HUNTER EQUITATION

Same course and scoring structure as Over Fences, BUT:
- Rider is primary identity (displayed large)
- Horse is secondary (smaller, below)
- "Pinned" when operator forces final placings (sub-variant via scoringType)

### Sub-variants

**Forced equitation** (scoringType=0):
- Operator enters placings manually
- No numeric scores shown publicly
- Ribbon display only
- Example: class 902 "Forced Eq Class" (test show)

**Scored equitation** (scoringType=1):
- Judges enter numeric scores
- Scores shown publicly
- Sub-variant of standard hunter scoring

### Display rules
- Primary identity flips from horse → rider
- On-course card: rider name big, horse name small
- Standings table: rider primary column, horse secondary (or omitted)
- Ribbons shown for placings

### Contrast with Jumper Method 7 (Timed Equitation)
- Method 7 Jumper Eq = uses jumper UDP protocol (timed, has a clock)
- Hunter Eq = uses hunter UDP protocol (no clock, judged)
- Same identity treatment (rider primary), different timing / scoring mechanics

### Stack model
- 1 container per round, same as Over Fences

---

## MODE 1 — FLAT (Hunter Under Saddle)

Rare in Ryegate data — most flat classes are judged in-ring without scoring software, but some shows do run them through Ryegate.

### Header
- classMode = 1
- scoringType: usually 0 (Forced — operator pins placings)
- numRounds: 1 (there's no "rounds" in flat — just the one period of judging)

### Scoring
- No course jumped
- Judge watches the riders at walk/trot/canter, then pins placings
- Usually scoringType=0 (Forced) — operator enters final placings directly
- No numeric scores shown

### Display rules
- No time, no faults, no jumping-related fields
- Placings only (1st, 2nd, 3rd, etc.)
- Rider identity usually primary (flat is often equitation-style)

### Stack model
- 1 container only. No rounds to stack.

### Live examples
- None in our current D1 (flat classes mostly bypass digital scoring in our sample)
- Spec only — behavior is inferred from field practice

### Gaps
- We don't have confirmed UDP behavior for flat classes. Assumption: behaves like a scoring-type-0 over-fences — no ON_COURSE signal, just placing posts.

---

## MODE 2 — HUNTER DERBY

A completely different beast. Multiple rounds with special scoring rules including "high options" (challenging jumps you CAN take for bonus points) and "handy bonuses" (style points for handy rounds).

### Header
- classMode = 2
- derbyType = 1-8 (sub-variant — 1-3 common in our data, 4-8 unverified)
- numRounds: often 2 (Classic + Handy rounds)
- scoringType: 1 (Scored) typical
- Multi-judge: common (derby panels often 2-3 judges)

### Scoring
- Each judge gives a BASE score per round
- Plus HIGH OPTION bonus (if rider took the high option jumps)
- Plus HANDY BONUS (round 2 only — style points for handy course riding)
- Combined = base + high option + handy, per round per judge
- Multi-round total: base R1 + base R2 + all bonuses

### Column layout (Derby — DIFFERENT from non-derby)

**Derby uses a special column stride:**

- **R1 block:**
  - col[15] = hiopt (high option flag)
  - col[16] = J1 base score
  - col[17] = hiopt mirror
  - col[18] = J2 base score
- **R2 block:**
  - col[24] = hiopt
  - col[25] = J1 base score
  - col[26] = J1 bonus
  - col[27] = hiopt mirror
  - col[28] = J2 base score
  - col[29] = J2 bonus

**WHY different:** derbies need slots for base + hiopt + bonus per round per judge. The standard hunter layout (sequential judge scores +9 stride) doesn't accommodate that.

**v3 parser rule:** when classMode=2, switch to derby column layout. Don't reuse the non-derby parser.

### Status-carry
- SINGLE-ROUND per round (usually)
- Exception: derby championship formats may carry back — noted per class

### Stack model
- 1 container per round. Typical derby = 2 containers (Classic + Handy).

### Display rules
- Show base score per judge
- Show handy bonus per judge (R2 only)
- Show combined per round
- Show overall combined

### Derby types (partial knowledge)

| derbyType | Known meaning | Verified? |
|---|---|---|
| 0 | Not a derby (shouldn't have classMode=2) | — |
| 1 | Type 1 derby | Partially verified in field |
| 2 | Type 2 derby (most common?) | Seen in field testing |
| 3 | Type 3 derby | Seen in field testing |
| 4-8 | Unknown variants | NOT YET VERIFIED |

### Live examples
- Test show: class 1001 "Another New Derby" (classMode=2, derbyType TBD)

### Gaps / unknowns
- Full derbyType 4-8 behavior not observed
- Handy bonus range not fully tested (max bonus? min bonus?)
- Derby championship roll-up rules partially unverified

---

## MODE 3 — SPECIAL (Championships, Team, Unusual Formats)

Catchall for classes that don't fit the other modes. This is where championships, team classes, and exotic formats live.

### Header
- classMode = 3
- isTeam (H[34]): True means team class
- isChampionship (H[11]): True means championship class
- phaseWeights (H[22-24]): may be non-100 for weighted rounds
- phaseLabels (H[25-27]): custom round labels (e.g. "Over Fences" / "Flat")

### Sub-variants (composed via flags)

**Special Team** (classMode=3 + isTeam=True):
- Multiple riders per team, combined scoring
- Scoring aggregation at team level
- numRounds often 2 (Over Fences + Flat, for example)
- Rare in our data

**Hunter Championship** (classMode=3 + isChampionship=True):
- Points from earlier qualifying classes determine entries
- Usually 2 rounds: Over Fences + Flat or OF + Handy
- Phase weights may be weighted (e.g. 60% OF + 40% Flat)
- phaseLabels customize the round names

**IHSA format** (classMode=3 + ihsa=True):
- Intercollegiate rules
- Catch-ride format (riders draw horses)
- Scoring conventions differ
- NOT VERIFIED in field testing

### Column layout
- Uses non-derby stride (same as Over Fences): col[15] R1 base, col[24] R2 base, col[33] R3 base, +9 per judge
- Phase weights applied to combined score calculation

### Stack model
- 1 container per round. For championships: additional "championship context" layer not represented in the stack.

### Live examples
- Test show: class 925 "New Special Class" — classMode=3, 3-round test

### Verified
- Class 925 live test confirmed 3-round column layout (R1 at col 15-21, R2 at 24-30, R3 at 33-39)
- Phase labels parsed correctly

### Gaps
- Team class scoring aggregation not fully tested
- IHSA rules unverified
- Championship point roll-up not implemented in v2

---

## MULTI-ROUND HANDLING

### numRounds field (H[03])

- 1 = single round (majority)
- 2 = two rounds (derbies, championships, stakes)
- 3 = three rounds (rare — championship formats, some specials)

### scoreMethod field (H[06])

Determines how multi-round totals combine:
- `0` = Total (sum): `combined = R1 + R2 + R3`
- `1` = Average (divide): `combined = (R1 + R2 + R3) / numRounds`

### Phase weights (H[22-24])

Per-round weight percentages (0-100). Default 100 = full weight.
- Example: 60/40 stakes class has weights [60, 40, 100] (last ignored if numRounds=2)
- Final score with weights: `sum(Ri * wi/100) / sum(wi/100)`

**v3 rule:** parser must apply phase weights to `derived.combined` when weights ≠ [100, 100, 100].

### Phase labels (H[25-27])

Custom round names:
- Default empty = "Round 1", "Round 2", "Round 3"
- Override examples: "Over Fences", "Flat", "Handy"
- Display uses these labels in standings

---

## TIE-BREAK RULES

Hunter classes can tie on score. Tie-break fields:

### Per-round tie-break (cols[18/19/20])

| Value | Meaning |
|---|---|
| 0 | Leave tied |
| 1-N | Break tie by Judge N's score |

### Overall tie-break (cols[21])

| Value | Meaning |
|---|---|
| 0 | Leave overall tied |
| 20 | Break by overall combined score |
| Other values | Per-class variants (not fully enumerated) |

### v3 rule
Descriptor must include tie-break rules. Rendering must respect them — can't naively sort by score alone.

---

## JUDGE SYSTEMS

### Single judge (numJudges=1)
- Simplest case
- Score displayed as single number
- Common for local shows

### Two judges (numJudges=2)
- Combined total displayed
- Optional per-judge breakdown
- Common at A shows

### 3-7+ judges (numJudges=3 to 7+, confirmed 2026-04-08)
- Combined total primary display
- Per-judge scores available on expand
- 7 judges = huge championship classes

### Hi-Lo system (scoringType=2)
- Requires numJudges ≥ 3
- Algorithm: drop highest score, drop lowest score, average the rest
- Displayed with "HiLo" badge so spectators understand

### Display rules
- Judges grid shown in compact form (display.html sidebar) or expandable (results.html)
- Per-judge, per-round breakdown on expand
- Multi-judge derby: special grid with base + bonus per judge

---

## UDP HANDLING FOR HUNTERS

### Hunter INTRO frame
- `{fr}=11` (not `{fr}=1` like jumpers)
- Indicates horse entered the ring
- This is the "on course" signal for hunters

### Hunter FINISH frame
- **Does NOT exist as a UDP event.** Hunter finish is signaled via `.cls` write, not UDP.
- Session notes (2026-03-29) confirmed this.

### Hunter equitation UDP
- Session 21 documented specific UDP tag mapping:
  - `{2}` = rider (swapped to primary position)
  - `{3}` = empty
  - `{6}` = city/state
  - Horse name NOT in UDP (must be pulled from .cls)
- FINISH frame holds indefinitely (no 10s expiry like jumpers)

### RANK signal
- Hunter classes may not emit `{8}` RANK on "Display Scores" — uses decimal FINISH metric as placement indicator
- Some hunter classes use different score-post mechanics; needs per-class testing

---

## STATUS CODES FOR HUNTERS

Same status code table as jumpers:
- `EL`, `RF`, `HF`, `WD`, `RT`, `DNS`, `DQ`, `RO`, `EX`, `HC`, `OC`

### Hunter status columns

- Text status per round: cols[52/53/54] for R1/R2/R3
- Numeric status fallback: cols[46/47/48] for R1/R2/R3
- Same numeric map: 1=EL, 2=RT, 3=OC, 4=WD, 5=RF, 6=DNS (SESSION-25 confirmed)

### Status attribution
- Per-round independent (unlike jumpers where R2 can wipe R1)
- EL in R1 doesn't prevent R2 from being scored (unless the operator pins them together)

### Special hunter status codes
- **DQ (Disqualified)** — used after the fact (e.g., failed drug test post-class)
- **EX (Excused)** — judge excused the rider mid-round (e.g., lameness)
- **HC (Hors Concours)** — exhibition only, not placed

---

## HAS-GONE LOGIC FOR HUNTERS

Hunters require evidence-based has-gone detection (can't trust flag columns):

### Evidence hierarchy
1. **Has score** = competed
2. **Has place** = competed (critical for Forced classes — place IS the evidence, no score available)
3. **Has status code other than DNS** = competed (EL/WD/RT count as "went and failed")
4. **DNS** = did not start, NOT competed

### Why not trust cols[49/50/51]?
The `hasGoneR1/R2/R3` boolean flags can get stuck at 1 from Ryegate testing mode. Evidence-based logic (score/place/status) is more reliable than raw flags.

**v2 rule (carries to v3):**
```js
const hSc = (entry.statusCode || '').toUpperCase();
const hasScore = !!(entry.score || entry.r1Total);
const hasPlace = !!(entry.place);
const hasHunterStatus = !!(hSc && hSc !== 'DNS');
entry.hasGone = hasScore || hasPlace || hasHunterStatus;
```

---

## MEMORY: UDP FRAME STRUCTURE FOR HUNTERS

UDP frames from Ryegate for hunter classes have different structure than jumpers. Known tags:

| Tag | Hunter meaning | Notes |
|---|---|---|
| `{fr}` | Frame type | 11 = INTRO, other values seen but not catalogued |
| `{1}` | Entry number | Same as jumper |
| `{2}` | Horse name OR rider name (swapped for equitation) | Primary identity |
| `{3}` | Secondary identity | Empty for equitation |
| `{5}` | Empty or stable info | Not critical |
| `{6}` | City/state | Equitation-specific |
| `{8}` | RANK (when posted) | Final rank for the class |
| `{11}` | Judge scores (somewhere in here) | Not fully catalogued |

### Gaps
- Full UDP tag catalog for hunters not documented
- Derby UDP frames (if any) unknown
- Multi-judge score UDP frames unknown

---

## CROSS-REFERENCE: Live hunter classes in D1

From production data at the time of this writing:

### Test show (hits-culpeper, TOD hardware)
- Method 0 (Over Fences) — classes 800, 806, 901, 902 (Forced Eq), 1002 (Multi-Judge)
- Method 0 championships — 20C, 23C, 26C, 29C, 35C, 38C, 41C, 48C (jumper-division championships but scored hunter-style)
- Method 2 (Derby) — class 1001 "Another New Derby"
- Method 3 (Special) — class 925 "New Special Class"

### Culpeper April (hits-culpeper-april)
- Hunter classes present but not in the subset Bill worked through this session. Per DB query, the Culpeper April show was predominantly jumpers in the ring 1 data we saw.

### Devon Fall Classic (historical — referenced in CLS-FORMAT.md)
- Hunter class verification at various points
- Class 221 was a jumper (Method 3), but Devon had multiple hunter classes too

---

## KNOWN GAPS (NOT FULLY VERIFIED IN v2)

Bill said: "we may not have flushed out every bug." These are the gaps:

1. **Derby types 4-8** — only seen types 1-3 in live data. Types 4-8 exist in spec but behavior unverified.

2. **IHSA rules** (ihsa flag) — classMode=3 + ihsa=True exists but no field testing. Collegiate rules may require different parsing.

3. **Hunter UDP tag catalog incomplete** — we know `{fr}=11` for INTRO and some tag behavior for equitation, but full tag coverage for derby, multi-round, and championship formats is gapped.

4. **Run-off (runOff flag)** behavior — flag exists but not fully exercised. When does it fire? How is the run-off scored? Not implemented in v2 display.

5. **Special Team classes** (classMode=3 + isTeam=True) — flag exists, team aggregation rules not tested. Multi-rider team scoring conventions unknown in our code.

6. **California Split** (californiaSplit) — rare, unverified behavior.

7. **Ribbons-only mode** (ribbonsOnly) — display behavior unverified (assume: hide scores, show ribbons only).

8. **Phase weights edge cases** — what if weights sum to > or < 100? Behavior not specified in our parser.

9. **Championship point rollup** — how does isChampionship=True actually aggregate points from qualifying classes? v2 doesn't implement this aggregation.

10. **Jogged classes** (isJogged) — operational flag only; what's the display implication if a horse jogs out lame?

11. **Status code `DQ`, `RO`, `EX`, `HC`** — defined but not seen live. Behavior inferred from spec.

12. **reverseRank flag** — exists, presumably means lower score wins, never seen live.

13. **Multi-judge TIEBREAK by judge N** — tie-break rule cols[18/19/20] values 1-N not fully tested.

14. **Average scoreMethod (H[06]=1)** — not sure how many shows actually use this vs Total. Parser logic written but untested.

15. **onCourseSB flag** — what does it actually change in display? Unknown.

16. **displayNATTeam flag** — national team display mode, unknown semantics.

17. **ignoreSireDam flag** — display behavior is clear (hide breeding), but is this flag actually set at FEI shows?

18. **noCutOff flag** — keeps low scorers in placings. When is it set? What's the default cutoff?

19. **avgRounds vs scoreMethod=1** — two different ways to indicate averaging. Which takes precedence?

20. **Hunter division championship classes** (like 20C, 23C in D1) — these are CLASSTYPE H but named after jumper divisions. How do they aggregate? Points from jumper classes scored hunter-style? Needs investigation.

---

## v3 Parser Responsibilities

Given all the above, the v3 `.cls` parser for hunters MUST:

1. **Detect hunter via classType='H' OR header-shape inference.** Col[2] 0-3 = hunter mode. Col[2] 0-15 = jumper method. Both ranges can overlap (0, 1, 2, 3 are valid in both!), so use the classType header column as the disambiguator.

2. **Parse all compositional flags.** isEquitation, isChampionship, isTeam, isJogged, ihsa, etc. — every flag gets a boolean in the descriptor.

3. **Branch column-layout handling:**
   - classMode=0,1,3 → non-derby layout (sequential judge scores, +9 stride)
   - classMode=2 → derby layout (base + hiopt + bonus columns)

4. **Normalize multi-judge scoring.** Descriptor should include per-judge score array structure, not just combined totals.

5. **Honor phase weights.** If weights ≠ default, apply to combined calculation.

6. **Handle status codes with hunter-specific semantics.** DQ, RO, EX, HC map as expected. Numeric status fallback same as jumpers.

7. **Emit parse warnings for gaps.** Every unknown flag combination, every unverified derbyType, every unseen IHSA class → log as parse_warning with raw context. Bill reviews post-show, codifies into parser on next calm session.

8. **Respect write-timing distinction.** Hunter `.cls` changes = score posted, not on-course. Classify events accordingly.

---

## Hunter class-kind descriptor shape (v3)

```
{
  class_kind: 'hunter' | 'hunter-equitation',
  timing_hardware: 'farmtek' | 'tod' | 'unknown',
  class_mode: 0 | 1 | 2 | 3,
  class_mode_label: 'Over Fences' | 'Flat' | 'Derby' | 'Special',
  scoring_type: 0 | 1 | 2,
  scoring_type_label: 'Forced' | 'Scored' | 'Hi-Lo',
  is_equitation: boolean,
  is_championship: boolean,
  is_team: boolean,
  is_jogged: boolean,
  is_derby: boolean,
  is_flat: boolean,
  is_special: boolean,
  derby_type: 0-8,
  num_rounds: 1-3,
  num_judges: 1-7+,
  score_method: 'total' | 'average',
  phase_weights: [number, number, number],
  phase_labels: [string, string, string],
  has_run_off: boolean,
  has_california_split: boolean,
  ihsa: boolean,
  ribbons_only: boolean,
  primary_identity: 'horse' | 'rider',   // 'rider' if is_equitation
  status_columns: { r1_text: 52, r2_text: 53, r3_text: 54, r1_num: 46, r2_num: 47, r3_num: 48 },
  score_columns: {
    layout: 'non-derby' | 'derby',
    r1_stride: [col_base: 15, gap: 9],   // per-judge
    // derby variant specifies hiopt/bonus offsets
  },
  tie_break: { r1: 0-N, r2: 0-N, r3: 0-N, overall: 0-N }
}
```

v3 parser emits this descriptor from the `.cls` header. Every page reads the descriptor; no page re-derives hunter behavior from raw columns.

---

## Related docs

- `CLS-FORMAT.md` at repo root — column-level spec (source of truth for field positions)
- `JUMPER-METHODS-REFERENCE.md` — companion reference, same structure
- `CLASS-RULES-CATALOG.txt` — behavioral rules by U/H/T/J classType (part 2 covers hunters)
- `CLASS-DETECTION-SCHEMAS.md` — hunter detection rules (.cls write-timing differs from jumper)
- Session notes:
  - SESSION-21 — hunter equitation UDP specifics
  - SESSION-20 — hunter multi-round work
  - 2026-03-29 (in CLS-FORMAT.md) — hunter write timing confirmed
  - 2026-04-08 — 7 judges confirmed at cols 15-21 (R1) and 24-30 (R2)
  - 2026-04-10 — R3 layout from class 925 Special test
  - 2026-04-06 — hunter header fields confirmed by cycling Ryegate settings

---

## When this doc evolves

Same edit rules as JUMPER-METHODS-REFERENCE.md:

- Every claim has a SOURCE (code line, session number, live class observation, spec reference)
- When a "NOT YET VERIFIED" gap gets filled by a live observation, update the mode entry AND remove from gaps list
- When Ryegate/Farmtek/TOD firmware changes hunter behavior, add a DATED note — don't overwrite history
- New hunter class variants discovered in the wild:
  1. Parser logs `parse_warning` with full class metadata
  2. Bill reviews after the show
  3. Research behavior + add new section here
  4. THEN add parser handling

No patching parser code without updating this doc first.
