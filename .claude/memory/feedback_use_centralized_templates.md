---
name: Use centralized templates for standings
description: When rendering jumper/hunter standings on any page, call WEST.jumperTemplates / WEST.hunterTemplates — never reinvent the table
type: feedback
originSessionId: c85fc7d4-2e35-4918-83be-0b377611108d
---
When porting standings tables to any page (live, class, ring, stats, future ring-display), use the centralized template modules in `v3/js/`:

- **Jumper / timing**: `WEST.jumperTemplates.renderTable(cls, entries, { layout })`
- **Hunter / equitation**: `WEST.hunterTemplates.renderTable(cls, entries, { layout, judgeGrid })`

**Why:** these modules are the single source of truth for placement rules (`jumperPlaceFor` / `hunterPlaceFor`), DnsLike filtering, championship Ch/Res markers, flag-policy gating, per-method round-cell layout, **method-aware round labels** (R1/JO, Phase 1/Phase 2, R1/R2/R3 — see `WEST.format.roundLabel(method, modifier, n)`), and **most-recent-round-first stacking for jumpers** (Bill 2026-04-27 directive).

**How to apply:**
- Don't hand-code `<table>` markup with hard-coded labels like "R1" / "JO" — call the template
- The template emits stable class names (`results-table`, `entry-place`, `entry-horse-rider`, `entry-round-stack`, etc.) styled by `west.css`; styling stays consistent across pages by virtue of using the same renderer
- Lab files (live-lab, show-lab) hard-code labels for visual iteration only — production must call the template
- If a page needs a layout the templates don't support, add a new `layout` option to the templates rather than forking the rendering

**Reference:** docs comment at `v3/pages/class.html:163-167` ("Single source of truth — the templates module per lens decides everything"), and the same pattern in `live.html` line 657 ("everything needs to call evenly no matter what page its on").
