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
    5:  'Gamblers Choice / Top Score',
    6:  'IV.1 Optimum',
    7:  'Timed Equitation',
    8:  'Table II',
    9:  'II.2d',
    10: 'II.2f Stratified',
    11: 'II.2c',
    13: 'II.2b · Immediate JO',
    14: 'Team',
    15: 'Winning Round',
  };

  // ── Hunter classMode (col[2] when class_type=H).
  const HUNTER_MODES = {
    0: 'Over Fences',
    1: 'Flat',
    2: 'Hunter Derby',
    3: 'Special',
  };

  // ── Hunter scoring type (col[5] when class_type=H).
  const HUNTER_SCORING_TYPES = {
    0: 'Forced placings',
    1: 'Scored',
    2: 'Hi-Lo (drop high + low judges)',
  };

  // ── Derby sub-types (col[37], applies when class_mode=2).
  // Index is ZERO-BASED — Ryegate writes 0 for the first dropdown option
  // (International). Confirmed by Bill 2026-04-25 (set dropdown to
  // National, header byte read as 1).
  // The HUNTER-METHODS-REFERENCE.md table is off-by-one and needs an
  // update; until then, code is the source of truth.
  const DERBY_TYPES = {
    0: 'International Derby',
    1: 'National Derby',
    2: 'National H&G',
    3: 'International H&G',
    4: 'USHJA Pony',
    5: 'USHJA Pony H&G',
    6: 'USHJA 2\'6" Junior',
    7: 'USHJA 2\'6" Junior H&G',
    8: 'WCHR Spec',
  };

  // ── Class-level "should I show X" GATES ─────────────────────────────
  //
  // Pattern: every conditional render decision (derby variant label,
  // judges grid, combined-total column, derby component breakdown,
  // championship markers, equitation rider-primary, etc.) lives in a
  // named gate function that bakes in EVERY relevant condition. Callers
  // get a single yes/no — no inline `class_mode === 2 && ...` chains
  // scattered across templates. Add new gates here as new flags are
  // wired through.

  // derbyTypeLabel(cls) — human derby variant name, ONLY when class is
  // actually a derby (class_mode === 2). Null otherwise. Source of
  // truth for "what to call this derby." Used by classDescription, can
  // be reused by admin tooltip / stats / live.
  WEST.format.derbyTypeLabel = function (cls) {
    if (!cls) return null;
    if (cls.class_mode !== 2) return null;
    const dt = cls.derby_type;
    if (dt == null) return null;
    return DERBY_TYPES[dt] || null;
  };

  // judgesGridApplies(cls) — should the per-judge breakdown grid be
  // available for this class? True only when:
  //   - class is hunter-shaped with multiple judges
  //   - and judges actually scored it (scoring_type !== 0 Forced)
  // Display of the grid itself is a future-phase feature; this gate
  // exists now so templates / detail UI can light up the "expand to
  // see per-judge scores" affordance the moment it's built.
  WEST.format.judgesGridApplies = function (cls) {
    if (!cls) return false;
    if (cls.scoring_type === 0) return false;
    return Number(cls.num_judges) > 1;
  };

  // combinedTotalApplies(cls) — should the results table render a
  // "Total" column (sum/avg of round totals)? True only when there's
  // more than one round AND scoring_type isn't Forced.
  WEST.format.combinedTotalApplies = function (cls) {
    if (!cls) return false;
    if (cls.scoring_type === 0) return false;
    return Number(cls.num_rounds) > 1;
  };

  // derbyComponentsApply(cls) — should the per-judge HighOptions /
  // HandyBonus columns surface? Captured today in
  // entry_hunter_judge_scores; rendering deferred. Gate is here so when
  // someone builds the columns, the right condition fires automatically.
  WEST.format.derbyComponentsApply = function (cls) {
    if (!cls) return false;
    if (cls.class_mode !== 2) return false;
    if (cls.scoring_type === 0) return false;
    return true;
  };

  // forcedPlacings(cls) — operator-pinned placings, no public scores.
  // True regardless of lens (jumper Method 7 modifier=0, hunter
  // scoring_type=0 — both surface as "Forced placings" to the viewer
  // and suppress score columns).
  WEST.format.forcedPlacings = function (cls) {
    if (!cls) return false;
    if (cls.scoring_type === 0) return true;
    if (cls.scoring_method === 7 && cls.scoring_modifier === 0) return true;
    return false;
  };

  // riderPrimary(cls) — should the identity column lead with rider
  // (and dim the horse), inverting the standard horse-primary layout?
  // True for equitation classes regardless of mode/lens, including the
  // jumper Method 7 (Timed Equitation) variant which doesn't carry the
  // is_equitation header flag but is conceptually equitation.
  WEST.format.riderPrimary = function (cls) {
    if (!cls) return false;
    if (cls.is_equitation === 1) return true;
    if (cls.scoring_method === 7) return true; // Timed Equitation jumper
    return false;
  };

  // singleLineIdentity(cls) — render rider and horse on ONE line
  // (separator between, flag with rider) instead of stacking. Fires
  // for ANY equitation class regardless of scoring mode (Forced or
  // Scored). The hunter renderIdentity already single-lines all
  // rider-primary entries; this gate is the formal source of truth
  // so future surfaces don't have to re-derive the rule.
  WEST.format.singleLineIdentity = function (cls) {
    return WEST.format.riderPrimary(cls);
  };

  // ── UDP frame tag labels (Phase 3b polish, lens-aware) ────────────────
  // Maps lens → frame → tag → human label. Per Article 1 + S42 rule 6,
  // tag meaning is per-frame within its lens — never inferred cross-lens
  // or cross-frame. Source: docs/v3-planning/UDP-PROTOCOL-REFERENCE.md
  // and the engine's bundled DEFAULT_MAP (operator-correctable via the
  // engine Protocol tab).
  //
  // Conservative coverage: only frame-1 (jumper on-course), frame-11
  // page-A (hunter), and method-7 equitation overlay. Other frames /
  // pages with multi-page semantics (frame 11 pages B/C, frame 16 derby)
  // are intentionally NOT mapped here — those carry page-dependent
  // meanings that the engine determines + a future enrichment chunk will
  // surface to the page along with the lens.
  const UDP_TAG_LABELS = {
    jumper: {
      1: {
        1: 'Entry', 2: 'Horse', 3: 'Rider', 4: 'Owner', 5: 'NAT',
        13: 'TA', 14: 'Jump', 15: 'Time', 17: 'Clock',
        18: 'Target', 19: 'Eq Score', 23: 'Countdown',
      },
    },
    hunter: {
      11: { 1: 'Entry', 2: 'Horse', 3: 'Rider', 4: 'Owner' },
      14: { 1: 'Entry', 2: 'Horse', 3: 'Rider', 4: 'Owner' },
    },
    equitation: {
      // Method 7 — Timed Equitation. Jumper protocol (frame 1) but the
      // primary identity is rider, score lands in {19}, {7} carries
      // rider name on the hunter side. Cover both.
      1: {
        1: 'Entry', 2: 'Horse', 3: 'Rider', 4: 'Owner', 5: 'NAT',
        13: 'TA', 14: 'Jump', 15: 'Time', 17: 'Clock',
        18: 'Target', 19: 'Eq Score', 23: 'Countdown',
      },
      11: { 1: 'Entry', 2: 'Horse', 3: 'Rider', 4: 'Owner', 7: 'Rider (EQ)' },
    },
  };

  // tagLabel(lens, frame, tagN) — returns the human label for a UDP tag,
  // or null when no mapping exists. Caller treats null as "render raw".
  WEST.format.tagLabel = function (lens, frame, tagN) {
    if (!lens) return null;
    const byLens = UDP_TAG_LABELS[lens];
    if (!byLens) return null;
    const byFrame = byLens[frame];
    if (!byFrame) return null;
    return byFrame[tagN] || null;
  };

  // ── Per-method round column labels (jumper lens) ─────────────────────
  // Keyed by scoring_method, value is an array of labels (1-indexed by
  // round). Empty string = "no label" (method has 1 round, header reads
  // blank rather than a generic "R1"). Source: Bill's session-34 spec.
  // Templates and any future surface (live, stats, display) consume
  // via WEST.format.roundLabel(method, modifier, n).
  const ROUND_LABELS = {
     0: [''],                                 // Table III — 1R
     2: ['Round 1', 'Jump Off'],              // II.2a
     3: ['Round 1', 'Round 2', 'Jump Off'],   // 2-Round + JO
     4: [''],                                 // II.1 Speed — 1R
     5: [''],                                 // Gamblers Choice — 1R
     6: [''],                                 // IV.1 Optimum — 1R; modifier=1 → 2R override below
     7: [''],                                 // Timed Equitation — 1R
     8: [''],                                 // Table II — 1R
     9: ['Phase 1', 'Phase 2'],               // II.2d Two-Phase
    10: ['Round 1', 'Jump Off'],              // II.2f Stratified
    11: ['Round 1', 'Jump Off'],              // II.2c Two-Phase (clears only)
    13: ['Round 1', 'Jump Off'],              // II.2b Immediate JO
    14: ['Round 1', 'Round 2', 'Jump Off'],   // Team Competition (display TBD)
    15: ['Round 1', 'Round 2'],               // Winning Round
  };

  // roundLabel(method, modifier, n) — 1-indexed round number n.
  // Returns the per-method label, or '' when the method declares no
  // label for that round (or method isn't catalogued). Method 6 with
  // modifier=1 ("qualifier flag active") promotes to 2-round + JO.
  WEST.format.roundLabel = function (method, modifier, n) {
    if (method === 6 && Number(modifier) === 1) {
      return ['Round 1', 'Jump Off'][n - 1] || '';
    }
    const labels = ROUND_LABELS[method];
    if (!labels) return '';
    return labels[n - 1] || '';
  };

  // ── timeAllowedSummary — method-aware one-liner for the hero card.
  // Reads cls.r{1,2,3}_time_allowed (jumper-only — null on hunter) and
  // formats a compact string per v2 conventions:
  //   1R / Speed / Optimum:    "TA 30s"
  //   Two-Phase (method 9):    "PH1 30s · PH2 31s"
  //   2R + JO (methods 2/etc): "R1 65s · JO 30s"
  //   3R + JO (method 3):      "R1 65s · R2 70s · JO 30s"
  // Returns '' when the class has no usable TA values (hunter, or
  // jumper class with all blanks).
  WEST.format.timeAllowedSummary = function (cls) {
    if (!cls) return '';
    const r1 = Number(cls.r1_time_allowed) || 0;
    const r2 = Number(cls.r2_time_allowed) || 0;
    const r3 = Number(cls.r3_time_allowed) || 0;
    if (!r1 && !r2 && !r3) return '';
    const m = Number(cls.scoring_method);
    const mod = Number(cls.scoring_modifier);
    const labels = { r1: 'R1', r2: 'R2', jo: 'JO' };
    if (m === 9) { labels.r1 = 'PH1'; labels.r2 = 'PH2'; }
    const parts = [];
    // Method 6 with modifier=1 promotes to 2-round (matches roundLabel
    // override). Method 3 / method 14 are 2R + JO.
    const is3R = (m === 3 || m === 14);
    const isMultiRound = (m === 2 || m === 9 || m === 10 || m === 11 || m === 13 || m === 15 || is3R || (m === 6 && mod === 1));
    if (!isMultiRound) {
      // Single-round methods — only R1 matters.
      if (r1 > 0) return 'TA ' + Math.round(r1) + 's';
      return '';
    }
    if (r1 > 0) parts.push(labels.r1 + ' ' + Math.round(r1) + 's');
    if (is3R) {
      if (r2 > 0) parts.push(labels.r2 + ' ' + Math.round(r2) + 's');
      if (r3 > 0) parts.push(labels.jo + ' ' + Math.round(r3) + 's');
    } else {
      // 2R + JO methods — second slot is the JO unless it's two-phase.
      const second = (m === 9) ? labels.r2 : labels.jo;
      if (r2 > 0) parts.push(second + ' ' + Math.round(r2) + 's');
    }
    return parts.join(' · ');
  };

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

  // ── classDescription(cls) ──────────────────────────────────────────
  //
  // Human-readable English summary of a class. Synthesizes everything
  // we know — mode + scoring type + round count + judges + derby
  // subtype + equitation flag — into one line. The hero subtitle on
  // the public class page calls this; admin tooltips and stats pages
  // can also reuse it.
  //
  // Distinct from methodLabel (which returns a terse "II.2b · Immediate
  // JO" suitable for a tooltip): classDescription is the long-form
  // version meant to be the most informative single line a viewer sees.
  WEST.format.classDescription = function (cls) {
    if (!cls) return '';
    const ct = (cls.class_type || '').toUpperCase();
    if (ct === 'H') return hunterDescription(cls);
    if (ct === 'J' || ct === 'T') return jumperDescription(cls);
    return '';
  };

  function hunterDescription(cls) {
    const parts = [];
    // Headline = the canonical label as-is. Equitation flag overrides
    // the mode label entirely (Equitation is its own discipline). Derby
    // sub-type overrides "Hunter Derby" with the specific variant when
    // known. Page context already establishes "this is a horse show",
    // so we don't re-prefix "Hunter" onto modes that don't already
    // carry it.
    let headline;
    const derbyName = WEST.format.derbyTypeLabel(cls);
    if (cls.is_equitation === 1) {
      headline = 'Equitation';
    } else if (derbyName) {
      headline = derbyName;
    } else {
      headline = HUNTER_MODES[cls.class_mode] || 'Hunter';
    }
    parts.push(headline);
    // Scoring type — call out non-default flavors. "Scored" is the
    // common case, no need to repeat it; Forced and Hi-Lo are notable.
    if (cls.scoring_type === 0 || cls.scoring_type === 2) {
      parts.push(HUNTER_SCORING_TYPES[cls.scoring_type]);
    }
    // Counts — only mention when > 1.
    const counts = [];
    if (Number(cls.num_rounds) > 1) counts.push(`${cls.num_rounds} rounds`);
    if (Number(cls.num_judges) > 1) counts.push(`${cls.num_judges} judges`);
    if (counts.length) parts.push(counts.join(', '));
    return parts.join(' · ');
  }

  function jumperDescription(cls) {
    // Lean on methodLabel for the article naming, then layer round
    // count when it's > 1 (the round count is implicit in the method
    // for many jumpers, but explicit here helps for tooltip-less hero).
    const base = WEST.format.methodLabel(
      cls.class_type, cls.scoring_method, cls.class_mode, cls.scoring_modifier
    );
    return base || '';
  }

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

  // ── Class informational notices ────────────────────────────────────
  //
  // Returns an array of human-readable notice strings triggered by
  // class-level flags. The display layer renders each as its own banner
  // line (or any other shape — caller decides). Centralized here so
  // every public surface (results, live, stats) shows the same wording
  // and a new flag → notice mapping lives in one place.
  //
  // Operator-set flags reflect Ryegate's policy. We don't compute the
  // ranking math; we just surface the explanatory text.
  WEST.format.classNotices = function (cls) {
    if (!cls) return [];
    const notices = [];
    if (cls.is_championship === 1) {
      notices.push('Championship class — placings may incorporate qualifying-class points');
    }
    if (cls.reverse_rank === 1) {
      notices.push('Lower score wins (pinned lowest to highest)');
    }
    if (cls.ribbons_only === 1) {
      notices.push('Ribbons only — numeric scores not published');
    }
    if (cls.is_jogged === 1) {
      notices.push('Horses jogged after class for soundness');
    }
    if (cls.is_team === 1) {
      notices.push('Team class');
    }
    if (cls.ihsa === 1) {
      notices.push('IHSA rules apply');
    }
    return notices;
  };

  // Championship marker for placed entries — "Ch" on place 1 (Champion),
  // "Res" on place 2 (Reserve). Returns empty string when class isn't a
  // championship or place is outside 1/2. Cross-lens: any class with
  // classes.is_championship=1 (hunter typical, jumper rare) gets the
  // markers.
  WEST.format.championshipMarker = function (place, isChampionship) {
    if (!isChampionship) return '';
    if (place === 1) return 'Ch';
    if (place === 2) return 'Res';
    return '';
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
