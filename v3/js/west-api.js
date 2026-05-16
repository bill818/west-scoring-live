// v3/js/west-api.js
//
// Worker URL, auth header, and JSON fetch primitive — single source of
// truth for every public page that talks to /v3/* endpoints.
//
// If the worker URL ever changes (custom domain, multi-region, etc.)
// the change lands here and every page picks it up. Pages should
// NEVER hardcode BASE.
//
// No auth key lives here or anywhere in client source. Every endpoint
// these spectator pages call is a public GET on the worker; writes are
// admin-only and go through the X-West-Admin token flow on admin.html /
// vmix-sandbox.html, never this module.
//
// Dual-env IIFE — browser pages load via <script>.

(function (root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.api = WEST.api || {};

  // Single source of truth — change here, every page follows.
  WEST.api.BASE = 'https://west-worker.bill-acb.workers.dev';

  // Fetch a /v3/* endpoint as JSON. Throws on network error or {ok:false}
  // response. No auth header — these are all public read endpoints.
  WEST.api.fetchJson = async function (path) {
    var res = await fetch(WEST.api.BASE + path);
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  // ETag-aware fetch — used by polling consumers (stats page today,
  // future live page) to cheaply check for updates. Worker responds 304
  // Not Modified when nothing changed; we surface that as
  // {notModified:true} so callers can skip re-rendering.
  // Pass etag=null on first call; pass the previous response's etag
  // on subsequent polls.
  // Returns:
  //   { notModified: true }                    when 304
  //   { data, etag }                           when 200
  // Throws on network error or {ok:false} response body.
  WEST.api.fetchJsonEtag = async function (path, etag) {
    var headers = {};
    if (etag) headers['If-None-Match'] = etag;
    var res = await fetch(WEST.api.BASE + path, { headers });
    if (res.status === 304) return { notModified: true };
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return { data: data, etag: res.headers.get('ETag') };
  };

  // Convenience: read a single URL query param. Returns '' when absent.
  WEST.api.queryParam = function (name) {
    return new URLSearchParams(window.location.search).get(name) || '';
  };

  // Path-based param reader for clean URLs (Pages _redirects rewrites
  // /v3/{slug}/{ring}/{class} → /v3/pages/class.html but the browser
  // address bar stays on the clean form, so window.location.pathname
  // is the real source of truth). Falls back to query params for
  // direct hits on /v3/pages/*.html (admin link, manual URLs, dev).
  // Returns the param value or '' when absent.
  //
  // Path segment positions (1-indexed after the /v3 prefix):
  //   1 = slug    2 = ring    3 = class
  WEST.api.pathParam = function (name) {
    var segs = window.location.pathname.split('/').filter(Boolean);
    if (segs[0] === 'v3' && segs.length >= 2 && segs[1] !== 'pages' && segs[1] !== 'admin') {
      var idx = { slug: 1, ring: 2, 'class': 3 }[name];
      if (idx != null && segs[idx]) return decodeURIComponent(segs[idx]);
    }
    // Fallback — direct hit on /v3/pages/*.html?slug=…
    return WEST.api.queryParam(name);
  };

  // Public-page URL builders — single source of truth for the v3 clean
  // URL scheme. Cloudflare Pages _redirects rewrites these to the actual
  // /v3/pages/*.html?... destinations, but every link in the codebase
  // calls these helpers so the pretty form is what users see + share.
  // Slug / ring / class are URL-encoded so unusual characters survive.
  var enc = function (v) { return encodeURIComponent(v); };
  WEST.api.urls = {
    index: function ()           { return '/v3'; },
    admin: function ()           { return '/v3/admin'; },
    show:  function (slug)       { return '/v3/' + enc(slug); },
    ring:  function (slug, ring) { return '/v3/' + enc(slug) + '/' + enc(ring); },
    cls:   function (slug, ring, classNum) {
      return '/v3/' + enc(slug) + '/' + enc(ring) + '/' + enc(classNum);
    },
  };

  // CommonJS export (harmless in browsers).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
