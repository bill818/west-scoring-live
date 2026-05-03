---
name: ETag-aware polling pattern (smart-poll until WS lands)
description: Worker endpoints that page data polls hit should use jsonWithEtag so 304s are cheap. Client uses WEST.api.fetchJsonEtag with stored etag; bails on document.hidden + status==='complete'. Stable contract — swaps to WebSocket subscription when Durable Objects land.
type: reference
originSessionId: 9024d026-0951-451f-8a07-0033a87c38ac
---
The "smart poll" pattern that ships v3 stats / live pages until Durable
Objects + WebSocket subscriptions land in Phase 7-8.

**Server side (worker):**
- Endpoint that page polls returns its body via
  `jsonWithEtag(request, data)` (helper already in west-worker.js).
- ETag is computed from a body hash; client sends `If-None-Match` to
  ask "has it changed?" — worker returns 304 with empty body when the
  hash matches.
- CORS: `Access-Control-Allow-Headers` must include `If-None-Match`,
  and `Access-Control-Expose-Headers` must include `ETag` so browser
  JS can read the response header.

**Client side (page):**
- `WEST.api.fetchJsonEtag(path, etag)` (in v3/js/west-api.js):
  - Pass `null` on first call → returns `{data, etag}`.
  - Pass the previous etag on subsequent polls → returns
    `{notModified: true}` on 304, or fresh `{data, etag}` on 200.
- Page stores the etag in state, polls every 10s with `setInterval`.
- Gates that should ALWAYS apply on a poll loop:
  - `document.hidden === true` → skip (battery saver on phones)
  - `cls.status === 'complete'` → stop polling and clear the interval
- Add a `visibilitychange` listener that fires an immediate refresh
  when the tab returns to foreground (so users don't wait up to
  10s for fresh data after backgrounding).

**Why this is good:** 95%+ of polls return ~hundred-byte 304s. Real
push-based updates need long-lived connections (WebSocket / SSE) which
need Durable Objects in the Cloudflare Worker stack. ETag polling is
the bridge that gets us "feels live" without DO. The endpoint contract
stays stable — when DO lands, the page swaps the poll for a WS
subscription with no API change.

**Where this is wired today:**
- `/v3/listJumperStats` returns ETag-wrapped responses (session 39).
- `v3/pages/stats.html` polls every 10s with the gating + visibility
  listener (session 39).

**Future surfaces that should adopt this:**
- live.html — when Phase 6/7 lands, until WS swap
- show-level stats (Tier 2 jumper stats)
- Any read endpoint a page consumes regularly
