---
name: Round labels — per-method via WEST.format.roundLabel
description: Round column labels are method-aware. Lookup driven by WEST.format.roundLabel(method, modifier, n) in west-format.js. The "keep generic R1/R2/R3" rule from session 34 has been superseded — Bill provided full per-method spec late session 34/35.
type: feedback
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
Round column labels (jumper) are method-aware as of session 35.
Centralized in `v3/js/west-format.js`:

```js
WEST.format.roundLabel(method, modifier, n)  // 1-indexed n
```

The `ROUND_LABELS` map keyed by scoring_method holds the per-method
strings (`Round 1 / Jump Off`, `Phase 1 / Phase 2`, empty string for
1-round methods, etc.). Templates module's `makeRoundTemplate` calls
this in `columns(cls)`.

**Historical context:** Earlier in session 34 Bill said "lets just keep
everything at R1 R2 R3 labels we can work on the Round Labels we can
add them back in." That was a temporary directive while the template
framework stabilized. Later in session 34/35 Bill provided the full
per-method spec; we built `roundLabel`. The generic-R1/R2/R3 phase is
done.

**How to apply:**
- Use `WEST.format.roundLabel(method, modifier, n)` for any new
  surface that needs round-column labels (live ticker, stats, display).
- Never hardcode `'R1'`, `'Round 1'`, `'Jump Off'` in template code —
  the formatter is the source of truth.
- Hunter rounds remain generic ("Round 1", "Round 2", "Round 3") in
  the hunter templates' stacked layout — no method-axis there yet.
  When derby gets specific labels (Classic / Handy), add a hunter
  section to `WEST.format.roundLabel` (or a parallel function).
