---
name: Class final/complete only on explicit signal
description: Never mark a class as final/complete based on idleness or eviction — only the explicit 3× Ctrl+A CLASS_COMPLETE signal on port 31000 finalizes a class
type: feedback
originSessionId: c85fc7d4-2e35-4918-83be-0b377611108d
---
A class is only marked **final / complete** in response to the explicit operator signal: 3× Ctrl+A → CLASS_COMPLETE on port 31000 (Channel B focus signal channel).

**Why:** A class going quiet for a while is not the same as it being done. The operator might be at lunch, on a weather hold, between rounds, or just paused. Marking the class final on idle would prematurely lock it, hide it from the live page, and possibly trigger downstream completion actions (D1 status updates, stats finalization, championship awards) before the class is actually done.

**How to apply:**
- The 20-min stale-class eviction in `RingStateDO._buildSnapshot` (west-worker.js) removes a class from the live panel stack only — it does NOT touch D1 status, does NOT mark the class final, and does NOT fire any "class complete" downstream side effects. The class re-appears in the stack on its next 31000 focus packet.
- When wiring the actual CLASS_COMPLETE signal handling: that's the ONLY place a class should transition to final/complete state. It can update D1 (`shows.classes.status`), evict from the live `byClass`, and trigger any post-class actions.
- Don't add idle-time-based fallbacks that promote idle → complete. Idle stays idle.

**Reference:** `docs/v3-planning/UDP-PROTOCOL-REFERENCE.md` — port 31000 Channel B semantics. CLASS_SELECTED = 1× Ctrl+A; CLASS_COMPLETE = 3× Ctrl+A within 2s.
