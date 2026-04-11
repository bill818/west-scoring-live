# Ryegate Scoring Software — .cls File Format Documentation
# WEST Scoring Live Project
# Last updated: 2026-04-10 (Session 20 — fr=12/16 active in pipeline, fr=14 ribbons,
# Last updated: 2026-04-09 (Session 19 — equitation UDP tags, auto-close 15min,
#   per-round worker stats, display page, show stats/search/weather endpoints)

---

## FILE TYPES

### .cls — Live Class File (PRIMARY DATA SOURCE)
- Located: C:\Ryegate\Jumper\Classes\
- One file per class (named by class number e.g. 221.cls)
- Read with shared access (fs.openSync flag 'r') — never lock this file
- DO NOT use .csv files — they are unreliable snapshots, not real-time

JUMPER write timing:
- File writes after each round is scored (R1, R2/JO, R3)
- Does NOT write while horse is on course — on-course state = jumper UDP {fr}=1

HUNTER write timing — CONFIRMED 2026-03-29:
- File does NOT write when horse goes on course (On Course click)
- File DOES write immediately when score is posted (result entered)
- This means: {fr}=11 INTRO = on course signal, .cls change = score posted
- .cls is authoritative for all hunter scoring — no need to parse FINISH UDP

### tsked.csv — Class Schedule
- Located: C:\Ryegate\Jumper\
- One file per ring
- Updated when operator adds/modifies classes

FORMAT — confirmed 2026-03-31 from live Devon Fall Classic data:
```
Row 0: ShowName,"DateRange"
Row 1+: ClassNum,ClassName,Date(M/D/YYYY),Flag
```

Example:
```
2025 Devon Fall Classic,"September 11-14, 2025"
48,"$1,000SUMMER CLASSIC  METER .90 JUMPER II.2B",9/14/2025,
48C,METER .90 JUMPER Championship,9/14/2025,S
9,"$25,000 DEVON FALL CLASSIC 1.35-1.40m II.2a",9/13/2025,
```

FLAG column values:
- (empty) = normal class
- S = Championship class (hunter only, when finalized)
- JO = Jump Order — display order of go on website

Row order within a date = ring order (the sequence classes run that day).
Classes are listed newest day first in the file.

### config.dat — Ring Configuration
- Located: C:\Ryegate\Jumper\
- Contains FTP path, server IP, show info, UDP ports

---

## CRITICAL: TWO SEPARATE HEADER SCHEMAS — NO CROSSOVER

ClassType (H[00]) determines which schema applies:
  H = Hunter schema
  J = Jumper schema (Farmtek timer — 40 col entries)
  T = Jumper schema (TIMY timer — 85 col entries)
  U = Unformatted (no schema — entry rows have no score columns)

ZERO column crossover between Hunter and Jumper schemas.
Every column from H[02] onward must be interpreted independently per schema.
NEVER assume a column means the same thing across schemas.
J and T share the same HEADER schema — only entry row length differs.
Once formatted as H or J/T, cannot be changed. Schema is locked permanently.

---

## ENTRY ROW LENGTHS:
  Hunter (H):       55 cols
  Farmtek (J):      40 cols (no TIMY timestamp blocks)
  TIMY (T):         85 cols (3 round timestamp blocks cols 37-81)
  Unformatted (U):  14 cols

---

## JUMPER HEADER — CONFIRMED FROM CLASS 221 LIVE SESSION 2026-03-22

### Cols 0-1 (shared with Hunter):
```
H[00] ClassType              H=Hunter, J=Farmtek, T=TIMY, U=Unformatted
H[01] ClassName              text e.g. "1.15m Jumper"
```

### Jumper-specific cols 2+:
### CONFIRMED 2026-04-08 by cycling ALL Ryegate class type settings (USEF + FEI)
```
H[02] ScoringMethodCode      see Scoring Methods below
H[03] ScoringModifier        context-dependent per H[02] — see table below
H[04] RoundsCompleted        increments 0→1→2→3 as each round is scored
H[05] ClockPrecision         0=thousandths (.001), 1=hundredths (.01)
                             CONFIRMED 2026-04-08 by toggling precision setting
                             No whole seconds option observed in Ryegate
H[06] ImmediateJumpoff       1=immediate (2b/2c/2d), 0=clears return (2a)
H[07] R1_FaultsPerInterval   fault points per time interval
                             1.0 = standard, 0.25 = quarter, 0 = no time faults (top score)
H[08] R1_TimeAllowed         TA in seconds (0 for faults converted / top score)
H[09] R1_TimeInterval        seconds per interval e.g. 1, 2, 4
H[10] R2_FaultsPerInterval   same pattern as R1
H[11] R2_TimeAllowed         TA for R2/JO in seconds
H[12] R2_TimeInterval        seconds per interval for R2
H[13] R3_FaultsPerInterval   stale/ignored if class has <3 rounds
H[14] R3_TimeAllowed         stale/ignored if class has <3 rounds
H[15] R3_TimeInterval        stale/ignored if class has <3 rounds
H[16] ?                      always 1 in all tests — purpose unknown
H[17] CaliforniaSplit        0=off, 1=on — CORRECTED 2026-04-08 (was mislabeled IsFEI)
H[18] IsFEI                  True/False — CORRECTED 2026-04-08 (was "always False")
                             FEI classes use same H[02] codes as USEF + H[18]=True
H[19] Sponsor                text field
H[20] ?                      always empty — legacy unused
H[21] CaliSplitSections      numeric, default 2
H[22] PenaltySeconds         seconds added per time fault e.g. 6
H[23] NoRank                 True/False — hides rank on scoreboard
H[24] ?                      always False — legacy unused
H[25] ShowStandingsTime      True/False
H[26] ShowFlags              True/False
H[27] FEI_WD_TiedWithEL      True=WD tied with EL (same placing), False=separate
                             CORRECTED 2026-04-08 (was "always True — legacy unused")
H[28] ShowFaultsAsDecimals   True/False
```

### Scoring Method Codes (H[02]):
### FULLY CONFIRMED 2026-04-08 by cycling ALL Ryegate options (USEF + FEI)
```
 0  = Table III / FEI Table C — Faults Converted (faults → seconds added to time, placed by time only)
 1  = Round + JO, R1 ties UNBROKEN (faults only in R1, fewest return for JO)
 2  = II.2a — Round + JO, tied for fewest faults return (time breaks ties in R1)
 3  = 2 Rounds + JO (R1+R2 faults cumulative, fewest return for JO)
       H[03]=0: ties broken by R1 time, H[03]=1: ties remain tied
 4  = II.1 — Speed (1 round, faults then fastest time)
 5  = Top Score (highest score wins, no time faults)
       H[03]=0: Gamblers Choice, H[03]=1: Accumulator
 6  = IV.1 — Optimum Time (closest to TA-4, faults first then distance)
       H[03]=0: 1-round, H[03]=1: 2-round (JO has optimum)
 7  = Timed Equitation (uses jumper UDP, rider-first display rules)
       H[03]=0: Forced (operator enters placements), H[03]=1: Scored (from scores)
 8  = Table II — Faults only, ties NOT broken by time (time recorded but unused for ranking)
 9  = II.2d — Two-phase, ALL entries advance to PH2, EL in PH2 = EL from ALL phases
10  = II.2f — Stratified JO, pre-determined # return, compete within fault tier only
11  = II.2c — Two-phase, only clears advance to PH2, EL in PH2 keeps PH1 result
       FEI Art 4.2: H[03]=1, H[18]=True — PH1 NOT against clock
       FEI Art 4.3: H[03]=2, H[18]=True — PH1 against clock
13  = II.2b — Immediate JO, only clears advance, no clears = broken by R1 time
14  = Team competition (2 rounds + JO)
       H[03]=0: individual times, H[03]=1: combined times (all riders added)
15  = Winning Round — pre-determined # return, R1 faults WIPED, JO is fresh start
```

### H[03] Scoring Modifier — context depends on H[02]:
```
H[02]=3  (2rnd+JO):   0=break ties by R1 time, 1=remain tied
H[02]=5  (Top Score):  0=Gamblers Choice, 1=Accumulator
H[02]=6  (Optimum):    0=1-round, 1=2-round (JO optimum)
H[02]=7  (Timed EQ):   0=Forced, 1=Scored
H[02]=11 (II.2c/FEI):  1=FEI Art 4.2 (PH1 no clock), 2=FEI Art 4.3 (PH1 clock)
H[02]=14 (Team):       0=individual times, 1=combined times
Others:                0 (default, no modifier)
```

### FEI Classes:
FEI classes use the SAME H[02] scoring method codes as USEF.
The ONLY header difference is H[18]=True (FEI flag).
FEI defaults to H[05]=1 (hundredths precision).

### USEF ↔ FEI Cross-Reference (confirmed 2026-04-08):
```
H[02]  USEF                          FEI                           FEI Article
─────  ────                          ───                           ───────────
 0     Table III (Faults Converted)  Table C                       —
 1     R1+JO (ties unbroken)         R1+JO (ties unbroken)         Art 220.1.1.3
 2     II.2a (fewest faults return)  Round+JO (ties broken)        Art 220.2.1.2
 3/0   2 Rounds+JO (break by R1)    2 Rounds+JO (break by R1)     Art 221.4.1
 3/1   2 Rounds+JO (remain tied)    2 Rounds+JO (remain tied)     Art 221.4.2
 4     II.1 Speed                    Time First Round              Art 220.1.1.1
 5/0   Gamblers Choice               NOT VALID FEI                 —
 5/1   Accumulator                   Accumulator                   Art 229
 6     IV.1 Optimum Time             NOT IN FEI                    —
 8     Table II (faults only)        Table II (faults only)        —
 9     II.2d (two-phase, EL=all)     Two-Phase Special             Art 222.2.3
10     II.2f (stratified JO)         R1+JO (ties unbroken)         Art 220.1.1.3
11/1   II.2c (FEI variant)           Two-Phase PH1 no clock        Art 222.1.4.2
11/2   II.2c (FEI variant)           Two-Phase PH1 with clock      Art 222.1.4.3
13     II.2b (immediate JO)          NOT IN FEI                    —
14     Team                          Nations Cup                   Art 226
15     Winning Round                 Winning Round                 Art 223.2
 7     Timed Equitation              NOT FEI (USEF only)           —
```
NOTE: H[02]/H[03] shown as "H[02]/H[03]" when H[03] matters.
Gamblers Choice, Optimum Time, and II.2b have no FEI equivalent.
Timed Equitation is USEF-only (uses jumper UDP, rider-first display).

NOTE: Two-phase (9) uses TIMY blocks 2 and 3 instead of 1 and 2.

---

## ELIMINATION / STATUS DISPLAY RULES — CONFIRMED 2026-04-08

### Status Code Categories:
```
ELIMINATIONS (display as "EL"):  EL, RO, RF, OC, HF, EX, DQ
  - Dash for place, hide round data for that round
  - Specific codes not shown to viewers (RF=rider fall, HF=horse fall etc.)

PARTIAL (display code as-is):    WD, RT, HC
  - WD = Withdrawn (before entering ring, no round data)
  - RT = Retired (mid-round, may have partial data)
  - HC = Hors Concours (exhibition, not scored for placement)

HIDE ENTIRELY:                   DNS
  - Did Not Start — entry hidden from results

NOTE: Ryegate does NOT send DNF or SC. RT covers "did not finish."
      Ryegate sends HC not SC for Hors Concours.
```

### Jumper Elimination Rules — per scoring method:
```
Three patterns:

SINGLE ROUND (H[2]=0,4,5,6,7,8):
  Any status in R1 = no place, no data, show code. One round, one chance.

CARRY-BACK (H[2]=3,9,14):
  R1 status = no place, hide all
  R2 status = no place, carry-back wipes all (show R1 data for context, R2 shows code)
  JO status = place valid (on R1+R2), show R1+R2, JO shows code

R1-HOLDS (H[2]=1,2,10,11,13,15):
  R1 status = no place, hide all
  R2/PH2 status = place valid (on R1), show R1, R2 shows code
  JO status = place valid (on R1), show R1, JO shows code
  EXCEPTION: H[2]=15 (Winning Round) — JO status = no place (R1 wiped for JO)
```

### Hunter Elimination Rules — ALL scoring methods:
```
ONE rule for ALL hunter classes (H[2]=0,1,2,3):
Earlier rounds ALWAYS hold. No carry-back. No exceptions.

  R1 status = no place, no score, show code
  R2 status = place on R1, show R1 score, R2 shows code
  R3 status = place on R1+R2, show R1+R2 scores, R3 shows code
```

---

### Optimum Time Classes (Method 6 / Table IV.1) — CONFIRMED 2026-04-03:
```
Method 6 = Table IV.1 = Optimum Time class
Optimum Time = TA - 4 seconds (HARDCODED RULE, not in header)
Example: TA=64 → Optimum=60

Scoring: faults ascending, then abs(time - optimum) ascending
  - Horse at 59.5s and 60.5s are equally ranked (both 0.5s from optimum)
  - Being under optimum is the same penalty as being over
  - Ryegate handles the sorting — places in .cls are authoritative

Display:
  - Show "Optimum Xs" under TA on live clock
  - Show distance from optimum per entry: "+1.500s from opt" or "-0.500s from opt"
  - Green highlight when within 2s of optimum

Method 4 (Table II.1) = standard speed class — fastest time wins, NOT optimum
  - Same single-round format but sorted by faults then fastest time
  - No optimum calculation needed
```

### Time Fault Formula — LOCKED IN:
```
TimeFaults = ceil(secondsOver / H[09]) × H[07]
PenaltySec = ceil(secondsOver / H[09]) × H[22]
TotalTime  = RawTime + PenaltySec

Website standard class:
  const secondsOver = rawTime - ta;
  const intervals   = secondsOver > 0 ? Math.ceil(secondsOver / timeInterval) : 0;
  const timeFaults  = intervals * faultsPerInterval;
  const penaltySec  = intervals * penaltySeconds;
  const totalTime   = rawTime + penaltySec;
```

---

## JUMPER ENTRY COLUMNS — TIMY (T) — 85 cols — FULLY CONFIRMED 2026-03-22

Source: Class 221, 1.15m Jumper, ScoringMethod=3, live scored session.

### Identity cols 0-12 (shared across all class types):
```
col[00] EntryNum
col[01] HorseName
col[02] RiderName
col[03] ?                   always empty — unknown purpose
col[04] CountryCode         FEI 3-letter code e.g. USA, GER, BRA
                            CONFIRMED 2026-03-31 from class 18 entry 106
                            Only populated when operator enters nationality
col[05] OwnerName
col[06] Sire
col[07] Dam
col[08] City                e.g. LEBANON, WELLINGTON
col[09] State               US state code (NJ, PA, FL) or country/province (THE NETHER, QC)
col[10] HorseFEI            FEI/USEF passport number e.g. 107XS23, 105MU40
col[11] RiderFEI            FEI/USEF number e.g. 10322256, 10080008
col[12] OwnerFEI            FEI/USEF number — rarely populated, assumed by pattern
```

### Scoring cols 13-35:
```
col[13] RideOrder           order horse goes in ring (1-N) ✓
col[14] OverallPlace        updates live as horses finish ✓

R1 block:
col[15] R1Time              raw elapsed seconds e.g. 32.12 ✓
col[16] R1PenaltySeconds    seconds added for time faults e.g. 6 ✓
col[17] R1TotalTime         R1Time + R1PenaltySeconds e.g. 38.12 ✓
col[18] R1TimeFaults        fractional time faults e.g. 1.25 ✓
col[19] R1JumpFaults        jump fault points (4 per rail standard) ✓
col[20] R1TotalFaults       R1TimeFaults + R1JumpFaults e.g. 5.25 ✓
col[21] ?                   always 0 — watch at HITS (possibly R1Place)

R2 block:
col[22] R2Time              raw elapsed seconds ✓
col[23] R2PenaltySeconds    seconds added for time faults ✓
col[24] R2TotalTime         R2Time + R2PenaltySeconds ✓
col[25] R2TimeFaults        fractional time faults ✓
col[26] R2JumpFaults        jump fault points ✓
col[27] R2TotalFaults       R2TimeFaults + R2JumpFaults ✓
col[28] ?                   always 0 — watch at HITS (possibly R2Place)

R3/JO block:
col[29] R3Time              raw elapsed seconds ✓
col[30] R3PenaltySeconds    seconds added for time faults ✓
col[31] R3TotalTime         R3Time + R3PenaltySeconds ✓
col[32] R3TimeFaults        fractional time faults ✓
col[33] R3JumpFaults        jump fault points ✓
col[34] R3TotalFaults       R3TimeFaults + R3JumpFaults ✓
col[35] StatusCode          EL=Eliminated, RF=RiderFall, WD=Withdrawn,
                            SC=Schooling, DNS=DidNotStart, DNF=DidNotFinish
                            0 or empty = normal completion
                            NOTE: Not confirmed in TIMY yet — confirm at HITS
```

### TIMY timestamp block cols 36-84:
```
col[36] HasGone             1 = competed in at least R1 ✓

R1 timestamp block (cols 37-51):
col[37] R1_CDStart          TOD e.g. 12:29:04
col[38] R1_CDPause1
col[39] R1_CDResume1
col[40] R1_CDPause2
col[41] R1_CDResume2
col[42] R1_CDPause3
col[43] R1_CDResume3
col[44] R1_RideStart        TOD e.g. 12:29:15.2700000 ✓
col[45] R1_RidePause1
col[46] R1_RideResume1
col[47] R1_RidePause2
col[48] R1_RideResume2
col[49] R1_RidePause3
col[50] R1_RideResume3
col[51] R1_RideEnd          TOD e.g. 12:29:47.3900000 ✓

R2 timestamp block (cols 52-66):
col[52] R2_CDStart          ✓
col[53-58] R2 CD pause/resume pairs
col[59] R2_RideStart        ✓
col[60-65] R2 ride pause/resume pairs
col[66] R2_RideEnd          ✓

R3 timestamp block (cols 67-81):
col[67] R3_CDStart          ✓
col[68-73] R3 CD pause/resume pairs
col[74] R3_RideStart        ✓
col[75-80] R3 ride pause/resume pairs
col[81] R3_RideEnd          ✓

col[82-84] unknown — 3 trailing cols to make 85 total, always empty
```

### Class 221 scored entries — actual values from live log:
```
#2104 ALESCO M Z (1st to go, 6 faults, no JO):
  col[13]=1 col[14]=5 col[15]=32.12 col[16]=6 col[17]=38.12
  col[18]=1.25 col[19]=4 col[20]=5.25
  col[36]=1 col[37]=12:29:04 col[44]=12:29:15.27 col[51]=12:29:47.39

#2226 FEDERAL JUSTICE (2nd, clear R1, JO with 1 time fault + 1 rail):
  col[13]=2 col[14]=3 col[15]=21.37 col[17]=21.37
  col[22]=28.41 col[23]=6 col[24]=34.41
  col[25]=1 col[26]=4 col[27]=5
  col[36]=1 col[37]=12:33:04 col[44]=12:33:07.33 col[51]=12:33:28.70
  col[52]=12:35:20 col[59]=12:35:23.11 col[66]=12:35:51.52

#3289 KTS VALVERDE (3rd, 3 rails in R1, no JO):
  col[13]=3 col[14]=6 col[15]=9.84 col[17]=9.84
  col[19]=12 col[20]=12
  col[36]=1 col[37]=12:33:35 col[44]=12:33:40.53 col[51]=12:33:50.37

#3699 SPORTSFIELD MR GREY (4th, 1 rail in R1, no JO):
  col[13]=4 col[14]=4 col[15]=16.76 col[17]=16.76
  col[19]=4 col[20]=4
  col[36]=1 col[37]=12:34:05 col[44]=12:34:07.99 col[51]=12:34:24.75

#3736 DIABLO Z (5th to go, clear R1 + R2 + R3, 1st place):
  col[13]=5 col[14]=1 col[15]=8.02 col[17]=8.02
  col[22]=8.15 col[24]=8.15
  col[29]=20.28 col[31]=20.28 col[32]=3 col[33]=4 col[34]=7
  col[36]=1 col[37]=12:34:37 col[44]=12:34:41.01 col[51]=12:34:49.03
  col[52]=12:36:02 col[59]=12:36:04.32 col[66]=12:36:12.47
  col[67]=12:37:02 col[74]=12:37:05.22 col[81]=12:37:25.50

#4190 CASCORD VA (6th, clear R1 + R2 + R3, 2nd place):
  col[13]=6 col[14]=2 col[15]=12.74 col[17]=12.74
  col[22]=11.47 col[24]=11.47
  col[29]=11.38 col[31]=11.38
  col[36]=1 col[37]=12:34:53 col[44]=12:34:59.97 col[51]=12:35:12.71
  col[52]=12:36:20 col[59]=12:36:21.34 col[66]=12:36:32.81
  col[67]=12:37:34 col[74]=12:37:51.74 col[81]=12:38:03.12
```

### Score Detection — TIMY:
```
R1 complete: col[36]=1 (HasGone) AND col[15] non-zero
R2 complete: col[22] non-zero
R3 complete: col[29] non-zero
Has time faults:  col[18] non-zero (R1), col[25] (R2), col[32] (R3)
Has jump faults:  col[19] non-zero (R1), col[26] (R2), col[33] (R3)
Eliminated etc:   col[35] non-zero/non-empty (confirm values at HITS)
```

---

## JUMPER ENTRY COLUMNS — FARMTEK (J) — 40 cols — CONFIRMED

Source: Class 221 snapshot 2026-03-21, 1 competed entry with RF.

### Identity cols 0-12: same layout as TIMY above (col[04]=CountryCode, col[10-12]=FEI).

### Scoring cols 13-39:
```
col[13] (empty/0)           NOTE: RideOrder NOT stored at col[13] for Farmtek
col[14] OverallPlace        ✓
col[15] R1Time              ✓
col[16] R1PenaltySeconds    ✓
col[17] R1TotalTime         ✓
col[18] R1TimeFaults        ✓ (fractional)
col[19] R1JumpFaults        ✓
col[20] R1TotalFaults       ✓
col[21] ?                   always 0
col[22] R2Time              ✓
col[23] R2PenaltySeconds    ✓
col[24] R2TotalTime         ✓
col[25] R2TimeFaults        ✓
col[26] R2JumpFaults        ✓
col[27] R2TotalFaults       ✓
col[28] ?                   always 0
col[29] R3Time              ✓
col[30] R3PenaltySeconds    ✓
col[31] R3TotalTime         ✓
col[32] R3TimeFaults        ✓
col[33] R3JumpFaults        ✓
col[34] R3TotalFaults       ✓
col[35] RideOrder           stored HERE for Farmtek (not col[13]) ✓
                            e.g. value 3 = 3rd to go
col[36] HasGone             1 = competed ✓
col[37] (empty)
col[38] (empty)
col[39] StatusCode          RF=RiderFall, EL=Eliminated etc ✓ CONFIRMED
                            empty = normal completion
```

### Class 221 Farmtek example (ALESCO M Z, all 3 rounds, RF in R3):
```
col[14]=1  col[15]=79.054  col[17]=79.054
col[18]=0.1  col[20]=0.1
col[22]=70.678  col[24]=70.678  col[25]=0.2  col[26]=4  col[27]=4.2
col[35]=3(RideOrder)  col[36]=1(HasGone)  col[39]=RF(StatusCode)
```

### Score Detection — Farmtek:
```
R1 complete: col[36]=1 AND col[15] non-zero
R2 complete: col[22] non-zero
R3 complete: col[29] non-zero
StatusCode:  col[39] non-empty
```

---

## HUNTER HEADER COLUMNS — CONFIRMED FROM LIVE TOGGLE TEST 2026-03-22

WARNING: Zero crossover with Jumper schema.

```
H[00] ClassType              H
H[01] ClassName              text

H[02] ClassMode              CONFIRMED 2026-04-06 by cycling all 4 Ryegate class type settings:
                             0=Over Fences (standard hunter, scored or forced)
                             1=Flat (no jumps, scored)
                             2=Derby (auto-set when Derby selected)
                             3=Special (custom multi-round, Normal or Team)

H[03] NumRounds              CONFIRMED 2026-04-10 on class 925 Special (h[3]
                             cycled 1 → 3 with class round count). Values: 1, 2, or 3.

H[04] CurrentRound           CONFIRMED 2026-04-10 by snapshot diff on class 925 Special:
                             1 = R1 view active in Ryegate
                             2 = R2 view active in Ryegate
                             3 = R3 view active in Ryegate
                             N+1 (e.g. 4 in a 3-round class) = "Overall" view
                             Tracks which round tab the operator currently has
                             selected. NOT a measure of "rounds scored" — it
                             reflects what the operator is looking at right now.
                             Useful as a signal for live on-course display: when
                             a horse is in the ring, the round-tab usually matches
                             what they're about to ride.
                             Pipeline: live.html uses this to label the on-course
                             banner round (R1/R2/R3); falls back to inferred or
                             suppressed when h[4] > numRounds (Overall view).

H[05] ScoringType            CONFIRMED 2026-04-06 by cycling scoring type settings:
                             0=Forced (operator manually enters placements, no computed scores)
                             1=Scored (places derived from judge scores, Total method)
                             2=Hi-Lo (drop highest + lowest judge scores, average the rest)
                             NOTE: was mislabeled IsFlat — corrected 2026-04-06

H[06] ScoreMethod            CONFIRMED 2026-04-06:
                             0=Total (sum all judge scores)
                             1=Average (average all judge scores)
                             NOTE: also 1 for WCHR Derby Spec (H[37]=8) — may have dual meaning

H[07] NumJudges              number of judges / score inputs — 1 to 5+ ✓
                             CONFIRMED 2026-04-06 by setting from 1 to 5
                             Auto-adjusts per derby sub-type for derbies
                             NOTE: was labeled NumScores — clarified to NumJudges 2026-04-06

H[08] RibbonCount            CONFIRMED 2026-04-10 — TRUE ribbon count (matches the
                             "12 ribbons" setting in Ryegate). Set to 12 for derbies
                             and Specials, 8 for standard hunter classes.
                             Earlier doc claimed H[04] was the ribbon count — that
                             was wrong. H[08] is the only ribbon count field.

H[09] SBDelay                numeric scoreboard delay (tested at value 4)

H[10] IsEquitation           True/False ✓
H[11] IsChampionship         True/False ✓
H[12] IsJogged               True/False ✓
H[13] OnCourseSB             True/False ✓
H[14] IgnoreSireDam          True/False ✓
H[15] PrintJudgeScores       True/False ✓
H[16] ReverseRank            True/False ✓

H[17] CaliforniaSplit        True/False ✓ (confirmed — flips True when Split enabled)
                             NOTE: Watcher label "RunOff" is wrong for hunter

H[18] R1TieBreak             0=LeaveTied, 1-N=ByJudgeN ✓
H[19] R2TieBreak             0=LeaveTied, 1-N=ByJudgeN ✓
H[20] R3TieBreak             0=LeaveTied, 1-N=ByJudgeN ✓
H[21] OverallTieBreak        0=LeaveTied, 20=ByOverallScore ✓

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
H[37] DerbyType              FULLY CONFIRMED 2026-04-03 by cycling all types:
                             0=International        (2 judges, ShowAllRounds=True)
                             1=National             (1 judge,  ShowAllRounds=False)
                             2=National H&G         (1 judge,  ShowAllRounds=True)
                             3=International H&G    (2 judges, ShowAllRounds=True)
                             4=USHJA Pony Derby     (1 judge,  ShowAllRounds=False)
                             5=USHJA Pony Derby H&G (1 judge,  ShowAllRounds=True)
                             6=USHJA 2'6 Jr Derby   (1 judge,  ShowAllRounds=False)
                             7=USHJA 2'6 Jr Derby H&G (1 judge, ShowAllRounds=True)
                             8=WCHR Derby Spec      (1 judge,  H[06]=1, ShowAllRounds=False)
                             H&G variants always set ShowAllRounds=True
                             Only International (0,3) uses 2 judges
                             H[06]=1 only for WCHR (8), all others H[06]=0
H[38] IHSA                   True/False ✓
H[39] RibbonsOnly            True/False ✓
```

### Derby Auto-changes (when Derby selected):
```
H[02] → 2 (HiLo)
H[07] → varies by derby sub-type
H[08] → 12
H[35] → True (standard derbies) or False (H&G variants)
H[39] → False (RibbonsOnly auto-cleared)
```

### ShowAllRounds defaults per derby type:
```
International (1): True  | National (2): True
NatlHG (3): False        | IntlHG (4): False
USHJAPony (5): True      | USHJAPonyHG (6): False
USHJA26Jr (7): True      | USHJA26JrHG (8): False
H&G variants = False, Standard derbies = True. Operator can override.
```

### Tie Break encoding:
```
0  = Leave Tied
1-N = By Judge N (literal judge number)
20  = By Overall Score
```

### STILL UNCERTAIN — Hunter Header:
```
H[06] — changes for H&G and Special, label unknown (possibly IsHuntAndGo)
H[07] — auto-adjusts per derby type, full mapping incomplete
H[09] — SBDelay, only tested at value 4
H[37]=9 — WCHR Spec not directly confirmed
```

---

## HUNTER ENTRY COLUMNS — CONFIRMED (2026-03-20, 97-class analysis)

Hunter entries are always 55 cols.

### Identity cols 0-12: same layout as Jumper — see above.
```
col[00]-col[12] identical across H, J, T types
col[04] = CountryCode (confirmed), col[10-12] = FEI numbers
```

### Standard single-judge single-round O/F:
```
col[13] GoOrder
col[14] CurrentPlace         live standing, updates after each horse
col[15] R1Score              judge score (45-95 typical)
col[42] R1Total              same as R1Score (no bonus)
col[45] CombinedTotal        same as R1Total
col[49] HasGone_R1           1=competed
col[52] StatusCode           EX=Excused, RF=RiderFall, OC=OffCourse
```

### Non-derby scored (H[2]=0 or 3, H[5]=1 or 2) — 1 to 7+ judges, 1-3 rounds:
### CONFIRMED 2026-04-08 (7 judges, 2 rounds, class 1002)
### CONFIRMED 2026-04-10 — R3 column map from class 925 Special, 2 judges
```
Per-judge scores are SEQUENTIAL — no hiopt, no bonus, no mirrors.
R1: col[15 + j] where j = 0..numJudges-1   (J1=col[15], J2=col[16], ... J7=col[21])
R2: col[24 + j] where j = 0..numJudges-1   (J1=col[24], J2=col[25], ... J7=col[30])
R3: col[33 + j] where j = 0..numJudges-1   (J1=col[33], J2=col[34], ... J7=col[39])
col[42] R1Total              sum of all judge R1 scores
col[43] R2Total              sum of all judge R2 scores
col[44] R3Total              sum of all judge R3 scores ★ NEW
col[45] CombinedTotal        R1Total + R2Total (+ R3Total when 3 rounds)
                             SAME caveat as derbies: only correct when operator
                             views Overall in Ryegate. Compute it ourselves
                             rather than trust col[45] mid-class.
col[46] R1_NumericStatus
col[47] R2_NumericStatus
col[48] R3_NumericStatus     ★ NEW
col[49] HasGone_R1
col[50] HasGone_R2
col[51] HasGone_R3           ★ NEW
col[52] StatusCode_R1
col[53] StatusCode_R2
col[54] StatusCode_R3        ★ NEW

NOTE: This layout is COMPLETELY DIFFERENT from derby layout.
      Derby interleaves hiopt/base/bonus/mirrors.
      Non-derby is straight sequential scores — clean +9 stride per round.
      H[2] determines which layout to use (0=non-derby OF, 2=derby, 3=Special).
      Special classes use this same non-derby layout but support 1-3 rounds.
      Maximum 7 judges confirmed. cols 22-23 unused (padding between R1 and R2);
      cols 31-32 unused (padding between R2 and R3); cols 40-41 unused (padding
      between R3 block and totals at col[42-45]).
```

### Two-round classic (1 judge, 2 rounds — legacy reference):
```
col[13] GoOrder
col[14] CurrentPlace
col[15] R1Score              (= J1 score when 1 judge)
col[24] R2Score              (= J1 R2 score when 1 judge)
col[42] R1Total
col[43] R2Total
col[45] CombinedTotal        R1+R2
col[49] HasGone_R1           1=R1 only (scratched before R2)
col[50] HasGone_R2           1=completed both rounds
col[52] StatusCode_R1
col[53] StatusCode_R2
```

### International Derby (2 judges, 2 rounds, high options + handy):
### FULLY CONFIRMED 2026-04-03 from class 1001
```
col[13] GoOrder
col[14] CurrentPlace
col[15] R1_HighOptionsTaken
col[16] Judge1_R1_BaseScore
col[17] R1_HighOptionsTaken  (mirrors col[15])
col[18] Judge2_R1_BaseScore
col[24] R2_HighOptionsTaken
col[25] Judge1_R2_BaseScore
col[26] Judge1_R2_HandyBonus (0-10)
col[27] R2_HighOptionsTaken  (mirrors col[24])
col[28] Judge2_R2_BaseScore
col[29] Judge2_R2_HandyBonus (0-10)
col[42] R1Total              = (J1base + hiOpt) + (J2base + hiOpt)
col[43] R2Total              = (J1base + hiOpt + handy) + (J2base + hiOpt + handy)
col[45] CombinedTotal        = R1Total + R2Total
         * ONLY CORRECT after operator views Overall in Ryegate
         * While viewing R1 or R2, col[45] shows THAT round's total only
col[46] R1_NumericStatus     0=normal, 2=incident, 3=retired
col[47] R2_NumericStatus     same values
col[49] HasGone_R1
col[50] HasGone_R2
col[52] R1_TextStatus        RF/HF/EL/OC/DNS (empty for RT)
col[53] R2_TextStatus        same (empty for RT)
```

### National Derby (1 judge, 2 rounds, high options + handy):
### CONFIRMED 2026-04-03 from class 1000
```
col[13] GoOrder
col[14] CurrentPlace
col[15] R1_HighOptionsTaken
col[16] Judge1_R1_BaseScore
col[42] R1Total              = base + hiOpt
col[24] R2_HighOptionsTaken
col[25] Judge1_R2_BaseScore
col[26] Judge1_R2_HandyBonus (0-10) — NOT CONFIRMED for National, was 0 in test
col[43] R2Total              = base + hiOpt (+ handy if applicable)
col[45] CombinedTotal        (same Overall-view caveat as International)
col[46] R1_NumericStatus
col[47] R2_NumericStatus
col[49] HasGone_R1
col[50] HasGone_R2
col[52] R1_TextStatus
col[53] R2_TextStatus
```

### Derby Type Map — FULLY CONFIRMED 2026-04-03:
```
H[37]=0  International           (2 judges, ShowAllRounds=True)
H[37]=1  National                (1 judge,  ShowAllRounds=False)
H[37]=2  National H&G            (1 judge,  ShowAllRounds=True)
H[37]=3  International H&G       (2 judges, ShowAllRounds=True)
H[37]=4  USHJA Pony Derby        (1 judge,  ShowAllRounds=False)
H[37]=5  USHJA Pony Derby H&G    (1 judge,  ShowAllRounds=True)
H[37]=6  USHJA 2'6 Jr Derby      (1 judge,  ShowAllRounds=False)
H[37]=7  USHJA 2'6 Jr Derby H&G  (1 judge,  ShowAllRounds=True)
H[37]=8  WCHR Derby Spec         (1 judge,  H[06]=1, ShowAllRounds=False)

H&G variants always set H[35] ShowAllRounds=True
Only International (0,3) uses 2 judges (H[07]=2)
All others use 1 judge (H[07]=1)
```

### Combined Total Caveat:
```
col[45] CombinedTotal is ONLY accurate when operator views Overall in Ryegate.
While viewing R1 or R2, col[45] reflects that round's total only.
For reliable combined: compute R1total[42] + R2total[43] ourselves.
```

### Score Detection — Hunter:
```
Has competed:    col[49]=='1' OR col[50]=='1'
Eliminated:      col[52] non-empty
Standard score:  col[49]=='1' AND col[15] non-zero
Classic score:   col[50]=='1' AND col[15] AND col[24] non-zero
```

### Hunter Status Code System — CONFIRMED 2026-04-03:
```
col[46]: R1 numeric status code
         0 = Normal completion
         1 = DNS (Did Not Start)
         2 = EL (Eliminated — covers RF, HF, EL, OC generically)
         3 = RT (Retired/Voluntary withdrawal)
         4 = WD (Withdrawn)
         5 = RF (Rider Fall — specific)
         6 = OC (Off Course — specific)
         7 = MR (?)
         8 = HC (Hors Concour)
         Worker maps: {'1':'DNS','2':'EL','3':'RT','4':'WD','5':'RF','6':'OC','7':'MR','8':'HC'}

col[47]: R2 numeric status code (same values as col[46])
         0 = Normal, 2 = Abnormal, 3 = RT
         CONFIRMED from class 1001 entry 113 (retired in R2)

col[52]: R1 text status code
         RF=Rider Fall, HF=Horse Fall, EL=Eliminated
         OC=Off Course, DNS=Did Not Start
         DOES NOT WRITE for RT/Retired — use col[46]=3 as fallback
         * May be sticky — doesn't always clear on status change in Ryegate

col[53]: R2 text status code (same values as col[52])
         Same RT caveat — doesn't write text, use col[47]=3 as fallback

Display logic:
  1. Check text code (col[52] R1 / col[53] R2) — use if present
  2. If empty, check numeric (col[46] R1 / col[47] R2):
     - 2 = show as "EL" (generic — text code would have been more specific)
     - 3 = show as "RT" (retired — text code never writes for this)
  3. If both empty/zero = normal completion
```

### Hunter hasGone Logic — CONFIRMED 2026-04-03:
```
hasGone flag (col[49]/col[50]) is NOT reliable alone:
  - DNS entries have hasGone=1 but no scores
  - Accidental toggles can set hasGone=1 with no data

Correct detection (waterfall):
  R1 competed = hasGone[49]=1 AND (score[15]>0 OR R1total[42]>0 OR status[52] non-empty OR col[46]>0)
  R2 competed = hasGoneR2[50]=1 OR R2score[24]>0 OR R2total[43]>0 OR status[53] non-empty

If hasGone=1 but no scores AND no status code → treat as NOT gone (accidental toggle)
If hasGone=0 but scores present → treat as gone (manual entry)
```

---

## TIMY TIMESTAMP FORMAT

Format: HH:MM:SS or HH:MM:SS.NNNNNNN
00:00:00 = not used / round not run

Elapsed calculation:
  Elapsed = (RideEnd - RideStart) - sum(all RidePause/RideResume durations)

Two-phase (ScoringMethod=9):
  TIMY: Phase 1 uses R1 block, Phase 2 uses R2 block (CONFIRMED 2026-04-04 from class 18)
  Farmtek: May use R2/R3 blocks instead — unconfirmed, possibly legacy behavior

---

## FARMTEK TIMING NOTES

Farmtek = optical beam timing. No TOD timestamps.
Cols 37-81 all 00:00:00 for Farmtek (J) classes.
HasGone (col[36]=1) is the only on-competed indicator for Farmtek.
RideOrder stored at col[35] not col[13] for Farmtek.

---

## TSKED.CSV STRUCTURE
```
Row 1:  ShowName, ShowDates
Row 2+: ClassNum, ClassName, Date, Flag
```
Flag: S=Scored/Finished (hunter classes, indicates results are finalized),
      JO=Jump Order (show order of go on website),
      (blank)=normal class
      NOTE: S is NOT championship — championship is H[11] IsChampionship in the .cls header
      Confirmed 2026-03-31

---

## CONFIG.DAT STRUCTURE

### CRITICAL CAVEAT — config.dat is partially in-memory cached:
Confirmed 2026-04-11 by toggling fields and observing file mtime/contents:

Ryegate reads config.dat at startup, holds **every** field in memory while
running, and writes back to disk on **specific events**. Not all changes
trigger a write.

**Triggers for config.dat write:**
- ✅ Changing hardware settings (UDP port, serial port, etc.) — flushes
  the ENTIRE file (whole in-memory snapshot) the moment the operator
  applies the change
- ✅ Clean exit of Ryegate — final flush of in-memory state
- ❌ Toggling Live Scoring on/off — in-memory ONLY, no flush
- ❌ Crashing — in-memory state is LOST

Because hardware-change writes flush the whole file, they side-effect any
other in-memory state at the time. So if the operator turned Live Scoring
off then changed the UDP port, the new file would show BOTH the new port
AND col[8]=False — even though the Live Scoring toggle alone wouldn't
have triggered a write.

**Useful implications for the watcher:**
- UDP port is read once at watcher startup (col[1]). The watcher CAN poll
  config.dat for mtime changes — when it ticks, re-read and pick up the
  new port without a restart. (Not yet implemented; tracked in the
  desktop watcher UI work.)
- Live Scoring toggle (col[8]) is NOT reliable for runtime state. It only
  reflects what Ryegate flushed last. For runtime embargo control we need
  a separate mechanism (desktop watcher button or admin page toggle).
- "Buttons not sticking after a crash" — confirmed by Bill — is exactly
  this: in-memory toggles never made it to disk before the crash.

First line comma-separated:
```
Col 0:  SerialPort         "COM7" etc
Col 1:  UDPPort            scoreboard port e.g. 29711
                           ★ STALE AT RUNTIME — see caveat above
Col 2:  "FDS"
Col 3:  ServerIP           Ryegate FTP server IP
Col 4:  FTPPath            "/SHOWS/HITS/.../r1" — ring from /r1, /r2 etc
Col 5:  FTPUser
Col 6:  FTPPassword
Col 7:  ?                  always True in tests so far
Col 8:  LiveScoring        True/False — confirmed 2026-04-11 by toggling
                           in Ryegate UI then clean-exiting Ryegate.
                           ★ STALE AT RUNTIME — see caveat above.
                           For runtime embargo control we need a separate
                           mechanism (desktop watcher button writing its
                           own flag, admin page toggle, etc.)
Col 24: ShowURLSlug        Ryegate back office ID — NOT reliable as show slug
                           Use config.json slug set by operator instead
```

UDP Ports:
```
Scoreboard port: config.dat col[1]
Live data port:  scoreboardPort - 496 (locked by Ryegate)
```

---

## UDP PROTOCOL

### CRITICAL: TWO COMPLETELY SEPARATE UDP SCHEMAS
Hunter and jumper UDP packets are entirely different systems.
NEVER assume a tag means the same thing across both.
Detection: `{fr}` frame number determines which schema applies.

```
{fr}=0      → Clear scoreboard — operator blanked the display (confirmed 2026-03-30)
             Packet: {RYESCR}{fr}0{1}  — ignore, no action needed
{fr}=1      → Jumper packet
{fr}=11-16+ → Hunter packet
```

---

### JUMPER UDP — CONFIRMED

Format: `{RYESCR}{fr}1{tag}value{tag}value...`

Jumper uses ONE frame always (`{fr}=1`). Fields toggle on/off per phase.
Phase is inferred from which fields are populated — NOT from frame number.

```
{fr}  always 1 for jumper
{1}   entry number
{2}   horse name
{3}   rider name
{8}   rank/place — FINISH signal (strip "RANK " prefix)
{13}  time allowed (strip "TA: " prefix)
{14}  jump faults (strip "JUMP " prefix)
{15}  time faults (strip "TIME " prefix)
{17}  elapsed seconds — ONCOURSE signal
{18}  TTB time to beat (unreliable, disappears)
{23}  countdown — CD signal (negative e.g. "-44")
```

Phase Detection (inferred from field presence):
```
IDLE      no active horse
INTRO     {1} present, no {23}/{17}/{8}
CD        {23} countdown present
ONCOURSE  {17} elapsed present, no {8}
FINISH    {8} rank present
```

Clock stop detection: 2.5s timer — if {17} stops incrementing → CLOCK_STOPPED event.
CD stop detection: 2.5s timer — if {23} stops changing → CD_STOPPED event.

UDP Collision Detection: REMOVED 2026-03-22.
Watcher trusts all UDP on configured port. Operator handles hardware collisions visually.

---

### HUNTER UDP — CONFIRMED 2026-03-23/29

Format: `{RYESCR}{fr}[11-16]{tag}value{tag}value...`

Hunter uses MULTIPLE frames. Each frame = a distinct display page/mode.
Frame number is the primary discriminator — not field presence.

#### CRITICAL ARCHITECTURE DECISION — 2026-03-29 (refined 2026-04-10):
Hunter UDP serves TWO purposes:
  1. Detecting that a horse is ON COURSE (fr=11 → ON_COURSE event)
  2. Detecting "Display Scores" button press (fr=12/16 → FINISH event)
Everything else comes from the .cls file.

The .cls file DOES NOT update when a horse goes on course.
The .cls file DOES update when a score is posted, BUT fs.watch can lag the
UDP frame by hundreds of ms — so on Display Scores we force a fresh read of
the selected .cls file and post that immediately, before the FINISH event.
This avoids the live page briefly showing stale (R1-only) data right after
the operator presses Display Scores.

The fr=12/16 handler in west-watcher.js:
  1. Reads {1} entry, {2} horse, {3} rider, {8} "RANK: N" from the UDP frame
  2. Force-reads the selected class .cls file off disk
  3. Posts /postClassData with the fresh content (so worker recomputes)
  4. Posts /postClassEvent { event: 'FINISH', entry, horse, rider, rank }

The live page gates score rendering on phase: ONCOURSE shows intro only,
FINISH shows the full judge grid. This matches operator expectation that
"Display Scores" is the deliberate trigger for showing scores publicly.

#### Frame map — confirmed:
```
{fr}=0    → CLEAR — scoreboard wiped, post CLEAR_ONCOURSE
{fr}=1    → Jumper packet (completely separate schema)
{fr}=11   → Hunter INTRO — horse goes on course (all hunter class types)
{fr}=12   → Hunter DISPLAY SCORES — REGULAR HUNTER (small fields, per-judge scores)
            → Watcher: force fresh .cls re-read + post FINISH event
{fr}=14   → RESULTS DISPLAY — forced/flat ribbon announcement (one entry per frame)
            → Watcher: post HUNTER_RESULT event (accumulating list)
{fr}=13   → Hunter STANDINGS — between-rounds scoreboard view of current
            placings (e.g., between R1 and R2 of a derby). Currently
            IGNORED by the pipeline — .cls is already authoritative for
            standings and the website always shows them. No trigger
            currently needed.
{fr}=15   → Hunter JOG / STANDBY — operator shows this between actions
            (e.g., during a jog for soundness, or as a generic standby
            graphic between Display Scores presses). Currently IGNORED by
            the pipeline. Could trigger a "JOG IN PROGRESS" or "STANDBY"
            indicator on the live/display pages if we want one later.
{fr}=16   → Hunter DISPLAY SCORES — DERBY (large fields for hi-opt + bonus)
            → Watcher: force fresh .cls re-read + post FINISH event
```

#### Hunter INTRO packet ({fr}=11) — THE ONLY HUNTER UDP WE ACT ON:

Frame 11 cycles between two page layouts:

Page A — horse/rider/owner:
```
{1}   entry number  ← READ THIS
{2}   horse name    ← READ THIS
{3}   rider name    ← READ THIS (may change if rider swap)
{4}   owner         ← READ THIS (free bonus)
{5}   unknown (empty)
{14}  H:XX.XXX = current class HIGH score (NOT this horse's score)
{15}  empty
{17}  scoreboard message text ← NOT elapsed time, NOT a clock signal
      IGNORE for phase detection — hunters have no running clock
```

Page B — pedigree (same {fr}=11, different tags):
```
{1}   entry number
{2}   horse name
{18}  sire name
{19}  "X" — breeding nomenclature filler (scoreboard shows "Dam X Sire")
{20}  dam name
```

Example Page A: `{RYESCR}{fr}11{1}3448{2}BALLPARK{3}TATUM BOOS{4}MARY EUFEMIA{5}{14}{15}{17}SB message`
Example Page B: `{RYESCR}{fr}11{1}3448{2}BALLPARK{18}ULYSS MORINDA{19}X{20}GHANA VAN'T ZONNEVELD`

Page C — EQUITATION (discovered 2026-04-09 — completely different tag layout):
```
{1}   entry number   ← same
{2}   (empty)        ← NO horse name
{7}   rider name     ← NOT in {3} — different tag!
{6}   city, state    ← full locale e.g. "MADISON, NJ"
{4}   (empty)
{5}   (empty)
{14}  (empty)
{15}  (empty)
{17}  (empty)
```

Example Page C: `{RYESCR}{fr}11{1}146{2}{7}WENDY CHAPOT NUNN{4}{5}{6}MADISON, NJ{14}{15}{17}`

Detection: if {3} is absent but {7} is present → equitation frame.
Watcher sets isEq=true + locale field on the flatEntriesSeen entry.
No horse name available from UDP — only rider + city/state.

Action on {fr}=11: store { entry, horse, rider, owner } in KV as onCourse.
That's it. No other processing needed.

#### Hunter DISPLAY SCORES packets — ACTIVE in pipeline (2026-04-10):
Operator-triggered "Display Scores" button. Watcher uses these as a hint
to force-refresh the .cls file and emit a FINISH event so the live page
flips out of ONCOURSE display. The packet's score tags are read for
logging only — actual scoring data still comes from .cls file (which we
force-read in the same handler).

{fr}=12 — REGULAR hunter Display Scores (standard O/F, non-derby scored):
```
{1}   entry number
{2}   horse name
{3}   rider name
{8}   RANK: [place]
{14}  T: [total]                         e.g. "T:   79.00"
{21}  1: [J1 score]                      e.g. "1: 78.00"
{22}  2: [J2 score]                      e.g. "2: 80.00"
{23+} 3+: [J3+ score]  (when N judges)
```
Sample (class 925, entry 194, 2-judge non-derby):
`{RYESCR}{fr}12{1}194{2}SIR WALLACE{3}WILLIAM SLATER{8}RANK: 3{14}T:   79.00{21}1: 78.00{22}2: 80.00`

{fr}=16 — DERBY Display Scores (larger fields for hi-opt + bonus):
```
{1}   entry number
{2}   horse name
{3}   rider name
{8}   RANK: [place]
{21}  [judge]: [score] + [bonus]  e.g. "1:4.000 + 76"
      Judge 1 score + bonus points
```

{fr}=14 — RESULTS DISPLAY (forced/flat ribbon announcement):
Operator announces ribbons one at a time, one entry per frame. Watcher
accumulates them in `hunterResults` and posts a HUNTER_RESULT event for
each new entry so the live page can render ribbons in real time.
```
{1}   entry number
{2}   horse name
{3}   rider name
{4}   owner
{8}   place text  e.g. "1st", "2nd"
{14}  score (empty for forced/flat classes)
```

#### Hunter phase detection (refined 2026-04-10):
```
{fr}=11 fires       → ON COURSE  → post ON_COURSE event (intro info only)
{fr}=12 fires       → DISPLAY SCORES (regular hunter) → force .cls re-read + post FINISH
{fr}=16 fires       → DISPLAY SCORES (derby)          → force .cls re-read + post FINISH
{fr}=14 fires       → RESULTS DISPLAY (forced/flat)   → post HUNTER_RESULT (accumulating)
{fr}=0  fires       → CLEAR scoreboard                → post CLEAR_ONCOURSE
.cls changes        → score posted                    → recompute results
```

The .cls file is still truth for scoring data. UDP frames are triggers
for state transitions on the live/display pages — they tell us "what
the operator wants the audience to see right now" (intro vs. scores
vs. ribbons).

#### Port 31000 — Video Wall / Class Complete Detection:
Always-on checkbox in Ryegate settings. Fires on every On Course click AND Ctrl+A.

Format: `{RYESCR}{fr}[frame]{26}[classNum]s{27}[classNum]{28}[className]{ }`
```
{fr}  Ryegate internal frame number — ignore
{26}  classNum + "s" = sponsor graphic filename — ignore
{27}  clean class number ← USE THIS
{28}  class name ← bonus
```

Signals:
```
1x Ctrl+A  → CLASS_SELECTED — screens refresh
3x Ctrl+A within 2 seconds → CLASS_COMPLETE
Also fires on every On Course click simultaneously with {fr}=11 INTRO
```

---

### HUNTER UDP — NO LONGER LEARNING (DECISION MADE):
We do not need to map remaining hunter UDP frames for the pipeline.
The .cls file provides all scoring data. UDP provides only the ON COURSE signal.
Remaining unknowns are informational only:
```
{fr}=13-15  Final/standings pages — not needed
{5}         Unknown tag — always empty, ignore
Multi-judge — .cls handles this, UDP not needed
Derby bonus — .cls handles this, UDP not needed
EX/OC/RF    — .cls StatusCode handles this
```

---

## STILL UNKNOWN

### Jumper Header:
```
H[03]: always 0 — legacy
H[18]: always False — legacy
H[20]: always empty — legacy
H[24]: always False — legacy
H[27]: always True — legacy
```

### TIMY Entry:
```
col[03]: always empty — unknown purpose, watch at HITS
col[12]: Owner FEI/USEF number — assumed by pattern (horse=10, rider=11, owner=12)
         CONFIRM at HITS — find an entry with all three numbers populated
col[21]: always 0 — possibly R1Place, watch at HITS
col[28]: always 0 — possibly R2Place, watch at HITS
col[35]: NOT the status code — always 0 for TIMY entries *
         * Status codes are at col[82] (R1) and col[83] (R2) — confirmed 2026-04-03
col[84]: R3 status code — probable but unconfirmed (no 3-round data available) *
col[82] R1_StatusCode *    RF=RiderFall, EL=Eliminated, WD=Withdrawn, OC=OffCourse, DNS=DidNotStart
                           * Updated 2026-04-03 — evidence from 50+ entries across methods 2,4,6,9,13
                           Populated when incident occurs in R1/PH1 or single-round classes
                           col[35] previously documented as status — ALWAYS 0, not status code
col[83] R2_StatusCode *    Same codes — populated when incident occurs in R2/JO/PH2
                           Only present on entries that competed in R2 (col[82] empty for these)
                           * Evidence: class 21 (method 9), class 23/24/27 (method 13)
col[84] R3_StatusCode *    Probable R3/JO status — NOT YET CONFIRMED (no 3-round data available)
                           * Needs confirmation at HITS with a method 3 class
```

### Farmtek Entry:
```
col[13]: always 0 — unused (RideOrder at col[35] instead)
col[37-38]: always empty
```

### Hunter Header:
```
H[06]: 1 observed only on WCHR Derby Spec — purpose unknown, not needed for display
H[07]: auto-adjusts per derby type — full map incomplete
H[09]: SBDelay — only tested at value 4
H[37]=9: WCHR Spec — likely but not confirmed
```

### Hunter Entry:
```
col[46]: small number on derbies — possibly bonus fence count
col[47]: small number on classics — unknown
```

### Division Champion vs Scored Championship — CONFIRMED 2026-04-03:
```
Both use: classType=H, H[11]=IsChampionship=True
Detection: check hasGone flags on entries

Division Champion (standings only):
  - Entries have places assigned but hasGone=false
  - No scores (col[15] empty/zero)
  - Display as placement list only — no score columns, no stats
  - These are division awards, not scored classes

Real Hunter Championship (scored):
  - Entries have hasGone=true (cycled through scoring)
  - Scores present (col[15] non-zero)
  - Display full results with judge scores
```

---

## UDP TAGS TO INVESTIGATE AT HITS

### Jumper tags we USE:
```
{1}   entry number        → ON_COURSE, INTRO, CD, FINISH
{2}   horse name          → ON_COURSE, INTRO
{3}   rider name          → ON_COURSE, INTRO
{8}   rank                → FINISH detection
{13}  TA                  → time allowed, round inference
{14}  jump faults         → live fault count
{15}  time faults         → not used live (calculated from clock)
{17}  elapsed             → running clock
{23}  countdown           → CD phase
```

### Jumper tags we LOG but don't use — investigate at HITS:
```
{4}   owner?              → appears in hunter {fr}=11, check if present in jumper
{5}   unknown             → always empty in current data
{18}  TTB (time to beat)  → unreliable, disappears — could show on live page?
{26}  class sponsor?      → from port 31000 only, not scoreboard port
```

### Jumper tags NOT YET SEEN — watch for at HITS:
```
{6}-{7}   unknown — may appear in specific class types
{9}-{12}  unknown — may carry additional entry/horse data
{16}      unknown — gap between {15} time faults and {17} elapsed
{19}-{22} unknown — may carry round-specific data
{24}-{25} unknown
```

### Hunter tags we USE:
```
{fr}=11: {1} entry, {2} horse, {3} rider, {4} owner → ON_COURSE only
```

### Hunter tags we LOG but don't use — investigate at HITS:
```
{fr}=11 Page A: {14} H:score (class high), {17} SB message text
{fr}=11 Page B: {18} sire, {19} "X", {20} dam → breeding data live
{fr}=12: {8} rank, {21} place:score → standard finish
{fr}=16: {8} rank, {21} judge:score+bonus → derby finish
{fr}=13-15: standings/final pages — unknown tag structure
```

### Port 31000 — investigate at HITS:
```
Currently fires on Ctrl+A (CLASS_SELECTED/COMPLETE) and On Course click.
{27} = classNum, {28} = className — confirmed
Does it also fire on ADD ENTRY? SCRATCH? SCORE POST?
Watch for additional triggers beyond Ctrl+A and On Course.
```

### Key questions for HITS UDP capture:
```
1. Does {fr}=0 (clear) fire every time between horses or only on manual clear?
2. Are there UDP signals for ADD ENTRY / SCRATCH / RIDER SWAP?
3. Does {18} TTB (time to beat) populate reliably in speed classes?
4. Do any tags carry the entry's current PLACE during the run?
5. Are there tags for fence count or course info?
6. Does jumper {4} carry owner like hunter {fr}=11 does?
7. Any UDP signal when the .cls file is about to be written (pre-score)?
```

