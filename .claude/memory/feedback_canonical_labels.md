---
name: Use canonical labels as-is, never re-prefix
description: Lookup tables hold the human-facing strings. Code does not decorate them with prefixes — page context establishes the rest. Adding "Hunter " on top of "Hunter Derby" is the bug to avoid.
type: feedback
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
Lookup tables in `west-format.js` (`HUNTER_MODES`, `DERBY_TYPES`,
`JUMPER_METHODS`, `HUNTER_SCORING_TYPES`, etc.) hold the canonical
human-facing string. Code that renders the label uses it AS-IS. Don't
decorate with extra prefixes.

**Why:** Bill 2026-04-25 — "we gotta work on your human speak ... why
not just use labels we gave it." Concrete bug: code rendered "Hunter
Hunter Derby · 2 rounds, 2 judges" because the template prefixed
"Hunter " on top of `HUNTER_MODES[2]` which was already "Hunter Derby".

**How to apply:**
- Look up the label, render it. Don't compose `'Hunter ' + label`.
- If you find yourself wanting a different prefix per case (e.g.
  "Hunter " on most modes but not on the one that already includes
  it), fix the LOOKUP TABLE — make the labels self-contained.
- Page context (header, breadcrumbs, prior content) establishes
  meaning. We don't repeat "Hunter " in the description line because
  the page is plainly about a horse show.
- Equitation overrides the mode label entirely (`'Equitation'`) —
  it's a discipline, not a sub-prefix on a mode.
- Derby variant labels (DERBY_TYPES) already contain "Derby" in their
  name — don't append " Derby".
