// v3/js/west-jumper-templates.js
//
// Per-template renderers for the JUMPER lens (class_type J or T).
//
// Detection: scoring_method (with one modifier-based override on method 6)
// and is_equitation drive template selection. See METHOD_TEMPLATE below
// — sourced from docs/v3-planning/JUMPER-METHODS-REFERENCE.md.
//
// Each template exposes:
//   columns(cls)          → string[] of column header labels
//   renderRow(entry, cls) → '<tr>...</tr>' HTML
//
// Round labels are intentionally generic (R1/R2/R3) for now. Per-method
// labels (Phase 1, Phase 2, JO, Winning Round, etc.) layer on later when
// the rest is settled.
//
// Both the public class.html page and (eventually) admin's entry table
// consume these templates → single source of truth for jumper display.
//
// Dual-env IIFE — browser pages load via <script>.

(function (root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.jumperTemplates = WEST.jumperTemplates || {};

  // ── Detection ────────────────────────────────────────────────────────
  //
  // Method → template ID lookup. Methods listed in JUMPER-METHODS-
  // REFERENCE.md; round counts validated against the spec doc and
  // Bill's session 2026-04-25 corrections.
  var METHOD_TEMPLATE = {
    0:  '1R',   // Table III / Table C
    2:  '2R',   // II.2a — R1 + delayed JO
    3:  '3R',   // 2 rounds + JO
    4:  '1R',   // II.1 Speed
    5:  '1R',   // Top Score (dropped — defensive default)
    6:  '1R',   // IV.1 Optimum (override → 2R when modifier=1)
    7:  'EQ',   // Timed Equitation
    8:  '1R',   // Table II
    9:  '2R',   // II.2d — Two-Phase
    10: '2R',   // II.2f — Stratified
    11: '2R',   // II.2c — Two-Phase (clears only)
    13: '2R',   // II.2b — Immediate JO  ★ workhorse
    14: 'TEAM', // Team Competition
    15: '2R',   // Winning Round
  };

  WEST.jumperTemplates.detect = function (cls) {
    if (!cls) return '1R';
    var method = cls.scoring_method;
    var modifier = cls.scoring_modifier;
    // Method-specific modifier overrides come first — most specific wins.
    if (method === 6 && modifier === 1) return '2R';
    // Equitation flag overrides plain 1R (method 7 is the typical case
    // but the flag can in principle apply to other methods too).
    if (cls.is_equitation) return 'EQ';
    return METHOD_TEMPLATE[method] || '1R';
  };

  // ── Helpers (jumper-specific) ────────────────────────────────────────

  // Pull a single round's wide-shape fields out of an entry into a
  // normalized object. Templates work against this rather than reaching
  // into r1_*/r2_*/r3_* prefixes everywhere.
  function roundOf(entry, n) {
    return {
      time:           entry['r' + n + '_time'],
      total_time:     entry['r' + n + '_total_time'],
      penalty_sec:    entry['r' + n + '_penalty_sec'],
      time_faults:    entry['r' + n + '_time_faults'],
      jump_faults:    entry['r' + n + '_jump_faults'],
      total_faults:   entry['r' + n + '_total_faults'],
      status:         entry['r' + n + '_status'],
      numeric_status: entry['r' + n + '_numeric_status'],
    };
  }

  // True if the round has any meaningful data (time OR status).
  // Absence of both = entry didn't ride that round.
  function roundHasData(rnd) {
    if (!rnd) return false;
    if (rnd.status) return true;
    var t = Number(rnd.time);
    return Number.isFinite(t) && t > 0;
  }

  // Render a jumper round cell. Killing-status rounds show the public
  // status code in red, hiding faults/time per Decision 1. Clean rounds
  // show "<faults> <time>" or just <time> when faults=0.
  function renderRoundCell(rnd) {
    if (!roundHasData(rnd)) return '<span class="round-blank">—</span>';
    if (WEST.status.isKillingStatus(rnd.status)) {
      var label = WEST.status.publicLabel(rnd.status) || rnd.status;
      return '<span class="round-status">' + escapeHtml(label) + '</span>';
    }
    var faults = Number(rnd.total_faults) || 0;
    var timeStr = WEST.format.time(rnd.time);
    if (faults > 0) {
      return '<span class="round-faults">' + faults + '</span> ' +
             '<span class="round-time">' + escapeHtml(timeStr) + '</span>';
    }
    return '<span class="round-time">' + escapeHtml(timeStr) + '</span>';
  }

  // Module-local alias so existing template code reads naturally. The
  // single source of truth is WEST.format.escapeHtml.
  function escapeHtml(s) { return WEST.format.escapeHtml(s); }

  // Status array for placement check — empties in any unseen round are
  // null which jumperIsPlaced handles correctly.
  function statusesOf(entry) {
    return {
      1: entry.r1_status || null,
      2: entry.r2_status || null,
      3: entry.r3_status || null,
    };
  }

  // Place column — defers to jumperPlaceFor (suppresses if R1 killed
  // under the method's ladder rules).
  function renderPlaceCell(entry, cls) {
    var place = WEST.rules.jumperPlaceFor(
      entry.overall_place,
      cls.scoring_method,
      statusesOf(entry)
    );
    if (place == null) return '<span class="place-blank">—</span>';
    return '<span class="place-num">' + place + '</span>';
  }

  // Inline flag span for a class+entry pair. The show_flags policy is
  // enforced inside WEST.format.flagFor — this template just wraps
  // the result in a span. Means a future stats / live / display page
  // CAN'T accidentally bypass the operator's Ryegate ShowFlags setting:
  // they all go through flagFor.
  function flagify(cls, entry) {
    var rendered = WEST.format.flagFor(cls, entry);
    if (!rendered) return '';
    return ' <span class="entry-flag">' + escapeHtml(rendered) + '</span>';
  }

  // Identity: horse on top, rider underneath. Owner intentionally omitted
  // from the public table — it's available on a future entry-detail page.
  function renderHorseRider(entry, cls) {
    return '<div class="entry-horse">' + escapeHtml(entry.horse_name || '—') + '</div>' +
           '<div class="entry-rider">' + escapeHtml(entry.rider_name || '') + flagify(cls, entry) + '</div>';
  }

  // ── Round-count templates (1R / 2R / 3R) ─────────────────────────────
  //
  // Same shape, parameterized by N. Generated once below — keeps the
  // three round templates in lockstep for future tweaks.
  function makeRoundTemplate(N) {
    var roundCols = [];
    for (var i = 1; i <= N; i++) roundCols.push('R' + i);
    var headers = ['Pl', '#', 'Horse / Rider'].concat(roundCols);

    function renderRow(entry, cls) {
      var cells = [];
      cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
      cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
      cells.push('<td class="entry-horse-rider">' + renderHorseRider(entry, cls) + '</td>');
      for (var i = 1; i <= N; i++) {
        cells.push('<td class="entry-round">' + renderRoundCell(roundOf(entry, i)) + '</td>');
      }
      return '<tr>' + cells.join('') + '</tr>';
    }

    return {
      columns: function () { return headers; },
      renderRow: renderRow,
    };
  }

  // ── EQ template ──────────────────────────────────────────────────────
  //
  // Equitation: 1 round; rider is the primary identity. Method 7 (Timed
  // Equitation) modifier:
  //   scoring_modifier = 0 → Forced  (operator pins place; no score column)
  //   scoring_modifier = 1 → Scored  (score column populated from col[19],
  //                                   exposed through r1_jump_faults
  //                                   per Method 7 spec)
  // Other methods with is_equitation=true fall through Scored display.
  var EQ_TEMPLATE = {
    columns: function (cls) {
      var base = ['Pl', '#', 'Rider / Horse'];
      // Forced eq has no score column — operator just pins placements.
      if (cls && cls.scoring_method === 7 && cls.scoring_modifier === 0) return base;
      return base.concat(['Score']);
    },
    renderRow: function (entry, cls) {
      var cells = [];
      cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
      cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
      // Rider primary, horse secondary — inverse of the round templates.
      cells.push(
        '<td class="entry-horse-rider">' +
          '<div class="entry-rider">' + escapeHtml(entry.rider_name || '—') + flagify(cls, entry) + '</div>' +
          '<div class="entry-horse">' + escapeHtml(entry.horse_name || '') + '</div>' +
        '</td>'
      );
      var isForcedEq = cls && cls.scoring_method === 7 && cls.scoring_modifier === 0;
      if (!isForcedEq) {
        // Method 7 scored stores the equitation score in r1_jump_faults
        // (col[19]) per JUMPER-METHODS-REFERENCE.md Method 7 spec.
        var raw = entry.r1_jump_faults;
        var score = (raw == null || raw === '') ? '—' : raw;
        cells.push('<td class="entry-score">' + escapeHtml(score) + '</td>');
      }
      return '<tr>' + cells.join('') + '</tr>';
    },
  };

  // ── TEAM template — stub ─────────────────────────────────────────────
  //
  // Method 14 (Team Competition) has a per-rider 3-round structure plus
  // a team-level rollup. Display needs more design — see Bill's note
  // 2026-04-25. For now we fall back to a 3R-shaped table per rider
  // with a placeholder team header so the page works against any test
  // data that lands.
  var TEAM_TEMPLATE = {
    columns: function () { return ['Pl', '#', 'Horse / Rider', 'R1', 'R2', 'R3']; },
    renderRow: function (entry, cls) {
      // Reuse the 3R row layout for now. Team aggregation comes later.
      return WEST.jumperTemplates.templates['3R'].renderRow(entry, cls);
    },
    isStub: true,
  };

  // ── Registry ─────────────────────────────────────────────────────────
  WEST.jumperTemplates.templates = {
    '1R':   makeRoundTemplate(1),
    '2R':   makeRoundTemplate(2),
    '3R':   makeRoundTemplate(3),
    'EQ':   EQ_TEMPLATE,
    'TEAM': TEAM_TEMPLATE,
  };

  // Convenience: render a full <table> given a class + entries.
  WEST.jumperTemplates.renderTable = function (cls, entries) {
    var tplId = WEST.jumperTemplates.detect(cls);
    var tpl = WEST.jumperTemplates.templates[tplId];
    var headers = tpl.columns(cls);
    var thead = '<thead><tr>' +
      headers.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('') +
      '</tr></thead>';
    var tbody = '<tbody>' +
      (entries || []).map(function (e) { return tpl.renderRow(e, cls); }).join('') +
      '</tbody>';
    return '<table class="results-table results-' + tplId.toLowerCase() + '">' +
      thead + tbody + '</table>';
  };

  // CommonJS export for tests / future Node consumers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.jumperTemplates;
  }
})(typeof window !== 'undefined' ? window : global);
