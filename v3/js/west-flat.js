// WEST v3 — shared hunter-flat helpers.
// Dual-environment IIFE: works in browsers (attaches to window.WEST.flat)
// and in Node (CommonJS export). Single source of truth for flat-class
// detection, EQ swap rule, render templates, and ribbon graphics so
// live.html and any future scoreboard / results / display surfaces stay
// consistent.
//
// Public API:
//   WEST.flat.isFlatMode(classMeta)         — definitive (class_meta.class_mode === 1)
//   WEST.flat.isEquitation(classMeta)       — definitive (class_meta.is_equitation === 1)
//   WEST.flat.createCadenceTracker()        — stateful per-class fr=11 cadence detector
//   WEST.flat.shouldRender(meta, classId, tracker) — combined gate
//   WEST.flat.renderResults(meta, rows, opts)      — HTML for pinned-ribbons list
//   WEST.flat.renderEntries(meta, rows)            — HTML for in-the-ring list
//   WEST.flat.ribbonSvg(placeNum)                  — single ribbon SVG (places 1-12)
//
// Why cadence is sticky: once a class has been observed rotating at flat
// cadence, the inferred-flat flag stays set for that class_id until the
// caller resets it on class change. Otherwise the layout would flip back
// to dumb-display the moment the operator stops rotation to start pinning
// ribbons (which is exactly when flat mode should stay active).
//
// Per Bill 2026-05-05 ("centralized rules we'll pull the same stuff later
// for a different display page"). This module is the source of truth.

(function (global) {
  const WEST = global.WEST = global.WEST || {};

  const FLAT_CADENCE_WINDOW_MS = 5000;  // inter-event gap
  const FLAT_CADENCE_MIN_COUNT = 3;     // events needed in window

  function isFlatMode(classMeta) {
    if (!classMeta) return false;
    return classMeta.class_mode === 1 || classMeta.class_mode === '1';
  }

  function isEquitation(classMeta) {
    return !!(classMeta && classMeta.is_equitation === 1);
  }

  function createCadenceTracker() {
    const fr11Times = {}; // class_id -> [timestamps]
    const inferred  = {}; // class_id -> true (sticky once set)
    return {
      update(snapshot) {
        if (!snapshot || !snapshot.last_scoring) return;
        const ls = snapshot.last_scoring;
        if (ls.channel !== 'A' || ls.frame !== 11 || !ls.class_id) return;
        const cid = String(ls.class_id);
        const ts = Date.parse(ls.at);
        if (!isFinite(ts)) return;
        const arr = fr11Times[cid] = fr11Times[cid] || [];
        if (!arr.length || arr[arr.length - 1] !== ts) arr.push(ts);
        if (arr.length > FLAT_CADENCE_MIN_COUNT * 2) {
          fr11Times[cid] = arr.slice(-FLAT_CADENCE_MIN_COUNT * 2);
        }
        const recent = (fr11Times[cid] || []).slice(-FLAT_CADENCE_MIN_COUNT);
        if (recent.length < FLAT_CADENCE_MIN_COUNT) return;
        for (let i = 1; i < recent.length; i++) {
          if (recent[i] - recent[i - 1] > FLAT_CADENCE_WINDOW_MS) return;
        }
        inferred[cid] = true;
      },
      isInferred(classId) {
        return !!inferred[String(classId)];
      },
      reset(classId) {
        const cid = String(classId);
        delete fr11Times[cid];
        delete inferred[cid];
      },
    };
  }

  // Combined gate: render flat layout if ANY of these signals say so.
  // - classMeta is definitive (mode=1 → known flat)
  // - flat_results.length > 0 → fr=14 ribbon announcements firing.
  //   Per Bill 2026-05-05, this triggers for ALL hunter classes (not
  //   just flat) — over-fences hunter results use the same fr=14
  //   protocol, and the cycling ribbons display is the right UX for
  //   any class that's announcing placings.
  // - entriesSeen.length > 1 is a quick check for the steady-state
  //   case where someone landed on the page mid-class with rotation
  //   already populated
  // - cadenceTracker is the inferred fallback for U-class hunters
  //   where class metadata isn't resolved but rotation is happening
  function shouldRender(classMeta, snapshot, cadenceTracker) {
    if (isFlatMode(classMeta)) return true;
    const results = (snapshot && snapshot.flat_results) || [];
    if (results.length > 0) return true;
    const entriesSeen = (snapshot && snapshot.flat_entries_seen) || [];
    if (entriesSeen.length > 1) return true;
    const focusId = snapshot && (
      (snapshot.last_focus    && snapshot.last_focus.class_id) ||
      (snapshot.last_scoring  && snapshot.last_scoring.class_id) ||
      snapshot.flat_class_id
    );
    if (focusId && cadenceTracker && cadenceTracker.isInferred(focusId)) return true;
    return false;
  }

  function esc(s) {
    if (WEST.format && WEST.format.escapeHtml) {
      return WEST.format.escapeHtml(s == null ? '' : String(s));
    }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Ribbon SVG — port of v2's WEST.ribbon.svg (display-config.js:160).
  // Hunter-show ribbon colors: 1=blue, 2=red, 3=yellow, 4=white/grey,
  // 5=pink, 6=green, 7=purple, 8=brown, 9=grey, 10=light blue, 11=fuchsia,
  // 12=lime green. Square 32×32 SVG with rosette petals + center number.
  // Returns empty string for unknown / out-of-range places.
  const RIBBON_COLORS = {
    1:  { o: '#0a3d8f', i: '#3a7bd5', f: '#e8f0fb', t: '#0a3d8f' },
    2:  { o: '#8b0000', i: '#cc2222', f: '#fbe8e8', t: '#8b0000' },
    3:  { o: '#9a7800', i: '#d4a800', f: '#fdf6d8', t: '#7a5e00' },
    4:  { o: '#888',    i: '#bbb',    f: '#f4f4f4', t: '#555'    },
    5:  { o: '#ad1457', i: '#e91e8c', f: '#fde8f3', t: '#ad1457' },
    6:  { o: '#1a6b2a', i: '#2ea043', f: '#e8f5eb', t: '#1a6b2a' },
    7:  { o: '#4a2d8e', i: '#7c52cc', f: '#f0ebfb', t: '#4a2d8e' },
    8:  { o: '#5c3317', i: '#8b5e3c', f: '#f5ede6', t: '#5c3317' },
    9:  { o: '#666',    i: '#999',    f: '#f0f0f0', t: '#444'    },
    10: { o: '#1565a8', i: '#5ba3e0', f: '#e3f2fd', t: '#1565a8' },
    11: { o: '#b0006a', i: '#e8409a', f: '#fce4f2', t: '#8b0052' },
    12: { o: '#3d7a00', i: '#7ec800', f: '#f0fce0', t: '#2d5c00' },
  };

  function ribbonSvg(placeNum) {
    const n = parseInt(placeNum, 10);
    if (!isFinite(n) || n < 1) return '';
    const c = RIBBON_COLORS[n];
    if (!c) return '';
    let petals = '';
    for (let i = 0; i < 12; i++) {
      const a = i * 30, r = 12, cx = 16, cy = 16;
      const rad = a * Math.PI / 180;
      const x = (cx + r * Math.sin(rad)).toFixed(1);
      const y = (cy - r * Math.cos(rad)).toFixed(1);
      petals += '<ellipse cx="' + x + '" cy="' + y +
        '" rx="4.5" ry="2.6" fill="' + c.o +
        '" transform="rotate(' + a + ',' + x + ',' + y + ')"/>';
    }
    const circles = '<circle cx="16" cy="16" r="10" fill="' + c.i +
      '"/><circle cx="16" cy="16" r="8" fill="' + c.f + '"/>';
    const fs = n >= 10 ? '10' : '12';
    return '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">'
      + petals + circles
      + '<text x="16" y="16" text-anchor="middle" dominant-baseline="central"'
      + ' font-family="serif" font-weight="bold" font-size="' + fs + '" fill="' + c.t + '">'
      + n + '</text></svg>';
  }

  // Render the pinned-ribbons list. Sorts by place_num ASC (1st on top);
  // rows missing place_num fall to bottom. EQ swap: rider primary when
  // class is equitation OR row's is_eq flag set.
  //
  // options.animatedSet — pass-by-reference object. entry_nums seen here
  // get marked truthy so re-renders don't re-trigger the fade-up animation.
  // options.markAnimated defaults true.
  function renderResults(classMeta, results, options) {
    options = options || {};
    const animated = options.animatedSet || {};
    const markAnimated = options.markAnimated !== false;
    const equit = isEquitation(classMeta);
    const sorted = (results || []).slice().sort(function (a, b) {
      if (a.place_num == null && b.place_num == null) return 0;
      if (a.place_num == null) return 1;
      if (b.place_num == null) return -1;
      return a.place_num - b.place_num;
    });
    return sorted.map(function (r) {
      const rowEqu = equit || r.is_eq;
      const primary = rowEqu ? (r.rider || r.horse || '') : (r.horse || '');
      const sub     = rowEqu ? (r.horse || '') : (r.rider || '');
      const isNew   = !animated[r.entry_num];
      if (markAnimated) animated[r.entry_num] = true;
      const ribbon = ribbonSvg(r.place_num) ||
        ('<span class="flat-place-text">' + esc(r.place_text || '') + '</span>');
      const horseLine = '<span class="flat-entry-num">#' + esc(r.entry_num || '') + '</span> ' + esc(primary || '—');
      let subLine = sub ? esc(sub) : '';
      if (r.score) subLine += (subLine ? ' · ' : '') + esc(r.score);
      return '<li class="flat-entry flat-result' + (isNew ? ' is-new' : '') + '">'
        + '<span class="num">' + ribbon + '</span>'
        + '<span>'
        +   '<div class="horse">' + horseLine + '</div>'
        +   (subLine ? '<div class="rider">' + subLine + '</div>' : '')
        + '</span>'
        + '</li>';
    }).join('');
  }

  // Render the in-the-ring rotation list. No places, no animation, no
  // sorting — caller provides whatever order makes sense (typically
  // arrival order from snapshot.flat_entries_seen).
  function renderEntries(classMeta, entries) {
    const equit = isEquitation(classMeta);
    return (entries || []).map(function (e) {
      const rowEqu = equit || e.is_eq;
      const primary = rowEqu ? (e.rider || e.horse || '') : (e.horse || '');
      const sub     = rowEqu ? (e.horse || '') : (e.rider || '');
      return '<li class="flat-entry">'
        + '<span class="num">#' + esc(e.entry_num || '') + '</span>'
        + '<span>'
        +   '<div class="horse">' + esc(primary || '—') + '</div>'
        +   (sub ? '<div class="rider">' + esc(sub) + '</div>' : '')
        + '</span>'
        + '</li>';
    }).join('');
  }

  WEST.flat = {
    isFlatMode,
    isEquitation,
    createCadenceTracker,
    shouldRender,
    renderResults,
    renderEntries,
    ribbonSvg,
    FLAT_CADENCE_WINDOW_MS,
    FLAT_CADENCE_MIN_COUNT,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.flat;
  }
})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof self !== 'undefined' ? self : this);
