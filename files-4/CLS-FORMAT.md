# Ryegate Scoring Software — .cls File Format Documentation
# WEST Scoring Live Project
# Last updated: 2026-03-22 (Session 14 — complete TIMY entry layout confirmed from live class 221)

---

## FILE TYPES

### .cls — Live Class File (PRIMARY DATA SOURCE)
- Located: C:\Ryegate\Jumper\Classes\
- One file per class (named by class number e.g. 221.cls)
- Ryegate writes ENTIRE file atomically at end of each round
- File does NOT update while horse is on course — on-course state = UDP only
- Read with shared access (fs.openSync flag 'r') — never lock this file
- DO NOT use .csv files — they are unreliable snapshots, not real-time

### tsked.csv — Class Schedule
- Located: C:\Ryegate\Jumper\
- One file per ring
- Updated when operator adds/modifies classes

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
```
H[02] ScoringMethodCode      see Scoring Methods below
H[03] ?                      always 0 — legacy unused
H[04] RoundsCompleted        CONFIRMED counter — increments 0→1→2→3 as each
                             round is scored. Was mislabeled HardwareType.
                             Corrected 2026-03-22 from live session evidence.
H[05] ClockPrecision         0=whole seconds, 1=hundredths, 2=thousandths
H[06] ImmediateJumpoff       1=immediate JO (2b), 0=clears return (2a)
H[07] R1_FaultsPerInterval   fault points per time interval
                             1.0 = standard (1 fault/second)
                             0.25 = quarter fault per second (seen class 221)
                             0.1 = FEI style (0.1 fault/second)
H[08] R1_TimeAllowed         TA in seconds e.g. 78
H[09] R1_TimeInterval        seconds per interval e.g. 1, 2, 4
H[10] R2_FaultsPerInterval   same pattern as R1
H[11] R2_TimeAllowed         TA for R2/JO in seconds
H[12] R2_TimeInterval        seconds per interval for R2
H[13] R3_FaultsPerInterval   stale/ignored if class has <3 rounds
H[14] R3_TimeAllowed         stale/ignored if class has <3 rounds
H[15] R3_TimeInterval        stale/ignored if class has <3 rounds
H[16] CaliforniaSplit        True/False
H[17] IsFEI                  True/False (0=False, 1=True)
H[18] ?                      always False — legacy unused
H[19] Sponsor                text field
H[20] ?                      always empty — legacy unused
H[21] CaliSplitSections      numeric, default 2
H[22] PenaltySeconds         seconds added per time fault e.g. 6
H[23] NoRank                 True/False
H[24] ?                      always False — legacy unused
H[25] ShowStandingsTime      True/False
H[26] ShowFlags              True/False
H[27] ?                      always True — legacy unused
H[28] ShowFaultsAsDecimals   True/False
```

### Class 221 actual header (1.15m Jumper, TIMY, ScoringMethod=3, after all 3 rounds):
```
H[00]=T  H[01]=1.15m Jumper  H[02]=3  H[03]=0  H[04]=3(RoundsCompleted=3)
H[05]=0  H[06]=1(ImmediateJO)
H[07]=0.25(R1 FaultsPerInterval)  H[08]=34(R1 TA)  H[09]=1(R1 Interval)
H[10]=1(R2 FaultsPerInterval)  H[11]=31(R2 TA)  H[12]=4(R2 Interval)
H[13]=1(R3 FaultsPerInterval)  H[14]=15(R3 TA)  H[15]=2(R3 Interval)
H[16]=1(CaliSplit)  H[17]=0  H[18]=False
H[21]=2(CaliSplitSections)  H[22]=6(PenaltySec)  H[23]=False
H[25]=False  H[26]=False  H[27]=True  H[28]=False
```

### Scoring Method Codes (H[02]):
```
2  = Round + JO, clears return at end (2a)
3  = Two rounds + JO
4  = Single round, against the clock (speed)
6  = Speed II (Farmtek only)
9  = Two-phase
13 = Round + immediate JO (2b)
```
NOTE: Two-phase (9) uses TIMY blocks 2 and 3 instead of 1 and 2.

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

### Identity cols 0-12:
```
col[00] EntryNum
col[01] HorseName
col[02] RiderName
col[03] (empty)
col[04] (empty)
col[05] OwnerName
col[06] Sire
col[07] Dam
col[08] City
col[09] State
col[10] Notes / USEF passport number (e.g. 107XS23)
col[11] USEF/FEI number (e.g. 10322256)
col[12] (empty)
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

### Identity cols 0-12: same layout as TIMY above.

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

H[02] ScoreType              0=Over Fences/Flat (standard)
                             2=Derby (auto-set when Derby selected)
                             3=Special class

H[03] NumRounds              1=single round, 2=two rounds ✓

H[04] HardwareType(?)        always 1 in hunter — may differ from jumper meaning

H[05] IsFlat                 0=Over Fences, 1=Flat ✓

H[06] ?                      0=standard, 1=H&G derby types and Special
                             Label "ImmediateJumpoff" wrong for hunter

H[07] NumScores              1=one score, 2=two, 3=three ✓
                             Auto-adjusts per derby sub-type

H[08] Ribbons                8=standard, 12=derbies ✓

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
H[37] DerbyType              0=none, 1=International, 2=National,
                             3=NatlHG, 4=IntlHG, 5=USHJAPony,
                             6=USHJAPonyHG, 7=USHJA26Jr, 8=USHJA26JrHG
                             9=WCHRSpec (likely — not directly confirmed)
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

### Identity cols 0-12:
```
col[00] EntryNum
col[01] HorseName
col[02] RiderName
col[03] (empty)
col[04] (empty)
col[05] OwnerName
col[06] Sire
col[07] Dam
col[08] City
col[09] State
col[10] Notes / USEF passport number
col[11] USEF/FEI number
col[12] ? (rarely populated)
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

### Two-round classic (1 judge, 2 rounds):
```
col[13] GoOrder
col[14] CurrentPlace
col[15] R1Score
col[24] R2Score              round 2 (handy or second O/F)
col[42] R1Total
col[43] R2Total
col[45] CombinedTotal        R1+R2
col[49] HasGone_R1           1=R1 only (scratched before R2)
col[50] HasGone_R2           1=completed both rounds
col[52] StatusCode_R1
col[53] StatusCode_R2
```

### International Derby (2 judges, 2 rounds, high options + handy):
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
col[29] Judge2_R2_HandyBonus
col[42] R1Total
col[43] R2Total
col[45] CombinedTotal
col[49] HasGone_R1
col[50] HasGone_R2
```

### Score Detection — Hunter:
```
Has competed:    col[49]=='1' OR col[50]=='1'
Eliminated:      col[52] non-empty
Standard score:  col[49]=='1' AND col[15] non-zero
Classic score:   col[50]=='1' AND col[15] AND col[24] non-zero
```

### STILL UNKNOWN — Hunter Entry:
```
col[46]: small number on derbies — possibly bonus fence count
col[47]: small number on classics — unknown
```

---

## TIMY TIMESTAMP FORMAT

Format: HH:MM:SS or HH:MM:SS.NNNNNNN
00:00:00 = not used / round not run

Elapsed calculation:
  Elapsed = (RideEnd - RideStart) - sum(all RidePause/RideResume durations)

Two-phase (ScoringMethod=9): Phase 1 uses R2 block, Phase 2 uses R3 block.

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
Flag: S=Scored/Complete, JO=OrderOfGoPosted, (blank)=standard

---

## CONFIG.DAT STRUCTURE

First line comma-separated:
```
Col 0:  SerialPort         "COM7" etc
Col 1:  UDPPort            scoreboard port e.g. 29711
Col 2:  "FDS"
Col 3:  ServerIP           Ryegate FTP server IP
Col 4:  FTPPath            "/SHOWS/HITS/.../r1" — ring from /r1, /r2 etc
Col 5:  FTPUser
Col 6:  FTPPassword
Col 24: ShowURLSlug        Ryegate back office ID — NOT reliable as show slug
                           Use config.json slug set by operator instead
```

UDP Ports:
```
Scoreboard port: config.dat col[1]
Live data port:  scoreboardPort - 496 (locked by Ryegate)
```

---

## UDP PROTOCOL — CONFIRMED

Format: {RYESCR}{tag}value{tag}value...

Tags:
```
{fr}  ring number
{1}   entry number
{2}   horse name
{3}   rider name
{4}   owner
{8}   rank — FINISH SIGNAL (strip "RANK " prefix)
{13}  time allowed (strip "TA: " prefix)
{14}  jump faults (strip "JUMP " prefix)
{15}  time faults (strip "TIME " prefix)
{17}  elapsed seconds
{18}  TTB time to beat (unreliable, disappears)
{23}  countdown (negative e.g. "-44")
```

Phase Detection:
```
IDLE      no active horse
INTRO     entry present, no CD/elapsed/rank
CD        {23} countdown present
ONCOURSE  {17} elapsed present, no {8}
FINISH    {8} rank present
```

UDP Collision Detection: REMOVED 2026-03-22.
Entry validation caused false positives on freshly formatted classes.
Watcher now trusts all UDP on the configured port. Operator handles
hardware-level collisions visually.

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
col[21]: always 0 — possibly R1Place, watch at HITS
col[28]: always 0 — possibly R2Place, watch at HITS
col[35]: StatusCode not yet confirmed in TIMY (only confirmed Farmtek col[39])
col[82-84]: trailing padding cols, always empty
```

### Farmtek Entry:
```
col[13]: always 0 — unused (RideOrder at col[35] instead)
col[37-38]: always empty
```

### Hunter Header:
```
H[06]: changes for H&G derbies and Special — label unknown
H[07]: auto-adjusts per derby type — full map incomplete
H[09]: SBDelay — only tested at value 4
H[37]=9: WCHR Spec — likely but not confirmed
```

### Hunter Entry:
```
col[46]: small number on derbies — possibly bonus fence count
col[47]: small number on classics — unknown
```

