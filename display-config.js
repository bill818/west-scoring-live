/**
 * WEST Scoring Live — Display Configuration
 * Single source of truth for how classes, scores, and statuses are rendered.
 * All pages include this file via <script src="display-config.js"></script>
 * Change here = change everywhere.
 *
 * This file does NOT score — Ryegate scores. We only read and display.
 * The .cls file is always the source of truth for results.
 *
 * Currently lives CLIENT-SIDE. Structured to move to Worker when
 * computation goes server-side. No DOM dependencies except countryFlag()
 * and esc() which are display-only helpers.
 *
 * MIGRATION NOTE: When moving to Worker, this file becomes the computation
 * engine. The Worker imports it, computes results, and returns formatted data.
 * Pages become thin display templates. countryFlag() and esc() stay client-side.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MULTI-ROUND / MULTI-JUDGE HUNTER DERBY RENDERING
 * ───────────────────────────────────────────────────────────────────────────
 * Hunter derbies (class_type H, H[2]='2') have per-judge phase scoring that
 * Ryegate does NOT expose pre-ranked. We compute all relative placings
 * client-side from raw column data. Judge count comes from H[37] derby type
 * (derbyTypes[code].judges — 1 for National, 2 for International).
 *
 * Per-judge phase card formulas:
 *   R1 = base + hiopt
 *   R2 = base + hiopt + bonus   (bonus = handy/option, R2 only)
 *
 * Column map (confirmed 2026-04-05 on 1000.cls national + 1001.cls international):
 *   R1:  [15]=hiOpt  [16]=J1base  [17]=hiOpt(mirror)  [18]=J2base
 *   R2:  [24]=hiOpt  [25]=J1base  [26]=J1bonus  [27]=hiOpt(mirror)  [28]=J2base  [29]=J2bonus
 *   [42]=R1total  [43]=R2total  [14]=final place (Ryegate-assigned, trusted)
 *   [45]=combined is STALE — recompute as [42]+[43]
 *   [46]/[47]=R1/R2 numeric status  [52]/[53]=R1/R2 text status (RF/HF/EL/OC/DNS/EX)
 *
 * Computed per-entry (WEST.hunter.derby.computeRankings):
 *   _jt.r1Ranks[j]        — relative rank by this judge's R1 phaseTotal
 *   _jt.r2Ranks[j]        — relative rank by this judge's R2 phaseTotal
 *   _jt.judgeCardTotals[j]— this judge's R1+R2 sum
 *   _jt.judgeCardRanks[j] — relative rank if only this judge scored the class
 *   _jt.movement          — R1-only overall rank minus final place (↑ moved up, ↓ moved down)
 *   _jt.combinedRank      — final place (from col[14])
 * Ties use standard competition ranking (1,1,3).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DERBY DISPLAY RULES (results.html)
 * ───────────────────────────────────────────────────────────────────────────
 * Two distinct render paths based on judge count — 1 judge collapses the
 * per-judge breakdown onto the row itself since it would be redundant in an
 * expand panel.
 *
 * NATIONAL — 1 judge (derby type 1, 4, 6, 8 per derbyTypes table):
 *   • Main row shows full breakdown inline:
 *       R1:  base + hiopt = phaseTotal         (rank)
 *       R2:  base + hiopt + bonus = phaseTotal (rank)
 *       Total: combined.toFixed(2)
 *   • (rank) = per-round rank across all entries (_jt.r1Ranks[0] / r2Ranks[0])
 *   • NO expand panel, NO click handler, NO "View Judge Scores" button
 *   • NO judge-summary header (single judge can't disagree with itself)
 *
 * INTERNATIONAL / H&G — 2 judges (derby type 0, 2, 3, 5, 7):
 *   • Main row shows aggregate totals only: R1=[42], R2=[43], Total=.toFixed(2)
 *   • "View Judge Scores" pill sits inside the scores column below the total
 *   • Click to expand → right-aligned panel under the row:
 *       - Round 1 section: J1 R1 / J2 R1 with "base + hiopt = total (rank)"
 *       - Round 2 section: J1 R2 / J2 R2 with "base + hiopt + bonus = total (rank)"
 *       - Judge Cards section: per-judge R1+R2 with "(Nth overall)" —
 *         only rendered when judges' card ranks are not all identical
 *   • Solo-winner green highlight: rank===1 on a per-phase row when that
 *     judge alone placed them first (relative to other judges in that phase)
 *   • Would-win green highlight: rank===1 on a judge card row when that
 *     single judge's card would make them class winner
 *   • Judge Cards Summary header (above list): only when judges disagree on #1
 *
 * STATUS / EDGE CASES (both paths):
 *   • R1 status + no R1 score → suppress place, ribbon shows status label, no expand
 *   • R1 clean + R2 status (e.g. EL in R2) → place stands on R1 alone, R1 row
 *     normal, R2 row renders status label instead of score, combined = R1Total
 *   • R1 only, R2 not yet ridden → running total shows R1Total, no movement arrow
 *   • Movement arrow: hidden unless both rounds complete AND rank actually changed
 *     (no-change and not-applicable render as empty space to preserve alignment)
 *
 * CURRENT DATA SOURCE (temporary):
 *   results.html parses per-judge data directly from classInfo.cls_raw via
 *   WEST.parseClsRows + WEST.hunter.derby.parseEntry. Once the watcher emits
 *   per-judge fields through Worker→D1, the render path switches to reading
 *   structured fields off entries[] and everything downstream stays identical.
 *
 * Last updated: 2026-04-05
 */

var WEST = WEST || {};


/* ═══════════════════════════════════════════════════════════════════════════
   SHARED — applies to all class types
   ═══════════════════════════════════════════════════════════════════════════ */

// ── ESCAPE HTML ──────────────────────────────────────────────────────────────
WEST.esc = function(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

// ── TIME FORMATTING ──────────────────────────────────────────────────────────
// H[05] ClockPrecision — CONFIRMED 2026-04-05:
//   0 = thousandths (.XXX)
//   1 = hundredths (.XX)
//   2 = whole seconds (probable, untested)
WEST.formatTime = function(val, precision) {
  if (!val) return '';
  var n = parseFloat(val);
  if (isNaN(n)) return String(val);
  var p = parseInt(precision);
  if (isNaN(p)) p = 0;
  if (p === 0) return n.toFixed(3);
  if (p === 1) return n.toFixed(2);
  return Math.round(n).toString();
};

// ── CLS HEADER PARSER ────────────────────────────────────────────────────────
WEST.parseClsHeader = function(clsRaw) {
  if (!clsRaw) return [];
  var line = clsRaw.split(/\r?\n/)[0] || '';
  var r = [], c = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { r.push(c.trim()); c = ''; }
    else c += ch;
  }
  r.push(c.trim());
  return r;
};

// ── CLS ENTRY ROW PARSER ─────────────────────────────────────────────────────
// Parses all entry rows from a .cls file. Skips header (line 0) and @foot lines.
// Returns array of col arrays — each col array is one entry row.
WEST.parseClsRows = function(clsRaw) {
  if (!clsRaw) return [];
  var lines = clsRaw.split(/\r?\n/);
  var rows = [];
  for (var li = 1; li < lines.length; li++) {
    var line = lines[li];
    if (!line || line.charAt(0) === '@') continue;
    var r = [], c = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { r.push(c); c = ''; }
      else c += ch;
    }
    r.push(c);
    if (r[0] && /^\d/.test(r[0])) rows.push(r);
  }
  return rows;
};

// ── ORDINAL ──────────────────────────────────────────────────────────────────
WEST.ordinal = function(n) {
  var s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ── COUNTRY FLAGS ────────────────────────────────────────────────────────────
// FEI 3-letter → ISO 2-letter for flagcdn.com images
// Only displayed when show_flags is enabled on the class (H[26] for jumper)
WEST.FEI_ISO = {AFG:'af',ALB:'al',ALG:'dz',AND:'ad',ANG:'ao',ANT:'ag',ARG:'ar',ARM:'am',ARU:'aw',AUS:'au',AUT:'at',AZE:'az',BAH:'bs',BAN:'bd',BAR:'bb',BEL:'be',BER:'bm',BIH:'ba',BOL:'bo',BRA:'br',BUL:'bg',CAN:'ca',CAY:'ky',CHI:'cl',CHN:'cn',COL:'co',CRC:'cr',CRO:'hr',CUB:'cu',CYP:'cy',CZE:'cz',DEN:'dk',DOM:'do',ECU:'ec',EGY:'eg',ESP:'es',EST:'ee',ETH:'et',FIN:'fi',FRA:'fr',GAB:'ga',GBR:'gb',GEO:'ge',GER:'de',GHA:'gh',GRE:'gr',GUA:'gt',HKG:'hk',HON:'hn',HUN:'hu',INA:'id',IND:'in',IRI:'ir',IRL:'ie',ISL:'is',ISR:'il',ISV:'vi',ITA:'it',JAM:'jm',JOR:'jo',JPN:'jp',KAZ:'kz',KEN:'ke',KOR:'kr',KSA:'sa',KUW:'kw',LAT:'lv',LBN:'lb',LIE:'li',LTU:'lt',LUX:'lu',MAR:'ma',MAS:'my',MEX:'mx',MGL:'mn',MKD:'mk',MON:'mc',NED:'nl',NEP:'np',NOR:'no',NZL:'nz',OMA:'om',PAN:'pa',PAR:'py',PER:'pe',PHI:'ph',POL:'pl',POR:'pt',PUR:'pr',QAT:'qa',ROU:'ro',RSA:'za',RUS:'ru',SIN:'sg',SLO:'si',SRB:'rs',SUI:'ch',SVK:'sk',SWE:'se',THA:'th',TPE:'tw',TTO:'tt',TUN:'tn',TUR:'tr',UAE:'ae',UKR:'ua',URU:'uy',USA:'us',UZB:'uz',VEN:'ve',VIE:'vn'};

WEST.countryFlag = function(feiCode, showFlags) {
  if (!feiCode || !showFlags) return '';
  var iso = WEST.FEI_ISO[String(feiCode).trim().toUpperCase()];
  if (!iso) return '';
  return '<img style="margin-left:4px;vertical-align:baseline;position:relative;top:1px;" src="https://flagcdn.com/20x15/' + iso + '.png" alt="' + WEST.esc(feiCode) + '" width="20" height="15">';
};

// ── CLASS TYPE LABEL ─────────────────────────────────────────────────────────
// Returns a human-readable label for any class
WEST.getClassTypeLabel = function(classInfo) {
  if (!classInfo) return '';
  var ct = (classInfo.class_type || '').toUpperCase();
  var sm = classInfo.scoring_method || '';

  if (ct === 'J' || ct === 'T') return WEST.jumper.getMethod(sm).label;
  if (ct === 'H') return WEST.hunter.getClassLabel(classInfo);
  if (ct === 'U') return 'Unformatted';
  return ct;
};


/* ═══════════════════════════════════════════════════════════════════════════
   JUMPER — class_type J (Farmtek) or T (TIMY)
   ═══════════════════════════════════════════════════════════════════════════ */

WEST.jumper = {};

// ── SCORING METHODS ──────────────────────────────────────────────────────────
// H[02] for jumper classes
WEST.jumper.methods = {
  '2':  { label: 'Jumper II.2a',       table: 'II.2a', rounds: 2, hasJO: true,  immediate: false, isOptimum: false, isTwoPhase: false },
  '3':  { label: 'Jumper (3 rounds)',   table: 'III',   rounds: 3, hasJO: true,  immediate: false, isOptimum: false, isTwoPhase: false },
  '4':  { label: 'Speed II.1',         table: 'II.1',  rounds: 1, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: false },
  '6':  { label: 'Optimum Time IV.1',  table: 'IV.1',  rounds: 1, hasJO: false, immediate: false, isOptimum: true,  isTwoPhase: false },
  '9':  { label: 'Two-Phase',          table: 'II.2d', rounds: 2, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: true  },
  '13': { label: 'Jumper II.2b',       table: 'II.2b', rounds: 2, hasJO: true,  immediate: true,  isOptimum: false, isTwoPhase: false },
};

WEST.jumper.getMethod = function(code) {
  return WEST.jumper.methods[String(code)] || { label: 'Jumper', table: '', rounds: 1, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: false };
};

// ── ROUND LABELS ─────────────────────────────────────────────────────────────
WEST.jumper.roundLabel = function(method, round) {
  var m = WEST.jumper.getMethod(method);
  if (m.isTwoPhase) return round === 1 ? 'PH1' : round === 2 ? 'PH2' : 'PH' + round;
  if (m.rounds === 3) return round === 1 ? 'R1' : round === 2 ? 'R2' : 'JO';
  return round === 1 ? 'R1' : round === 2 ? 'JO' : 'R' + round;
};

// ── OPTIMUM TIME ─────────────────────────────────────────────────────────────
// Table IV.1 (method 6): optimum = TA - 4 (hardcoded FEI rule, not in .cls)
WEST.jumper.OPTIMUM_OFFSET = 4;

WEST.jumper.getOptimumTime = function(ta) {
  return ta > 0 ? ta - WEST.jumper.OPTIMUM_OFFSET : 0;
};

WEST.jumper.getOptimumDistance = function(elapsed, ta) {
  var opt = WEST.jumper.getOptimumTime(ta);
  if (opt <= 0) return null;
  return elapsed - opt;
};

// ── TA VALUES ────────────────────────────────────────────────────────────────
// Read from cls_raw header: H[08]=R1, H[11]=R2, H[14]=R3
WEST.jumper.getTAFromRaw = function(clsRaw) {
  var h = WEST.parseClsHeader(clsRaw);
  var ct = h[0] || '';
  if (ct === 'J' || ct === 'T') {
    return { r1: parseFloat(h[8]) || 0, r2: parseFloat(h[11]) || 0, r3: parseFloat(h[14]) || 0 };
  }
  return { r1: 0, r2: 0, r3: 0 };
};

// ── TIME FAULT FORMULA ───────────────────────────────────────────────────────
// From cls header: H[07]=faultsPerInterval, H[09]=timeInterval, H[22]=penaltySeconds
WEST.jumper.getTimeFaultParams = function(clsRaw, round) {
  var h = WEST.parseClsHeader(clsRaw);
  var offset = (round - 1) * 3; // R1=[7,8,9], R2=[10,11,12], R3=[13,14,15]
  return {
    fpi: parseFloat(h[7 + offset]) || 1,
    ti:  parseFloat(h[9 + offset]) || 1,
    ps:  parseFloat(h[22]) || 6,
  };
};

WEST.jumper.calcTimeFaults = function(elapsed, ta, fpi, ti) {
  if (!ta || ta <= 0) return 0;
  var secsOver = Math.max(0, elapsed - ta);
  if (secsOver <= 0) return 0;
  return Math.ceil(secsOver / ti) * fpi;
};

// ── STATUS CODES ─────────────────────────────────────────────────────────────
// TIMY (T): col[82]=R1 status, col[83]=R2 status, col[84]=R3 (unconfirmed)
// Farmtek (J): col[39]=single status
// Text codes: RF, HF, EL, OC, DNS, DNF, WD, SC
// RT (Retired): col[82]=empty, often no text — detected by entry having no R2 data
WEST.jumper.statusCodes = {
  'RF':  { label: 'RF',   fullLabel: 'Rider Fall'     },
  'HF':  { label: 'HF',   fullLabel: 'Horse Fall'     },
  'EL':  { label: 'EL',   fullLabel: 'Eliminated'     },
  'OC':  { label: 'OC',   fullLabel: 'Off Course'     },
  'DNS': { label: 'DNS',  fullLabel: 'Did Not Start'  },
  'DNF': { label: 'DNF',  fullLabel: 'Did Not Finish' },
  'WD':  { label: 'WD',   fullLabel: 'Withdrawn'      },
  'SC':  { label: 'SC',   fullLabel: 'Schooling'      },
  'RT':  { label: 'RT',   fullLabel: 'Retired'        },
};

WEST.jumper.getStatusLabel = function(code) {
  if (!code) return null;
  var s = WEST.jumper.statusCodes[String(code).trim().toUpperCase()];
  return s ? s.label : String(code).toUpperCase();
};

// ── HAS COMPETED ─────────────────────────────────────────────────────────────
// Evidence-based: hasGone flag alone is NOT reliable for jumper
// Must have time, place, or status code
WEST.jumper.hasCompeted = function(entry) {
  return !!(entry.r1TotalTime || entry.overallPlace || entry.statusCode || entry.r1StatusCode);
};

// ── PLACE DISPLAY ────────────────────────────────────────────────────────────
// Any status code = suppress place (jumper entries with status didn't complete)
WEST.jumper.shouldShowPlace = function(entry) {
  if (entry.statusCode || entry.r1StatusCode || entry.r2StatusCode) return false;
  return !!entry.overallPlace;
};

// ── STANDINGS SORT ───────────────────────────────────────────────────────────
// Places come from .cls file (Ryegate sorts). We trust them.
// For display sorting when no place: faults asc, then time asc (or optimum distance)
WEST.jumper.sortEntries = function(entries, method) {
  var m = WEST.jumper.getMethod(method);
  return entries.slice().sort(function(a, b) {
    var pa = parseInt(a.overallPlace || a.place || 999);
    var pb = parseInt(b.overallPlace || b.place || 999);
    return pa - pb;
  });
};


/* ═══════════════════════════════════════════════════════════════════════════
   HUNTER — class_type H
   ═══════════════════════════════════════════════════════════════════════════ */

WEST.hunter = {};

// ── DERBY TYPES ──────────────────────────────────────────────────────────────
// H[37] — confirmed 2026-04-03
WEST.hunter.derbyTypes = {
  '0': { label: 'International',           judges: 2, hg: false, showAllRounds: true  },
  '1': { label: 'National',                judges: 1, hg: false, showAllRounds: false },
  '2': { label: 'National H&G',            judges: 1, hg: true,  showAllRounds: true  },
  '3': { label: 'International H&G',       judges: 2, hg: true,  showAllRounds: true  },
  '4': { label: 'USHJA Pony Derby',        judges: 1, hg: false, showAllRounds: false },
  '5': { label: 'USHJA Pony Derby H&G',    judges: 1, hg: true,  showAllRounds: true  },
  '6': { label: 'USHJA 2\'6 Jr Derby',     judges: 1, hg: false, showAllRounds: false },
  '7': { label: 'USHJA 2\'6 Jr Derby H&G', judges: 1, hg: true,  showAllRounds: true  },
  '8': { label: 'WCHR Derby Spec',         judges: 1, hg: false, showAllRounds: false },
};

WEST.hunter.getDerby = function(code) {
  return WEST.hunter.derbyTypes[String(code)] || null;
};

// ── CLASS LABEL ──────────────────────────────────────────────────────────────
WEST.hunter.getClassLabel = function(classInfo) {
  if (!classInfo) return 'Hunter';
  // Check if derby via cls_raw header H[37]
  var h = WEST.parseClsHeader(classInfo.cls_raw);
  var derbyType = h[37] || '0';
  var scoreType = h[2] || '0';
  if (scoreType === '2') {
    var derby = WEST.hunter.getDerby(derbyType);
    return derby ? derby.label : 'Hunter Derby';
  }
  if (h[10] === 'True') return 'Equitation';
  if (h[11] === 'True') return 'Hunter Championship';
  if (h[5] === '1') return 'Hunter Flat';
  return 'Hunter';
};

// ── IS DERBY ─────────────────────────────────────────────────────────────────
// Accepts both D1 naming (class_type/cls_raw) and watcher KV naming (classType/clsRaw)
WEST.hunter.isDerby = function(classInfo) {
  if (!classInfo) return false;
  var ct = classInfo.class_type || classInfo.classType;
  if (ct !== 'H') return false;
  var raw = classInfo.cls_raw || classInfo.clsRaw || '';
  var h = WEST.parseClsHeader(raw);
  return h[2] === '2';
};

// ── IS EQUITATION ────────────────────────────────────────────────────────────
// H[10]='True' in the .cls header marks a hunter-formatted equitation class.
// Jumper-formatted equitation classes (J/T .cls files) are NOT covered by this
// flag — they need separate handling.
WEST.hunter.isEquitation = function(classInfo) {
  if (!classInfo) return false;
  var ct = classInfo.class_type || classInfo.classType;
  if (ct !== 'H') return false;
  var raw = classInfo.cls_raw || classInfo.clsRaw || '';
  var h = WEST.parseClsHeader(raw);
  return h[10] === 'True';
};

// ── DERBY COLUMN MAP ─────────────────────────────────────────────────────────
// Where to find scores in hunter entry rows — varies by number of judges
//
// National (1 judge):
//   R1: [15]=hiOpt  [16]=J1base               [42]=R1total
//   R2: [24]=hiOpt  [25]=J1base  [26]=J1handy  [43]=R2total
//
// International (2 judges):
//   R1: [15]=hiOpt  [16]=J1base  [17]=hiOpt(mirror)  [18]=J2base  [42]=R1total
//   R2: [24]=hiOpt  [25]=J1base  [26]=J1handy  [27]=hiOpt(mirror)  [28]=J2base  [29]=J2handy  [43]=R2total
//
// Combined: [45] = R1+R2 (ONLY reliable after operator views Overall in Ryegate)
// Safe: always compute R1total + R2total ourselves
//
// Standard hunter (not derby):
//   [15]=score  [42]=R1total  [45]=combined
//   Two-round: [24]=R2score  [43]=R2total  [45]=R1+R2

// ── STATUS CODES ─────────────────────────────────────────────────────────────
// col[52]=R1 text, col[53]=R2 text
// col[46]=R1 numeric, col[47]=R2 numeric
//
// Text codes: RF, HF, EL, OC, DNS, EX
// Numeric: 0=normal, 2=abnormal exit, 3=retired(RT)
// NOTE: RT does not always write text to col[52/53] — use numeric col[46/47]=3 as fallback
WEST.hunter.statusCodes = {
  'RF':  { label: 'RF',   fullLabel: 'Rider Fall'    },
  'HF':  { label: 'HF',   fullLabel: 'Horse Fall'    },
  'EL':  { label: 'EL',   fullLabel: 'Eliminated'    },
  'OC':  { label: 'OC',   fullLabel: 'Off Course'    },
  'DNS': { label: 'DNS',  fullLabel: 'Did Not Start' },
  'EX':  { label: 'EX',   fullLabel: 'Excused'       },
  'RT':  { label: 'RT',   fullLabel: 'Retired'       },
};

// Numeric fallback: col[46]/col[47]
WEST.hunter.numericStatusMap = {
  '2': 'EL',  // Generic — text code has specifics (RF/HF/EL/OC/DNS)
  '3': 'RT',  // Retired — text code often missing
};

WEST.hunter.getStatus = function(textCode, numericCode) {
  // 1. Check text code first (authoritative when present)
  if (textCode) {
    var upper = String(textCode).trim().toUpperCase();
    var s = WEST.hunter.statusCodes[upper];
    return s || { label: upper, fullLabel: upper };
  }
  // 2. Fall back to numeric code
  if (numericCode && String(numericCode) !== '0') {
    var mapped = WEST.hunter.numericStatusMap[String(numericCode)];
    if (mapped) return WEST.hunter.statusCodes[mapped];
    return { label: '?', fullLabel: 'Unknown Status' };
  }
  // 3. No status — normal completion
  return null;
};

// ── HAS COMPETED ─────────────────────────────────────────────────────────────
// Hunter hasGone waterfall:
// 1. hasGone=1 AND has score/status → competed
// 2. hasGone=0 but has score → manual entry, still competed
// 3. hasGone=1 but no score and no status → accidental toggle, NOT competed
WEST.hunter.hasCompeted = function(entry) {
  var hasEvidence = !!(entry.score || entry.r1Total || entry.combined ||
    entry.statusCode || entry.r1TextStatus ||
    (entry.r1NumericStatus && String(entry.r1NumericStatus) !== '0'));
  return hasEvidence;
};

// ── HAS COMPETED R2 ──────────────────────────────────────────────────────────
// R2 evidence: score, total, or status code
WEST.hunter.hasCompetedR2 = function(entry) {
  return !!(entry.r2Score || entry.r2Total ||
    entry.r2TextStatus ||
    (entry.r2NumericStatus && String(entry.r2NumericStatus) !== '0'));
};

// ── PLACE DISPLAY ────────────────────────────────────────────────────────────
// R1 status with no R1 score → suppress place (never finished R1)
// R2 status with R1 score → show place (completed R1, ranked on R1 score)
// No status → show place
WEST.hunter.shouldShowPlace = function(entry) {
  var r1Status = WEST.hunter.getStatus(entry.r1TextStatus || entry.statusCode, entry.r1NumericStatus);
  var hasR1Score = !!(entry.score || entry.r1Total);

  // R1 status with no score = didn't finish, suppress place
  if (r1Status && !hasR1Score) return false;

  // Everything else = show place if they have one
  return !!(entry.place || entry.overallPlace);
};

// ── DIVISION CHAMPION ────────────────────────────────────────────────────────
// H + IsChampionship + no entries actually competed = division standings only
// Display as placement list, no score columns, no stats link
WEST.hunter.isDivisionChampion = function(classInfo, entries) {
  if (!classInfo || classInfo.class_type !== 'H') return false;
  var h = WEST.parseClsHeader(classInfo.cls_raw);
  if (h[11] !== 'True') return false; // Not championship
  if (!entries || !entries.length) return true;
  var anyCompeted = entries.some(function(e) { return WEST.hunter.hasCompeted(e); });
  return !anyCompeted;
};

// ── COMBINED TOTAL ───────────────────────────────────────────────────────────
// col[45] is unreliable (only correct after operator views Overall in Ryegate)
// Always compute ourselves: R1total + R2total
WEST.hunter.getCombinedTotal = function(entry) {
  var r1 = parseFloat(entry.r1Total || entry.score || 0) || 0;
  var r2 = parseFloat(entry.r2Total || 0) || 0;
  return r1 + r2;
};


/* ───────────────────────────────────────────────────────────────────────────
   HUNTER DERBY — per-judge scoring, relative ranks, judge cards
   ─────────────────────────────────────────────────────────────────────────── */

WEST.hunter.derby = {};

// Judge count from header H[37] derby type
WEST.hunter.derby.getJudgeCount = function(classInfo) {
  if (!classInfo || !classInfo.cls_raw) return 1;
  var h = WEST.parseClsHeader(classInfo.cls_raw);
  var type = WEST.hunter.derbyTypes[String(h[37] || '0')];
  return type ? type.judges : 1;
};

// Parse a CLS entry row into a structured derby entry with per-judge scores
// Column map (confirmed 2026-04-05 against 1000.cls national + 1001.cls international):
//   R1:  [15]=hiOpt  [16]=J1base  [17]=hiOpt(mirror)  [18]=J2base
//   R2:  [24]=hiOpt  [25]=J1base  [26]=J1bonus  [27]=hiOpt(mirror)  [28]=J2base  [29]=J2bonus
//   [42]=R1total  [43]=R2total  [45]=combined (stale — recompute ourselves)
//   [46]=R1numStatus [47]=R2numStatus [49]=hasGoneR1 [50]=hasGoneR2 [52]=R1textStatus [53]=R2textStatus
// Per judge phase card:
//   R1 = base + hiopt
//   R2 = base + hiopt + bonus  (bonus = handy/option bonus, R2 only)
WEST.hunter.derby.parseEntry = function(cols, judgeCount) {
  var num = function(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
  var r1 = [], r2 = [];
  var r1HiOpt = num(cols[15]);
  var r2HiOpt = num(cols[24]);

  var j1r1b = num(cols[16]);
  var j1r2b = num(cols[25]);
  var j1r2bonus = num(cols[26]);
  r1.push({ base: j1r1b, hiopt: r1HiOpt, bonus: 0,         phaseTotal: j1r1b + r1HiOpt });
  r2.push({ base: j1r2b, hiopt: r2HiOpt, bonus: j1r2bonus, phaseTotal: j1r2b + r2HiOpt + j1r2bonus });

  if (judgeCount >= 2) {
    var j2r1b = num(cols[18]);
    var j2r2b = num(cols[28]);
    var j2r2bonus = num(cols[29]);
    r1.push({ base: j2r1b, hiopt: r1HiOpt, bonus: 0,         phaseTotal: j2r1b + r1HiOpt });
    r2.push({ base: j2r2b, hiopt: r2HiOpt, bonus: j2r2bonus, phaseTotal: j2r2b + r2HiOpt + j2r2bonus });
  }

  return {
    entry_num:       cols[0] || '',
    horse:           cols[1] || '',
    rider:           cols[2] || '',
    country:         cols[4] || '',
    owner:           cols[5] || '',
    sire:            cols[6] || '',
    dam:             cols[7] || '',
    city:            cols[8] || '',
    state:           cols[9] || '',
    horse_fei:       cols[10] || '',
    rider_fei:       cols[11] || '',
    place:           (cols[14] && cols[14] !== '0') ? cols[14] : '',
    r1:              r1,
    r2:              r2,
    r1Total:         num(cols[42]),
    r2Total:         num(cols[43]),
    combined:        num(cols[42]) + num(cols[43]),
    r1NumericStatus: cols[46] || '',
    r2NumericStatus: cols[47] || '',
    hasGoneR1:       cols[49] === '1',
    hasGoneR2:       cols[50] === '1',
    r1TextStatus:    cols[52] || '',
    r2TextStatus:    cols[53] || '',
  };
};

// Did this entry compete R1 / R2?
WEST.hunter.derby.hasR1 = function(e) {
  if (e.r1TextStatus) return false;
  return !!(e.r1 && e.r1.some(function(p) { return p.phaseTotal > 0; }));
};
WEST.hunter.derby.hasR2 = function(e) {
  if (e.r2TextStatus) return false;
  return !!(e.r2 && e.r2.some(function(p) { return p.phaseTotal > 0; }));
};

// Assign standard-competition ranks (ties share rank, next skipped)
WEST.hunter.derby._assignRanks = function(items) {
  items.sort(function(a, b) { return b.val - a.val; });
  var ranks = {};
  for (var i = 0; i < items.length; i++) {
    if (i > 0 && items[i].val === items[i - 1].val) {
      ranks[items[i].key] = ranks[items[i - 1].key];
    } else {
      ranks[items[i].key] = i + 1;
    }
  }
  return ranks;
};

// Compute per-judge per-phase ranks, judge card totals + ranks, and movement
// Mutates each entry with _jt = { judgeCount, r1Ranks, r2Ranks, judgeCardTotals, judgeCardRanks, movement, combinedRank }
WEST.hunter.derby.computeRankings = function(entries, judgeCount) {
  var self = WEST.hunter.derby;
  var assign = self._assignRanks;

  entries.forEach(function(e) {
    e._jt = {
      judgeCount:      judgeCount,
      r1Ranks:         [],
      r2Ranks:         [],
      judgeCardTotals: [],
      judgeCardRanks:  [],
      movement:        null,
      combinedRank:    null,
    };
  });

  // R1 per-judge ranks
  for (var j = 0; j < judgeCount; j++) {
    (function(jj) {
      var items = entries.filter(self.hasR1).map(function(e) {
        return { key: e.entry_num, val: e.r1[jj].phaseTotal };
      });
      var ranks = assign(items);
      entries.forEach(function(e) { e._jt.r1Ranks[jj] = ranks[e.entry_num] || null; });
    })(j);
  }

  // R2 per-judge ranks
  for (var j2 = 0; j2 < judgeCount; j2++) {
    (function(jj) {
      var items = entries.filter(self.hasR2).map(function(e) {
        return { key: e.entry_num, val: e.r2[jj].phaseTotal };
      });
      var ranks = assign(items);
      entries.forEach(function(e) { e._jt.r2Ranks[jj] = ranks[e.entry_num] || null; });
    })(j2);
  }

  // Judge card totals + ranks (R1 + R2 per judge)
  for (var jc = 0; jc < judgeCount; jc++) {
    (function(jj) {
      entries.forEach(function(e) {
        if (self.hasR1(e) && self.hasR2(e)) {
          e._jt.judgeCardTotals[jj] = e.r1[jj].phaseTotal + e.r2[jj].phaseTotal;
        } else {
          e._jt.judgeCardTotals[jj] = null;
        }
      });
      var items = entries
        .filter(function(e) { return e._jt.judgeCardTotals[jj] !== null; })
        .map(function(e) { return { key: e.entry_num, val: e._jt.judgeCardTotals[jj] }; });
      var ranks = assign(items);
      entries.forEach(function(e) { e._jt.judgeCardRanks[jj] = ranks[e.entry_num] || null; });
    })(jc);
  }

  // R1 and R2 overall ranks — sum across judges per round, then rank.
  // For 1-judge these equal the per-judge rank; for multi-judge they're
  // the aggregate round-level rank shown next to R1/R2 totals on the row.
  var r1OverallItems = entries.filter(self.hasR1).map(function(e) {
    var sum = 0;
    for (var j = 0; j < judgeCount; j++) sum += e.r1[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  var r1OverallRanks = assign(r1OverallItems);

  var r2OverallItems = entries.filter(self.hasR2).map(function(e) {
    var sum = 0;
    for (var j = 0; j < judgeCount; j++) sum += e.r2[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  var r2OverallRanks = assign(r2OverallItems);

  entries.forEach(function(e) {
    var r1Rank = r1OverallRanks[e.entry_num] || null;
    var r2Rank = r2OverallRanks[e.entry_num] || null;
    var finalPlace = parseInt(e.place) || null;
    e._jt.r1OverallRank = r1Rank;
    e._jt.r2OverallRank = r2Rank;
    e._jt.combinedRank = finalPlace;
    // Movement: R1-only overall rank vs final place
    if (r1Rank && finalPlace && self.hasR2(e)) {
      e._jt.movement = r1Rank - finalPlace; // positive = moved up
    }
  });

  return entries;
};

// Split decision check — 2+ judges AND they disagree on positions 1, 2, or 3
// (any of the top 3 placings differ across judges → split).
WEST.hunter.derby.shouldShowJudgeSummary = function(entries, judgeCount) {
  if (judgeCount < 2) return false;
  for (var pos = 1; pos <= 3; pos++) {
    var atPos = [];
    for (var j = 0; j < judgeCount; j++) {
      var found = null;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i]._jt && entries[i]._jt.judgeCardRanks[j] === pos) {
          found = entries[i]; break;
        }
      }
      if (found) atPos.push(found.entry_num);
    }
    if (atPos.length >= 2 && atPos.some(function(n) { return n !== atPos[0]; })) return true;
  }
  return false;
};

// Top-N per judge (by judge card total) — used by summary header
WEST.hunter.derby.topPerJudge = function(entries, judgeCount, n) {
  var out = [];
  for (var j = 0; j < judgeCount; j++) {
    (function(jj) {
      var ranked = entries
        .filter(function(e) { return e._jt && e._jt.judgeCardTotals[jj] !== null; })
        .map(function(e) { return { entry: e, score: e._jt.judgeCardTotals[jj] }; })
        .sort(function(a, b) { return b.score - a.score; })
        .slice(0, n || 3);
      out.push(ranked);
    })(j);
  }
  return out;
};

// Render a phase card math string — always includes all components for the round
// R1:  "base + hiopt"
// R2:  "base + hiopt + bonus"
WEST.hunter.derby.renderPhaseMath = function(phase, roundNum) {
  var parts = [String(phase.base), String(phase.hiopt)];
  if (roundNum === 2) parts.push(String(phase.bonus));
  return parts.join(' + ');
};

// Compact per-judge per-round breakdown for the hunter live on-course finish card.
// Returns small HTML block suitable for embedding under the score+rank. Takes an
// already-parsed derby entry (from buildEntries) — same data shape used by the
// main derby renderer. Multi-round non-derby hunters will reuse this once their
// parser is wired — the shape is judge-count/round-count agnostic.
//
// Structure:
//   R1 total  (aggregate across judges, col[42])
//   R2 total  (aggregate across judges, col[43])
//   ---
//   J1 R1   base + hiopt = phaseTotal
//   J2 R1   base + hiopt = phaseTotal
//   J1 R2   base + hiopt + bonus = phaseTotal
//   J2 R2   base + hiopt + bonus = phaseTotal
// (1-judge derbies suppress the J-prefixed per-judge rows since they're
// redundant with the R1/R2 totals.)
WEST.hunter.derby.renderCompactBreakdown = function(entry, judgeCount) {
  if (!entry) return '';
  var hasR1 = WEST.hunter.derby.hasR1(entry);
  var hasR2 = WEST.hunter.derby.hasR2(entry);
  if (!hasR1 && !hasR2) return '';

  var html = '<div class="oc-breakdown">';

  // Aggregate totals — both rounds on one line to save vertical space, with per-round rank
  if (hasR1 || hasR2) {
    var r1Rank = entry._jt ? entry._jt.r1OverallRank : null;
    var r2Rank = entry._jt ? entry._jt.r2OverallRank : null;
    html += '<div class="oc-breakdown-totals-row">';
    if (hasR1) {
      html += '<span class="oc-breakdown-total-item"><span class="oc-breakdown-lbl">R1</span><span class="oc-breakdown-total-val">' + entry.r1Total + '</span>'
        + (r1Rank ? '<span class="oc-breakdown-total-rank">(' + WEST.ordinal(r1Rank) + ')</span>' : '')
        + '</span>';
    }
    if (hasR2) {
      html += '<span class="oc-breakdown-total-item"><span class="oc-breakdown-lbl">R2</span><span class="oc-breakdown-total-val">' + entry.r2Total + '</span>'
        + (r2Rank ? '<span class="oc-breakdown-total-rank">(' + WEST.ordinal(r2Rank) + ')</span>' : '')
        + '</span>';
    }
    html += '</div>';
  }

  // Per-judge details — multi-judge only. Laid out as a grid: rounds as rows,
  // judges as columns, so J1 R1 sits left of J2 R1 and J1 R2 sits under J1 R1.
  if (judgeCount > 1 && (hasR1 || hasR2)) {
    var cellHtml = function(lbl, p, roundNum, rank) {
      return '<span class="oc-breakdown-cell">'
        + '<span class="oc-breakdown-lbl">' + lbl + '</span>'
        + '<span class="oc-breakdown-math">' + WEST.hunter.derby.renderPhaseMath(p, roundNum) + ' = ' + p.phaseTotal + '</span>'
        + (rank ? '<span class="oc-breakdown-rank">(' + WEST.ordinal(rank) + ')</span>' : '')
        + '</span>';
    };
    html += '<div class="oc-breakdown-judges-grid">';
    if (hasR1) {
      html += '<div class="oc-breakdown-judges-row">';
      for (var j = 0; j < judgeCount; j++) {
        var jr1 = entry._jt && entry._jt.r1Ranks ? entry._jt.r1Ranks[j] : null;
        html += cellHtml('J' + (j + 1) + ' R1', entry.r1[j], 1, jr1);
      }
      html += '</div>';
    }
    if (hasR2) {
      html += '<div class="oc-breakdown-judges-row">';
      for (var j2 = 0; j2 < judgeCount; j2++) {
        var jr2 = entry._jt && entry._jt.r2Ranks ? entry._jt.r2Ranks[j2] : null;
        html += cellHtml('J' + (j2 + 1) + ' R2', entry.r2[j2], 2, jr2);
      }
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
};

/* ───────────────────────────────────────────────────────────────────────────
   DERBY HTML RENDERERS — shared between results.html and live.html
   Pure string templates, no DOM manipulation. Each page handles event wiring
   and open-state tracking itself.
   ─────────────────────────────────────────────────────────────────────────── */

// Normalize field naming — D1 uses cls_raw/show_flags, watcher KV uses clsRaw/showFlags
WEST.hunter.derby._clsRaw = function(classInfo) {
  if (!classInfo) return '';
  return classInfo.cls_raw || classInfo.clsRaw || '';
};
WEST.hunter.derby._showFlags = function(classInfo) {
  if (!classInfo) return false;
  return !!(classInfo.show_flags || classInfo.showFlags);
};

// Build parsed+ranked derby entries from classInfo (either D1 row or watcher KV body)
WEST.hunter.derby.buildEntries = function(classInfo) {
  var raw = WEST.hunter.derby._clsRaw(classInfo);
  if (!raw) return { entries: [], judgeCount: 1 };
  var judgeCount = WEST.hunter.derby.getJudgeCount({ cls_raw: raw });
  var rows = WEST.parseClsRows(raw);
  var entries = rows.map(function(r) { return WEST.hunter.derby.parseEntry(r, judgeCount); });
  WEST.hunter.derby.computeRankings(entries, judgeCount);
  entries.sort(function(a, b) {
    var pa = parseInt(a.place) || 999;
    var pb = parseInt(b.place) || 999;
    if (pa !== pb) return pa - pb;
    return (b.combined || 0) - (a.combined || 0);
  });
  return { entries: entries, judgeCount: judgeCount };
};

// Full list — returns complete '<div class="results-wrap">…</div>' HTML string
// Pages insert this via innerHTML and then bind their own toggleEntry handler
WEST.hunter.derby.renderList = function(classInfo) {
  var built = WEST.hunter.derby.buildEntries(classInfo);
  var entries = built.entries;
  var judgeCount = built.judgeCount;

  if (!entries.length) {
    return '<div class="results-wrap"><div class="no-results">No entries found for this class.</div></div>';
  }

  var html = '<div class="results-wrap">';
  if (judgeCount > 1 && WEST.hunter.derby.shouldShowJudgeSummary(entries, judgeCount)) {
    html += WEST.hunter.derby.renderSummary(entries, judgeCount);
  }
  for (var i = 0; i < entries.length; i++) {
    html += WEST.hunter.derby.renderEntry(entries[i], classInfo, judgeCount);
  }
  html += '</div>';
  return html;
};

// BY-JUDGE VIEW — renders the class grouped by judge, each section sorted by
// that judge's card total desc. Used when the user toggles "View Judges Scores"
// on the results page. Multi-judge derbies only (1-judge is redundant with
// combined view and the button is suppressed).
WEST.hunter.derby.renderByJudgeList = function(classInfo) {
  var esc = WEST.esc;
  var built = WEST.hunter.derby.buildEntries(classInfo);
  var entries = built.entries;
  var judgeCount = built.judgeCount;
  if (!entries.length || judgeCount < 2) return '<div class="results-wrap"><div class="no-results">No entries found for this class.</div></div>';

  var isEq = WEST.hunter.isEquitation(classInfo);
  var showFlags = WEST.hunter.derby._showFlags(classInfo);
  var html = '<div class="results-wrap by-judge-view">';

  for (var j = 0; j < judgeCount; j++) {
    (function(jj) {
      // Sort entries by this judge's card total desc, missing cards at bottom
      var sorted = entries.slice().sort(function(a, b) {
        var av = a._jt && a._jt.judgeCardTotals[jj];
        var bv = b._jt && b._jt.judgeCardTotals[jj];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av;
      });

      html += '<div class="judge-section">';
      html += '<div class="judge-section-hdr">Judge ' + (jj + 1) + '</div>';

      sorted.forEach(function(g) {
        var r1Status = WEST.hunter.getStatus(g.r1TextStatus, g.r1NumericStatus);
        var hasR1 = WEST.hunter.derby.hasR1(g);
        var hasR2 = WEST.hunter.derby.hasR2(g);
        var r1Failed = !!r1Status && !hasR1;
        var rank = g._jt ? g._jt.judgeCardRanks[jj] : null;
        var flag = showFlags ? WEST.countryFlag(g.country, true) : '';

        var placeText = r1Failed ? (r1Status ? r1Status.label : '—') : (rank ? rank : '—');

        html += '<div class="result-entry"><div class="result-main">';
        html += '<div class="r-ribbon"><div class="r-place-txt">' + placeText + '</div></div>';

        // Info column (EQ-aware)
        if (isEq) {
          var locale = [g.city, g.state].filter(Boolean).join(', ');
          html += '<div class="r-info">'
            + '<div class="r-horse-rider">'
            + '<span class="r-bib">' + esc(g.entry_num) + '</span>'
            + '<span class="r-horse">' + esc(g.rider) + (flag ? ' ' + flag : '') + '</span>'
            + (locale ? '<span class="r-rider-inline">' + esc(locale) + '</span>' : '')
            + '</div>'
            + (g.horse ? '<div class="r-owner">' + esc(g.horse) + '</div>' : '')
            + '</div>';
        } else {
          html += '<div class="r-info">'
            + '<div class="r-horse-rider">'
            + '<span class="r-bib">' + esc(g.entry_num) + '</span>'
            + '<span class="r-horse">' + esc(g.horse) + '</span>'
            + '<span class="r-rider-inline">' + esc(g.rider) + (flag ? ' ' + flag : '') + '</span>'
            + '</div>'
            + '</div>';
        }

        // Scores — this judge's R1, R2, and card total
        html += '<div class="r-scores">';
        if (r1Failed) {
          html += '<span class="r-status">' + (r1Status ? r1Status.label : 'DNS') + '</span>';
        } else {
          if (hasR1) {
            var p1 = g.r1[jj];
            html += '<div class="r-score-row"><span class="r-score-lbl">R1</span>'
              + '<span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(p1, 1) + ' = ' + p1.phaseTotal + '</span>'
              + '</div>';
          }
          if (hasR2) {
            var p2 = g.r2[jj];
            html += '<div class="r-score-row"><span class="r-score-lbl">R2</span>'
              + '<span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(p2, 2) + ' = ' + p2.phaseTotal + '</span>'
              + '</div>';
          }
          var cardTotal = g._jt && g._jt.judgeCardTotals[jj];
          if (cardTotal != null) {
            html += '<div class="r-total">' + cardTotal.toFixed(2) + '</div>';
          }
        }
        html += '</div>'; // r-scores

        html += '</div></div>'; // result-main, result-entry
      });

      html += '</div>'; // judge-section
    })(j);
  }

  html += '</div>';
  return html;
};

// Single entry row — returns '<div class="result-entry">…</div>'
WEST.hunter.derby.renderEntry = function(g, classInfo, judgeCount) {
  var esc = WEST.esc;
  var place = g.place || '';
  var r1Status = WEST.hunter.getStatus(g.r1TextStatus, g.r1NumericStatus);
  var r2Status = WEST.hunter.getStatus(g.r2TextStatus, g.r2NumericStatus);
  var hasR1 = WEST.hunter.derby.hasR1(g);
  var hasR2 = WEST.hunter.derby.hasR2(g);
  var r1Failed = !!r1Status && !hasR1;
  var canExpand = judgeCount > 1 && (hasR1 || hasR2) && !r1Failed;
  var showFlags = WEST.hunter.derby._showFlags(classInfo);
  var flag = showFlags ? WEST.countryFlag(g.country, true) : '';
  var isEq = WEST.hunter.isEquitation(classInfo);

  var html = '<div class="result-entry' + (canExpand ? ' has-judges' : '') + '"'
    + ' data-entry-num="' + esc(g.entry_num) + '"'
    + (canExpand ? ' onclick="toggleEntry(this,event)"' : '') + '>';
  html += '<div class="result-main">';

  // Movement arrow
  if (hasR1 && hasR2 && g._jt && g._jt.movement) {
    html += WEST.hunter.derby.renderMovement(g._jt.movement);
  } else {
    html += '<div class="r-move"></div>';
  }

  // Ribbon / place
  var placeText = r1Failed ? (r1Status ? r1Status.label : '—') : (place || '—');
  html += '<div class="r-ribbon"><div class="r-place-txt">' + placeText + '</div></div>';

  // Info column — rider-first for equitation, horse-first for open hunter/derby
  if (isEq) {
    var locale = [g.city, g.state].filter(Boolean).join(', ');
    html += '<div class="r-info">'
      + '<div class="r-horse-rider">'
      + '<span class="r-bib">' + esc(g.entry_num) + '</span>'
      + '<span class="r-horse">' + esc(g.rider) + (flag ? ' ' + flag : '') + '</span>'
      + (locale ? '<span class="r-rider-inline">' + esc(locale) + '</span>' : '')
      + '</div>'
      + (g.horse ? '<div class="r-owner">' + esc(g.horse) + '</div>' : '')
      + '</div>';
  } else {
    var breeding = [g.sire, g.dam].filter(Boolean).join(' x ');
    html += '<div class="r-info">'
      + '<div class="r-horse-rider">'
      + '<span class="r-bib">' + esc(g.entry_num) + '</span>'
      + '<span class="r-horse">' + esc(g.horse) + '</span>'
      + '<span class="r-rider-inline">' + esc(g.rider) + (flag ? ' ' + flag : '') + '</span>'
      + '</div>'
      + (breeding ? '<div class="r-breeding">' + esc(breeding) + '</div>' : '')
      + (g.owner && g.owner !== g.rider ? '<div class="r-owner">' + esc(g.owner) + '</div>' : '')
      + '</div>';
  }

  html += WEST.hunter.derby.renderScoresCol(g, judgeCount, hasR1, hasR2, r1Status, r2Status, r1Failed, canExpand);
  html += '</div>'; // result-main

  if (canExpand) {
    html += WEST.hunter.derby.renderExpand(g, judgeCount);
  }

  html += '</div>'; // result-entry
  return html;
};

WEST.hunter.derby.renderScoresCol = function(g, judgeCount, hasR1, hasR2, r1Status, r2Status, r1Failed, canExpand) {
  if (r1Failed) {
    return '<div class="r-scores"><span class="r-status">' + (r1Status ? r1Status.label : 'DNS') + '</span></div>';
  }
  var html = '<div class="r-scores">';

  if (judgeCount === 1) {
    if (hasR1) {
      var p1 = g.r1[0];
      var r1k = g._jt ? g._jt.r1Ranks[0] : null;
      html += '<div class="r-score-row"><span class="r-score-lbl">R1</span>'
        + '<span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(p1, 1) + ' = ' + p1.phaseTotal + '</span>'
        + (r1k ? '<span class="r-score-val" style="font-size:11px;color:#aaa;">(' + WEST.ordinal(r1k) + ')</span>' : '')
        + '</div>';
    }
    if (hasR2) {
      var p2 = g.r2[0];
      var r2k = g._jt ? g._jt.r2Ranks[0] : null;
      html += '<div class="r-score-row"><span class="r-score-lbl">R2</span>'
        + '<span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(p2, 2) + ' = ' + p2.phaseTotal + '</span>'
        + (r2k ? '<span class="r-score-val" style="font-size:11px;color:#aaa;">(' + WEST.ordinal(r2k) + ')</span>' : '')
        + '</div>';
    } else if (r2Status) {
      html += '<div class="r-score-row"><span class="r-score-lbl">R2</span><span class="r-status">' + r2Status.label + '</span></div>';
    }
  } else {
    if (hasR1) {
      var r1Rank = g._jt ? g._jt.r1OverallRank : null;
      html += '<div class="r-score-row"><span class="r-score-lbl">R1</span>'
        + '<span class="r-score-val primary">' + g.r1Total + '</span>'
        + (r1Rank ? '<span class="r-score-val" style="font-size:11px;color:#aaa;">(' + WEST.ordinal(r1Rank) + ')</span>' : '')
        + '</div>';
    }
    if (hasR2) {
      var r2Rank = g._jt ? g._jt.r2OverallRank : null;
      html += '<div class="r-score-row"><span class="r-score-lbl">R2</span>'
        + '<span class="r-score-val primary">' + g.r2Total + '</span>'
        + (r2Rank ? '<span class="r-score-val" style="font-size:11px;color:#aaa;">(' + WEST.ordinal(r2Rank) + ')</span>' : '')
        + '</div>';
    } else if (r2Status) {
      html += '<div class="r-score-row"><span class="r-score-lbl">R2</span><span class="r-status">' + r2Status.label + '</span></div>';
    }
  }

  if (hasR1 && hasR2) {
    html += '<div class="r-total">' + g.combined.toFixed(2) + '</div>';
  } else if (hasR1 && !hasR2 && !r2Status) {
    html += '<div class="r-total">' + g.r1Total.toFixed(2) + '</div>';
  } else if (hasR1 && r2Status) {
    html += '<div class="r-total">' + g.r1Total.toFixed(2) + '</div>';
  }

  if (canExpand) {
    html += '<div class="r-judge-hint">View Judge Scores</div>';
  }

  html += '</div>';
  return html;
};

WEST.hunter.derby.renderMovement = function(m) {
  if (m > 0)  return '<div class="r-move up">&uarr;' + m + '</div>';
  if (m < 0)  return '<div class="r-move down">&darr;' + Math.abs(m) + '</div>';
  return '<div class="r-move"></div>';
};

WEST.hunter.derby.renderExpand = function(e, judgeCount) {
  if (!e._jt) return '';
  var hasR1 = WEST.hunter.derby.hasR1(e);
  var hasR2 = WEST.hunter.derby.hasR2(e);
  var html = '<div class="derby-expand"><div class="de-inner">';

  if (hasR1) {
    html += '<div class="de-section"><div class="de-section-lbl">Round 1</div>';
    for (var j = 0; j < judgeCount; j++) {
      var p = e.r1[j];
      var rk = e._jt.r1Ranks[j];
      var solo = rk === 1 && judgeCount > 1;
      html += '<div class="de-judge-row">'
        + '<span class="de-judge-lbl">J' + (j + 1) + ' R1</span>'
        + '<span class="de-judge-math">' + WEST.hunter.derby.renderPhaseMath(p, 1) + ' = ' + p.phaseTotal + '</span>'
        + '<span class="de-judge-rank' + (solo ? ' solo-winner' : '') + '">'
        + (rk ? '(' + WEST.ordinal(rk) + ')' : '') + '</span>'
        + '</div>';
    }
    html += '</div>';
  }

  if (hasR2) {
    html += '<div class="de-section"><div class="de-section-lbl">Round 2</div>';
    for (var j2 = 0; j2 < judgeCount; j2++) {
      var p2 = e.r2[j2];
      var rk2 = e._jt.r2Ranks[j2];
      var solo2 = rk2 === 1 && judgeCount > 1;
      html += '<div class="de-judge-row">'
        + '<span class="de-judge-lbl">J' + (j2 + 1) + ' R2</span>'
        + '<span class="de-judge-math">' + WEST.hunter.derby.renderPhaseMath(p2, 2) + ' = ' + p2.phaseTotal + '</span>'
        + '<span class="de-judge-rank' + (solo2 ? ' solo-winner' : '') + '">'
        + (rk2 ? '(' + WEST.ordinal(rk2) + ')' : '') + '</span>'
        + '</div>';
    }
    html += '</div>';
  }

  if (judgeCount > 1 && hasR1 && hasR2 && e._jt.judgeCardTotals.some(function(t) { return t !== null; })) {
    var allSame = e._jt.judgeCardRanks.every(function(r) { return r === e._jt.judgeCardRanks[0]; });
    if (!allSame) {
      html += '<div class="de-section"><div class="de-section-lbl">Judge Cards</div>';
      e._jt.judgeCardTotals.forEach(function(t, idx) {
        if (t === null) return;
        var rank = e._jt.judgeCardRanks[idx];
        var wouldWin = rank === 1;
        html += '<div class="de-judge-card-row">'
          + '<span class="de-judge-card-lbl">J' + (idx + 1) + ' card</span>'
          + '<span class="de-judge-card-val">' + t.toFixed(2) + '</span>'
          + '<span class="de-judge-card-rank' + (wouldWin ? ' would-win' : '') + '">'
          + (rank ? '(' + WEST.ordinal(rank) + ' overall)' : '') + '</span>'
          + '</div>';
      });
      html += '</div>';
    }
  }

  html += '</div></div>';
  return html;
};

WEST.hunter.derby.renderSummary = function(entries, judgeCount) {
  var esc = WEST.esc;
  var tops = WEST.hunter.derby.topPerJudge(entries, judgeCount, 3);
  var topNums = tops.map(function(t) { return t[0] ? t[0].entry.entry_num : null; });
  var html = '<div class="jt-summary">'
    + '<div class="jt-summary-head">'
    + '<span class="jt-summary-title">Judge Cards &mdash; Split Decision</span>'
    + '<span class="jt-summary-sub">Judges disagree on top placing</span>'
    + '</div>';
  tops.forEach(function(top, j) {
    html += '<div class="jt-judge-block">'
      + '<div class="jt-judge-block-lbl">Judge ' + (j + 1) + '</div>';
    top.forEach(function(t, idx) {
      var differs = idx === 0 && topNums.some(function(n) { return n && n !== t.entry.entry_num; });
      html += '<div class="jt-judge-row' + (differs ? ' differs' : '') + '">'
        + '<span class="jt-judge-rank">' + WEST.ordinal(idx + 1) + '</span>'
        + '<span class="jt-judge-horse">' + esc(t.entry.horse) + '</span>'
        + '<span class="jt-judge-score">' + t.score + '</span>'
        + '</div>';
    });
    html += '</div>';
  });
  html += '</div>';
  return html;
};
