---
name: Design rollout — Gotham via Adobe Fonts
description: Site-wide type system — Gotham (Adobe Fonts) for display, Inter (Google) for body, Source Code Pro for mono. Black palette. Kit ID dcn7wbu.
type: project
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
v3 visual direction confirmed by Bill 2026-05-07. The earlier "G combo"
(Big Shoulders Display + Inter + JetBrains Mono, 2026-05-03) didn't
land — too college-stadium / sport-y vs the polished NBC-broadcast
feel Bill was after. Swapped to Gotham via Adobe Fonts (Creative
Cloud sub).

**Type system (current):**
- `--font-display: 'gotham-black', 'Big Shoulders Display', sans-serif`
  — headlines, IN RING badges, class panel names
- `--font-body: 'Inter', system-ui, sans-serif`
  — body text, panels, UI. Inter still pulls from Google Fonts since
  Adobe Fonts only ships the heaviest Inter cut.
- `--font-mono: 'source-code-pro-black', 'JetBrains Mono', monospace`
  — debug strip, batch IDs, data labels
- `--font-numeric: 'acumin-pro-condensed-black', 'industry-black',
  'gotham-black', sans-serif` — DEFINED but not yet wired into the
  scoreboard clock/time/faults selectors. Available for the ESPN-
  ticker upgrade when ready.

Plus targeted overrides:
- `.logo-west`, `.app-header .brand-name`, `.show-title` use
  `gotham-xnarrow-book` weight 700 (narrower brand-mark cut). The
  default Gotham Black felt fat at brand-mark size; X-Narrow keeps
  the geometric Gotham character with tighter horizontal proportions.

**Adobe Fonts kit:** ID `dcn7wbu`, loaded via `@import` in v3/pages/
west.css (alongside Google Fonts for Inter). Adobe Fonts removed the
domain allowlist requirement years ago — the kit works on any site
that loads the embed link. See `project_adobe_fonts_kit.md` for what's
in it and how to add weights.

**Palette (unchanged from prior rollout):**
- `--navy: #0a0a0a` (deep black brand surface)
- `--navy-2: #1a1a1a`, `--black: #111`, `--red: #b82025`,
  `--green: #2e7d32`, `--gold: #c9a440`
- `--off-white: #f7f7f8`, `--row-bg: #fff`, `--row-bg-hover: #f3f5f9`
- `--border: #e5e7eb`, `--border-strong: #cdd2d9`
- `--text-body: #1f2937`, `--text-muted: #6b7280`, `--text-faint: #9ca3af`

**How to apply:** Edit `v3/pages/west.css` — the central stylesheet
loads the kit + defines the tokens. Per-page overrides go in the
component selectors that need them. Never @import the kit per page;
west.css is the single source of truth (see `reference_west_css.md`).
The lab pages (font-lab, index-lab-black) reference the OLD type
system on purpose — kept as historical comparisons, not deployed.
