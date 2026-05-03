---
name: Judges grid build — rollback point
description: Pre-judges-grid known-good commit on main. If migration 018 / compute pass / new endpoints / templates renderer cause regressions, reset main to f75c05f and the system returns to session-35 working state.
type: project
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
**Rollback point:** `f75c05f` on `main`, 2026-04-25 ~17:42 ET — session-35
commit ("v3 Session 35: hunter templates + named gates + results
polish"). Bill flagged this before authorizing the judges-grid build.

If the judges-grid work introduces any regressions:

```
cd /Users/billworthington/Projects/west-scoring-live
git reset --hard f75c05f
git push origin main --force-with-lease   # only if already pushed
```

D1 schema additions from migration 018 stay even after a code rollback
— they're additive (new columns nullable, new table doesn't break
existing reads). The added rank columns just go unused.

Worker also needs rolling back to the pre-018 deploy. The pre-018
worker version was `f0001507-72cd-41c6-94a9-391e6c969f38`. To revert:
re-deploy from the rolled-back code via wrangler.

**Why this memory exists:** complex migration + new endpoints + new
renderer all landing together = real chance of subtle break. Bill's
"this is the go back point if needed" is the explicit safety valve.
