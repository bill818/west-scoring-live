// WEST v3 — shared scoreboard-display helpers.
// Dual-environment IIFE: works in browsers (attaches to window.WEST.scoreboard)
// and in Node (CommonJS export).
//
// Frame 15 on Channel A is a multi-purpose "scoreboard cycling display"
// frame — Ryegate uses it to broadcast a list of entries to the
// scoreboard, two pairs per packet. The {13} tag carries the LITERAL
// label that distinguishes the ceremony:
//
//   {13}="JOG ORDER"    → tentative jog cycle at championships.
//                          Judges may still re-order before pinning.
//                          Render as plain numbered list (no ribbons).
//   {13}="STANDBY LIST" → call-back roster (riders the judges want for
//                          further testing). Order matters but is NOT
//                          a placing — Ryegate orders by back-number
//                          or class position. Render as bare roster.
//
// Bill 2026-05-05: "Jogs aren't final placings, judges can switch
// results... A standby is when the judges give a list of riders to
// stand by for final testing. It is not a placing but a stand by."
//
// Tag map for fr=15:
//   {1}=entry A   {2}=horse A   {8}=position A
//   {13}=label
//   {17}=position B   {18}=entry B   {20}=horse B

(function (global) {
  const WEST = global.WEST = global.WEST || {};

  function esc(s) {
    if (WEST.format && WEST.format.escapeHtml) {
      return WEST.format.escapeHtml(s == null ? '' : String(s));
    }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Render the jog-order panel — tentative numbered list, no ribbons.
  // entries are pre-ordered by the worker (Ryegate's broadcast order
  // preserved). Each item: { entry_num, horse, position, position_text }.
  // Position is the index Ryegate assigned (may shuffle as judges
  // reorder). We display the count as "1, 2, 3, …" rather than the
  // ribbon image to signal that it isn't final.
  function renderJogOrder(classMeta, entries) {
    if (!entries || !entries.length) return '';
    return entries.map(function (e, i) {
      const n = (i + 1);
      return '<li class="jog-row">'
        + '<span class="jog-pos">' + n + '</span>'
        + '<span class="jog-num">#' + esc(e.entry_num || '') + '</span>'
        + '<span class="jog-name">' + esc(e.horse || '—') + '</span>'
        + '</li>';
    }).join('');
  }

  // Render the standby-list panel — bare roster, no positions shown.
  // Order is whatever Ryegate sent; preserved as-is. No place numbers
  // because standby is not a placing.
  function renderStandbyList(classMeta, entries) {
    if (!entries || !entries.length) return '';
    return entries.map(function (e) {
      return '<li class="standby-row">'
        + '<span class="standby-num">#' + esc(e.entry_num || '') + '</span>'
        + '<span class="standby-name">' + esc(e.horse || '—') + '</span>'
        + '</li>';
    }).join('');
  }

  // ── renderOOG(classMeta, rosterEntries, opts) ──────────────────────────
  //
  // Kiosk / ring-display Order-of-Go panel. Auto-detects between two modes:
  //
  //   • hasOOG  — at least one roster entry has ride_order > 0 → render
  //               "Up Next" (sorted by ride_order) + "Competed" (sorted
  //               by place). Operator loaded a schedule.
  //   • seen-only — no entry has a real ride_order → drop Up Next and
  //               render a single "Seen" list of entries with any data,
  //               place-first. The operator either skipped scheduling
  //               or this class doesn't carry one (catch-all warm-ups,
  //               etc).
  //
  // Roster entries are the wide-shape rows from /v3/listEntries:
  //   { id, entry_num, horse_name, rider_name, ride_order, overall_place,
  //     current_place, r1_status, r2_status, r3_status, r1_h_status, ...,
  //     r1_time, r1_total_faults, combined_total, r1_score_total, ... }
  //
  // Opts:
  //   onCourseEntryNum  — string/number entry_num that's currently in the
  //                       ring. Renders the gold-bordered "is-current"
  //                       row treatment. Pass focus_preview.entry_num.
  //   labels            — overrides for header strings { upNext, gone,
  //                       seen, empty }. Defaults: "Up Next" / "Competed"
  //                       / "Seen" / "Awaiting first ride".
  //   hideUpcoming      — when true, drop the upcoming/remaining list
  //                       entirely. Kiosk policy: the .cls's ride_order
  //                       is rarely operator-curated, so showing it as
  //                       "Up Next" misleads spectators. Display surfaces
  //                       opt in; admin / live retain the full list.
  //                       Bill 2026-05-13.
  //
  // Returns the INNER HTML for the .oog container (page wraps it). The
  // page styles `.oog-section`, `.oog-header`, `.oog-list`, `.oog-row`
  // etc. — west.css doesn't ship those yet because only display.html
  // uses them, but future kiosk consumers can adopt the same class names.
  function renderOOG(classMeta, rosterEntries, opts) {
    opts = opts || {};
    var rows = rosterEntries || [];
    var ocEntry = opts.onCourseEntryNum != null ? String(opts.onCourseEntryNum) : '';
    var lbl = Object.assign({
      upNext: 'Up Next',
      gone:   'Competed',
      seen:   'Seen',
      empty:  'Awaiting first ride',
    }, opts.labels || {});
    var isEq = !!(classMeta && classMeta.is_equitation);

    function entryIsGone(e) {
      if (!e) return false;
      if (e.overall_place != null) return true;
      if (e.current_place != null) return true;
      if (e.r1_status || e.r2_status || e.r3_status) return true;
      if (e.r1_h_status || e.r2_h_status || e.r3_h_status) return true;
      if (e.r1_time || e.r2_time || e.r3_time) return true;
      if (e.combined_total != null) return true;
      if (e.r1_score_total != null || e.r2_score_total != null || e.r3_score_total != null) return true;
      return false;
    }

    var upNext = [], gone = [];
    rows.forEach(function (e) {
      if (entryIsGone(e)) gone.push(e);
      else upNext.push(e);
    });
    // Only fire OOG mode when at least one UPCOMING entry has a real
    // ride_order. Ryegate uses col[13] with dual semantics: when a class
    // has a curated/posted order of go, every entry is pre-populated
    // (1..N); when there's no curated order, col[13]=0 for everyone and
    // Ryegate auto-stamps it as each horse enters the ring. Testing on
    // `rows.some(...)` would be fooled by the already-competed entries
    // and render Up Next with meaningless sort order. Testing on `upNext`
    // distinguishes the two cases cleanly. Bill 2026-05-14.
    var hasOOG = !opts.hideUpcoming
              && upNext.some(function (e) { return Number(e.ride_order) > 0; });

    upNext.sort(function (a, b) {
      var oa = Number(a.ride_order) || 999, ob = Number(b.ride_order) || 999;
      if (oa !== ob) return oa - ob;
      return (Number(a.entry_num) || 0) - (Number(b.entry_num) || 0);
    });

    // Latest finished_at across this entry's rounds — anchor for the Seen
    // sort below. Falls back to NULL when no per-round timestamp is
    // available (legacy rows that predate migration 037, or rounds that
    // only carry status with no scored data). Latest because a multi-round
    // class's "when did they last ride" is the most useful chronological
    // signal — a Round-1 finisher who hasn't ridden R2 yet sits earlier
    // than an entry that just finished a jump-off.
    function latestFinishedAt(e) {
      var ts = null;
      ['r1_finished_at','r2_finished_at','r3_finished_at',
       'r1_h_finished_at','r2_h_finished_at','r3_h_finished_at'].forEach(function (k) {
        if (e[k] && (!ts || String(e[k]) > String(ts))) ts = e[k];
      });
      return ts;
    }

    // Gone list — chronological by latest finished_at, MOST RECENT FIRST.
    // The center standings panel already shows place-sorted "leaderboard"
    // ordering; the side panel's job is "what's happening right now", so
    // the just-finished rider sits at the top. Falls back to place /
    // entry_num for rows with no finished_at (rows that predate migration
    // 037 or carry only status with no scored data). Same rule in both
    // OOG and seen-only modes — Bill 2026-05-13: "the seen should be the
    // order they went into the ring", side panel is recency-first.
    gone.sort(function (a, b) {
      var ta = latestFinishedAt(a), tb = latestFinishedAt(b);
      if (ta && tb) return String(tb).localeCompare(String(ta));
      if (ta && !tb) return -1;
      if (!ta && tb) return  1;
      var pa = Number(a.overall_place || a.current_place) || 999;
      var pb = Number(b.overall_place || b.current_place) || 999;
      if (pa !== pb) return pa - pb;
      return (Number(a.entry_num) || 0) - (Number(b.entry_num) || 0);
    });

    // Up-Next label = entry.position_label, computed server-side in
    // assignOOGPositionLabels (west-worker.js). Page just reads. Single
    // source of truth so display.html OOG, live.html, and any future
    // surface render the same labels at the same moment. Fallback to
    // raw ride_order only when position_label hasn't been stamped yet
    // (legacy data sources that don't pass through the snapshot builder).
    function rowHtml(e, kind) {
      var label = e && e.position_label || null;
      var orderText;
      if (kind === 'gone') {
        orderText = e.overall_place || e.current_place || '';
      } else {
        orderText = label != null ? label : (e.ride_order || '');
      }
      var isCurrent = (kind !== 'gone') && ocEntry && (String(e.entry_num) === ocEntry);
      var isOnDeck  = (kind !== 'gone') && label === 'On Deck';
      var primary   = isEq ? e.rider_name : e.horse_name;
      var secondary = isEq ? e.horse_name : e.rider_name;
      var orderCls  = 'oog-order'
        + (isOnDeck ? ' is-on-deck' : '')
        + (label === 'On Course' ? ' is-on-course' : '');
      return '<div class="oog-row'
        + (kind === 'gone' ? ' is-gone' : '')
        + (isCurrent ? ' is-current' : '') + '">'
        + '<span class="' + orderCls + '">' + esc(orderText || '') + '</span>'
        + '<div class="oog-info">'
        +   '<div class="oog-horse">' + esc(primary || '') + '</div>'
        +   '<div class="oog-rider">' + esc(secondary || '') + '</div>'
        + '</div></div>';
    }

    var out = '';
    if (hasOOG) {
      if (upNext.length) {
        var grow = gone.length === 0;
        out += '<div class="oog-section ' + (grow ? 'is-grow' : 'is-shrink') + '">'
          +   '<div class="oog-header">' + esc(lbl.upNext) + ' (' + upNext.length + ')</div>'
          +   '<div class="oog-list">'
          +   upNext.map(function (e) { return rowHtml(e, 'upNext'); }).join('')
          +   '</div></div>';
      }
      if (gone.length) {
        out += '<div class="oog-section is-grow">'
          +   '<div class="oog-header is-gone">' + esc(lbl.gone) + ' (' + gone.length + ')</div>'
          +   '<div class="oog-list">'
          +   gone.map(function (e) { return rowHtml(e, 'gone'); }).join('')
          +   '</div></div>';
      }
      if (!upNext.length && !gone.length) {
        out += '<div class="oog-section is-grow">'
          +   '<div class="oog-header">Order of Go</div>'
          +   '<div class="oog-list"><div class="oog-empty">No entries</div></div>'
          +   '</div>';
      }
    } else {
      out += '<div class="oog-section is-grow">'
        +   '<div class="oog-header">' + esc(lbl.seen) + ' (' + gone.length + ')</div>'
        +   '<div class="oog-list">'
        +   (gone.length
              ? gone.map(function (e) { return rowHtml(e, 'gone'); }).join('')
              : '<div class="oog-empty">' + esc(lbl.empty) + '</div>')
        +   '</div></div>';
    }
    return out;
  }

  WEST.scoreboard = {
    renderJogOrder,
    renderStandbyList,
    renderOOG,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.scoreboard;
  }
})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof self !== 'undefined' ? self : this);
