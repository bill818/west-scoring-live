---
name: Engine mtime gating — TODO (stale .cls prevention)
description: Prevention work for the stale-.cls problem (Saratoga incident 2026-05-07). Recovery shipped (Flush ring button); engine-side mtime gating still to do.
type: project
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Engine should refuse to upload .cls files older than the connected show's
start_date (with ~24h grace). Without it, opening the engine on a
computer with leftover .cls files from a prior week dumps last week's
test data into this week's show.

**Why:** Saratoga 2026-05-07 incident — operator pointed engine at
saratogaspring-wk2, watch folder had ~49 leftover .cls files from a
prior week, all uploaded and mixed with this week's real scoring.
Visible to spectators. Diagnosis + manual cleanup was painful.

**How to apply:** when building the engine .cls watcher logic, fetch
`show.start_date` on connect, store as session-scoped `uploadCutoffMs`,
gate watcher events on `mtime >= uploadCutoffMs - 24h`. Touchpoints:
`v3/engine/main.js` watch loop + initial scan. New helper
`shouldUploadCls(filePath, mtime, cutoffMs)` for unit testing.

**What's already shipped:**
- `POST /v3/flushRing` (auth-gated) wipes D1 + R2 + KV + DO state for a
  (slug, ring_num) pair, preserves show + ring config
- "🗑 Flush" button on each ring row in admin.html (type-to-confirm)
- Deferred-work writeup: docs/v3-planning/STALE-CLS-PREVENTION.md

**Don't auto-flush at the worker.** Operator asked about this — the
worker can't tell "engine restart after lunch" from "fresh week with
stale files." All look identical from the upload path. Auto-flush would
nuke a morning's scoring on any engine hiccup. Signal has to come from
the engine (mtime, which can't lie about the past) or the operator
(Flush button).
