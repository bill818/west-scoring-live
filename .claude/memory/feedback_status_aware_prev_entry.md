---
name: previous_entry surfaces EL/RF/RT/WD status
description: _buildPrevEntry detects status as a round-attribution signal AND returns status_code/label/category/full so the just-finished banner can render eliminations.
type: feedback
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
The "Just Finished" banner on the public live page must update when
the on-course rider was eliminated / fell / retired / withdrew —
not just when they completed cleanly with a time + faults.

**Why:** Bill 2026-05-07: "if a rider had fall or elim in the live
box the previous rider box wouldn't update with that." Pre-fix
`_buildPrevEntry` only attributed a round when total_faults /
total_time / score_total had data. An eliminated rider has none of
those — the round they fell in is recorded ONLY via `r{N}_status =
'EL' / 'RF' / 'RT' / 'WD'`. Detection missed them, returned null,
and previous_entry stayed on the prior clean rider indefinitely.

**How to apply:** `_buildPrevEntry(row, classKind, classMeta)` in
west-worker.js detects a round if any of total_faults / total_time /
score_total / status (`r{N}_status` for jumper, `r{N}_h_status` for
hunter) is non-null. Status decoded via `_decodeOnCourseStatus` and
surfaced as `status_code` / `status_label` / `status_category` /
`status_full` on the returned record. **classMeta is the third arg
(added 2026-05-08) so hunter rows can resolve which round was
*displayed* — see `_decodeHunterDisplayedRound`** for the subset-match
algorithm. Returned hunter records also carry `displayed_score`,
`displayed_round_label`, and `displayed_is_overall` so the banner
doesn't have to recompute Overall vs R1/R2/R3 client-side.

`_samePrevEntry` also compares `status_code` so a clean→EL flip on
the same entry/round still triggers the update (faults/time/place
might still be null on both sides).

**Page rendering:** the just-finished banner in live.html shows the
status_label ("EL"/"RT"/"WD") in the F slot and status_full ("Rider
Fall" / "Retired" / etc) in the Time slot when status is present.
Falls back to F/Time/Rank when status is null (clean ride).

**Related:** focus_preview (M4 lower-third on-course display) uses
the same `_decodeOnCourseStatus` helper — they share the dictionary.
