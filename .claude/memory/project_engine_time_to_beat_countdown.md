---
name: Engine UDP — time-to-beat live countdown + finish delta
description: Two paired ideas for repurposing the TTB display element during a class. (1) During on-course, when rider is within ±5s of TTB, swap static TTB for a live ±5 countdown. (2) On finish, when both rider and leader are CLEAR, swap TA for the time delta vs leader. Future engine + live-page work — not built yet.
type: project
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
**Idea (Bill, 2026-04-26):**
The funnel currently holds the "time to beat" (TTB) as a static value
during the on-course phase. New behavior: once the on-course rider's
elapsed time crosses within 5 seconds of the TTB, the display swaps to
a live signed countdown that runs from −5 to +5:

```
−5 ─────── 0 ─────── +5
ahead of TTB         behind TTB
```

When the rider is on the −5 → 0 side, they're ahead of the time to
beat (running faster). At 0 they're exactly tied. On the 0 → +5 side
they're falling behind. Visceral live-feel for spectators — instead of
abstract elapsed-vs-static-TTB, they see how the rider is closing in
or losing ground in real time.

**Where this hooks in (when implemented):**
- **Engine / funnel:** during on-course phase, while broadcasting the
  rider's elapsed time, also compute `elapsed - TTB` and broadcast it
  as a separate field once the absolute difference is < 5. Funnel emits
  the static TTB as today UNTIL that threshold is crossed; then emits
  the relative delta.
- **Live page UI:** subscribes to the new field; swaps the TTB
  display element (or its style) for a centered ±5 countdown indicator
  with a clear marker at 0. Color cues — green on −5..0 side, red on
  0..+5 side — make the lead/lag visually obvious.
- **Status semantics:** when the rider crosses 0 and goes positive,
  they've passed the TTB time without finishing yet — but jumper rules
  may impose faults that affect ranking, so the countdown is purely
  about pace, not final placement.

**Edge cases to handle:**
- TTB is null / no leader yet — countdown doesn't apply, stay on
  elapsed-only display.
- Rider eliminated or retires during the countdown — fall back to the
  killing-status display.
- Multi-round events (Method 13 II.2b immediate JO etc.) — TTB is the
  current jump-off leader's time, not the R1 leader's.

---

## Idea 2 — finish-time delta vs leader (paired with idea 1)

**Idea (Bill, 2026-04-26):**
On rider FINISH (not during on-course), swap the displayed TA (Time
Allowed) for the **delta between this rider's round time and the
current leader's round time** — but ONLY when both have a CLEAR
round (zero faults). The countdown idea above handles the on-course
phase; this handles the moment of finish.

```
Rider finishes 65.234, leader 64.987 → display "+0.247"  (slower)
Rider finishes 64.500, leader 64.987 → display "−0.487"  (took the lead)
Rider faulted → no swap; TA stays
Leader faulted (no clears) → no swap; TA stays
```

**Why "both clear":** comparing a 0-fault time to a 4-fault time
isn't the comparison spectators care about — fault counts dominate
ranking. The clean-vs-clean delta is the meaningful pace signal.
Faulted-vs-faulted comparison could be a future extension; for now
the gate is strict.

**Where this hooks in:**
- **Engine / funnel:** at FINISH frame, if (rider.r1_total_faults === 0
  AND leader.r1_total_faults === 0), compute `rider.r1_time -
  leader.r1_time` and broadcast as a finish-delta field. Otherwise emit
  null / no-swap.
- **Live page UI:** subscribes to finish-delta; if non-null, swap the
  TA display element for the signed delta. Same color cues as the
  countdown — green for negative (took the lead), red for positive
  (slower). Unsigned magnitude rendered in DM Mono with explicit
  `−` / `+` so the direction reads instantly.
- **Reverts to TA on next on-course start** — when the next rider
  starts, the field swaps back to the standing TA (or back to the
  countdown when that next rider crosses the ±5 threshold).

**Edge cases to handle:**
- No leader yet (this is the first clear of the class) — no swap;
  this rider IS the leader. Could optionally render a "★ NEW LEADER"
  badge instead of the delta. Future polish.
- Tied to the leader exactly (delta = 0) — display "0.000" centered
  with a tied indicator.
- Multi-round formats — leader is per-round (R1 leader for R1
  finishes; JO leader for JO finishes). Same per-round scoping as
  the countdown idea.

---

**Status:** **Both ideas — NOT BUILT.** Captured 2026-04-26 while
class-finalization signal + live-page work were both teed up but not
yet underway. Belongs in the live-page rebuild when that work
resumes; live UDP plumbing is the dependency.

**See also:**
- `docs/v3-planning/LIVE-PAGES-UI-SPEC.md` — live-page design (the
  consumer of this when it ships).
- `docs/v3-planning/UDP-PROTOCOL-REFERENCE.md` — UDP frame definitions
  (where the new field would land if it gets a dedicated frame).
