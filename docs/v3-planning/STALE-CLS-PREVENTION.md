# Stale .cls Prevention — engine-side work to do

**Status:** partial. Recovery shipped (admin Flush ring button + `/v3/flushRing`).
Prevention is still TODO on the engine side.

## The problem (Saratoga, 2026-05-07)

Operator pointed the engine at the Saratoga Spring Wk II computer. The
Ryegate watch folder still had ~49 .cls files from the prior week's test
session. Engine started, scanned the folder, and uploaded **everything** —
mixing last week's test entries (e.g. #34 KINGSTOWN, #43 AMERICAN ROAD,
#86 EMMY LOU in class 925) with this week's real scoring. Both surfaced
on the public site simultaneously. Operator caught it but the diagnosis
+ manual cleanup was painful.

Root cause: the engine has no concept of "is this file from this show or
the last one?" — it uploads anything in the watch folder.

## What shipped (recovery — done)

### `POST /v3/flushRing` (auth-gated)
[west-worker.js — search "POST /v3/flushRing"](../../west-worker.js)

Body: `{ slug, ring_num }`. Wipes for that (slug, ring_num):
- D1: classes, entries, entry_jumper_*, entry_hunter_*, class_jumper_stats,
  udp_events (filtered by show_id+ring_num), ring_live_segment
- R2: every object under `${slug}/${ring_num}/` prefix (paginated list+delete)
- KV: `ring-state:${slug}:${ring_num}`, `cls-last:${slug}:${ring_num}`
  (engine heartbeat intentionally preserved)
- DO: routes through `/class-action` action=flush_all to nuke in-memory byClass

Returns `{ ok, slug, ring_num, summary }` with deletion counts per layer.

Show row + ring row are **preserved** — the operator's config stays so the
engine has somewhere to write to on restart.

### Admin "🗑 Flush" button on each ring row
[v3/pages/admin.html — search "btn-ring-flush"](../../v3/pages/admin.html)

Type-to-confirm dialog (must type the ring number) so a misclick next to
"Edit" doesn't nuke a ring. Toast shows summary on success.

## What's NOT shipped (prevention — TODO on engine)

The recovery button works but it's a **manual** safety net. The real fix
is the engine refusing to upload stale files in the first place.

### Recommended: mtime gating

When the engine connects to a show:
1. Fetch `show.start_date` from `/v3/getShow?slug=...`
2. Scan the watch folder
3. **Skip any .cls whose mtime < show.start_date** (with a small grace
   buffer — say 24h before start_date, in case the operator pre-loads
   classes the day before)
4. Watch normally going forward

Why this works: a file's modification time can't lie about the past. If
Ryegate hasn't touched a file since last week, it's by definition not
part of this week's show.

Edge cases:
- **Mid-show engine restart**: recent files (post-start_date) still upload.
  Correct behavior — that's resume.
- **Operator opens an old class for reference**: Ryegate touches the file's
  mtime, file gets uploaded as fresh. Rare; admin Flush handles it.
- **Pre-show class config**: operator builds the class list the day before.
  The 24h grace buffer above covers this.

### Code touchpoints (engine)

- `v3/engine/main.js` — wherever the .cls watch loop / initial scan lives.
  Add the show start_date fetch on connect, store as a session-scoped
  `uploadCutoffMs`, gate file watcher events on `mtime >= uploadCutoffMs`.
- New function `shouldUploadCls(filePath, mtime, cutoffMs)` so the rule
  has one home and is easy to unit test.

### Optional belt-and-suspenders: connect-time prompt

If the watch folder has any .cls files when the engine first connects to
a show this session, show a one-time dialog:

> Found 49 existing .cls files in C:\Ryegate\Jumper\Classes
> 
> [ Upload all (last week's data?) ]   [ Use mtime filter (recommended) ]   [ Skip all ]

Default is mtime filter. Skip all = engine ignores everything in the
folder until a new file is created. Upload all = legacy behavior.

This is overkill if mtime gating is solid — only worth building if real
shows surface mtime edge cases.

## Why the worker doesn't auto-flush on its own

(Operator asked: "why can't the worker just detect fresh data and wipe
the old?")

The worker can't reliably distinguish:
- Engine restarted after lunch ← preserve data
- Engine switched to a backup laptop mid-show ← preserve data
- Engine crashed and reconnected 30s later ← preserve data
- New week, leftover test files ← wipe

All four look identical from the worker's side: a /v3/postCls arrives for
class N, and class N already exists in D1. There's no field on the upload
that says "this is a fresh session."

If we made the worker auto-flush on any restart-like signal, the operator
would lose their morning's work the first time the engine hiccups. That's
a much worse failure mode than test data showing up — test data is
visible and recoverable, deleted scoring isn't.

The signal **has** to come from one of:
- The operator explicitly (Flush ring button — shipped)
- The engine inferring fresh-vs-resume (mtime gating — TODO)
- The .cls content itself (date-based filtering — unreliable)

The mtime approach is "the engine follows itself" — it knows what's fresh
because it knows the show's date range.
