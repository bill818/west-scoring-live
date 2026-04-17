/**
 * WEST Scoring Live — Display Configuration
 * Client-side rendering helpers for all pages. Formats scores, statuses,
 * ribbons, and per-judge breakdowns. All pages include via <script src="display-config.js">
 *
 * This file does NOT score — Ryegate scores. We only render.
 * The .cls file is the source of truth. The Worker pre-computes all
 * rankings, and pages receive finished JSON — no client-side parsing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE (as of 2026-04-08)
 * ───────────────────────────────────────────────────────────────────────────
 * Watcher reads .cls → parses header + entries → posts to Worker
 * Worker runs computeClassResults() → pre-computes rankings, stats,
 *   per-judge breakdowns → stores in KV (results:slug:ring:classNum)
 * Pages poll /getResults → receive pre-computed JSON → just render
 *
 * This file provides:
 *   - Formatting helpers: esc(), formatTime(), countryFlag(), ordinal()
 *   - Ribbon SVG graphics: WEST.ribbon.svg(), placeRibbon(), champSvg()
 *   - Hunter rendering: renderPrecomputed(), renderEntry(), renderExpand(),
 *     renderScoresCol(), renderSummary(), renderCompactBreakdown()
 *   - Detection helpers: isDerby(), isEquitation(), getClassLabel()
 *   - Client-side fallback: buildEntries() + computeRankings() for
 *     historical classes that don't have pre-computed results yet
 *
 * renderPhaseMath auto-detects format from the data shape:
 *   - Worker sends { base, hiopt, bonus, phaseTotal } for derbies
 *     → renders "base + hiopt [+ bonus] = total" (always, even when 0)
 *   - Worker sends { score, phaseTotal } for non-derby scored classes
 *     → renders just the score number
 *   - The data shape IS the instruction — no isDerby flag needed
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HUNTER HEADER MAP (confirmed 2026-04-06)
 * ───────────────────────────────────────────────────────────────────────────
 * H[2]  ClassMode:    0=Over Fences, 1=Flat, 2=Derby, 3=Special
 * H[5]  ScoringType:  0=Forced, 1=Scored, 2=Hi-Lo
 * H[6]  ScoreMethod:  0=Total, 1=Average
 * H[7]  NumJudges:    1-7+ (confirmed up to 7)
 * H[10] IsEquitation  True/False
 * H[11] IsChampionship True/False
 * H[37] DerbyType:    0-8 (only when H[2]=2)
 *
 * DERBY column layout (H[2]=2, 1-2 judges):
 *   R1: [15]=hiOpt [16]=J1base [17]=hiOpt(mirror) [18]=J2base
 *   R2: [24]=hiOpt [25]=J1base [26]=J1bonus [27]=mirror [28]=J2base [29]=J2bonus
 *   Phase card: base + hiopt + bonus = phaseTotal
 *
 * NON-DERBY SCORED layout (H[2]=0, H[5]=1/2, 1-7+ judges):
 *   R1: col[15+j] for j=0..numJudges-1 (sequential)
 *   R2: col[24+j] for j=0..numJudges-1 (sequential)
 *   Phase card: just the score (no hiopt/bonus fields)
 *   Confirmed 2026-04-08 from class 1002 (7 judges, 2 rounds)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DISPLAY RULES
 * ───────────────────────────────────────────────────────────────────────────
 * 1-judge classes: inline breakdown on the row, no expand panel
 * 2+ judge classes: aggregate totals on row, click-to-expand per-judge panel
 * Split Decision pill: judges disagree on any of top 3 positions
 * View Judges Scores toggle: by-judge view for multi-judge classes
 * Ribbons: SVG for places 1-12, CH/RC for championships, only on non-live
 * Equitation: rider-first layout (rider bold, city/state, horse muted below)
 * Movement arrows: R1 rank vs final place, only when both rounds complete
 * Status codes: centralized elimination/status display rules:
 *   - WEST.elimStatuses (EL,RO,RF,OC,HF,EX,DQ) → display as "EL"
 *   - WEST.partialStatuses (WD,RT,HC) → display code as-is
 *   - WEST.hideStatuses (DNS) → hide entry entirely
 *   - WEST.statusDisplayLabel(code) → viewer-friendly label
 *   - WEST.jumper.getStatusDisplay(sm, r1, r2, r3) → per-method rules
 *   - WEST.hunter.getStatusDisplay(r1, r2, r3) → universal rule
 *
 * Table III / Faults Converted (H[2]=0 jumper):
 *   - Ranked by TOTAL TIME only (clock time + converted fault seconds)
 *   - r1TotalTime has the final time (Ryegate converts faults to seconds)
 *   - Jump faults shown muted (informational, not used for ranking)
 *   - No "flt" suffix on the display — it's a time class
 *   - Detect via scoringMethod === '0' or _computed.isFaultsConverted
 *
 * Last updated: 2026-04-09
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
// Confirmed 2026-04-08: only these two options exist in Ryegate.
WEST.formatTime = function(val, precision) {
  if (!val) return '';
  var n = parseFloat(val);
  if (isNaN(n)) return String(val);
  var p = parseInt(precision);
  if (p === 1) return n.toFixed(2);
  return n.toFixed(3); // default to thousandths
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

// ── RIBBON GRAPHICS ──────────────────────────────────────────────────────────
// SVG ribbons for placements 1-12, plus champion/reserve champion.
// Use only for classes that are NOT currently live (places can shuffle during
// scoring). Port of old site's ribbonSvg/champSvg/placeRibbon.
WEST.ribbon = {};

WEST.ribbon.svg = function(n) {
  var C = {
    1:  {o:'#0a3d8f',i:'#3a7bd5',f:'#e8f0fb',t:'#0a3d8f'},  // Blue
    2:  {o:'#8b0000',i:'#cc2222',f:'#fbe8e8',t:'#8b0000'},  // Red
    3:  {o:'#9a7800',i:'#d4a800',f:'#fdf6d8',t:'#7a5e00'},  // Yellow
    4:  {o:'#888',   i:'#bbb',   f:'#f4f4f4',t:'#555'   },  // White/Grey
    5:  {o:'#ad1457',i:'#e91e8c',f:'#fde8f3',t:'#ad1457'},  // Pink
    6:  {o:'#1a6b2a',i:'#2ea043',f:'#e8f5eb',t:'#1a6b2a'},  // Green
    7:  {o:'#4a2d8e',i:'#7c52cc',f:'#f0ebfb',t:'#4a2d8e'},  // Purple
    8:  {o:'#5c3317',i:'#8b5e3c',f:'#f5ede6',t:'#5c3317'},  // Brown
    9:  {o:'#666',   i:'#999',   f:'#f0f0f0',t:'#444'   },  // Grey
    10: {o:'#1565a8',i:'#5ba3e0',f:'#e3f2fd',t:'#1565a8'},  // Light blue
    11: {o:'#b0006a',i:'#e8409a',f:'#fce4f2',t:'#8b0052'},  // Fuchsia
    12: {o:'#3d7a00',i:'#7ec800',f:'#f0fce0',t:'#2d5c00'},  // Lime green
  };
  var c = C[n]; if (!c) return '';
  // Square 32x32 viewBox — no hanging tails. Bigger center disc so the
  // place number reads cleanly. Petals at r=12 around (16,16).
  var p = '';
  for (var i = 0; i < 12; i++) {
    var a = i * 30, r = 12, cx = 16, cy = 16, rad = a * Math.PI / 180;
    var x = (cx + r * Math.sin(rad)).toFixed(1);
    var y = (cy - r * Math.cos(rad)).toFixed(1);
    p += '<ellipse cx="' + x + '" cy="' + y + '" rx="4.5" ry="2.6" fill="' + c.o + '" transform="rotate(' + a + ',' + x + ',' + y + ')"/>';
  }
  var circles = '<circle cx="16" cy="16" r="10" fill="' + c.i + '"/><circle cx="16" cy="16" r="8" fill="' + c.f + '"/>';
  // Number is now ~12px in a r=8 disc — comfortably readable. Double-digit
  // shrinks slightly to fit.
  var fs = n >= 10 ? '10' : '12';
  return '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">'
    + p + circles
    + '<text x="16" y="16" text-anchor="middle" dominant-baseline="central" font-family="serif" font-weight="bold" font-size="' + fs + '" fill="' + c.t + '">' + n + '</text>'
    + '</svg>';
};

WEST.ribbon.champSvg = function(isRC) {
  var cols = isRC ? ['#8b0000','#9a7800','#888'] : ['#0a3d8f','#8b0000','#9a7800'];
  // Square 36x36 viewBox — no hanging tails. Three-layer rosette (outer +
  // mid + inner) so champion ribbons read as fancier than place ribbons,
  // with a bigger center disc for the CH/RC label.
  var p = '';
  for (var i = 0; i < 12; i++) {
    var a = i * 30, r = 14, cx = 18, cy = 18, rad = a * Math.PI / 180;
    var x = (cx + r * Math.sin(rad)).toFixed(1);
    var y = (cy - r * Math.cos(rad)).toFixed(1);
    p += '<ellipse cx="' + x + '" cy="' + y + '" rx="5" ry="2.8" fill="' + cols[0] + '" transform="rotate(' + a + ',' + x + ',' + y + ')"/>';
  }
  for (var i2 = 0; i2 < 12; i2++) {
    var a2 = i2 * 30 + 15, r2 = 10, cx2 = 18, cy2 = 18, rad2 = a2 * Math.PI / 180;
    var x2 = (cx2 + r2 * Math.sin(rad2)).toFixed(1);
    var y2 = (cy2 - r2 * Math.cos(rad2)).toFixed(1);
    p += '<ellipse cx="' + x2 + '" cy="' + y2 + '" rx="4" ry="2.3" fill="' + cols[1] + '" transform="rotate(' + a2 + ',' + x2 + ',' + y2 + ')"/>';
  }
  for (var i3 = 0; i3 < 8; i3++) {
    var a3 = i3 * 45, r3 = 6, cx3 = 18, cy3 = 18, rad3 = a3 * Math.PI / 180;
    var x3 = (cx3 + r3 * Math.sin(rad3)).toFixed(1);
    var y3 = (cy3 - r3 * Math.cos(rad3)).toFixed(1);
    p += '<ellipse cx="' + x3 + '" cy="' + y3 + '" rx="3.4" ry="2" fill="' + cols[2] + '" transform="rotate(' + a3 + ',' + x3 + ',' + y3 + ')"/>';
  }
  var lbl = isRC ? 'RC' : 'CH';
  return '<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">'
    + p
    + '<circle cx="18" cy="18" r="8" fill="#fff"/><circle cx="18" cy="18" r="6.5" fill="#f8f4e8"/>'
    + '<text x="18" y="18" text-anchor="middle" dominant-baseline="central" font-family="serif" font-weight="bold" font-size="9" fill="#111">' + lbl + '</text>'
    + '</svg>';
};

// Returns ribbon SVG for a given place. Championship classes (H[11]=True)
// get CH/RC ribbons for 1st/2nd. isChampionship flag from header takes
// priority; falls back to class name string match for backward compat.
WEST.ribbon.placeRibbon = function(place, className, isChampionship) {
  var n = parseInt(place);
  if (!n) return '';
  var isChamp = isChampionship || (className && /champion/i.test(className));
  if (isChamp && n === 1) return WEST.ribbon.champSvg(false);
  if (isChamp && n === 2) return WEST.ribbon.champSvg(true);
  return WEST.ribbon.svg(n) || '';
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


// ── STATUS CODE TABLES ──────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH — watcher + worker + all frontend pages reference
// these tables. Change here = change everywhere.
//
// TEXT CODES — the canonical set of status strings used site-wide.
// Source: Ryegate .cls files (text fields in tail columns) and UDP frames.
//
//   Code   Meaning               Category
//   ────   ────────────────────   ──────────
//   EL     Eliminated             elim
//   RO     Run Out                elim
//   RF     Refusal                elim
//   OC     Off Course             elim
//   HF     Had Faults (retired)   elim
//   EX     Excused                elim
//   DQ     Disqualified           elim
//   WD     Withdrawn              partial
//   RT     Retired                partial
//   HC     Hors Concours          partial
//   DNS    Did Not Start          hide
//
// NUMERIC CODES — Farmtek .cls entry rows use numeric values 1-6 as
// per-round status flags. Values > 6 are scoring data (e.g. faults),
// not status codes. This mapping is observed from live Culpeper 2026
// data cross-referenced against Ryegate's HTML output.
//
// ROUND COLUMNS (Farmtek J, 40-col entry rows):
//   Round   Scoring block   Status flag column
//   ─────   ─────────────   ──────────────────
//   R1      cols[15-20]     col[21]
//   R2/JO   cols[22-27]     col[28]
//   R3      cols[29-34]     col[35]
//
// NUMERIC → TEXT MAPPING:
//   Numeric   Text    Confirmed from
//   ───────   ────    ─────────────────────────────────
//   1         EL      (tentative — not yet observed)
//   2         RT      class 212 #6318 col[21]=2, Ryegate shows RT ✓ (NOT RF — RF=Rider Fall is different)
//   3         OC      class 264 #6056 col[28]=3, Ryegate shows EL (OC=off course=eliminated) ✓
//   4         WD      class 264 #1959 col[28]=4, Ryegate shows WD ✓
//   5         RF      class 220 #6116 col[21]=3+text=RF, Ryegate confirms Rider Fall ✓
//   6         DNS     (tentative — not yet observed)
//   >6        --      NOT a status — scoring data (e.g. col[28]=9 = 9 JO faults)
//
// TEXT STATUS SCAN — Farmtek also writes a text status string (EL/RF/OC/WD
// etc.) somewhere in cols[36]-[39], but the exact column shifts between
// entries. The watcher scans the cluster for any recognized code. When
// found, the text status takes priority over the numeric mapping.
//
// IMPORTANT: numeric codes 1,2,5,6 are tentative. As we observe them in
// live data, update the "Confirmed from" column. If a mapping is wrong,
// the text-status scan takes priority — numeric is fallback only.

WEST.numericStatusMap = { 1:'EL', 2:'RT', 3:'OC', 4:'WD', 5:'RF', 6:'DNS' };

// Status code categories
WEST.elimStatuses   = ['EL','RO','RF','OC','HF','EX','DQ'];  // Eliminations
WEST.hideStatuses   = ['DNS'];                                 // Hide entirely
WEST.partialStatuses = ['WD','RT','HC'];                       // May have partial data

WEST.isElimStatus = function(code) {
  return WEST.elimStatuses.indexOf((code || '').toUpperCase()) >= 0;
};
WEST.isHideStatus = function(code) {
  return WEST.hideStatuses.indexOf((code || '').toUpperCase()) >= 0;
};
WEST.isPartialStatus = function(code) {
  return WEST.partialStatuses.indexOf((code || '').toUpperCase()) >= 0;
};
WEST.isAnyStatus = function(code) {
  var c = (code || '').toUpperCase();
  return WEST.isElimStatus(c) || WEST.isHideStatus(c) || WEST.isPartialStatus(c);
};

// Display labels — viewers see generic codes, not specific reasons.
WEST.statusDisplayLabel = function(code) {
  var c = (code || '').toUpperCase();
  if (WEST.elimStatuses.indexOf(c) >= 0) return 'EL';
  if (c === 'RT') return 'RT';
  if (c === 'WD') return 'WD';
  if (c === 'HC') return 'HC';
  if (c === 'DNS') return 'DNS';
  return c || '';
};

// ── JUMPER ELIMINATION DISPLAY TABLE ─────────────────────────────────────────
// Three patterns based on scoring method (H[2]):
//
// SINGLE ROUND (0,4,5,6,7,8):
//   Any status = no place, no data shown.
//
// CARRY-BACK (3,9,14):
//   R1 status = no place, hide all.
//   R2 status = no place, carry-back wipes all (show R1 data for context, hide R2).
//   JO status = place valid (on R1+R2), show R1+R2, hide JO.
//
// R1-HOLDS (1,2,10,11,13,15):
//   R1 status = no place, hide all.
//   R2/PH2 status = place valid (on R1), show R1, hide R2.
//   JO status = place valid (on R1), show R1, hide JO.
//   Exception: 15 (Winning Round) JO status = no place (R1 wiped for JO).
//
// For ALL methods: R1/PH1 status = always no place, always hide data.

WEST.jumper = {};

WEST.jumper.singleRound = { '0':1, '4':1, '6':1, '7':1 };
WEST.jumper.r2CarryBack = { '3':1, '9':1, '14':1 };
WEST.jumper.r1Holds     = { '2':1, '11':1, '13':1 };

// Returns display rules for a status entry. null = no status, render normally.
// { showPlace, rounds: { 1: show|hide|status, 2: ..., 3: ... }, label }
WEST.jumper.getStatusDisplay = function(sm, r1Status, r2Status, r3Status) {
  var r1 = (r1Status || '').toUpperCase();
  var r2 = (r2Status || '').toUpperCase();
  var r3 = (r3Status || '').toUpperCase();
  var has1 = WEST.isAnyStatus(r1);
  var has2 = WEST.isAnyStatus(r2);
  var has3 = WEST.isAnyStatus(r3);
  if (!has1 && !has2 && !has3) return null; // no status — normal entry

  var label = WEST.statusDisplayLabel(r1 || r2 || r3);
  var s = String(sm);

  // R1 status — always no place, hide everything
  if (has1) {
    return { showPlace: false, showR1: false, showR2: false, showR3: false, label: label };
  }

  // Single round — should never have R2/R3 status but handle gracefully
  if (WEST.jumper.singleRound[s]) {
    return { showPlace: false, showR1: false, showR2: false, showR3: false, label: label };
  }

  // Carry-back methods (3, 9, 14) — R2 status wipes all, no place
  if (WEST.jumper.r2CarryBack[s] && has2) {
    return { showPlace: false, showR1: true, showR2: false, showR3: false, label: WEST.statusDisplayLabel(r2) };
  }

  // R1-holds methods — R2/PH2 status: place valid, show R1, hide R2
  if (WEST.jumper.r1Holds[s] && has2) {
    return { showPlace: true, showR1: true, showR2: false, showR3: false, label: WEST.statusDisplayLabel(r2) };
  }

  // JO (R3) status
  if (has3) {
    if (WEST.jumper.r2CarryBack[s]) {
      // Carry-back: JO status = place on R1+R2
      return { showPlace: true, showR1: true, showR2: true, showR3: false, label: WEST.statusDisplayLabel(r3) };
    }
    // R1-holds: JO status = place on R1
    return { showPlace: true, showR1: true, showR2: false, showR3: false, label: WEST.statusDisplayLabel(r3) };
  }

  // Fallback
  return { showPlace: false, showR1: false, showR2: false, showR3: false, label: label };
};

// ── SCORING METHODS ──────────────────────────────────────────────────────────
// H[02] for jumper classes
WEST.jumper.methods = {
  '2':  { label: 'Jumper II.2a',       table: 'II.2a', rounds: 2, hasJO: true,  immediate: false, isOptimum: false, isTwoPhase: false },
  '3':  { label: 'Jumper (3 rounds)',   table: 'III',   rounds: 3, hasJO: true,  immediate: false, isOptimum: false, isTwoPhase: false },
  '4':  { label: 'Speed II.1',         table: 'II.1',  rounds: 1, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: false },
  '6':  { label: 'Optimum Time IV.1',  table: 'IV.1',  rounds: 1, hasJO: false, immediate: false, isOptimum: true,  isTwoPhase: false },
  '7':  { label: 'Timed Equitation',   table: 'Eq',    rounds: 1, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: false },
  '9':  { label: 'Two-Phase',          table: 'II.2d', rounds: 2, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: true  },
  '11': { label: 'Jumper II.2c',       table: 'II.2c', rounds: 2, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: true, clearsOnly: true },
  '13': { label: 'Jumper II.2b',       table: 'II.2b', rounds: 2, hasJO: true,  immediate: true,  isOptimum: false, isTwoPhase: false },
  '14': { label: 'Team',               table: 'Team',  rounds: 3, hasJO: true,  immediate: false, isOptimum: false, isTwoPhase: false },
  '15': { label: 'Winning Round',      table: 'WR',    rounds: 2, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: false },
};

WEST.jumper.getMethod = function(code) {
  return WEST.jumper.methods[String(code)] || { label: 'Jumper', table: '', rounds: 1, hasJO: false, immediate: false, isOptimum: false, isTwoPhase: false };
};

// ── JO PLACE MAP (method 2 only) ─────────────────────────────────────────────
// Applies to II.2a (method 2) only — R1 clears return for a separate Jump Off
// in R1 ride order, with a gap between R1 and JO. II.2b (method 13) is an
// immediate JO (rider does JO right after their clear R1), so places populate
// progressively and no pre-JO overlay is needed. Returns a map
//   { entryNum: 'JO-1' | 'JO-2' | ... | '—' | null }
// null = no override, use the normal place column.
//
// States:
//   A — no clear has r2 activity yet → show JO-1..N for clears in r1 ride order
//   B — at least one clear has r2 activity → blank ("—") for clears still pending JO
//       (place for entries with r2 comes from Ryegate's computed overallPlace)
//
// Non-clear entries (faults or elim) are never overridden — they keep their
// normal R1 place / status.
WEST.jumper.computeJoPlaces = function(entries, scoringMethod) {
  var map = {};
  var sm = String(scoringMethod || '');
  if (sm !== '2') return map;
  if (!entries || !entries.length) return map;

  var hasR2Activity = function(e) {
    if (e.r2TotalTime) return true;
    if (e.r2TotalFaults && String(e.r2TotalFaults) !== '0') return true;
    var sc = (e.r2StatusCode || '').toUpperCase();
    // WD and DNS in JO = rider declined the jump off. Treat as no activity
    // so they retain eligibility via their R1 clear placing.
    if (sc && sc !== 'DNS' && sc !== 'WD') return true;
    return false;
  };
  var isR1Clear = function(e) {
    var tf = parseFloat(e.r1TotalFaults || 0);
    if (tf !== 0) return false;
    var sc = (e.r1StatusCode || e.statusCode || '').toUpperCase();
    var elimSet = ['EL','RF','HF','OC','WD','DNS','DNF','SC','RT'];
    if (elimSet.indexOf(sc) >= 0) return false;
    return !!(e.r1TotalTime);
  };

  var clears = entries.filter(isR1Clear);
  if (!clears.length) return map;

  // Sort clears by R1 ride order (fallback to entry number if rideOrder missing)
  clears.sort(function(a, b) {
    var ra = parseInt(a.rideOrder) || 9999;
    var rb = parseInt(b.rideOrder) || 9999;
    if (ra !== rb) return ra - rb;
    return String(a.entry_num || a.entryNum || '').localeCompare(String(b.entry_num || b.entryNum || ''));
  });

  // Only apply the JO-N overlay when JO has not started for anyone yet.
  // Once any clear has r2 activity, stop overriding and let Ryegate's place
  // flow through for every row — it's the source of truth on who's placed
  // where, withdrew, etc., and our helper can't reliably reason about it.
  var joStarted = clears.some(hasR2Activity);
  if (joStarted) return map;
  clears.forEach(function(e, i) {
    var key = e.entry_num || e.entryNum;
    map[key] = 'JO-' + (i + 1);
  });
  return map;
};

// ── ROUND LABELS ─────────────────────────────────────────────────────────────
// Compact label — for standings/rounds block (tight column width)
WEST.jumper.roundLabel = function(method, round) {
  var m = WEST.jumper.getMethod(method);
  if (m.isTwoPhase) return round === 1 ? 'PH1' : round === 2 ? 'PH2' : 'PH' + round;
  if (m.rounds === 3) return round === 1 ? 'R1' : round === 2 ? 'R2' : 'JO';
  if (m.rounds === 1) return 'R1'; // single-round (II.1, Optimum, Timed Eq) — never JO
  // Two-round: JO label only when the method actually has a JO (II.2a/II.2b).
  // Winning Round (method 15) has two straight rounds — no JO.
  if (!m.hasJO) return round === 1 ? 'R1' : round === 2 ? 'R2' : 'R' + round;
  return round === 1 ? 'R1' : round === 2 ? 'JO' : 'R' + round;
};

// Long label — for on-course banner (descriptive, has space)
WEST.jumper.roundLabelLong = function(method, round) {
  var m = WEST.jumper.getMethod(method);
  if (m.isTwoPhase) return round === 1 ? 'Phase 1' : round === 2 ? 'Phase 2' : 'Phase ' + round;
  if (m.rounds === 3) return round === 1 ? 'Round 1' : round === 2 ? 'Round 2' : 'Jump Off';
  if (m.rounds === 1) return 'Round 1'; // single-round — never Jump Off
  if (!m.hasJO) return round === 1 ? 'Round 1' : round === 2 ? 'Round 2' : 'Round ' + round;
  return round === 1 ? 'Round 1' : round === 2 ? 'Jump Off' : 'Round ' + round;
};

// ── EQUITATION ENTRY NAME HELPER ─────────────────────────────────────────────
// For jumper equitation (method 7): rider-focused display.
// Returns { primary, secondary, tertiary } for the entry row name fields.
//   Standard jumper: primary=horse, secondary=rider
//   Equitation:      primary=rider, secondary="City, ST", tertiary=horse
WEST.jumper.entryNameParts = function(entry, scoringMethod) {
  if (String(scoringMethod) === '7') {
    var locale = [entry.city, entry.state].filter(Boolean).join(', ');
    return { primary: entry.rider || '', secondary: locale, tertiary: entry.horse || '', isEq: true };
  }
  return { primary: entry.horse || '', secondary: entry.rider || '', tertiary: '', isEq: false };
};

// Render an entry name block as HTML (rider-first for equitation, horse-first otherwise).
// Includes bib number and optional flag. Reusable across live/results/display pages.
WEST.jumper.renderEntryName = function(entry, scoringMethod, opts) {
  opts = opts || {};
  var esc = WEST.esc;
  var p = WEST.jumper.entryNameParts(entry, scoringMethod);
  var flag = opts.flag || '';
  var bib = opts.showBib !== false ? '<span class="r-bib">' + esc(entry.entryNum || entry.entry_num || '') + '</span>' : '';
  var html = '<div class="r-info"><div class="r-horse-rider">'
    + bib
    + '<span class="r-horse">' + esc(p.primary) + (flag && !p.isEq ? ' ' + flag : '') + '</span>'
    + '<span class="r-rider-inline">' + esc(p.secondary) + (flag && p.isEq ? ' ' + flag : '') + '</span>'
    + '</div>';
  if (p.tertiary) html += '<div class="r-owner">' + esc(p.tertiary) + '</div>';
  html += '</div>';
  return html;
};

// Convenience wrapper that pulls status codes off the entry directly so
// callers don't have to thread four arguments. Returns the same shape as
// WEST.jumper.getStatusDisplay (or null when no status). Use this from
// outer row code that needs to decide whether to hide the place column.
WEST.jumper.getEntryStatus = function(entry, scoringMethod) {
  if (!entry || !WEST.jumper.getStatusDisplay) return null;
  return WEST.jumper.getStatusDisplay(
    scoringMethod,
    entry.r1StatusCode || entry.r1TextStatus || '',
    entry.r2StatusCode || entry.r2TextStatus || '',
    entry.r3StatusCode || entry.r3TextStatus || ''
  );
};

// ── SHARED OOG / CLASS STATE HELPERS ────────────────────────────────────────
// Centralized logic for "is this entry currently on course" and "is this
// class complete." Used by all pages (live, display, stats, results) to
// keep OOG rendering and on-course highlighting consistent.

// Standardized phase labels — used by on-course banners on all pages.
// Source of truth: one place, consistent across live/display/stats.
// ── ADAPTIVE POLL INTERVAL ───────────────────────────────────────────────────
// Returns milliseconds to wait before the next poll. Considers:
//   1. Whether a class is active (fast) vs idle (slow)
//   2. navigator.connection.effectiveType — slow-2g/2g → dial back to save
//      battery/data in weak service areas at horse shows
//
// baseActive / baseIdle override the defaults when a page needs different
// cadence (e.g. stats page polls results slower than the live strip).
WEST.getPollInterval = function(active, baseActive, baseIdle) {
  var fastMs = baseActive || 1000;
  var idleMs = baseIdle || 10000;
  // Connection-aware backoff for weak mobile signal
  try {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.effectiveType) {
      var t = conn.effectiveType;
      if (t === 'slow-2g' || t === '2g') {
        fastMs = Math.max(fastMs, 5000);
        idleMs = Math.max(idleMs, 30000);
      } else if (t === '3g') {
        fastMs = Math.max(fastMs, 3000);
        idleMs = Math.max(idleMs, 15000);
      }
    }
    // Honor Save-Data hint if user has it set
    if (conn && conn.saveData) {
      fastMs = Math.max(fastMs, 3000);
      idleMs = Math.max(idleMs, 15000);
    }
  } catch(e) {}
  return active ? fastMs : idleMs;
};

WEST.phaseLabel = function(phase) {
  var p = String(phase || '').toUpperCase();
  if (p === 'INTRO') return 'Intro';
  if (p === 'CD') return 'Countdown';
  if (p === 'FINISH') return 'Finished';
  if (p === 'ONCOURSE' || p === 'RIDE_START') return 'On Course';
  return 'On Course'; // default for unknown phases
};

// Returns true ONLY when the given entry is actively on course.
// A FINISH phase means the entry is done — not "on course" anymore.
// This fixes the stats-page bug where a finished entry was still tagged "OC".
WEST.isOnCourse = function(oc, entryNum) {
  if (!oc || !entryNum) return false;
  if (oc.phase === 'FINISH') return false;
  return String(oc.entry) === String(entryNum);
};

// Returns true when a class should be considered complete.
// Class is complete if:
//   1. It's in recentClasses (CLASS_COMPLETE event fired), OR
//   2. It's not in activeClasses AND not the selected class AND has results
WEST.isClassComplete = function(liveData, classNum, hasResults) {
  if (!liveData) return false;
  if (liveData.recentClasses && liveData.recentClasses.some(function(r) {
    return String(r.classNum) === String(classNum);
  })) return true;
  var isActive = liveData.activeClasses && liveData.activeClasses.some(function(a) {
    return String(a.classNum) === String(classNum);
  });
  var isSelected = liveData.selected && String(liveData.selected.classNum) === String(classNum);
  if (!isActive && !isSelected && hasResults) return true;
  return false;
};

// ── SHARED CLASS SPECS RENDERER ──────────────────────────────────────────────
// Returns a short string of class specs suitable for display next to the
// class name — method label, all TAs (method-aware), sponsor.
// Used by on-course banner (live, display, stats) and results page.
//
// Example outputs:
//   "Jumper II.2c  |  PH1=30s, PH2=31s  |  Sponsor: Acme"
//   "Two-Phase  |  PH1=30s, PH2=31s"
//   "Jumper II.1  |  TA=30s"
//   "Jumper (3 rounds)  |  R1=30s, R2=40s, JO=60s"
//
// classData is the per-class object from liveData.classData[classNum].
// Returns '' if no class data.

// Get the short type label for a class (uses methods table, falls back to classType).
// e.g. "Jumper II.2c", "Hunter", "Faults Converted"
WEST.getTypeLabel = function(classData) {
  if (!classData) return '';
  var sm = String(classData.scoringMethod || classData.scoring_method || '');
  var ct = (classData.classType || classData.class_type || '').toUpperCase();
  var method = WEST.jumper.methods[sm];
  if (method) return method.label;
  if (sm === '0') return 'Faults Converted';
  if (ct === 'J' || ct === 'T') return 'Jumper';
  if (ct === 'H') return 'Hunter';
  return ct;
};

// Get the formatted TA string for a class, method-aware.
// e.g. "PH1=30s, PH2=31s", "R1=30s, JO=60s", "TA=30s", "R1=30s, R2=40s, JO=60s"
WEST.getTAString = function(classData) {
  if (!classData) return '';
  var sm = String(classData.scoringMethod || classData.scoring_method || '');
  var method = WEST.jumper.methods[sm];
  // Accept both shapes: parseCls (r1TimeAllowed) or precomputed (ta.r1)
  var ta = classData.ta || classData._computed && classData._computed.ta;
  var r1 = ta ? parseFloat(ta.r1) || 0 : (parseFloat(classData.r1TimeAllowed || classData.timeAllowed1 || 0) || 0);
  var r2 = ta ? parseFloat(ta.r2) || 0 : (parseFloat(classData.r2TimeAllowed || classData.timeAllowed2 || 0) || 0);
  var r3 = ta ? parseFloat(ta.r3) || 0 : (parseFloat(classData.r3TimeAllowed || classData.timeAllowed3 || 0) || 0);
  var s = '';
  if (method) {
    if (method.rounds === 1) {
      if (r1 > 0) s = 'TA=' + r1 + 's';
    } else if (method.isTwoPhase) {
      if (r1 > 0) s = 'PH1=' + r1 + 's';
      if (r2 > 0) s += (s ? ', ' : '') + 'PH2=' + r2 + 's';
    } else if (method.rounds === 3) {
      if (r1 > 0) s = 'R1=' + r1 + 's';
      if (r2 > 0) s += (s ? ', ' : '') + 'R2=' + r2 + 's';
      if (r3 > 0) s += (s ? ', ' : '') + 'JO=' + r3 + 's';
    } else {
      if (r1 > 0) s = 'R1=' + r1 + 's';
      if (r2 > 0) s += (s ? ', ' : '') + 'JO=' + r2 + 's';
    }
  } else if (r1 > 0) {
    s = 'TA=' + r1 + 's';
  }
  return s;
};

WEST.renderClassSpecs = function(classData) {
  if (!classData) return '';
  var esc = WEST.esc;
  var typeLabel = WEST.getTypeLabel(classData);
  var taStr = WEST.getTAString(classData);

  var sponsor = (classData.sponsor || '').trim();
  var trophy = (classData.trophy || '').trim();

  var parts = [];
  if (typeLabel) parts.push('<span class="wcs-type">' + esc(typeLabel) + '</span>');
  if (taStr) parts.push('<span class="wcs-ta">' + esc(taStr) + '</span>');
  if (sponsor) parts.push('<span class="wcs-sponsor">Sponsor: ' + esc(sponsor) + '</span>');
  if (trophy) parts.push('<span class="wcs-trophy">' + esc(trophy) + '</span>');

  return parts.length ? '<div class="wcs-bar">' + parts.join('<span class="wcs-sep"> | </span>') + '</div>' : '';
};

// ── SHARED ON-COURSE RENDERER ────────────────────────────────────────────────
// Single source of truth for the on-course banner/card across all pages.
// All equitation rules, phase handling, fault display, entry name logic,
// and clock rendering live HERE — not scattered across HTML files.
//
// Usage:  var html = WEST.renderOnCourse(oc, classData, opts);
//         container.innerHTML = html;
//
// The function uses `woc-*` CSS classes. Each page defines its own CSS for
// these classes to control theme (light/dark) and layout (grid/strip/card).
// Element IDs are standardized: woc-clock, woc-jf, woc-tf, woc-total.
// Each page's tickClock() references these IDs to update in real-time.
//
// opts:
//   scale:       number (default 1, display page uses 0.75 for previous entry)
//   showTA:      boolean (default true)
//   isPrevious:  boolean (dims the card)
//   compact:     boolean (stats strip mode — no card wrapper)

WEST.renderOnCourse = function(oc, classData, opts) {
  if (!oc || (!oc.horse && !oc.rider && !oc.entry)) return '';
  opts = opts || {};
  var esc = WEST.esc;
  var fmtTime = function(t) { return WEST.formatTime ? WEST.formatTime(t, 2) : t; };

  // ── Scoring method + equitation detection ──
  var sm = classData ? String(classData.scoringMethod || '') : '';
  var isEq = sm === '7';
  var isOpt = sm === '6';

  // ── Phase ──
  var phase = (oc.phase || 'ONCOURSE').toUpperCase();
  var phaseLabel = WEST.phaseLabel(phase);

  // ── Entry name (equitation-aware) ──
  var primary, secondary, tertiary;
  if (isEq) {
    primary = oc.rider || '';
    secondary = [oc.city, oc.state].filter(Boolean).join(', ');
    tertiary = oc.horse || '';
  } else {
    primary = oc.horse || '';
    secondary = oc.rider || '';
    tertiary = '';
  }

  // ── Round label (long form for the banner: "Round 1", "Phase 1", "Jump Off") ──
  var roundLabel = oc.label || '';
  if (!roundLabel && oc.round && WEST.jumper && WEST.jumper.roundLabelLong) {
    roundLabel = WEST.jumper.roundLabelLong(sm, oc.round);
  }

  // ── Clock ──
  var elapsed = parseFloat(oc.elapsed) || 0;
  var clockVal, clockClass = '';
  var ta = parseFloat(oc.ta) || 0;
  var now = Date.now();
  var ts = new Date(oc.ts).getTime() || now;

  if (phase === 'INTRO') {
    clockVal = '45';
    clockClass = 'woc-countdown';
  } else if (phase === 'CD') {
    var cdVal = Math.abs(parseInt(oc.countdown) || 45);
    var cdElapsed = Math.floor((now - ts) / 1000);
    clockVal = String(Math.max(0, cdVal - cdElapsed));
    clockClass = 'woc-countdown';
  } else if (phase === 'FINISH') {
    // Equitation score — show "90 pts" instead of clock time
    if (isEq && oc.eqScore) {
      clockVal = parseFloat(oc.eqScore) + ' pts';
      clockClass = 'woc-score';
    } else {
      var elVal = oc.elapsed || '';
      if (elVal && isNaN(parseFloat(elVal))) {
        clockVal = WEST.statusDisplayLabel ? WEST.statusDisplayLabel(elVal) : elVal;
        clockClass = 'woc-status';
      } else {
        clockVal = elVal ? fmtTime(elVal) : String(Math.floor(elapsed));
      }
    }
  } else {
    // ONCOURSE — ticking
    var ocElapsed = oc.paused ? elapsed : elapsed + Math.floor((now - ts) / 1000);
    clockVal = String(Math.max(0, Math.floor(ocElapsed)));
    if (ta > 0 && ocElapsed > ta) clockClass = 'woc-overtime';
  }

  // ── Faults ──
  var jf = parseFloat(oc.jumpFaults) || 0;
  var fpi = parseFloat(oc.fpi) || 1;
  var ti  = parseFloat(oc.ti) || 1;
  var secsOver = 0;
  if (phase === 'ONCOURSE' && ta > 0) {
    var rtElapsed = oc.paused ? elapsed : elapsed + Math.floor((now - ts) / 1000);
    secsOver = Math.max(0, rtElapsed - ta);
  }
  var tf = secsOver > 0 ? Math.ceil(secsOver / ti) * fpi : (parseFloat(oc.timeFaults) || 0);
  var totalF = jf + tf;

  // ── Rank ──
  var rank = oc.rank ? String(oc.rank).replace(/^RANK\s*/i, '').trim() : '';
  var showRank = phase === 'FINISH' && rank && !/^EL$/i.test(rank) && !/^NP$/i.test(rank);

  // ── TA string ──
  var taStr = ta > 0 ? 'TA ' + oc.ta + 's' : '';

  // ── Optimum time (method 6) ──
  var optStr = '';
  var optDistHtml = '';
  if (isOpt && ta > 0) {
    var optTime = ta - 4;
    optStr = 'Optimum ' + optTime + 's';
    if (phase === 'ONCOURSE') {
      var ocNow = oc.paused ? elapsed : elapsed + Math.floor((now - ts) / 1000);
      var dist = ocNow - optTime;
      var sign = dist >= 0 ? '+' : '';
      optDistHtml = '<div class="woc-opt-dist" id="woc-opt-dist">' + sign + Math.floor(dist) + 's from opt</div>';
    }
  }

  // ── Build HTML — two sections for layout flexibility ──
  // woc-info: entry identity (name, locale, entry number)
  // woc-data: clock, faults, rank, TA — the live/changing stuff
  // Pages wrap these in their own grid/stack/strip container.

  var info = '<div class="woc-info">';
  info += '<div class="woc-entry">#' + esc(oc.entry || '') + '</div>';
  info += '<div class="woc-primary">' + esc(primary) + '</div>';
  if (secondary) info += '<div class="woc-secondary">' + esc(secondary) + '</div>';
  if (tertiary) info += '<div class="woc-tertiary">' + esc(tertiary) + '</div>';
  info += '</div>';

  var data = '<div class="woc-data">';
  if (roundLabel) data += '<div class="woc-round">' + esc(roundLabel) + '</div>';
  data += '<div class="woc-clock ' + clockClass + '" id="woc-clock">' + clockVal + '</div>';
  data += '<div id="woc-stale" class="woc-stale"></div>';
  data += '<div class="woc-phase-label">' + esc(phaseLabel) + '</div>';

  // Faults
  if (phase === 'ONCOURSE' || phase === 'FINISH') {
    data += '<div class="woc-faults">';
    if (isEq) {
      data += '<div class="woc-fault"><span class="woc-fault-lbl">Time Faults</span><span class="woc-fault-val" id="woc-tf">' + tf + '</span></div>';
    } else {
      data += '<div class="woc-fault"><span class="woc-fault-lbl">Jump</span><span class="woc-fault-val" id="woc-jf">' + jf + '</span></div>';
      data += '<div class="woc-fault"><span class="woc-fault-lbl">Time</span><span class="woc-fault-val" id="woc-tf">' + tf + '</span></div>';
      data += '<div class="woc-fault"><span class="woc-fault-lbl">Total</span><span class="woc-fault-val" id="woc-total">' + totalF + '</span></div>';
    }
    data += '</div>';
  }

  if (showRank) data += '<div class="woc-rank">RANK ' + esc(rank) + '</div>';
  if (taStr && opts.showTA !== false) data += '<div class="woc-ta">' + taStr + '</div>';
  if (optStr) data += '<div class="woc-ta woc-opt">' + optStr + '</div>';
  if (optDistHtml) data += optDistHtml;
  data += '</div>';

  return info + data;
};

// Shared tickClock for on-course — call from setInterval(WEST.tickOnCourse, 1000).
// Updates woc-clock, woc-tf, woc-total, woc-opt-dist by standard IDs.
// Pages store clock state in WEST._ocState (set by renderOnCourse call).
WEST._ocState = null;

WEST.setOcState = function(oc, classData) {
  if (!oc) { WEST._ocState = null; return; }
  var sm = classData ? String(classData.scoringMethod || '') : '';
  var ta = parseFloat(oc.ta) || 0;
  // Use browser time when data CONTENT changes (elapsed/phase/entry differ from
  // last state). Eliminates clock-skew between watcher PC and viewer's device.
  var prev = WEST._ocState;
  var dataChanged = !prev
    || prev.elapsed !== (parseFloat(oc.elapsed) || 0)
    || prev.phase !== (oc.phase || 'ONCOURSE').toUpperCase()
    || prev._entry !== oc.entry;
  WEST._ocState = {
    phase: (oc.phase || 'ONCOURSE').toUpperCase(),
    elapsed: parseFloat(oc.elapsed) || 0,
    ts: dataChanged ? Date.now() : (prev ? prev.ts : Date.now()),
    _entry: oc.entry,
    paused: !!oc.paused,
    ta: ta,
    fpi: parseFloat(oc.fpi) || 1,
    ti: parseFloat(oc.ti) || 1,
    jf: parseFloat(oc.jumpFaults) || 0,
    countdown: Math.abs(parseInt(oc.countdown) || 45),
    isEq: sm === '7',
    isOpt: sm === '6',
    optTime: (sm === '6' && ta > 0) ? ta - 4 : 0,
  };
};

WEST.tickOnCourse = function() {
  var s = WEST._ocState;
  if (!s) return;
  var el = document.getElementById('woc-clock');
  if (!el) return;
  var now = Date.now();
  var diff = (now - s.ts) / 1000;

  if (s.phase === 'INTRO') {
    el.textContent = '45';
    return;
  }
  if (s.phase === 'CD') {
    var remaining = Math.max(0, s.countdown - Math.floor(diff));
    el.textContent = String(remaining);
    return;
  }
  if (s.phase === 'FINISH') return; // frozen

  // ONCOURSE — tick up
  var display = s.paused ? s.elapsed : Math.max(0, Math.floor(s.elapsed + diff));
  if (display > 300) { el.textContent = '--'; return; }
  el.textContent = String(display);
  el.className = 'woc-clock' + (s.ta > 0 && display > s.ta ? ' woc-overtime' : '');

  // Update time faults
  var tfEl = document.getElementById('woc-tf');
  if (tfEl && s.ta > 0) {
    var secsOver = Math.max(0, display - s.ta);
    var tf = secsOver > 0 ? Math.ceil(secsOver / s.ti) * s.fpi : 0;
    tfEl.textContent = String(tf);
    var totEl = document.getElementById('woc-total');
    if (totEl) totEl.textContent = String(s.jf + tf);
  }

  // Staleness badge — shows how old the data is so viewers know if their
  // connection is lagging. Updates the woc-stale element if it exists.
  var staleEl = document.getElementById('woc-stale');
  if (staleEl) {
    var ageSec = Math.floor(diff);
    if (ageSec < 5)       { staleEl.textContent = 'live'; staleEl.className = 'woc-stale'; }
    else if (ageSec < 30) { staleEl.textContent = ageSec + 's'; staleEl.className = 'woc-stale woc-stale-warn'; }
    else if (ageSec < 90) { staleEl.textContent = ageSec + 's'; staleEl.className = 'woc-stale woc-stale-warn'; }
    else                  { staleEl.textContent = 'signal lost'; staleEl.className = 'woc-stale woc-stale-lost'; }
  }

  // Optimum distance
  if (s.isOpt && s.optTime > 0) {
    var optEl = document.getElementById('woc-opt-dist');
    if (optEl) {
      var dist = display - s.optTime;
      var sign = dist >= 0 ? '+' : '';
      optEl.textContent = sign + Math.floor(dist) + 's from opt';
    }
  }
};

// ── HEARTBEAT CLOCK FALLBACK ─────────────────────────────────────────────────
// When the primary onCourse data is stale (watcher's ONCOURSE POSTs lost on
// bad internet), the heartbeat's clock snapshot can provide a lower-resolution
// but recent correction. Called by the page's poll handler when it detects
// the heartbeat clock is fresher than the onCourse state.
WEST.applyHeartbeatClock = function(hbClock, hbTs) {
  if (!hbClock || !hbTs) return;
  var s = WEST._ocState;
  var hbTime = new Date(hbTs).getTime();
  if (!hbTime || isNaN(hbTime)) return;
  // Apply heartbeat when current state is stale (>15s old by browser clock).
  // Can't compare watcher timestamps vs worker timestamps directly — different
  // clocks with potential skew. Instead, trust the heartbeat if our local view
  // is old enough that a correction would help.
  if (s && (Date.now() - s.ts) < 15000) return;
  var phase = (hbClock.phase || 'ONCOURSE').toUpperCase();
  WEST._ocState = {
    phase:     phase,
    elapsed:   parseFloat(hbClock.elapsed) || 0,
    ts:        hbTime,
    paused:    phase === 'FINISH',
    ta:        parseFloat(hbClock.ta) || (s ? s.ta : 0),
    fpi:       s ? s.fpi : 1,
    ti:        s ? s.ti : 1,
    jf:        parseFloat(hbClock.jumpFaults) || 0,
    countdown: s ? s.countdown : 45,
    isEq:      s ? s.isEq : false,
    isOpt:     s ? s.isOpt : false,
    optTime:   s ? s.optTime : 0,
  };
};

// ── UNIVERSAL JUMPER STANDINGS ROW (rounds block) ────────────────────────────
// Single source of truth for jumper rounds rendering. All pages call this so
// the same rules apply everywhere — status display ("R2 RT" with R1 still
// visible), method-specific layouts (faults converted shows jf+final time,
// optimum shows time + distance, two-phase shows PH1+PH2 stacked, etc.).
//
// Returns the ROUNDS PORTION of a standings row only. The caller wraps it in
// their own outer row with the place column + entry info column. This keeps
// each page's outer layout flexible while sharing the inner per-round logic.
//
// Entry shape — accepts both raw watcher fields and computed entries:
//   r1Total, r2Total, r3Total
//   r1TotalTime, r2TotalTime, r3TotalTime
//   r1TotalFaults / r1JumpFaults / r1TimeFaults, r2*, r3*
//   r1StatusCode, r2StatusCode, r3StatusCode  (or *TextStatus / statusCode fallback)
//
// scoringMethod: H[02] from .cls (string '0'..'15'), determines layout
//
// opts:
//   { clockPrecision: 0|1|2, optimumTime: number, includeRoundLabel: bool }
//
// Output is class-based HTML using the `jp-*` namespace:
//   <div class="jp-rounds">
//     <div class="jp-row">
//       <span class="jp-lbl">PH2</span>
//       <span class="jp-faults">0 flt</span>
//       <span class="jp-time">21.59</span>
//     </div>
//     ...
//   </div>
//
// Each page adds its own CSS rules for the jp-* classes (light/dark theme,
// font sizes, alignment) — see display.html, live.html, results.html.
WEST.jumper.renderRoundsBlock = function(entry, scoringMethod, opts) {
  opts = opts || {};
  var esc = WEST.esc;
  var clockPrec = opts.clockPrecision != null ? opts.clockPrecision : 2;
  var optimumTime = opts.optimumTime || 0;
  var fmtTime = function(t) { return WEST.formatTime(t, clockPrec); };

  var method = WEST.jumper.getMethod(scoringMethod);
  var isFaultsConverted = String(scoringMethod) === '0';
  var isOptimum = method.isOptimum;
  var isEquitation = String(scoringMethod) === '7';

  // Equitation (method 7): after pinned, show score as "X pts", hide time/faults.
  // Equitation score lives in r1JumpFaults (col[19]) — Ryegate repurposes the
  // jump faults field for the judge's score. Placement shown by the outer row.
  if (isEquitation && entry.place && parseInt(entry.place) > 0) {
    var eqScore = parseFloat(entry.r1JumpFaults || 0);
    if (eqScore > 0) {
      return '<div class="jp-rounds"><span class="jp-eq-score">' + eqScore + ' pts</span></div>';
    }
    return ''; // pinned but no score entered — just show placement
  }

  // Centralized status display rules — handles "R1 EL hides everything",
  // "R2 RT keeps R1 visible", "JO RT keeps R1+R2", method-specific carry-back
  // rules, etc. Returns null when no status is present.
  var sd = WEST.jumper.getStatusDisplay
    ? WEST.jumper.getStatusDisplay(
        scoringMethod,
        entry.r1StatusCode || entry.r1TextStatus || '',
        entry.r2StatusCode || entry.r2TextStatus || '',
        entry.r3StatusCode || entry.r3TextStatus || ''
      )
    : null;

  // Full elimination — sd says hide every round. Single status badge.
  if (sd && !sd.showR1 && !sd.showR2 && !sd.showR3) {
    return '<div class="jp-rounds"><span class="jp-status">' + esc(sd.label) + '</span></div>';
  }

  var html = '<div class="jp-rounds">';

  // Faults Converted (Table III): single row, jump faults + final time only.
  // r1TotalTime is the converted time (clock + jumpFaults + penaltySeconds)
  // computed by the worker (or watcher). No round label, no separate flt.
  if (isFaultsConverted) {
    var jf = parseFloat(entry.r1JumpFaults || 0);
    var t1 = entry.r1TotalTime || '';
    if (t1 || jf) {
      html += '<div class="jp-row jp-converted">'
        + '<span class="jp-faults">' + jf + ' jf</span>'
        + '<span class="jp-time">' + esc(fmtTime(t1)) + '</span>'
        + '</div>';
    }
    html += '</div>';
    return html;
  }

  // Build rounds list, highest first (JO/R3 → R2 → R1).
  // Round shows up if there's a total time OR a status code (so a WD/RT with
  // no time still renders as a status-only row via sd.showRn rules below).
  var rounds = [];
  var r3Sc = (entry.r3StatusCode || entry.r3TextStatus || '');
  var r2Sc = (entry.r2StatusCode || entry.r2TextStatus || '');
  if (entry.r3TotalTime || r3Sc) {
    rounds.push({ r: 3, faults: entry.r3TotalFaults, time: entry.r3TotalTime, jf: entry.r3JumpFaults });
  }
  if (entry.r2TotalTime || r2Sc) {
    rounds.push({ r: 2, faults: entry.r2TotalFaults, time: entry.r2TotalTime, jf: entry.r2JumpFaults });
  }
  if (entry.r1TotalTime) {
    rounds.push({ r: 1, faults: entry.r1TotalFaults, time: entry.r1TotalTime, jf: entry.r1JumpFaults });
  }

  // Also surface status-only rows for rounds the operator failed but where
  // earlier rounds completed (so the user sees "PH2 RF" rather than nothing).
  // Status rows are rendered IN PLACE of the score row when sd.showRn is false.
  rounds.forEach(function(rd) {
    var lbl = WEST.jumper.roundLabel(scoringMethod, rd.r);
    var roundShown = !sd || sd['showR' + rd.r];

    if (!roundShown && sd) {
      // Status replaces this round's score
      html += '<div class="jp-row jp-row-status">'
        + '<span class="jp-lbl">' + esc(lbl) + '</span>'
        + '<span class="jp-status">' + esc(sd.label) + '</span>'
        + '</div>';
    } else {
      var faults = parseFloat(rd.faults || 0);
      var isClean = faults === 0;
      html += '<div class="jp-row">'
        + '<span class="jp-lbl">' + esc(lbl) + '</span>';
      // Equitation: hide jump faults (always 0, irrelevant to viewers)
      if (!isEquitation) {
        html += '<span class="jp-faults' + (isClean ? ' clean' : '') + '">' + faults + ' flt</span>';
      }
      html += '<span class="jp-time">' + esc(fmtTime(rd.time)) + '</span>'
        + '</div>';
    }

    // Optimum distance under R1 (Method 6)
    if (isOptimum && optimumTime > 0 && rd.time && rd.r === 1) {
      var tNum = parseFloat(rd.time);
      if (!isNaN(tNum)) {
        var dist = tNum - optimumTime;
        var sign = dist >= 0 ? '+' : '';
        var closeClass = Math.abs(dist) < 1 ? ' jp-opt-close' : '';
        html += '<div class="jp-row jp-row-opt' + closeClass + '">'
          + '<span class="jp-lbl">OPT</span>'
          + '<span class="jp-time">' + sign + dist.toFixed(3) + 's</span>'
          + '</div>';
      }
    }
  });

  html += '</div>';
  return html;
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


// ── HUNTER ELIMINATION DISPLAY TABLE ─────────────────────────────────────────
// Simpler than jumper — ONE rule for ALL hunter scoring methods (0,1,2,3):
// Earlier rounds ALWAYS hold. No carry-back. No exceptions.
//
//   R1 status → no place, no score, show code
//   R2 status → place on R1, show R1, hide R2, show code
//   R3 status → place on R1+R2, show R1+R2, hide R3, show code

WEST.hunter = WEST.hunter || {};

WEST.hunter.getStatusDisplay = function(r1Status, r2Status, r3Status) {
  var r1 = (r1Status || '').toUpperCase();
  var r2 = (r2Status || '').toUpperCase();
  var r3 = (r3Status || '').toUpperCase();
  var has1 = WEST.isAnyStatus(r1);
  var has2 = WEST.isAnyStatus(r2);
  var has3 = WEST.isAnyStatus(r3);
  if (!has1 && !has2 && !has3) return null;

  if (has1) {
    return { showPlace: false, showR1: false, showR2: false, showR3: false, label: WEST.statusDisplayLabel(r1) };
  }
  if (has2) {
    return { showPlace: true, showR1: true, showR2: false, showR3: false, label: WEST.statusDisplayLabel(r2) };
  }
  if (has3) {
    return { showPlace: true, showR1: true, showR2: true, showR3: false, label: WEST.statusDisplayLabel(r3) };
  }
  return null;
};


/* ═══════════════════════════════════════════════════════════════════════════
   HUNTER — class_type H
   ═══════════════════════════════════════════════════════════════════════════ */

WEST.hunter = WEST.hunter || {};

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
// Hunter header column meanings (CONFIRMED 2026-04-06):
//   H[2]  ClassMode:   0=Over Fences, 1=Flat, 2=Derby, 3=Special
//   H[5]  ScoringType: 0=Forced, 1=Scored, 2=Hi-Lo
//   H[7]  NumJudges:   1-5+
//   H[10] IsEquitation
//   H[11] IsChampionship
//   H[37] DerbyType (only when H[2]=2)
WEST.hunter.getClassLabel = function(classInfo) {
  if (!classInfo) return 'Hunter';
  if (classInfo._computed && classInfo._computed.label) return classInfo._computed.label;
  var raw = classInfo.cls_raw || classInfo.clsRaw || '';
  var h = WEST.parseClsHeader(raw);
  var classMode = h[2] || '0';
  if (classMode === '2') {
    var derby = WEST.hunter.getDerby(h[37] || '0');
    return derby ? derby.label : 'Hunter Derby';
  }
  if (classMode === '3') return 'Hunter Special';
  if (classMode === '1') return 'Hunter Flat';
  if (h[10] === 'True') return 'Equitation';
  if (h[11] === 'True') return 'Hunter Championship';
  return 'Hunter';
};

// ── IS DERBY ─────────────────────────────────────────────────────────────────
// Accepts D1 naming, watcher KV naming, and pre-computed _computed objects.
WEST.hunter.isDerby = function(classInfo) {
  if (!classInfo) return false;
  if (classInfo._computed) return !!classInfo._computed.isDerby;
  var ct = classInfo.class_type || classInfo.classType;
  if (ct !== 'H') return false;
  var raw = classInfo.cls_raw || classInfo.clsRaw || '';
  var h = WEST.parseClsHeader(raw);
  return h[2] === '2';
};

// ── IS EQUITATION ────────────────────────────────────────────────────────────
// Accepts D1 naming, watcher KV naming, and pre-computed _computed objects.
WEST.hunter.isEquitation = function(classInfo) {
  if (!classInfo) return false;
  if (classInfo._computed) return !!classInfo._computed.isEquitation;
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

// Judge count — for derbies use H[37] derby type table, for all others use H[7] directly
// CONFIRMED 2026-04-06: H[7] = NumJudges for all hunter classes
WEST.hunter.derby.getJudgeCount = function(classInfo) {
  if (classInfo && classInfo._computed) return classInfo._computed.judgeCount || 1;
  var raw = classInfo ? (classInfo.cls_raw || classInfo.clsRaw || '') : '';
  if (!raw) return 1;
  var h = WEST.parseClsHeader(raw);
  // Derby: judge count comes from the derby type table
  if (h[2] === '2') {
    var type = WEST.hunter.derbyTypes[String(h[37] || '0')];
    return type ? type.judges : 1;
  }
  // All other hunter classes: H[7] is the judge count directly
  var n = parseInt(h[7]) || 1;
  return n > 0 ? n : 1;
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

// Did this entry compete R1 / R2 / R3?
WEST.hunter.derby.hasR1 = function(e) {
  if (e.r1TextStatus) return false;
  return !!(e.r1 && e.r1.some(function(p) { return p.phaseTotal > 0; }));
};
WEST.hunter.derby.hasR2 = function(e) {
  if (e.r2TextStatus) return false;
  return !!(e.r2 && e.r2.some(function(p) { return p.phaseTotal > 0; }));
};
WEST.hunter.derby.hasR3 = function(e) {
  if (e.r3TextStatus) return false;
  return !!(e.r3 && e.r3.some(function(p) { return p.phaseTotal > 0; }));
};

// Evidence check for "did this entry actually compete?" — Ryegate sometimes
// leaves the hasGone flag stuck even when no data was ever entered. An entry
// really competed if it has at least one real score OR a real status code
// (EL / RT / RF / etc.). Otherwise hide it from results entirely.
WEST.hunter.derby.hasEvidence = function(e) {
  if (!e) return false;
  if (WEST.hunter.derby.hasR1(e) || WEST.hunter.derby.hasR2(e) || WEST.hunter.derby.hasR3(e)) return true;
  // Any normalized or raw status code counts as evidence of a real outcome.
  if (e.r1StatusCode || e.r2StatusCode || e.r3StatusCode) return true;
  if (e.r1TextStatus || e.r2TextStatus || e.r3TextStatus) return true;
  if (e.statusCode) return true;
  // Numeric status > 0 also counts (RT sets numeric=3 with no text code).
  var rn = function(v) { var n = parseInt(v); return isNaN(n) ? 0 : n; };
  if (rn(e.r1NumericStatus) > 0 || rn(e.r2NumericStatus) > 0 || rn(e.r3NumericStatus) > 0) return true;
  return false;
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

// Render a phase card math string.
// Derby: ALWAYS show all components including zeros — "90 + 4 + 0 = 94"
// Non-derby: just the score — "5" (hiopt and bonus are always 0, don't display them)
// Render a phase card math string. Auto-detects format from the data:
// Derby phase cards have { base, hiopt, bonus } → show "base + hiopt [+ bonus] = total"
// Non-derby phase cards have { score } only → show just the score
// The Worker decides which shape to send — the renderer just reads what's there.
WEST.hunter.derby.renderPhaseMath = function(phase, roundNum) {
  if (phase.base !== undefined) {
    // Derby format — always show all components including zeros
    var parts = [String(phase.base), String(phase.hiopt)];
    if (roundNum === 2) parts.push(String(phase.bonus));
    return parts.join(' + ') + ' = ' + phase.phaseTotal;
  }
  // Non-derby — just the score
  return String(phase.phaseTotal);
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
        + '<span class="oc-breakdown-math">' + WEST.hunter.derby.renderPhaseMath(p, roundNum) + '</span>'
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

// Shim _jt fields onto a pre-computed entry from the Worker so the existing
// renderers (renderEntry, renderExpand, etc.) work without modification.
// Worker stores ranks at top level; renderers expect _jt.
WEST.hunter.derby._shimJt = function(entries, judgeCount) {
  entries.forEach(function(e) {
    if (e._jt) return; // already shimmed
    e._jt = {
      judgeCount:      judgeCount,
      r1Ranks:         e.r1Ranks || [],
      r2Ranks:         e.r2Ranks || [],
      r3Ranks:         e.r3Ranks || [],
      judgeCardTotals: e.judgeCardTotals || [],
      judgeCardRanks:  e.judgeCardRanks || [],
      r1OverallRank:   e.r1OverallRank || null,
      r2OverallRank:   e.r2OverallRank || null,
      r3OverallRank:   e.r3OverallRank || null,
      movement:        e.movement || null,
      combinedRank:    e.combinedRank || null,
    };
  });
  return entries;
};

// Render from pre-computed Worker results (no cls_raw parsing needed).
// Takes the computed object directly, shims _jt, fakes a classInfo for renderers.
WEST.hunter.derby.renderPrecomputed = function(computed, opts) {
  opts = opts || {};
  var entries = WEST.hunter.derby._shimJt(computed.entries || [], computed.judgeCount || 1);
  // Filter stuck-hasGone entries (no score, no status) — they haven't really
  // competed even though Ryegate marked them as gone.
  entries = entries.filter(WEST.hunter.derby.hasEvidence);
  var fakeClassInfo = {
    class_name: computed.className, className: computed.className,
    class_type: 'H', classType: 'H',
    cls_raw: '', clsRaw: '',
    show_flags: computed.showFlags, showFlags: computed.showFlags,
    _computed: computed,
  };
  var judgeCount = computed.judgeCount || 1;

  if (!entries.length) {
    return '<div class="results-wrap"><div class="no-results">No entries found for this class.</div></div>';
  }

  var html = '<div class="results-wrap">';
  if (judgeCount > 1 && computed.isSplitDecision) {
    html += WEST.hunter.derby.renderSummary(entries, judgeCount);
  }
  for (var i = 0; i < entries.length; i++) {
    html += WEST.hunter.derby.renderEntry(entries[i], fakeClassInfo, judgeCount, opts);
  }
  html += '</div>';
  return html;
};

WEST.hunter.derby.renderPrecomputedByJudge = function(computed, opts) {
  opts = opts || {};
  var entries = WEST.hunter.derby._shimJt(computed.entries || [], computed.judgeCount || 1);
  // Filter stuck-hasGone entries (no score, no status) — hide from by-judge view too.
  entries = entries.filter(WEST.hunter.derby.hasEvidence);
  var esc = WEST.esc;
  var judgeCount = computed.judgeCount || 1;
  if (!entries.length || judgeCount < 2) return '<div class="results-wrap"><div class="no-results">No entries found for this class.</div></div>';

  // Round metadata from the computed class object (worker emits these from
  // H[3] and H[25-27]). Fall back to 2-round / R1,R2 for legacy cache entries.
  var numRounds = computed.numRounds || 2;
  if (numRounds < 1) numRounds = 1;
  if (numRounds > 3) numRounds = 3;
  var roundLabels = computed.roundLabels || ['R1', 'R2', 'R3'];

  var isEq = computed.isEquitation;
  var showFlags = computed.showFlags;
  var className = computed.className || '';
  var html = '<div class="results-wrap by-judge-view">';

  for (var j = 0; j < judgeCount; j++) {
    (function(jj) {
      var sorted = entries.slice().sort(function(a, b) {
        var av = a._jt && a._jt.judgeCardTotals[jj];
        var bv = b._jt && b._jt.judgeCardTotals[jj];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av;
      });

      html += '<div class="judge-section"><div class="judge-section-hdr">Judge ' + (jj + 1) + '</div>';
      sorted.forEach(function(g) {
        // Centralized status rules — same as display.html sidebar judge cards
        // and the renderJudgeGrid path. R1 status = full elim (place hidden,
        // all rounds hidden). R2/R3 status = "earlier rounds always hold."
        var sd = WEST.hunter.getStatusDisplay
          ? WEST.hunter.getStatusDisplay(g.r1StatusCode || g.r1TextStatus || '', g.r2StatusCode || g.r2TextStatus || '', g.r3StatusCode || g.r3TextStatus || '')
          : null;
        var isElimFull = sd && !sd.showR1;
        var rank = g._jt ? g._jt.judgeCardRanks[jj] : null;
        var flag = showFlags ? WEST.countryFlag(g.country, true) : '';
        var placeText = isElimFull ? sd.label : (rank ? rank : '—');
        var ribbonSvg = (!opts.isLive && !isElimFull && rank) ? WEST.ribbon.placeRibbon(rank, className) : '';

        html += '<div class="result-entry"' + (isElimFull ? ' style="opacity:0.5;"' : '') + '><div class="result-main">';
        html += ribbonSvg ? '<div class="r-ribbon">' + ribbonSvg + '</div>' : '<div class="r-ribbon"><div class="r-place-txt">' + placeText + '</div></div>';
        if (isEq) {
          var locale = [g.city, g.state].filter(Boolean).join(', ');
          html += '<div class="r-info"><div class="r-horse-rider"><span class="r-bib">' + esc(g.entry_num) + '</span><span class="r-horse">' + esc(g.rider) + (flag ? ' ' + flag : '') + '</span>' + (locale ? '<span class="r-rider-inline">' + esc(locale) + '</span>' : '') + '</div>' + (g.horse ? '<div class="r-owner">' + esc(g.horse) + '</div>' : '') + '</div>';
        } else {
          html += '<div class="r-info"><div class="r-horse-rider"><span class="r-bib">' + esc(g.entry_num) + '</span><span class="r-horse">' + esc(g.horse) + '</span><span class="r-rider-inline">' + esc(g.rider) + (flag ? ' ' + flag : '') + '</span></div></div>';
        }
        html += '<div class="r-scores">';
        if (isElimFull) {
          html += '<span class="r-status">' + esc(sd.label) + '</span>';
        } else {
          // Loop rounds 1..numRounds. For each round: if status rules say
          // hide it (e.g. R2 RT), show the status label in the round row.
          // Otherwise show this judge's phase score.
          var phasesByRound = [g.r1, g.r2, g.r3];
          for (var r = 1; r <= numRounds; r++) {
            var idx = r - 1;
            var phases = phasesByRound[idx];
            var ph = phases && phases[jj];
            var roundShown = !sd || sd['showR' + r];
            var lbl = roundLabels[idx] || ('R' + r);
            if (!roundShown) {
              html += '<div class="r-score-row"><span class="r-score-lbl">' + esc(lbl) + '</span><span class="r-status">' + esc(sd.label) + '</span></div>';
            } else if (ph && (ph.score != null || ph.base != null || (ph.phaseTotal && ph.phaseTotal > 0))) {
              html += '<div class="r-score-row"><span class="r-score-lbl">' + esc(lbl) + '</span><span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(ph, r) + '</span></div>';
            }
          }
          var cardTotal = g._jt && g._jt.judgeCardTotals[jj];
          if (cardTotal != null) html += '<div class="r-total">' + cardTotal.toFixed(2) + '</div>';
        }
        html += '</div></div></div>';
      });
      html += '</div>';
    })(j);
  }
  html += '</div>';
  return html;
};

// ── JUDGES TABLE — universal multi-judge results renderer ────────────────────
// Returns HTML for the per-judge score grid for one entry.
// Works for derbies (base+hiopt+bonus) and non-derby scored (score only).
// All pages should use this for consistent multi-judge display.
//
// Grid shape (driven by class header — H[3]=numRounds, H[7]=numJudges):
//
//              J1      J2     ...    Jn      Round Total
//   R1         …       …             …       [r1Total]
//   R2         …       …             …       [r2Total]
//   R3         …       …             …       [r3Total]   (only if numRounds===3)
//              ───     ───           ───     ───
//   Tot        jc1     jc2           jcn     OVERALL
//
// entry: computed entry object with rN[], rNTotal, rNRanks, rNOverallRank,
//        combined, judgeCardTotals[], judgeCardRanks[]
// judgeCount: number of judges (from H[7])
// sd: result of WEST.hunter.getStatusDisplay() for this entry
// opts.isDerby: show hiopt+bonus columns in the column header
// opts.dark: dark theme (for display.html)
// opts.numRounds: 1, 2, or 3 — defaults to 2 for backward compat
// opts.roundLabels: ['R1','R2','R3'] override (from H[25]/H[26]/H[27] phase labels)
//
// Returns: { header: '...', row: '...', gridCols: '...' }

WEST.hunter.renderJudgeGrid = function(entry, judgeCount, sd, opts) {
  opts = opts || {};
  var esc = WEST.esc;
  var isDerby = opts.isDerby || false;
  var dark = opts.dark || false;
  var numRounds = opts.numRounds || 2;
  if (numRounds < 1) numRounds = 1;
  if (numRounds > 3) numRounds = 3;
  var roundLabels = opts.roundLabels || ['R1', 'R2', 'R3'];
  // Column width. Compact mode (for narrow containers like the display.html
  // on-course sidebar card, ~312px available) shrinks everything. Otherwise:
  // derby = 140 (room for "base+hiopt+bonus"), non-derby = 95 at 1-4 judges,
  // 55 at 5+ so the grid still fits the results/standings column.
  var compact = opts.compact || false;
  var colW, totalW, rndW;
  if (compact) {
    colW = isDerby ? 85 : (judgeCount >= 4 ? 40 : 60);
    totalW = 70;
    rndW = 22;
  } else {
    colW = isDerby ? 140 : (judgeCount >= 5 ? 55 : 95);
    totalW = 90;
    rndW = 28;
  }
  // Round label column must fit the longest label — "Gymnastics" is way wider
  // than "R1". Grow rndW for custom Special labels; default R1/R2/R3 stays small.
  if (opts.roundLabels) {
    var maxLabelChars = 2;
    for (var li = 0; li < opts.roundLabels.length; li++) {
      var lbl = opts.roundLabels[li];
      if (lbl && lbl.length > maxLabelChars) maxLabelChars = lbl.length;
    }
    var charW = compact ? 7 : 8; // approx px per char at row font size
    var needed = maxLabelChars * charW + 10;
    if (needed > rndW) rndW = needed;
  }

  // Dimension-aware column collapse:
  //  - judgeCount === 1 → drop the "Round Total" column (always == J1, redundant)
  //  - numRounds === 1  → drop the bottom totals row (R1 row IS the overall, redundant)
  // When BOTH apply (1 judge × 1 round) the grid collapses to a single cell.
  var showTotalCol = judgeCount > 1;
  var showTotalsRow = numRounds > 1;

  // Build grid columns: round label + per-judge + (optional) total
  var gridCols = rndW + 'px';
  for (var i = 0; i < judgeCount; i++) gridCols += ' ' + colW + 'px';
  if (showTotalCol) gridCols += ' ' + totalW + 'px';

  var muted = dark ? '#999' : 'var(--text-muted)';
  var dimmed = dark ? '#666' : '#999';
  var bright = dark ? 'var(--white,#f0f0f0)' : 'var(--black,#111)';
  var red = 'var(--red,#b82025)';
  var accent = dark ? 'var(--gold,#fbbf24)' : 'var(--black,#111)';

  // Column header
  var header = '<div style="display:grid;grid-template-columns:' + gridCols + ';gap:10px;text-align:right;font-family:DM Mono,monospace;font-size:10px;letter-spacing:.08em;color:' + muted + ';margin-left:auto;width:fit-content;">';
  header += '<span></span>';
  for (var jh = 0; jh < judgeCount; jh++) {
    header += '<span style="color:' + bright + ';text-decoration:underline;">J' + (jh + 1) + (isDerby ? ' + HiOpt + Bonus' : '') + '</span>';
  }
  if (showTotalCol) header += '<span style="color:' + bright + ';text-decoration:underline;">Round Total</span>';
  header += '</div>';

  // Round renderer
  function renderRound(lbl, rndData, rndRanks, rndTotal, rndRank, showRound) {
    var h = '<div style="display:grid;grid-template-columns:' + gridCols + ';gap:10px;align-items:baseline;margin-bottom:4px;font-family:DM Mono,monospace;font-size:14px;margin-left:auto;width:fit-content;">';
    h += '<span style="color:' + muted + ';font-size:12px;">' + lbl + '</span>';
    if (sd && !showRound) {
      for (var jx = 0; jx < judgeCount; jx++) h += '<span></span>';
      if (showTotalCol) h += '<span style="text-align:right;color:' + red + ';font-weight:600;">' + esc(sd.label) + '</span>';
    } else {
      for (var jj = 0; jj < judgeCount; jj++) {
        var ph = rndData && rndData[jj] ? rndData[jj] : {};
        var scoreStr = '';
        if (isDerby) {
          var parts = [];
          if (ph.base) parts.push(ph.base);
          if (ph.hiopt) parts.push('+' + ph.hiopt);
          if (ph.bonus) parts.push('+' + ph.bonus);
          scoreStr = parts.join('');
        } else {
          scoreStr = ph.score ? String(ph.score) : (ph.phaseTotal ? String(ph.phaseTotal) : '');
        }
        // Per-judge rank (N) — drop ONLY in the 1-judge × 1-round case
        // (single visible cell, overall place is shown in the ribbon).
        // For 1j×2r the per-judge rank is the round rank (meaningful).
        // For 2j×1r the per-judge rank shows judge agreement (meaningful).
        var collapseRanks = (judgeCount === 1 && numRounds === 1);
        var jRk = (!collapseRanks && rndRanks && rndRanks[jj]) ? rndRanks[jj] : '';
        // When the totals row is hidden (1-round class), promote the per-judge
        // cells to "bright" so the single visible row reads as the headline.
        var cellColor = showTotalsRow ? muted : bright;
        var cellWeight = showTotalsRow ? '' : 'font-weight:600;';
        h += '<span style="text-align:right;color:' + cellColor + ';' + cellWeight + '">' + esc(scoreStr) + (jRk ? ' <span style="color:' + dimmed + ';font-size:10px;">(' + jRk + ')</span>' : '') + '</span>';
      }
      if (showTotalCol) h += '<span style="text-align:right;color:' + bright + ';font-weight:600;">' + esc(rndTotal) + (rndRank ? ' <span style="color:' + dimmed + ';font-size:10px;">(' + rndRank + ')</span>' : '') + '</span>';
    }
    h += '</div>';
    return h;
  }

  // Build row HTML
  var e = entry;
  var row = '';
  var hCombined = e.combined || '';

  // "All hidden" = sd says hide every round in numRounds
  var allHidden = !!sd;
  if (sd) {
    for (var rh = 1; rh <= numRounds; rh++) {
      if (sd['showR' + rh]) { allHidden = false; break; }
    }
  } else {
    allHidden = false;
  }

  // 1 judge × 1 round — no grid needed, no labels, no header. Just the score
  // (or status). The overall place is already shown in the ribbon/place column
  // outside renderJudgeGrid, so the single value carries no rank either.
  var collapseSingle = (judgeCount === 1 && numRounds === 1);
  if (collapseSingle) {
    if (allHidden) {
      row = '<div style="font-family:DM Mono,monospace;font-size:24px;font-weight:700;color:' + red + ';text-align:right;margin-left:auto;width:fit-content;">' + esc(sd.label) + '</div>';
    } else {
      var phase = e.r1 && e.r1[0];
      var scoreStr = '';
      if (phase) {
        if (isDerby) {
          var parts = [];
          if (phase.base) parts.push(phase.base);
          if (phase.hiopt) parts.push('+' + phase.hiopt);
          if (phase.bonus) parts.push('+' + phase.bonus);
          scoreStr = parts.join('');
        } else {
          scoreStr = phase.score != null ? String(phase.score) : (phase.phaseTotal != null ? String(phase.phaseTotal) : '');
        }
      }
      if (!scoreStr) scoreStr = e.r1Total != null ? String(e.r1Total) : '';
      row = '<div style="font-family:DM Mono,monospace;font-size:24px;font-weight:700;color:' + accent + ';text-align:right;margin-left:auto;width:fit-content;">' + esc(scoreStr) + '</div>';
    }
    return { header: '', row: row, gridCols: '' };
  }

  if (allHidden) {
    // Fully eliminated — just show status in the totals position
    row += '<div style="display:grid;grid-template-columns:' + gridCols + ';gap:10px;align-items:baseline;font-family:DM Mono,monospace;margin-left:auto;width:fit-content;">';
    row += '<span></span>';
    for (var je = 0; je < judgeCount; je++) row += '<span></span>';
    if (showTotalCol) row += '<span style="text-align:right;color:' + red + ';font-weight:700;font-size:17px;">' + esc(sd.label) + '</span>';
    row += '</div>';
  } else {
    // Loop rounds 1..numRounds — header is the truth, render every row that exists
    for (var r = 1; r <= numRounds; r++) {
      var rTotal = e['r' + r + 'Total'] || '';
      var rData  = e['r' + r];
      var rRanks = e['r' + r + 'Ranks'];
      var rRank  = e['r' + r + 'OverallRank'] || '';
      var rShow  = sd ? !!sd['showR' + r] : true;
      var rLbl   = roundLabels[r - 1] || ('R' + r);
      // Render if entry has a total for this round OR status rules want to show the status here
      if (rTotal || (sd && !rShow)) {
        row += renderRound(rLbl, rData, rRanks, rTotal, rRank, rShow);
      }
    }

    // Divider + per-judge totals row (ending with OVERALL combined in the corner).
    // Skipped entirely when numRounds === 1 — the single round row IS the overall.
    if (showTotalsRow) {
      var borderColor = dark ? 'var(--border,#1e2940)' : 'var(--border,#e2e2e2)';
      row += '<div style="border-top:1px solid ' + borderColor + ';margin:5px 0;"></div>';
      row += '<div style="display:grid;grid-template-columns:' + gridCols + ';gap:10px;align-items:baseline;font-family:DM Mono,monospace;margin-left:auto;width:fit-content;">';
      row += '<span></span>';
      for (var jt = 0; jt < judgeCount; jt++) {
        var jCard = e.judgeCardTotals && e.judgeCardTotals[jt] ? e.judgeCardTotals[jt] : '';
        var jCardRank = e.judgeCardRanks && e.judgeCardRanks[jt] ? e.judgeCardRanks[jt] : '';
        if (jCard) {
          row += '<span style="text-align:right;color:' + bright + ';font-size:14px;font-weight:600;">J' + (jt + 1) + ' ' + esc(jCard) + (jCardRank ? ' <span style="color:' + dimmed + ';font-size:10px;">(' + jCardRank + ')</span>' : '') + '</span>';
        } else {
          row += '<span></span>';
        }
      }
      if (showTotalCol) row += '<span style="text-align:right;color:' + accent + ';font-weight:700;font-size:17px;">' + esc(hCombined) + '</span>';
      row += '</div>';
    }
  }

  return { header: header, row: row, gridCols: gridCols };
};

// Full list — returns complete '<div class="results-wrap">…</div>' HTML string
// Pages insert this via innerHTML and then bind their own toggleEntry handler.
// opts.isLive = true when class is currently being scored (suppresses ribbon graphics).
WEST.hunter.derby.renderList = function(classInfo, opts) {
  opts = opts || {};
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
    html += WEST.hunter.derby.renderEntry(entries[i], classInfo, judgeCount, opts);
  }
  html += '</div>';
  return html;
};

// BY-JUDGE VIEW — renders the class grouped by judge, each section sorted by
// that judge's card total desc. Used when the user toggles "View Judges Scores"
// on the results page. Multi-judge derbies only (1-judge is redundant with
// combined view and the button is suppressed).
WEST.hunter.derby.renderByJudgeList = function(classInfo, opts) {
  opts = opts || {};
  var esc = WEST.esc;
  var built = WEST.hunter.derby.buildEntries(classInfo);
  var entries = built.entries;
  var judgeCount = built.judgeCount;
  if (!entries.length || judgeCount < 2) return '<div class="results-wrap"><div class="no-results">No entries found for this class.</div></div>';

  var isEq = WEST.hunter.isEquitation(classInfo);
  var showFlags = WEST.hunter.derby._showFlags(classInfo);
  var className = classInfo && (classInfo.class_name || classInfo.className) || '';
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
        var ribbonSvg = (!opts.isLive && !r1Failed && rank) ? WEST.ribbon.placeRibbon(rank, className) : '';

        html += '<div class="result-entry"><div class="result-main">';
        if (ribbonSvg) {
          html += '<div class="r-ribbon">' + ribbonSvg + '</div>';
        } else {
          html += '<div class="r-ribbon"><div class="r-place-txt">' + placeText + '</div></div>';
        }

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
              + '<span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(p1, 1) + '</span>'
              + '</div>';
          }
          if (hasR2) {
            var p2 = g.r2[jj];
            html += '<div class="r-score-row"><span class="r-score-lbl">R2</span>'
              + '<span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(p2, 2) + '</span>'
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
WEST.hunter.derby.renderEntry = function(g, classInfo, judgeCount, opts) {
  opts = opts || {};
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
  var className = classInfo && (classInfo.class_name || classInfo.className) || '';

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

  // Ribbon / place — SVG ribbon when not live AND placed, otherwise numeric
  var placeText = r1Failed ? (r1Status ? r1Status.label : '—') : (place || '—');
  var isChampFlag = classInfo._computed ? !!classInfo._computed.isChampionship : false;
  var ribbonSvg = (!opts.isLive && !r1Failed && place) ? WEST.ribbon.placeRibbon(place, className, isChampFlag) : '';
  if (ribbonSvg) {
    html += '<div class="r-ribbon">' + ribbonSvg + '</div>';
  } else {
    html += '<div class="r-ribbon"><div class="r-place-txt">' + placeText + '</div></div>';
  }

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

  // Pull round metadata from the computed class object (worker emits these).
  // Falls back to 2-round/default labels for legacy KV entries without them.
  var comp = classInfo && classInfo._computed;
  var scoresOpts = {
    numRounds: (comp && comp.numRounds) || 2,
    roundLabels: (comp && comp.roundLabels) || null,
  };
  html += WEST.hunter.derby.renderScoresCol(g, judgeCount, hasR1, hasR2, r1Status, r2Status, r1Failed, canExpand, scoresOpts);
  html += '</div>'; // result-main

  if (canExpand) {
    html += WEST.hunter.derby.renderExpand(g, judgeCount);
  }

  html += '</div>'; // result-entry
  return html;
};

// Round-driven scores column. opts.numRounds + opts.roundLabels come from the
// computed class object (header H[3] and H[25-27]). Defaults to 2-round/R1-R2.
WEST.hunter.derby.renderScoresCol = function(g, judgeCount, hasR1, hasR2, r1Status, r2Status, r1Failed, canExpand, opts) {
  opts = opts || {};
  var numRounds = opts.numRounds || 2;
  if (numRounds < 1) numRounds = 1;
  if (numRounds > 3) numRounds = 3;
  var roundLabels = opts.roundLabels || ['R1', 'R2', 'R3'];

  if (r1Failed) {
    return '<div class="r-scores"><span class="r-status">' + (r1Status ? r1Status.label : 'DNS') + '</span></div>';
  }

  // Build per-round metadata arrays so we can loop generically.
  var hasR3 = WEST.hunter.derby.hasR3(g);
  var r3Status = WEST.hunter.getStatus(g.r3TextStatus, g.r3NumericStatus);
  var hasArr = [hasR1, hasR2, hasR3];
  var statusArr = [r1Status, r2Status, r3Status];
  var totalArr = [g.r1Total, g.r2Total, g.r3Total];
  var phasesArr = [g.r1, g.r2, g.r3];
  var judgeRanksArr = g._jt
    ? [g._jt.r1Ranks, g._jt.r2Ranks, g._jt.r3Ranks]
    : [null, null, null];
  var overallRankArr = g._jt
    ? [g._jt.r1OverallRank, g._jt.r2OverallRank, g._jt.r3OverallRank]
    : [null, null, null];

  var html = '<div class="r-scores">';

  // Dimension-aware collapse: when both judgeCount === 1 AND numRounds === 1,
  // skip the per-round row entirely and just show the score in the total
  // position. Drops "R1: 87 (1)" + separator + "87" down to just "87".
  var collapseSingle = (judgeCount === 1 && numRounds === 1);
  // Also drop the per-round-row label when there's only one round (the round
  // label is redundant when there's nothing to compare it to). Per-judge ranks
  // and per-round overall rank are still meaningful in 2j×1r and 1j×2r cases.
  var hideRowLabel = (numRounds === 1);

  if (!collapseSingle) {
    for (var r = 1; r <= numRounds; r++) {
      var idx = r - 1;
      var has = hasArr[idx];
      var status = statusArr[idx];
      var total = totalArr[idx];
      var phases = phasesArr[idx];
      var judgeRanks = judgeRanksArr[idx];
      var overallRank = overallRankArr[idx];
      var lbl = roundLabels[idx] || ('R' + r);
      var lblHtml = hideRowLabel ? '' : '<span class="r-score-lbl">' + esc(lbl) + '</span>';

      if (has) {
        if (judgeCount === 1) {
          var p = phases && phases[0];
          var k = judgeRanks && judgeRanks[0];
          html += '<div class="r-score-row">' + lblHtml
            + '<span class="r-score-val primary">' + WEST.hunter.derby.renderPhaseMath(p, r) + '</span>'
            + (k ? '<span class="r-score-val" style="font-size:11px;color:#aaa;">(' + WEST.ordinal(k) + ')</span>' : '')
            + '</div>';
        } else {
          html += '<div class="r-score-row">' + lblHtml
            + '<span class="r-score-val primary">' + total + '</span>'
            + (overallRank ? '<span class="r-score-val" style="font-size:11px;color:#aaa;">(' + WEST.ordinal(overallRank) + ')</span>' : '')
            + '</div>';
        }
      } else if (status) {
        html += '<div class="r-score-row">' + lblHtml + '<span class="r-status">' + status.label + '</span></div>';
      }
    }
  }

  // Total row — show `combined` if every round in numRounds is done,
  // otherwise fall back to a partial sum of the rounds that are done.
  // Skipped when collapseSingle handles the lone score below.
  var allDone = true;
  var anyDone = false;
  for (var rd = 0; rd < numRounds; rd++) {
    if (hasArr[rd]) anyDone = true;
    else allDone = false;
  }
  if (collapseSingle) {
    // 1×1: render the single score in the r-total position with no row above.
    var single = (g.r1 && g.r1[0]) ? WEST.hunter.derby.renderPhaseMath(g.r1[0], 1) : (g.r1Total || '');
    html += '<div class="r-total">' + esc(String(single)) + '</div>';
  } else if (allDone && g.combined !== undefined && g.combined !== null) {
    var combinedStr = typeof g.combined === 'number' ? g.combined.toFixed(2) : String(g.combined);
    html += '<div class="r-total">' + combinedStr + '</div>';
  } else if (anyDone) {
    var partial = 0;
    for (var rt = 0; rt < numRounds; rt++) {
      if (hasArr[rt]) {
        var t = totalArr[rt];
        var n = typeof t === 'number' ? t : parseFloat(t) || 0;
        partial += n;
      }
    }
    html += '<div class="r-total">' + partial.toFixed(2) + '</div>';
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
  var html = '<div class="derby-expand"><div class="de-inner">';

  // Use centralized judge grid
  var isDerby = !!(e.r1 && e.r1[0] && e.r1[0].base !== undefined);
  var sd = WEST.hunter.getStatusDisplay
    ? WEST.hunter.getStatusDisplay(e.r1StatusCode || e.r1TextStatus || '', e.r2StatusCode || e.r2TextStatus || '', '')
    : null;
  // Map _jt fields to renderJudgeGrid expected fields
  var gridEntry = {
    r1: e.r1, r2: e.r2,
    r1Total: e._jt.r1Total || e.r1Total,
    r2Total: e._jt.r2Total || e.r2Total,
    combined: e._jt.combined || e.combined,
    r1Ranks: e._jt.r1Ranks,
    r2Ranks: e._jt.r2Ranks,
    r1OverallRank: e._jt.r1OverallRank,
    r2OverallRank: e._jt.r2OverallRank,
    judgeCardTotals: e._jt.judgeCardTotals,
    judgeCardRanks: e._jt.judgeCardRanks,
  };
  var jg = WEST.hunter.renderJudgeGrid(gridEntry, judgeCount, sd, { isDerby: isDerby });
  html += jg.header;
  html += jg.row;

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
