---
name: Ring display page (planned)
description: Dedicated large-screen / paddock-display surface separate from live.html — affects how big to scale live.html and what content to prioritize there
type: project
originSessionId: c85fc7d4-2e35-4918-83be-0b377611108d
---
A dedicated "ring display" page is planned — separate file from live.html, designed for permanent large-screen / paddock-mounted / arena-projector use (think 30-foot viewing distance, no UI chrome, takeover layout).

**Why it matters for live.html sizing decisions:**
live.html targets responsive web (phone → laptop → desktop monitor) for spectators on personal devices. It does NOT need to also serve the kiosk-display use case — that lives on the ring display page. Bill confirmed 2026-05-03: live.html scaling larger on a big monitor is fine, but the dedicated TV/kiosk experience is its own surface.

**How to apply:**
- When tuning live.html or live-lab responsive breakpoints: cap at "big desktop monitor" (1600-1920px) — don't chase 4K paddock displays here
- When designing the ring display page: probably no header chrome, just live box + top-N standings strip, optimized for 30ft viewing
- Likely a separate `?display=kiosk` route or a new `display.html` file — TBD when we get there
