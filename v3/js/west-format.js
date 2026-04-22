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
  // Concise human-readable labels; only methods we've seen live or have
  // spec confidence about. Unknown methods fall through to "Method N".
  const JUMPER_METHODS = {
    0:  'Table III',
    2:  'II.2a',
    3:  '2-Round + JO',
    4:  'II.1 Speed',
    6:  'IV.1 Optimum',
    7:  'Timed Equitation',
    9:  'II.2d',
    10: 'II.2f Stratified',
    11: 'II.2c',
    13: 'II.2b · Immediate JO',
    14: 'Team',
    15: 'Winning Round',
  };

  // ── Hunter classMode (col[2] when class_type=H). Semantics not fully
  // catalogued yet — intentionally left empty rather than guessed.
  const HUNTER_MODES = {};

  // ── Scoring modifier (col[3]) — only rendered for methods where the
  // value is semantically meaningful to a human. For other methods the
  // modifier is captured in the DB but not shown in list UI.
  function modifierLabel(method, mod) {
    if (mod === null || mod === undefined || mod === '') return '';
    const n = Number(mod);
    if (!Number.isFinite(n)) return '';
    if (method === 6) return n === 1 ? '2-round' : '1-round';
    if (method === 7) return n === 1 ? 'Scored' : 'Forced';
    return ''; // unknown modifier semantics — don't render
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
