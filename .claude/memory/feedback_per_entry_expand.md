---
name: Per-entry expand for detail views, never page-level toggle
description: Detail surfaces (judges grid today; future per-judge breakdown, derby components, history) expand inline beneath the clicked row, not via a page-level "View X" toggle that swaps the whole table. One click reveals one row's detail.
type: feedback
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
When adding a detail view that augments existing result rows (judges
grid, derby components, per-rider history, etc.), the right pattern
is **per-entry click-to-expand**, NOT a page-level toggle that flips
the whole table between modes.

**Why:** Bill 2026-04-25 (session 36) on the judges-grid build —
"that toggle view scores lives on the entry row under the round
scores. it only expands on the entry that is clicked not all of them
... and it expands down (drop down)."

**How to apply:**
- Each row gets a small affordance chip (e.g. "▸ View judges") under
  the score column so users see the row is expandable.
- A hidden detail row (`<tr class="...-detail-row">` or equivalent)
  follows the main row in the DOM, revealed by toggling `.is-open`
  via a click handler. No re-render — pure DOM toggle.
- Other rows are unaffected when one row expands.
- Page-level "Combined / Detail" toggle bars are an anti-pattern for
  this kind of per-row detail. They were tried first on the judges
  grid and rejected.
- The chip's arrow flips ▸ → ▾ on open. CSS handles the visual.
- Detail rows should not be a "load on click" pattern — pre-fetch
  the data (alongside main listEntries) so the toggle is instant.
  Adds ~no perceived latency for the multi-judge cases that warrant
  detail.

**Where this pattern is wired today:**
- Judges grid in [west-hunter-templates.js](v3/js/west-hunter-templates.js)
  — `injectJudgesHint`, `renderJudgeDropdownRow`, `renderEntryJudgeGrid`.
- Click handler in [class.html](v3/pages/class.html) — `wireJudgeDropdowns`.

**Future surfaces that should follow the same pattern:**
- Derby components per-judge breakdown (HighOptions / HandyBonus columns).
- Per-rider history / season summary (when stats page lands).
- Live-page on-course detail panel (when live work resumes).
