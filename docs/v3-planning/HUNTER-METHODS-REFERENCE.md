# Hunter Methods — Authoritative Reference

---

> # ⚠️ ARTICLE 1 — classType IS THE GATEKEEPER
>
> **This entire document is written for the HUNTER LENS. `classType == 'H'` in col[0] of row 0.**
>
> Every field reference in this doc (col[2], col[7], col[10], etc.) means its HUNTER value. Those same column numbers mean DIFFERENT things under the jumper lens. **Do not translate hunter field meanings to jumper contexts or vice versa.**
>
> If you are looking at a .cls where col[0] is `J`, `T`, or `U` — **stop reading this doc**. Go to `JUMPER-METHODS-REFERENCE.md` (for J/T) or `CLASS-DETECTION-SCHEMAS.md` Part 1 (for U resolution).
>
> A .cls file is STRICTLY TYPED by classType. You never mix hunter and jumper lenses on the same file.
>
> If you've ever been tempted to say "wait, doesn't col[7] mean TimeAllowed?" — no. Under the hunter lens (this doc), col[7] means `numJudges`. Under the jumper lens (other doc), col[7] means `r1FaultsPerInterval`. Both are right, IN THEIR OWN LENSES. Never both at once.
>
> See memory `feedback_class_type_commandment.md` for the full rationale.

---

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

## WHAT v2 ALREADY BUILT (HUNTER WORK THAT CARRIES INTO v3)

**Bill, Session 28 correction:** an earlier version of this doc listed "20 unresolved gaps" for hunters. That was wrong — re-audit of `display-config.js` shows v2 has substantial hunter infrastructure already tested and working. v3 inherits all of this; it doesn't rebuild from scratch.

### Derby infrastructure — COMPLETE

All 9 derby types mapped with full metadata in `WEST.hunter.derbyTypes` (display-config.js lines 1289-1298):

| derbyType | Label | Judges | H&G | showAllRounds |
|---|---|---|---|---|
| 0 | International | 2 | No | Yes |
| 1 | National | 1 | No | No |
| 2 | National H&G | 1 | Yes | Yes |
| 3 | International H&G | 2 | Yes | Yes |
| 4 | USHJA Pony Derby | 1 | No | No |
| 5 | USHJA Pony Derby H&G | 1 | Yes | Yes |
| 6 | USHJA 2'6 Jr Derby | 1 | No | No |
| 7 | USHJA 2'6 Jr Derby H&G | 1 | Yes | Yes |
| 8 | WCHR Derby Spec | 1 | No | No |

All 9 types have resolver helpers: `WEST.hunter.getDerby(code)`, `getClassLabel(classInfo)`. **All were tested during v2 development.**

### Judge grid rendering — COMPLETE

`WEST.hunter.renderJudgeGrid(entry, judgeCount, statusDisplay, opts)` at display-config.js:2013. Parameterized for:
- 1-7+ judges (7 confirmed live at class 1002, 2026-04-08)
- Derby vs non-derby layouts
- Compact (display.html sidebar, stats.html) vs expanded (results.html) modes
- Status-code dimming + per-round status rules

Derby-specific builders at lines 1831, 1872, 1902:
- `WEST.hunter.derby.buildEntries(classInfo)` — parses per-judge per-round structure
- `WEST.hunter.derby.renderPrecomputed(computed, opts)` — standard render
- `WEST.hunter.derby.renderPrecomputedByJudge(computed, opts)` — by-judge view

### Championship rendering — COMPLETE

- `isChampionship` flag (H[11]) handled throughout
- CH/RC ribbons for 1st/2nd (via `WEST.ribbon.placeRibbon` at line 230)
- Championship class detection via flag OR class name regex (`/champion/i`)
- `getClassLabel(classInfo)` returns "Hunter Championship" when flag set

### Split Decision detection — COMPLETE

When a multi-judge class has disagreement on top 3 positions, a red "SPLIT DECISION" pill renders on the class header. Judge grid shows per-judge ranks so spectators can see the disagreement source.

### Multi-round scoring — COMPLETE

- R1 / R2 / R3 column layouts confirmed (non-derby sequential +9 stride, derby special layout)
- 7 judges at cols 15-21 (R1) / 24-30 (R2) — confirmed class 1002, 2026-04-08
- R3 at cols 33-39 — confirmed class 925 Special, 2026-04-10
- Combined score totals at cols[42/43/44]/[45]
- Phase weights extraction at cols[22-24]
- Phase labels at cols[25-27]

### Equitation overlay — COMPLETE

- `isEquitation` detection (method 7 on jumper OR H[10]=True on hunter)
- Rider-primary identity flip across all standings, on-course cards, and results
- "Rider / Horse" column header instead of "Horse / Rider"
- Scored vs Forced (scoringType) sub-variants both handled

### Detection helpers — COMPLETE

- `WEST.hunter.isDerby(classInfo)`
- `WEST.hunter.isEquitation(classInfo)`
- `WEST.hunter.getClassLabel(classInfo)` — handles all classMode + scoringType + flag combinations
- `WEST.hunter.isChampionship(classInfo)`

### Status code handling — COMPLETE

- Text status per round (cols[52/53/54]) + numeric fallback (cols[46/47/48]) with 1=EL, 2=RT, 3=OC, 4=WD, 5=RF, 6=DNS mapping
- Evidence-based has-gone logic (don't trust flag columns alone — use score OR place OR non-DNS status)
- Per-round status display rules (each round independent — a round's status hides that round only, not downstream rounds)

---

## REMAINING GAPS (the smaller, real list)

These are the flags / behaviors spec'd but not live-verified OR not yet implemented. Much shorter than the earlier "20 gaps" list because most were actually done in v2.

1. **Team class aggregation** (classMode=3 + isTeam=True) — header parsed, but team-level scoring rollup (summing member scores, team standings) is not implemented. When v3 first sees a Special Team class live, this needs filling in.

2. **Run-off (runOff flag, H[30])** — parser reads it, display has no special handler. Happens when top placings are tied and a timed run-off resolves them. Not observed live in our D1 sample.

3. **California Split (californiaSplit, H[17])** — parser reads it + `caliSplitSections` (H[33]). Rare, mostly west-coast convention. Class divided into sections, each with its own placings. v2 doesn't render section dividers.

4. **IHSA rules (ihsa flag, H[38])** — flag parsed but no behavior changes triggered. Intercollegiate catch-ride format has different scoring conventions. Unknown whether a cross-reference to IHSA rules is required.

5. **displayNATTeam (H[36])** — flag parsed, display behavior unknown. National team display mode, likely FEI-ish.

6. **reverseRank (H[16])** — flag parsed (lower score wins). Never observed live. Edge case.

7. **noCutOff (H[32])** — flag parsed, effect on placings unclear (default cutoff unknown).

8. **avgRounds (H[31]) vs scoreMethod=1 (H[06])** — two different signals for averaging. Precedence rule unverified.

9. **Jumper-division championship classes (H type)** — classes like 20C, 23C in D1 are classType=H but named after jumper divisions. Points aggregation from qualifying jumper classes is done in Ryegate, not us. We render what Ryegate gives us; the actual math isn't modeled on our side.

10. **Phase weight edge cases** — what if weights sum to >100 or <100? Parser accepts any number, display applies directly without normalization.

**Handling in v3:** parse_warnings table (per DATABASE-SCHEMA-EXPANSION) captures the first live occurrence of any of these. Bill reviews post-show, codifies into the hunter module. Observability > speculation.

---

## SUMMARY — what v3 inherits vs what still needs work

**v3 inherits from v2 (don't rebuild):**
- All 9 derby types mapped with metadata
- Judge grid renderer (1-7 judges, derby vs non-derby, compact + expanded modes)
- Derby scoring pipeline (per-judge per-round, hiopt, handy bonus)
- Championship class rendering (CH/RC ribbons, isChampionship flag)
- Split Decision multi-judge disagreement detection
- Equitation overlay (rider-primary identity)
- classMode / scoringType / flag detection helpers (isDerby, isEquitation, isChampionship, getClassLabel)
- Status code text + numeric fallback mapping
- Multi-round column layouts (up to 7 judges, up to R3 confirmed)
- Phase weights extraction, phase labels

**v3 still needs to do:**
- Port all the above into the shared `west-rules.js` / hunter-specific helper module (vanilla-JS IIFE style, dual-environment per project_electron_engine.md)
- Implement the 10 remaining gaps listed above as they appear live (observability-first — log parse_warnings, codify after review)
- Maintain the classType gatekeeper (Article 1) as the top-level parser branch

**v3 does NOT need to re-derive:**
- Column positions for non-derby and derby
- Judge count behavior
- Status code mappings
- Derby type labels
- Championship ribbon logic
- Multi-judge split-decision detection

---

## COLUMN MAPS — self-contained hunter reference

The hunter column maps from CLS-FORMAT.md are reproduced here so the hunter doc is a single source for v3 hunter parser work. The session dates and class confirmations are preserved — this represents hundreds of hours of live-toggle testing.

**Remember Article 1:** every column below is meaningful ONLY under the hunter lens (`classType == 'H'`). The same column numbers mean different things in the jumper lens.

### Hunter Header Columns (H[00] — H[39])

Confirmed from live toggle test 2026-03-22 with incremental confirmations through 2026-04-10.

```
H[00] ClassType              H
H[01] ClassName              text

H[02] ClassMode              CONFIRMED 2026-04-06 by cycling all 4 Ryegate class type settings:
                             0 = Over Fences (standard hunter, scored or forced)
                             1 = Flat (no jumps, scored)
                             2 = Derby (auto-set when Derby selected)
                             3 = Special (custom multi-round, Normal or Team)

H[03] NumRounds              CONFIRMED 2026-04-10 on class 925 Special.
                             Values: 1, 2, or 3.

H[04] CurrentRound           CONFIRMED 2026-04-10 by snapshot diff on class 925 Special:
                             1 = R1 view active in Ryegate
                             2 = R2 view active in Ryegate
                             3 = R3 view active in Ryegate
                             N+1 = "Overall" view (e.g. 4 in a 3-round class)
                             Reflects what operator is currently viewing — NOT
                             a measure of rounds scored. Useful live-on-course
                             signal: when a horse is in the ring, the round tab
                             usually matches what they're about to ride.
                             live.html uses this to label the on-course banner
                             round (R1/R2/R3); falls back when h[4] > numRounds.

H[05] ScoringType            CONFIRMED 2026-04-06 by cycling scoring type settings:
                             0 = Forced (operator manually enters placements)
                             1 = Scored (places derived from judge scores, Total)
                             2 = Hi-Lo (drop highest + lowest, average rest)
                             NOTE: was mislabeled IsFlat — corrected 2026-04-06

H[06] ScoreMethod            CONFIRMED 2026-04-06:
                             0 = Total (sum all judge scores)
                             1 = Average (average all judge scores)
                             NOTE: also 1 for WCHR Derby Spec (H[37]=8) — may
                             have dual meaning. Label STILL UNCERTAIN for H&G
                             and Special variants (possibly IsHuntAndGo).

H[07] NumJudges              1 to 7+ judges. CONFIRMED 2026-04-06 by cycling 1→5,
                             7 verified live on class 1002 (2026-04-08).
                             Auto-adjusts per derby sub-type.
                             NOTE: was mislabeled NumScores — clarified 2026-04-06

H[08] RibbonCount            CONFIRMED 2026-04-10 — TRUE ribbon count (matches
                             Ryegate's "12 ribbons" setting). 12 for derbies &
                             Specials, 8 for standard hunter. Earlier doc claimed
                             H[04] was ribbon count — that was wrong. H[08] is
                             the only ribbon count field.

H[09] SBDelay                numeric scoreboard delay (tested at value 4)

H[10] IsEquitation           True/False ✓
H[11] IsChampionship         True/False ✓
H[12] IsJogged               True/False ✓
H[13] OnCourseSB             True/False ✓
H[14] IgnoreSireDam          True/False ✓
H[15] PrintJudgeScores       True/False ✓
H[16] ReverseRank            True/False ✓

H[17] CaliforniaSplit        True/False ✓ (confirmed — flips True when Split
                             enabled in Ryegate). NOTE: watcher label "RunOff"
                             is WRONG for hunter — it's CaliforniaSplit here.

H[18] R1TieBreak             0 = LeaveTied, 1-N = ByJudgeN ✓
H[19] R2TieBreak             0 = LeaveTied, 1-N = ByJudgeN ✓
H[20] R3TieBreak             0 = LeaveTied, 1-N = ByJudgeN ✓
H[21] OverallTieBreak        0 = LeaveTied, 20 = ByOverallScore ✓

H[22] PhaseWeight1           always 100
H[23] PhaseWeight2           always 100
H[24] PhaseWeight3           always 100
H[25] Phase1Label            "Phase 1" default, customizable
H[26] Phase2Label            "Phase 2" default, customizable
H[27] Phase3Label            "Phase 3" default, customizable
H[28] Message                scoreboard message text
H[29] Sponsor                sponsor text

H[30] RunOff                 True/False ✓
H[31] AvgRounds              True/False ✓
H[32] NoCutOff               True/False ✓
H[33] CaliSplitSections      numeric — 2=default, 4=confirmed ✓
H[34] Dressage               True/False ✓
H[35] ShowAllRounds          True/False ✓ (auto-set per derby type default)
H[36] DisplayNATTeam         True/False ✓
H[37] DerbyType              FULLY CONFIRMED 2026-04-03 by cycling all types
                             (see derby type table below)
H[38] IHSA                   True/False ✓
H[39] RibbonsOnly            True/False ✓
```

### Derby Auto-changes (when Derby selected)

```
H[02] → 2 (HiLo family)
H[07] → varies by derby sub-type
H[08] → 12 (ribbon count)
H[35] → True (standard derbies) or False (H&G variants)
H[39] → False (RibbonsOnly auto-cleared)
```

### ShowAllRounds defaults per derby type

```
International (1): True          | National (2): True
NatlHG (3): False                | IntlHG (4): False
USHJAPony (5): True              | USHJAPonyHG (6): False
USHJA26Jr (7): True              | USHJA26JrHG (8): False
```
H&G variants = False, Standard derbies = True. Operator can override.

### Tie Break encoding

```
0   = Leave Tied
1-N = By Judge N (literal judge number)
20  = By Overall Score
```

### Hunter Header — STILL UNCERTAIN

```
H[06]   — label unknown for H&G / Special variants (possibly IsHuntAndGo)
H[07]   — auto-adjusts per derby type, full mapping incomplete
H[09]   — SBDelay, only tested at value 4
H[37]=9 — WCHR Spec sub-variant not directly confirmed (extends the 0-8 range)
```

---

### Hunter Entry Columns

Hunter entries are always 55 cols. Identity cols 0-12 match Jumper layout (see jumper reference).

```
col[00] EntryNum (or empty — some entries padding)
col[01] Horse
col[02] Rider
col[04] CountryCode
col[10-12] FEI numbers
```

### Standard single-judge single-round Over Fences

```
col[13] GoOrder
col[14] CurrentPlace            live standing, updates after each horse
col[15] R1Score                 judge score (45-95 typical)
col[42] R1Total                 same as R1Score (no bonus in single-judge OF)
col[45] CombinedTotal           same as R1Total
col[49] HasGone_R1              1=competed
col[52] StatusCode              EX/RF/HF/EL/OC
```

### Non-derby scored (H[02]=0 or 3, H[05]=1 or 2) — 1 to 7+ judges, 1-3 rounds

CONFIRMED 2026-04-08 (7 judges, 2 rounds, class 1002)
CONFIRMED 2026-04-10 — R3 column map from class 925 Special, 2 judges

**Per-judge scores are SEQUENTIAL — no hiopt, no bonus, no mirrors.**

```
R1: col[15 + j] where j = 0..numJudges-1    (J1=col[15], J2=col[16], ... J7=col[21])
R2: col[24 + j] where j = 0..numJudges-1    (J1=col[24], J2=col[25], ... J7=col[30])
R3: col[33 + j] where j = 0..numJudges-1    (J1=col[33], J2=col[34], ... J7=col[39])

col[42] R1Total                 sum of all judge R1 scores
col[43] R2Total                 sum of all judge R2 scores
col[44] R3Total                 sum of all judge R3 scores ★ NEW
col[45] CombinedTotal           R1Total + R2Total (+ R3Total if 3 rounds)
                                SAME caveat as derbies: only correct when operator
                                views "Overall" in Ryegate. Compute yourself from
                                col[42]+col[43](+col[44]) rather than trust col[45]
                                mid-class.
col[46] R1_NumericStatus
col[47] R2_NumericStatus
col[48] R3_NumericStatus        ★ NEW
col[49] HasGone_R1
col[50] HasGone_R2
col[51] HasGone_R3              ★ NEW
col[52] StatusCode_R1
col[53] StatusCode_R2
col[54] StatusCode_R3           ★ NEW

UNUSED padding cols:
  22-23 (between R1 and R2)
  31-32 (between R2 and R3)
  40-41 (between R3 block and totals)
```

**Note:** this layout is COMPLETELY DIFFERENT from derby. Derby interleaves hiopt/base/bonus/mirrors; non-derby is straight sequential +9 stride per round. H[02] determines which layout to use.

### Two-round classic (1 judge, 2 rounds — legacy reference)

```
col[13] GoOrder
col[14] CurrentPlace
col[15] R1Score                 (= J1 R1 score when 1 judge)
col[24] R2Score                 (= J1 R2 score when 1 judge)
col[42] R1Total
col[43] R2Total
col[45] CombinedTotal           R1 + R2
col[49] HasGone_R1              1 = R1 only (scratched before R2)
col[50] HasGone_R2              1 = completed both rounds
col[52] StatusCode_R1
col[53] StatusCode_R2
```

### International Derby (2 judges, 2 rounds, high options + handy)

FULLY CONFIRMED 2026-04-03 from class 1001

```
col[13] GoOrder
col[14] CurrentPlace
col[15] R1_HighOptionsTaken
col[16] Judge1_R1_BaseScore
col[17] R1_HighOptionsTaken     (mirrors col[15])
col[18] Judge2_R1_BaseScore
col[24] R2_HighOptionsTaken
col[25] Judge1_R2_BaseScore
col[26] Judge1_R2_HandyBonus    (0-10)
col[27] R2_HighOptionsTaken     (mirrors col[24])
col[28] Judge2_R2_BaseScore
col[29] Judge2_R2_HandyBonus    (0-10)
col[42] R1Total                 = (J1base + hiOpt) + (J2base + hiOpt)
col[43] R2Total                 = (J1base + hiOpt + handy) + (J2base + hiOpt + handy)
col[45] CombinedTotal           = R1Total + R2Total
                                * ONLY CORRECT after operator views Overall in Ryegate
                                * While viewing R1 or R2, col[45] shows THAT round's total
col[46] R1_NumericStatus        0=normal, 2=incident, 3=retired
col[47] R2_NumericStatus        same values
col[49] HasGone_R1
col[50] HasGone_R2
col[52] R1_TextStatus           RF/HF/EL/OC/DNS (empty for RT)
col[53] R2_TextStatus           same (empty for RT)
```

### National Derby (1 judge, 2 rounds, high options + handy)

CONFIRMED 2026-04-03 from class 1000

```
col[13] GoOrder
col[14] CurrentPlace
col[15] R1_HighOptionsTaken
col[16] Judge1_R1_BaseScore
col[42] R1Total                 = base + hiOpt
col[24] R2_HighOptionsTaken
col[25] Judge1_R2_BaseScore
col[26] Judge1_R2_HandyBonus    (0-10) — NOT CONFIRMED for National, was 0 in test
col[43] R2Total                 = base + hiOpt (+ handy if applicable)
col[45] CombinedTotal           (same Overall-view caveat as International)
col[46] R1_NumericStatus
col[47] R2_NumericStatus
col[49] HasGone_R1
col[50] HasGone_R2
col[52] R1_TextStatus
col[53] R2_TextStatus
```

### Combined Total Caveat (CRITICAL)

```
col[45] CombinedTotal is ONLY accurate when operator views "Overall" in Ryegate.
While viewing R1 or R2, col[45] reflects that round's total only.
For reliable combined: compute R1total[42] + R2total[43] ourselves.
```

Applies to ALL hunter classes with multiple rounds. v3 parser should ALWAYS compute combined from component totals, never trust col[45] for mid-class state.

### Score Detection — Hunter

```
Has competed:     col[49]=='1' OR col[50]=='1' (combined with evidence below)
Eliminated:       col[52] or col[53] non-empty
Standard score:   col[49]=='1' AND col[15] non-zero
Classic score:    col[50]=='1' AND col[15] non-zero AND col[24] non-zero
```

### Hunter Status Code System — CONFIRMED 2026-04-03

```
col[46]: R1 numeric status code
         0 = Normal completion
         1 = DNS (Did Not Start)
         2 = EL (Eliminated — covers RF, HF, EL, OC generically)
         3 = RT (Retired / voluntary withdrawal)
         4 = WD (Withdrawn)
         5 = RF (Rider Fall — specific)
         6 = OC (Off Course — specific)
         7 = MR (?)
         8 = HC (Hors Concours)

Worker maps: {'1':'DNS','2':'EL','3':'RT','4':'WD','5':'RF','6':'OC','7':'MR','8':'HC'}

col[47]: R2 numeric status code (same values as col[46])
         CONFIRMED from class 1001 entry 113 (retired in R2)

col[52]: R1 text status code
         RF = Rider Fall, HF = Horse Fall, EL = Eliminated
         OC = Off Course, DNS = Did Not Start
         DOES NOT WRITE for RT/Retired — use col[46]=3 as fallback
         May be sticky — doesn't always clear on status change in Ryegate

col[53]: R2 text status code (same values as col[52])
         Same RT caveat — doesn't write text, use col[47]=3 as fallback

Display logic (waterfall):
  1. Check text code (col[52] R1 / col[53] R2) — use if present
  2. If empty, check numeric (col[46] R1 / col[47] R2):
     - 2 → show as "EL" (generic — text code would have been more specific)
     - 3 → show as "RT" (retired — text code never writes for this)
  3. If both empty/zero = normal completion
```

### Hunter hasGone Logic — CONFIRMED 2026-04-03

```
hasGone flag (col[49]/col[50]) is NOT reliable alone:
  - DNS entries may have hasGone=1 but no scores
  - Accidental toggles can set hasGone=1 with no data
  - Ryegate testing mode leaves hasGone stuck

Correct detection (waterfall, evidence-based):
  R1 competed = hasGone[49]=1
                AND (score[15]>0 OR R1total[42]>0 OR status[52] non-empty OR col[46]>0)
  R2 competed = hasGoneR2[50]=1
                OR R2score[24]>0 OR R2total[43]>0 OR status[53] non-empty

If hasGone=1 but no scores AND no status code → treat as NOT gone (accidental toggle)
If hasGone=0 but scores present → treat as gone (manual entry)
```

---

## JUDGES GRID DESIGN — the layout that was really thought out

**Bill, Session 28:** "that judges grid was really thought out the judge column by rounds row."

The judges grid is the centerpiece visual for multi-judge hunter classes. It's not a table of scores thrown together — it's a deliberate structure that reads top-down AND left-right in the way spectators naturally scan.

### The layout

```
                 R1     R2     R3     Total
  Judge 1       [87]   [85]          [172]
  Judge 2       [86]   [88]          [174]
  Judge 3       [85]   [86]          [171]
                -----  -----         -----
  Round Total   [258]  [259]         [517]
```

**Axis choice:** judges are the COLUMN axis, rounds are the ROW axis. Each judge's scores read TOP TO BOTTOM (how that judge saw the class round by round). Each round's combined reads LEFT TO RIGHT (what all judges thought of that round).

Why this way, not the other:
- Spectators typically look at ONE judge's pattern at a time ("what did Judge 1 think overall")
- Then compare across judges for a given round ("Judge 1 vs Judge 2 on R2")
- Putting judges as columns puts that scan direction along the eye's natural left-right motion
- Putting rounds as rows keeps the round labels in the reading axis

### Variants and parameterization

Built in `WEST.hunter.renderJudgeGrid(entry, judgeCount, statusDisplay, opts)`:

- **Compact mode** (display.html sidebar, stats.html): just total row + one score row, for at-a-glance
- **Expanded mode** (results.html): full grid with all judges × all rounds + per-round totals + grand total
- **Derby mode** (opts.isDerby): separate rows for base score, hiopt, handy bonus per judge per round
- **Single-judge mode**: degenerates to a single column — grid collapses gracefully
- **Status-code mode**: if a round is EL/RT/WD, that row dims with the status label in place of scores

### What makes it work

1. **Columns scale with judge count.** 1 judge = narrow. 7 judges = full grid. Same code path.
2. **Status dims, not hides.** Eliminated rounds stay visible (with status code) instead of disappearing, preserving continuity in the grid.
3. **Total rows bold.** The one row spectators gravitate to (overall totals) is visually weighted so it reads as the answer.
4. **Per-round totals at the bottom.** Round columns sum vertically, total row sums horizontally. Two axes of comparison in one grid.
5. **Derby bonus rows shared with base.** Same column; base + hiopt + handy are stacked within the cell, not splitting into new columns. Keeps the judge-column abstraction intact.

### Why this matters for v3

- v3 must preserve this grid exactly — it's the single most information-dense display on the site
- The renderer (`WEST.hunter.renderJudgeGrid`) should move to the shared rules/display module with the SAME API (entry, judgeCount, statusDisplay, opts)
- Don't redesign it — spectators have learned to read it. "Modernize under the hood, not on the surface" applies hardest here.

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

- `CLS-FORMAT.md` (sibling doc in this folder, moved here from repo root in Session 28) — column-level spec (source of truth for field positions)
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
