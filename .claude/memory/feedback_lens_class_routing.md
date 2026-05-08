---
name: Route body scores by lens class, never to focused_class_id
description: pickScores() in west-worker.js routes body.jumper_scores / body.hunter_scores into byClass[lensClassId] (the class the LAST UDP event was for), with an empty-overwrite guard. Never write to byClass[focused_class_id] blindly.
type: feedback
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Body-of-update score arrays (`body.jumper_scores`, `body.hunter_scores`
on `/v3/postCls`-style writes through `_updateByClass`) belong to
**whatever class the last UDP event was for** — `lensClassId` derived
from `last_scoring.class_id || last_focus.class_id`. They do NOT
necessarily belong to the operator's currently focused class.

**Why:** Bill 2026-05-08, class 341 Saratoga: live page suddenly went
"Awaiting standings…" mid-class. Class had real scores in D1 the whole
time. Root cause: `_updateByClass` was writing scores into
`byClass[focused_class_id]` regardless of which class the body's score
arrays actually came from. When the operator clicked through another
class on Ryegate, focused_class_id flipped, and the next /v3/postCls
write (still carrying class 341's scores in its body) silently
clobbered byClass[other_class] while leaving byClass[341] stale. From
the page's perspective, 341 lost its standings even though they were
still in D1 and in the body of every postCls.

Same shape was the root cause of class 326 going "Awaiting
standings…" — a `pullJumperScoresV3` mid-stale-sweep returned `[]`
which then overwrote populated `byClass[326].jumper_scores`.

**How to apply:** every write of body scores into `byClass[*]` goes
through `pickScores(bodyScores, priorScores, bodyClassMeta,
focusedClassId)`:

1. **Lens routing**: prefer `bodyClassMeta?.class_id` (the lens of the
   incoming body); fall back to `focusedClassId` only if metadata is
   missing.
2. **Empty-overwrite guard**: if `bodyScores` is `[]` (or null) and
   `priorScores` already has content, **keep prior**. Don't trust an
   empty array from a stale-sweep window.
3. Returned object: `{ classId, scores }` — caller writes
   `byClass[classId].jumper_scores = scores` (or hunter_scores).

The same empty-overwrite rule must hold on every other code path that
writes scores arrays — `/scores-update` already has its own guard
(b95f9de). Add the guard at the boundary, never above it.

**Don't** add "fallback to focused" logic that re-introduces the
write-to-wrong-class bug. The lens IS the body. Focus is for **what
to broadcast back**, not what to write.

**Reference:** commit fcb3fa2 (`_updateByClass` rewrite), b95f9de
(`/scores-update` empty-overwrite guard). class 341 self-healed in 8
seconds post-deploy.
