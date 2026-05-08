---
name: Adobe Fonts kit (dcn7wbu) — what's loaded
description: Kit ID, families included, how to add/swap weights. No domain allowlist needed for Adobe Fonts kits.
type: project
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Bill's Adobe Fonts web project for west scoring. Loaded via
`@import url('https://use.typekit.net/dcn7wbu.css')` in
v3/pages/west.css.

**Families currently in the kit** (each shipped at weights 400 + 700,
both styles):
- `gotham-black` — display workhorse (headlines, IN RING, class panels)
- `gotham-xnarrow-book` — narrower cut for wordmark + show titles
- `gotham-narrow-xlight`, `gotham-condensed-thin` — light variants,
  not currently wired
- `acumin-pro-condensed-black` — heavy + condensed, reserved for the
  scoreboard `--font-numeric` token (not yet wired)
- `industry-black` — alternate condensed display, available as a
  fallback in `--font-numeric`
- `source-code-pro-black` — replaces JetBrains Mono for `--font-mono`
- `inter-18pt-black` / `inter-24pt-black` / `inter-28pt-black` —
  optical-size Inter cuts. Body keeps loading Inter from Google Fonts
  for the regular weights (Adobe ships only the Black cut here)
- `hoefler-txt-black` — extra serif, available for editorial flair
  if any pages want it later

**No domain allowlist needed.** Adobe removed the per-project domain
allowlist when they unified Typekit into Creative Cloud (~2020).
Common gotcha: old Typekit guidance from blog posts says to add
domains. Ignore it. Kit works on any site that loads the embed link.

**Adding more weights:** fonts.adobe.com → Account menu → My Adobe
Fonts → Web Projects → "west scoring" (project ID dcn7wbu) → click
the family → "</> Web Project" button → check more weights → save.
The kit reloads automatically; no embed-tag change needed. Cache may
hold ~5 min on already-loaded pages.

**Why some Gotham cuts are odd weights:** Adobe Fonts identifies each
family by its named cut + weight, mapped to standard CSS weights.
"gotham-xnarrow-book" ships as TWO weights (Book = 400/normal, plus
a Bold = 700) under the same identifier. CSS just references the
identifier and picks weight; Adobe serves the right file.

**See also:** `project_design_rollout.md` for the type-system tokens.
