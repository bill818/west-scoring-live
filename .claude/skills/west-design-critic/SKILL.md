---
name: west-design-critic
description: Critique web layout and design changes for the WEST Scoring v3 project. Use whenever the user edits CSS, changes a page layout, ports a page to the new design, picks colors or fonts, tunes spacing or column widths, addresses mobile responsiveness, asks "how does this look", "does this feel sleek", or wants design feedback. Knows the WEST design vocabulary — Big Shoulders Display + Inter + JetBrains Mono fonts, navy/black palette, section-banner + show-hero + ring-row patterns, the lab pages as canonical references. Use this skill BEFORE shipping any design change so the result stays consistent with the shipped design system, and use it whenever you're about to freestyle a layout decision (don't — critique your own draft against this first). Also use when the user nudges a column width, changes a font weight, asks about responsive breakpoints, or proposes a new card / panel / hero / table style.
---

# WEST Design Critic

Reviews layout and design changes for the WEST Scoring v3 project so the result stays **sleek, modern, and consistent** with the shipped design system. Default mode: critique a draft, then suggest the smallest specific change that makes it better. Don't redesign — nudge.

## Process for any design change

1. **Read the actual files first**, don't theorize. Look at:
   - `v3/pages/west.css` — current shipped tokens + rules
   - `v3/pages/index-lab-black.html` — original visual pitch
   - `v3/pages/show-lab.html` — show-page vocabulary
   - `v3/pages/live-lab.html` — multi-class stacked layout, responsive scaling
   - The page being changed
2. **Apply the design system below** — check the change against the established tokens, patterns, and rules.
3. **Give specific, actionable critique** — never generic. "Place column at 40px is wider than needed for a 1-2 digit number; try 28-32px to free up room for Horse/Rider" beats "spacing feels off."
4. **Default to small changes.** The design system is shipped and working. Suggest the smallest CSS or markup nudge that solves the problem.

## Design system

### Type system (G combo)

- **Display** — Big Shoulders Display (weights 500–800). Use for: page titles, hero names, place numbers, section banners, brand wordmark, big numeric values.
- **Body** — Inter (400–700). Use for: paragraphs, table cell text, form text, button labels.
- **Mono / codes / labels** — JetBrains Mono (400–500). Use for: small caps labels, status pills, monospace data, mono caps subtitles.

All three load via `@import url('...googleapis.com/css2?...')` at the top of `v3/pages/west.css`. CSS tokens: `--font-display`, `--font-body`, `--font-mono`. **Always use the tokens, never hard-code font names** — the centralized swap is the whole point.

### Palette

- `--navy: #0a0a0a` — deep black brand surface (section banners, brand mark, ring badges)
- `--navy-2: #1a1a1a` — secondary navy gradient stop
- `--off-white: #f7f7f8` — page background
- `--row-bg: #ffffff` / `--row-bg-hover: #f3f5f9` — content cards / table rows
- `--border: #e5e7eb` / `--border-strong: #cdd2d9` — dividers / focused borders
- `--text-body: #1f2937` / `--text-muted: #6b7280` / `--text-faint: #9ca3af` — three text levels
- `--red: #b82025` — accent for class numbers, live indicators, brand red
- `--green: #2e7d32` — clear rounds, live state, "go" indicators
- `--gold: #c9a440` — championship Champion tags
- `--blue` / `--amber` — admin status accents (kept for backwards compat; don't use for new design)

## Established patterns

When the change wants to do what one of these patterns already does, **use the existing pattern** — don't invent a parallel one.

- **App header** (`.app-header`): white background, sticky, compass logo + "WEST" wordmark + "SCORING.LIVE" mono caps tag + nav. Same on every page.
- **Page head** (`.idx-page-head` on index): big Big Shoulders title in navy + mono caps subtitle + filter input with optional tabs.
- **Show hero** (`.show-hero`): 3-column grid `[logo cell | info | side]`. Logo is 120×120 (or navy badge for ring page via `.show-hero-logo.ring-badge`). Big Shoulders name (~44px), Inter meta, mono caps location, side column for pills/buttons.
- **Section banner** (`.section-banner`): navy background, white Big Shoulders uppercase, optional count badge + pulsing dot when live (`.live` modifier). Use `.standalone` modifier for rounded corners when not followed directly by `.section-rows`.
- **Section rows** (`.section-rows`): white container with border, no border-radius on top (it sits flush under a section banner).
- **Row pattern**: `<li class="row-item"><a class="row" href="..."><logo|info|right-meta></a><optional preview sibling></li>`. Used by show rows on index, ring rows on show. The sibling-not-child preview avoids nested anchor problems (preview class items are `<a>` too).
- **Pill family**: `.live-pill` (green pulse), `.upcoming-pill` (indigo), `.past-pill` (gray faint). Same usage everywhere — status communication.
- **Standings tables**: NEVER hand-roll. Always call `WEST.jumperTemplates.renderTable(cls, entries, { layout })` or `WEST.hunterTemplates.renderTable(cls, entries, { layout, judgeGrid })` from `v3/js/`. They handle method-aware round labels (R1/JO, Phase 1/Phase 2, R1/R2/R3), recent-round-first stacking for jumpers, placement rules, championship markers, flag policy.

## Design rules

1. **Use the design tokens.** Never hard-code colors or font names — always reference `var(--*)`. If you see duplication, pull into a token.
2. **Use the centralized template modules** for any standings table — never reinvent.
3. **Recent round first for jumpers** — JO above R1, R3 above R2 above R1. Honor method-aware labels via `WEST.format.roundLabel(method, modifier, n)` instead of hard-coding "R1" / "JO".
4. **Mobile sleek means mobile-native, not scaled-down desktop.** When the user says "feels too big on phone": drop redundant labels (the "Entry" / "Clock" labels above identity / clock are the canonical case), collapse stacked stats to inline rows, ditch lower-priority columns (the standings Gap column is the canonical example), use a denser inline layout instead of stacked.
5. **Phone breakpoint is ≤640px.** Tablet/laptop is the default. TV/wide is ≥1600px (live box can break out wider via `.live-box-wrap-wide`). The dedicated kiosk / 30ft viewing surface is a separate planned page — don't make live.html try to serve that.
6. **Width constraint is 1100px** for content containers (page-wrap, section-banner, section-rows, hero blocks). Live box can break out wider on TV-class screens.
7. **Don't add features the change doesn't require.** A spacing tweak doesn't need a refactor. Small commits, small CSS deltas, small markup deltas. Match the user's scope.
8. **Centralize.** New rule belongs in `west.css` if ≥2 pages will need it. Page-specific rules go in the page's inline `<style>` block. Lab pages are standalone with their own inline styles — they don't link `west.css` and never should.

## Critique checklist

When reviewing a draft, run through:

- [ ] **Tokens used, not raw values?** Search the diff for hex colors and font-family strings. Any raw value is a flag.
- [ ] **Existing pattern reused, not reinvented?** "Could this be `.section-banner` instead of a fresh navy bar?"
- [ ] **Hierarchy clear?** Big Shoulders for the thing the eye should land on first, Inter for body, mono for labels. Not the other way around.
- [ ] **Spacing balanced?** Look at column widths, padding, gap. Is the most-important content (Horse/Rider, class name) getting room or being squeezed by less-important columns (Place, Faults, Time)?
- [ ] **Mobile considered?** At ≤640px, does it stack sensibly, drop redundant chrome, scale type proportionally? Does the show/ring breadcrumb wrap below the brand so the live pill stays visible?
- [ ] **Responsive without breaking the design at any size?** No "TA" wrapping awkwardly, no orphan separators, no clock font crowding the cell.
- [ ] **Consistent with the labs?** When in doubt, the lab pages are the source of truth. If the change diverges, justify or align.
- [ ] **Live data plumbing intact?** A design change should not break the data-render contract — IDs preserved, render functions still emit valid markup.
- [ ] **Accessibility basics?** Contrast on text-faint over off-white, focusable controls, semantic markup, alt text on images.

## How to write critique

**Be specific and actionable.**
- Bad: "spacing feels off."
- Good: "Place column at 40px is wider than needed for a 1-2 digit number — try 28-32px. That frees ~10px for Horse/Rider, which is currently truncating on Bridget Hallman."

**Be honest.** If the user asks "does this look good?" and it doesn't, say what's off. Generic praise wastes their iteration time.

**Match the user's vocabulary.** If they say "sleek," don't pivot to "minimalist." If they say "feels too big," don't over-engineer with breakpoints — just shrink what they pointed at.

**Verdict first, then reasoning.** When the user asks for an opinion, give it in one or two sentences, then explain. Don't bury the lede.

**Reference specific files and line numbers** when possible. `west.css:925` beats "the ring row CSS."

## Anti-patterns to flag immediately

- **"Just resize for mobile"** — that's how you get scaled-down-desktop, which the user has explicitly called out as not-sleek. Mobile needs its own information hierarchy, not just smaller fonts.
- **Inventing new pattern names** when existing ones fit. Adding `.results-card` when `.section-banner` + `.section-rows` already do that job.
- **Hard-coding fonts or colors.** Kills the centralized swap. Always token.
- **Hand-rolling standings markup.** Kills the placement-rule + round-label logic that lives in the templates.
- **Redesigning a page when the user asked for a tweak.** Match scope.
- **`!important` declarations.** Almost always a sign that the cascade is being abused — find the real conflict and resolve it.
- **Inline styles for anything reusable.** One-off positioning is fine; if you're inlining a pattern, promote it to a class.

## When this skill should NOT take over

- Pure data/logic changes that don't touch CSS or markup
- Backend / Cloudflare worker changes
- When the user is debugging a broken page (fix it first, critique later)
- When the user explicitly says "just make this work, don't critique"
- Lab files in pure exploration mode where the user says "I'm just sketching"

## Scope reminder

This skill is for **WEST Scoring v3 web pages** (everything under `v3/pages/`). It's tied to the specific design system, fonts, and patterns shipped for that project. It is NOT a general web design skill — if the user is working on a different project, this skill should pass.
