---
name: Engine → vMix local integration plan
description: Pinned plan for installing a WEST engine on the broadcast (vMix) computer, listening to Ryegate UDP locally, and writing scoring.json + a local HTTP/WS server for vMix Title sources and Web Browser Source overlays. Sub-100ms latency, no cloud round-trip.
type: project
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
**Status:** Planned 2026-05-10, not yet built.

**Where:** Full plan in `docs/v3-planning/ENGINE-VMIX-INTEGRATION.md`.

**Quick summary:**
- A second engine instance runs on the vMix computer, listens to the
  same Ryegate UDP broadcast as the operator engine.
- Outputs two things locally:
  1. `scoring.json` (atomic write on each event) — for vMix Title
     Designer's Data Source feature.
  2. Local HTTP + WS server (`http://localhost:8765`) — serves an
     `overlay.html` bundle that vMix loads as a Web Browser Source,
     plus a WS endpoint for real-time push (live clock).
- Operator's engine is unchanged — keeps posting to Cloudflare for
  the public web. The vMix engine is a passive UDP consumer with no
  cloud connection.

**Why local:** broadcast graphics need sub-100ms latency. Cloud
round-trip is 300-800ms — fine for spectator pages, not fine for
broadcast where viewers compare to the announcer's call.

**Build order:** extract a "snapshot core" library from
west-worker.js first (so cloud + local engines share the same
scoring logic), then UDP listener, then local server, then
overlay.html, then scoring.json writer.

**Reusable artifacts already built:**
- `v3/pages/scoreboard-lab.html` Layout C (Devon 3:1 ultra-wide)
  becomes the basis for overlay.html — make bg transparent, wire WS
  subscription, deploy.
- All three layouts (wide / 16:9 / Devon 3:1) can each become
  separate vMix overlay variants.

**Open questions logged at end of the doc** — Bill needs to weigh in
before build starts.
