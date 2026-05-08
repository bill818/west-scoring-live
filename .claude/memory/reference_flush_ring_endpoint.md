---
name: /v3/flushRing — operator recovery for stale data
description: Auth-gated POST that wipes D1 + R2 + KV + DO state for a (slug, ring_num) pair. Show + ring config preserved. Admin "🗑 Flush" button on each ring row.
type: reference
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
Operator recovery tool for the "engine pointed at a venue with leftover
.cls files" scenario. Built after Saratoga 2026-05-07 incident where
~49 prior-week test files got mixed with current scoring.

**Endpoint:** `POST /v3/flushRing` body `{ slug, ring_num }` —
auth-gated. Wipes for that ring:
- D1: classes, entries, all entry_jumper_*/entry_hunter_*,
  class_jumper_stats, udp_events (filtered show_id+ring_num),
  ring_live_segment
- R2: every object under `${slug}/${ring_num}/` prefix (paginated)
- KV: `ring-state:slug:ring`, `cls-last:slug:ring` (engine heartbeat
  preserved)
- DO: routes through `/class-action` action=flush_all to nuke
  in-memory byClass + 15s cls_lock cooldown

Show row + ring row preserved. Engine restart re-populates.

**Admin UI:** "🗑 Flush" button on each ring row in admin.html
(ring-list). Type-to-confirm dialog (must type the ring number) so
a misclick next to "Edit" can't fire it. Toast shows deletion
counts on success.

**Operator must stop the engine first.** The worker doesn't enforce
it — a running engine will recreate rows mid-delete and leave a
partial wipe. The confirm dialog spells this out.

**Don't auto-flush at the worker.** Bill asked about this. The worker
can't tell "engine restart after lunch" from "fresh week / stale
files." Both look like /v3/postCls arriving for a class that already
exists. Auto-flush would nuke morning's scoring on any engine hiccup.
Signal must come from operator (Flush button) or engine-side
prevention (mtime gate — see `project_engine_mtime_gating.md`).

**See also:** `docs/v3-planning/STALE-CLS-PREVENTION.md` for the
incident writeup + engine-side mtime gating that's still TODO.
