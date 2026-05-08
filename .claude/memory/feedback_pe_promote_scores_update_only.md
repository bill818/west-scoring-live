---
name: previous_entry promoted ONLY by /scores-update (sig-diff)
description: pe is now promoted exclusively in /scores-update via signature-diff, not in _updateByClass. Eliminates the flash from UDP-event-fires-before-postCls-row-write race.
type: feedback
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
`previous_entry` is set ONLY inside `/scores-update` (the path called
from `/v3/postCls` after fresh row data is in D1). `_updateByClass`
(called from `/v3/postUdpEvent`) does not touch `previous_entry`.

**Why:** Bill 2026-05-08 — "just wait for the data to write and
process and then show everything." UDP events arrive ~500ms before
`/v3/postCls` writes the score row, so any pe promote in
`_updateByClass` used a stale row. The banner flashed single-round
state, then refined to the full breakdown when `/scores-update`
caught up. Both case (a) [same rider, row updated] and case (b)
[transition, rider changed] could trigger this race in different
ways. Removing the entire pe-promote logic from `_updateByClass`
collapses both paths to a single visible update.

**How `/scores-update` picks the promote target:**
Signature-diff. Compare `body.hunter_scores` (just written) against
`existing.hunter_scores` (prior state) and find the entry whose row
data CHANGED. That's the rider who just got a new score released.
Signature includes:
- r1/r2/r3 score totals + faults + times + statuses
- combined_total
- current_place, overall_place
- judges (round:idx:base:hiopt:handy joined)

This sidesteps `last_identity` entirely — by the time
`/scores-update` fires, `last_identity` may have already flipped to
the next on-course rider. The diff finds X regardless.

**Trade-off:** brief gap on rider transitions where the banner stays
on the previously promoted entry until `/v3/postCls` for the
just-finished rider completes. Bounded by .cls write latency
(~few hundred ms). Single clean update wins over snappier-but-flashy.

**Don't reintroduce pe-promote in `_updateByClass`.** It will look
like a quick fix for the gap delay but reopens the flash race.

**Reference:** commits `718cb26` (defer to /scores-update), `28ae9b8`
(remove case b too, sig-diff target detection). The earlier
`_updateByClass` promotion logic (case a / case b) is preserved
in commit history if the trade-off ever needs revisiting.
