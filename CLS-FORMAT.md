# Ryegate Scoring Software — File Format Documentation
# Discovered through live analysis 2026-03-19
# WEST Scoring Live Project

---

## FILE TYPES

### .cls — Live Class File (PRIMARY DATA SOURCE)
- Located: C:\Ryegate\Jumper\Classes\
- One file per class (named by class number e.g. 221.cls)
- Updated in real time by scoring software as class runs
- Read with shared access (fs.openSync flag 'r') — never lock this file
- DO NOT use .csv files — they are unreliable snapshots, not real-time

### tsked.csv — Class Schedule
- Located: C:\Ryegate\Jumper\
- One file per ring
- Updated when operator adds/modifies classes

### config.dat — Ring Configuration
- Located: C:\Ryegate\Jumper\
- Contains FTP path, server IP, show info, UDP ports
- Key for auto-configuring where to send data

---

## CRITICAL: TWO SEPARATE HEADER SCHEMAS

The header row (row 0) has a COMPLETELY DIFFERENT column layout depending on
whether the class is formatted as Hunter or Jumper. Columns 0-9 are shared.
Columns 10+ are format-dependent.

Once a class is formatted as Hunter OR Jumper, Ryegate will NOT allow it to be
re-formatted as the other type. The schema is locked in permanently.

ClassType (col 0) determines which schema applies:
  H = Hunter schema
  J = Jumper schema (Farmtek timer)
  T = Jumper schema (TIMY timer — same columns as J)
  U = Unformatted (no schema yet — entry rows have no score columns)

---

## CLS FILE STRUCTURE

### Row 1 — Class Header (shared cols 0-9)
```
Col 0:  ClassType          H=Hunter, J=Jumper Farmtek, T=Jumper TIMY, U=Unformatted
Col 1:  ClassName          "1.15m Jumper"
Col 2:  NumEntries         total entries in class
Col 3:  ?                  always 0
Col 4:  ?                  unknown — 1 for Farmtek, 2 for TIMY (timer type flag?)
Col 5:  ClockPrecision     confirmed changed live (marker 10)
Col 6:  ?                  unknown flag, set to 1 on format
Col 7:  ?                  unknown flag, set to 1 on format
Col 8:  TimeAllowed_R1     78 = 78 seconds (JUMPER) / Ribbons count (HUNTER)
Col 9:  NumJudges          1 for jumper, 4 for hunter
```

### Row 1 — Class Header (JUMPER cols 6+) — CONFIRMED
```
Col 6:  ImmediateJumpoff      1=immediate JO (2b), 0=clears return at end (2a)
Col 7:  R1_FaultsPerInterval  default 1 (1 fault per interval)
Col 8:  R1_TimeAllowed        seconds e.g. 79
Col 9:  R1_TimeInterval       default 1 (1 second per interval)
Col 10: R2_FaultsPerInterval  default 1
Col 11: R2_TimeAllowed        seconds e.g. 68
Col 12: R2_TimeInterval       default 1
Col 13: R3_FaultsPerInterval  default 1 (stale/ignored if <3 rounds)
Col 14: R3_TimeAllowed        seconds e.g. 45 (stale/ignored if <3 rounds)
Col 15: R3_TimeInterval       default 1 (stale/ignored if <3 rounds)
Col 16: CaliforniaSplit        1/True = enabled
Col 17: IsFEI                  True/False
Col 18: ?                      unknown
Col 19: Sponsor                "Sponsored by field"
Col 20: ?                      unknown — never seen a value
Col 21: CaliSplitSections      default 2, confirmed changed 2→3 live
Col 22: PenaltySeconds         default 6, confirmed changed 6→9 live
Col 23: NoRank                 True/False
Col 24: ?                      False — unknown
Col 25: ShowStandingsTime      True/False
Col 26: ShowFlags              True/False
Col 27: ?                      always True — unknown
Col 28: ShowFaultsAsDecimals   True/False
```

NOTE: Per-round pattern is FaultsPerInterval → TimeAllowed → TimeInterval (3 cols per round).
Standard penalty = 1 fault per 1 second. Non-standard e.g. 0.25 faults per 1 second.
Ryegate leaves R3 values stale when class has fewer than 3 rounds — ignore if not a 3-round class.

### Scoring Method Code (H[02]) — PARTIAL
```
2  = Round + JO, clears return at end (2a)
3  = Two rounds + JO
4  = Single round, against the clock
9  = Two-phase
13 = Round + immediate JO (2b)
```
NOTE: H[02] determines which TIMY timestamp blocks are used.
Two-phase (9) uses blocks 2 and 3 instead of 1 and 2.
All other formats use blocks sequentially from block 1.

### Row 1 — Class Header (HUNTER cols 0-9 shared, cols 10+) — PARTIAL

#### Shared cols (confirmed):
```
Col 0:  ClassType          H
Col 1:  ClassName
```

#### Hunter-specific cols 2+ (from 97-class data analysis 2026-03-20):
```
Col 2:  ?ScoringSubtype    0=standard O/F, 1=U/S only, 2=Derby/Classic
Col 3:  NumRounds          1=single round, 2=two-round classic/derby   [90% confidence]
Col 4:  NumJudges          1=standard, 2=International Derby, 4=Derby  [90% confidence]
Col 5:  ?                  UNKNOWN — does NOT reliably flag U/S
Col 6:  ?                  always 0
Col 7:  ?                  1=standard, 2=International Derby only
Col 8:  Ribbons            8=standard, 12=classics/derbies              [90% confidence]
Col 9:  ?                  always 4 — NOT NumJudges
Col 10: IsEquitation       True/False — CONFIRMED changed live
Col 11: IsChampionship     True/False — True on all Championship classes
Col 12: ?                  always False
Col 13: ?                  True/False — varies, purpose unknown [needs toggle test]
Col 14: ?                  True/False — False on Championships/U/S     [needs toggle test]
Col 15: ?                  always True
Col 16: ?                  always False
Col 17: ?                  True/False — True on 501.cls only (Jr Classic 3'3")
Col 18: ?                  0=standard, 1=International Derby only
Col 19: ?                  always 0
Col 20: ?                  always 0
Col 21: ?                  always 0
Col 22: PhaseWeight1       always 100
Col 23: PhaseWeight2       always 100
Col 24: PhaseWeight3       always 100
Col 25: Phase1Label        always "Phase 1"
Col 26: Phase2Label        always "Phase 2"
Col 27: Phase3Label        always "Phase 3"
Col 28: Message            scoreboard message text — operator entered
Col 29: ?                  always empty
Col 30: ?                  always False
Col 31: ?                  always False
Col 32: ?                  always False
Col 33: ?                  always 2
Col 34: ?                  always False
Col 35: ?                  False=standard, True=International Derby only
Col 36: ?                  always False
Col 37: IsDerby            0=standard, 1=National/Jr/Amateur Derby      [90% confidence]
Col 38: ?                  always False
Col 39: ?                  always False
```

NOTE: Many hunter header cols still need live toggle testing to confirm.
Priority unknowns: cols 2, 5, 7, 13, 14, 17, 18, 33, 35.

### Row 2 — @foot (Trophy/Footer)
```
@foot, "Trophy name or footer text"
```

### Row 3 — @money (Prize Money) — JUMPER ONLY
```
@money, 7500, 5500, 3250, 2000, 1500, 1250, 1000, 750, 750, 500...
(prize money per place, 0 = no prize for that place)
```

### Remaining Rows — Entry Data
One entry per row. Structure differs by class type:

---

## HUNTER ENTRY COLUMNS — CONFIRMED (2026-03-20, 97-class analysis)

Hunter entries are always 55 cols. HasGone flag is col 49 (NOT col 40 as previously assumed).

### Identity cols (shared with jumper):
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
Col 12: ? (rare — one derby entry had a number here)
```

### Scoring cols — standard single-judge single-round O/F:
```
Col 13: GoOrder            ride order (1-N) — may be 0 if not set
Col 14: CurrentPlace       live standing (1=leading), updates after each horse
Col 15: R1Score            hunter judge score (45-95 typical range)
Col 42: R1Total            same as R1Score for standard classes (no bonus)
Col 45: CombinedTotal      same as R1Total for single-round classes
Col 49: HasGone_R1         1=horse has competed in R1
Col 52: StatusCode         EX=Excused, RF=RiderFall, OC=OffCourse
```

### Scoring cols — two-round classic (1 judge, 2 rounds):
```
Col 13: GoOrder
Col 14: CurrentPlace
Col 15: R1Score            round 1 judge score
Col 24: R2Score            round 2 judge score (handy or second O/F)
Col 42: R1Total
Col 43: R2Total
Col 45: CombinedTotal      R1Score + R2Score
Col 49: HasGone_R1         1=completed R1 only (scratch before R2)
Col 50: HasGone_R2         1=completed both rounds (normal completion)
Col 52: StatusCode_R1
Col 53: StatusCode_R2
```

### Scoring cols — International Derby (2 judges, 2 rounds, high options + handy bonus):
```
Scoring formula per round:
  Total = Judge1BaseScore + HighOptionBonus + Judge2BaseScore + HighOptionBonus
  R2 Total adds HandyBonus for each judge on top

Col 13: GoOrder
Col 14: CurrentPlace
Col 15: R1_HighOptionsTaken    number of high option fences jumped R1 (0-4)
Col 16: Judge1_R1_BaseScore    judge 1 base score round 1
Col 17: R1_HighOptionsTaken    mirrors col 15 (same value — both judges same options)
Col 18: Judge2_R1_BaseScore    judge 2 base score round 1
Col 24: R2_HighOptionsTaken    number of high option fences jumped R2 (0-4)
Col 25: Judge1_R2_BaseScore    judge 1 base score round 2
Col 26: Judge1_R2_HandyBonus   judge 1 handy bonus (0-10) round 2
Col 27: R2_HighOptionsTaken    mirrors col 24
Col 28: Judge2_R2_BaseScore    judge 2 base score round 2
Col 29: Judge2_R2_HandyBonus   judge 2 handy bonus (0-10) round 2
Col 42: R1Total                Judge1_R1 + HighOpts + Judge2_R1 + HighOpts
Col 43: R2Total                Judge1_R2 + HighOpts + Handy + Judge2_R2 + HighOpts + Handy
Col 45: CombinedTotal          R1Total + R2Total
Col 49: HasGone_R1             1=competed
Col 50: HasGone_R2             1=went back for round 2 (top horses only)
```

### National/Jr/Amateur Derby (single judge, 2 rounds, high options):
```
Scoring formula:
  Total = BaseScore + (HighOptionsTaken × HighOptionValue)

Col 13: GoOrder
Col 14: CurrentPlace
Col 15: NumJudgesScored_R1     judges who scored (1-4)
Col 16: R1Score                base score round 1
Col 24: NumJudgesScored_R2     judges who scored round 2
Col 25: R2Score                base score round 2
Col 42: R1Total                score + bonus points
Col 43: R2Total
Col 45: CombinedTotal
Col 46: ?BonusFenceCount       small number (2-3) — bonus/high option count?
Col 49: HasGone_R1
Col 50: HasGone_R2
Col 52: StatusCode
```

### Cols always empty/zero in hunter entries:
```
Col 3, 4:    always empty
Col 17-23:   zeros for standard/classic, multi-judge derby scores for Int'l Derby
Col 30-41:   always 0
Col 44:      always 0
Col 46-48:   always 0 except derby bonus fence col 46
Col 50:      HasGone_R2 — 0 unless two-round class
Col 51:      always 0
Col 53-54:   always 0 except StatusCode_R2 on col 53
```

### SCORE DETECTION — CORRECTED:
```
Horse has competed:    col[49] == '1' OR col[50] == '1'
R1 complete:          col[49] == '1' AND col[15] non-zero
R2 complete:          col[50] == '1' AND col[24] non-zero (or col[43] for derby)
Eliminated/scratched: col[52] non-empty (EX, RF, OC)
```

---

## JUMPER / TABLE ENTRY COLUMNS — CONFIRMED
```
Col 0:  EntryNum
Col 1:  HorseName
Col 2:  RiderName
Col 3:  (empty)
Col 4:  Country            "NZL", "USA" etc
Col 5:  OwnerName
Col 6:  Sire
Col 7:  Dam
Col 8:  City
Col 9:  State
Col 10: Notes
Col 11: USEF/FEI number
Col 12: (empty)
Col 13: RideOrder          go order — confirmed set live
Col 14: R1Place            finishing position in R1
Col 15: R1Time             elapsed seconds e.g. 36.360 — CONFIRMED
Col 16: R1JumpFaults       jump fault points e.g. 4, 8 — CONFIRMED
Col 17: R1Total            R1Time + R1JumpFaults e.g. 40.360 — CONFIRMED
Col 18: ?                  unknown
Col 19: ?rawFaults         seen 4, 8 — possibly raw rail count × 4
Col 20: ?rawFaultsMirror   mirrors col 19
Col 21: ?                  unknown
Col 22: R2Time             JO elapsed seconds — CONFIRMED
Col 23: ?                  unknown
Col 24: R2Total            JO total — CONFIRMED
Col 25: R2JumpFaults       JO jump faults
Col 26: ?                  unknown
Col 27: ?                  unknown
Col 28: ?                  unknown
Col 29: ?                  unknown
Col 30-34: ?               unknown
Col 35: StatusCode         RF=RiderFall, EL=Eliminated, WD=Withdrawn, SC=Schooling,
                           DNS=DidNotStart, DNF=DidNotFinish, RET=Retired
```

## SCORE DETECTION

### Hunter — horse has competed:
```
col[49] == '1'  →  completed R1 (standard) or R1 only of two-round
col[50] == '1'  →  completed R2 (two-round classic/derby)
col[52] non-empty → eliminated/excused (EX, RF, OC)
```

### Hunter — has useful scores:
```
Standard:  col[49]=='1' AND col[15] non-zero
Classic:   col[50]=='1' AND col[15] AND col[24] non-zero
Derby:     col[50]=='1' AND col[16] AND col[25] non-zero (Int'l)
           col[50]=='1' AND col[16] AND col[25] non-zero (National)
```

### Jumper — horse has run R1:
```
col[15] non-zero OR col[17] non-zero OR col[14] non-zero
```

### Jumper — horse has run R2/JO:
```
col[22] non-zero OR col[24] non-zero
```

TIMY hardware writes TOD (time of day) timestamps to the entry row via serial port.
Format: HH:MM:SS or HH:MM:SS.NNNNNNN
00:00:00 = not used / round not run

CRITICAL: Ryegate allocates ALL THREE round blocks regardless of how many rounds
the class actually uses. Unused round blocks stay 00:00:00. This means entry rows
are FIXED WIDTH — no need to account for variable column counts per round number.

Each round block is 15 columns wide:
  1 col  CDStart
  6 cols CD Pause/Resume pairs (3 pairs)
  1 col  RideStart
  6 cols Ride Pause/Resume pairs (3 pairs)
  1 col  RideEnd

### Round 1 Block (cols 36-51) — CONFIRMED 2026-03-20:
```
Col 36: R1_HasGone_or_CDStart  Farmtek: 1=competed | TIMY: CDStart TOD
Col 37: R1_CDStart             TIMY CDStart TOD
Col 38: R1_CDPause1
Col 39: R1_CDResume1
Col 40: R1_CDPause2
Col 41: R1_CDResume2
Col 42: R1_CDPause3
Col 43: R1_CDResume3
Col 44: R1_RideStart           confirmed matching TOD screen exactly
Col 45: R1_RidePause1
Col 46: R1_RideResume1
Col 47: R1_RidePause2
Col 48: R1_RideResume2
Col 49: R1_RidePause3
Col 50: R1_RideResume3
Col 51: R1_RideEnd             confirmed matching TOD screen exactly
```

### Round 2 / JO Block (cols 52-66) — CONFIRMED 2026-03-20:
```
Col 52: R2_CDStart             confirmed
Col 53: R2_CDPause1
Col 54: R2_CDResume1
Col 55: R2_CDPause2
Col 56: R2_CDResume2
Col 57: R2_CDPause3
Col 58: R2_CDResume3
Col 59: R2_RideStart           confirmed
Col 60: R2_RidePause1
Col 61: R2_RideResume1
Col 62: R2_RidePause2
Col 63: R2_RideResume2
Col 64: R2_RidePause3
Col 65: R2_RideResume3
Col 66: R2_RideEnd             confirmed
```

### Round 3 Block (cols 67-81) — unused for standard 2-round classes:
```
Col 67: R3_CDStart
Col 68: R3_CDPause1
Col 69: R3_CDResume1
Col 70: R3_CDPause2
Col 71: R3_CDResume2
Col 72: R3_CDPause3
Col 73: R3_CDResume3
Col 74: R3_RideStart
Col 75: R3_RidePause1
Col 76: R3_RideResume1
Col 77: R3_RidePause2
Col 78: R3_RideResume2
Col 79: R3_RidePause3
Col 80: R3_RideResume3
Col 81: R3_RideEnd
```

### Elapsed Time Calculation (TIMY):
```
Elapsed = (RideEnd - RideStart) - sum(all RidePause/RideResume durations)
```

---

## FARMTEK TIMING NOTES

Farmtek is optical beam timing — no TOD timestamps written to .cls file.
Cols 36-80 will all be 00:00:00 for Farmtek (J type) classes.
On-course detection for Farmtek must use header-level flags only.
Timer start/stop detected by R1Time/R1Place appearing in entry row.

---

## TSKED.CSV STRUCTURE

```
Row 1:  ShowName, ShowDates
Row 2+: ClassNum, ClassName, Date, Flag
```

### Flag values (col 3):
```
S       = Scored/Complete — confirmed seen on class 47 after scoring
JO      = Order of Go posted
(blank) = standard class, no special flag
```

---

## CONFIG.DAT STRUCTURE

First line is comma-separated:
```
Col 0:  SerialPort         "Select COM port..." or "COM7"
Col 1:  UDPPort            29696 (scoreboard port, 29697/98/99 for other rings)
Col 2:  ?                  "FDS"
Col 3:  ServerIP           "68.178.203.100" (Ryegate FTP server)
Col 4:  FTPPath            "/SHOWS/HITS/Culpeper/2025/Summer/wk12/r1"
Col 5:  FTPUser            "ftpryegate01@ryegate.com"
Col 6:  FTPPassword        " " (space = blank/stored elsewhere)
Col 24: ShowURLSlug        "hits-east" (maps to ryegate.live show URL)
```

Subsequent lines:
```
Line 1: comma-separated config values
Line 2: unknown numbers
Line 3: unknown numbers
Line 4: C:\path (download path)
Line 5: (Show Name) placeholder
Line 6: (Dates) placeholder
Line 7: Location placeholder
Line 8: Footer 2 (judges CD or timing)
Line 9: C:\path (desktop path)
```

### KEY FIELDS FOR AUTO-CONFIGURATION:
- FTPPath (col 4) → show/ring/week → maps to KV show structure
- ShowURLSlug (col 24) → maps to ryegate.live URL for show discovery
- UDPPort (col 1) → scoreboard UDP port (29696 = ring 1)
- Ring number extracted from FTPPath: /r1 = ring 1, /r2 = ring 2 etc.

---

## STILL UNKNOWN — JUMPER HEADER
```
Col 4:  timer type flag? (1=Farmtek, 2=TIMY — needs confirmation)
Col 5:  ClockPrecision — confirmed changes but encoding unknown (.01, .001 etc)
Col 6:  unknown flag (always 1 after format)
Col 7:  unknown flag (always 1 after format)
Col 18: False on format — unknown
Col 20: unknown
Col 21: value 2 on format — unknown
Col 24: False on format — unknown
Col 27: True on format — unknown
NumRounds: H[04]=1 for Farmtek, H[04]=2 for TIMY — may be timer type not rounds
           Needs targeted test: change rounds, press marker
```

## STILL UNKNOWN — JUMPER ENTRY
```
Col 18: unknown
Col 19: seen values 4, 8 — possibly raw rail count × 4
Col 20: mirrors col 19
Col 21: unknown
Col 23: unknown
Col 26: unknown
Col 27: unknown
Col 28: unknown
Col 29: unknown
Col 30-34: unknown
```

## STILL UNKNOWN — HUNTER HEADER
```
Col 2:  ScoringSubtype? — 0=standard, 1=U/S, 2=Derby/Classic (needs confirmation)
Col 5:  unknown — does NOT reliably indicate U/S
Col 7:  1=standard, 2=International Derby only — purpose unclear
Col 9:  always 4 — not NumJudges, purpose completely unknown
Col 13: True/False — varies, needs toggle test
Col 14: True/False — False on Championships/U/S, needs toggle test
Col 17: True on 501.cls only — needs toggle test
Col 18: 1=International Derby only — needs toggle test
Col 33: always 2 — unknown
Col 35: True=International Derby only — needs toggle test
All unknowns need live header toggle screen recording
```

## STILL UNKNOWN — HUNTER ENTRY
```
Col 12: rarely populated — seen one derby entry with a number
Col 46: small number (2-3) on derbies — possibly bonus fence count
Col 47: small number on classics only — unknown
```

---

Last updated: 2026-03-20 (Session 10 — hunter entry cols confirmed, 97-class analysis, UDP protocol mapped)
