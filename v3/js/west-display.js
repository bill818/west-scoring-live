// v3/js/west-display.js
//
// Cross-page UI primitives. Render small standardized HTML fragments
// — chips, status badges, place markers, country chips — used across
// stats.html, show.html, ring.html, class.html, and admin.html.
// Centralized so the visual treatment for "this is a chip" is defined
// once; pages call the helper and forget about the markup.
//
// CSS lives in v3/pages/west.css.
//
// Bill 2026-04-26: extracted as a cleanup pass before further pages
// (live, display.html, show-level stats) start consuming the same
// primitives. "We've duplicated chip styling 4-5 places" → one home.
//
// REFACTOR TARGETS (TODO — left for a future session):
//   - show.html        → renderHero status-badge → WEST.display.statusBadge
//   - index.html       → show-card status indicator (currently text-only)
//   - admin.html       → show list status + sidebar dot
//   - class.html       → hero-stats-tag chip
//   - hunter-templates → judges-hint chip (▸ View judges)
//   - jumper-templates → place-marker (Ch / Res)
//
// Today only stats.html consumes from west-display directly. Helpers
// below are stable; refactor each page on its own schedule.
//
// Dual-env IIFE — browser pages load via <script>.

(function (root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.display = WEST.display || {};

  // Module-local escape — single source of truth is WEST.format.escapeHtml.
  function escapeHtml(s) {
    return (WEST.format && WEST.format.escapeHtml)
      ? WEST.format.escapeHtml(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
  }

  // ── chip(text, opts) ──────────────────────────────────────────────────
  // Generic small uppercase-mono badge. Opts:
  //   variant:  'default' | 'red' | 'blue' | 'green' | 'amber' | 'muted'
  //   size:     'sm' | 'md' (default 'sm')
  //   solid:    true → filled background; false (default) → tinted bg
  //   className: extra class to append
  WEST.display.chip = function (text, opts) {
    opts = opts || {};
    var variant = opts.variant || 'default';
    var size    = opts.size    || 'sm';
    var solid   = opts.solid === true;
    var extra   = opts.className ? ' ' + escapeHtml(opts.className) : '';
    var classes = 'wd-chip wd-chip-' + size + ' wd-chip-' + variant +
                  (solid ? ' wd-chip-solid' : '') + extra;
    return '<span class="' + classes + '">' + escapeHtml(text) + '</span>';
  };

  // ── statusBadge(status) ───────────────────────────────────────────────
  // Show / class status pill — variant chosen from status name.
  //   active / live              → green
  //   pending / upcoming         → blue
  //   complete / archived / past → muted gray
  //   anything else              → default neutral
  WEST.display.statusBadge = function (status, opts) {
    var s = String(status || '').toLowerCase();
    var variant;
    if (s === 'active' || s === 'live')                          variant = 'green';
    else if (s === 'pending' || s === 'upcoming')                variant = 'blue';
    else if (s === 'complete' || s === 'archived' || s === 'past') variant = 'muted';
    else                                                          variant = 'default';
    return WEST.display.chip(status, Object.assign({ variant: variant }, opts || {}));
  };

  // ── placeMarker(place, opts) ─────────────────────────────────────────
  // Place number with optional championship override (Ch / Res chips
  // replace the number on is_championship classes per session-36 rule).
  //   opts.isChampionship  bool — when true, 1 → Ch, 2 → Res
  //   opts.solo            bool — larger sizing for hero (vs inline)
  // Returns '' when no place.
  WEST.display.placeMarker = function (place, opts) {
    opts = opts || {};
    if (place == null || place === '') return '';
    var p = parseInt(place, 10);
    if (opts.isChampionship && (p === 1 || p === 2)) {
      var label = (p === 1) ? 'Ch' : 'Res';
      return WEST.display.chip(label, {
        variant: 'red',
        solid: true,
        className: opts.solo ? 'wd-chip-solo' : '',
      });
    }
    return Number.isFinite(p) ? String(p) : escapeHtml(place);
  };

  // ── countryChip(code, count) ─────────────────────────────────────────
  // Country flag emoji + 3-letter code + optional count, as one inline
  // chip. Used in entry-summary "By Country" lists.
  WEST.display.countryChip = function (code, count) {
    var flag = (WEST.format && WEST.format.flag) ? WEST.format.flag(code) : '';
    var html = '<span class="wd-country-chip">' +
      (flag ? flag + ' ' : '') +
      '<span class="wd-country-code">' + escapeHtml(code) + '</span>';
    if (count != null && count !== '') {
      html += ' <span class="wd-country-count">(' + escapeHtml(count) + ')</span>';
    }
    html += '</span>';
    return html;
  };

  // CommonJS export (harmless in browsers).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.display;
  }
})(typeof window !== 'undefined' ? window : globalThis);
