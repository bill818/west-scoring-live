---
name: Banner slots — worker decides shape, page iterates
description: just-finished banner uses pe.banner_slots from the worker; page just maps slots → spans. Single source of truth. Reusable across live.html, ring display, future surfaces.
type: feedback
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
The just-finished banner (and per-class panel banner) renders from
`pe.banner_slots` — an array `[{label, value, emphasize?}, ...]` the
worker builds in `_buildPrevEntry`. Page is a one-line iterator:

```js
jfStatsRow.innerHTML = pe.banner_slots.map(s =>
  `<span class="jf-stat${s.emphasize ? ' is-emphasis' : ''}">
     <span class="jf-stat-lbl">${esc(s.label)}</span>
     <span>${esc(s.value)}</span>
   </span>`
).join('');
```

**Why:** Bill 2026-05-08 — "this shouldn't have been this hard keep
it simple." The page used to have ~80 lines of branching (status vs
hunter vs jumper × single vs multi-round) and partial DOM overrides.
A scope bug in that mess (`esc` not defined inside `render()`) silently
killed the whole thing on mobile. Single iterator + worker-decided
slots removes the entire failure surface.

**Worker shapes (from `_buildPrevEntry`):**
- EL/RF/RT/WD: `Status / Reason / Rank`
- Hunter multi-round (rounds.length >= 2): `R1 / R2 / [R3] / Overall(emph) / J1 / J2 / Rank`
- Hunter single-round: `Score(emph) / J1 / J2 / Rank`
- Jumper / equitation: `F / Time / Rank`
- Single-judge classes skip the J slots
- Derby classes inline hi-opt + handy on judge slots: `J1 88+5+3`

**Adding new slot types** (equitation bonuses, jump-off splits, etc.):
push them into `bannerSlots` in the worker — page never changes.

**Page-side fallback (`computeSlotsFromPe`)** in live.html mirrors the
worker logic so pe records that pre-date `banner_slots` still render.
Keep the two in sync if logic changes.

**Reusable for ring display / kiosk:** any future surface reads
`snapshot.previous_entry.banner_slots` (or `class.previous_entry.banner_slots`
for non-focused) and renders the same way. No re-implementation of
EL/hunter/jumper detection.

**Reference:** commit `a6e4205` (banner_slots architecture introduction),
`822d327` (esc-scope bug — local helpers when adding new code blocks
inside `render()`).
