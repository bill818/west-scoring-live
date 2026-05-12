---
name: Engine mtime gating — DONE 2026-05-11 (engine v3.1.7)
description: Stale-cls prevention shipped. Engine v3.1.7 refuses uploads outside start_date..end_date+24h; TEST shows + TEST classes bypass. Saratoga 2026-05-07 root cause fixed.
type: project
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
**SHIPPED 2026-05-11 in engine v3.1.7.** Everything below is historical
context for why this work happened; the code is in place.

Engine refuses to upload .cls files older than the connected show's
start_date (with 24h end grace). Without it, opening the engine on a
computer with leftover .cls files from a prior week dumps last week's
test data into this week's show.

**Why:** Saratoga 2026-05-07 incident — operator pointed engine at
saratogaspring-wk2, watch folder had ~49 leftover .cls files from a
prior week, all uploaded and mixed with this week's real scoring.
Visible to spectators. Diagnosis + manual cleanup was painful.

**Final implementation (3.1.7):**
- `fetchShowMeta()` in main.js pulls `{ start_date, end_date, is_test }` from `/v3/getShow` on startup, show change, and a 5-min interval. Sticky cache survives transient fetch failures.
- `shouldUploadCls(filename, mtimeMs, bytes)` returns `{ allow, reason }`. Bypass for `showMeta.is_test`, bypass for parsed `class_name` matching `/test/i`, otherwise enforce `start_date <= mtime <= end_date + 24h`.
- Gate runs inside `postClsFile` before every upload. Blocked files counted + logged + surfaced in renderer state.

**Pre-existing recovery (unchanged):**
- `POST /v3/flushRing` (auth-gated) wipes D1 + R2 + KV + DO state for a (slug, ring_num) pair, preserves show + ring config
- "🗑 Flush" button on each ring row in admin.html (type-to-confirm)

**Don't auto-flush at the worker.** Operator asked about this — the worker can't tell "engine restart after lunch" from "fresh week with stale files." All look identical from the upload path. Auto-flush would nuke a morning's scoring on any engine hiccup. Signal comes from the engine (mtime, which can't lie about the past) or the operator (Flush button).
