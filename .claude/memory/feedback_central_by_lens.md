---
name: Centralize formatting; central by lens
description: Bill's architectural directive — lens-specific concerns in lens-specific modules; only true cross-lens primitives are shared. No inline duplication across pages.
type: feedback
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
Every formatting/display decision goes through shared modules. Lens-
specific concerns (jumper vs hunter) get their own modules. Pages are
thin glue.

Three layers:
- Cross-lens primitives: `west-format.js`, `west-status.js`, `west-rules.js`
- Lens-specific: `west-jumper-templates.js` (built), `west-hunter-templates.js` (planned), `west-cls-{jumper,hunter}.js`
- Page glue: `show.html`, `ring.html`, `class.html`, future `live.html` / `stats.html` / `display.html`

**Why:** Bill 2026-04-25 — "i dont want to monkey with Flag graphics in
future locations (display, results, Stats, Live, other possible display
configurations)." The same point applies to time formatting, place
ordinals, status labels, country flags, etc. If you change "32.757s" →
"32.76s" once in `west-format.js`, every surface updates. If you'd left
it inline, you'd be hunting through 5 pages plus the templates module.

**How to apply:**
- When you find yourself copy-pasting a primitive between pages, move it
  to the right shared module FIRST, then call from both pages.
- Lens-specific helpers (e.g. jumper round-cell rendering) belong in
  that lens's templates module, NOT in cross-lens primitives.
- Cross-lens helpers (time, faults, ordinals, status code dictionary,
  flag map, escape, place ordinal logic) live in `west-format.js` or
  `west-status.js` — never in a templates module.
- A jumper module never reaches into hunter data shapes or vice versa
  (Article 1 / classType-is-gatekeeper rule applies here too).
- See [JS-MODULES-AND-PAGES.md](docs/v3-planning/JS-MODULES-AND-PAGES.md)
  for the current ledger of "edit X here, nowhere else."
