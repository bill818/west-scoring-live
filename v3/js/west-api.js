// v3/js/west-api.js
//
// Worker URL, auth header, and JSON fetch primitive — single source of
// truth for every public page that talks to /v3/* endpoints.
//
// If the worker URL ever changes (custom domain, multi-region, etc.) or
// the auth header rotates, the change lands here and every page picks
// it up. Pages should NEVER hardcode AUTH or BASE.
//
// Dual-env IIFE — browser pages load via <script>.

(function (root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.api = WEST.api || {};

  // Single source of truth — change here, every page follows.
  WEST.api.AUTH = 'west-scoring-2026';
  WEST.api.BASE = 'https://west-worker.bill-acb.workers.dev';

  // Fetch a /v3/* endpoint as JSON. Throws on network error or {ok:false}
  // response. Auth header is always attached.
  WEST.api.fetchJson = async function (path) {
    var res = await fetch(WEST.api.BASE + path, {
      headers: { 'X-West-Key': WEST.api.AUTH },
    });
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  // Convenience: read a single URL query param. Returns '' when absent.
  WEST.api.queryParam = function (name) {
    return new URLSearchParams(window.location.search).get(name) || '';
  };

  // CommonJS export (harmless in browsers).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
