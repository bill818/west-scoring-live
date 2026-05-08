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
  // logic. On championship classes, the Ch/Res chip REPLACES the place
  // number on places 1/2 (Ch implies 1, Res implies 2 — number is
  // redundant). All other places render as the bare place number.
  //
  // Bill 2026-05-06: when class is FINAL (cls.is_final from
  // class.finalized_at) AND the class declared a ribbon count via
  // its .cls header (cls.ribbon_count = H[8]), render WEST.ribbons.svg
  // for places 1..ribbon_count. Places beyond ribbon_count keep the
  // bare number (no ribbon awarded for them). Prize money under the
  // ribbon when cls.prize_money carries an amount > 0 for that place.
  function renderPlaceCell(entry, cls) {
    var place = WEST.rules.hunterPlaceFor(
      entry.current_place,
      cls.scoring_type,
      entry.r1_score_total,
      entry.r1_h_status
    );
    if (place == null) return '<span class="place-blank">—</span>';
    var marker = WEST.format.championshipMarker(place, cls.is_championship === 1);
    if (marker) {
      return '<span class="place-marker place-marker-solo">' + marker + '</span>';
    }
    var ribbonCap = Number(cls.ribbon_count) || 0;
    if (cls.is_final && ribbonCap > 0 && place >= 1 && place <= ribbonCap
        && window.WEST && window.WEST.ribbons && window.WEST.ribbons.svg) {
      var ribbon = window.WEST.ribbons.svg(place);
      if (ribbon) {
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
      { html: '<span class="hd-line">' + (riderPrimary ? 'Rider-Horse' : 'Horse-Rider') + '</span><span class="hd-line">Owner</span><span class="hd-line hd-breeding">Breeding</span>', cls: 'entry-horse-rider' },
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
    // opts.isFinal + opts.prizeMoney flow through to renderPlaceCell
    // via the cls object — same pattern as jumperTemplates.renderTable.
    // cls.prize_money from /v3/listClasses is a JSON STRING; parse to
    // an array so Array.isArray(cls.prize_money) succeeds downstream.
    if (options.isFinal || options.prizeMoney || (cls.prize_money && typeof cls.prize_money === 'string')) {
      var parsedMoney = options.prizeMoney || null;
      if (!parsedMoney && typeof cls.prize_money === 'string') {
        try { var p = JSON.parse(cls.prize_money); if (Array.isArray(p)) parsedMoney = p; }
        catch (e) { /* malformed — degrade silently */ }
      } else if (!parsedMoney && Array.isArray(cls.prize_money)) {
        parsedMoney = cls.prize_money;
      }
      cls = Object.assign({}, cls, {
        is_final: cls.is_final || !!options.isFinal,
        prize_money: parsedMoney,
      });
    }
    var tplId = WEST.hunterTemplates.detect(cls);
    var tpl = WEST.hunterTemplates.templates[tplId];
    // Filter DNS-like entries (no place + no round data + no status) —
    // shared cross-lens rule via WEST.rules.isDnsLike.
    entries = (entries || []).filter(function (e) { return !WEST.rules.isDnsLike(e); });
    // Build entry_id → grid-row map when judges-grid data is available.
    // Used to emit per-entry drop-down detail rows beneath each main
    // row (multi-judge hunter classes only — gate decides).
    var gridById = null;
    if (options.judgeGrid && options.judgeGrid.rows && WEST.format.judgesGridApplies(cls)) {
      gridById = new Map();
      options.judgeGrid.rows.forEach(function (gr) { gridById.set(gr.entry_id, gr); });
    }
    var multiRound = false;
    var roundCount = forcedSafeRoundCount(cls, 1);
    if (cls && cls.scoring_type !== 0 && tplId !== 'FLAT' && roundCount > 1) {
      multiRound = true;
    }
    if (layout === 'stacked' && multiRound) {
      return renderStackedTable(cls, entries, tplId, tpl, gridById);
    }
    var headers = tpl.columns(cls);
    var thead = '<thead><tr>' +
      headers.map(function (h) {
        var content = h.html != null ? h.html : escapeHtml(h.label);
        return '<th class="' + escapeHtml(h.cls) + '">' + content + '</th>';
      }).join('') +
      '</tr></thead>';
    var colspan = headers.length;
    var tbody = '<tbody>' + entries.map(function (e) {
      var rowHtml = tpl.renderRow(e, cls);
      if (gridById && gridById.has(e.id)) {
        // Mark the main row clickable + inject "▸ View Breakdown" hint +
        // append a hidden drop-down row with this entry's per-judge
        // grid. Class.html attaches the toggle handler after innerHTML.
        rowHtml = rowHtml.replace(/^<tr>/,
          '<tr class="has-judges-toggle" data-entry-id="' + e.id + '">');
        rowHtml = injectJudgesHint(rowHtml);
        rowHtml += renderJudgeDropdownRow(gridById.get(e.id), cls, colspan);
      }
      return rowHtml;
    }).join('') + '</tbody>';
    return '<table class="results-table results-h-' + tplId.toLowerCase() + '">' +
      thead + tbody + '</table>';
  };

  // Inject a small "▸ View Breakdown" hint chip at the bottom of the
  // last cell of the row (the rightmost score column — entry-combined
  // for multi-round, last entry-round for 1-round). Positions the
  // affordance directly under the score so users see expandability
  // where their eye naturally lands. CSS rotates the arrow to ▾
  // when the row is open.
  function injectJudgesHint(rowHtml) {
    var lastClose = rowHtml.lastIndexOf('</td>');
    if (lastClose === -1) return rowHtml;
    return rowHtml.slice(0, lastClose) +
      '<div class="judges-hint">View Breakdown</div>' +
      rowHtml.slice(lastClose);
  }

  // Per-entry drop-down detail (one <tr> with single colspan'd <td>
  // containing the inline judge grid for this entry). Rendered hidden
  // by default; class.html toggles .is-open on click.
  function renderJudgeDropdownRow(gridEntry, cls, colspan) {
    return '<tr class="judges-detail-row" data-entry-id="' + gridEntry.entry_id + '">' +
      '<td colspan="' + colspan + '">' +
        renderEntryJudgeGrid(gridEntry, cls) +
      '</td>' +
    '</tr>';
  }

  // Inline mini-grid for ONE entry — header row + per-round rows +
  // per-judge totals row. Self-contained CSS grid so the columns line
  // up within this entry's box (no shared header dependency).
  function renderEntryJudgeGrid(gridEntry, cls) {
    var judgeCount = Math.max(1, Number(cls.num_judges) || 1);
    var numRounds  = Math.max(1, Math.min(3, Number(cls.num_rounds) || 1));
    var isDerby    = WEST.format.derbyComponentsApply(cls);
    var showTotalCol  = judgeCount > 1;
    var showTotalsRow = numRounds > 1;

    // Grid-template-columns shared by header + all rows so columns are
    // UNIFORM (every J-column the same width regardless of which row's
    // content is widest). v2-style adaptive widths — narrower judge
    // columns when there are many judges, wider for derby (room for
    // base+hi+handy components).
    var judgeColW = isDerby ? 100 : 70;
    if (judgeCount >= 5) judgeColW = isDerby ? 80 : 50;
    var totalColW = 90;
    var gridCols = '28px';
    for (var ji = 0; ji < judgeCount; ji++) gridCols += ' ' + judgeColW + 'px';
    if (showTotalCol) gridCols += ' ' + totalColW + 'px';

    // Header — concise. Derby cells already read as "base+hi+handy"
    // visually; we used to put "J1 + HiOpt + Handy" in the column header
    // but it inflated each column width way past the data. Just J1 / J2
    // / etc. now; the cell format speaks for itself.
    // "(Place)" annotation tells the viewer the parenthesized numbers
    // (N) shown next to each score are the rank, not part of the score.
    var hdr = ['<span class="ejg-rnd-lbl"></span>'];
    for (var jh = 0; jh < judgeCount; jh++) {
      hdr.push('<span class="ejg-hdr">J' + (jh + 1) + ' <span class="ejg-hdr-note">(Place)</span></span>');
    }
    if (showTotalCol) hdr.push('<span class="ejg-hdr">Total <span class="ejg-hdr-note">(Place)</span></span>');

    var html = '<div class="entry-judge-grid">';
    html += '<div class="ejg-row ejg-header" style="grid-template-columns:' + gridCols + '">' +
      hdr.join('') + '</div>';

    // Per-round rows
    for (var n = 1; n <= numRounds; n++) {
      var rd = gridEntry.rounds && gridEntry.rounds.find(function (r) { return r.round === n; });
      if (rd && WEST.status.isKillingStatus(rd.status)) {
        var lbl = WEST.status.publicLabel(rd.status) || rd.status;
        html += '<div class="ejg-row" style="grid-template-columns:' + gridCols + '">' +
          '<span class="ejg-rnd-lbl">R' + n + '</span>' +
          '<span class="ejg-status" style="grid-column: 2 / -1">' +
            escapeHtml(lbl) +
          '</span>' +
        '</div>';
        continue;
      }
      var cells = ['<span class="ejg-rnd-lbl">R' + n + '</span>'];
      for (var jc = 0; jc < judgeCount; jc++) {
        var j = rd && rd.judges && rd.judges.find(function (x) { return x.idx === jc; });
        var cellTxt = '';
        if (j) {
          if (isDerby) {
            var parts = [];
            if (j.base != null)  parts.push(j.base);
            if (j.hiopt)         parts.push('+' + j.hiopt);
            if (j.handy)         parts.push('+' + j.handy);
            cellTxt = parts.join('');
          } else {
            cellTxt = j.base != null ? String(j.base) : '';
          }
        }
        var rkTxt = (j && j.rank) ? ' <span class="ejg-rank">(' + j.rank + ')</span>' : '';
        cells.push('<span class="ejg-cell">' + escapeHtml(cellTxt) + rkTxt + '</span>');
      }
      if (showTotalCol) {
        var totTxt = (rd && rd.total != null) ? rd.total : '';
        var totRk  = (rd && rd.overallRank) ? ' <span class="ejg-rank">(' + rd.overallRank + ')</span>' : '';
        cells.push('<span class="ejg-cell ejg-round-total">' + escapeHtml(totTxt) + totRk + '</span>');
      }
      html += '<div class="ejg-row" style="grid-template-columns:' + gridCols + '">' + cells.join('') + '</div>';
    }

    // Per-judge totals row + combined
    if (showTotalsRow) {
      var trCells = ['<span class="ejg-rnd-lbl"></span>'];
      for (var jt = 0; jt < judgeCount; jt++) {
        var card = gridEntry.judgeCards && gridEntry.judgeCards.find(function (x) { return x.idx === jt; });
        if (card) {
          var rk = card.rank ? ' <span class="ejg-rank">(' + card.rank + ')</span>' : '';
          trCells.push('<span class="ejg-judge-card">J' + (jt + 1) + ' ' + card.total + rk + '</span>');
        } else {
          trCells.push('<span class="ejg-judge-card"></span>');
        }
      }
      if (showTotalCol) {
        var combined = gridEntry.combined != null ? gridEntry.combined : '';
        trCells.push('<span class="ejg-combined">' + escapeHtml(combined) + '</span>');
      }
      html += '<div class="ejg-row ejg-totals" style="grid-template-columns:' + gridCols + '">' +
        trCells.join('') + '</div>';
    }

    html += '</div>';
    return html;
  }

  // Stacked variant — collapses round columns into one column with each
  // round on its own line, latest round on top.
  function renderStackedTable(cls, entries, tplId, tpl, gridById) {
    var headers = tpl.columns(cls).slice(0, 3);  // Pl + # + identity
    headers.push({ label: 'Rounds', cls: 'entry-round-stack' });
    var thead = '<thead><tr>' +
      headers.map(function (h) {
        var content = h.html != null ? h.html : escapeHtml(h.label);
        return '<th class="' + escapeHtml(h.cls) + '">' + content + '</th>';
      }).join('') +
      '</tr></thead>';
    var colspan = headers.length;
    var tbody = '<tbody>' + entries.map(function (e) {
      var rowHtml = renderStackedRow(e, cls, tplId);
      if (gridById && gridById.has(e.id)) {
        rowHtml = rowHtml.replace(/^<tr>/,
          '<tr class="has-judges-toggle" data-entry-id="' + e.id + '">');
        rowHtml = injectJudgesHint(rowHtml);
        rowHtml += renderJudgeDropdownRow(gridById.get(e.id), cls, colspan);
      }
      return rowHtml;
    }).join('') + '</tbody>';
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

  // ── JUDGES GRID RENDERER ─────────────────────────────────────────────
  //
  // Consumes the /v3/listJudgeGrid response shape and returns a full
  // table HTML string. Mirrors v2's renderJudgeGrid layout — header row
  // (J1, J2, …, Round Total) at top, then per-entry sections containing
  // identity column on the left and score grid on the right (per-round
  // rows + per-judge totals row + combined).
  //
  // Mode awareness: derby cells show "base+hiopt+handy"; non-derby cells
  // show just the base score. Header label includes "+ HiOpt + Bonus"
  // for derby. Same gate (WEST.format.derbyComponentsApply) controls
  // both decisions.
  //
  // Smart collapses:
  //   1 judge × 1 round: caller shouldn't be calling this — basic table
  //                       handles it.
  //   1 judge × multi-round: drops the Round Total column (redundant).
  //   multi-judge × 1 round: drops the per-judge totals row (round total
  //                          IS the overall).
  //   eliminated entry:       status code in red replaces the scores.

  WEST.hunterTemplates.renderJudgeGrid = function (gridData, cls) {
    if (!gridData || !gridData.rows || !cls) return '';
    var rows = gridData.rows.filter(function (r) {
      return !WEST.rules.isDnsLike(r);
    });
    if (!rows.length) return '<div class="placeholder">No entries yet.</div>';

    var judgeCount = Math.max(1, Number(cls.num_judges) || 1);
    var numRounds  = Math.max(1, Math.min(3, Number(cls.num_rounds) || 1));
    var isDerby    = WEST.format.derbyComponentsApply(cls);
    var showTotalCol  = judgeCount > 1;
    var showTotalsRow = numRounds > 1;

    // Header — built once at the top, identity column left of the grid
    var grid_cols = 'auto'; // round label
    for (var jh = 0; jh < judgeCount; jh++) grid_cols += ' minmax(0, 1fr)';
    if (showTotalCol) grid_cols += ' minmax(80px, auto)';

    var hdrCells = ['<span class="jg-rnd-lbl"></span>'];
    for (var i = 0; i < judgeCount; i++) {
      hdrCells.push('<span class="jg-hdr">J' + (i + 1) +
        (isDerby ? ' + HiOpt + Handy' : '') + '</span>');
    }
    if (showTotalCol) hdrCells.push('<span class="jg-hdr">Round Total</span>');
    var headerHtml =
      '<div class="judge-grid-header" style="grid-template-columns:' + grid_cols + '">' +
      hdrCells.join('') +
      '</div>';

    var html = '<div class="judge-grid">';
    html += '<div class="judge-grid-header-wrap">' + headerHtml + '</div>';

    rows.forEach(function (e) {
      html += '<div class="judge-grid-entry">' +
        '<div class="jg-identity">' +
          '<div class="jg-place">' + renderJudgeGridPlace(e, cls) + '</div>' +
          '<div class="jg-id-stack">' +
            '<div class="entry-num">#' + escapeHtml(e.entry_num) + '</div>' +
            renderJudgeGridIdentity(e, cls) +
          '</div>' +
        '</div>' +
        '<div class="jg-scores">' +
          renderJudgeGridScores(e, cls, judgeCount, numRounds, isDerby, grid_cols, showTotalCol, showTotalsRow) +
        '</div>' +
      '</div>';
    });

    html += '</div>';
    return html;
  };

  function renderJudgeGridPlace(entry, cls) {
    if (entry.place == null) return '<span class="place-blank">—</span>';
    var marker = WEST.format.championshipMarker(entry.place, cls.is_championship === 1);
    if (marker) {
      return '<span class="place-marker place-marker-solo">' + marker + '</span>';
    }
    return '<span class="place-num">' + entry.place + '</span>';
  }

  // Identity for the grid — mirrors the round-template stack (Horse — Rider /
  // Owner / Sire×Dam) but compacted; flag rides with rider via flagFor.
  function renderJudgeGridIdentity(entry, cls) {
    var horse = escapeHtml(entry.horse_name || '—');
    var rider = escapeHtml(entry.rider_name || '');
    var flag  = WEST.format.flagFor(cls, entry);
    var flagHtml = flag ? ' <span class="entry-flag">' + escapeHtml(flag) + '</span>' : '';
    var html =
      '<div class="entry-horse-line">' +
        '<span class="entry-horse">' + horse + '</span>' +
        (rider ? ' <span class="entry-sep">—</span> <span class="entry-rider">' + rider + flagHtml + '</span>' : '') +
      '</div>';
    if (entry.owner_name) {
      html += '<div class="entry-owner">' + escapeHtml(entry.owner_name) + '</div>';
    }
    var pedigree = '';
    if (entry.sire && entry.dam) pedigree = entry.sire + ' x ' + entry.dam;
    else if (entry.sire || entry.dam) pedigree = entry.sire || entry.dam;
    if (pedigree) html += '<div class="entry-pedigree">' + escapeHtml(pedigree) + '</div>';
    return html;
  }

  function renderJudgeGridScores(entry, cls, judgeCount, numRounds, isDerby, gridCols, showTotalCol, showTotalsRow) {
    var html = '';
    // Per-round rows
    for (var n = 1; n <= numRounds; n++) {
      var rd = entry.rounds && entry.rounds.find(function (r) { return r.round === n; });
      // Killing-status round → status-only row (red)
      if (rd && WEST.status.isKillingStatus(rd.status)) {
        var lbl = WEST.status.publicLabel(rd.status) || rd.status;
        html += '<div class="jg-round-row" style="grid-template-columns:' + gridCols + '">' +
          '<span class="jg-rnd-lbl">R' + n + '</span>' +
          '<span class="jg-status" style="grid-column:span ' + judgeCount + (showTotalCol ? ' / -1' : '') + '">' +
            escapeHtml(lbl) +
          '</span>' +
        '</div>';
        continue;
      }
      // Normal round row — render each judge cell
      var cells = ['<span class="jg-rnd-lbl">R' + n + '</span>'];
      for (var ji = 0; ji < judgeCount; ji++) {
        var j = rd && rd.judges && rd.judges.find(function (x) { return x.idx === ji; });
        var cellTxt = '';
        if (j) {
          if (isDerby) {
            var parts = [];
            if (j.base != null) parts.push(j.base);
            if (j.hiopt)        parts.push('+' + j.hiopt);
            if (j.handy)        parts.push('+' + j.handy);
            cellTxt = parts.join('');
          } else {
            cellTxt = j.base != null ? String(j.base) : '';
          }
        }
        var rkTxt = (j && j.rank) ? ' <span class="jg-rank">(' + j.rank + ')</span>' : '';
        cells.push('<span class="jg-cell">' + escapeHtml(cellTxt) + rkTxt + '</span>');
      }
      if (showTotalCol) {
        var totTxt = (rd && rd.total != null) ? rd.total : '';
        var totRk  = (rd && rd.overallRank) ? ' <span class="jg-rank">(' + rd.overallRank + ')</span>' : '';
        cells.push('<span class="jg-cell jg-round-total">' + escapeHtml(totTxt) + totRk + '</span>');
      }
      html += '<div class="jg-round-row" style="grid-template-columns:' + gridCols + '">' + cells.join('') + '</div>';
    }
    // Per-judge totals row + combined
    if (showTotalsRow) {
      var trCells = ['<span class="jg-rnd-lbl"></span>'];
      for (var jt = 0; jt < judgeCount; jt++) {
        var jc = entry.judgeCards && entry.judgeCards.find(function (x) { return x.idx === jt; });
        if (jc) {
          var rk = jc.rank ? ' <span class="jg-rank">(' + jc.rank + ')</span>' : '';
          trCells.push('<span class="jg-judge-card">J' + (jt + 1) + ' ' + jc.total + rk + '</span>');
        } else {
          trCells.push('<span class="jg-judge-card"></span>');
        }
      }
      if (showTotalCol) {
        var combined = entry.combined != null ? entry.combined : '';
        trCells.push('<span class="jg-combined">' + escapeHtml(combined) + '</span>');
      }
      html += '<div class="jg-round-row jg-totals" style="grid-template-columns:' + gridCols + '">' +
        trCells.join('') +
      '</div>';
    }
    return html;
  }

  // ── BY-JUDGE VIEW ────────────────────────────────────────────────────
  //
  // Class regrouped by judge. One section per judge, each containing the
  // entries ordered by THAT judge's pre-computed card rank ascending
  // (server is authoritative — never re-sort by raw totals on the client).
  // Each entry shows: that judge's rank, identity, per-round scores from
  // that judge only, and the judge's card total.
  //
  // Killing-status R1 → shown at the bottom (no card rank), dimmed,
  // status label in place of the rank. Per-round killing-status (R2/R3)
  // → status pill in that round row, earlier rounds still visible.
  //
  // Consumes the same /v3/listJudgeGrid response shape as
  // renderJudgeGrid and the per-row dropdown.

  WEST.hunterTemplates.renderByJudgeView = function (cls, gridData) {
    if (!gridData || !gridData.rows || !cls) return '';
    var rows = gridData.rows.filter(function (r) {
      return !WEST.rules.isDnsLike(r);
    });
    if (!rows.length) return '<div class="placeholder">No entries yet.</div>';

    var judgeCount = Math.max(1, Number(cls.num_judges) || 1);
    var numRounds  = Math.max(1, Math.min(3, Number(cls.num_rounds) || 1));
    var isDerby    = WEST.format.derbyComponentsApply(cls);
    var isEq       = cls.is_equitation === 1;

    var html = '<div class="by-judge-view">';
    for (var ji = 0; ji < judgeCount; ji++) {
      html += renderJudgeSection(ji, rows, cls, numRounds, judgeCount, isDerby, isEq);
    }
    html += '</div>';
    return html;
  };

  function judgeCardOf(row, ji) {
    return row.judgeCards && row.judgeCards.find(function (x) { return x.idx === ji; });
  }

  function r1StatusOf(row) {
    var rd = row.rounds && row.rounds.find(function (r) { return r.round === 1; });
    return rd ? rd.status : null;
  }

  function renderJudgeSection(ji, rows, cls, numRounds, judgeCount, isDerby, isEq) {
    // Sort by this judge's pre-computed card rank ascending. Unranked
    // (full-elim or no card) lands at the bottom — server hasn't given
    // them a rank, we don't invent one.
    var sorted = rows.slice().sort(function (a, b) {
      var ra = (judgeCardOf(a, ji) || {}).rank;
      var rb = (judgeCardOf(b, ji) || {}).rank;
      var ax = (ra == null) ? Infinity : ra;
      var bx = (rb == null) ? Infinity : rb;
      return ax - bx;
    });

    // Header row — Rank | # | Horse / Rider | R1 [| R2 [| R3]] | Card Total
    var hdrCells = [
      '<th class="bj-h-rank">Rank</th>',
      '<th class="bj-h-num">#</th>',
      '<th class="bj-h-id">' + (isEq ? 'Rider / Horse' : 'Horse / Rider') + '</th>',
    ];
    for (var n = 1; n <= numRounds; n++) {
      hdrCells.push('<th class="bj-h-rnd">R' + n + '</th>');
    }
    hdrCells.push('<th class="bj-h-total">Card Total</th>');

    var bodyHtml = sorted.map(function (row) {
      return renderByJudgeRow(row, cls, ji, numRounds, isDerby, isEq);
    }).join('');

    return '<section class="by-judge-section">' +
      '<h3 class="by-judge-hdr">Judge ' + (ji + 1) + '</h3>' +
      '<table class="by-judge-table">' +
        '<thead><tr>' + hdrCells.join('') + '</tr></thead>' +
        '<tbody>' + bodyHtml + '</tbody>' +
      '</table>' +
    '</section>';
  }

  function renderByJudgeRow(row, cls, ji, numRounds, isDerby, isEq) {
    var card   = judgeCardOf(row, ji);
    var rank   = card && card.rank;
    var total  = card && card.total;
    var killR1 = WEST.status.isKillingStatus(r1StatusOf(row));

    // Rank cell — full-elim shows status; otherwise this judge's rank.
    // Ch/Res chip only on places 1/2 of championship classes.
    var rankHtml;
    if (killR1) {
      var elimLbl = WEST.status.publicLabel(r1StatusOf(row)) || r1StatusOf(row) || 'EL';
      rankHtml = '<span class="bj-rank-status">' + escapeHtml(elimLbl) + '</span>';
    } else if (rank) {
      var marker = WEST.format.championshipMarker(rank, cls.is_championship === 1);
      rankHtml = marker
        ? '<span class="place-marker place-marker-solo">' + marker + '</span>'
        : '<span class="bj-rank">' + rank + '</span>';
    } else {
      rankHtml = '<span class="bj-rank-blank">—</span>';
    }

    var roundCells = '';
    for (var n = 1; n <= numRounds; n++) {
      var rd = row.rounds && row.rounds.find(function (r) { return r.round === n; });
      if (killR1) {
        roundCells += '<td class="bj-rnd-cell"><span class="bj-rnd-blank">—</span></td>';
        continue;
      }
      if (rd && WEST.status.isKillingStatus(rd.status)) {
        var rlbl = WEST.status.publicLabel(rd.status) || rd.status;
        roundCells += '<td class="bj-rnd-cell"><span class="bj-rnd-status">' +
          escapeHtml(rlbl) + '</span></td>';
        continue;
      }
      var j = rd && rd.judges && rd.judges.find(function (x) { return x.idx === ji; });
      var cellTxt = '';
      if (j) {
        if (isDerby) {
          var parts = [];
          if (j.base != null) parts.push(j.base);
          if (j.hiopt)        parts.push('+' + j.hiopt);
          if (j.handy)        parts.push('+' + j.handy);
          cellTxt = parts.join('');
        } else {
          cellTxt = j.base != null ? String(j.base) : '';
        }
      }
      roundCells += '<td class="bj-rnd-cell">' +
        (cellTxt ? '<span class="bj-rnd-val">' + escapeHtml(cellTxt) + '</span>'
                 : '<span class="bj-rnd-blank">—</span>') +
      '</td>';
    }

    var totalCell = (!killR1 && total != null)
      ? '<td class="bj-total-cell"><span class="bj-total">' + escapeHtml(String(total)) + '</span></td>'
      : '<td class="bj-total-cell"><span class="bj-rnd-blank">—</span></td>';

    return '<tr class="by-judge-row' + (killR1 ? ' is-elim' : '') + '">' +
      '<td class="bj-rank-cell">' + rankHtml + '</td>' +
      '<td class="bj-num-cell">' + escapeHtml(row.entry_num || '') + '</td>' +
      '<td class="bj-id-cell">' + renderIdentity(row, cls, isEq) + '</td>' +
      roundCells +
      totalCell +
    '</tr>';
  }

  // ── LIVE SCORE CARD ──────────────────────────────────────────────────
  // Right-side card shown on hunter live surfaces when a Display Scores
  // trigger (fr=12/14/16) names a focused entry AND that entry has score
  // data in hunter_scores. Returns { html, hasScore }; caller hides the
  // card slot entirely when hasScore is false.
  //
  // Per Bill 2026-05-05: hunter has no clock — the right card stays
  // empty (and HIDDEN) until scores populate.
  WEST.hunterTemplates.renderScoreCard = function (meta, hunterScores, snapshot) {
    const empty = { html: '', hasScore: false };
    if (!snapshot || !Array.isArray(hunterScores)) return empty;
    const ls = snapshot.last_scoring;
    if (!ls || ls.channel !== 'A') return empty;
    if (ls.frame !== 12 && ls.frame !== 14 && ls.frame !== 16) return empty;
    const tagEntry = String((ls.tags || {})['1'] || '').replace(/\r/g, '').trim();
    if (!tagEntry) return empty;
    let entryRow = null;
    for (let i = 0; i < hunterScores.length; i++) {
      if (String(hunterScores[i].entry_num) === tagEntry) { entryRow = hunterScores[i]; break; }
    }
    if (!entryRow) return empty;

    const fmt = function (v) { return (v == null) ? null : Number(v).toFixed(3); };
    const r1 = fmt(entryRow.r1_score_total);
    const r2 = fmt(entryRow.r2_score_total);
    const r3 = fmt(entryRow.r3_score_total);
    const combined = fmt(entryRow.combined_total);
    const rounds = [];
    if (r1) rounds.push('<div class="hunter-score-round"><span class="hunter-score-round-lbl">R1</span><span class="hunter-score-round-val">' + r1 + '</span></div>');
    if (r2) rounds.push('<div class="hunter-score-round"><span class="hunter-score-round-lbl">R2</span><span class="hunter-score-round-val">' + r2 + '</span></div>');
    if (r3) rounds.push('<div class="hunter-score-round"><span class="hunter-score-round-lbl">R3</span><span class="hunter-score-round-val">' + r3 + '</span></div>');

    let html = '<div class="hunter-score-block">';
    if (rounds.length) html += '<div class="hunter-score-rounds">' + rounds.join('') + '</div>';
    if (combined) {
      html += '<div class="hunter-score-total-lbl">Total</div>';
      html += '<div class="hunter-score-total-val">' + combined + '</div>';
    }
    const placeApplied = (WEST.rules && WEST.rules.hunterPlaceFor)
      ? WEST.rules.hunterPlaceFor(entryRow.current_place,
          meta && meta.scoring_type, entryRow.r1_score_total, entryRow.r1_h_status)
      : entryRow.current_place;
    if (placeApplied != null) {
      html += '<div class="hunter-score-place">PLACE<span class="val">' + placeApplied + '</span></div>';
    }

    const nJudges = meta && Number(meta.num_judges);
    const isDerby = meta && meta.class_mode === 2;
    if (Array.isArray(entryRow.judges) && entryRow.judges.length > 0 && nJudges && nJudges > 1) {
      const byRound = {};
      entryRow.judges.forEach(function (j) {
        if (!byRound[j.round]) byRound[j.round] = {};
        byRound[j.round][j.idx] = j;
      });
      // Dynamic grid: one column per judge plus a round-label column.
      // Font + cell-padding scale down as judge count grows so the grid
      // stays inside the score-card slot. Bill 2026-05-05 — "shrink
      // font as needed for those multi judges" (he saw a 7-judge case
      // overflow the slot).
      const rndColPx = nJudges >= 6 ? 18 : 24;
      const cols = rndColPx + 'px repeat(' + nJudges + ', 1fr)';
      const baseFs = nJudges <= 3 ? 14 : nJudges <= 5 ? 12 : nJudges <= 7 ? 10 : 9;
      const padPx  = nJudges <= 3 ? 2 : 1;
      const hdrFs  = Math.max(7, baseFs - 4);
      const rowStyle = 'display:grid;grid-template-columns:' + cols
        + ';gap:' + padPx + 'px;align-items:baseline;font-size:' + baseFs + 'px;';
      const hdrCellStyle = 'font-size:' + hdrFs + 'px;color:var(--text-muted);letter-spacing:.12em;text-transform:uppercase;text-align:center;';

      let grid = '<div class="hunter-judge-grid">';
      const hdrCells = ['<span class="hunter-judge-rnd"></span>'];
      for (let jh = 0; jh < nJudges; jh++) {
        hdrCells.push('<span class="hunter-judge-cell" style="' + hdrCellStyle + '">J' + (jh + 1) + '</span>');
      }
      grid += '<div class="hunter-judge-row" style="' + rowStyle + '">' + hdrCells.join('') + '</div>';
      Object.keys(byRound).map(Number).sort().forEach(function (rn) {
        const cells = ['<span class="hunter-judge-rnd">R' + rn + '</span>'];
        for (let ji = 0; ji < nJudges; ji++) {
          const j = byRound[rn][ji];
          if (!j || j.base == null) { cells.push('<span class="hunter-judge-cell empty">—</span>'); continue; }
          let bonus = '';
          if (isDerby) {
            if (j.hiopt != null && j.hiopt > 0) bonus += ' <span class="bonus">+' + Number(j.hiopt).toFixed(0) + '</span>';
            if (j.handy != null && j.handy > 0) bonus += ' <span class="bonus">+' + Number(j.handy).toFixed(0) + '</span>';
          }
          cells.push('<span class="hunter-judge-cell"><span class="base">' + Number(j.base).toFixed(1) + '</span>' + bonus + '</span>');
        }
        grid += '<div class="hunter-judge-row" style="' + rowStyle + '">' + cells.join('') + '</div>';
      });
      grid += '</div>';
      html += grid;
    }
    html += '</div>';
    return { html: html, hasScore: true };
  };

  // M4 lower-third right-column content for HUNTERS (Bill 2026-05-06).
  // Mirrors the jumper layout (Rank / Clock / Faults) but with the data
  // hunters actually have: rank / overall + round score / per-judge cells.
  // Single-round hides the round line; single-judge hides the judges
  // line; derbies always carry granular base+hi-opt+handy.
  //
  // Returns { hasContent, rank, overall, roundLabel, roundValue, judgesHtml }.
  // Caller injects each piece into the existing m4 slots so CSS animations
  // and is-final / is-cd tints continue to apply.
  WEST.hunterTemplates.renderLowerThird = function (meta, hunterScores, snapshot) {
    var empty = { hasContent: false };
    if (!snapshot || !meta || !Array.isArray(hunterScores)) return empty;
    // Frame gate (Bill 2026-05-06, refined 2026-05-08): blank ONLY on
    // intro (fr=11) — that's the "new rider walking in, don't bleed
    // the previous entry's stats" case. Display Scores triggers
    // (fr=12 / 14 / 16) and idle frames (fr=0 clear, fr=1 on-course
    // tick) all keep showing the row's released scores. Pre-fix the
    // gate also blanked on fr=0, so the moment Ryegate sent a clear
    // between rides the score slot went empty even though the
    // previous rider's released scores were still the right thing
    // to show.
    var ls = snapshot.last_scoring;
    if (!ls || ls.channel !== 'A') return empty;
    if (ls.frame === 11) return empty;
    // Find the on-course entry. last_identity is the canonical "who's
    // on the air" tag carrier; fall back to last_scoring's {1} if the
    // identity carry-forward isn't populated yet.
    var iTags = (snapshot.last_identity && snapshot.last_identity.tags) || {};
    var sTags = (ls.tags) || {};
    var entryTag = String((iTags['1'] || sTags['1'] || '')).replace(/\r/g, '').trim();
    if (!entryTag) return empty;
    var entryRow = null;
    for (var i = 0; i < hunterScores.length; i++) {
      if (String(hunterScores[i].entry_num) === entryTag) { entryRow = hunterScores[i]; break; }
    }
    if (!entryRow) return empty;

    var nJudges = Math.max(1, Number(meta.num_judges) || 1);
    var numRounds = Math.max(1, Math.min(3, Number(meta.num_rounds) || 1));
    var isDerby = WEST.format && WEST.format.derbyComponentsApply
      ? WEST.format.derbyComponentsApply(meta)
      : (meta.class_mode === 2);

    // Current round = highest scored round, capped at the class's
    // configured num_rounds (don't pick up stale R3 data on a 2-round
    // class — Bill 2026-05-06).
    var currentRound = 0;
    for (var n = numRounds; n >= 1; n--) {
      if (entryRow['r' + n + '_score_total'] != null) { currentRound = n; break; }
    }
    if (!currentRound) return empty;

    var place = (WEST.rules && WEST.rules.hunterPlaceFor)
      ? WEST.rules.hunterPlaceFor(entryRow.current_place,
          meta.scoring_type, entryRow.r1_score_total, entryRow.r1_h_status)
      : entryRow.current_place;

    // Display mode detection (Bill 2026-05-06): the operator's most
    // recent Display Scores click drives the BIG label/value.
    //
    // For fr=12 (non-derby Display Scores), tag {14} carries "T: 79.00"
    // — the value the operator just sent to the scoreboard. We match
    // that against combined_total / r1 / r2 / r3 to know which round
    // (or overall) was actually displayed. Handles RE-DISPLAY of an
    // earlier round correctly — without this, the heuristic would
    // always pick the highest-scored round even when the operator
    // intentionally re-pinned R1.
    //
    // For fr=16 (derby) and fr=14 (ribbons), UDP cycles through
    // multiple display pages so tag values aren't a stable signal.
    // Fall back to: highest-scored round, with Overall mode when
    // combined_total + every configured round are populated.
    var allRoundsScored = numRounds > 1;
    if (allRoundsScored) {
      for (var ar = 1; ar <= numRounds; ar++) {
        if (entryRow['r' + ar + '_score_total'] == null) { allRoundsScored = false; break; }
      }
    }
    var displayedRound = null;
    var displayedIsOverall = false;

    // PRIMARY detector — combined_total subset matching (Bill 2026-05-06).
    // The .cls writes combined_total = SUM of every round that's been
    // RELEASED (operator hit Display Scores). Rounds that judges scored
    // but operator hasn't displayed yet aren't in combined. So:
    //   • combined matches sum(all rounds) → all released → Overall mode
    //   • combined matches sum of subset → those are the released rounds;
    //     show the highest-numbered released one
    //   • combined matches one round alone → only that round released
    //
    // Stable across fr=16 cycling because it doesn't depend on UDP at all.
    // Handles re-display of an earlier round correctly because the
    // combined value reflects what's actually released, not what the
    // scoreboard happens to be flashing right now.
    var combined = entryRow.combined_total != null ? Number(entryRow.combined_total) : null;
    if (numRounds > 1 && combined != null && isFinite(combined)) {
      var EPS_C = 0.5;
      var bestSubset = null;
      // Enumerate every non-empty subset of {1..numRounds}. With max 3
      // rounds this is up to 7 subsets — trivial. Pick the largest
      // subset whose sum matches combined; ties broken by highest
      // round number (latest release wins).
      for (var bm = 1; bm < (1 << numRounds); bm++) {
        var subRounds = [];
        var subSum = 0;
        var bad = false;
        for (var rb = 0; rb < numRounds; rb++) {
          if (bm & (1 << rb)) {
            var rv = Number(entryRow['r' + (rb + 1) + '_score_total']);
            if (!isFinite(rv)) { bad = true; break; }
            subRounds.push(rb + 1);
            subSum += rv;
          }
        }
        if (bad) continue;
        if (Math.abs(subSum - combined) >= EPS_C) continue;
        if (!bestSubset
            || subRounds.length > bestSubset.rounds.length
            || (subRounds.length === bestSubset.rounds.length
                && subRounds[subRounds.length - 1] > bestSubset.rounds[bestSubset.rounds.length - 1])) {
          bestSubset = { rounds: subRounds, sum: subSum };
        }
      }
      if (bestSubset) {
        if (bestSubset.rounds.length === numRounds) {
          displayedIsOverall = true;
          displayedRound = numRounds;
        } else {
          displayedRound = bestSubset.rounds[bestSubset.rounds.length - 1];
          displayedIsOverall = false;
        }
      }
    }

    // SECONDARY detector — UDP {14} on fr=12/16 (Display Scores triggers).
    // Only kicks in when the subset method couldn't decide (typically:
    // single-round classes, or combined_total still null). For fr=16
    // (derby) UDP cycles, so this is unreliable; we use it as a last
    // resort before falling back to "highest scored."
    if (displayedRound == null && (ls.frame === 12 || ls.frame === 16) && ls.tags) {
      var t14 = String(ls.tags['14'] || '').replace(/[\r\n]/g, '').trim();
      var ovMatch = t14.match(/^O[VR]?\s*:\s*([\d.]+)/i);
      var tMatch  = t14.match(/^T\w*\s*:?\s*([\d.]+)/i);
      var anyNum  = t14.match(/([\d.]+)/);
      var ds = null, hintOverall = false;
      if (ovMatch)      { ds = parseFloat(ovMatch[1]); hintOverall = true; }
      else if (tMatch)  { ds = parseFloat(tMatch[1]); }
      else if (anyNum)  { ds = parseFloat(anyNum[1]); }
      if (isFinite(ds)) {
        var EPS_U = 0.5;
        if (hintOverall && combined != null && Math.abs(combined - ds) < EPS_U) {
          displayedIsOverall = true;
          displayedRound = numRounds;
        }
        if (displayedRound == null) {
          for (var dr = 1; dr <= numRounds; dr++) {
            var drv = Number(entryRow['r' + dr + '_score_total']);
            if (isFinite(drv) && Math.abs(drv - ds) < EPS_U) {
              displayedRound = dr;
              break;
            }
          }
        }
      }
    }

    // FALLBACK — highest scored round only. Never auto-promote to Overall
    // here; Overall must be explicitly detected (subset match or "OV:" in
    // UDP). Keeps the bar honest when we can't read the operator's intent.
    if (displayedRound == null) {
      displayedRound = currentRound;
      displayedIsOverall = false;
    }


    var bigLabel, bigValue;
    var chipParts = [];
    if (displayedIsOverall) {
      bigLabel = 'Overall';
      bigValue = Number(entryRow.combined_total).toFixed(1);
      for (var rn = 1; rn <= numRounds; rn++) {
        var rv = Number(entryRow['r' + rn + '_score_total']);
        if (isFinite(rv)) {
          chipParts.push('<span class="lt-round"><span class="lbl">R' + rn + '</span><span class="v">' + rv.toFixed(1) + '</span></span>');
        }
      }
    } else {
      bigLabel = numRounds > 1 ? ('R' + displayedRound) : 'Score';
      bigValue = Number(entryRow['r' + displayedRound + '_score_total']).toFixed(1);
      // Chips: every OTHER scored round (not the one being shown big).
      // Prefer chronological order — R1 first, then R2, etc.
      for (var pr = 1; pr <= numRounds; pr++) {
        if (pr === displayedRound) continue;
        var prv = Number(entryRow['r' + pr + '_score_total']);
        if (isFinite(prv)) {
          chipParts.push('<span class="lt-round"><span class="lbl">R' + pr + '</span><span class="v">' + prv.toFixed(1) + '</span></span>');
        }
      }
    }

    var middleHtml = '<div class="m4-hunter-overall"><span class="lbl">' + bigLabel + '</span><span class="v">' + bigValue + '</span></div>';
    if (chipParts.length) {
      middleHtml += '<div class="m4-hunter-rounds">' + chipParts.join('') + '</div>';
    }

    // Judges line — only when class has > 1 judge configured AND we have
    // judge data. Shows the per-judge breakdown for the SAME round the
    // big number is showing (so a re-display of R1 shows R1 judges, not
    // R2's). Each cell shows base + (derby) hiopt + handy as small bonus
    // chips. Single-judge classes hide entirely.
    var judgesHtml = '';
    if (nJudges > 1 && Array.isArray(entryRow.judges) && entryRow.judges.length) {
      var cells = [];
      for (var ji = 0; ji < nJudges; ji++) {
        var match = null;
        for (var k = 0; k < entryRow.judges.length; k++) {
          var j = entryRow.judges[k];
          if (Number(j.round) === displayedRound && Number(j.idx) === ji) { match = j; break; }
        }
        var inner;
        if (!match || match.base == null) {
          inner = '<span class="lt-jv empty">—</span>';
        } else {
          var bonusHtml = '';
          if (isDerby) {
            if (match.hiopt != null && match.hiopt > 0) {
              bonusHtml += '<span class="lt-jb">+' + Number(match.hiopt).toFixed(0) + '</span>';
            }
            if (match.handy != null && match.handy > 0) {
              bonusHtml += '<span class="lt-jb">+' + Number(match.handy).toFixed(0) + '</span>';
            }
          }
          inner = '<span class="lt-jv">' + Number(match.base).toFixed(1) + '</span>' + bonusHtml;
        }
        cells.push('<span class="lt-judge"><span class="lt-jl">J' + (ji + 1) + '</span>' + inner + '</span>');
      }
      judgesHtml = '<div class="m4-hunter-judges">' + cells.join('') + '</div>';
    }

    return {
      hasContent: true,
      rank: place != null ? String(place) : null,
      middleHtml: middleHtml,
      judgesHtml: judgesHtml,
    };
  };

  // CommonJS export for tests / future Node consumers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.hunterTemplates;
  }
})(typeof window !== 'undefined' ? window : global);
