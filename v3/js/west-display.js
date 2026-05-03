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
// CONSUMERS (current):
//   - stats.html       → countryChip in entry-summary "By Country" list
//   - show.html        → statusBadge in renderHero
//
// CONSUMERS (deferred / out-of-scope for refactor):
//   - index.html / admin.html — status today is a colored dot, not a
//     chip; switching to chip = feature change, not refactor. Decide
//     visual direction before adopting.
//   - class.html / ring.html — only static .header-tag / .hero-action
//     elements; helper would just JS-render a static chip = no dedup.
//   - hunter-templates judges-hint — a dropdown affordance with its
//     own CSS + behavior; not really a chip.
//   - jumper-templates / hunter-templates place-marker — Ch/Res
//     already routed through WEST.format.championshipMarker; .wd-chip
//     swap risks visual drift without coordinated CSS retirement.
//
// Helpers below are stable; expand when a NEW chip pattern appears
// across pages, not to retroactively refactor settled code.
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

  // ── Drawer (slide-in side panel) ─────────────────────────────────────
  // Replaces native <dialog> with a friendlier slide-in panel. Markup
  // pattern in HTML:
  //   <div class="drawer" id="dlgFoo">
  //     <div class="drawer-header"><h2>Title</h2><button class="drawer-close-btn" data-drawer-close="dlgFoo">✕</button></div>
  //     <div class="drawer-body">…</div>
  //     <div class="drawer-footer">…</div>
  //   </div>
  // Open with WEST.drawer.open('dlgFoo'); close with WEST.drawer.close('dlgFoo'),
  // ESC, the [data-drawer-close] button, or clicking the backdrop.
  WEST.drawer = {};

  // Internal: track the per-drawer ESC handler so we can detach on close.
  var _drawerEsc = {};

  function _ensureBackdrop(id) {
    var bd = document.getElementById('drawer-bd-' + id);
    if (bd) return bd;
    bd = document.createElement('div');
    bd.id = 'drawer-bd-' + id;
    bd.className = 'drawer-backdrop';
    bd.addEventListener('click', function () { WEST.drawer.close(id); });
    document.body.appendChild(bd);
    return bd;
  }

  WEST.drawer.open = function (id) {
    var d = document.getElementById(id);
    if (!d) return;
    var bd = _ensureBackdrop(id);
    // Two RAFs so the browser actually paints transform:translateX(100%)
    // before we flip to translateX(0) — guarantees the slide animation.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        bd.classList.add('open');
        d.classList.add('open');
      });
    });
    document.body.style.overflow = 'hidden';
    var handler = function (e) { if (e.key === 'Escape') WEST.drawer.close(id); };
    _drawerEsc[id] = handler;
    document.addEventListener('keydown', handler);
  };

  WEST.drawer.close = function (id) {
    var d = document.getElementById(id);
    var bd = document.getElementById('drawer-bd-' + id);
    if (d) d.classList.remove('open');
    if (bd) bd.classList.remove('open');
    document.body.style.overflow = '';
    if (_drawerEsc[id]) {
      document.removeEventListener('keydown', _drawerEsc[id]);
      delete _drawerEsc[id];
    }
  };

  WEST.drawer.isOpen = function (id) {
    var d = document.getElementById(id);
    return !!(d && d.classList.contains('open'));
  };

  // Wire global [data-drawer-close="<id>"] buttons. Loaded once at DOM
  // ready; pages that add more close buttons later can re-call this.
  WEST.drawer.bindCloseButtons = function () {
    document.querySelectorAll('[data-drawer-close]').forEach(function (btn) {
      if (btn._drawerWired) return;
      btn._drawerWired = true;
      btn.addEventListener('click', function () {
        WEST.drawer.close(btn.getAttribute('data-drawer-close'));
      });
    });
  };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', WEST.drawer.bindCloseButtons);
    } else {
      WEST.drawer.bindCloseButtons();
    }
  }

  // CommonJS export (harmless in browsers).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.display;
  }
})(typeof window !== 'undefined' ? window : globalThis);
