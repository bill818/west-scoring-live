# Jumper Scoring Methods — Authoritative Reference

---

> # ⚠️ ARTICLE 1 — classType IS THE GATEKEEPER
>
> **This entire document is written for the JUMPER LENS. `classType == 'J'` (Farmtek) or `'T'` (TOD) in col[0] of row 0.**
>
> Every field reference in this doc (col[2], col[5], col[8], col[18], etc.) means its JUMPER value. Those same column numbers mean DIFFERENT things under the hunter lens. **Do not translate jumper field meanings to hunter contexts or vice versa.**
>
> If you are looking at a .cls where col[0] is `H` — **stop reading this doc**. Go to `HUNTER-METHODS-REFERENCE.md`. If col[0] is `U`, go to `CLASS-DETECTION-SCHEMAS.md` Part 1 for the lens-resolution rules.
>
> A .cls file is STRICTLY TYPED by classType. You never mix hunter and jumper lenses on the same file.
>
> If you've ever been tempted to say "wait, doesn't col[10] mean isEquitation?" — not under this lens. Under the jumper lens (this doc), col[10] means `r2FaultsPerInterval`. Under the hunter lens (other doc), col[10] means `isEquitation`. Both are right, IN THEIR OWN LENSES. Never both at once.
>
> See memory `feedback_class_type_commandment.md` for the full rationale.

---

## Purpose

One canonical page per jumper scoring method. For each: the official name, scoring rules, round structure, status-carry behavior, train-stack model, known quirks, and source citations from prior sessions / CLS-FORMAT.md.

This is the document v3's `.cls` parser + class descriptor codes against. When you see "we keep patching this method" it's because this info was scattered across 27 session notes and CLS-FORMAT.md; now it's consolidated.

**When a new method or modifier is encountered in the wild, append the knowledge HERE first, before writing parser code.**

Related docs:
- `CLASS-RULES-CATALOG.txt` — broader behavioral rules by U/H/T/J
- `/CLS-FORMAT.md` — column-level .cls spec (source of truth for field positions)
- `STATS-MODULE-ADDENDUM.txt` — how these methods power stats primitives

---

## Train-Stack Model (Bill's analogy)

> Class = freight train. Each entry = a train car. Each car can stack up to 3 containers (one per round). A container stacks only when advancement conditions are met. Rendering reads top-row-first: everyone with the most containers, then next tier down.

Applied per method below in each "Stack model" line.

---

## Status-Carry: the "Ladder" Model

Bill's ladder rule (train metaphor extension):

> **A ladder exists between two rounds ONLY when their faults are added together (cumulative scoring). At a ladder, you can be kicked off — later-round elim voids the earlier result. Above the last ladder, you're secure. Stacks never demote — you either hold your tier or are removed from placings entirely.**

This replaces the older "status-carry family" classification because it's more precise: the question isn't "what family is the whole method in," it's "for each pair of adjacent rounds, are their faults summed?"

**Per-adjacency rule:**
- `cumulative: true` → ladder between those rounds → later-round EL/RT/WD erases earlier result
- `cumulative: false` → no ladder → earlier result is secured even if later round fails

**Examples:**
- Method 3 (2-round + JO): R1→R2 is `cumulative: true` (ladder). R2→JO is `cumulative: false` (no ladder — once in JO you can't be demoted).
- Method 9 (II.2d): PH1→PH2 is `cumulative: true` (ONE ride scored as a sum — ladder exists even though it's one physical ride).
- Method 2 (II.2a): R1→JO is `cumulative: false` (JO is a separate competition from R1, no ladder).
- Method 15 (Winning Round): R1→R2 is `cumulative: false` (R1 faults wiped entirely for R2 — no ladder).

**Universal guarantees regardless of method:**
- Monotonic stacks — an entry's tier (max stack depth reached) never decreases during scoring
- EL at any ladder = entry removed from placings entirely, NOT demoted to a lower tier
- Single-round classes have no ladders possible — any status hides everything

---

## Modifier Column (H[03]) — context-dependent per method

| Method | H[03]=0 | H[03]=1 | H[03]=2 |
|---|---|---|---|
| 3 | Ties broken by R1 time | Remain tied | — |
| 5 | Gamblers Choice | Accumulator | — |
| 6 | 1-round optimum | 2-round optimum + JO | — |
| 7 | Forced (operator pins) | Scored (from scores) | — |
| 11 | — | FEI Art 4.2 (PH1 no clock) | FEI Art 4.3 (PH1 with clock) |
| 14 | Individual times | Combined team times | — |

Other methods: H[03]=0 only, no modifier.

---

## METHOD 0 — Table III (USEF) / Table C (FEI)

- **Scoring:** Faults converted to penalty seconds. Ranked by converted time only.
- **Rounds:** 1 round. No JO.
- **Status-carry:** SINGLE-ROUND.
- **FEI:** Yes — FEI Table C article.
- **Stack model:** 1 container max. No stacking possible.
- **In noJumpOff list:** Yes (confirmed SESSION-22). Watcher previously mislabeled "Jump Off" for this method — fixed.
- **Live examples:**
  - Test show (`hits-culpeper`, TOD): class 811 "Table III", class 900 "New Class with OOG"
  - Culpeper April (`hits-culpeper-april`, Farmtek): class 417 "$5,000 STX Open Speed - 1.20m" — LIVE 2026-04-17, ran successfully
- **Verified:** Live + spec.

---

## METHOD 2 — II.2a — Round + JO (clears return)

- **Scoring:** Fewest faults in R1 return for JO. Time breaks ties inside R1 for non-JO placings; JO time/faults determines JO placings.
- **Rounds:** 1 round, JO only for zero-fault R1s.
- **Immediate JO:** No. H[06]=0 — delayed JO (clears return after all R1 done).
- **Status-carry:** R1-HOLDS. EL in R1 hides everything; a placed R1 with a completed JO shows both.
- **FEI:** Yes — FEI Art 220.2.1.2 / USEF Article 220.2.1.2.
- **Stack model:** 2 containers max. Everyone who competed gets R1 container. Zero-fault R1s get JO container stacked on top. Render: JO placings on top, then R1 clears who didn't JO (shouldn't happen in 2a but edge cases), then R1 faulters, then non-starters.
- **JO-N overlay (SESSION-22):** Pre-JO display shows "JO-1, JO-2, ..." instead of tied "1"s in R1 ride order, scoped to method 2 only. Excluded from immediate-JO methods.
- **Live examples:**
  - Test show (TOD): class 9 "$25,000 DEVON FALL CLASSIC 1.35-1.40m II.2a", class 38 "$7,500 SJHF 1.35M JUNIOR/AMATEUR JUMPER II.2a", class 809 "NEW II2a Class"
  - Culpeper April: none — this show didn't run any II.2a classes in ring 1
- **Verified:** Class 809 tested live through OOG + type inference; classes 9, 38 are real operational classes named with II.2a in title.

---

## METHOD 3 — 2 Rounds + JO

- **Scoring:** Cumulative R1+R2 faults determine JO entry. Fewest cumulative return.
- **Rounds:** 2 rounds (both scored) + JO for tied fewest-cumulative.
- **Modifier (H[03]):** 0 = ties broken by R1 time; 1 = remain tied.
- **Status-carry:** CARRY-BACK. R1 status hides all. R2 status wipes all (shows R1 for context per spec but display may vary). JO status shows R1+R2.
- **FEI:** Yes — FEI Art 221.4.1 (H[03]=0) and 221.4.2 (H[03]=1).
- **Stack model:** 3 containers max. Everyone gets R1 container. Those who ride R2 get R2 stacked. Top cumulative-fault tier gets JO stacked on R2. Render top-down.
- **Live examples:**
  - Test show (TOD): none — no explicit Method 3 class in the test show catalog
  - Culpeper April (Farmtek): none — no Method 3 class in ring 1
  - Historical reference: class 221 at Devon Fall Classic — parsed the 3-round data that established the column layout
- **Verified:** Column layout confirmed from Devon class 221 data (CLS-FORMAT.md lines 388-427). No clean method-3 live run in the two shows surveyed here — worth flagging: the column structure was verified, but whether the full JO logic works end-to-end at a 2026 show is not in our data.

---

## METHOD 4 — II.1 — Speed (1 round)

- **Scoring:** Faults ascending, then fastest time wins.
- **Rounds:** 1 round only. No JO.
- **Status-carry:** SINGLE-ROUND.
- **Time faults:** Applied (clock active). Standard interval + fault calculation.
- **FEI:** Yes — FEI Art 220.1.1.1 (Time First Round).
- **Stack model:** 1 container max.
- **Contrast with Method 6:** Both are single-round, but Method 4 is fastest-time; Method 6 is closest-to-optimum.
- **Live examples:**
  - Test show (TOD): EXTENSIVELY tested — classes 2, 4, 8, 19, 22, 25, 28, 34, 40, 49, 50, 51, 52, 53, 54, 55, 56, 804, 812 (all named "II.1" in title including "$10,000 SPEED STAKE 1.40m II.1")
  - Culpeper April (Farmtek): classes 214, 218, 222, 266, 267, 270, 285 — these are the "speed" counterparts at each division (ran live 2026-04-17)
- **Verified:** Live at both shows. Heaviest-tested method after 13.

---

## METHOD 5 — Top Score (Gamblers Choice / Accumulator)

- **Status:** DROPPED — never observed in live data (SESSION-22). Removed from watcher's active method map.
- **Scoring (spec):** Highest score wins (reversed from faults ascending).
- **Time faults:** H[07]=0 — no time faults.
- **Modifier (H[03]):** 0 = Gamblers Choice (USEF only); 1 = Accumulator (FEI Art 229).
- **Rounds:** 1 round. No JO.
- **Status-carry:** SINGLE-ROUND.
- **Stack model:** 1 container max.
- **Action:** If ever seen in the wild, un-drop from method map and confirm live behavior before declaring parser ready.

---

## METHOD 6 — IV.1 — Optimum Time

- **Scoring:** Faults ascending, then distance from optimum ascending. `score = abs(time - optimum)` as secondary sort.
- **Optimum formula:** `optimum = TA - 4` seconds (hardcoded FEI/USEF convention).
- **Modifier (H[03]):** 0 = 1 round; 1 = 2 rounds + JO (JO uses optimum).
- **Status-carry:** SINGLE-ROUND (H[03]=0) or CARRY-BACK (H[03]=1).
- **Display:** Show "Optimum Xs" under TA. Show "+/- distance from optimum" per entry. Green highlight if within 2s of optimum.
- **FEI:** No — not in FEI articles.
- **Stack model:** 1 container (H[03]=0) or 2 containers (H[03]=1 with JO).
- **Verified:** Spec. Live test deferred (SESSION-22 line 141: "Method 6 Optimum test pending").

---

## METHOD 7 — Timed Equitation

- **USEF only.** Not in FEI.
- **Jumper protocol, equitation identity:** Uses jumper UDP (not hunter) but displays like equitation (rider primary).
- **Scoring:** Equitation scores stored in col[19] (the r1JumpFaults slot), NOT jump faults. Col[20] duplicates.
- **Modifier (H[03]):** 0 = Forced (operator enters placements); 1 = Scored (derived from scores).
- **Rounds:** 1 round. No JO. In noJumpOff list.
- **Status-carry:** SINGLE-ROUND.
- **Time handling:** Clock active, TA displayed, but time doesn't determine ranking — score does (or operator pinning for H[03]=0).
- **UDP pattern (SESSION-21):** `{2}=rider` (swapped to primary), `{3}=empty`, `{6}=city/state`, horse name not in UDP. Finish frame HOLDS indefinitely (no 10s expiry like jumpers).
- **On-course display:** Rider + city/state primary, hide jump faults. After pinned: placement + "X pts."
- **RANK signal:** May not send `{8}` on "Display Scores" — uses decimal FINISH metric as placement indicator.
- **Stack model:** 1 container max.
- **Verified:** Fully shipped SESSION-21, tested with class 809 rider-swap.

---

## METHOD 9 — II.2d — Two-Phase (ALL advance to PH2)

- **Physical flow:** One ride, two phases. `Start → transition gate → clock resets to 0 → finish`. Clock has TWO segments, each starting at 0, each with its own TA.
- **Scoring:** Cumulative PH1+PH2 faults. All entries ride both phases.
- **Status-carry:** CARRY-BACK. EL/RT in PH2 erases PH1 — because it's semantically ONE round split into two phases. The whole ride is voided.
- **Vendor transition behavior:**
  - **Farmtek:** Automatic 5-second hold. UDP gap ~5s. Phase 2 elapsed starts at ~5 in UDP stream (explains the Session 27 mystery — it's the hold, not a clock failing to reset).
  - **TOD:** Operator-gated "Send to Next Round" button. Variable gap. Phase 2 anchored to phase 1 trigger timestamp, not button press.
- **TIMY/TOD columns:** Phase 1 in R1 block, Phase 2 in R2 block (same as Farmtek, confirmed 2026-04-04).
- **FEI:** Yes — FEI Art 222.2.3 (Two-Phase Special).
- **Stack model:** **1 container with phase-1/phase-2 divider** — NOT two stacked containers. Because 2d is semantically one round. Rendering should show phase 1 and phase 2 side-by-side in the same tier, not one stacked on the other.
- **Verified:** Phase transition logging added SESSION-26. Real two-phase UDP captured Session 27 (log analysis confirmed 1-Hz clean source + 5s Farmtek hold artifact).

---

## METHOD 10 — II.2f — Stratified JO

- **Scoring:** R1 faults determine fault tier. Pre-determined top-N of each tier advance to JO.
- **Rounds:** 1 round, JO within tiers.
- **Status-carry:** R1-HOLDS.
- **FEI:** Yes — mapped to FEI Art 220.1.1.3 (R1+JO ties unbroken per CLS-FORMAT.md).
- **Stack model:** 2 containers max. R1 container for all. JO container stacked for tier-members who advance.
- **Verified:** Spec only. Never observed live. Parser should log "unknown stratification rules" warning until first live encounter.

---

## METHOD 11 — II.2c — Two-Phase (only clears advance to PH2)

- **This is the II.2c I thought lived elsewhere. It's method 11.**
- **Physical flow:** Two phases — but only PH1 clears continue to PH2. SAME physical flow as Method 9 (start → gate → clock resets → finish) when they DO continue.
- **Scoring:** PH1 faults + time determine who clears to PH2. PH2 adds faults/time for tied clears.
- **Status-carry:** CARRY-BACK in spec — but the SEMANTICS for EL differ from Method 9: because PH2 is effectively a jump-off (only R1 clears ride it), an EL in PH2 doesn't erase PH1 clear status. The rider cleared PH1 and gets that credit. This is the rule Bill explained this session.
  - **Operational note:** This is the place where status-carry depends on the SEMANTIC reading. Spec says CARRY-BACK, but the judging convention differs from 9. Parser should treat 11 as "phase-2 EL keeps phase-1 result" behaviorally.
- **Modifier (H[03]):** 1 = FEI Art 4.2 (PH1 NOT against clock); 2 = FEI Art 4.3 (PH1 against clock).
- **IsFEI flag:** H[18]=True required for FEI Art variants.
- **FEI:** Yes — FEI Art 222.1.4.2 (Art 4.2) and 222.1.4.3 (Art 4.3).
- **Stack model:** 2 containers. PH1 = R1 container for all. PH2 = JO-equivalent container stacked for clears. Normal two-container stacking — unlike Method 9 which is one container with a divider.
- **Verified:** Spec only. FEI integration confirmed SESSION-20 (hunter multi-round work touched related flags). Live test not cited.
- **Parser warning:** H[03]=1 "PH1 NOT against clock" means different H[07]/H[09] interpretation for PH1 block. Needs fixture testing before shipping live.

---

## METHOD 13 — II.2b — Immediate Jump-Off (only clears advance)

- **Scoring:** Only R1 clears advance to JO. JO is IMMEDIATE — horse returns to ring immediately after their R1 round if clear, before next R1 rider.
- **Rounds:** 1 round + immediate JO.
- **Immediate JO:** H[06]=1.
- **Tie-break when no clears:** R1 time breaks ties (JO is "broken" by R1 time).
- **Status-carry:** R1-HOLDS. JO placement valid on R1; R1 status hides all.
- **JO-N overlay (SESSION-22):** NOT applied. Places populate progressively during immediate-JO.
- **FEI:** No — not in FEI.
- **Stack model:** 2 containers max. R1 for all. JO stacked for clears. Similar structure to Method 2 but the stacking happens immediately per-rider rather than in a batch.
- **Verified:** Classes 23, 24, 27 (SESSION-25) — method 13 with real status codes (numeric + text) confirmed live.

---

## METHOD 14 — Team Competition

- **Rounds:** R1 + R2 + JO (3 rounds — confirmed SESSION-22 after fix from swapped method 15).
- **Scoring:** Per-spec, applied to TEAM aggregate. Individual times feed team totals.
- **Modifier (H[03]):** 0 = individual times (sum); 1 = combined times (all riders added).
- **Status-carry:** CARRY-BACK.
- **FEI:** Yes — FEI Art 226 (Nations Cup).
- **Stack model:** 3 containers per rider × team aggregation layer on top. The stack model applies per-rider AND there's a team-level rollup that's independent. Rendering needs to support both views (rider standings inside a team, team standings across teams).
- **Method-label fix (SESSION-22):** Previously swapped with method 15 in the method map. Now: 14 = Team (R1/R2/JO), 15 = Winning Round (R1/R2 no JO).
- **Verified:** Spec + method-map fix. Not explicitly live-tested in notes.

---

## METHOD 15 — Winning Round (2 rounds, R1 wiped for R2)

- **Scoring:** 2 rounds. Pre-determined number return for R2. R1 FAULTS WIPED — R2 is fresh start.
- **Rounds:** R1 + R2. No JO (R2 IS the winning round).
- **Status-carry:** CARRY-BACK **with R2-wipe exception:** R2 ranking ignores R1 faults. A DNS/WD in R2 means no R2 place — R1 result not carried forward because R1 is wiped.
- **FEI:** Yes — FEI Art 223.2.
- **Stack model:** 2 containers. R1 for all. R2 stacks for returners. Note: the R2 container is semantically "winning round" not "jump-off" — its content isn't JO ties-broken, it's a fresh competition.
- **Method-label fix (SESSION-22):** Previously swapped with method 14. Now corrected.
- **Verified:** Spec + fix. Not explicitly live-tested.

---

## METHOD 8 — dropped placeholder

- **Status:** DROPPED — never observed live. Removed from watcher's method map (SESSION-22).
- **Spec (if needed):** Table II (Faults only, ties NOT broken by time).
- **If seen in wild:** un-drop, research, add here.

---

## Summary — Stack Heights by Method

| Method | Max containers | Stacks when | Status-carry family |
|---|---|---|---|
| 0 (Table III) | 1 | — | SINGLE-ROUND |
| 2 (II.2a) | 2 | R1 clear → JO | R1-HOLDS |
| 3 (2-round + JO) | 3 | fewest cumulative → JO | CARRY-BACK |
| 4 (II.1 Speed) | 1 | — | SINGLE-ROUND |
| 5 (Top Score) | 1 | — | SINGLE-ROUND |
| 6 (IV.1 Optimum) | 1 or 2 | 2-round variant only | SINGLE-ROUND or CARRY-BACK |
| 7 (Timed Eq) | 1 | — | SINGLE-ROUND |
| 9 (II.2d) | **1 w/ divider** | — (one ride, split) | CARRY-BACK |
| 10 (II.2f Stratified) | 2 | top-N per tier | R1-HOLDS |
| 11 (II.2c) | 2 | R1 clear → PH2 | CARRY-BACK (behavioral: PH2-EL keeps PH1) |
| 13 (II.2b Immediate) | 2 | R1 clear → JO (immediate) | R1-HOLDS |
| 14 (Team) | 3 + team layer | standard 3-round | CARRY-BACK |
| 15 (Winning Round) | 2 | top-N return for R2 | CARRY-BACK w/ R2-wipe |

---

## Vendor Transition Behavior (for two-phase methods 9 and 11)

### Farmtek
- Automatic 5-second hold at phase transition.
- Scoreboard shows phase 1 final time during hold.
- Phase 2 clock runs internally during hold.
- UDP stream shows elapsed starting at ~5 when it resumes (not 0). NOT a bug.
- Gap is deterministic (5s).

### TOD (the "T" classType — NOT TIMY; TIMY is dead hardware)
- Operator-gated. Waits for "Send to Next Round" button in Ryegate.
- No automatic timer. Operator can take any amount of time.
- Phase 2 clock anchored to phase 1 trigger TIMESTAMP, not button press — so elapsed stays accurate.
- UDP gap is VARIABLE.
- Watcher's FINISH_LOCK (currently 5s, tuned for Farmtek) may need to be operator-gated for TOD.

### TOD + FEI timing philosophy
- TOD = Time Of Day = one absolute reference clock, all events are timestamps against it.
- FEI standard for decades.
- Our v1.11 heartbeat-as-authority model is a port of this philosophy to the web — Bill's original design intent.
- Raw TOD timestamps only land in .cls at class-end, not in live UDP. Worth archiving for post-class forensics.

---

## Status Code Numeric Fallback (T and J both)

Watcher falls back to numeric codes at cols[21] (R1), [28] (R2), [35] (R3) when text field is empty:

```
1 = EL  (tentative — not yet observed live)
2 = RT  (confirmed — class 212 #6318)
3 = OC  (generic eliminated — text field specifies OC/EL/RF variant)
4 = WD  (confirmed — Farmtek NEVER writes text, numeric only)
5 = RF  (confirmed — class 220 #6116)
6 = DNS (tentative — not yet observed live)
```

Farmtek text position shifts across entries — scan cols[36-39] cluster, not fixed col[38].

---

## Gaps — confirmed NOT FOUND in notes

These are the remaining unknowns. When encountered, capture first, code second.

- Method 10 live example (stratified JO) — spec only
- Method 8 semantics — placeholder, dropped
- Method 5 live example — dropped before observation
- Method 11 H[03]=1/2 distinction live — FEI Art 4.2 vs 4.3 — needs fixture
- Method 14 live test — theory only
- Method 15 live test — theory only
- "Power and Speed" as Bill's verbal terminology — he mentioned this session; maps to Method 11 (II.2c)
- Three-round classes in practice (beyond class 221 at Devon) — only one class on record

---

## When this doc evolves

Edit rules:
- Every method entry has SOURCE citations. Never add a claim without a source.
- When a "NOT FOUND" gap gets filled by a live observation, update the method entry AND remove from gaps list.
- When a behavior changes in Ryegate/Farmtek/TOD firmware, add a DATED note — don't overwrite history.
- Train-stack model applied to every new method — it's the rendering contract v3 display code relies on.

New methods discovered in the wild:
1. Parser logs "unknown scoring method N" as a parse_warning
2. Bill reviews after the show (not during)
3. Research the method spec + live observations
4. Add a new section here with all the structure above
5. Then (and only then) add parser handling

No patching parser code without updating this doc first.

---

## Sources consulted for this document

- `/CLS-FORMAT.md` — lines 129-194 (method spec table), 227-239 (status-carry rules), 270-273 (Method 6 optimum), 388-427 (class 221 live data)
- `SESSION-NOTES-20.txt` — FEI flag integration, hunter multi-round
- `SESSION-NOTES-21.txt` — Method 7 Timed Equitation full implementation, UDP patterns
- `SESSION-NOTES-22.txt` — Method 14/15 swap fix, Method 2 JO-N overlay, methods 5/8 dropped, class 809 Method 2 test
- `SESSION-NOTES-25.txt` — Method 13 classes 23/24/27 status code verification
- `SESSION-NOTES-26.txt` — Method 9 phase transition observation, Farmtek timing
- `SESSION-NOTES-27.txt` — Method 9 UDP log analysis (clean 1-Hz + 5s hold artifact)
- `west-watcher.js` — active method map, flag derivation (lines 760-770, 838-1038)
- **Bill's own explanation (Session 28, 2026-04-18):** Method 9 = II.2d specifically, II.2c = Method 11, Power and Speed as old name for II.2c, two-phase physical flow (gate clock resets), Farmtek 5s hold vs TOD operator-gate, T classType = TOD not TIMY
