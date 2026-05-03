---
name: Show flags policy — scoring computer is the only source
description: Country flags display is controlled solely by Ryegate's H[26] ShowFlags toggle. No per-page or admin override exists. Use WEST.format.flagFor() — never WEST.format.flag() — on public surfaces.
type: feedback
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
Country flag rendering on public surfaces is gated by `cls.show_flags`,
which mirrors the operator's Ryegate H[26] ShowFlags checkbox. When
operator unchecks ShowFlags in Ryegate and saves, the next .cls re-emit
flips H[26] to False, the worker parser writes show_flags=0, and flags
disappear everywhere on next page load.

**Why:** Bill 2026-04-25 — "the only place to change flags should rest
on the scoring computer.. (uncheck show flags, flags dissappear)."
Multiple display surfaces (results, live, stats, display, future
layouts) shouldn't be able to drift on this — the operator's choice is
THE choice.

**How to apply:**
- All public surfaces MUST call `WEST.format.flagFor(cls, entry)` —
  never `WEST.format.flag(code)` directly. flagFor bakes in the
  show_flags policy check; flag(code) is a primitive that bypasses it.
- Don't add a per-class override in admin — operator owns this in Ryegate.
- Don't add a per-page "always show" toggle — it would defeat the
  policy. If a future page genuinely needs always-on flags (e.g. an
  FEI-only page), build a separate primitive then, with the design
  intent reviewed.
- The FLAGS map (FEI 3-letter → emoji) lives in `west-format.js`. New
  countries appended there benefit every surface automatically.
- Active in WEST_DB_V3 as of 2026-04-25: `classes.show_flags` (added
  migration 014), defaulted 0 — most domestic shows leave it off.
