---
name: Focused class only commits on B+intro pair
description: snapshot.focused_class_id requires the explicit Channel B + intro frame pair within ~1s. Bare Channel B clicks are operator browsing — not enough to commit focus.
type: feedback
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Focus on the public live page only flips when the operator gives an
explicit "this class, this entry, on course now" signal. That signal
is the B+intro pair: Channel B {29}=<class_id> on port 31000 AND a
fr=1 / fr=11 intro frame on Channel A within `LIVE_PAIR_WINDOW_MS`
(1000ms). A bare Channel B click is the operator browsing classes —
shouldn't flap the public panel.

**Why:** Bill 2026-05-07: "we have the 31000 and the intro as a pair
because this explicitly says this is the class we're on and this
entry is going... it's very explicit." Pre-fix the worker preferred
last_focus.class_id (Channel B alone), so the public panel shifted
to whatever class the operator clicked on Ryegate even without a
rider on course. Combined with chip-name desync, this surfaced as
"old number / new name" mismatches when operators browsed.

**How to apply:** `_focusedClassId(body)` in west-worker.js prefers
the most-recently-locked is_live class from `byClass` (where
`is_live=true` only after the pair fires + `last_live_event_at`
tracks when). Falls back to the eager Channel B / Channel A chain
ONLY when no class has paired yet — first focus of a fresh session,
or all live classes have un-lived (FINAL / timeout / clear / flush).
The eager fallback is needed so the page renders SOMETHING before
the first pair lands; don't remove it.

**Related — idle-ring identity flush:** When every class on the ring
goes un-live (RING_LIVE_TIMEOUT_MS = 30 min, FINAL, manual clear,
flush_all), `_buildSnapshot` also nulls top-level `last_identity`,
`last_scoring`, `last_focus`, `class_meta`, `focused_class_id`,
`focus_preview`. Without this the M4 live-box kept showing the last
rider's name/horse/clock for hours after the ring went silent —
those fields carry through `{...body}` independently of byClass
state. Gate is `liveClassIds.length > 0`.
