---
name: Banner Round-vs-Overall pacing — design decision to revisit
description: The just-finished banner currently mirrors the operator's display sequence (round score first, Overall a few seconds later). Pinned to revisit whether to short-circuit straight to full breakdown.
type: project
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
**Current behavior** (as of 2026-05-08, west-worker `_buildPrevEntry`):
The banner_slots reflect what `combined_total` is at promote time.
For a hunter rider finishing R2 in a 2-round class, the operator's
button-press sequence drives the banner:

1. Operator releases R2 alone → `combined_total = R2` → banner shows
   single-round "Score N" (because the subset matcher resolves to
   {R2} only).
2. A few seconds later, operator releases Overall → `combined_total
   = R1 + R2` → `_samePrevEntry` detects the change → banner
   re-promotes with `R1 / R2 / Overall / J1 / J2 / Rank`.

The gap is operator cadence between button presses, not a bug.

**Why:** keeps the public banner faithful to what's currently on the
ring's scoreboard. Spectator sees the same number the announcer is
saying.

**Why we might revisit:** for spectators it's confusing to see
"Score 77" briefly then jump to "Overall 163" — they read the first
number as the entry's actual score. The brief mismatch is the cost
of fidelity-to-scoreboard.

**Alternative we'd consider:**
- Always render `R1 / R2 / Overall / Rank` the moment >= 2 rounds
  have any score, regardless of what the operator has currently
  released to the scoreboard.
- Compute Overall ourselves as `r1 + r2 (+ r3)` instead of reading
  `combined_total`.
- Trade-off: spectator banner can be "ahead" of the scoreboard,
  showing the math before the announcer has even said it.

**Status:** Bill 2026-05-08 "fair enough lets pin that to think
about later." Not a bug, deliberate design. Revisit if spectator
feedback shows the pacing is confusing.

**Code locations:**
- `_buildPrevEntry` in west-worker.js — banner_slots construction
- `_decodeHunterDisplayedRound` — subset matcher that defines what
  "the operator just released" means
- `_samePrevEntry` — judges_sig + combined_total + displayed_round_label
  comparison that triggers re-promotes
