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

  // ── Per-method round-cell display tweaks ─────────────────────────────
  //
  // Most methods render faults bold + time muted. A few methods invert
  // that hierarchy because the ranking signal lives in time, not faults.
  // Add an entry here when a method has display quirks; defaults apply
  // when a method isn't listed.
  //
  //   faultsStyle: 'primary' (default — bold)
  //                'secondary' (italic + dim — Table III)
  //   timeStyle:   'secondary' (default — small + muted)
  //                'primary' (bold + body color — Table III)
  var METHOD_DISPLAY_CONFIG = {
    // Method 0 (Table III / Table C): faults are CONVERTED to penalty
    // seconds and added to time. Final rank is by total_time only.
    // Show faults as informational context, time as the authority.
    0: { faultsStyle: 'secondary', timeStyle: 'primary' },
  };

  function configFor(cls) {
    if (!cls) return {};
    return METHOD_DISPLAY_CONFIG[cls.scoring_method] || {};
  }

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
  // show "<faults> <time>" or just <time> when faults=0. Per-method
  // display config (METHOD_DISPLAY_CONFIG) can flip the visual hierarchy
  // when a method ranks by time-only (Table III) etc.
  function renderRoundCell(rnd, cls) {
    if (!roundHasData(rnd)) return '<span class="round-blank">—</span>';
    if (WEST.status.isKillingStatus(rnd.status)) {
      var label = WEST.status.publicLabel(rnd.status) || rnd.status;
      return '<span class="round-status">' + escapeHtml(label) + '</span>';
    }
    var faults = Number(rnd.total_faults) || 0;
    var timeStr = WEST.format.time(rnd.time);
    var cfg = configFor(cls);
    var faultsCls = 'round-faults'
      + (faults > 0 ? ' is-faulted' : '')
      + (cfg.faultsStyle === 'secondary' ? ' is-secondary' : '');
    var timeCls = 'round-time'
      + (cfg.timeStyle === 'primary' ? ' is-primary' : '');
    // Always show fault count — clean rounds read "0 Flts 32.757" so the
    // column shape is uniform and "Flts" is a recognizable cue.
    return '<span class="' + faultsCls + '">' + faults + ' Flts</span> ' +
           '<span class="' + timeCls + '">' + escapeHtml(timeStr) + '</span>';
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
  // under the method's ladder rules). On championship classes the
  // Ch/Res chip REPLACES the place number for places 1/2 (Ch implies
  // 1, Res implies 2 — number is redundant). Single source via
  // WEST.format.championshipMarker so hunter and other surfaces share
  // the rule.
  //
  // Bill 2026-05-06: when the class is FINAL (cls.is_final, set by
  // renderTable from opts.isFinal which class.html derives from
  // class.status==='complete'), places 1-12 render the WEST.flat.ribbonSvg
  // (same ribbon graphics used by hunter flat results). Places > 12 or
  // championship-marker rows keep the existing rendering.
  function renderPlaceCell(entry, cls) {
    var place = WEST.rules.jumperPlaceFor(
      entry.overall_place,
      cls.scoring_method,
      statusesOf(entry)
    );
    if (place == null) return '<span class="place-blank">—</span>';
    var marker = WEST.format.championshipMarker(place, cls.is_championship === 1);
    if (marker) {
      return '<span class="place-marker place-marker-solo">' + marker + '</span>';
    }
    if (cls.is_final && place >= 1 && place <= 12
        && window.WEST && window.WEST.flat && window.WEST.flat.ribbonSvg) {
      var ribbon = window.WEST.flat.ribbonSvg(place);
      if (ribbon) {
        // Bill 2026-05-06: prize money under the ribbon, FINAL only.
        // cls.prize_money is an array of dollar amounts per place
        // (1st = index 0). Renders only when there's an amount > 0.
        var prize = '';
        if (Array.isArray(cls.prize_money)
            && place >= 1
            && place <= cls.prize_money.length) {
          var amt = Number(cls.prize_money[place - 1]);
          if (Number.isFinite(amt) && amt > 0) {
            prize = '<span class="place-prize">$' + amt.toLocaleString() + '</span>';
          }
        }
        return '<span class="place-ribbon-wrap">'
          + '<span class="place-ribbon">' + ribbon + '</span>'
          + prize
          + '</span>';
      }
    }
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

  // Identity for the round templates (1R/2R/3R/TEAM). Three-line stack,
  // each line conditional on data present:
  //   Line 1: Horse — Rider + flag    (single line, hyphen separator)
  //   Line 2: Owner                   (regular, muted)
  //   Line 3: Sire × Dam              (smaller + italic — pedigree)
  // EQ template uses its own composer (rider primary, city/state line).
  function renderHorseRider(entry, cls) {
    var horse = escapeHtml(entry.horse_name || '—');
    var rider = escapeHtml(entry.rider_name || '');
    var flag  = flagify(cls, entry);
    // Horse + rider share line 1 with the rider rendered as a sibling
    // span so the flag can sit at the rider end without affecting horse.
    var html = '<div class="entry-horse-line">' +
      '<span class="entry-horse">' + horse + '</span>' +
      (rider ? ' <span class="entry-sep">—</span> <span class="entry-rider">' + rider + flag + '</span>' : '') +
      '</div>';
    if (entry.owner_name) {
      html += '<div class="entry-owner">' + escapeHtml(entry.owner_name) + '</div>';
    }
    var pedigree = '';
    if (entry.sire && entry.dam) pedigree = entry.sire + ' x ' + entry.dam;
    else if (entry.sire || entry.dam) pedigree = entry.sire || entry.dam;
    if (pedigree) {
      html += '<div class="entry-pedigree">' + escapeHtml(pedigree) + '</div>';
    }
    return html;
  }

  // ── Round-count templates (1R / 2R / 3R) ─────────────────────────────
  //
  // Same shape, parameterized by N. Generated once below — keeps the
  // three round templates in lockstep for future tweaks.
  function makeRoundTemplate(N) {
    // Column descriptors: { label, cls }. The cls drives both the
    // <th> alignment and the <td> styling so headers and cells stay
    // in lockstep when a column's alignment / width changes.
    // Round labels themselves come from WEST.format.roundLabel — single
    // source of truth shared across templates / live / stats / display.
    function buildHeaders(cls) {
      var hdrs = [
        { label: 'Pl', cls: 'entry-place' },
        { label: '#',  cls: 'entry-num'   },
        { html: '<span class="hd-line">Horse-Rider</span><span class="hd-line">Owner</span><span class="hd-line hd-breeding">Breeding</span>', cls: 'entry-horse-rider' },
      ];
      var method   = cls && cls.scoring_method;
      var modifier = cls && cls.scoring_modifier;
      for (var i = 1; i <= N; i++) {
        var lbl = WEST.format.roundLabel(method, modifier, i);
        hdrs.push({ label: lbl, cls: 'entry-round' });
      }
      return hdrs;
    }

    function renderRow(entry, cls) {
      var cells = [];
      cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
      cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
      cells.push('<td class="entry-horse-rider">' + renderHorseRider(entry, cls) + '</td>');
      for (var i = 1; i <= N; i++) {
        cells.push('<td class="entry-round">' + renderRoundCell(roundOf(entry, i), cls) + '</td>');
      }
      return '<tr>' + cells.join('') + '</tr>';
    }

    return {
      columns: buildHeaders,
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
      var base = [
        { label: 'Pl',            cls: 'entry-place'        },
        { label: '#',             cls: 'entry-num'          },
        { label: 'Rider / Horse', cls: 'entry-horse-rider'  },
      ];
      // Forced eq has no score column — operator just pins placements.
      if (cls && cls.scoring_method === 7 && cls.scoring_modifier === 0) return base;
      return base.concat([{ label: 'Score', cls: 'entry-score' }]);
    },
    renderRow: function (entry, cls) {
      var cells = [];
      cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
      cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
      // Identity: rider primary, horse secondary — inverse of the round
      // templates. WEST.format.singleLineIdentity gates the layout —
      // forced EQ collapses rider + horse onto a single line (with a
      // separator and the flag riding with the rider). Other EQ variants
      // keep rider stacked above horse. CSS scoping via .results-eq
      // flips the bold/muted styling so rider reads bold and horse muted.
      var horseTxt = escapeHtml(entry.horse_name || '');
      var riderTxt = escapeHtml(entry.rider_name || '—');
      var flagSpan = flagify(cls, entry);
      var locParts = [];
      if (entry.city)  locParts.push(entry.city);
      if (entry.state) locParts.push(entry.state);
      var locLine = locParts.length
        ? '<div class="entry-meta">' + escapeHtml(locParts.join(', ')) + '</div>'
        : '';
      var identityHtml;
      if (WEST.format.singleLineIdentity(cls)) {
        identityHtml = '<div class="entry-horse-line">' +
          '<span class="entry-rider">' + riderTxt + flagSpan + '</span>' +
          (horseTxt ? ' <span class="entry-sep">—</span> <span class="entry-horse">' + horseTxt + '</span>' : '') +
        '</div>' + locLine;
      } else {
        identityHtml =
          '<div class="entry-rider">' + riderTxt + flagSpan + '</div>' +
          '<div class="entry-horse">' + horseTxt + '</div>' +
          locLine;
      }
      cells.push('<td class="entry-horse-rider">' + identityHtml + '</td>');
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
    // Delegate to 3R for both columns and rows — picks up the
    // method-14 round labels (Round 1 / Round 2 / Jump Off) automatically
    // through WEST.format.roundLabel. Team aggregation layer comes later.
    columns: function (cls) {
      return WEST.jumperTemplates.templates['3R'].columns(cls);
    },
    renderRow: function (entry, cls) {
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
  // options.layout: 'stacked' (default — rounds collapsed into one
  //                 column, latest round on top: Jump Off above Round 1)
  //                 or 'inline' (round columns side-by-side).
  // Default is 'stacked' per Bill's session-34 directive — public-facing
  // pages get the compact layout. Future: layout becomes a show-level
  // admin setting (shows.results_layout) so operator can flip per show.
  // Stacked only differs visually for 2R / 3R / TEAM; 1R and EQ render
  // the same either way.
  WEST.jumperTemplates.renderTable = function (cls, entries, options) {
    options = options || {};
    var layout = options.layout || 'stacked';
    // opts.isFinal + opts.prizeMoney flow through to renderPlaceCell
    // via the cls object — simpler than threading params through every
    // nested template/row helper. Caller (class.html) sets isFinal from
    // class.finalized_at and prizeMoney from class.prize_money JSON.
    if ((options.isFinal && !cls.is_final) || (options.prizeMoney && !cls.prize_money)) {
      cls = Object.assign({}, cls, {
        is_final: cls.is_final || !!options.isFinal,
        prize_money: cls.prize_money || options.prizeMoney || null,
      });
    }
    var tplId = WEST.jumperTemplates.detect(cls);
    var multiRound = (tplId === '2R' || tplId === '3R' || tplId === 'TEAM');
    // Filter DNS-like entries (no place + no round data + no status) —
    // public consumers don't need to see registrations that never rode.
    entries = (entries || []).filter(function (e) { return !WEST.rules.isDnsLike(e); });
    if (layout === 'stacked' && multiRound) {
      return renderStackedTable(cls, entries, tplId);
    }
    var tpl = WEST.jumperTemplates.templates[tplId];
    var headers = tpl.columns(cls);
    var thead = '<thead><tr>' +
      headers.map(function (h) {
        var content = h.html != null ? h.html : escapeHtml(h.label);
        return '<th class="' + escapeHtml(h.cls) + '">' + content + '</th>';
      }).join('') +
      '</tr></thead>';
    var tbody = '<tbody>' +
      (entries || []).map(function (e) { return tpl.renderRow(e, cls); }).join('') +
      '</tbody>';
    return '<table class="results-table results-' + tplId.toLowerCase() + '">' +
      thead + tbody + '</table>';
  };

  // Stacked render: collapses 2-3 round columns into one "Rounds" column.
  // Each entry's rounds render top-down latest-first (Jump Off above
  // Round 1, etc.) per Bill's session-34 spec — saves horizontal space.
  function renderStackedTable(cls, entries, tplId) {
    var headers = [
      { label: 'Pl', cls: 'entry-place' },
      { label: '#',  cls: 'entry-num'   },
      { html: '<span class="hd-line">Horse-Rider</span><span class="hd-line">Owner</span><span class="hd-line hd-breeding">Breeding</span>', cls: 'entry-horse-rider' },
      { label: 'Rounds', cls: 'entry-round-stack' },
    ];
    var thead = '<thead><tr>' +
      headers.map(function (h) {
        var content = h.html != null ? h.html : escapeHtml(h.label);
        return '<th class="' + escapeHtml(h.cls) + '">' + content + '</th>';
      }).join('') +
      '</tr></thead>';
    var tbody = '<tbody>' +
      (entries || []).map(function (e) {
        return renderStackedRow(e, cls);
      }).join('') +
      '</tbody>';
    return '<table class="results-table results-' + tplId.toLowerCase() + ' is-stacked">' +
      thead + tbody + '</table>';
  }

  function renderStackedRow(entry, cls) {
    var method   = cls && cls.scoring_method;
    var modifier = cls && cls.scoring_modifier;
    var stacks = [];
    for (var i = 1; i <= 3; i++) {
      var rnd = roundOf(entry, i);
      if (!roundHasData(rnd)) continue;
      stacks.push({
        n: i,
        label: WEST.format.roundLabel(method, modifier, i),
        cellHtml: renderRoundCell(rnd, cls),
      });
    }
    // Latest round on top — Jump Off / Phase 2 / Round N reads first.
    stacks.reverse();
    var stackHtml = stacks.length
      ? stacks.map(function (s) {
          var lbl = s.label
            ? '<span class="round-label">' + escapeHtml(s.label) + '</span> '
            : '';
          return '<div class="round-stacked">' + lbl + s.cellHtml + '</div>';
        }).join('')
      : '<span class="round-blank">—</span>';
    var cells = [];
    cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
    cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
    cells.push('<td class="entry-horse-rider">' + renderHorseRider(entry, cls) + '</td>');
    cells.push('<td class="entry-round-stack">' + stackHtml + '</td>');
    return '<tr>' + cells.join('') + '</tr>';
  }

  // CommonJS export for tests / future Node consumers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.jumperTemplates;
  }
})(typeof window !== 'undefined' ? window : global);
