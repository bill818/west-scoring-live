---
name: Design rollout — black + G fonts
description: Confirmed visual direction for v3 site-wide rollout — Big Shoulders Display + Inter + JetBrains Mono on the black palette from the index-lab-black mockup
type: project
originSessionId: c85fc7d4-2e35-4918-83be-0b377611108d
---
Site-wide visual redesign confirmed by Bill 2026-05-03 after the font-lab Round 2 + index-lab pitches.

**Type system (G combo):**
- Display: Big Shoulders Display (weights 500–800)
- Body: Inter (weights 400–700)
- Mono / codes / labels: JetBrains Mono (400–500)

**Palette (black variant):**
- `--navy: #0a0a0a` (deep black, repurposes the "navy" token name from the mockup)
- `--navy-2: #1a1a1a`, `--black: #111`, `--red: #b82025`, `--green: #2e7d32`, `--gold: #c9a440`
- `--off-white: #f7f7f8`, `--row-bg: #fff`, `--row-bg-hover: #f3f5f9`
- `--border: #e5e7eb`, `--border-strong: #cdd2d9`
- `--text-body: #1f2937`, `--text-muted: #6b7280`, `--text-faint: #9ca3af`

**Source-of-truth mockups:**
- v3/pages/index-lab-black.html — full layout patterns (banners, show rows, ring previews, tabs)
- v3/pages/font-lab.html — combo G section is the type spec

**Why:** Round 1 fonts (Geist/Cabinet/Manrope/Fraunces) were "too polite" — the new system has the same commanding presence as the serif W in the WEST logo, but in sans. Equipe-inspired layout patterns (heavy section banners, fixed logo column, taxonomy tag meta line, expanded-by-default active row) keep scannability under multi-show / multi-ring conditions.

**How to apply:** Make changes in v3/pages/west.css (the central stylesheet — see reference_west_css.md). Roll out page by page; reference the lab pages for component patterns. Don't delete the lab pages — they remain the design reference until rollout is fully complete.
