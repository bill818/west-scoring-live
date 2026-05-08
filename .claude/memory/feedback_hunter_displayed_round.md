---
name: Hunter "displayed round" decoded server-side
description: _decodeHunterDisplayedRound in west-worker.js subset-matches the displayed combined_total against released round scores so the banner knows whether it was Overall or R1/R2/R3 — page reads displayed_round_label/displayed_score, never recomputes
type: feedback
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
For hunter classes, the score the operator just announced (and that
should appear in the just-finished banner) might be a single round
(R1/R2/R3) or the **Overall** = sum of two or more released rounds.
The protocol doesn't tell you which directly — `combined_total` is
always present once any round is announced, but it might equal
`r1_h_score`, `r2_h_score`, or `r1+r2`, etc.

**Why:** Bill 2026-05-08, looking at the hunter just-finished banner
showing the wrong round label: "for overall that seemed like a patch
not a fix... yes fix it right while we have test shows to work with."
The first attempt was client-side: live.html guessed at Overall by
comparing combined_total to individual rounds. That bled
classification logic into the page (violates centralization). It also
got it wrong when two rounds tied or when phase scores summed
ambiguously.

**How to apply:** `_decodeHunterDisplayedRound(row, classMeta)` in
west-worker.js. Inputs:
- `combined_total` (announced score)
- `r{1..N}_h_score` (each released round's score, where N = num_rounds)

Algorithm:
1. Build `released = [{ n, score }]` for every non-null round score.
2. If `combined_total` exactly matches a single round score, that's
   the displayed round; return `{ round: n, label: roundLabel(...),
   score, is_overall: false }`.
3. Otherwise iterate non-empty subsets of `released` (size ≥ 2),
   compute their sum, and find the LARGEST subset whose sum equals
   combined_total. That's Overall over those rounds; return
   `{ round: null, label: 'Overall', score: combined_total,
   is_overall: true, rounds_in_overall: [...] }`.
4. Largest-subset preference handles the edge case where r1 = r2 +
   r3 by coincidence — Overall trumps single-round.

Surfaced on previous_entry as `displayed_score`,
`displayed_round_label`, `displayed_is_overall`. Live page reads them
directly; never recomputes.

**Don't** push round-classification logic back into the page. Same
rule for any future "what was actually announced?" decision —
decoding belongs in the worker so live.html, results.html, and any
future ring-display surface render the same answer.

**Reference:** commit 1eafefe. Pairs with the centralized-templates
rule (`feedback_use_centralized_templates.md`) — the template
displays whatever the worker tells it, no inference.
