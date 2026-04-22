// WEST v3 — shared format helpers.
// Dual-environment IIFE: works in browsers (attaches to window.WEST) and
// in Node (CommonJS export). Pages and the engine will both consume this
// module without duplicating logic.
//
// Phase 2b+: seeds with method/mode/modifier human-readable labels so the
// admin can render hover tooltips. More formatters get added here as pages
// need them (time, rank, faults, status, etc.).

(function (global) {
  const WEST = global.WEST = global.WEST || {};
  WEST.format = WEST.format || {};

  // ── Jumper scoring methods (col[2] when class_type ∈ J, T, U-inferred)
  // Source: docs/v3-planning/JUMPER-METHODS-REFERENCE.md + project memory.
  // Only methods we've seen in real data or have spec confidence about.
  const JUMPER_METHODS = {
    0:  'Table III — Faults Converted · 1 round',
    2:  'II.2a — R1 + JO · no ladder',
    3:  '2-Round + JO · ladder R1↔R2',
    4:  'II.1 Speed · 1 round',
    6:  'IV.1 Optimum (TA−4 target)',
    7:  'Timed Equitation (USEF — rider-primary display)',
    9:  'II.2d — Two-Phase · ladder PH1↔PH2',
    10: 'II.2f Stratified JO (spec only — never observed)',
    11: 'II.2c — Two-Phase · no ladder',
    13: 'II.2b — Immediate JO (most common)',
    14: 'Team — R1/R2/JO · ladder R1↔R2',
    15: 'Winning Round — R1 wiped for R2',
  };

  // ── Hunter classMode (col[2] when class_type=H). Semantics not fully
  // catalogued yet — intentionally left empty rather than guessed.
  const HUNTER_MODES = {};

  // ── Scoring modifier (col[3]) — meaning depends on the method.
  function modifierLabel(method, mod) {
    if (mod === null || mod === undefined || mod === '') return '';
    const n = Number(mod);
    if (!Number.isFinite(n)) return '';
    if (method === 6) return n === 1 ? '2-round variant' : '1-round';
    if (method === 7) return n === 1 ? 'Scored' : 'Forced';
    return 'modifier ' + n;
  }

  // methodLabel — returns a human-readable phrase for the (classType,
  // method, mode, modifier) tuple. Used by admin for hover tooltips.
  // Returns '' when nothing meaningful can be said.
  WEST.format.methodLabel = function (classType, method, mode, modifier) {
    const ct = (classType || '').toUpperCase();
    if (ct === 'H') {
      if (mode === null || mode === undefined) return 'Hunter class (mode not set)';
      return HUNTER_MODES[mode] || `Hunter classMode ${mode}`;
    }
    if (method === null || method === undefined) return '';
    const base = JUMPER_METHODS[method] || `Method ${method} (not yet catalogued)`;
    const modStr = modifierLabel(method, modifier);
    return modStr ? `${base} · ${modStr}` : base;
  };

  // CommonJS export for Node (engine) side — harmless in browsers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.format;
  }
})(typeof window !== 'undefined' ? window : globalThis);
