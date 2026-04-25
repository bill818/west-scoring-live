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

  // formatDate — take an ISO "YYYY-MM-DD" string and render as
  // "MM/DD/YYYY" (Bill's preferred display format). Returns the input
  // unchanged if it doesn't match the expected pattern.
  WEST.format.date = function (iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    return `${m[2]}/${m[3]}/${m[1]}`;
  };

  // formatDateWithDayName — "Fri 09/12/2025". Used for date group headers
  // so operators can see the day-of-week at a glance.
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  WEST.format.dateWithDay = function (iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const day = DAYS[d.getUTCDay()];
    return `${day} ${m[2]}/${m[3]}/${m[1]}`;
  };

  // ── Schedule flag labels — tsked.csv col[3] values interpreted for UI
  // S  = Scored/Finished (results finalized, confirmed 2026-03-31)
  // JO = Jump Order posted (display order of go)
  // L  = Live-badge (less well confirmed, older semantics)
  // empty / unknown → not rendered
  const SCHEDULE_FLAGS = {
    'S':  'Scored',
    'JO': 'JO posted',
    'L':  'Live',
  };
  WEST.format.scheduleFlagLabel = function (flag) {
    if (!flag) return '';
    return SCHEDULE_FLAGS[flag] || flag;
  };

  // ── Numeric primitives ──────────────────────────────────────────────
  // Used by jumper round cells, place columns, etc. Cross-lens: hunter
  // judge scores reuse the same fault/score primitives where applicable.

  // Time: 3-decimal seconds, Ryegate convention. null/0 → "—".
  WEST.format.time = function (sec) {
    if (sec == null) return '—';
    const n = Number(sec);
    if (!Number.isFinite(n) || n === 0) return '—';
    return n.toFixed(3);
  };

  // Faults: integer display. null → "—". 0 stays "0" (caller decides
  // whether to show 0 or hide for clean rounds).
  WEST.format.faults = function (f) {
    if (f == null) return '—';
    const n = Number(f);
    if (!Number.isFinite(n)) return '—';
    return String(n);
  };

  // HTML-safe escape. Used by every page that interpolates user data
  // into innerHTML. Single source so a future XSS rule (e.g. forbidding
  // a specific glyph) lands in one place.
  WEST.format.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Day labels — short ("Fri Apr 25") and long ("Friday, Apr 25").
  // Both construct as local dates so timezone shifts don't drop a day.
  // dayLabel = short, used inline in subtitles. dayLabelLong = long,
  // used for section headers where the extra real estate reads better.
  function buildDay(iso, weekdayStyle) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    const dt = new Date(+m[1], +m[2] - 1, +m[3]);
    return dt.toLocaleDateString('en-US', { weekday: weekdayStyle, month: 'short', day: 'numeric' });
  }
  WEST.format.dayLabel = function (iso) { return buildDay(iso, 'short'); };
  WEST.format.dayLabelLong = function (iso) { return buildDay(iso, 'long'); };

  // ── Country flag rendering ─────────────────────────────────────────
  // FEI 3-letter codes → Unicode flag emojis. Map ported from v1
  // (Working site mid march/results.html). Codes not in the table
  // render as the bare 3-letter string (no emoji, no error).
  // Returns "" on empty input — caller decides display policy
  // (e.g. honor class.show_flags or always-show on stats pages).
  const FLAGS = {AFG:'🇦🇫',ALB:'🇦🇱',ALG:'🇩🇿',AND:'🇦🇩',ANG:'🇦🇴',ANT:'🇦🇬',ARG:'🇦🇷',ARM:'🇦🇲',ARU:'🇦🇼',AUS:'🇦🇺',AUT:'🇦🇹',AZE:'🇦🇿',BAH:'🇧🇸',BAN:'🇧🇩',BAR:'🇧🇧',BDI:'🇧🇮',BEL:'🇧🇪',BEN:'🇧🇯',BER:'🇧🇲',BHU:'🇧🇹',BIH:'🇧🇦',BIZ:'🇧🇿',BOL:'🇧🇴',BOT:'🇧🇼',BRA:'🇧🇷',BRN:'🇧🇭',BRU:'🇧🇳',BUL:'🇧🇬',BUR:'🇧🇫',CAF:'🇨🇫',CAM:'🇰🇭',CAN:'🇨🇦',CAY:'🇰🇾',CGO:'🇨🇬',CHA:'🇹🇩',CHI:'🇨🇱',CHN:'🇨🇳',CIV:'🇨🇮',CMR:'🇨🇲',COD:'🇨🇩',COK:'🇨🇰',COL:'🇨🇴',COM:'🇰🇲',CPV:'🇨🇻',CRC:'🇨🇷',CRO:'🇭🇷',CUB:'🇨🇺',CYP:'🇨🇾',CZE:'🇨🇿',DEN:'🇩🇰',DJI:'🇩🇯',DOM:'🇩🇴',ECU:'🇪🇨',EGY:'🇪🇬',ERI:'🇪🇷',ESA:'🇸🇻',ESP:'🇪🇸',EST:'🇪🇪',ETH:'🇪🇹',FIJ:'🇫🇯',FIN:'🇫🇮',FRA:'🇫🇷',FSM:'🇫🇲',GAB:'🇬🇦',GAM:'🇬🇲',GBR:'🇬🇧',GBS:'🇬🇼',GEO:'🇬🇪',GEQ:'🇬🇶',GER:'🇩🇪',GHA:'🇬🇭',GRE:'🇬🇷',GRN:'🇬🇩',GUA:'🇬🇹',GUI:'🇬🇳',GUM:'🇬🇺',GUY:'🇬🇾',HAI:'🇭🇹',HKG:'🇭🇰',HON:'🇭🇳',HUN:'🇭🇺',INA:'🇮🇩',IND:'🇮🇳',IRI:'🇮🇷',IRL:'🇮🇪',IRQ:'🇮🇶',ISL:'🇮🇸',ISR:'🇮🇱',ISV:'🇻🇮',ITA:'🇮🇹',IVB:'🇻🇬',JAM:'🇯🇲',JOR:'🇯🇴',JPN:'🇯🇵',KAZ:'🇰🇿',KEN:'🇰🇪',KGZ:'🇰🇬',KOR:'🇰🇷',KSA:'🇸🇦',KUW:'🇰🇼',LAO:'🇱🇦',LAT:'🇱🇻',LBA:'🇱🇾',LBN:'🇱🇧',LBR:'🇱🇷',LCA:'🇱🇨',LES:'🇱🇸',LIE:'🇱🇮',LTU:'🇱🇹',LUX:'🇱🇺',MAD:'🇲🇬',MAR:'🇲🇦',MAS:'🇲🇾',MAW:'🇲🇼',MDA:'🇲🇩',MDV:'🇲🇻',MEX:'🇲🇽',MGL:'🇲🇳',MKD:'🇲🇰',MLI:'🇲🇱',MLT:'🇲🇹',MON:'🇲🇨',MOZ:'🇲🇿',MRI:'🇲🇺',MTN:'🇲🇷',MYA:'🇲🇲',NAM:'🇳🇦',NCA:'🇳🇮',NED:'🇳🇱',NEP:'🇳🇵',NIG:'🇳🇪',NOR:'🇳🇴',NZL:'🇳🇿',OMA:'🇴🇲',PAK:'🇵🇰',PAN:'🇵🇦',PAR:'🇵🇾',PER:'🇵🇪',PHI:'🇵🇭',PLE:'🇵🇸',PLW:'🇵🇼',PNG:'🇵🇬',POL:'🇵🇱',POR:'🇵🇹',PRK:'🇰🇵',PUR:'🇵🇷',QAT:'🇶🇦',ROU:'🇷🇴',RSA:'🇿🇦',RUS:'🇷🇺',RWA:'🇷🇼',SAM:'🇼🇸',SEN:'🇸🇳',SEY:'🇸🇨',SIN:'🇸🇬',SKN:'🇰🇳',SLE:'🇸🇱',SLO:'🇸🇮',SMR:'🇸🇲',SOL:'🇸🇧',SOM:'🇸🇴',SRB:'🇷🇸',SRI:'🇱🇰',SSD:'🇸🇸',STP:'🇸🇹',SUD:'🇸🇩',SUI:'🇨🇭',SUR:'🇸🇷',SVK:'🇸🇰',SWE:'🇸🇪',SWZ:'🇸🇿',SYR:'🇸🇾',TAN:'🇹🇿',TGA:'🇹🇴',THA:'🇹🇭',TJK:'🇹🇯',TKM:'🇹🇲',TLS:'🇹🇱',TOG:'🇹🇬',TPE:'🇹🇼',TTO:'🇹🇹',TUN:'🇹🇳',TUR:'🇹🇷',UAE:'🇦🇪',UGA:'🇺🇬',UKR:'🇺🇦',URU:'🇺🇾',USA:'🇺🇸',UZB:'🇺🇿',VAN:'🇻🇺',VEN:'🇻🇪',VIE:'🇻🇳',VIN:'🇻🇨',YEM:'🇾🇪',ZAM:'🇿🇲',ZIM:'🇿🇼'};

  // flag(code) → "🇺🇸 USA" / "USA" / "". Pure primitive — no policy.
  // Most callers should use flagFor() instead (which applies the
  // operator-set show_flags policy). flag() is exposed only for cases
  // where the caller has explicitly determined display policy already.
  WEST.format.flag = function (code) {
    if (!code) return '';
    const upper = String(code).trim().toUpperCase();
    if (!upper) return '';
    const emoji = FLAGS[upper];
    return emoji ? emoji + ' ' + upper : upper;
  };

  // flagFor(cls, entry) — applies the SCORING-COMPUTER policy:
  // flags only appear when the operator has checked ShowFlags in
  // Ryegate (jumper class header H[26], stored as cls.show_flags).
  // Every public surface (results, live, stats, display, etc.) MUST
  // route through this helper rather than calling flag(code) directly,
  // so unchecking ShowFlags in Ryegate erases flags everywhere on the
  // next /v3/postCls. Returns the same shape as flag() — caller still
  // owns HTML wrapping.
  WEST.format.flagFor = function (cls, entry) {
    if (!cls || !cls.show_flags) return '';
    return WEST.format.flag(entry && entry.country_code);
  };

  // Ordinal place: 1 → "1st", 2 → "2nd", 21 → "21st", 22 → "22nd".
  WEST.format.ordinal = function (n) {
    if (n == null) return '';
    const num = Number(n);
    if (!Number.isFinite(num) || num < 1) return '';
    const last2 = num % 100;
    if (last2 >= 11 && last2 <= 13) return `${num}th`;
    const last1 = num % 10;
    const suffix = last1 === 1 ? 'st' : last1 === 2 ? 'nd' : last1 === 3 ? 'rd' : 'th';
    return `${num}${suffix}`;
  };

  // CommonJS export for Node (engine) side — harmless in browsers.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.format;
  }
})(typeof window !== 'undefined' ? window : globalThis);
