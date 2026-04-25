// v3/js/west-hunter-templates.js
//
// Per-template renderers for the HUNTER lens (class_type H).
//
// Detection ladder (Bill's session-34 spec, simplified):
//   1. is_equitation === 1   → EQ           (rider primary, overrides mode)
//   2. else, class_mode:
//        0 → OVER_FENCES
//        1 → FLAT
//        2 → DERBY
//        3 → SPECIAL
//
// Inside each template:
//   - scoring_type === 0 (Forced) → no score columns; place + identity
//   - scoring_type === 1 or 2 (Scored / Hi-Lo) → per-round totals + combined
//   - num_rounds drives the column count (1/2/3) for Scored/Hi-Lo
//   - is_championship → Ch/Res markers on places 1/2 (via shared
//     WEST.format.championshipMarker)
//   - num_judges > 1 → judges-grid expand is a future-phase feature;
//     for now we render the per-round combined total only
//   - derby_type → drives the hero label (DERBY template); no
//     column-shape change yet
//
// Cross-lens primitives this module consumes:
//   - WEST.format.escapeHtml / time / faults / ordinal / dayLabel
//   - WEST.format.flagFor (operator's Ryegate ShowFlags policy)
//   - WEST.format.championshipMarker (Ch/Res chip)
//   - WEST.status.publicLabel / isKillingStatus
//   - WEST.rules.hunterPlaceFor (R1 gate, scoring_type aware)
//
// Dual-env IIFE — browser pages load via <script>.

(function (root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.hunterTemplates = WEST.hunterTemplates || {};

  // ── Detection ────────────────────────────────────────────────────────
  WEST.hunterTemplates.detect = function (cls) {
    if (!cls) return 'OVER_FENCES';
    if (cls.is_equitation === 1) return 'EQ';
    switch (cls.class_mode) {
      case 0: return 'OVER_FENCES';
      case 1: return 'FLAT';
      case 2: return 'DERBY';
      case 3: return 'SPECIAL';
      default: return 'OVER_FENCES';
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────

  function escapeHtml(s) { return WEST.format.escapeHtml(s); }

  // Pull a single hunter round's wide-shape fields out of an entry.
  function hunterRoundOf(entry, n) {
    return {
      total:          entry['r' + n + '_score_total'],
      status:         entry['r' + n + '_h_status'],
      numeric_status: entry['r' + n + '_h_numeric_status'],
    };
  }

  function hunterRoundHasData(rnd) {
    if (!rnd) return false;
    if (rnd.status) return true;
    var t = Number(rnd.total);
    return Number.isFinite(t) && t > 0;
  }

  // Render a hunter round cell. Killing-status rounds show the public
  // status code; clean rounds show the round total (combined of all
  // judges for that round). Per-judge breakdown deferred to future phase.
  function renderHunterRoundCell(rnd) {
    if (!hunterRoundHasData(rnd)) return '<span class="round-blank">—</span>';
    if (WEST.status.isKillingStatus(rnd.status)) {
      var label = WEST.status.publicLabel(rnd.status) || rnd.status;
      return '<span class="round-status">' + escapeHtml(label) + '</span>';
    }
    var t = Number(rnd.total);
    return '<span class="hunter-score">' + (Number.isFinite(t) ? t : '—') + '</span>';
  }

  function renderCombinedCell(entry) {
    var total = Number(entry.combined_total);
    if (!Number.isFinite(total) || total === 0) return '<span class="round-blank">—</span>';
    return '<span class="hunter-combined">' + total + '</span>';
  }

  // Place column — defers to hunterPlaceFor for the R1-gate / forced-pin
  // logic. Adds Ch/Res chip on places 1/2 when class is_championship.
  function renderPlaceCell(entry, cls) {
    var place = WEST.rules.hunterPlaceFor(
      entry.current_place,
      cls.scoring_type,
      entry.r1_score_total,
      entry.r1_h_status
    );
    if (place == null) return '<span class="place-blank">—</span>';
    var marker = WEST.format.championshipMarker(place, cls.is_championship === 1);
    var markerHtml = marker ? ' <span class="place-marker">' + marker + '</span>' : '';
    return '<span class="place-num">' + place + '</span>' + markerHtml;
  }

  // Inline flag span — same policy gate as jumper (operator's ShowFlags).
  function flagify(cls, entry) {
    var rendered = WEST.format.flagFor(cls, entry);
    if (!rendered) return '';
    return ' <span class="entry-flag">' + escapeHtml(rendered) + '</span>';
  }

  // Identity stack (horse / rider primary order). Pedigree (sire × dam)
  // and owner render below as smaller subtitle lines, matching the
  // jumper templates. Caller decides which name leads (horse for
  // standard, rider for EQ) via the swap parameter.
  function renderIdentity(entry, cls, riderPrimary) {
    var horse = escapeHtml(entry.horse_name || '—');
    var rider = escapeHtml(entry.rider_name || '');
    var flag  = flagify(cls, entry);
    var line1;
    if (riderPrimary) {
      // Rider — Horse, flag with rider
      line1 = '<div class="entry-horse-line">' +
        '<span class="entry-rider">' + rider + flag + '</span>' +
        (horse ? ' <span class="entry-sep">—</span> <span class="entry-horse">' + horse + '</span>' : '') +
        '</div>';
    } else {
      // Horse — Rider (default — flag still rides with rider)
      line1 = '<div class="entry-horse-line">' +
        '<span class="entry-horse">' + horse + '</span>' +
        (rider ? ' <span class="entry-sep">—</span> <span class="entry-rider">' + rider + flag + '</span>' : '') +
        '</div>';
    }
    var html = line1;
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

  // ── Common row builders ──────────────────────────────────────────────
  //
  // Forced rows (no scores) — Pl + # + identity.
  // Scored rows — Pl + # + identity + Ri columns + combined.

  function buildForcedRow(entry, cls, riderPrimary) {
    var cells = [];
    cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
    cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
    cells.push('<td class="entry-horse-rider">' + renderIdentity(entry, cls, riderPrimary) + '</td>');
    return '<tr>' + cells.join('') + '</tr>';
  }

  function buildScoredRow(entry, cls, N, riderPrimary) {
    var cells = [];
    cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
    cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
    cells.push('<td class="entry-horse-rider">' + renderIdentity(entry, cls, riderPrimary) + '</td>');
    for (var i = 1; i <= N; i++) {
      cells.push('<td class="entry-round">' + renderHunterRoundCell(hunterRoundOf(entry, i)) + '</td>');
    }
    if (N > 1) {
      cells.push('<td class="entry-combined">' + renderCombinedCell(entry) + '</td>');
    }
    return '<tr>' + cells.join('') + '</tr>';
  }

  // Forced and Scored column descriptors share most cells; only the
  // round columns + combined differ. Round labels for hunter are
  // currently simple "R1 / R2 / R3" — round-label customization (e.g.
  // Derby's "Classic / Handy") is a future-phase format-module addition.
  function buildForcedColumns(riderPrimary) {
    return [
      { label: 'Pl', cls: 'entry-place' },
      { label: '#',  cls: 'entry-num'   },
      { label: riderPrimary ? 'Rider / Horse' : 'Horse / Rider', cls: 'entry-horse-rider' },
    ];
  }

  function buildScoredColumns(N, riderPrimary) {
    var cols = buildForcedColumns(riderPrimary);
    for (var i = 1; i <= N; i++) {
      cols.push({ label: 'R' + i, cls: 'entry-round' });
    }
    if (N > 1) {
      cols.push({ label: 'Total', cls: 'entry-combined' });
    } else {
      // For 1-round Scored, the single round IS the score — repurpose
      // the column header to read "Score".
      cols[cols.length - 1] = { label: 'Score', cls: 'entry-round' };
    }
    return cols;
  }

  // Templates pick columns + row-builder based on the class's
  // scoring_type and num_rounds. EQ flips the identity to rider-primary;
  // the rest share the same structure.

  function makeHunterTemplate(opts) {
    var riderPrimary = !!opts.riderPrimary;
    return {
      columns: function (cls) {
        if (cls && cls.scoring_type === 0) return buildForcedColumns(riderPrimary);
        var n = forcedSafeRoundCount(cls, opts.defaultRounds);
        return buildScoredColumns(n, riderPrimary);
      },
      renderRow: function (entry, cls) {
        if (cls && cls.scoring_type === 0) return buildForcedRow(entry, cls, riderPrimary);
        var n = forcedSafeRoundCount(cls, opts.defaultRounds);
        return buildScoredRow(entry, cls, n, riderPrimary);
      },
    };
  }

  // num_rounds may be missing on older data — opts.defaultRounds gives
  // the per-template fallback (FLAT defaults to 1; OF/SPECIAL/EQ default
  // to whatever num_rounds says, capped 1-3; DERBY defaults to 2).
  function forcedSafeRoundCount(cls, fallback) {
    var n = cls && Number(cls.num_rounds);
    if (Number.isFinite(n) && n >= 1 && n <= 3) return n;
    return fallback;
  }

  // FLAT special-case — always 1 round regardless of num_rounds.
  var FLAT_TEMPLATE = {
    columns: function (cls) {
      if (cls && cls.scoring_type === 0) return buildForcedColumns(false);
      return buildScoredColumns(1, false);
    },
    renderRow: function (entry, cls) {
      if (cls && cls.scoring_type === 0) return buildForcedRow(entry, cls, false);
      return buildScoredRow(entry, cls, 1, false);
    },
  };

  // ── Registry ─────────────────────────────────────────────────────────
  WEST.hunterTemplates.templates = {
    'OVER_FENCES': makeHunterTemplate({ defaultRounds: 1 }),
    'FLAT':        FLAT_TEMPLATE,
    'DERBY':       makeHunterTemplate({ defaultRounds: 2 }),
    'SPECIAL':     makeHunterTemplate({ defaultRounds: 1 }),
    'EQ':          makeHunterTemplate({ defaultRounds: 1, riderPrimary: true }),
  };

  // Convenience renderTable — same surface as jumperTemplates.renderTable.
  // options.layout: 'stacked' (default) or 'inline'. Single-round
  // templates render the same in either mode.
  WEST.hunterTemplates.renderTable = function (cls, entries, options) {
    options = options || {};
    var layout = options.layout || 'stacked';
    var tplId = WEST.hunterTemplates.detect(cls);
    var tpl = WEST.hunterTemplates.templates[tplId];
    // Filter DNS-like entries (no place + no round data + no status) —
    // shared cross-lens rule via WEST.rules.isDnsLike.
    entries = (entries || []).filter(function (e) { return !WEST.rules.isDnsLike(e); });
    var multiRound = false;
    var roundCount = forcedSafeRoundCount(cls, 1);
    if (cls && cls.scoring_type !== 0 && tplId !== 'FLAT' && roundCount > 1) {
      multiRound = true;
    }
    if (layout === 'stacked' && multiRound) {
      return renderStackedTable(cls, entries, tplId, tpl);
    }
    var headers = tpl.columns(cls);
    var thead = '<thead><tr>' +
      headers.map(function (h) {
        return '<th class="' + escapeHtml(h.cls) + '">' + escapeHtml(h.label) + '</th>';
      }).join('') +
      '</tr></thead>';
    var tbody = '<tbody>' +
      (entries || []).map(function (e) { return tpl.renderRow(e, cls); }).join('') +
      '</tbody>';
    return '<table class="results-table results-h-' + tplId.toLowerCase() + '">' +
      thead + tbody + '</table>';
  };

  // Stacked variant — collapses round columns into one column with each
  // round on its own line, latest round on top.
  function renderStackedTable(cls, entries, tplId, tpl) {
    var headers = tpl.columns(cls).slice(0, 3);  // Pl + # + identity
    headers.push({ label: 'Rounds', cls: 'entry-round-stack' });
    var thead = '<thead><tr>' +
      headers.map(function (h) {
        return '<th class="' + escapeHtml(h.cls) + '">' + escapeHtml(h.label) + '</th>';
      }).join('') +
      '</tr></thead>';
    var tbody = '<tbody>' +
      (entries || []).map(function (e) {
        return renderStackedRow(e, cls, tplId);
      }).join('') +
      '</tbody>';
    return '<table class="results-table results-h-' + tplId.toLowerCase() + ' is-stacked">' +
      thead + tbody + '</table>';
  }

  function renderStackedRow(entry, cls, tplId) {
    var riderPrimary = (tplId === 'EQ');
    var maxN = forcedSafeRoundCount(cls, 1);
    var stacks = [];
    for (var i = 1; i <= maxN; i++) {
      var rnd = hunterRoundOf(entry, i);
      if (!hunterRoundHasData(rnd)) continue;
      stacks.push({
        n: i,
        label: 'Round ' + i,
        cellHtml: renderHunterRoundCell(rnd),
      });
    }
    // Hunters render chronologically — Round 1 on top, Round 2 below.
    // (Jumpers reverse because the Jump Off is the climactic round.)
    var stackHtml = stacks.length
      ? stacks.map(function (s) {
          return '<div class="round-stacked">' +
                   '<span class="round-label">' + escapeHtml(s.label) + '</span> ' +
                   s.cellHtml +
                 '</div>';
        }).join('')
      : '<span class="round-blank">—</span>';
    if (maxN > 1) {
      var combined = renderCombinedCell(entry);
      stackHtml += '<div class="round-stacked round-combined-row">' +
                     '<span class="round-label">Total</span> ' + combined +
                   '</div>';
    }
    var cells = [];
    cells.push('<td class="entry-place">' + renderPlaceCell(entry, cls) + '</td>');
    cells.push('<td class="entry-num">' + escapeHtml(entry.entry_num || '') + '</td>');
    cells.push('<td class="entry-horse-rider">' + renderIdentity(entry, cls, riderPrimary) + '</td>');
    cells.push('<td class="entry-round-stack">' + stackHtml + '</td>');
    return '<tr>' + cells.join('') + '</tr>';
  }

  // CommonJS export for tests / future Node consumers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.hunterTemplates;
  }
})(typeof window !== 'undefined' ? window : global);
