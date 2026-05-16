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
    // Definitive flat: class_mode=1 (operator-set in the .cls header).
    if (isFlatMode(classMeta)) return true;
    // Bill 2026-05-08: definitive NOT-flat — a parsed hunter class
    // with class_mode=0, a scoring_type (1=scored, 2=hi-lo), and
    // num_rounds > 0 is an over-fences scored class. The standings
    // table is the primary UX. The rotation/cadence/results heuristics
    // below were eagerly flipping these classes into flat-render mode
    // because they share fr=11 / fr=14 UDP protocol with flat classes,
    // even though class_mode is explicitly 0. Short-circuit here so
    // a $10k Green Hunter Classic doesn't render as a 4-rider rotation
    // list when it's actually a 21-entry scored class with judge data.
    const isParsedScoredOverFences = classMeta
      && (classMeta.class_mode === 0 || classMeta.class_mode === '0')
      && (Number(classMeta.num_rounds) || 0) > 0
      && (classMeta.scoring_type === 1 || classMeta.scoring_type === '1'
       || classMeta.scoring_type === 2 || classMeta.scoring_type === '2');
    if (isParsedScoredOverFences) return false;
    // Cross-class guard (Bill 2026-05-16). flat_results / flat_entries_seen
    // are per-class in the worker now, but defend in depth here too: if
    // the flat data's class_id doesn't match the class we're evaluating,
    // it's a co-active class's data (e.g. championship 1001's ribbons
    // while we're rendering classic 505) — must NOT flip this class into
    // flat mode off foreign ribbons. Only the results/entriesSeen
    // heuristics are gated; isFlatMode (metadata, class_mode=1) above is
    // authoritative and unaffected.
    var metaCid = (classMeta && classMeta.class_id != null) ? String(classMeta.class_id) : null;
    var flatCid = (snapshot && snapshot.flat_class_id != null) ? String(snapshot.flat_class_id) : null;
    var flatMatchesClass = !flatCid || !metaCid || flatCid === metaCid;
    // Heuristic fallback — U-class hunters where metadata hasn't
    // resolved yet, or rotation is observed before the .cls parses.
    const results = (flatMatchesClass && snapshot && snapshot.flat_results) || [];
    if (results.length > 0) return true;
    const entriesSeen = (flatMatchesClass && snapshot && snapshot.flat_entries_seen) || [];
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

  // Ribbon SVG — delegates to the shared WEST.ribbons module (lifted
  // out so jumper + hunter results pages can use it without importing
  // this whole hunter-flat module). Re-exported on WEST.flat.ribbonSvg
  // for backward compat — old call sites work unchanged.
  function ribbonSvg(placeNum) {
    if (WEST.ribbons && WEST.ribbons.svg) return WEST.ribbons.svg(placeNum);
    return '';
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
      // Places 1-12 get a ribbon SVG (fits the fixed narrow column).
      // Anything else (championship "CHAMPION"/"RESERVE", or a raw text
      // place Ryegate sends without a 1-12 number) has no ribbon — fall
      // back to a text chip AND flag the row so the layout lets that
      // column auto-size instead of overflowing the 44px ribbon slot.
      const svg = ribbonSvg(r.place_num);
      const isTextPlace = !svg;
      const ribbon = svg ||
        ('<span class="flat-place-text">' + esc(r.place_text || '') + '</span>');
      const horseLine = '<span class="flat-entry-num">#' + esc(r.entry_num || '') + '</span> ' + esc(primary || '—');
      let subLine = sub ? esc(sub) : '';
      if (r.score) subLine += (subLine ? ' · ' : '') + esc(r.score);
      return '<li class="flat-entry flat-result'
        + (isNew ? ' is-new' : '')
        + (isTextPlace ? ' is-text-place' : '') + '">'
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
