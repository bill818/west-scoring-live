---
name: Engine flat-class wiring (NEXT SESSION TOP PRIORITY)
description: Hunter flat-class detection + ribbon results need wiring in the v3 engine. Frontend + snapshot contract + mock are already in place; only the engine UDP-event-to-snapshot plumbing is missing.
type: project
originSessionId: c85fc7d4-2e35-4918-83be-0b377611108d
---
**Status (2026-05-03):** Frontend renders flat-class layout when `snapshot.classes[i].flat_entries.length > 1`. Mock cycles through a flat hunter class to demo it. Engine doesn't emit flat_entries yet — that's the gap.

**Top-priority next session:** wire the v3 engine to produce flat_entries (and later, hunter_results for ribbons), mirroring v2's pattern.

## What's done (frontend + contract)

- **Snapshot contract**: each per-class entry in `snapshot.classes[]` now has `flat_entries` (Array | null). Each entry: `{ entry, horse, rider, owner, locale, isEq }`.
- **live.html `renderFlatClass(snapshot)`**: detects flat state on the focused class, hides `.live-box-grid`, shows `.live-box-flat` with the entry list. Banner text swaps to "Flat class in the ring".
- **CSS**: `.live-box-flat`, `.live-box-flat-count`, `.flat-list` (auto-fit grid `repeat(auto-fit, minmax(260px, 1fr))`), `.flat-entry`. Mobile reduces to single column.
- **Mock**: 4th class in the cycle is hunter flat (class 214), 8 entries. When focus rotates to it, live box swaps to flat list.

## What needs wiring in v3 engine

### 1. Frame 11 rotation → flat_entries (priority 1)

v2 pattern (`west-watcher.js:2451-2481`):
- On every frame 11 (hunter on-course/intro page A), extract `{1}` entry, `{2}` horse, `{3}` rider, `{4}` owner. For equitation, `{7}` is rider, `{2}` is empty, `{6}` is locale (city/state).
- Maintain a per-class `flatEntriesSeen` map keyed by entry number. Add new entries as they rotate through.
- Reset the map on a new class-select (1× Ctrl+A on port 31000) — different class ⇒ different rotation set.
- Build an ordered list `Object.values(flatEntriesSeen)` and post it to the worker on every frame 11.

In v3, this should land in the engine's UDP listener. Look at `v3/engine/main.js` around the existing frame 11 handling. Each batch posted to `/v3/postUdpEvent` should include `flat_entries: [...]` for the focused class. The worker DO will then store it in `byClass[classId].flat_entries` (the contract is already wired in `_updateByClass` — just needs the data to actually arrive).

### 2. Frame 14 → hunter_results / ribbon view (priority 2)

v2 pattern (`west-watcher.js:2488+`):
- Frame 14 = ribbon announcement. One entry per frame, with `{8}` = place ("1st", "2nd", ...), `{14}` = score (or empty for forced).
- Accumulate in `hunterResults` array as ribbons are called.
- Post each as a `HUNTER_RESULT` event so the live page can render ribbons in real-time.

Live page needs a third state alongside flat / single — a "ribbon results" mode that takes over the live box with the announced placements (with ribbon SVG icons, animating new arrivals). That CSS / render function is NOT yet built in v3 — defer until after frame 11 wiring.

### 3. Class-select reset (priority 1, same as #1)

When 31000 fires CLASS_SELECTED (1× Ctrl+A), reset `flatEntriesSeen` for the now-deselected class (or just for the newly-selected class — depends on how we model it).

## How to test once wired

1. `?mock=1` already demos the flat layout — visual confirmed
2. With real engine, point a Ryegate session at a hunter flat class; verify:
   - Frame 11 packets accumulate `flat_entries` in the snapshot
   - Live box swaps to flat list when 2+ entries seen
   - Class-select reset clears the list when operator changes class

## Where to look

- v2 engine: `west-watcher.js:2440-2520` (frame 11 + frame 14 handling)
- v2 worker: `west-worker.js:1430-1450` (flatEntries pass-through)
- v2 frontend: `live.html:558-621` (FLAT RESULTS + FLAT CLASS rendering)
- v3 engine: `v3/engine/main.js` (where frame 11 currently handled — add accumulation)
- v3 worker DO: already accepts `flat_entries` on per-class state via `_updateByClass`
- v3 live frontend: `v3/pages/live.html` `renderFlatClass()` and CSS for `.live-box-flat`
- UDP protocol reference: `docs/v3-planning/UDP-PROTOCOL-REFERENCE.md`
