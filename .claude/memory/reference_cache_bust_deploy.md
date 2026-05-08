---
name: Cache-bust JS bundles per preview deploy
description: deploy-preview.sh stamps every script tag's ?v=__BUILD__ with git short SHA + epoch. Mobile Safari ignores must-revalidate; rotating the URL forces a fresh fetch each deploy.
type: reference
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
**Setup (preview-only):**
- `v3/pages/live.html` (and other pages) reference each module/CSS
  with `?v=__BUILD__`:
  ```html
  <script src="../js/west-format.js?v=__BUILD__"></script>
  ```
- `deploy-preview.sh` rewrites `__BUILD__` to a unique token at
  stage time:
  ```sh
  BUILD_ID="$(git rev-parse --short HEAD)-$(date +%s)"
  find _pages_dist -name '*.html' -print0 | xargs -0 sed -i '' \
    "s/__BUILD__/${BUILD_ID}/g"
  ```
- `deploy-preview.bat` does the same on Windows via PowerShell.

**Why:** Bill 2026-05-08 — phone wasn't picking up new code despite
deploys. Mobile Safari (and Chrome on iOS) ignore `must-revalidate`
on cached JS for hours; the URL has to change for the browser to
fetch fresh. The HTML itself is small + uncacheable, so a fresh
HTML pull picks up the new `?v=...` hash and pulls new bundles.

**Production untouched** — `westscoring.live` is not ready (Bill
2026-05-08). Preview pipeline only.

**To force the user to refresh once after the FIRST deploy with
this setup**: their existing cached HTML still references the old
URLs. They need to close + reopen the tab once. After that, every
subsequent deploy auto-busts.

**Reference:** commit `be82277` (cache-bust setup added).
