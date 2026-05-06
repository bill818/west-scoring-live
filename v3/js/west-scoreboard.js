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

  WEST.scoreboard = {
    renderJogOrder,
    renderStandbyList,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.scoreboard;
  }
})(typeof globalThis !== 'undefined' ? globalThis :
   typeof window !== 'undefined' ? window :
   typeof self !== 'undefined' ? self : this);
