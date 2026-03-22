# Ryegate Scoring Software — .cls File Format Documentation
# WEST Scoring Live Project
# Last updated: 2026-03-22 (Session 13 — full hunter header toggle test completed)

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
  J = Jumper schema (Farmtek timer)
  T = Jumper schema (TIMY timer — same columns as J)
  U = Unformatted (no schema — entry rows have no score columns)

**ZERO column crossover between Hunter and Jumper schemas.**
H[02] means ScoreType in Hunter. H[02] means ScoringMethodCode in Jumper.
H[21] means OverallTieBreak in Hunter. H[21] means CaliSplitSections in Jumper.
Every column from H[02] onward must be interpreted independently per schema.
NEVER assume a column means the same thing across schemas.

Once formatted as H or J/T, cannot be changed. Schema is locked permanently.

---

## ENTRY ROW LENGTHS (confirmed from 97-class analysis):
  Hunter (H):  always 55 cols
  Farmtek (J): always 40 cols (no TIMY timestamp blocks)
  TIMY (T):    always 85 cols (includes 3 round timestamp blocks)
  Unformatted: 14 cols

---

## JUMPER HEADER COLUMNS — CONFIRMED

### Shared cols 0-1 (same for Hunter and Jumper):
```
H[00] ClassType              H=Hunter, J=Farmtek, T=TIMY, U=Unformatted
H[01] ClassName              "1.15m Jumper"
```

### Jumper-specific cols 2+ — CONFIRMED:
```
H[02] ScoringMethodCode      see Scoring Methods below
H[03] ?                      always 0
H[04] HardwareType           1=Farmtek, 2=TIMY (correlates with H[00])
H[05] ClockPrecision         0=standard, 1=hundredths, 2=thousandths
H[06] ImmediateJumpoff       1=immediate JO (2b), 0=clears return (2a)
H[07] R1_FaultsPerInterval   default 1 (1 fault per interval)
H[08] R1_TimeAllowed         seconds e.g. 78
H[09] R1_TimeInterval        default 1 (1 second per interval)
H[10] R2_FaultsPerInterval   default 1
H[11] R2_TimeAllowed         seconds e.g. 43
H[12] R2_TimeInterval        default 1
H[13] R3_FaultsPerInterval   stale/ignored if <3 rounds
H[14] R3_TimeAllowed         stale/ignored if <3 rounds
H[15] R3_TimeInterval        stale/ignored if <3 rounds
H[16] CaliforniaSplit        True/False
H[17] IsFEI                  True/False
H[18] ?                      always False
H[19] Sponsor                text field
H[20] ?                      unknown — never seen a value
H[21] CaliSplitSections      default 2
H[22] PenaltySeconds         default 6
H[23] NoRank                 True/False
H[24] ?                      always False
H[25] ShowStandingsTime      True/False
H[26] ShowFlags              True/False
H[27] ?                      always True
H[28] ShowFaultsAsDecimals   True/False
```

NOTE: Per-round pattern = FaultsPerInterval → TimeAllowed → TimeInterval (3 cols/round)
Ryegate leaves R3 values stale when <3 rounds — ignore if not a 3-round class.

### Scoring Method Codes (H[02]) — CONFIRMED:
```
2  = Round + JO, clears return at end (2a)
3  = Two rounds + JO
4  = Single round, against the clock (speed)
6  = Speed II (Farmtek only)
9  = Two-phase
13 = Round + immediate JO (2b)
```
NOTE: Two-phase (9) uses TIMY blocks 2 and 3 instead of 1 and 2.

---

## HUNTER HEADER COLUMNS — CONFIRMED FROM LIVE TOGGLE TEST 2026-03-22

WARNING: Zero crossover with Jumper schema. Every column is hunter-specific.
Labels marked ? are column names inherited from the watcher and may be wrong.
Only values that were directly observed changing are marked CONFIRMED.

```
H[00] ClassName              H — ClassType
H[01] ClassName              text — class name

H[02] ScoreType              CONFIRMED — observed values:
                             0 = Over Fences / Flat (standard scoring)
                             2 = Derby (auto-set when Derby type selected)
                             3 = Special class

H[03] NumRounds              CONFIRMED — observed values: 1, 2
                             Was set to 2 before this test began
                             1 = single round, 2 = two rounds

H[04] HardwareType(?)        observed: always 1 in hunter classes
                             May mean something different than jumper H[04]
                             Needs further testing

H[05] IsFlat                 CONFIRMED — observed values:
                             0 = Over Fences (seen in first log session)
                             1 = Flat (set before this test, stayed 1 throughout)

H[06] ?                      CONFIRMED changes — observed values:
                             0 = standard (most class types)
                             1 = USHJA 2'6" Jr H&G derby AND Special class
                             Label "ImmediateJumpoff" inherited from jumper — WRONG for hunter
                             Possibly IsHuntAndGo or HasMultiplePhases — needs more testing

H[07] NumScores(?)           CONFIRMED changes — observed values:
                             1 = most derby types (auto-set)
                             2 = International Derby (auto-set)
                             3 = was set manually before test began
                             Pattern: auto-adjusts per derby type

H[08] Ribbons                CONFIRMED — observed values:
                             8  = standard classes
                             12 = derby classes (auto-set when Derby selected)

H[09] SBDelay(?)             observed: always 4 in this test (SB Delay was set to 4)
                             Appears to be numeric scoreboard delay
                             Needs test with different delay values to confirm

H[10] IsEquitation           CONFIRMED True/False — direct toggle test ✓
H[11] IsChampionship         CONFIRMED True/False — direct toggle test ✓
H[12] IsJogged               CONFIRMED True/False — direct toggle test ✓
H[13] OnCourseSB             CONFIRMED True/False — direct toggle test ✓
H[14] IgnoreSireDam          CONFIRMED True/False — direct toggle test ✓
H[15] PrintJudgeScores       CONFIRMED True/False — direct toggle test ✓
H[16] ReverseRank            CONFIRMED True/False — direct toggle test ✓

H[17] CaliforniaSplit        CONFIRMED True/False — flipped True when Split enabled
                             NOTE: Watcher label "RunOff" is WRONG for hunter schema
                             Run Off is H[30] in hunter schema

H[18] R1TieBreak(?)          CONFIRMED changes — observed values:
                             0 = Leave Tied
                             1 = By Judge 1 (Intl H&G, USHJA Pony)
                             8 = By Judge 8 (USHJA Pony H&G, USHJA 2'6" Jr)
                             7 = By Judge 7 (Special class)
                             Pattern: literal judge number

H[19] R2TieBreak(?)          CONFIRMED changes — observed values:
                             0 = Leave Tied
                             6 = By Judge 6 (Special class only in this test)

H[20] R3TieBreak(?)          CONFIRMED changes — observed values:
                             0 = Leave Tied
                             4 = By Judge 4 (Special class only in this test)

H[21] OverallTieBreak(?)     CONFIRMED changes — observed values:
                             0  = Leave Tied
                             20 = By Overall Score (Intl H&G and some USHJA types)

H[22] PhaseWeight1           observed: always 100
H[23] PhaseWeight2           observed: always 100
H[24] PhaseWeight3           observed: always 100
H[25] Phase1Label            text — "Phase 1" default, customizable in Special
H[26] Phase2Label            text — "Phase 2" default, customizable in Special
H[27] Phase3Label            text — "Phase 3" default, customizable in Special
H[28] Message                scoreboard message text
H[29] Sponsor                sponsor text

H[30] RunOff                 CONFIRMED True/False — direct toggle test ✓
H[31] AvgRounds              CONFIRMED True/False — direct toggle test ✓
H[32] NoCutOff               CONFIRMED True/False — direct toggle test ✓
H[33] CaliSplitSections      CONFIRMED numeric — observed values: 2, 4
                             Default 2 sections, changed to 4 in live test
H[34] Dressage               CONFIRMED True/False — direct toggle test ✓
H[35] ShowAllRounds          CONFIRMED True/False — direct toggle test ✓
                             Also auto-set per derby sub-type default:
                             Standard derbies (Intl, Natl, USHJA Pony, USHJA 2'6" Jr) → True
                             H&G variants → False
                             Ryegate sets each derby type's default — operator can override

H[36] DisplayNATTeam         CONFIRMED True/False — direct toggle test ✓

H[37] DerbyType              CONFIRMED — observed values (increments sequentially):
                             0 = no derby (standard O/F, Flat, Special resets to 0)
                             1 = International
                             2 = National
                             3 = National Hunt & Go
                             4 = International Hunt & Go
                             5 = USHJA Pony Derby
                             6 = USHJA Pony Hunt & Go
                             7 = USHJA 2'6" Jr Derby
                             8 = USHJA 2'6" Jr H&G
                             NOTE: WCHR Spec not confirmed — marker 24 was USHJA 2'6" Jr H&G

H[38] IHSA                   CONFIRMED True/False — direct toggle test ✓
H[39] RibbonsOnly            CONFIRMED True/False — direct toggle test ✓
```

### Derby Auto-changes (observed when Derby class type selected):
```
H[02] → 2 (HiLo)
H[07] → varies by derby sub-type
H[08] → 12
H[35] → True or False depending on derby sub-type (see H[35] above)
H[39] → False (RibbonsOnly auto-cleared)
```

### Tie Break Value Encoding (H[18]-H[21]):
```
0  = Leave Tied
1-N = By Judge N (literal judge number)
20  = By Overall Score
```

### H[35] ShowAllRounds Default per Derby Type:
```
International (H[37]=1):      True
National (H[37]=2):           True  (wait — log shows False at marker 18)
National H&G (H[37]=3):       False
International H&G (H[37]=4):  False
USHJA Pony (H[37]=5):         True
USHJA Pony H&G (H[37]=6):     False
USHJA 2'6" Jr (H[37]=7):      True
USHJA 2'6" Jr H&G (H[37]=8):  False
H&G variants consistently default False. Standard derbies default True.
Operator can override in class settings.
```

### STILL UNCERTAIN — HUNTER HEADER:
```
H[06] — confirmed changes (0→1) for H&G derby types and Special
        Label "ImmediateJumpoff" inherited from jumper schema — wrong for hunter
        Possibly IsHuntAndGo — needs further testing
H[07] — auto-adjusts per derby type, full value mapping not yet complete
H[09] — appears to be SBDelay numeric but only tested at value 4
WCHR Spec — not confirmed which H[37] value (may be 9 or higher)
```

---

## HUNTER ENTRY COLUMNS — CONFIRMED (2026-03-20, 97-class analysis)

Hunter entries are always 55 cols. HasGone = col[49] NOT col[40].

### Identity cols (confirmed for Hunter — do NOT assume same for Jumper):
```
Col 0:  EntryNum
Col 1:  HorseName
Col 2:  RiderName
Col 3:  (empty)
Col 4:  (empty)
Col 5:  OwnerName
Col 6:  Sire
Col 7:  Dam
Col 8:  City
Col 9:  State
Col 10: Notes / USEF passport number
Col 11: USEF/FEI number
Col 12: ? (rarely populated — seen one derby entry with a number)
```

### Standard single-judge single-round O/F:
```
Col 13: GoOrder
Col 14: CurrentPlace      live standing, updates after each horse
Col 15: R1Score           hunter judge score (45-95 typical)
Col 42: R1Total           same as R1Score for standard classes
Col 45: CombinedTotal     same as R1Total for single-round
Col 49: HasGone_R1        1=competed
Col 52: StatusCode        EX=Excused, RF=RiderFall, OC=OffCourse
```

### Two-round classic (1 judge, 2 rounds):
```
Col 13: GoOrder
Col 14: CurrentPlace
Col 15: R1Score
Col 24: R2Score           round 2 (handy or second O/F)
Col 42: R1Total
Col 43: R2Total
Col 45: CombinedTotal     R1Score + R2Score
Col 49: HasGone_R1        1=completed R1 only (scratched before R2)
Col 50: HasGone_R2        1=completed both rounds
Col 52: StatusCode_R1
Col 53: StatusCode_R2
```

### International Derby (2 judges, 2 rounds, high options + handy bonus):
```
Scoring: Total = Judge1Base + HighOptBonus + Judge2Base + HighOptBonus
         R2 adds HandyBonus per judge

Col 13: GoOrder
Col 14: CurrentPlace
Col 15: R1_HighOptionsTaken     high option fences jumped R1 (0-4)
Col 16: Judge1_R1_BaseScore
Col 17: R1_HighOptionsTaken     mirrors col 15
Col 18: Judge2_R1_BaseScore
Col 24: R2_HighOptionsTaken     high option fences jumped R2
Col 25: Judge1_R2_BaseScore
Col 26: Judge1_R2_HandyBonus    (0-10)
Col 27: R2_HighOptionsTaken     mirrors col 24
Col 28: Judge2_R2_BaseScore
Col 29: Judge2_R2_HandyBonus
Col 42: R1Total
Col 43: R2Total
Col 45: CombinedTotal
Col 49: HasGone_R1
Col 50: HasGone_R2
```

### National/Jr/Amateur Derby (multi-judge):
```
Col 13: GoOrder
Col 14: CurrentPlace
Col 15: NumJudgesScored_R1
Col 16: R1Score (base)
Col 24: NumJudgesScored_R2
Col 25: R2Score
Col 42: R1Total
Col 43: R2Total
Col 45: CombinedTotal
Col 46: ?BonusFenceCount
Col 49: HasGone_R1
Col 50: HasGone_R2
```

### Score Detection:
```
Has competed:    col[49]=='1' OR col[50]=='1'
Eliminated:      col[52] non-empty
Standard score:  col[49]=='1' AND col[15] non-zero
Classic score:   col[50]=='1' AND col[15] AND col[24] non-zero
Intl Derby:      col[50]=='1' AND col[16] AND col[25] non-zero
Natl Derby:      col[50]=='1' AND col[16] AND col[25] non-zero
```

---

## STILL UNKNOWN — HUNTER ENTRY
```
Col 46: small number (2-3) on derbies — possibly bonus fence count
Col 47: small number on classics only — unknown
```

---

## JUMPER ENTRY COLUMNS — CONFIRMED

### Identity cols (same as hunter cols 0-12):
See Hunter identity cols above.

### Scoring cols — CONFIRMED:
```
Col 13: RideOrder          order of go (1-N)
Col 14: R1Place            final R1 standing
Col 15: R1Time             elapsed seconds e.g. 82.620
Col 16: R1JumpFaults       fault points e.g. 0, 4, 8
Col 17: R1Total            R1Time + R1JumpFaults
Col 18: ?                  unknown
Col 19: ?                  seen values 4, 8 — possibly raw rail count × 4
Col 20: ?                  mirrors col 19
Col 21: ?                  unknown
Col 22: R2Time             JO elapsed seconds ✓ CONFIRMED
Col 23: ?                  unknown
Col 24: R2Total            JO total ✓ CONFIRMED
Col 25: R2JumpFaults       JO jump faults
Col 26-34: ?               unknown
Col 35: StatusCode         RF=RiderFall, EL=Eliminated, WD=Withdrawn,
                           SC=Schooling, DNS=DidNotStart,
                           DNF=DidNotFinish, RET=Retired
```

### Score Detection:
```
R1 complete: col[15] OR col[17] OR col[16] non-zero
R2 complete: col[22] OR col[24] non-zero
```

---

## TIMY TIMESTAMP BLOCKS — CONFIRMED 2026-03-20

TIMY hardware writes TOD (time of day) to entry row via serial port.
Format: HH:MM:SS or HH:MM:SS.NNNNNNN
00:00:00 = not used

Each round block is 15 cols: CDStart + 6 CD pause/resume + RideStart + 6 Ride pause/resume + RideEnd
All 3 blocks always allocated regardless of rounds used.

### Round 1 Block (cols 36-51) — CONFIRMED:
```
Col 36: R1_CDStart
Col 37-43: R1_CD Pause/Resume pairs (3 pairs)
Col 44: R1_RideStart    ✓ confirmed matching TOD screen
Col 45-50: R1_Ride Pause/Resume pairs (3 pairs)
Col 51: R1_RideEnd      ✓ confirmed matching TOD screen
```

### Round 2 / JO Block (cols 52-66) — CONFIRMED:
```
Col 52: R2_CDStart      ✓ confirmed
Col 53-58: R2_CD Pause/Resume pairs
Col 59: R2_RideStart    ✓ confirmed
Col 60-65: R2_Ride Pause/Resume pairs
Col 66: R2_RideEnd      ✓ confirmed
```

### Round 3 Block (cols 67-81) — unused for standard 2-round classes:
```
Col 67: R3_CDStart
Col 68-73: R3_CD Pause/Resume pairs
Col 74: R3_RideStart
Col 75-80: R3_Ride Pause/Resume pairs
Col 81: R3_RideEnd
```

### Elapsed Time Calculation:
```
Elapsed = (RideEnd - RideStart) - sum(all RidePause/RideResume durations)
```

### Two-phase (ScoringMethod=9):
Phase 1 uses Round 2 block. Phase 2 uses Round 3 block.

---

## FARMTEK TIMING NOTES

Farmtek = optical beam timing. No TOD timestamps written.
Cols 36-80 all 00:00:00 for Farmtek (J type) classes.
On-course detection uses R1Time/R1Place appearing in entry row.

---

## TSKED.CSV STRUCTURE
```
Row 1:  ShowName, ShowDates
Row 2+: ClassNum, ClassName, Date, Flag
```

Flag values:
```
S       = Scored/Complete
JO      = Order of Go posted
(blank) = standard
```

---

## CONFIG.DAT STRUCTURE

First line comma-separated:
```
Col 0:  SerialPort         "COM7" etc
Col 1:  UDPPort            29711 (scoreboard port)
Col 2:  "FDS"
Col 3:  ServerIP           Ryegate FTP server IP
Col 4:  FTPPath            "/SHOWS/HITS/.../r1" — ring from /r1, /r2 etc
Col 5:  FTPUser
Col 6:  FTPPassword
Col 24: ShowURLSlug        "hits-east" — Ryegate back office ID
                           NOTE: Not reliable as show slug for our system
                           Use config.json slug set by operator instead
```

Subsequent lines:
```
Line 3: Show Name
Line 4: Dates
Line 5: Location
```

### UDP Ports:
```
Scoreboard port: config.dat col[1] — USE THIS (e.g. 29711)
Live data port:  scoreboardPort - 496 — PERMANENTLY LOCKED by Ryegate
```

---

## UDP PROTOCOL — CONFIRMED

Format: {RYESCR}{tag}value{tag}value...

### Tags:
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

### Phase Detection:
```
IDLE      no active horse
INTRO     entry present, no CD/elapsed/rank
CD        {23} countdown present
ONCOURSE  {17} elapsed present, no {8}
FINISH    {8} rank present
```

---

## STILL UNKNOWN

### Jumper Header:
```
H[03]: always 0 — unknown purpose, likely legacy
H[18]: always False — likely legacy unused
H[20]: unknown — never seen a value
H[24]: always False — likely legacy
H[27]: always True — likely legacy
```

### Jumper Entry:
```
Col 18: unknown
Col 19: seen values 4, 8 — possibly raw rail count × 4
Col 20: mirrors col 19 — unknown
Col 21: unknown
Col 23: unknown
Col 26-34: unknown
```
NOTE ON JUMPER ENTRY UNKNOWNS: These columns sit between confirmed scoring
cols (R1/R2 times, faults, totals) and the status code. They likely contain
intermediate calculation values or legacy fields Ryegate uses internally.
For display purposes we don't need them — we have all the scores we need.

### Hunter Header:
```
H[06]: confirmed changes for H&G derbies and Special class
       Label "ImmediateJumpoff" inherited from jumper — WRONG for hunter
       Possibly IsHuntAndGo — needs one more targeted test
H[07]: auto-adjusts per derby sub-type, full value mapping incomplete
H[09]: appears to be SBDelay numeric, only tested at value 4
WCHR Spec: H[37] value not confirmed — likely 9 (sequential after 8)
```

### Hunter Entry:
```
Col 46: small number on derbies — possibly bonus fence count
Col 47: small number on classics — unknown
```

