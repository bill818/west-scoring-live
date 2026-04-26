# Clean URLs — Deferred to go-live

Status: **DEFERRED** — attempted 2026-04-26 (Session 39), reverted same
session because Cloudflare Pages `_redirects` can't preserve clean URLs
in the address bar with the patterns we need. Pages Functions is the
right tool; revisit before public go-live.

## What we want

Public-facing URLs that look like:

```
https://westscoring.live/v3                                    (all shows)
https://westscoring.live/v3/{slug}                             (show)
https://westscoring.live/v3/{slug}/{ring}                      (ring)
https://westscoring.live/v3/{slug}/{ring}/{class}              (class)
https://westscoring.live/v3/admin                              (admin)
```

…instead of the current shareable-but-ugly `?slug=…&ring=…&class=…`
form.

## What we tried

A `_redirects` file with 200-status rewrites + placeholders:

```
/v3                          /v3/pages/index.html      200
/v3/admin                    /v3/pages/admin.html      200
/v3/:slug                    /v3/pages/show.html       200
/v3/:slug/:ring              /v3/pages/ring.html       200
/v3/:slug/:ring/:class       /v3/pages/class.html      200
```

## Why it failed

Cloudflare Pages 200-rewrites with placeholders interact badly with two
default Pages behaviors:

1. **`.html` → no-extension auto-redirect.** Pages 308-canonicalizes
   any URL ending in `.html` to the no-extension form. The 200-rewrite
   destination `/v3/pages/show.html` triggers a 308 to `/v3/pages/show`.
2. **Re-walking `_redirects` after the canonicalization.** The
   canonicalized `/v3/pages/X` then matches `/v3/:slug/:ring` with
   slug=`pages`, ring=`X` — infinite redirect loop.

A pass-through identity rule (`/v3/pages/* → /v3/pages/:splat 200`
listed first) breaks the loop, BUT the URL still externally redirects
from `/v3/{slug}` to `/v3/pages/show` — the clean URL doesn't survive
in the browser address bar, AND the destination page has lost the
slug/ring/class info because the rewrite stripped the original path.

Net: `_redirects` 200 status is documented as "rewrite," but in
practice it's a 308 to the destination, not an internal rewrite, when
placeholders are involved.

## What ships before go-live

**Cloudflare Pages Functions.** A small `functions/v3/[[catchall]].js`
runs on the request, parses the path, and returns the right .html file
content with the original URL preserved. Roughly:

```js
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const segs = url.pathname.split('/').filter(Boolean); // ['v3', ...]
  if (segs.length === 1) return context.env.ASSETS.fetch(new URL('/v3/pages/index.html',  url));
  if (segs[1] === 'admin')   return context.env.ASSETS.fetch(new URL('/v3/pages/admin.html', url));
  if (segs[1] === 'pages')   return context.next();      // pass through to static
  if (segs.length === 2) return context.env.ASSETS.fetch(new URL('/v3/pages/show.html',  url));
  if (segs.length === 3) return context.env.ASSETS.fetch(new URL('/v3/pages/ring.html',  url));
  if (segs.length === 4) return context.env.ASSETS.fetch(new URL('/v3/pages/class.html', url));
  return context.next();
}
```

The pages already have the helpers they need:

- `WEST.api.urls.{index,admin,show,ring,cls}` — clean URL builders
  (already in [west-api.js](../../v3/js/west-api.js))
- `WEST.api.pathParam(name)` — reads slug/ring/class from
  `window.location.pathname`, falls back to query-string for direct
  hits on `/v3/pages/*.html` (already in west-api.js)

Once Functions is in place, the link-site updates (breadcrumbs, show
cards, ring cards, header logo, footer admin) flip to the helper
calls; the `_redirects` file becomes unnecessary.

## Reversion checklist (already done)

- Deleted `_redirects` from repo root
- Reverted static `<a href="...">` in 5 v3 pages back to `index.html`
  / `admin.html` / etc.
- Reverted JS-generated link sites back to query-string URLs
- Reverted `getQueryParam = WEST.api.pathParam` back to `queryParam`
- Reverted `deploy-preview.{sh,bat}` (no `_redirects` staging)
- KEPT the `WEST.api.urls` and `WEST.api.pathParam` helpers in
  [west-api.js](../../v3/js/west-api.js) — they're harmless on the
  current site and will be needed when Functions lands.

## Trigger

Do this work as part of the **public go-live** push (no firm date —
gated on engine connection landing + production cutover from v2).
Until then, query-string URLs are the canonical form.
