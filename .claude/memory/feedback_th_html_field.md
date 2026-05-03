---
name: Table-header column descriptors support h.html for raw HTML
description: Th renderers in jumper + hunter templates accept either h.label (escaped) or h.html (raw). Use h.html only when a column header genuinely needs internal markup (multi-line stacks, future composite headers); default to h.label.
type: feedback
originSessionId: 9024d026-0951-451f-8a07-0033a87c38ac
---
The four `th` renderers in `v3/js/west-jumper-templates.js` and
`v3/js/west-hunter-templates.js` (renderTable + renderStackedTable on
both lenses) accept column descriptors with either:
- `h.label` — string, runs through `escapeHtml` (the default, safe).
- `h.html`  — string, used as-is (escape-bypass — caller is responsible).

The renderer prefers `h.html` when present:
```js
var content = h.html != null ? h.html : escapeHtml(h.label);
return '<th class="' + escapeHtml(h.cls) + '">' + content + '</th>';
```

**Why:** Bill 2026-04-25 (session 37) — the standings identity column
needed a 3-line header (Horse-Rider / Owner / Breeding) with the
Breeding line hideable on phone via a CSS class on one of the spans.
Squeezing that into a `\n`-string + `white-space:pre-line` would have
worked but couldn't carry per-line CSS classes for the breakpoint hide.
The `h.html` field is the explicit escape-hatch.

**How to apply:**
- New columns default to `{ label: 'Pl', cls: 'entry-place' }`. Don't
  reach for `h.html` unless the header genuinely needs internal markup.
- Wrap each line in `<span class="hd-line">…</span>` — the shared CSS
  rule `.results-table thead .hd-line{display:block;line-height:1.35;}`
  stacks them.
- Add a per-line class (e.g. `hd-breeding`) only when you need to
  selectively hide / style a line at a breakpoint.
- The `escapeHtml(h.cls)` for the th's class attribute still runs —
  only the *content* is unsanitized when h.html is set. Keep `h.html`
  string-construction internal to the templates module (not user
  input).

**Where this is wired today:**
- `west-jumper-templates.js` buildHeaders (inline) + renderStackedTable
  (stacked) — identity column uses `h.html` with three `hd-line` spans.
- `west-hunter-templates.js` buildForcedColumns + renderStackedTable —
  same pattern, with riderPrimary swapping line 1 to "Rider-Horse".

A failed-and-reverted attempt (session 38) also used `h.html` for the
jumper round-column TA second line. Bill rejected the per-row TA in
favor of a hero subtitle — but the renderer still supports the
pattern; the helper (`buildRoundHeader`) was deleted along with the
revert.
