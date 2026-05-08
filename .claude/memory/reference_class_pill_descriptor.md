---
name: Class pill + remaining-progress descriptor
description: Worker emits {state, label, progress, progress_label, total, remaining, gone} on every class entry and at top-level snapshot.pill. Pages render directly — no recompute.
type: reference
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Every class entry in `snapshot.classes[]` and `snapshot.pill`
(focused class) carries a pill descriptor:

```js
{
  state: 'final' | 'inring' | 'open',
  label: 'FINAL' | 'In Ring' | 'Open',  // display string
  progress: '27 of 40' | null,           // null when FINAL or empty roster
  progress_label: 'Gone' | null,
  total: 40,
  remaining: 13,
  gone: 27,
}
```

**Counts:** `total` = entries with a real entry_num. `remaining` =
entries that have NOT yet scored round 1 AND have no terminating
status (EL/RF/RT/WD). `gone` = total - remaining.

**FINAL state suppresses progress** — the pill alone tells the story.
For non-FINAL, the value `'27 of 40'` counts UP as riders go (was
originally `'13 of 40'` remaining; flipped because the number ticking
down read backwards).

**Page render** (live.html): pill on top, value `27 of 40` underneath,
small caps `GONE` label below. All centered as a tight stack on the
right side of the class header.

```
● IN RING
27 of 40
GONE
```

**Reusable for kiosk / ring display:** future surfaces just read
`snapshot.pill` or `class.pill` and render the same way. The pill is
also kept on every class in `classes[]` so a multi-class display can
show per-class progress.

**Built by `_buildClassPill(classEntry)`** in west-worker.js. Called
once per class in the snapshot map and once for the focused class at
top level.

**Reference:** commits `c6f6a13` (pill descriptor introduced),
`c702f7c` (count-up gone instead of count-down remaining), `ed0d658`
(value-over-label centered stack).
