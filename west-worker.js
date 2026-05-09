/**
 * WEST Scoring Live — Worker v2.2
 * Handles live class data and UDP events from west-watcher.js
 * Stores in KV (live) and D1 (archival)
 *
 * Bindings required:
 *   WEST_LIVE     — KV namespace
 *   WEST_DB       — D1 database (west-scoring)
 *   WEST_AUTH_KEY — Secret
 *
 * ENDPOINTS:
 *   POST /postClassData           — watcher posts .cls standings on every change
 *   POST /postUdpEvent            — watcher posts UDP events
 *   POST /postClassEvent          — watcher posts CLASS_SELECTED / CLASS_COMPLETE
 *   POST /heartbeat               — watcher alive signal every 60s
 *   GET  /getLiveClass            — website polls for live class + event data
 *   GET  /getClasses              — website gets all classes for a show
 *   GET  /getResults              — website gets full results for a class
 *   GET  /ping                    — health check
 *   GET  /admin/shows             — list all shows in D1
 *   GET  /admin/showData          — full data for a show
 *   POST /admin/createShow        — create a new show
 *   POST /admin/updateShow        — update show fields
 *   POST /admin/completeClass     — mark a class complete
 *   DELETE /admin/clearShow       — delete all D1 data for a show
 *   DELETE /admin/clearAll        — wipe entire database
 *   DELETE /admin/clearLive       — clear KV live keys for a ring
 */

const AUTH_KEY_NAME = 'X-West-Key';

// v3 feature flag. Reads env.V3_ENABLED (wrangler.toml [vars] or Cloudflare
// dashboard override). Default OFF — production stays safe until cutover.
// Use this helper at the entry of every v3 endpoint:
//   if (!isV3Enabled(env)) return new Response('v3 disabled', { status: 404 });
// Never check env.V3_ENABLED directly — go through this helper so we can
// evolve it later (e.g., add per-show toggles or staged rollout percentages).
function isV3Enabled(env) {
  return env.V3_ENABLED === 'true' || env.V3_ENABLED === true;
}

// ── SHOW LOCK (V3) ──────────────────────────────────────────────────────────
// Engine writes are gated by a per-show lock. Lock state is derived from
// shows.lock_override:
//   'locked'   → always locked
//   'unlocked' → never locked
//   'auto'     → locked iff end_date < today (UTC date string compare)
// Returns a small descriptor so callers can include the reason in the
// response if they want (engine logs it; admin tooltip surfaces it).
function computeShowLock(showRow) {
  if (!showRow) return { locked: false, reason: null };
  const ov = showRow.lock_override || 'auto';
  if (ov === 'locked')   return { locked: true,  reason: 'manual' };
  if (ov === 'unlocked') return { locked: false, reason: null };
  // 'auto' — date-based. Use UTC date for the compare; show end_date is
  // stored YYYY-MM-DD with no timezone, and the windows we care about
  // are >= 1 day past, so timezone fuzz is harmless.
  if (showRow.end_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (showRow.end_date < today) return { locked: true, reason: 'auto-after-end-date' };
  }
  return { locked: false, reason: null };
}

async function isShowLockedV3(env, slug) {
  try {
    const show = await env.WEST_DB_V3.prepare(
      'SELECT lock_override, end_date FROM shows WHERE slug = ?'
    ).bind(slug).first();
    return computeShowLock(show).locked;
  } catch (e) { return false; }
}

function lockedResponse(reason) {
  return new Response(JSON.stringify({
    ok: false, locked: true, reason: reason || 'locked',
    error: 'Show is locked from engine writes',
  }), { status: 423, headers: { 'Content-Type': 'application/json' } });
}

// ── HUNTER STANDINGS QUERY (Phase 3b Chunk 13) ─────────────────────────────
// Pulls top-20 entries with their current_place + combined_total for the
// hunter leaderboard panel on live.html. Used by /v3/postUdpEvent (per-batch
// refresh) AND /v3/postCls (push-on-update, so a Display Scores trigger
// that updates D1 without firing a UDP event still refreshes the page).
// classPk is classes.id (integer PK), NOT class_id (text). Returns null on
// error so callers can decide whether to surface a partial snapshot.
async function pullHunterScoresV3(env, classPk) {
  if (!classPk) return null;
  // Returns Ryegate's summary fields (current_place + combined_total)
  // PLUS the inputs WEST.rules.hunterPlaceFor needs (scoring_type,
  // r1_total, r1_status) so the page can apply the canonical placement
  // rule from west-rules.js. Without that, eliminated entries still
  // show a place number — Bill 2026-05-02: "right now 112 is elim in
  // the first round and showing a place." Page-side rule handles
  // Forced (scoring_type=0) vs Scored/Hi-Lo gates correctly.
  try {
    const r = await env.WEST_DB_V3.prepare(`
      SELECT e.id, e.entry_num, e.horse_name, e.rider_name, e.owner_name,
             e.country_code, e.sire, e.dam,
             ehs.current_place, ehs.combined_total,
             r1.total              AS r1_score_total,
             r1.status             AS r1_h_status,
             r1.numeric_status     AS r1_h_numeric_status,
             r1.round_overall_rank AS r1_overall_rank,
             r2.total              AS r2_score_total,
             r2.status             AS r2_h_status,
             r2.numeric_status     AS r2_h_numeric_status,
             r2.round_overall_rank AS r2_overall_rank,
             r3.total              AS r3_score_total,
             r3.status             AS r3_h_status,
             r3.numeric_status     AS r3_h_numeric_status,
             r3.round_overall_rank AS r3_overall_rank
      FROM entries e
      LEFT JOIN entry_hunter_summary ehs ON ehs.entry_id = e.id
      LEFT JOIN entry_hunter_rounds r1 ON r1.entry_id = e.id AND r1.round = 1
      LEFT JOIN entry_hunter_rounds r2 ON r2.entry_id = e.id AND r2.round = 2
      LEFT JOIN entry_hunter_rounds r3 ON r3.entry_id = e.id AND r3.round = 3
      WHERE e.class_id = ?
      ORDER BY
        CASE WHEN ehs.current_place IS NULL OR ehs.current_place = 0
             THEN 1 ELSE 0 END,
        ehs.current_place ASC,
        CAST(e.entry_num AS INTEGER) ASC
      LIMIT 50
    `).bind(classPk).all();
    const rows = r.results || [];
    // Per-judge per-round scores — needed for derby HighOpt/Handy display
    // and multi-judge breakdown in the live score card. Bulk-pull all
    // judges for this class in one query, then group by entry_id.
    if (rows.length) {
      try {
        const byEntryId = new Map();
        for (const row of rows) byEntryId.set(row.id, row);
        // Per-judge per-round score + rank from D1 (rank computed at
        // /v3/postCls time by computeJudgeGridRanks).
        const j = await env.WEST_DB_V3.prepare(`
          SELECT e.id AS entry_id, ehjs.round, ehjs.judge_idx,
                 ehjs.base_score, ehjs.high_options, ehjs.handy_bonus,
                 ehjs.judge_round_rank
          FROM entries e
          JOIN entry_hunter_judge_scores ehjs ON ehjs.entry_id = e.id
          WHERE e.class_id = ?
          ORDER BY e.id, ehjs.round, ehjs.judge_idx
        `).bind(classPk).all();
        for (const judge of (j.results || [])) {
          const entry = byEntryId.get(judge.entry_id);
          if (!entry) continue;
          if (!entry.judges) entry.judges = [];
          entry.judges.push({
            round: judge.round,
            idx:   judge.judge_idx,
            base:  judge.base_score,
            hiopt: judge.high_options,
            handy: judge.handy_bonus,
            judge_round_rank: judge.judge_round_rank,
          });
        }
        // Per-judge cumulative across rounds + rank — for the judgeCards
        // row at the bottom of the dropdown grid in multi-round classes.
        const cards = await env.WEST_DB_V3.prepare(`
          SELECT e.id AS entry_id, ehjc.judge_idx,
                 ehjc.card_total, ehjc.card_rank
          FROM entries e
          JOIN entry_hunter_judge_cards ehjc ON ehjc.entry_id = e.id
          WHERE e.class_id = ?
          ORDER BY e.id, ehjc.judge_idx
        `).bind(classPk).all();
        for (const card of (cards.results || [])) {
          const entry = byEntryId.get(card.entry_id);
          if (!entry) continue;
          if (!entry.judge_cards) entry.judge_cards = [];
          entry.judge_cards.push({
            idx:   card.judge_idx,
            total: card.card_total,
            rank:  card.card_rank,
          });
        }
      } catch (e) {
        console.log(`[pullHunterScoresV3] judges lookup failed: ${e.message}`);
      }
    }
    return rows;
  } catch (e) {
    console.log(`[pullHunterScoresV3] failed for class_pk=${classPk}: ${e.message}`);
    return null;
  }
}

// ── JUMPER STANDINGS QUERY (Phase 3b Chunk 14) ─────────────────────────────
// Pulls top-20 jumper entries with the inputs WEST.rules.jumperPlaceFor
// needs (overall_place, scoring_method, r{1,2,3}_status). Page applies the
// canonical rule to suppress place for entries the method's wipesOnFail
// ladder eliminated. Includes round time + faults so the panel can show
// "0 / 65.234" style scores. Equitation classes (Method 7) ride this same
// pipe — they're jumper-protocol classes by lens.
async function pullJumperScoresV3(env, classPk) {
  if (!classPk) return null;
  try {
    const r = await env.WEST_DB_V3.prepare(`
      SELECT e.entry_num, e.horse_name, e.rider_name, e.owner_name,
             e.country_code, e.sire, e.dam, e.city, e.state,
             ejs.overall_place, ejs.ride_order,
             r1.time AS r1_time, r1.total_time AS r1_total_time,
             r1.penalty_sec AS r1_penalty_sec,
             r1.time_faults AS r1_time_faults,
             r1.jump_faults AS r1_jump_faults,
             r1.total_faults AS r1_total_faults,
             r1.status AS r1_status, r1.numeric_status AS r1_numeric_status,
             r2.time AS r2_time, r2.total_time AS r2_total_time,
             r2.penalty_sec AS r2_penalty_sec,
             r2.time_faults AS r2_time_faults,
             r2.jump_faults AS r2_jump_faults,
             r2.total_faults AS r2_total_faults,
             r2.status AS r2_status, r2.numeric_status AS r2_numeric_status,
             r3.time AS r3_time, r3.total_time AS r3_total_time,
             r3.penalty_sec AS r3_penalty_sec,
             r3.time_faults AS r3_time_faults,
             r3.jump_faults AS r3_jump_faults,
             r3.total_faults AS r3_total_faults,
             r3.status AS r3_status, r3.numeric_status AS r3_numeric_status
      FROM entries e
      LEFT JOIN entry_jumper_summary ejs ON ejs.entry_id = e.id
      LEFT JOIN entry_jumper_rounds r1 ON r1.entry_id = e.id AND r1.round = 1
      LEFT JOIN entry_jumper_rounds r2 ON r2.entry_id = e.id AND r2.round = 2
      LEFT JOIN entry_jumper_rounds r3 ON r3.entry_id = e.id AND r3.round = 3
      WHERE e.class_id = ?
      ORDER BY
        CASE WHEN ejs.overall_place IS NULL OR ejs.overall_place = 0
             THEN 1 ELSE 0 END,
        ejs.overall_place ASC,
        CAST(e.entry_num AS INTEGER) ASC
      LIMIT 50
    `).bind(classPk).all();
    return r.results || [];
  } catch (e) {
    console.log(`[pullJumperScoresV3] failed for class_pk=${classPk}: ${e.message}`);
    return null;
  }
}

// ── CLASS KIND DERIVATION (Phase 3b polish) ────────────────────────────────
// Article 1 split: class_type is HARDWARE (H/J/T/U), class_kind is the
// SEMANTIC lens (jumper / hunter / equitation). Used by /v3/postUdpEvent
// to enrich the snapshot so live.html can render UDP tags with their
// human labels per-lens. Returns null when no lens can be committed.
function deriveClassKindV3(classType, scoringMethod) {
  const ct = (classType || '').toUpperCase();
  const m = parseInt(scoringMethod, 10);
  if (ct === 'H') return 'hunter';
  if (ct === 'J' || ct === 'T') {
    return m === 7 ? 'equitation' : 'jumper';
  }
  if (ct === 'U' && Number.isFinite(m) && m >= 0 && m <= 15) {
    return m === 7 ? 'equitation' : 'jumper';
  }
  return null;
}

// ── .cls HEADER PARSE (Phase 2b) ─────────────────────────────────────────
// Article 1 enforced: classType at col[0] is THE LENS. Hunter and jumper
// column meanings are NEVER translated across lenses. We only read the
// minimum needed for the classes table:
//   - classType (col[0]): H | J | T | U
//   - className (col[1]): quoted string, operator-entered
//   - scoring_method (col[2]) for J/T only
//   - class_mode   (col[2]) for H only
//   - U = no lens committed — read col[0] and col[1] only, mark unconfigured

function parseCsvLineV3(line) {
  // Quote-aware single-line splitter (same pattern as v2 funnel).
  // Named V3-suffix to avoid colliding with any v2 helper.
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Phase 2d: jumper lens column layout.
// MIRROR of v3/js/west-cls-jumper.js `current` version. Keep in sync.
// Versioning scaffold lives in the shared file; worker only needs the
// active version. When layout shifts, bump the comment + replace this
// block with the new version's data (AND bump `current` in the shared
// file + add a new version entry there).
const CLS_JUMPER_LAYOUT_VERSION = 'v_2026_04_23';
const CLS_JUMPER_LAYOUT = {
  identity: {
    entry_num: 0, horse_name: 1, rider_name: 2,
    country_code: 4, owner_name: 5, sire: 6, dam: 7,
    city: 8, state: 9,
    horse_usef: 10, rider_usef: 11, owner_usef: 12,
  },
  ride_order: 13,
  overall_place: 14,
  rounds: {
    1: { time:15, penalty_sec:16, total_time:17, time_faults:18, jump_faults:19, total_faults:20, numeric_status:21 },
    2: { time:22, penalty_sec:23, total_time:24, time_faults:25, jump_faults:26, total_faults:27, numeric_status:28 },
    3: { time:29, penalty_sec:30, total_time:31, time_faults:32, jump_faults:33, total_faults:34, numeric_status:35 },
  },
  text_status: {
    J: { scan_range: [37, 38, 39] },
    T: { 1: 82, 2: 83, 3: 84 },
  },
  expected_cols: { J: 40, T: 85 },
};

// Empirical jumper numeric → display-category map. Built from live evidence
// (Culpeper 2026-04 + v2 watcher observations). Codes 1, 5, 6 never observed
// live; parser logs parse_warning if encountered. See SESSION-32 findings.
const JUMPER_NUMERIC_MAP = {
  2: 'RT',  // Retired
  3: 'EL',  // Elim family (generic — Ryegate's specific text wins when present)
  4: 'WD',  // Withdrew
};

// Text status whitelist for tail-scan (Farmtek). Matches v2 watcher.
const JUMPER_KNOWN_STATUS_RE = /^(EL|RF|OC|HF|WD|RT|DNS|DQ|RO|EX|HC)$/i;

// Number-parse helpers: parseFloat("") → NaN which SQLite REAL won't accept.
// Return null for empty / non-numeric so D1 bind stores NULL.
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Phase 2d: parse per-round status for one entry row (jumper lens).
// Returns { r1:{text,numeric}, r2:{...}, r3:{...} }.
// Core rule (SESSION-32 §10): per-round INDEPENDENT. Never propagates
// one round's status to another. Text wins over numeric when attributable.
function parseEntryStatusesJumper(cols, classType) {
  const L = CLS_JUMPER_LAYOUT;
  const nums = {
    1: intOrNull(cols[L.rounds[1].numeric_status]) || 0,
    2: intOrNull(cols[L.rounds[2].numeric_status]) || 0,
    3: intOrNull(cols[L.rounds[3].numeric_status]) || 0,
  };
  const out = {
    r1: { text: null, numeric: nums[1] || null },
    r2: { text: null, numeric: nums[2] || null },
    r3: { text: null, numeric: nums[3] || null },
  };

  if (classType === 'T') {
    // TOD: per-round text columns, direct read
    for (const round of [1, 2, 3]) {
      const col = L.text_status.T[round];
      const val = (cols[col] || '').trim();
      if (val && JUMPER_KNOWN_STATUS_RE.test(val)) {
        out['r' + round].text = val.toUpperCase();
      }
    }
  } else {
    // Farmtek (J): tail-scan single text field at cols 37-39.
    // Attribute to the LATEST round whose numeric flag fired.
    let tailText = null;
    for (const col of L.text_status.J.scan_range) {
      const val = (cols[col] || '').trim();
      if (val && JUMPER_KNOWN_STATUS_RE.test(val)) {
        tailText = val.toUpperCase();
        break;
      }
    }
    if (tailText) {
      if (nums[3]) out.r3.text = tailText;
      else if (nums[2]) out.r2.text = tailText;
      else if (nums[1]) out.r1.text = tailText;
      // If no numeric fired but text found → anomaly; leave all text null,
      // parser caller logs parse_warning from its own sweep.
    }
  }

  // For any round with a non-zero numeric but no text attributed, derive
  // text from the JUMPER_NUMERIC_MAP. Ryegate-specific text (when present)
  // wins; numeric-derived fallback only when text absent.
  for (const round of [1, 2, 3]) {
    const r = out['r' + round];
    if (r.numeric && !r.text) {
      r.text = JUMPER_NUMERIC_MAP[r.numeric] || null;
    }
  }

  return out;
}

// Phase 2d: parse full jumper scoring per entry.
// classType: 'J' (Farmtek) or 'T' (TOD). U-with-method is skipped upstream.
// Returns { entries: [...], status: string }.
// Each entry object's fields map 1:1 to entry_jumper_scores columns.
function parseEntriesScoreJ(text, classType) {
  if (classType !== 'J' && classType !== 'T') {
    return { entries: [], status: 'skipped: wrong lens' };
  }
  const L = CLS_JUMPER_LAYOUT;
  const expectedCols = L.expected_cols[classType];
  const lines = text.split(/\r?\n/);
  const entries = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.startsWith('@')) continue;
    const cols = parseCsvLineV3(line);
    const rawEntryNum = (cols[L.identity.entry_num] || '').trim();
    if (!rawEntryNum || !/^[A-Za-z0-9_-]{1,16}$/.test(rawEntryNum)) continue;

    const notes = [];
    if (expectedCols && cols.length !== expectedCols) {
      notes.push(`col count ${cols.length}, expected ${expectedCols} for ${classType}`);
    }

    const statuses = parseEntryStatusesJumper(cols, classType);

    // Log parse_warning for numeric codes outside our empirical map.
    for (const round of [1, 2, 3]) {
      const n = statuses['r' + round].numeric;
      if (n && !JUMPER_NUMERIC_MAP[n]) {
        notes.push(`R${round} unknown numeric ${n}`);
      }
    }
    // First-ever R3 data signal — structural R3 positions stay flagged
    // until we see live 3-round jumper data. Both branches log for now.
    const r3Time = numOrNull(cols[L.rounds[3].time]);
    if ((r3Time && r3Time > 0) || statuses.r3.numeric) {
      notes.push('R3 data observed — confirms structural R3 position');
    }

    entries.push({
      entry_num: rawEntryNum,
      ride_order: intOrNull(cols[L.ride_order]),
      overall_place: intOrNull(cols[L.overall_place]),
      r1_time:           numOrNull(cols[L.rounds[1].time]),
      r1_penalty_sec:    numOrNull(cols[L.rounds[1].penalty_sec]),
      r1_total_time:     numOrNull(cols[L.rounds[1].total_time]),
      r1_time_faults:    numOrNull(cols[L.rounds[1].time_faults]),
      r1_jump_faults:    numOrNull(cols[L.rounds[1].jump_faults]),
      r1_total_faults:   numOrNull(cols[L.rounds[1].total_faults]),
      r1_status:         statuses.r1.text,
      r1_numeric_status: statuses.r1.numeric,
      r2_time:           numOrNull(cols[L.rounds[2].time]),
      r2_penalty_sec:    numOrNull(cols[L.rounds[2].penalty_sec]),
      r2_total_time:     numOrNull(cols[L.rounds[2].total_time]),
      r2_time_faults:    numOrNull(cols[L.rounds[2].time_faults]),
      r2_jump_faults:    numOrNull(cols[L.rounds[2].jump_faults]),
      r2_total_faults:   numOrNull(cols[L.rounds[2].total_faults]),
      r2_status:         statuses.r2.text,
      r2_numeric_status: statuses.r2.numeric,
      r3_time:           r3Time,
      r3_penalty_sec:    numOrNull(cols[L.rounds[3].penalty_sec]),
      r3_total_time:     numOrNull(cols[L.rounds[3].total_time]),
      r3_time_faults:    numOrNull(cols[L.rounds[3].time_faults]),
      r3_jump_faults:    numOrNull(cols[L.rounds[3].jump_faults]),
      r3_total_faults:   numOrNull(cols[L.rounds[3].total_faults]),
      r3_status:         statuses.r3.text,
      r3_numeric_status: statuses.r3.numeric,
      score_parse_status: notes.length > 0 ? 'warnings' : 'parsed',
      score_parse_notes:  notes.length > 0 ? notes.join('; ') : null,
    });
  }

  return { entries, status: `parsed: ${entries.length} jumper scorings` };
}

// Phase 2d hunter half: hunter lens column layout.
// MIRROR of v3/js/west-cls-hunter.js `current` version. Keep in sync.
const CLS_HUNTER_LAYOUT_VERSION = 'v_2026_04_24';
const CLS_HUNTER_LAYOUT = {
  identity: {
    entry_num: 0, horse_name: 1, rider_name: 2,
    country_code: 4, owner_name: 5, sire: 6, dam: 7,
    city: 8, state: 9,
    horse_usef: 10, rider_usef: 11, owner_usef: 12,
  },
  go_order: 13,
  current_place: 14,
  rounds: {
    1: { total: 42, numeric_status: 46, text_status: 52 },
    2: { total: 43, numeric_status: 47, text_status: 53 },
    3: { total: 44, numeric_status: 48, text_status: 54 },
  },
  combined_total: 45,
  min_cols: 55,

  // Non-derby per-judge score starts (Layout A — sequential, +9 stride).
  // R1 judge J: col[15 + J],  R2: col[24 + J],  R3: col[33 + J]
  // Capped at numJudges-1 (max J=6 for 7-judge class).
  judges: {
    1: { start: 15 },
    2: { start: 24 },
    3: { start: 33 },
  },

  // Derby per-judge layout (classMode=2, Layout B — interleaved).
  // R1 stride per judge = 2: [HighOptions, BaseScore]
  //   J1: col[15]=HighOpt, col[16]=Base
  //   J2: col[17]=HighOpt (mirror of col[15]), col[18]=Base
  //   Jn: col[15 + 2n]=HighOpt, col[16 + 2n]=Base
  // R2 stride per judge = 3: [HighOptions, BaseScore, HandyBonus]
  //   J1: col[24]=HighOpt, col[25]=Base, col[26]=Handy
  //   J2: col[27]=HighOpt, col[28]=Base, col[29]=Handy
  //   Jn: col[24 + 3n]=HighOpt, col[25 + 3n]=Base, col[26 + 3n]=Handy
  // R3: derby classes typically 2-round; extrapolation unconfirmed.
  derby: {
    rounds: {
      1: { start: 15, stride: 2, hasHandy: false },
      2: { start: 24, stride: 3, hasHandy: true  },
    },
  },
};

// Hunter numeric status map (from v2 display-config.js:1390).
// Narrower than jumper map — hunter operators don't use the same code set.
// Unknown values log parse_warning (parser fallback).
const HUNTER_NUMERIC_MAP = {
  2: 'EL',  // generic — text code has specifics (RF/HF/EL/OC/DNS)
  3: 'RT',  // retired — often missing text
};

// Phase 2d: parse hunter scoring per entry.
// Returns { entries: [...], status: string }.
// Each entry object carries summary fields (go_order, current_place,
// combined_total, parse meta) AND wide-shape round fields (r1_total,
// r1_status, r1_numeric_status, r2_*, r3_*) — the worker splits at
// write time into entry_hunter_summary + entry_hunter_rounds rows.
// Per-judge scores NOT captured (deferred).
function parseEntriesScoreH(text, classMode) {
  const L = CLS_HUNTER_LAYOUT;
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.startsWith('@')) continue;
    const cols = parseCsvLineV3(line);
    const rawEntryNum = (cols[L.identity.entry_num] || '').trim();
    if (!rawEntryNum || !/^[A-Za-z0-9_-]{1,16}$/.test(rawEntryNum)) continue;

    const notes = [];
    if (cols.length < L.min_cols) {
      notes.push(`col count ${cols.length} below hunter min ${L.min_cols}`);
    }
    if (classMode === 2) {
      notes.push('classMode=2 Derby — component breakdown not captured (totals at col[42-45] still land)');
    }

    // Per-round status attribution. Hunter has direct per-round text
    // columns (52/53/54) AND per-round numeric (46/47/48). Both are
    // lens-specific. Unlike Farmtek, no tail-scan ambiguity.
    const statuses = {};
    for (const round of [1, 2, 3]) {
      const ns = intOrNull(cols[L.rounds[round].numeric_status]) || 0;
      const txtRaw = (cols[L.rounds[round].text_status] || '').trim();
      let txt = null;
      if (txtRaw && JUMPER_KNOWN_STATUS_RE.test(txtRaw)) {
        txt = txtRaw.toUpperCase();
      }
      // Numeric fallback (hunter-specific map) when text missing
      if (!txt && ns > 0) {
        txt = HUNTER_NUMERIC_MAP[ns] || null;
        if (!HUNTER_NUMERIC_MAP[ns]) {
          notes.push(`R${round} unknown hunter numeric ${ns}`);
        }
      }
      statuses[round] = { text: txt, numeric: ns || null };
    }

    entries.push({
      entry_num: rawEntryNum,
      go_order: intOrNull(cols[L.go_order]),
      current_place: intOrNull(cols[L.current_place]),
      combined_total: numOrNull(cols[L.combined_total]),

      r1_total:          numOrNull(cols[L.rounds[1].total]),
      r1_status:         statuses[1].text,
      r1_numeric_status: statuses[1].numeric,
      r2_total:          numOrNull(cols[L.rounds[2].total]),
      r2_status:         statuses[2].text,
      r2_numeric_status: statuses[2].numeric,
      r3_total:          numOrNull(cols[L.rounds[3].total]),
      r3_status:         statuses[3].text,
      r3_numeric_status: statuses[3].numeric,

      score_parse_status: notes.length > 0 ? 'warnings' : 'parsed',
      score_parse_notes:  notes.length > 0 ? notes.join('; ') : null,
    });
  }
  return { entries, status: `parsed: ${entries.length} hunter scorings` };
}

// Phase 2d hunter completion: per-judge score parser.
// Returns array of { entry_num, rows: [{round, judge_idx, base_score,
// high_options, handy_bonus}] } — one entry per parsed row, with 0..N
// judge-round rows per entry.
//
// Non-derby (classMode 0/1/3): sequential per-judge scores via Layout A.
// Derby (classMode 2): interleaved HighOpt/Base/Handy via Layout B.
// Forced (scoringType 0): no judge scores exist in the .cls — skip entirely.
function parseHunterJudgeScores(text, classMode, numJudges, scoringType) {
  if (scoringType === 0) return { entries: [], status: 'skipped: forced (no judge scores)' };
  if (!Number.isFinite(numJudges) || numJudges < 1) {
    return { entries: [], status: 'skipped: numJudges invalid' };
  }
  const L = CLS_HUNTER_LAYOUT;
  const lines = text.split(/\r?\n/);
  const entries = [];
  const isDerby = classMode === 2;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('@')) continue;
    const cols = parseCsvLineV3(line);
    const rawEntryNum = (cols[L.identity.entry_num] || '').trim();
    if (!rawEntryNum || !/^[A-Za-z0-9_-]{1,16}$/.test(rawEntryNum)) continue;

    const rows = [];

    if (isDerby) {
      // Derby layout B — interleaved per-judge slots.
      // Skip rule: base_score null or 0 = judge didn't score this round.
      // Hunter scoring range is 40-100 in practice; 0 is Ryegate's
      // "empty slot" sentinel (EL'd entries, unused slots, etc.).
      for (const round of [1, 2]) {  // derby typically 2-round; R3 unconfirmed
        const block = L.derby.rounds[round];
        for (let j = 0; j < numJudges; j++) {
          const base = block.start + j * block.stride;
          const ho    = numOrNull(cols[base]);
          const score = numOrNull(cols[base + 1]);
          const handy = block.hasHandy ? numOrNull(cols[base + 2]) : null;
          if (score == null || score === 0) continue;
          rows.push({ round, judge_idx: j, base_score: score, high_options: ho, handy_bonus: handy });
        }
      }
    } else {
      // Non-derby layout A — sequential judge scores, +9 stride between rounds.
      // Same skip rule: 0 = empty slot, not a real score.
      for (const round of [1, 2, 3]) {
        const start = L.judges[round].start;
        for (let j = 0; j < numJudges; j++) {
          const score = numOrNull(cols[start + j]);
          if (score == null || score === 0) continue;
          rows.push({ round, judge_idx: j, base_score: score, high_options: null, handy_bonus: null });
        }
      }
    }

    if (rows.length > 0) {
      entries.push({ entry_num: rawEntryNum, rows });
    }
  }

  return { entries, status: `parsed: ${entries.length} entries with judge data` };
}

// Phase 2c: parse entry rows. Called after header parse decides which lens
// to use. Identity cols 0-12 are shared across H/J/T/U-inferred. Scoring
// cols diverge by lens — handled by parseEntriesScoreJ (jumper, above) and
// parseEntriesScoreH (hunter, above).
function parseClsEntriesV3(text, lensKnown) {
  if (!lensKnown) return { entries: [], status: 'skipped: no lens', trophy: null };
  const lines = text.split(/\r?\n/);
  const entries = [];
  let trophy = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Special metadata rows prefixed '@' — capture the ones we care
    // about, skip the rest. @foot carries trophy/footer text at cols[1].
    if (line.startsWith('@')) {
      if (line.startsWith('@foot')) {
        const ftCols = parseCsvLineV3(line);
        const t = (ftCols[1] || '').trim();
        if (t) trophy = t;
      }
      continue;
    }
    const cols = parseCsvLineV3(line);
    if (!cols[0] || !cols[0].trim()) continue;
    // entry_num must look reasonable — alphanumeric short string
    const entryNum = cols[0].trim();
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(entryNum)) continue;
    entries.push({
      entry_num: entryNum,
      horse_name:   (cols[1]  || '').trim() || null,
      rider_name:   (cols[2]  || '').trim() || null,
      country_code: (cols[4]  || '').trim().toUpperCase() || null,
      owner_name:   (cols[5]  || '').trim() || null,
      sire:         (cols[6]  || '').trim() || null,
      dam:          (cols[7]  || '').trim() || null,
      city:         (cols[8]  || '').trim() || null,
      state:        (cols[9]  || '').trim() || null,
      horse_usef:   (cols[10] || '').trim() || null,
      rider_usef:   (cols[11] || '').trim() || null,
      owner_usef:   (cols[12] || '').trim() || null,
      raw_row:      line,
    });
  }
  return { entries, status: `parsed: ${entries.length} entries`, trophy };
}

// Parse the @money row from a .cls file's body — returns an array
// of dollar amounts per finishing place (1st, 2nd, 3rd, ...). Persisted
// to classes.prize_money on every /v3/postCls write so class.html can
// render the prize amount beneath each ribbon when the class is FINAL
// (Bill 2026-05-06). Null when no @money row is present.
// Defensive JSON.parse for the prize_money TEXT column. Returns null
// if the row was written with malformed JSON or somehow not an array.
function safeParsePrizeMoney(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) { return null; }
}

function parseClsMoneyV3(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  catch (e) { return null; }
  const moneyLine = text.split(/\r?\n/).find(l => l.startsWith('@money'));
  if (!moneyLine) return null;
  const parts = moneyLine.split(',').slice(1).map(s => parseFloat((s || '').trim()));
  // Trim trailing zeros so we don't carry a long tail of empty places
  // (Ryegate sometimes pads the row with zeros to a fixed length).
  let lastNonZero = -1;
  for (let i = 0; i < parts.length; i++) {
    if (Number.isFinite(parts[i]) && parts[i] > 0) lastNonZero = i;
  }
  if (lastNonZero < 0) return null;
  return parts.slice(0, lastNonZero + 1).map(n => Number.isFinite(n) ? n : 0);
}

function parseClsHeaderV3(bytes) {
  // bytes = ArrayBuffer. Returns {class_type, class_name, scoring_method?,
  //  class_mode?, parse_status, parse_notes}.
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (e) {
    return { class_type: 'U', class_name: null, parse_status: 'parse_error', parse_notes: 'decode failed: ' + e.message };
  }
  const firstLine = (text.split(/\r?\n/)[0] || '').trim();
  if (!firstLine) {
    return { class_type: 'U', class_name: null, parse_status: 'parse_error', parse_notes: 'empty header row' };
  }
  const cols = parseCsvLineV3(firstLine);
  const rawType = (cols[0] || '').trim().toUpperCase();
  const className = (cols[1] || '').trim() || null;

  if (!['H', 'J', 'T', 'U'].includes(rawType)) {
    return { class_type: 'U', class_name: className, parse_status: 'parse_error', parse_notes: `unknown classType "${cols[0]}"` };
  }

  if (rawType === 'U') {
    // Article 1: U = hardware type not committed. Per locked v3 principle
    // "parse everything readable regardless of classType", we still read
    // col[2] as a potential scoring method when it's jumper-shaped (0-15).
    // class_type stays U (honest to the file); scoring_method captures
    // the lens hint so the class isn't mis-labeled "unconfigured" when
    // it actually has a method code operator-entered.
    const methodMaybe = parseInt(cols[2], 10);
    if (Number.isFinite(methodMaybe) && methodMaybe >= 0 && methodMaybe <= 15) {
      const modMaybe = parseInt(cols[3], 10);
      return {
        class_type: 'U',
        class_name: className,
        scoring_method: methodMaybe,
        scoring_modifier: Number.isFinite(modMaybe) ? modMaybe : null,
        parse_status: 'parsed',
        parse_notes: 'U hardware-type, jumper-shape method inferred from col[2]',
      };
    }
    return {
      class_type: 'U',
      class_name: className,
      parse_status: className ? 'unconfigured' : 'parse_error',
      parse_notes: className ? 'U — no lens committed yet' : 'U with no name',
    };
  }

  if (rawType === 'H') {
    // Hunter lens. Known header positions (per CLS-FORMAT.md H[XX]):
    //   col[2]  classMode       (0=O/F, 1=Flat, 2=Derby, 3=Special)
    //   col[3]  numRounds       (1, 2, or 3)
    //   col[5]  scoringType     (0=Forced, 1=Scored, 2=Hi-Lo)
    //   col[6]  scoreMethod     (0=Total, 1=Average)
    //   col[7]  numJudges
    //   col[8]  ribbonCount     (8 standard, 12 derby/special)
    //   col[10] isEquitation    (True/False)
    //   col[11] isChampionship  (True/False)
    //   col[29] sponsor         (text)
    //   col[37] derbyType       (0-8)
    //   col[38] ihsa            (True/False)
    const bool01 = (v) => {
      const s = (v || '').trim().toLowerCase();
      return s === 'true' ? 1 : s === 'false' ? 0 : null;
    };
    const intOrNullHelper = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    return {
      class_type:         'H',
      class_name:         className,
      class_mode:         intOrNullHelper(cols[2]),
      num_rounds:         intOrNullHelper(cols[3]),
      scoring_type:       intOrNullHelper(cols[5]),
      score_method:       intOrNullHelper(cols[6]),
      num_judges:         intOrNullHelper(cols[7]),
      ribbon_count:       intOrNullHelper(cols[8]),
      is_equitation:      bool01(cols[10]),
      is_championship:    bool01(cols[11]),
      is_jogged:          bool01(cols[12]),
      print_judge_scores: bool01(cols[15]),
      reverse_rank:       bool01(cols[16]),
      sponsor:            (cols[29] || '').trim() || null,
      is_team:            bool01(cols[34]),
      show_all_rounds:    bool01(cols[35]),
      derby_type:         intOrNullHelper(cols[37]),
      ihsa:               bool01(cols[38]),
      ribbons_only:       bool01(cols[39]),
      parse_status:       'parsed',
      parse_notes:        null,
    };
  }

  // J or T — jumper lens. col[2] = scoring_method, col[3] = scoring_modifier.
  // col[26] = ShowFlags (jumper lens only — hunter's H[26] is Phase2Label).
  // col[8/11/14] = per-round time_allowed (seconds, jumper-only — see
  // migration 019). 0 / blank → null (no TA on that round).
  const n = parseInt(cols[2], 10);
  const mod = parseInt(cols[3], 10);
  const flagsRaw = (cols[26] || '').trim().toLowerCase();
  const showFlags = flagsRaw === 'true' ? 1 : 0;
  const taOf = (raw) => {
    const v = parseFloat(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  return {
    class_type: rawType,
    class_name: className,
    scoring_method: Number.isFinite(n) ? n : null,
    scoring_modifier: Number.isFinite(mod) ? mod : null,
    show_flags: showFlags,
    r1_time_allowed: taOf(cols[8]),
    r2_time_allowed: taOf(cols[11]),
    r3_time_allowed: taOf(cols[14]),
    parse_status: 'parsed',
    parse_notes: null,
  };
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-West-Key, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ETag-aware JSON response. If the client sent If-None-Match and the
// data hasn't changed, returns 304 (zero bytes). Otherwise returns the
// full response with an ETag header. Uses a simple FNV-1a hash — fast,
// no crypto overhead, collisions don't matter (worst case = one extra fetch).
async function jsonWithEtag(request, data) {
  const body = JSON.stringify(data);
  // FNV-1a 32-bit hash
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const etag = '"' + (h >>> 0).toString(36) + '"';
  const clientEtag = request.headers.get('If-None-Match');
  if (clientEtag === etag) {
    return new Response(null, { status: 304, headers: CORS });
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'ETag': etag, ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function isAuthed(request, env) {
  const key = request.headers.get(AUTH_KEY_NAME);
  return key && key === env.WEST_AUTH_KEY;
}

// ── RING STATE DURABLE OBJECT (Phase 3b Chunk 6) ────────────────────────────
// One instance per (slug, ring_num). Holds the latest engine-posted snapshot
// in memory. The main worker routes /v3/postUdpEvent through here so the DO
// becomes the authoritative state holder. Chunk 6 keeps reads going through
// the KV mirror (so /v3/getRingState is unchanged); Chunk 7 will add a
// WebSocket broadcast and Chunk 8 swaps the page from polling to WS.
//
// DO eviction: low-traffic instances get evicted by the runtime. New
// instances start with null snapshot — KV still has the last good copy, so
// polling clients are unaffected. We don't proactively re-read KV on
// construction (lazy); when Chunk 7 lands, a WS client connecting to a
// cold DO will trigger the warm-up read.

// Status code map (Bill 2026-05-06: worker-side decoding so pages
// stay dumb). Mirrors v3/js/west-status.js — kept inline here so the
// worker doesn't need a build step to share modules. ELIM family
// collapses the EL label per Bill's "EL" simplification (display
// shows "EL" for any of EL/RF/HF/OC/RO/DQ; full carries the verbose
// reason for tooltips). PARTIAL = retired / withdrew (rider chose
// to stop). DNS = entered but never rode.
const STATUS_CODES = {
  E:   { label: 'EL',  full: 'Eliminated',     category: 'ELIM'    },
  EL:  { label: 'EL',  full: 'Eliminated',     category: 'ELIM'    },
  RF:  { label: 'EL',  full: 'Rider Fall',     category: 'ELIM'    },
  HF:  { label: 'EL',  full: 'Horse Fall',     category: 'ELIM'    },
  OC:  { label: 'EL',  full: 'Off Course',     category: 'ELIM'    },
  RO:  { label: 'EL',  full: 'Refused Out',    category: 'ELIM'    },
  DQ:  { label: 'EL',  full: 'Disqualified',   category: 'ELIM'    },
  RT:  { label: 'RT',  full: 'Retired',        category: 'PARTIAL' },
  WD:  { label: 'WD',  full: 'Withdrew',       category: 'PARTIAL' },
  DNS: { label: 'DNS', full: 'Did Not Start',  category: 'DNS'     },
  NS:  { label: 'DNS', full: 'No Show',        category: 'DNS'     },
};

// Pick the scores array to write onto byClass[focusedClassId]. Body
// scores belong to lensClassId (last UDP event's class), which can
// differ from the focused class. Routing rule:
//   • When lens class matches focused, adopt body (with empty-array
//     guard — a mid-sweep [] doesn't clobber populated prior).
//   • When lens != focused, body's scores belong to a different
//     class entirely; keep prior unchanged.
//   • When body has no class_meta hint at all (legacy / hunter-only
//     batches), fall through to body if defined, else prior.
// Bill 2026-05-08.
function pickScores(bodyScores, priorScores, bodyClassMeta, focusedClassId) {
  const lensClassId = bodyClassMeta && bodyClassMeta.class_id;
  const lensIsFocused = lensClassId != null
    && String(lensClassId) === String(focusedClassId);
  const priorIsPopulated = Array.isArray(priorScores) && priorScores.length > 0;
  // Empty-overwrite guard — keep populated prior when incoming is empty.
  const bodyIsEmpty = Array.isArray(bodyScores) && bodyScores.length === 0;
  if (bodyIsEmpty && priorIsPopulated) return priorScores;
  // Lens-class routing — only adopt body scores when they're for the
  // focused class. When body has no lens hint we can't tell, so
  // adopt body (preserves legacy behavior) unless empty + prior is
  // populated (handled above).
  if (lensClassId != null && !lensIsFocused) {
    return priorScores != null ? priorScores : null;
  }
  return bodyScores !== undefined ? bodyScores : (priorScores || null);
}

// Pick the hunter "displayed round" for a scoring row — i.e. which
// round (or Overall) the operator most recently RELEASED via Display
// Scores. Mirror of the subset-matching logic in
// v3/js/west-hunter-templates.js renderLowerThird (the M4 lower-
// third's PRIMARY detector). Centralized here so the just-finished
// banner, the M4 lower-third, and any future hunter surface all read
// the SAME displayed-round + score from the worker — no client-side
// duplication. Bill 2026-05-08.
//
// Rationale: combined_total = SUM of every round operator has
// released. So:
//   • combined matches sum(all rounds)             → Overall mode
//   • combined matches sum of subset of rounds      → those are
//     released; the highest-numbered round in the subset is the
//     "current displayed round" (latest release wins ties)
//   • combined matches one round alone              → only that
//     round released
// Stable across UDP cycling because it's data-only.
//
// fr=12/14/16 UDP tag matching is intentionally NOT in this helper
// — that's an "active rider, this very tick" signal that's only
// meaningful for the M4 lower-third (live focus). For previous_entry
// (after the rider leaves), the subset-match is the right answer.
//
// Returns { round, label, score, isOverall } or null when row has no
// scored rounds. round is null when isOverall=true.
function _decodeHunterDisplayedRound(row, classMeta) {
  if (!row || !classMeta) return null;
  const numRounds = Math.max(1, Math.min(3, Number(classMeta.num_rounds) || 1));
  // Collect rounds with CLEAN data (skip status-set rounds — their 0
  // isn't a real score; subset matching against 0 falsely promoted to
  // Overall). Bill 2026-05-08.
  const scored = [];
  for (let n = 1; n <= numRounds; n++) {
    const v = row['r' + n + '_score_total'];
    const st = row['r' + n + '_h_status'];
    if (v != null && Number.isFinite(Number(v)) && !st) {
      scored.push({ n, score: Number(v) });
    }
  }
  if (!scored.length) return null;
  const combined = row.combined_total != null ? Number(row.combined_total) : null;
  // Subset matching only applies to multi-round classes with combined.
  if (numRounds > 1 && combined != null && Number.isFinite(combined)) {
    const EPS = 0.5;
    let best = null;
    for (let bm = 1; bm < (1 << numRounds); bm++) {
      const subRounds = [];
      let subSum = 0;
      let bad = false;
      for (let rb = 0; rb < numRounds; rb++) {
        if (bm & (1 << rb)) {
          // Bill 2026-05-08: guard null AND status. Number(null) === 0
          // and Number.isFinite(0) === true, so null was being included
          // as 0 in the all-rounds subset. Same trap with status-set
          // rounds where r{N}_score_total is 0 by convention.
          const rRaw = row['r' + (rb + 1) + '_score_total'];
          const rSt  = row['r' + (rb + 1) + '_h_status'];
          if (rRaw == null || rSt) { bad = true; break; }
          const rv = Number(rRaw);
          if (!Number.isFinite(rv)) { bad = true; break; }
          subRounds.push(rb + 1);
          subSum += rv;
        }
      }
      if (bad) continue;
      if (Math.abs(subSum - combined) >= EPS) continue;
      if (!best
        || subRounds.length > best.rounds.length
        || (subRounds.length === best.rounds.length
            && subRounds[subRounds.length - 1] > best.rounds[best.rounds.length - 1])) {
        best = { rounds: subRounds, sum: subSum };
      }
    }
    if (best) {
      if (best.rounds.length === numRounds) {
        return { round: null, label: 'Overall', score: combined, isOverall: true };
      }
      const top = best.rounds[best.rounds.length - 1];
      return {
        round: top,
        label: 'R' + top,
        score: Number(row['r' + top + '_score_total']),
        isOverall: false,
      };
    }
  }
  // Fallback: highest-numbered scored round, never auto-promote to
  // Overall (matches the template's no-implicit-Overall rule).
  const top = scored[scored.length - 1];
  return { round: top.n, label: 'R' + top.n, score: top.score, isOverall: false };
}

// Find the on-course entry's most recent ROUND status and decode it.
// Looks at the highest-numbered round that has data (status or faults
// or score) — that's the round the operator was running when the
// status was set. Returns null if no terminating status is set
// (rider hasn't been eliminated/withdrawn/etc).
function _decodeOnCourseStatus(row, classKind) {
  if (!row) return null;
  // Pick the round with the most recent data — start from R3 down.
  // Hunter status field name is r{N}_h_status; jumper is r{N}_status.
  const statusKey = classKind === 'hunter' ? 'h_status' : 'status';
  for (let n = 3; n >= 1; n--) {
    const code = row['r' + n + '_' + statusKey];
    if (!code) continue;
    const norm = String(code).trim().toUpperCase();
    const meta = STATUS_CODES[norm];
    if (meta) return { code: norm, label: meta.label, category: meta.category, full: meta.full };
    // Unknown code — surface raw so the page can at least show it.
    return { code: norm, label: norm, category: null, full: norm };
  }
  return null;
}

// S46 LIVE thresholds (Bill 2026-05-06 spec).
//   LIVE_PAIR_WINDOW_MS — max delta between B+{29}=X and matching intro
//     frame for class X to count as the explicit "horse in ring" trigger.
//   LIVE_PAIR_STALE_MS  — how long a half-pair (B-only or intro-only) is
//     held in this.pendingLive before being discarded.
//   RING_LIVE_TIMEOUT_MS — a class without any UDP for this long flips
//     un-live with reason='timeout'. Survives ribbon ceremonies and
//     coursewalks; Bill: "30 min time out" matches the existing
//     stagnant-class drop window in _buildSnapshot.
const LIVE_PAIR_WINDOW_MS  = 1000;
const LIVE_PAIR_STALE_MS   = 5000;
const RING_LIVE_TIMEOUT_MS = 30 * 60 * 1000;
// Bill 2026-05-06: brief blackout after a manual Flush so the trailing
// .cls write that fires when a class closes (engine watching the file
// system) doesn't immediately re-light a class via the cls_lock path.
// Doesn't affect the explicit B+intro live trigger — operator's
// deliberate "make this live" action always works.
const FLUSH_COOLDOWN_MS = 15 * 1000;
export class RingStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.snapshot = null;
    // Multi-class store (S45 — Bill 2026-05-03): one entry per concurrently-
    // open class on this ring, keyed by class_id. Each entry holds that
    // class's own meta + standings + last_seen_at. The top-level snapshot
    // tracks only the FOCUSED class for backwards compat; the multi-class
    // panel stack on live.html reads .classes (sorted by recency).
    this.byClass = {};
    // S46 LIVE-trigger state (Bill 2026-05-06).
    // pendingLive: rolling per-class pair detector. A B+{29}=X click and a
    // matching intro frame (jumper fr=1 / hunter fr=11) for class X within
    // 1000ms = the explicit "horse is now in the ring" signal. Both halves
    // can land in the same batch or across batches; we hold pending halves
    // for up to LIVE_PAIR_STALE_MS so a B in one batch + intro in the
    // next still fire. In-memory only — DO eviction loses pending pairs;
    // operator just re-clicks and the next intro re-fires the trigger.
    this.pendingLive = {};
    // ringOpenSegment: the in-flight ring_live_segment row. NULL when ring
    // is un-live. { d1_id, started_at, classes_seen: [classId, ...] }.
    // Persisted into the snapshot so warmUp() can restore it after DO
    // eviction; an open D1 row is the secondary source of truth (recovery
    // also reads D1 if the snapshot doesn't carry it).
    this.ringOpenSegment = null;
    // Manual focus override (Bill 2026-05-06 — engine right-click "Make
    // Focus"). When set, _focusedClassId returns this in preference to
    // the natural Channel B / Channel A sources. Cleared automatically
    // when a Channel B focus event arrives for a DIFFERENT class so the
    // operator's next Ryegate click takes back over normally. Persisted
    // into the snapshot so warmUp restores it after DO eviction.
    this.forcedFocusClassId = null;
  }

  // Helper — pick the focused class id.
  //
  // PRIORITY (Bill 2026-05-07, refined): the focus trigger is the
  // B+intro pair within LIVE_PAIR_WINDOW_MS — operator clicks Channel
  // B AND a fr=1/11 intro frame arrives within ~1s. A bare Channel B
  // click (operator browsing classes) is NOT enough to commit focus;
  // the public live page sat at "old number / new name" because the
  // chip read from one channel and the name from the other. By gating
  // on the same pair the live trigger uses, we make focus a single
  // atomic event — chip, name, panel routing all flip together.
  //
  // Most-recently-locked-live-class wins. byClass[X].is_live + its
  // last_live_event_at timestamp track when the pair fired for X;
  // this picks the latest. Falls back to the eager Channel B / A
  // chain only when no class has locked yet (cold session).
  //
  // Channel B with {29}="F" is a finalize-click only — skip it so
  // finalizing class B while focused on class A doesn't pull focus.
  _focusedClassId(body) {
    // Manual override wins over any natural source. Stays sticky until
    // the operator's NEXT Channel B click on a DIFFERENT class clears
    // it (handled in /event handler).
    if (this.forcedFocusClassId && this.byClass[this.forcedFocusClassId]) {
      return this.forcedFocusClassId;
    }
    // Pair-gated: most recently locked-live class.
    let lockedId = null;
    let lockedTs = 0;
    for (const cid of Object.keys(this.byClass)) {
      const c = this.byClass[cid];
      if (!c || !c.is_live) continue;
      const ts = c.last_live_event_at || c.live_since || 0;
      if (ts > lockedTs) { lockedTs = ts; lockedId = c.class_id || cid; }
    }
    if (lockedId) return lockedId;
    // Eager fallbacks only when no class has paired yet — first focus
    // of a fresh session, or all live classes have un-lived (timeout /
    // FINAL / clear). Channel B without a paired intro is a "browsing"
    // signal, but we still need SOMETHING for the page to render before
    // the first pair lands.
    if (body.last_focus && body.last_focus.class_id) {
      const tag29 = ((body.last_focus.tags || {})['29'] || '')
        .replace(/\r/g, '').trim().toUpperCase();
      if (tag29 !== 'F') return body.last_focus.class_id;
    }
    if (body.last_scoring && body.last_scoring.class_id) {
      return body.last_scoring.class_id;
    }
    if (body.class_meta && body.class_meta.class_id) {
      return body.class_meta.class_id;
    }
    if (this.snapshot && this.snapshot.focused_class_id) {
      return this.snapshot.focused_class_id;
    }
    return null;
  }

  // Helper — build the public snapshot view from the in-memory state.
  // Keeps the top-level shape unchanged for backwards compat, plus new
  // fields focused_class_id + classes (sorted most-recently-seen first).
  //
  // Stale-class eviction (Bill 2026-05-03): drop any class whose
  // last_seen_at is more than CLASS_STALE_MS in the past. The class
  // re-appears in the panel stack the next time a 31000 focus packet
  // (or any event referencing it) arrives.
  //
  // IMPORTANT: This is UI hygiene only — it does NOT mark the class as
  // final/complete. The class's D1 status stays untouched and no
  // downstream "class complete" actions fire. A class is only marked
  // final when the explicit 3× Ctrl+A → CLASS_COMPLETE signal arrives
  // on port 31000 (wiring TBD). A 20-min idle class might be paused
  // (operator at lunch, weather hold) and could resume — eviction is
  // purely about keeping the live panel stack tidy.
  _buildSnapshot(body) {
    // Class lifecycle on the live page:
    //   • Non-final classes evict 20 min after last_seen_at (idle)
    //   • Final classes hold "full" panel for 60 SECONDS from finalized_at
    //     (Bill 2026-05-06: was 10 min; tightened so any finalized class
    //     — focused or in the multi-class stack — collapses to the slim
    //     Recent Results bar / "View Final Results" CTA quickly.)
    //   • Then collapse (60s-30min after finalized_at)
    //   • Then drop entirely (>30min after finalized_at)
    const NON_FINAL_STALE_MS = 20 * 60 * 1000;
    const FINAL_FULL_MS      = 60 * 1000;        // 0-60s: full panel
    const FINAL_DROP_MS      = 30 * 60 * 1000;   // 30min+:  remove
    const now = Date.now();
    // S46 — sweep live-class timeouts BEFORE the lifecycle eviction so
    // a class that drops via NON_FINAL_STALE still records its un-live
    // transition. Reason='timeout', went_unlive_at = actual last UDP.
    this._sweepLiveTimeouts();
    for (const id of Object.keys(this.byClass)) {
      const c = this.byClass[id];
      const seenAt = Date.parse(c.last_seen_at || '');
      const finalAt = Date.parse(c.finalized_at || '');
      if (c.is_final && Number.isFinite(finalAt)) {
        if (now - finalAt > FINAL_DROP_MS) { delete this.byClass[id]; continue; }
        c.lifecycle_state = (now - finalAt > FINAL_FULL_MS) ? 'collapsed' : 'full';
      } else {
        if (Number.isFinite(seenAt) && (now - seenAt) > NON_FINAL_STALE_MS) {
          delete this.byClass[id]; continue;
        }
        c.lifecycle_state = 'full';
      }
    }
    // Bill 2026-05-06: a class only earns a panel on the public live
    // page once the LIVE trigger pair has fired (B+intro within 1s) at
    // least once for it. Bare Channel B clicks (or any other lone UDP
    // touch) populate byClass internally for tracking, but they do NOT
    // surface on live.html. Filter:
    //   • is_live  — currently live (pair fired and not yet un-lived)
    //   • live_since — was live at some point (entry survived un-live)
    //   • is_final — explicitly finalized (operator marked complete)
    const classes = Object.values(this.byClass)
      .filter(c => c && (c.is_live || c.live_since != null || c.is_final))
      .sort((a, b) =>
        String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
      .map(c => Object.assign({}, c, { pill: this._buildClassPill(c) }));
    const focusedId = this._focusedClassId(body);
    // Surface the persisted is_final / finalized_at for the focused
    // class at the top level. Sourced PURELY from byClass state so
    // a finalize-click for a non-focused class doesn't inflate the
    // focused class's pill (the per-event Channel-B-with-F loop sets
    // is_final on the right class regardless of focus).
    const focusedEntry = focusedId ? this.byClass[focusedId] : null;
    // S46 — ring-wide is_live = ANY class on this ring is_live.
    // live_since = earliest live_since across the live classes (ring's
    // current segment start). live_class_ids = the actual list, so
    // public consumers (and the engine UI) can render per-class pills.
    const liveClassIds = [];
    let earliestLiveSince = null;
    for (const c of classes) {
      if (c && c.is_live) {
        liveClassIds.push(c.class_id);
        const ls = Number(c.live_since) || 0;
        if (ls && (!earliestLiveSince || ls < earliestLiveSince)) earliestLiveSince = ls;
      }
    }
    // Top-level class_meta reflects the FOCUSED class, sourced from its
    // byClass entry (which is now correctly per-class after the routing
    // change in /event). Body.class_meta is the LENS class meta which
    // might be a different class — falling back to it would re-introduce
    // the data-mismatch bug. Bill 2026-05-06.
    const focusedClassMeta = (focusedEntry && focusedEntry.class_meta) || null;
    const focusedClassKind = (focusedEntry && focusedEntry.class_kind) || body.class_kind || null;
    // Bill 2026-05-07: when every class on the ring has timed out
    // (RING_LIVE_TIMEOUT_MS or operator cleared / FINAL'd them all),
    // also flush the top-level identity/focus carry-forward. Without
    // this the public M4 live box keeps showing the last rider's
    // entry/horse/rider/clock for hours after the ring went silent —
    // body.last_identity / last_scoring / last_focus from the prior
    // batch carry through the spread below, and focus_preview gets
    // built from the focusedEntry's stale tags. Mirrors the same
    // "ring is idle → wipe" behavior we already do per-class
    // (previous_entry cleared on timeout, classes filtered out of
    // snapshot.classes when not is_live/live_since/is_final).
    const ringHasLiveClass = liveClassIds.length > 0;
    return {
      ...body,
      class_meta: ringHasLiveClass ? focusedClassMeta : null,
      class_kind: ringHasLiveClass ? focusedClassKind : null,
      focused_class_id: ringHasLiveClass ? focusedId : null,
      // Identity/scoring/focus carry-forward — null when ring idle.
      last_identity: ringHasLiveClass ? body.last_identity : null,
      last_scoring:  ringHasLiveClass ? body.last_scoring  : null,
      last_focus:    ringHasLiveClass ? body.last_focus    : null,
      is_final: ringHasLiveClass && !!(focusedEntry && focusedEntry.is_final === true),
      finalized_at: ringHasLiveClass && focusedEntry ? (focusedEntry.finalized_at || null) : null,
      // Top-level pill descriptor — mirrors the focused class's pill so
      // pages can render header status without recomputing. Per-class
      // pills live on each entry in `classes[]`. Bill 2026-05-08.
      pill: ringHasLiveClass && focusedEntry ? this._buildClassPill(focusedEntry) : null,
      // Sticky most-recent-completed entry for the focused class.
      // Consumers (live page "Just Finished" banner, future scoreboard
      // views, etc.) read this directly without client-side detection.
      previous_entry: ringHasLiveClass && focusedEntry ? (focusedEntry.previous_entry || null) : null,
      // S46 — ring-wide live state. is_live=true means at least one
      // class on this ring is currently live (operator clicked B+{29}
      // and an intro frame fired within 1s). live_since is the start
      // of the current ring segment. live_class_ids enumerates which
      // classes are live so the engine UI + public pages can show pills.
      is_live: liveClassIds.length > 0,
      live_since: earliestLiveSince,
      live_class_ids: liveClassIds,
      // ring_open_segment is persisted into KV so warmUp() can restore
      // it after DO eviction without going to D1 first. Spectator pages
      // don't need it — it's an internal state-passing field.
      ring_open_segment: this.ringOpenSegment,
      // Manual focus override — same persistence rationale.
      forced_focus_class_id: this.forcedFocusClassId,
      classes,
      // S46 — small peek for the engine UI mirroring what the public
      // live box is showing right now. Pulled from the focused class's
      // last_identity (entry/horse/rider) + last_scoring (rank/faults/
      // clock). Engine renders this as a read-only "what public sees"
      // card. Null when nothing's focused or when the ring is idle
      // (every class timed out — see ringHasLiveClass above).
      focus_preview: ringHasLiveClass ? this._buildFocusPreview(focusedEntry) : null,
    };
  }

  // S46 — build the engine's focus preview from the focused class's
  // most recent identity + scoring frames. Tags are pulled raw so the
  // engine can show what the operator is actually seeing on the public
  // live box without re-deriving phase rules. (Bill 2026-05-06.)
  // Pill descriptor for a class — single source of truth for the
  // status pill + progress text shown on live, ring display, and any
  // future scoreboard surface. Bill 2026-05-08: "all worker side we
  // will use this on other displays."
  //
  // Returns { state, label, progress, total, remaining }:
  //   state    — 'final' | 'inring' | 'open'
  //   label    — 'FINAL' | 'In Ring' | 'Open'  (display string)
  //   progress — 'N of M remaining' or null when FINAL / no roster
  //   total    — total entry count (excluding DNS-like)
  //   remaining— entries with NO score data + NO terminating status
  _buildClassPill(classEntry) {
    if (!classEntry) return null;
    const isFinal = !!classEntry.is_final;
    const isLive = !!classEntry.is_live;
    const state = isFinal ? 'final' : isLive ? 'inring' : 'open';
    const label = isFinal ? 'FINAL' : isLive ? 'In Ring' : 'Open';
    // Progress count — entries that have NOT yet started (no score on
    // any round, no status set). Once R1 is scored OR a terminating
    // status (EL/RF/RT/WD) lands, the entry is "done" for progress
    // purposes. Multi-round classes use round-1 progress; round 2 will
    // get its own counter when we wire it.
    const scores = classEntry.class_kind === 'hunter'
      ? (classEntry.hunter_scores || [])
      : (classEntry.jumper_scores || []);
    let total = 0, remaining = 0;
    for (const e of scores) {
      // Skip rows that don't represent a real entry (DNS-like).
      if (!e || !e.entry_num) continue;
      total += 1;
      const hasScore = e.r1_score_total != null
        || e.r1_total_faults != null
        || e.r1_total_time != null
        || e.r1_h_status || e.r1_status;
      if (!hasScore) remaining += 1;
    }
    // Progress counts UP — entries that have GONE so far, of total.
    // Pages render a two-line stack:
    //
    //   27 of 40
    //   GONE
    //
    // Both null when FINAL or empty roster — pill alone tells the story.
    const gone = total - remaining;
    const progress = isFinal || total === 0
      ? null
      : gone + ' of ' + total;
    const progress_label = progress ? 'Gone' : null;
    return { state, label, progress, progress_label, total, remaining, gone };
  }

  _buildFocusPreview(focusedEntry) {
    if (!focusedEntry) return null;
    const ident = focusedEntry.last_identity || null;
    const scoring = focusedEntry.last_scoring || null;
    const iTags = (ident && ident.tags) || {};
    const sTags = (scoring && scoring.tags) || {};
    const grab = (t, k) => ((t && t[k]) || '').replace(/\r/g, '').trim() || null;
    const onCourseEntryNum = grab(iTags, '1') || grab(sTags, '1');
    // Bill 2026-05-06: lift the on-course entry's status code (E/RF/HF/
    // RT/WD/etc) to focus_preview so the live page M4 + commentator
    // strip can show "ELIM" / "WD" / "RT" badges without re-deriving
    // status rules client-side. UDP fr=1 doesn't carry status — pulled
    // from the entry's row in jumper_scores / hunter_scores (D1-fed).
    let statusInfo = null;
    if (onCourseEntryNum) {
      const scoresArr = (focusedEntry.class_kind === 'hunter')
        ? (focusedEntry.hunter_scores || [])
        : (focusedEntry.jumper_scores || []);
      const row = scoresArr.find(r => String(r.entry_num) === String(onCourseEntryNum));
      if (row) statusInfo = _decodeOnCourseStatus(row, focusedEntry.class_kind);
    }
    return {
      class_id: focusedEntry.class_id || null,
      class_name: (focusedEntry.class_meta && focusedEntry.class_meta.class_name) || null,
      class_kind: focusedEntry.class_kind || null,
      is_live: !!focusedEntry.is_live,
      is_final: !!focusedEntry.is_final,
      entry_num: onCourseEntryNum,
      horse: grab(iTags, '2'),
      rider: grab(iTags, '3') || grab(iTags, '7'),
      rank: grab(sTags, '8'),
      label_or_ta: grab(sTags, '13'),
      jump_faults: grab(sTags, '14'),
      time_faults: grab(sTags, '15'),
      clock: grab(sTags, '17'),
      target_time: grab(sTags, '18'),
      countdown: grab(sTags, '23'),
      last_frame: scoring && Number.isFinite(scoring.frame) ? scoring.frame : null,
      // status_code = raw 2-letter code (E/RF/HF/OC/RO/DQ/RT/WD/...)
      // status_label = display label ("EL" collapses RF/HF/OC/RO/DQ/E)
      // status_category = 'ELIM' | 'PARTIAL' | 'DNS' | null
      // status_full = human-readable ("Eliminated", "Withdrew", etc)
      // null when on-course entry has no terminating status — page
      // shows clock/faults as normal.
      status_code:     statusInfo ? statusInfo.code     : null,
      status_label:    statusInfo ? statusInfo.label    : null,
      status_category: statusInfo ? statusInfo.category : null,
      status_full:     statusInfo ? statusInfo.full     : null,
      previous_entry: focusedEntry.previous_entry || null,
    };
  }

  // Helper — fold this batch's class-specific data into byClass[classId].
  // Carries forward the prior entry's standings if the new batch only had
  // Channel B (focus) frames — same rationale as the top-level carry-forward.
  // Build a flat previous_entry record from a scoring row. Picks the
  // LATEST scored round (3 → 2 → 1) so jump-off / multi-round results
  // surface correctly, not just R1. Returns null if the row has no
  // scoring data.
  //
  // Bill 2026-05-07: status (EL/RF/RT/WD) is also a valid round-attribution
  // signal — a fallen rider has no time/faults/score but the round the fall
  // happened in is still known. Without this the just-finished banner went
  // blank when an on-course rider got eliminated.
  _buildPrevEntry(row, classKind, classMeta) {
    if (!row) return null;
    const statusKey = classKind === 'hunter' ? 'h_status' : 'status';
    let round = null;
    for (let n = 3; n >= 1; n--) {
      const tf = row['r' + n + '_total_faults'];
      const tt = row['r' + n + '_total_time'];
      const sc = row['r' + n + '_score_total'];
      const st = row['r' + n + '_' + statusKey];
      if (tf != null || tt != null || sc != null || st) { round = n; break; }
    }
    if (round == null) {
      // Hunter-only fallback (forced classes have only current_place).
      if (row.current_place == null && row.overall_place == null) return null;
    }
    const r = round || 1;
    const statusInfo = _decodeOnCourseStatus(row, classKind);
    // Hunter "displayed round" — Overall vs R1/R2/R3 — derived once
    // server-side via combined-total subset matching. The just-
    // finished banner reads displayed_round_label + displayed_score
    // directly instead of patching together fallbacks. Bill 2026-05-08.
    const displayed = (classKind === 'hunter')
      ? _decodeHunterDisplayedRound(row, classMeta || {})
      : null;
    // Per-round score breakdown for hunters — banner shows R1/R2/R3 +
    // Overall when a multi-round class is past round 1. Bill 2026-05-08.
    // Skip rounds that ended in a terminating status (EL/RF/RT/WD) —
    // their r{N}_score_total is 0 by convention but it isn't a real
    // score; the status branch in the banner surfaces it correctly.
    let hunterRounds = null;
    if (classKind === 'hunter') {
      const numRounds = Math.max(1, Math.min(3, Number((classMeta || {}).num_rounds) || 1));
      hunterRounds = [];
      for (let n = 1; n <= numRounds; n++) {
        const sc = row['r' + n + '_score_total'];
        const st = row['r' + n + '_h_status'];
        if (sc != null && Number.isFinite(Number(sc)) && !st) {
          hunterRounds.push({ n, label: 'R' + n, score: Number(sc) });
        }
      }
    }
    // Banner slots — what the just-finished banner should render. Worker
    // decides shape (EL / multi-round hunter / single-round hunter /
    // jumper); page just iterates and renders. Single source of truth.
    // Bill 2026-05-08: "this shouldn't have been this hard keep it simple."
    const fmtScore = (v) => {
      if (v == null) return '—';
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      return parseFloat(n.toFixed(2)).toString();
    };
    const rankFor = () => {
      if (classKind === 'hunter') {
        return row.current_place != null ? String(row.current_place)
             : row.overall_place != null ? String(row.overall_place)
             : '—';
      }
      return row.overall_place != null ? String(row.overall_place) : '—';
    };
    let bannerSlots = [];
    if (statusInfo) {
      bannerSlots = [
        { label: classKind === 'hunter' ? 'Status' : 'F',     value: statusInfo.label },
        { label: classKind === 'hunter' ? 'Reason' : 'Time',  value: statusInfo.full || statusInfo.label },
        { label: 'Rank', value: rankFor() },
      ];
    } else if (classKind === 'hunter') {
      const rounds = hunterRounds || [];
      // Per-judge slots — multi-judge classes include each judge's
      // score for the LATEST released round (base, plus +hi-opt and
      // +handy bonuses for derbies). Single-judge classes skip.
      // Bill 2026-05-08.
      const nJ = Math.max(1, Number((classMeta || {}).num_judges) || 1);
      const isDerby = (classMeta || {}).class_mode === 2;
      const judgeSlots = [];
      if (nJ > 1 && Array.isArray(row.judges) && row.judges.length && rounds.length) {
        const latestRound = rounds[rounds.length - 1].n;
        for (let ji = 0; ji < nJ; ji++) {
          const j = row.judges.find(x => x.round === latestRound && x.idx === ji);
          if (!j || j.base == null) {
            judgeSlots.push({ label: 'J' + (ji + 1), value: '—' });
            continue;
          }
          let v = fmtScore(j.base);
          if (isDerby) {
            if (j.hiopt != null && Number(j.hiopt) > 0) v += '+' + Number(j.hiopt).toFixed(0);
            if (j.handy != null && Number(j.handy) > 0) v += '+' + Number(j.handy).toFixed(0);
          }
          judgeSlots.push({ label: 'J' + (ji + 1), value: v });
        }
      }
      if (rounds.length >= 2) {
        bannerSlots = rounds.map(rr => ({ label: rr.label, value: fmtScore(rr.score) }));
        bannerSlots.push({ label: 'Overall', value: fmtScore(row.combined_total), emphasize: true });
        bannerSlots = bannerSlots.concat(judgeSlots);
        bannerSlots.push({ label: 'Rank', value: rankFor() });
      } else if (rounds.length === 1) {
        bannerSlots = [{ label: 'Score', value: fmtScore(rounds[0].score), emphasize: true }];
        bannerSlots = bannerSlots.concat(judgeSlots);
        bannerSlots.push({ label: 'Rank', value: rankFor() });
      }
    } else {
      // Jumper / equitation
      const tf = row['r' + r + '_total_faults'];
      const tt = row['r' + r + '_total_time'];
      bannerSlots = [
        { label: 'F',    value: tf != null ? String(tf) : '—' },
        { label: 'Time', value: tt != null ? Number(tt).toFixed(3) : '—' },
        { label: 'Rank', value: rankFor() },
      ];
    }
    return {
      entry_num: row.entry_num,
      horse_name: row.horse_name || null,
      rider_name: row.rider_name || null,
      owner_name: row.owner_name || null,
      round: round,
      // Latest-round flat fields (consumers read these directly).
      faults: row['r' + r + '_total_faults'] != null ? row['r' + r + '_total_faults'] : null,
      time:   row['r' + r + '_total_time']   != null ? row['r' + r + '_total_time']   : null,
      jump_faults: row['r' + r + '_jump_faults'] != null ? row['r' + r + '_jump_faults'] : null,
      time_faults: row['r' + r + '_time_faults'] != null ? row['r' + r + '_time_faults'] : null,
      score_total: row['r' + r + '_score_total'] != null ? row['r' + r + '_score_total'] : null,
      // Backward-compat: keep r1_* aliases so existing consumers don't break.
      r1_total_faults: row.r1_total_faults != null ? row.r1_total_faults : null,
      r1_total_time:   row.r1_total_time   != null ? row.r1_total_time   : null,
      r1_jump_faults:  row.r1_jump_faults  != null ? row.r1_jump_faults  : null,
      r1_time_faults:  row.r1_time_faults  != null ? row.r1_time_faults  : null,
      r1_score_total:  row.r1_score_total  != null ? row.r1_score_total  : null,
      combined_total:  row.combined_total  != null ? row.combined_total  : null,
      overall_place:   row.overall_place   != null ? row.overall_place   : null,
      current_place:   row.current_place   != null ? row.current_place   : null,
      // Status (kept for pages that filter on category, etc).
      status_code:     statusInfo ? statusInfo.code     : null,
      status_label:    statusInfo ? statusInfo.label    : null,
      status_category: statusInfo ? statusInfo.category : null,
      status_full:     statusInfo ? statusInfo.full     : null,
      // Hunter — what the operator actually displayed.
      displayed_round_label: displayed ? displayed.label : null,
      displayed_score:       displayed ? displayed.score : null,
      displayed_is_overall:  displayed ? !!displayed.isOverall : null,
      rounds: hunterRounds,
      // Judge data + signature — kept on pe so _samePrevEntry can
      // detect when judges arrive after the entry was first promoted
      // (judge rows are populated via /v3/postCls + pullHunterScoresV3,
      // which can land a moment AFTER the rider transition triggered
      // the initial promote → without this signature the banner_slots
      // would stay frozen without the J1/J2 cells).
      judges:    Array.isArray(row.judges) ? row.judges : null,
      judges_sig: Array.isArray(row.judges)
        ? row.judges.map(j => j.round + ':' + j.idx + ':' + j.base + ':' + (j.hiopt || 0) + ':' + (j.handy || 0)).join('|')
        : '',
      // Banner — pre-computed slot list. Page just iterates this.
      banner_slots: bannerSlots,
    };
  }

  // Returns true if two previous_entry records carry the same data
  // (entry + round + faults + time + place + status). finished_at and any
  // meta are ignored. Used to skip pointless re-promotions. Status is in
  // the comparison so a clean→EL flip on the SAME entry/round still
  // triggers the banner update (the rider's status is what changed, even
  // if their place / time / faults stayed null on both sides).
  _samePrevEntry(a, b) {
    if (!a || !b) return false;
    return String(a.entry_num) === String(b.entry_num)
      && a.round === b.round
      && a.faults === b.faults
      && a.time === b.time
      && a.overall_place === b.overall_place
      && a.current_place === b.current_place
      && (a.status_code || null) === (b.status_code || null)
      // Hunter — Overall release doesn't bump round number but does
      // change combined_total + displayed_round_label. Compare both
      // so a R2-only → Overall flip on the same entry re-promotes.
      && (a.combined_total || null) === (b.combined_total || null)
      && (a.displayed_round_label || null) === (b.displayed_round_label || null)
      // Judges arrive a tick after the rider transition. Without this
      // the J1/J2 cells never get added to banner_slots once the
      // initial empty-judges promote was deduped.
      && (a.judges_sig || '') === (b.judges_sig || '');
  }

  _updateByClass(body) {
    const classId = this._focusedClassId(body);
    if (!classId) return;
    const prior = this.byClass[classId] || {};

    // Previous-entry tracking (Bill 2026-05-06): the most recently
    // SCORED entry per class. Promotion happens in two shapes:
    //
    //   (a) Same rider still on course, their scoring row updated:
    //       promote them — covers initial finish + multi-round (R1 →
    //       JO) cases.
    //   (b) On-course rider CHANGED (priorOnCourseEntry → new rider):
    //       promote the OUTGOING rider's row. The incoming rider is
    //       NOT a candidate even if their row has prior-round data.
    //
    // Bill 2026-05-08: previously the code always evaluated
    // _buildPrevEntry on the CURRENT on-course entry's row. When a new
    // rider came on course with R1 already scored from earlier in the
    // class, they got promoted as previous_entry — banner switched to
    // show whoever just walked into the ring instead of the rider who
    // just finished. Worker-owned; pages just read previous_entry.
    const newId = body.last_identity || prior.last_identity || null;
    const newOnCourseEntry = newId && newId.tags
      ? String((newId.tags['1'] || '')).replace(/\r/g, '').trim()
      : '';
    const priorOnCourseEntry = prior.last_identity && prior.last_identity.tags
      ? String((prior.last_identity.tags['1'] || '')).replace(/\r/g, '').trim()
      : '';
    let previousEntry = prior.previous_entry || null;
    // Skip repopulate when class is FINAL — Bill 2026-05-06: the FINAL
    // handler upstream nulls previous_entry, but without this gate the
    // still-present last_identity + scoring row immediately rebuild it
    // on the very next batch.
    // Bill 2026-05-08: pe is now promoted EXCLUSIVELY by /scores-update.
    // _updateByClass fires from /v3/postUdpEvent which runs BEFORE
    // /v3/postCls has written fresh row data — any promote here used
    // stale prior.hunter_scores and produced a visible flash of
    // single-round state before /scores-update refined it. Removed
    // both case (a) [same rider] and case (b) [transition].
    //
    // Trade-off: brief gap between rider transition and the next
    // /scores-update (where pe stays on the prior promoted entry).
    // The gap is bounded by .cls write latency (~few hundred ms).
    // Single visible update per operator press wins over a snappier-
    // but-flashy transition.
    //
    // priorOnCourseEntry / newOnCourseEntry kept declared above for
    // diagnostic visibility; intentionally unused here.
    void priorOnCourseEntry; void newOnCourseEntry;

    this.byClass[classId] = {
      class_id: classId,
      class_kind: body.class_kind || prior.class_kind || null,
      // Bill 2026-05-06: only adopt body.class_meta when it's actually
      // FOR this class (matches by class_id stamp). The route fetches
      // meta for the LAST event's class_id, which can be different
      // from the focused class — we don't want lens-class meta poisoning
      // a different focused class's entry. Routing of class_meta to
      // its own byClass entry happens separately in /event handler.
      class_meta: (body.class_meta && String(body.class_meta.class_id) === String(classId))
        ? body.class_meta
        : (prior.class_meta || null),
      // Bill 2026-05-08: scores are routed by LENS CLASS — body.
      // jumper_scores / hunter_scores belong to whatever class the
      // last UDP event was for (lensClassId in /v3/postUdpEvent),
      // NOT necessarily the focused class. Same trap class_meta hit
      // (fixed earlier). Only adopt body scores when the lens class
      // matches the focused class. Otherwise keep prior — the
      // focused class's actual scores live there from its own
      // /v3/postCls + /scores-update path. body.class_meta.class_id
      // carries the lens class as a proxy.
      //
      // PLUS empty-overwrite guard: even when lens IS focused, a
      // mid-sweep pullJumperScoresV3 can return [] transiently. Keep
      // populated prior over an incoming empty.
      jumper_scores: pickScores(body.jumper_scores, prior.jumper_scores, body.class_meta, classId),
      hunter_scores: pickScores(body.hunter_scores, prior.hunter_scores, body.class_meta, classId),
      hunter_seen:   body.hunter_seen   !== undefined ? body.hunter_seen   : (prior.hunter_seen   || null),
      last_scoring:  body.last_scoring  || prior.last_scoring  || null,
      last_focus:    body.last_focus    || prior.last_focus    || null,
      last_identity: body.last_identity || prior.last_identity || null,
      is_final:      prior.is_final     || false,
      finalized_at:  prior.finalized_at || null,
      // S46 — preserve live-state fields across batches. _processLiveTriggers
      // runs BEFORE _updateByClass and writes is_live/live_since to byClass;
      // without these explicit carries the spread-overwrite below would
      // wipe them on the very next batch (engine "Not live" bug 2026-05-06).
      is_live:             prior.is_live === true,
      live_since:          prior.live_since || null,
      live_trigger:        prior.live_trigger || null,
      last_live_event_at:  prior.last_live_event_at || null,
      went_unlive_at:      prior.went_unlive_at || null,
      unlive_reason:       prior.unlive_reason || null,
      previous_entry: previousEntry,
      last_seen_at:  body.received_at   || new Date().toISOString(),
    };
  }

  // Read KV into this.snapshot if we don't have it yet. Used on cold-DO
  // first event AND on cold-DO first WS connect — keeps the in-memory
  // snapshot in sync with the durable mirror across evictions.
  async warmUp(slug, ringNum) {
    if (this.snapshot) return;
    try {
      const raw = await this.env.WEST_LIVE.get(`ring-state:${slug}:${ringNum}`);
      if (raw) {
        this.snapshot = JSON.parse(raw);
        // Restore byClass from the persisted classes array so the DO can
        // continue accumulating per-class state across evictions.
        if (Array.isArray(this.snapshot.classes)) {
          for (const c of this.snapshot.classes) {
            if (c && c.class_id) this.byClass[c.class_id] = c;
          }
        }
        // Restore in-flight ring segment so we don't open a duplicate row
        // when the next event arrives. If the snapshot has it, trust it.
        if (this.snapshot.ring_open_segment) {
          this.ringOpenSegment = this.snapshot.ring_open_segment;
        }
        if (this.snapshot.forced_focus_class_id) {
          this.forcedFocusClassId = this.snapshot.forced_focus_class_id;
        }
      }
    } catch (e) {
      console.log(`[RingStateDO/warmUp] KV read failed: ${e.message}`);
    }
    // D1 fallback for ring_open_segment: if KV didn't have it but D1 has
    // an open row for this ring, restore it. Then forensic-close if the
    // last_event_at is older than RING_LIVE_TIMEOUT_MS — operator walked
    // away before DO evicted, and the ring is no longer live.
    if (!this.ringOpenSegment && slug && ringNum != null) {
      try {
        const row = await this.env.WEST_DB_V3.prepare(
          'SELECT id, started_at, last_event_at FROM ring_live_segment ' +
          'WHERE show_slug = ? AND ring_num = ? AND ended_at IS NULL ' +
          'ORDER BY id DESC LIMIT 1'
        ).bind(slug, Number(ringNum)).first();
        if (row && row.id) {
          const lastAt = Number(row.last_event_at) || 0;
          const stale = (Date.now() - lastAt) > RING_LIVE_TIMEOUT_MS;
          if (stale) {
            await this.env.WEST_DB_V3.prepare(
              'UPDATE ring_live_segment SET ended_at = ?, ended_reason = ? WHERE id = ?'
            ).bind(lastAt, 'recovery_close', row.id).run();
          } else {
            this.ringOpenSegment = {
              d1_id: row.id,
              started_at: Number(row.started_at) || 0,
              classes_seen: [],
            };
          }
        }
      } catch (e) {
        console.log(`[RingStateDO/warmUp] D1 segment recovery failed: ${e.message}`);
      }
    }
  }

  // S46 LIVE detection — scan this batch's events for the B+intro pair.
  // Channel B with {29}=<class_id> (no F) is the operator focus click;
  // matching intro frame is fr=1 (jumper) or fr=11 (hunter). When both
  // exist for the same class within LIVE_PAIR_WINDOW_MS, the class
  // transitions to is_live=true. Cross-batch tolerant via this.pendingLive.
  // Always called BEFORE FINAL processing in the batch — but we re-check
  // is_final after to handle the rare same-batch B+intro→FINAL race.
  _processLiveTriggers(body) {
    const events = body.events || [];
    if (!events.length) return;
    const now = Date.now();
    // Sweep stale pending halves first (older than the window + grace).
    for (const cid of Object.keys(this.pendingLive)) {
      const p = this.pendingLive[cid];
      const focusOld = !p.focusAt || (now - p.focusAt) > LIVE_PAIR_STALE_MS;
      const introOld = !p.introAt || (now - p.introAt) > LIVE_PAIR_STALE_MS;
      if (focusOld && introOld) delete this.pendingLive[cid];
    }
    // Collect halves from this batch.
    for (const e of events) {
      if (!e || !e.class_id) continue;
      const cid = String(e.class_id);
      const evAt = Date.parse(e.at) || now;
      if (e.channel === 'B') {
        const tag29 = ((e.tags && e.tags['29']) || '').replace(/\r/g, '').trim().toUpperCase();
        if (tag29 === 'F') continue; // FINAL click — handled elsewhere
        this.pendingLive[cid] = this.pendingLive[cid] || {};
        this.pendingLive[cid].focusAt = evAt;
      } else if (e.channel === 'A' && (e.frame === 1 || e.frame === 11)) {
        this.pendingLive[cid] = this.pendingLive[cid] || {};
        this.pendingLive[cid].introAt = evAt;
        this.pendingLive[cid].introFrame = e.frame;
      }
    }
    // Evaluate each pending pair.
    for (const cid of Object.keys(this.pendingLive)) {
      const p = this.pendingLive[cid];
      if (!p.focusAt || !p.introAt) continue;
      const delta = Math.abs(p.focusAt - p.introAt);
      if (delta > LIVE_PAIR_WINDOW_MS) continue;
      // Pair fires. Trigger transition.
      const triggerAt = Math.max(p.focusAt, p.introAt);
      const cls = this.byClass[cid] || (this.byClass[cid] = { class_id: cid });
      cls.last_live_event_at = triggerAt;
      if (!cls.is_live) {
        cls.is_live = true;
        cls.live_since = triggerAt;
        cls.live_trigger = 'intro+focus';
        cls.went_unlive_at = null;
        cls.unlive_reason = null;
      }
      delete this.pendingLive[cid];
    }
  }

  // Bump last_live_event_at for any live class that has events in this
  // batch. Keeps the timeout from firing during long classes (each event
  // is a heartbeat). Called after _processLiveTriggers so a fresh-live
  // class also gets its heartbeat bumped from this same batch.
  _bumpLiveHeartbeats(body) {
    const events = body.events || [];
    if (!events.length) return;
    const now = Date.now();
    const seen = new Set();
    for (const e of events) {
      if (!e || !e.class_id) continue;
      const cid = String(e.class_id);
      if (seen.has(cid)) continue;
      seen.add(cid);
      const cls = this.byClass[cid];
      if (!cls || !cls.is_live) continue;
      const evAt = Date.parse(e.at) || now;
      cls.last_live_event_at = Math.max(cls.last_live_event_at || 0, evAt);
    }
  }

  // Timeout sweep — run during _buildSnapshot. Any is_live class whose
  // last_live_event_at is older than RING_LIVE_TIMEOUT_MS flips un-live
  // with reason='timeout' and went_unlive_at = the actual last UDP we
  // got (NOT now — Bill's accuracy rule for the manager report).
  _sweepLiveTimeouts() {
    const now = Date.now();
    for (const id of Object.keys(this.byClass)) {
      const cls = this.byClass[id];
      if (!cls || !cls.is_live) continue;
      const last = Number(cls.last_live_event_at) || 0;
      if (last && (now - last) > RING_LIVE_TIMEOUT_MS) {
        cls.is_live = false;
        cls.went_unlive_at = last;
        cls.unlive_reason = 'timeout';
        // Bill 2026-05-06: timeout also clears the Just Finished
        // overlay — same rule as FINAL. A 30-min UDP-silent class
        // shouldn't keep the previous_entry banner pinned for
        // spectators looking at the live page.
        cls.previous_entry = null;
      }
    }
  }

  // Compute ring-wide live state from byClass and reconcile with the
  // in-flight ring_live_segment in D1. Called after every event/scores
  // update. Opens a new segment when ring transitions un-live → live;
  // closes the open segment when ring transitions live → un-live;
  // updates classes_run + last_event_at while a segment stays open.
  // manualUnliveHint = explicit { at, reason } passed by /class-action
  // when the un-live source isn't on a byClass entry (e.g. Clear/flush
  // deletes the entry first). Wins over scanned values if provided.
  async _reconcileRingSegment(slug, ringNum, manualUnliveHint) {
    if (!slug || ringNum == null) return;
    const liveClasses = [];
    let latestUnliveAt = 0;
    let latestUnliveReason = null;
    for (const id of Object.keys(this.byClass)) {
      const c = this.byClass[id];
      if (!c) continue;
      if (c.is_live) {
        liveClasses.push(c);
      } else if (c.went_unlive_at && c.went_unlive_at > latestUnliveAt) {
        latestUnliveAt = c.went_unlive_at;
        latestUnliveReason = c.unlive_reason || 'timeout';
      }
    }
    const anyLive = liveClasses.length > 0;
    const ringNumInt = Number(ringNum);

    // OPEN — ring just went live (no segment in flight).
    if (anyLive && !this.ringOpenSegment) {
      const startedAt = Math.min(...liveClasses.map(c => Number(c.live_since) || Date.now()));
      const seenIds = liveClasses.map(c => String(c.class_id));
      try {
        const res = await this.env.WEST_DB_V3.prepare(
          'INSERT INTO ring_live_segment (show_slug, ring_num, started_at, last_event_at, classes_run) ' +
          'VALUES (?, ?, ?, ?, ?)'
        ).bind(slug, ringNumInt, startedAt, startedAt, seenIds.length).run();
        const insertId = res && res.meta && res.meta.last_row_id;
        this.ringOpenSegment = {
          d1_id: insertId || null,
          started_at: startedAt,
          classes_seen: seenIds,
        };
      } catch (e) {
        console.log(`[RingStateDO] segment OPEN failed for ${slug}/${ringNumInt}: ${e.message}`);
      }
      return;
    }

    // STAY OPEN — bump heartbeat + record any newly-live classes.
    if (anyLive && this.ringOpenSegment) {
      const seenSet = new Set(this.ringOpenSegment.classes_seen || []);
      let added = false;
      for (const c of liveClasses) {
        const cid = String(c.class_id);
        if (!seenSet.has(cid)) { seenSet.add(cid); added = true; }
      }
      const seenArr = Array.from(seenSet);
      const heartbeat = Math.max(...liveClasses.map(c => Number(c.last_live_event_at) || 0));
      this.ringOpenSegment.classes_seen = seenArr;
      try {
        if (added) {
          await this.env.WEST_DB_V3.prepare(
            'UPDATE ring_live_segment SET last_event_at = ?, classes_run = ? WHERE id = ?'
          ).bind(heartbeat || Date.now(), seenArr.length, this.ringOpenSegment.d1_id).run();
        } else {
          await this.env.WEST_DB_V3.prepare(
            'UPDATE ring_live_segment SET last_event_at = ? WHERE id = ?'
          ).bind(heartbeat || Date.now(), this.ringOpenSegment.d1_id).run();
        }
      } catch (e) {
        console.log(`[RingStateDO] segment HEARTBEAT failed for ${slug}/${ringNumInt}: ${e.message}`);
      }
      return;
    }

    // CLOSE — ring just went un-live.
    if (!anyLive && this.ringOpenSegment) {
      const hintAt = manualUnliveHint && manualUnliveHint.at;
      const hintReason = manualUnliveHint && manualUnliveHint.reason;
      const endedAt = hintAt || latestUnliveAt || Date.now();
      const reason = hintReason || latestUnliveReason || 'timeout';
      try {
        await this.env.WEST_DB_V3.prepare(
          'UPDATE ring_live_segment SET ended_at = ?, ended_reason = ?, last_event_at = ? WHERE id = ?'
        ).bind(endedAt, reason, endedAt, this.ringOpenSegment.d1_id).run();
      } catch (e) {
        console.log(`[RingStateDO] segment CLOSE failed for ${slug}/${ringNumInt}: ${e.message}`);
      }
      this.ringOpenSegment = null;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /event — engine batch arriving via /v3/postUdpEvent route.
    if (request.method === 'POST' && url.pathname === '/event') {
      let body;
      try { body = await request.json(); }
      catch (e) { return new Response('Invalid JSON', { status: 400 }); }
      // Cold-DO restoration — without this, a freshly-constructed DO
      // (after Cloudflare's inactivity eviction) starts with byClass={}
      // and would lose every previously-open class on the first new
      // event. warmUp restores byClass from the last KV snapshot.
      // Skipped when this.snapshot is already set (warm DO; no-op).
      await this.warmUp(body.slug, body.ring_num);
      // Carry-forward cross-batch state — if this batch only had Channel B
      // events, last_scoring will be null even though we might have had
      // an on-course frame in the prior batch. Same for last_focus.
      // Without this, switching between batches would visually wipe the
      // panels. (S43 Chunk 12.)
      //
      // Bill 2026-05-06: bound the carry-forward to CARRY_STALE_MS so a
      // stale last_focus from earlier in the day doesn't pin the wrong
      // class as "focused" forever and prevent the lifecycle from
      // evicting it. Matches the non-final idle window — anything that
      // would have aged out of byClass also ages out of the carry sources.
      const CARRY_STALE_MS = 20 * 60 * 1000;
      const isFresh = function (ev) {
        if (!ev || !ev.at) return false;
        const t = Date.parse(ev.at) || 0;
        return t > 0 && (Date.now() - t) < CARRY_STALE_MS;
      };
      if (!body.last_scoring && this.snapshot && isFresh(this.snapshot.last_scoring)) {
        body.last_scoring = this.snapshot.last_scoring;
      }
      if (!body.last_focus && this.snapshot && isFresh(this.snapshot.last_focus)) {
        body.last_focus = this.snapshot.last_focus;
      }
      // Carry-forward last_identity ONLY when the focused class hasn't
      // changed — otherwise we'd surface the previous class's rider
      // during a class transition. Compares against either focus or
      // scoring class_id from the new batch. (S43 Chunk 18 fix.)
      if (!body.last_identity && this.snapshot && this.snapshot.last_identity) {
        const newFocusClassId =
          (body.last_focus   && body.last_focus.class_id) ||
          (body.last_scoring && body.last_scoring.class_id) || null;
        const carriedClassId = this.snapshot.last_identity.class_id || null;
        if (!newFocusClassId || newFocusClassId === carriedClassId) {
          body.last_identity = this.snapshot.last_identity;
        }
      }

      // Identify classes that received {29}=F in THIS batch — they're
      // exempt from the un-finalize loop below. F is the operator's
      // explicit FINAL command and ALWAYS wins (Bill 2026-05-06: "a
      // class should ALWAYS go final if that 31000 port has the F
      // command"). Pre-scanning lets the un-finalize loop run first and
      // skip these classes entirely.
      const finalizedThisBatch = new Set();
      for (const e of (body.events || [])) {
        if (!e || e.channel !== 'B' || !e.class_id) continue;
        const tag29 = ((e.tags && e.tags['29']) || '').replace(/\r/g, '').trim().toUpperCase();
        if (tag29 === 'F') finalizedThisBatch.add(String(e.class_id));
      }

      // Un-finalize rule (Bill 2026-05-05; tightened 2026-05-06): a
      // FINAL'd class transitions back to OPEN only on a deliberate
      // re-open pair — Channel B without {29}=F AND an INTRO frame
      // (fr=1 jumper / fr=11 hunter) for the same class. Mirrors the
      // live-trigger pair so routine Channel A traffic (ribbons,
      // standings, idle frames) can't accidentally undo a FINAL.
      //
      // Order-agnostic: same batch can have A-then-B or B-then-A.
      // Cross-batch tolerant: stash _unfinalAt in byClass so a B in
      // one batch + intro in the next still fires within the window.
      // Runs BEFORE the FINAL loop so a same-batch F can't be undone.
      // Window matches the LIVE-trigger pair window — un-finalize uses
      // identical criteria to a fresh "go live" event (Bill 2026-05-06:
      // "same as it was if it was new").
      const UNFINAL_WINDOW_MS = LIVE_PAIR_WINDOW_MS;
      const unfinalCandidate = {}; // classId -> { hasUnfinalB, hasChanA, latestAt }
      for (const e of (body.events || [])) {
        if (!e || !e.class_id) continue;
        const cid = String(e.class_id);
        if (finalizedThisBatch.has(cid)) continue; // F always wins
        const cls = this.byClass[cid];
        if (!cls || !cls.is_final) continue;
        const evAt = Date.parse(e.at) || Date.now();
        unfinalCandidate[cid] = unfinalCandidate[cid] || { hasUnfinalB: false, hasChanA: false, latestAt: 0 };
        const slot = unfinalCandidate[cid];
        slot.latestAt = Math.max(slot.latestAt, evAt);
        if (e.channel === 'B') {
          const hasF = ((e.tags && e.tags['29']) || '').replace(/\r/g, '').trim().toUpperCase() === 'F';
          if (!hasF) slot.hasUnfinalB = true;
        } else if (e.channel === 'A' && (e.frame === 1 || e.frame === 11)) {
          slot.hasChanA = true;
        }
      }
      // Track classes that just transitioned out of FINAL — used after
      // the loop to mirror finalized_at = NULL into D1 so class.html's
      // ribbons drop on un-finalize (Bill 2026-05-06).
      const newlyUnfinalIds = [];
      for (const cid of Object.keys(unfinalCandidate)) {
        const slot = unfinalCandidate[cid];
        const cls = this.byClass[cid];
        if (!cls || !cls.is_final) continue;
        // Same-batch pair: both signals present → un-final immediately.
        if (slot.hasUnfinalB && slot.hasChanA) {
          cls.is_final = false;
          cls.finalized_at = null;
          cls._unfinalAt = null;
          newlyUnfinalIds.push(cid);
          if (this._focusedClassId(body) === cid) body.is_final = false;
          continue;
        }
        // Cross-batch: B alone in this batch, A might come next batch.
        if (slot.hasUnfinalB && !slot.hasChanA) {
          cls._unfinalAt = slot.latestAt;
        }
        // A alone: check if a recent B is still pending within window.
        if (slot.hasChanA && !slot.hasUnfinalB && cls._unfinalAt) {
          if (slot.latestAt - cls._unfinalAt <= UNFINAL_WINDOW_MS) {
            cls.is_final = false;
            cls.finalized_at = null;
            cls._unfinalAt = null;
            newlyUnfinalIds.push(cid);
            if (this._focusedClassId(body) === cid) body.is_final = false;
          }
        }
      }

      // Mirror the un-finalize back to D1 so class.html drops ribbons
      // when an operator reopens a class. Same fire-and-forget pattern
      // as the FINAL D1 write below. Excludes any class id that's
      // ALSO being re-finalized in the same batch (finalizedThisBatch
      // wins per F-always-wins rule).
      if (newlyUnfinalIds.length && body.slug && body.ring_num != null) {
        const ringNumIntU = Number(body.ring_num);
        const stmtU = this.env.WEST_DB_V3.prepare(
          "UPDATE classes SET finalized_at = NULL " +
          "WHERE class_id = ? AND ring_id = (" +
          "  SELECT r.id FROM rings r " +
          "  JOIN shows s ON s.id = r.show_id " +
          "  WHERE s.slug = ? AND r.ring_num = ?" +
          ") AND finalized_at IS NOT NULL"
        );
        const dedupedU = Array.from(new Set(newlyUnfinalIds))
          .filter(cid => !finalizedThisBatch.has(cid));
        if (dedupedU.length) {
          const opsU = dedupedU.map(cid => stmtU.bind(cid, body.slug, ringNumIntU));
          this.env.WEST_DB_V3.batch(opsU).catch(err => {
            console.log(`[RingStateDO/event] D1 un-finalize write failed: ${err.message}`);
          });
        }
      }

      // FINAL signal: per-class, decoupled from focus. Channel B with
      // {29}="F" finalizes whatever class the packet is FOR — not the
      // currently-focused class. Lets operator finalize class B while
      // working class A without disturbing A's focus or open state.
      // Bill 2026-05-05: "test the channel b string and just have it
      // finalize whatever class it has that F was attached to."
      // Always wins — runs AFTER un-finalize so {29}=F in the same
      // batch can't be un-done by parallel B/intro events.
      for (const e of (body.events || [])) {
        if (!e || e.channel !== 'B' || !e.class_id) continue;
        const tag29 = ((e.tags && e.tags['29']) || '').replace(/\r/g, '').trim().toUpperCase();
        if (tag29 !== 'F') continue;
        const cid = String(e.class_id);
        let cls = this.byClass[cid];
        if (!cls) {
          // Class not yet in byClass — create a stub so the FINAL flag
          // sticks. _updateByClass / future events will fill in the
          // rest of the metadata.
          cls = this.byClass[cid] = { class_id: cid };
        }
        if (!cls.is_final) {
          cls.is_final = true;
          cls.finalized_at = e.at || new Date().toISOString();
        }
        // S46 — FINAL also flips is_live=false. went_unlive_at = the
        // FINAL event's actual time (not now). Operator's explicit
        // "this class is done" closes the live state immediately;
        // any pending B+intro pair for this class is also cleared.
        if (cls.is_live) {
          cls.is_live = false;
          cls.went_unlive_at = Date.parse(e.at) || Date.now();
          cls.unlive_reason = 'final';
        }
        if (this.pendingLive[cid]) delete this.pendingLive[cid];
        // Bill 2026-05-06: clear "Just Finished" sticky entry on FINAL.
        // Once the class is marked complete, the most-recently-scored
        // entry is no longer the relevant overlay — the standings carry
        // the story. Banner consumers (focused class + per-class panels)
        // read previous_entry directly, so nulling it removes both.
        cls.previous_entry = null;
        // Belt-and-suspenders: clear any cross-batch _unfinalAt latch
        // that might have been waiting for an intro frame to fire.
        cls._unfinalAt = null;
      }

      // Persist finalized_at to D1 for any class that just went FINAL.
      // class.html reads cls.finalized_at to decide whether to render
      // ribbon SVGs (1st-12th place markers) on the placings — the
      // ribbons are reserved for finalized classes (Bill 2026-05-06).
      // Fire-and-forget so the /event hot path stays fast; D1 write
      // failures are logged but never surface to the engine.
      // (v3 classes table has no `status` column — `finalized_at` was
      // added via migration 032.)
      const newlyFinalIds = [];
      for (const e of (body.events || [])) {
        if (!e || e.channel !== 'B' || !e.class_id) continue;
        const tag29 = ((e.tags && e.tags['29']) || '').replace(/\r/g, '').trim().toUpperCase();
        if (tag29 === 'F') newlyFinalIds.push(String(e.class_id));
      }
      if (newlyFinalIds.length && body.slug && body.ring_num != null) {
        const ringNumInt = Number(body.ring_num);
        const finalizedAtIso = new Date().toISOString();
        const stmt = this.env.WEST_DB_V3.prepare(
          "UPDATE classes SET finalized_at = ? " +
          "WHERE class_id = ? AND ring_id = (" +
          "  SELECT r.id FROM rings r " +
          "  JOIN shows s ON s.id = r.show_id " +
          "  WHERE s.slug = ? AND r.ring_num = ?" +
          ") AND finalized_at IS NULL"
        );
        const dedupedIds = Array.from(new Set(newlyFinalIds));
        const ops = dedupedIds.map(cid => stmt.bind(finalizedAtIso, cid, body.slug, ringNumInt));
        this.env.WEST_DB_V3.batch(ops).catch(err => {
          console.log(`[RingStateDO/event] D1 finalized_at write failed: ${err.message}`);
        });
      }

      // fr=0 × 3 consecutive → operator-intent CLEAR. Single fr=0 fires
      // on auto-timeout (scoreboard going dim), so we don't treat one
      // as a class reset. Three in a row is a deliberate hold-down /
      // multi-press meaning "clear the on-course panel for real."
      // Tracks per-class via this._fr0ConsecutiveByClass; resets when
      // any non-zero fr=11/12/13/14/15/16 fires for that class.
      // Clears last_identity AND last_scoring (Bill 2026-05-06 — the
      // 3x clear should wipe the rider AND their clock/faults/rank off
      // the live banner, not just the identity). Leaves flat_results /
      // jog_order / standby_list intact — those are class-history.
      this._fr0ConsecutiveByClass = this._fr0ConsecutiveByClass || {};
      const fr0Map = this._fr0ConsecutiveByClass;
      for (const e of (body.events || [])) {
        if (!e || e.channel !== 'A' || !e.class_id) continue;
        const cid = String(e.class_id);
        if (e.frame === 0) {
          fr0Map[cid] = (fr0Map[cid] || 0) + 1;
          if (fr0Map[cid] >= 3) {
            body.last_identity = null;
            body.last_scoring = null;
            // Mirror onto the byClass entry so _updateByClass's
            // `body || prior` carry-forward doesn't resurrect them
            // from the previous batch's data.
            const cls = this.byClass[cid];
            if (cls) {
              cls.last_identity = null;
              cls.last_scoring = null;
              cls.previous_entry = null;
            }
            // Don't reset to 0 here — additional fr=0s shouldn't keep
            // re-clearing if the operator is just sitting on it. The
            // counter resets on the next non-zero scoring frame.
          }
        } else if (e.frame >= 11) {
          fr0Map[cid] = 0;
        }
      }
      // Hunter Flat accumulators — fr=11 builds the "in the ring"
      // rotation list, fr=14 builds the placings list. Both append-only
      // within a class; reset on class-id change. fr=0 does NOT clear
      // (operator dimming the screen ≠ class reset). Frame-number gating
      // only — no class_kind check. Mirrors v2 watcher (west-watcher.js
      // ON_COURSE / HUNTER_RESULT handlers): forced/U-class hunters
      // surface placings without waiting for class metadata to resolve.
      // Consumer prefers hunter_scores[].current_place over flat_results
      // once the .cls is written (forced/flat .cls writes col[14]=place).
      {
        const flatFocusClassId =
          (body.last_focus   && body.last_focus.class_id) ||
          (body.last_scoring && body.last_scoring.class_id) || null;
        const priorFlatClassId = (this.snapshot && this.snapshot.flat_class_id) || null;
        const classChanged = !!(priorFlatClassId && flatFocusClassId && priorFlatClassId !== flatFocusClassId);
        const entriesSeen = classChanged ? [] :
          ((this.snapshot && this.snapshot.flat_entries_seen) || []).slice();
        const results = classChanged ? [] :
          ((this.snapshot && this.snapshot.flat_results) || []).slice();
        const seenIdx = new Map(entriesSeen.map((r, i) => [r.entry_num, i]));
        const resIdx  = new Map(results.map((r, i)      => [r.entry_num, i]));
        // upsertSeen — dedupe by entry_num, refresh fields on repeat
        const upsertSeen = (entryNum, horse, rider, owner, isEq, at) => {
          if (!entryNum) return;
          if (seenIdx.has(entryNum)) {
            const i = seenIdx.get(entryNum);
            entriesSeen[i] = { ...entriesSeen[i], horse, rider, owner, is_eq: isEq };
          } else {
            seenIdx.set(entryNum, entriesSeen.length);
            entriesSeen.push({ entry_num: entryNum, horse, rider, owner, is_eq: isEq, first_seen_at: at });
          }
        };

        // Scoreboard cycling-display accumulators (fr=15). Two distinct
        // ceremonies share the frame, distinguished by the {13} label
        // tag. Both preserve Ryegate's broadcast order — judges may
        // arrange by back-number, class position, or anything else, and
        // the page should render exactly that order. fr=0 doesn't clear.
        let jogOrder = (this.snapshot && Array.isArray(this.snapshot.jog_order))
          ? this.snapshot.jog_order.slice() : [];
        let standbyList = (this.snapshot && Array.isArray(this.snapshot.standby_list))
          ? this.snapshot.standby_list.slice() : [];
        if (classChanged) { jogOrder = []; standbyList = []; }
        // Each fr=15 packet broadcasts the FULL roster's most recent
        // pair (cycling). To avoid duplicates while preserving order,
        // we rebuild the array per-tick by appending each pair if not
        // already present. Once a class has been seen, subsequent ticks
        // that re-broadcast the same pairs become no-ops.
        const jogIdx     = new Map(jogOrder.map((r, i) => [r.entry_num, i]));
        const standbyIdx = new Map(standbyList.map((r, i) => [r.entry_num, i]));

        for (const e of (body.events || [])) {
          if (!e || e.channel !== 'A') continue;
          if (e.frame !== 11 && e.frame !== 13 && e.frame !== 14 && e.frame !== 15) continue;
          if (flatFocusClassId && e.class_id && e.class_id !== flatFocusClassId) continue;
          const tags = e.tags || {};

          // Frame 15 — SCOREBOARD CYCLING DISPLAY (jog or standby).
          // Two pairs per packet:
          //   {1}=entry A, {2}=horse A, {8}=position A
          //   {13}=label ("JOG ORDER" | "STANDBY LIST")
          //   {17}=position B, {18}=entry B, {20}=horse B
          // Routed by the {13} label into either jog_order or
          // standby_list. Preserve append order so re-broadcast cycles
          // don't shuffle.
          if (e.frame === 15) {
            const label = (tags['13'] || '').replace(/\r/g, '').trim().toUpperCase();
            const eA = (tags['1']  || '').replace(/\r/g, '').trim();
            const hA = (tags['2']  || '').replace(/\r/g, '').trim();
            const pA = (tags['8']  || '').replace(/\r/g, '').trim();
            const eB = (tags['18'] || '').replace(/\r/g, '').trim();
            const hB = (tags['20'] || '').replace(/\r/g, '').trim();
            const pB = (tags['17'] || '').replace(/\r/g, '').trim();
            if (label === 'JOG ORDER') {
              if (eA && !jogIdx.has(eA)) {
                jogIdx.set(eA, jogOrder.length);
                jogOrder.push({ entry_num: eA, horse: hA, position_text: pA });
              }
              if (eB && !jogIdx.has(eB)) {
                jogIdx.set(eB, jogOrder.length);
                jogOrder.push({ entry_num: eB, horse: hB, position_text: pB });
              }
            } else if (label === 'STANDBY LIST') {
              if (eA && !standbyIdx.has(eA)) {
                standbyIdx.set(eA, standbyList.length);
                standbyList.push({ entry_num: eA, horse: hA });
              }
              if (eB && !standbyIdx.has(eB)) {
                standbyIdx.set(eB, standbyList.length);
                standbyList.push({ entry_num: eB, horse: hB });
              }
            }
            // Unknown {13} labels: skip silently. Worth logging if a
            // new ceremony surfaces in the wild (parse_warnings would
            // be the destination once observability lands).
            continue;
          }

          // Frame 13 — DUAL PURPOSE:
          //   1) EQ FLAT rotation (class_mode=1 + is_equitation=1)
          //   2) Hunter JOG ORDER display (fires after class complete,
          //      regardless of class_mode)
          // Two entries per packet:
          //   {1}=entry A, {2}=rider A, {18}=entry B, {20}=rider B
          // No horse, no owner (riders only on this frame). Gated on
          // class_meta.class_mode === 1 so jog-order frames on non-flat
          // hunters don't trip the flat-detection cadence rule (which
          // would render an over-fences class as flat after its jog).
          if (e.frame === 13) {
            const isFlatClass = body.class_meta && body.class_meta.class_mode === 1;
            if (!isFlatClass) continue;
            const eA   = (tags['1']  || '').replace(/\r/g, '').trim();
            const rA   = (tags['2']  || '').replace(/\r/g, '').trim();
            const eB   = (tags['18'] || '').replace(/\r/g, '').trim();
            const rB   = (tags['20'] || '').replace(/\r/g, '').trim();
            if (eA) upsertSeen(eA, '', rA, '', true, e.at);
            if (eB) upsertSeen(eB, '', rB, '', true, e.at);
            continue;
          }

          const entryNum = (tags['1'] || '').replace(/\r/g, '').trim();
          if (!entryNum) continue;
          // EQ branch on fr=11/14: no {3} but has {7} → use {7} as rider,
          // {2} is empty (v2 pattern). Hunter (non-EQ) uses {2}=horse,
          // {3}=rider.
          const t3 = (tags['3'] || '').replace(/\r/g, '').trim();
          const t7 = (tags['7'] || '').replace(/\r/g, '').trim();
          const isEq = !t3 && !!t7;
          const horse = isEq ? '' : (tags['2'] || '').replace(/\r/g, '').trim();
          const rider = isEq ? t7 : t3;
          const owner = (tags['4'] || '').replace(/\r/g, '').trim();
          if (e.frame === 11) {
            upsertSeen(entryNum, horse, rider, owner, isEq, e.at);
          } else if (e.frame === 14) {
            const placeText = (tags['8'] || '').replace(/\r/g, '').trim();
            if (!placeText) continue; // operator clearing a pin or empty announcement — skip
            const m = placeText.match(/^(\d+)/);
            const placeNum = m ? parseInt(m[1], 10) : null;
            const scoreRaw = (tags['14'] || '').replace(/\r/g, '').trim();
            const rec = { entry_num: entryNum, horse, rider, owner, is_eq: isEq,
                          place_text: placeText, place_num: placeNum,
                          score: scoreRaw || null, pinned_at: e.at };
            if (resIdx.has(entryNum)) results[resIdx.get(entryNum)] = rec;
            else { resIdx.set(entryNum, results.length); results.push(rec); }
          }
        }
        body.flat_entries_seen = entriesSeen;
        body.flat_results      = results;
        body.flat_class_id     = flatFocusClassId;
        body.jog_order         = jogOrder;
        body.standby_list      = standbyList;
      }

      // Manual focus auto-release (Bill 2026-05-06): if the operator
      // forced focus to class X via the engine right-click menu, the
      // next natural Channel B click on a DIFFERENT class takes back
      // over. Skip Channel B with {29}=F (finalize-only — doesn't move
      // focus naturally either). Same-class B clicks are no-ops.
      if (this.forcedFocusClassId) {
        for (const e of (body.events || [])) {
          if (!e || e.channel !== 'B' || !e.class_id) continue;
          const tag29 = ((e.tags && e.tags['29']) || '').replace(/\r/g, '').trim().toUpperCase();
          if (tag29 === 'F') continue;
          if (String(e.class_id) !== String(this.forcedFocusClassId)) {
            this.forcedFocusClassId = null;
            break;
          }
        }
      }

      // Route class_meta to its OWN byClass entry (Bill 2026-05-06).
      // /v3/postUdpEvent fetches class_meta for the last event's class
      // id (lensClassId), which might not equal the currently-focused
      // class. We stamp class_id onto class_meta there, then here we
      // park it on the correct entry. Pre-creates the entry if needed
      // so a class_meta arriving before B+intro pair doesn't get lost.
      if (body.class_meta && body.class_meta.class_id != null) {
        const metaCid = String(body.class_meta.class_id);
        const target = this.byClass[metaCid] || (this.byClass[metaCid] = { class_id: metaCid });
        target.class_meta = body.class_meta;
        if (body.class_kind && !target.class_kind) target.class_kind = body.class_kind;
      }

      // S46 LIVE detection — runs after FINAL/unfinal so a same-batch
      // FINAL takes precedence over any B+intro pair for that class.
      // _bumpLiveHeartbeats follows so a fresh-live class also gets its
      // last_live_event_at bumped from this batch's events.
      this._processLiveTriggers(body);
      this._bumpLiveHeartbeats(body);

      // Update the per-class store (S45 multi-class), then build the public
      // snapshot view that includes the .classes panel stack on top of all
      // existing top-level fields.
      this._updateByClass(body);
      this.snapshot = this._buildSnapshot(body);
      // S46 — reconcile ring segment AFTER snapshot build (which runs the
      // timeout sweep). Opens a new D1 row when ring transitions un-live
      // → live, closes it when ring transitions live → un-live, bumps
      // heartbeat in between.
      await this._reconcileRingSegment(body.slug, body.ring_num);
      // Mirror to KV — /v3/getRingState reads from here, and Chunk 8's
      // polling fallback needs it when a WS handshake fails. We persist the
      // full augmented snapshot (including .classes) so polling clients
      // get the multi-class view too.
      try {
        await this.env.WEST_LIVE.put(
          `ring-state:${body.slug}:${body.ring_num}`,
          JSON.stringify(this.snapshot),
          { expirationTtl: 600 }
        );
      } catch (e) {
        console.log(`[RingStateDO] KV put failed for ${body.slug}/${body.ring_num}: ${e.message}`);
        // In-memory snapshot still updated — WS broadcast still serves
        // fresh clients regardless.
      }
      // Phase 3b Chunk 7 — broadcast to every connected WebSocket. Use
      // state.getWebSockets() (hibernation API) so the runtime owns the
      // connection list across DO eviction. Dead sockets get caught by
      // the per-socket try/catch.
      const wsMessage = JSON.stringify({ type: 'snapshot', data: this.snapshot });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(wsMessage); } catch (e) { /* runtime cleans dead */ }
      }
      // Engine reads is_live + live_class_ids from this response on every
      // batch — feeds the engine's operator-facing live-class panel
      // without needing a separate poll endpoint. classes_summary is the
      // minimal projection the engine right-click menu needs (id, lifecycle
      // state, class name) — full byClass payload would be wasteful.
      const classesSummary = (this.snapshot.classes || []).map(c => ({
        class_id: c.class_id,
        class_name: (c.class_meta && c.class_meta.class_name) || null,
        is_live: !!c.is_live,
        is_final: !!c.is_final,
      }));
      return new Response(JSON.stringify({
        ok: true,
        broadcast_to: this.state.getWebSockets().length,
        is_live: this.snapshot.is_live,
        live_since: this.snapshot.live_since,
        live_class_ids: this.snapshot.live_class_ids,
        focused_class_id: this.snapshot.focused_class_id,
        forced_focus_class_id: this.snapshot.forced_focus_class_id,
        classes_summary: classesSummary,
        focus_preview: this.snapshot.focus_preview || null,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /scores-update — push from /v3/postCls when scoring changes
    // in D1. Without this, a Display Scores trigger / score post updates
    // D1 but the live snapshot stays stale until the next UDP batch
    // (which may never come if the operator stops sending UDP). Body:
    // { class_id, hunter_scores?, jumper_scores? }. We gate on class_id
    // matching the current focus so a postCls for a non-focused class
    // doesn't clobber the live panel. Lens-aware too: if focus is
    // hunter, only hunter_scores update; if jumper / equitation, only
    // jumper_scores. (S43 Chunks 13 + 14 — Bill 2026-05-02.)
    if (request.method === 'POST' && url.pathname === '/scores-update') {
      let body;
      try { body = await request.json(); }
      catch (e) { return new Response('Invalid JSON', { status: 400 }); }
      // Cold-DO restoration — same rationale as /event handler.
      await this.warmUp(body.slug, body.ring_num);
      if (!this.snapshot) {
        return new Response(JSON.stringify({ ok: true, applied: false, reason: 'no snapshot' }));
      }
      // .cls write = lock signal (Bill 2026-05-06, tightened: option 2 —
      // "cls change not cls touch"). A .cls update with NEW scoring data
      // is Ryegate's confirmation that real scoring happened — strong
      // enough to promote a tentative class to fully-live without an
      // explicit B+intro pair. A .cls TOUCH (file save with no content
      // change — e.g., operator opened/closed in an editor) does NOT
      // count. Compares the incoming scores array against what's
      // currently stored on the byClass entry; identical = skip.
      // Skipped when:
      //   • class is already final (don't relight a finalized class on a re-save)
      //   • class is already live (no-op)
      //   • a manual Flush fired within FLUSH_COOLDOWN_MS
      //   • scoring data didn't actually change (touch, not change)
      const cidFromBody = body.class_id != null ? String(body.class_id) : '';
      const inFlushCooldown = this.flushedAt
        && (Date.now() - this.flushedAt) < FLUSH_COOLDOWN_MS;
      if (cidFromBody && !inFlushCooldown) {
        const existing = this.byClass[cidFromBody];
        // Determine whether body carries genuinely new scoring data.
        // For a brand-new class (no existing entry), any non-empty
        // scores array counts as a change — that's the operator's
        // first score and a legitimate live trigger.
        let scoresChanged;
        if (!existing) {
          const candidate = (body.hunter_scores && body.hunter_scores.length)
            ? body.hunter_scores
            : (body.jumper_scores || []);
          scoresChanged = !!(candidate && candidate.length);
        } else {
          const prevH = existing.hunter_scores || null;
          const prevJ = existing.jumper_scores || null;
          const nextH = body.hunter_scores !== undefined ? body.hunter_scores : prevH;
          const nextJ = body.jumper_scores !== undefined ? body.jumper_scores : prevJ;
          scoresChanged = JSON.stringify(prevH) !== JSON.stringify(nextH)
                       || JSON.stringify(prevJ) !== JSON.stringify(nextJ);
        }
        if (scoresChanged) {
          let target = existing;
          if (!target) target = this.byClass[cidFromBody] = { class_id: cidFromBody };
          if (!target.is_live && !target.is_final) {
            const now = Date.now();
            target.is_live = true;
            target.live_since = now;
            target.last_live_event_at = now;
            target.live_trigger = 'cls_lock';
            target.went_unlive_at = null;
            target.unlive_reason = null;
          }
        }
      }

      // Multi-class store update (S45) — apply to whichever class the
      // body targets, regardless of which class is currently focused.
      // Other-class score updates are valuable for the panel stack on
      // live.html (a non-focused class panel can still reflect its
      // latest results without waiting for it to be focused again).
      const targetEntry = this.byClass[body.class_id];
      if (targetEntry) {
        const targetLens = targetEntry.class_kind;
        const targetIsHunter = targetLens === 'hunter';
        const targetIsJumper = targetLens === 'jumper' || targetLens === 'equitation';
        // Capture prior scores BEFORE we overwrite them below — the
        // sig-diff promote logic at the end of this block needs to
        // compare old vs new. `existing` (line 2544) and `targetEntry`
        // are the same DO object reference, so reassigning
        // targetEntry.hunter_scores = body.hunter_scores also mutates
        // existing.hunter_scores. Without this snapshot, priorScores
        // === newScores, sig-diff finds nothing, pe never promotes
        // past the first time. Bill 2026-05-09 (Aiken jumpers).
        const priorHunterScores = Array.isArray(targetEntry.hunter_scores) ? targetEntry.hunter_scores : [];
        const priorJumperScores = Array.isArray(targetEntry.jumper_scores) ? targetEntry.jumper_scores : [];
        // Bill 2026-05-08: don't overwrite a populated scores array
        // with an empty one. /v3/postCls runs the entry-stale-sweep
        // (DELETE FROM entries WHERE class_id = ? AND entry_num NOT
        // IN ...) before the upsert; if pullJumperScoresV3 fires
        // mid-sweep it can return [] transiently, which used to
        // blank byClass[X].jumper_scores and the page rendered
        // "Awaiting standings…" until the next /v3/postCls. Keep
        // the prior populated array when the incoming is empty —
        // the next /v3/postCls (a few hundred ms later) refreshes
        // with the real list. Empty + nothing-prior is still
        // legitimate (brand-new class, no entries yet).
        const isEmptyArr = (a) => Array.isArray(a) && a.length === 0;
        if (targetIsHunter && body.hunter_scores !== undefined) {
          if (!(isEmptyArr(body.hunter_scores)
                && Array.isArray(targetEntry.hunter_scores)
                && targetEntry.hunter_scores.length > 0)) {
            targetEntry.hunter_scores = body.hunter_scores;
          }
        }
        if (targetIsJumper && body.jumper_scores !== undefined) {
          if (!(isEmptyArr(body.jumper_scores)
                && Array.isArray(targetEntry.jumper_scores)
                && targetEntry.jumper_scores.length > 0)) {
            targetEntry.jumper_scores = body.jumper_scores;
          }
        }
        // Promote previous_entry — sole promote site for hunter/jumper
        // pe across both same-rider-on-course updates and rider
        // transitions. /scores-update fires AFTER /v3/postCls writes
        // the row, so we always have fresh data here. Bill 2026-05-08.
        //
        // Detection strategy: find the entry whose row data CHANGED
        // since the last broadcast. That's the rider who just finished
        // (or just got a new score released). Don't rely on
        // last_identity — by the time /scores-update fires, last_identity
        // may have already flipped to the next on-course rider.
        if (!targetEntry.is_final) {
          const sigOf = (r) => r ? [
            r.r1_score_total, r.r2_score_total, r.r3_score_total,
            r.combined_total,
            r.r1_total_faults, r.r1_total_time,
            r.r2_total_faults, r.r2_total_time,
            r.r3_total_faults, r.r3_total_time,
            r.r1_h_status, r.r2_h_status, r.r3_h_status,
            r.r1_status, r.r2_status, r.r3_status,
            r.current_place, r.overall_place,
            (r.judges || []).map(j => j.round + ':' + j.idx + ':' + j.base + ':' + (j.hiopt || 0) + ':' + (j.handy || 0)).join('|'),
          ].join('~') : '';
          const priorScores = targetIsHunter ? priorHunterScores : priorJumperScores;
          const newScores = targetIsHunter
            ? (targetEntry.hunter_scores || [])
            : (targetEntry.jumper_scores || []);
          const priorSigs = new Map(priorScores.map(r => [String(r.entry_num), sigOf(r)]));
          // Pick the entry whose signature changed AND now has scoring data.
          let updatedRow = null;
          for (const r of newScores) {
            const newSig = sigOf(r);
            const oldSig = priorSigs.get(String(r.entry_num)) || '';
            if (newSig !== oldSig && newSig) {
              // Prefer entries with actual scoring data (skip null-only changes).
              const hasData = r.r1_score_total != null || r.r2_score_total != null
                            || r.r3_score_total != null || r.combined_total != null
                            || r.r1_total_faults != null || r.r1_total_time != null
                            || r.r1_h_status || r.r1_status;
              if (hasData) { updatedRow = r; break; }
            }
          }
          if (updatedRow) {
            const candidate = this._buildPrevEntry(updatedRow, targetLens, targetEntry.class_meta);
            if (candidate && !this._samePrevEntry(targetEntry.previous_entry, candidate)) {
              candidate.finished_at = new Date().toISOString();
              targetEntry.previous_entry = candidate;
            }
          }
        }
      }

      // Lens derivation. Normally /v3/postUdpEvent stamps snapshot.class_kind
      // from the classes-table row's (class_type, scoring_method). On a
      // brand-new class the operator opens, UDP fires before the .cls is
      // posted, so D1 carries class_type='U' and scoring_method=null →
      // class_kind comes back null. /v3/postCls then parses the .cls and
      // promotes the row to J/T/H, but the snapshot's class_kind is still
      // null when this /scores-update fires. Bailing here on a null lens
      // means the first horse's standings never broadcast — the page only
      // catches up when the next UDP event refreshes the lens (the operator
      // saw "second horse going on course was the trigger"). The body is
      // authoritative — its scores arrays come from the just-parsed D1 row,
      // so if hunter_scores/jumper_scores is present we know the lens.
      let lensKind = this.snapshot.class_kind;
      if (lensKind !== 'hunter' && lensKind !== 'jumper' && lensKind !== 'equitation') {
        if (Array.isArray(body.hunter_scores)) lensKind = 'hunter';
        else if (Array.isArray(body.jumper_scores)) lensKind = 'jumper';
      }
      const isHunter = lensKind === 'hunter';
      const isJumper = lensKind === 'jumper' || lensKind === 'equitation';
      if (!isHunter && !isJumper) {
        return new Response(JSON.stringify({ ok: true, applied: false, reason: 'no scoring lens' }));
      }
      // Match against any class_id source — Channel A or Channel B.
      const focusedClassId =
        (this.snapshot.last_scoring && this.snapshot.last_scoring.class_id) ||
        (this.snapshot.last_focus && this.snapshot.last_focus.class_id) ||
        (this.snapshot.last && this.snapshot.last.class_id) || null;
      const focusMatched = focusedClassId === body.class_id;
      if (focusMatched) {
        // Catch up class_kind on the focused snapshot so later consumers
        // (live page lens checks, next /scores-update) don't see the stale
        // null carried over from the pre-parse UDP batch.
        if (this.snapshot.class_kind == null) {
          this.snapshot.class_kind = lensKind;
        }
        // Top-level (focused class's) scores update — backwards-compat path.
        // Same empty-overwrite guard as the byClass path above so a
        // transient mid-sweep [] from pullJumperScoresV3 doesn't blank
        // the focused panel's standings.
        const isEmptyArrTop = (a) => Array.isArray(a) && a.length === 0;
        if (isHunter && body.hunter_scores !== undefined) {
          if (!(isEmptyArrTop(body.hunter_scores)
                && Array.isArray(this.snapshot.hunter_scores)
                && this.snapshot.hunter_scores.length > 0)) {
            this.snapshot.hunter_scores = body.hunter_scores;
          }
        }
        if (isJumper && body.jumper_scores !== undefined) {
          if (!(isEmptyArrTop(body.jumper_scores)
                && Array.isArray(this.snapshot.jumper_scores)
                && this.snapshot.jumper_scores.length > 0)) {
            this.snapshot.jumper_scores = body.jumper_scores;
          }
        }
      }
      this.snapshot.received_at = new Date().toISOString();
      // Rebuild the .classes array so the panel-stack view reflects the
      // updated byClass entry (last_seen_at order is unchanged; only
      // the standings within the matching entry shift).
      this.snapshot = this._buildSnapshot(this.snapshot);
      // Reconcile the ring segment AFTER snapshot rebuild — the cls_lock
      // promotion above might have flipped this class's is_live, so the
      // open D1 segment needs to track it (or open a new one).
      await this._reconcileRingSegment(body.slug, body.ring_num);
      // Persist to KV so polling fallback also sees the fresh scores.
      try {
        await this.env.WEST_LIVE.put(
          `ring-state:${this.snapshot.slug}:${this.snapshot.ring_num}`,
          JSON.stringify(this.snapshot),
          { expirationTtl: 600 }
        );
      } catch (e) {
        console.log(`[RingStateDO/scores-update] KV put failed: ${e.message}`);
      }
      // Broadcast updated snapshot to all WS clients.
      const wsMessage = JSON.stringify({ type: 'snapshot', data: this.snapshot });
      let broadcasts = 0;
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(wsMessage); broadcasts++; } catch (e) {}
      }
      return new Response(JSON.stringify({ ok: true, applied: true, focusMatched, broadcasts }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /class-action — manual operator action from the engine
    // right-click menu (Bill 2026-05-06). Body:
    //   { slug, ring_num, class_id, action }
    // action ∈ { 'clear' | 'finalize' | 'focus' }
    //   clear:    is_live=false (manual_clear), wipes previous_entry
    //   finalize: is_live=false (final), is_final=true, wipes previous_entry
    //   focus:    sets forcedFocusClassId — overrides natural focus until
    //             a Channel B click on a different class arrives
    // After mutation: rebuilds snapshot, mirrors KV, broadcasts WS,
    // reconciles ring_live_segment so the D1 row closes/stays open
    // appropriately. Returns the new live snapshot fields the engine
    // panel needs to repaint immediately.
    if (request.method === 'POST' && url.pathname === '/class-action') {
      let body;
      try { body = await request.json(); }
      catch (e) { return new Response('Invalid JSON', { status: 400 }); }
      await this.warmUp(body.slug, body.ring_num);
      const action = String(body.action || '').toLowerCase();
      const cid = body.class_id != null ? String(body.class_id) : '';
      if (action !== 'clear' && action !== 'finalize' && action !== 'focus' && action !== 'flush_all') {
        return new Response('Invalid action', { status: 400 });
      }
      // class_id required for per-class actions; ignored for flush_all.
      if (action !== 'flush_all' && !cid) {
        return new Response('Missing class_id', { status: 400 });
      }
      const cls = cid ? this.byClass[cid] : null;
      if (action !== 'flush_all' && action !== 'finalize' && !cls) {
        // Allow finalize to create a stub (mirror Channel B {29}=F path);
        // clear/focus on an unknown class is a no-op error.
        return new Response(JSON.stringify({ ok: false, error: 'class not in ring state' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      const now = Date.now();
      if (action === 'clear') {
        // Bill 2026-05-06: Clear live should drop the class from the
        // live page entirely, not just dim the LIVE banner. Capture
        // the un-live reason for the segment close, then evict the
        // byClass entry — the class disappears from snapshot.classes,
        // engine's live pane, and live.html's panel stack on the next
        // broadcast. Future UDP for this class id rebuilds the entry
        // from scratch.
        if (cls.is_live) {
          cls.is_live = false;
          cls.went_unlive_at = now;
          cls.unlive_reason = 'manual_clear';
        }
        delete this.byClass[cid];
        if (this.pendingLive[cid]) delete this.pendingLive[cid];
        if (this.forcedFocusClassId === cid) this.forcedFocusClassId = null;
        // Bill 2026-05-06: Clear live also un-finalizes the class in
        // D1 — operator's "un-live" gesture should drop ribbons +
        // prize money from class.html, not just the live banner.
        // Same fire-and-forget pattern as the FINAL write.
        if (body.slug && body.ring_num != null) {
          const ringNumIntC = Number(body.ring_num);
          this.env.WEST_DB_V3.prepare(
            "UPDATE classes SET finalized_at = NULL " +
            "WHERE class_id = ? AND ring_id = (" +
            "  SELECT r.id FROM rings r JOIN shows s ON s.id = r.show_id " +
            "  WHERE s.slug = ? AND r.ring_num = ?" +
            ") AND finalized_at IS NOT NULL"
          ).bind(cid, body.slug, ringNumIntC).run().catch(err => {
            console.log(`[RingStateDO/class-action clear] D1 un-finalize write failed: ${err.message}`);
          });
        }
      } else if (action === 'finalize') {
        const target = cls || (this.byClass[cid] = { class_id: cid });
        if (!target.is_final) {
          target.is_final = true;
          target.finalized_at = new Date().toISOString();
        }
        if (target.is_live) {
          target.is_live = false;
          target.went_unlive_at = now;
          target.unlive_reason = 'final';
        }
        target.previous_entry = null;
        if (this.pendingLive[cid]) delete this.pendingLive[cid];
        // Mirror finalized_at to D1 so class.html shows ribbons.
        // Same fire-and-forget pattern as the /event FINAL handler.
        if (body.slug && body.ring_num != null) {
          const ringNumIntF = Number(body.ring_num);
          this.env.WEST_DB_V3.prepare(
            "UPDATE classes SET finalized_at = ? " +
            "WHERE class_id = ? AND ring_id = (" +
            "  SELECT r.id FROM rings r JOIN shows s ON s.id = r.show_id " +
            "  WHERE s.slug = ? AND r.ring_num = ?" +
            ") AND finalized_at IS NULL"
          ).bind(target.finalized_at || new Date().toISOString(), cid, body.slug, ringNumIntF).run().catch(err => {
            console.log(`[RingStateDO/class-action finalize] D1 finalized_at write failed: ${err.message}`);
          });
        }
      } else if (action === 'focus') {
        this.forcedFocusClassId = cid;
      } else if (action === 'flush_all') {
        // Nuke every class off the ring (Bill 2026-05-06 — engine "Flush
        // live" button). EVERY byClass entry is evicted, including
        // finalized classes still in their collapsed-FINAL lifecycle.
        // Operator wants a clean slate; finer control is available via
        // right-click → Clear live on individual classes. Pending pairs
        // and forced focus also cleared so nothing re-lights immediately.
        // flushedAt suppresses cls_lock relight for FLUSH_COOLDOWN_MS so
        // the trailing .cls write at class close doesn't undo the flush.
        this.byClass = {};
        this.pendingLive = {};
        this.forcedFocusClassId = null;
        this.flushedAt = now;
        // Wipe the top-level snapshot pointers too. Without this, the
        // sticky last_focus / last_scoring / focused_class_id from
        // before the flush would carry forward and re-promote the old
        // class on the next batch (the engine pane would still show
        // 1001 as focused even though every byClass entry is gone).
        if (this.snapshot) {
          this.snapshot.last_focus = null;
          this.snapshot.last_scoring = null;
          this.snapshot.last_identity = null;
          this.snapshot.focused_class_id = null;
          this.snapshot.focus_preview = null;
          this.snapshot.previous_entry = null;
        }
      }
      // Rebuild snapshot from current state — pass the prior body so the
      // top-level fields don't blank.
      this.snapshot = this._buildSnapshot(this.snapshot || {});
      this.snapshot.received_at = new Date().toISOString();
      // Reconcile segment: clear/finalize/flush on the last live class
      // closes the open D1 row. Pass the manual hint so the closed
      // ended_at reflects when the operator actually clicked, not a
      // stale went_unlive_at from another byClass entry (or the wall
      // clock when reconcile happens to run).
      const manualHint = (action === 'clear' || action === 'flush_all')
        ? { at: now, reason: 'manual_clear' }
        : (action === 'finalize' ? { at: now, reason: 'final' } : null);
      await this._reconcileRingSegment(body.slug, body.ring_num, manualHint);
      try {
        await this.env.WEST_LIVE.put(
          `ring-state:${body.slug}:${body.ring_num}`,
          JSON.stringify(this.snapshot),
          { expirationTtl: 600 }
        );
      } catch (e) {
        console.log(`[RingStateDO/class-action] KV put failed: ${e.message}`);
      }
      const wsMessage = JSON.stringify({ type: 'snapshot', data: this.snapshot });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(wsMessage); } catch (e) {}
      }
      const classesSummary = (this.snapshot.classes || []).map(c => ({
        class_id: c.class_id,
        class_name: (c.class_meta && c.class_meta.class_name) || null,
        is_live: !!c.is_live,
        is_final: !!c.is_final,
      }));
      return new Response(JSON.stringify({
        ok: true,
        action,
        class_id: cid,
        is_live: this.snapshot.is_live,
        live_since: this.snapshot.live_since,
        live_class_ids: this.snapshot.live_class_ids,
        focused_class_id: this.snapshot.focused_class_id,
        forced_focus_class_id: this.snapshot.forced_focus_class_id,
        classes_summary: classesSummary,
        focus_preview: this.snapshot.focus_preview || null,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /ws — WebSocket upgrade for spectator clients.
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      // slug + ring are passed via URL params from the public /v3/live
      // route — needed for the warm-up KV read on cold DOs.
      const slug = url.searchParams.get('slug');
      const ringNum = url.searchParams.get('ring_num');
      await this.warmUp(slug, ringNum);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation accept — connection persists across DO eviction.
      // Server side is what we keep on the DO; client gets returned to
      // the browser via the upgrade response.
      this.state.acceptWebSocket(server);

      // Send the initial snapshot as soon as the connection is up so the
      // client doesn't have to wait for the next engine batch to render.
      if (this.snapshot) {
        try { server.send(JSON.stringify({ type: 'snapshot', data: this.snapshot })); }
        catch (e) { /* if it fails right at handshake, runtime closes it */ }
      } else {
        try { server.send(JSON.stringify({ type: 'idle', reason: 'no snapshot yet' })); }
        catch (e) {}
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  // Hibernation handlers — called by the runtime when an external event
  // hits a connection. Clients aren't expected to send anything meaningful
  // in Chunk 7; messages get logged and ignored.
  webSocketMessage(ws, message) {
    // No-op for now. Future: client could send "subscribe to filter" or "ping".
  }
  webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, 'closing'); } catch (e) {}
  }
  webSocketError(ws, error) {
    console.log(`[RingStateDO] WS error: ${error && error.message || error}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── v2 RETIRED 2026-05-02 ────────────────────────────────────────────────
    // Culpeper was the last show on v2. All v2 ingest + spectator endpoints
    // return 410 Gone with a [V2-DEPRECATED] log line so we can see if
    // anything (bookmarks, stale watcher PCs, bots) is still hitting them.
    // After ~7 days of zero hits, the bodies below will be deleted for real.
    // /admin/* is NOT in this list — admin tools haven't been ported to v3 yet.
    const V2_RETIRED_PATHS = new Set([
      '/postClassData', '/postClassEvent', '/postSchedule', '/heartbeat',
      '/postUdpEvent',  // legacy v2 endpoint — distinct from /v3/postUdpEvent
      '/getLiveClass', '/getShow', '/getShowStats', '/getShowWeather',
      '/searchShow', '/getClasses', '/getResults', '/getShows',
    ]);
    if (V2_RETIRED_PATHS.has(path)) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ua = request.headers.get('User-Agent') || 'unknown';
      console.log(`[V2-DEPRECATED] ${method} ${path} ip=${ip} ua=${ua.slice(0, 80)}`);
      return new Response(
        JSON.stringify({ ok: false, error: 'This endpoint has been retired. v2 was decommissioned 2026-05-02. Please use the v3 engine and /v3/* endpoints.' }),
        { status: 410, headers: { 'Content-Type': 'application/json', ...CORS } }
      );
    }

    // ── GET /ping ─────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/ping') {
      return json({ ok: true, ts: new Date().toISOString(), version: '2.2' });
    }

    // ── POST /postClassData ───────────────────────────────────────────────────
    // Watcher posts on every .cls file change — fire and forget from watcher
    if (method === 'POST' && path === '/postClassData') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring } = extractSlugRing(body, url);
      if (!slug || !ring) return err('Missing slug or ring');

      const classNum = (body.filename || '').replace('.cls', '');

      // Check if show is locked (admin set to complete) — skip all writes
      const locked = await isShowLocked(env, slug);
      if (locked) {
        console.log(`[postClassData] ${slug} LOCKED — ignoring ${classNum}`);
        return json({ ok: true, classNum, locked: true });
      }

      // Write classData to per-class KV key — every active class gets its own live data
      const key = `live:${slug}:${ring}:${classNum}`;
      // Preserve previously-set per-entry status codes across postClassData
      // writes. Old watchers that don't read Farmtek col[38] correctly (or
      // miss UDP overlays) leave r1/r2StatusCode empty in the body; previous
      // overlays would be lost on every save. Only fill gaps — don't
      // overwrite statuses the incoming body actually set.
      try {
        const prevRaw = await env.WEST_LIVE.get(key);
        if (prevRaw && body && Array.isArray(body.entries)) {
          const prev = JSON.parse(prevRaw);
          const prevByEntry = {};
          (prev.entries || []).forEach(pe => { if (pe && pe.entryNum) prevByEntry[pe.entryNum] = pe; });
          body.entries.forEach(e => {
            const p = prevByEntry[e.entryNum];
            if (!p) return;
            // Only backfill status from previous KV if the incoming entry has
            // NO status on ANY round. If the cls parser set a status on one
            // round (e.g. r2=OC), that's the authoritative picture — don't
            // pull stale statuses from a previous UDP overlay into other rounds.
            const incomingHasStatus = !!(e.r1StatusCode || e.r2StatusCode || e.statusCode);
            if (!incomingHasStatus) {
              if (p.r1StatusCode) e.r1StatusCode = p.r1StatusCode;
              if (p.r2StatusCode) e.r2StatusCode = p.r2StatusCode;
              if (p.statusCode)   e.statusCode   = p.statusCode;
            }
          });
        }
      } catch (e) { /* best-effort merge — ignore parse errors */ }
      await env.WEST_LIVE.put(key, JSON.stringify(body), { expirationTtl: 7200 });

      // Pre-compute results — runs once here instead of on every viewer's phone.
      // Stored in KV for live polling, and written to D1 on CLASS_COMPLETE.
      const computed = computeClassResults(body);
      const resultsKey = `results:${slug}:${ring}:${classNum}`;
      await env.WEST_LIVE.put(resultsKey, JSON.stringify(computed), { expirationTtl: 7200 });

      // If OOG exists, persist to D1 so it survives KV expiry (watcher offline overnight)
      if (computed.orderOfGo && computed.orderOfGo.length) {
        ctx.waitUntil((async () => {
          try {
            const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
            if (show) {
              await env.WEST_DB.prepare(
                'UPDATE classes SET final_results = ? WHERE show_id = ? AND ring = ? AND class_num = ? AND (final_results IS NULL OR status != ?)'
              ).bind(JSON.stringify(computed), show.id, ring, classNum, 'complete').run();
            }
          } catch(e) { console.error('[OOG persist]', e.message); }
        })());
      }

      // Active array managed by CLASS_SELECTED (Ctrl+A) and INTRO/ON_COURSE (UDP events)
      // .cls changes update data only — deliberate operator action puts a class live

      ctx.waitUntil(writeToD1(env, body, slug, ring));
      console.log(`[postClassData] ${key} — class ${classNum} ${body.classType} [computed]`);
      return json({ ok: true, classNum });
    }

    // ── POST /postUdpEvent ────────────────────────────────────────────────────
    // Watcher posts UDP events (INTRO, RIDE_START, FINISH, FAULT etc)
    if (method === 'POST' && path === '/postUdpEvent') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const slug = url.searchParams.get('slug') || body.slug || 'unknown';
      const ring = url.searchParams.get('ring') || body.ring || '1';
      if (await isShowLocked(env, slug)) return json({ ok: false, locked: true });
      const key = `event:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(body), { expirationTtl: 300 });
      console.log(`[postUdpEvent] ${key} — ${body.event} #${body.entry}`);
      return json({ ok: true, key });
    }

    // ── POST /postClassEvent ──────────────────────────────────────────────────
    // Watcher posts CLASS_SELECTED (1x Ctrl+A) and CLASS_COMPLETE (3x Ctrl+A)
    if (method === 'POST' && path === '/postClassEvent') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring } = extractSlugRing(body, url);
      if (!slug || !ring) return err('Missing slug or ring');

      // Reject all events if show is locked
      const locked = await isShowLocked(env, slug);
      if (locked) return json({ ok: false, locked: true });

      const { event, classNum, className } = body;

      if (event === 'INTRO') {
        const key = `oncourse:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry, horse: body.horse, rider: body.rider, owner: body.owner,
          city: body.city || '', state: body.state || '',
          phase: 'INTRO', ta: body.ta || '',
          round: body.round || 1, label: body.label || '',
          fpi: body.faultsPerInterval || 1, ti: body.timeInterval || 1, ps: body.penaltySeconds || 6,
          ts: new Date().toISOString()
        }), { expirationTtl: 120 });
        // Track first horse of the day
        ctx.waitUntil(recordFirstHorse(env, slug, ring));
        // Auto-reinstate class to active array — horse entering the ring = class is live
        const selRaw = await env.WEST_LIVE.get(`selected:${slug}:${ring}`);
        if (selRaw) {
          const sel = JSON.parse(selRaw);
          const activeKey = `active:${slug}:${ring}`;
          const activeRaw = await env.WEST_LIVE.get(activeKey);
          let active = activeRaw ? JSON.parse(activeRaw) : [];
          const idx = active.findIndex(a => String(a.classNum) === String(sel.classNum));
          if (idx >= 0) {
            active[idx].ts = new Date().toISOString();
            active[idx].ring = ring;
          } else {
            active.push({ classNum: sel.classNum, className: sel.className || '', ring, ts: new Date().toISOString() });
            console.log(`[INTRO] ${sel.classNum} reinstated to active (horse on course)`);
          }
          await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
        }
        console.log(`[INTRO] ${slug}:${ring} — #${body.entry} ${body.horse}`);
        return json({ ok: true, event: 'INTRO', entry: body.entry });
      }

      if (event === 'FAULT') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        if (existing) {
          const oc = JSON.parse(existing);
          oc.jumpFaults = body.jumpFaults || '0';
          oc.timeFaults = body.timeFaults || '0';
          await env.WEST_LIVE.put(key, JSON.stringify(oc), { expirationTtl: 300 });
        }
        console.log(`[FAULT] ${slug}:${ring} — #${body.entry} jf=${body.jumpFaults}`);
        return json({ ok: true, event: 'FAULT' });
      }

      if (event === 'FINISH') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        const prev = existing ? JSON.parse(existing) : {};
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry || prev.entry, horse: body.horse || prev.horse,
          rider: body.rider || prev.rider, owner: body.owner || prev.owner,
          city: body.city || prev.city || '', state: body.state || prev.state || '',
          phase: 'FINISH', ta: prev.ta || body.ta || '',
          elapsed: body.elapsed || prev.elapsed || '', jumpFaults: body.jumpFaults || '0',
          timeFaults: body.timeFaults || '0', rank: body.rank || '',
          eqScore: body.eqScore || prev.eqScore || '',
          hunterScore: body.hunterScore || '', isHunter: !!body.isHunter,
          round: body.round || 1, label: body.label || '',
          ts: new Date().toISOString()
        }), { expirationTtl: 600 }); // 10 min — hunters hold finish display indefinitely on page, need long KV persistence
        console.log(`[FINISH] ${slug}:${ring} — #${body.entry} rank=${body.rank}`);
        // If elapsed is a status code (WD/RT/EL/etc.), overlay it onto the
        // entry's r{round}StatusCode in classData + computed KV so the
        // standings row picks it up. Ryegate doesn't always write text
        // statuses (col[82]/[83]) for declined rounds, so the UDP finish
        // event is the only source for those cases.
        const elap = String(body.elapsed || '').toUpperCase().trim();
        const STATUS_SET = ['WD','RT','EL','RF','HF','OC','DNS','DNF','SC','DQ','RO','EX'];
        const isStatusElapsed = elap && STATUS_SET.indexOf(elap) >= 0;
        if (isStatusElapsed && body.entry) {
          ctx.waitUntil(overlayFinishStatus(env, slug, ring, String(body.entry), parseInt(body.round) || 1, elap));
        }
        return json({ ok: true, event: 'FINISH', entry: body.entry });
      }

      if (event === 'CD_START') {
        const key = `oncourse:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry, horse: body.horse, rider: body.rider, owner: body.owner,
          city: body.city || '', state: body.state || '',
          phase: 'CD', countdown: body.countdown || 0, ta: body.ta || '',
          round: body.round || 1, label: body.label || '',
          fpi: body.faultsPerInterval || 1, ti: body.timeInterval || 1, ps: body.penaltySeconds || 6,
          ts: new Date().toISOString()
        }), { expirationTtl: 120 });
        console.log(`[CD_START] ${slug}:${ring} — #${body.entry} ${body.horse} cd=${body.countdown}`);
        return json({ ok: true, event: 'CD_START', entry: body.entry });
      }

      if (event === 'ON_COURSE') {
        const key = `oncourse:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry, horse: body.horse, rider: body.rider, owner: body.owner,
          city: body.city || '', state: body.state || '',
          phase: 'ONCOURSE', elapsed: body.elapsed || 0, ta: body.ta || '',
          round: body.round || 1, label: body.label || '',
          fpi: body.faultsPerInterval || 1, ti: body.timeInterval || 1, ps: body.penaltySeconds || 6,
          isHunter: !!body.isHunter,
          flatEntries: body.flatEntries || null,
          paused: false,
          ts: new Date().toISOString()
        }), { expirationTtl: 300 });
        // Hunter: persist entries-seen list per class so live page can show
        // who has gone even before the .cls writes (forced placement classes)
        if (body.isHunter && body.flatEntries && body.flatEntries.length) {
          const selRaw = await env.WEST_LIVE.get(`selected:${slug}:${ring}`);
          if (selRaw) {
            const sel = JSON.parse(selRaw);
            const seenKey = `hunterseen:${slug}:${ring}:${sel.classNum}`;
            // Merge with existing — watcher resets flatEntriesSeen on class re-select
            const existingRaw = await env.WEST_LIVE.get(seenKey);
            const existing = existingRaw ? JSON.parse(existingRaw) : [];
            const merged = {};
            existing.forEach(e => { merged[e.entry] = e; });
            body.flatEntries.forEach(e => { merged[e.entry] = e; });
            await env.WEST_LIVE.put(seenKey, JSON.stringify(Object.values(merged)), { expirationTtl: 7200 });
          }
        }
        console.log(`[ON_COURSE] ${slug}:${ring} — #${body.entry} ${body.horse}${body.isHunter ? ' [hunter]' : ''}${body.flatEntries ? ' [flat:' + body.flatEntries.length + ']' : ''}`);
        return json({ ok: true, event: 'ON_COURSE', entry: body.entry });
      }

      if (event === 'HUNTER_RESULT') {
        // Flat/forced class result announcement — accumulates results as operator
        // announces ribbons. Store the growing list on oncourse KV so live page
        // can render ribbons appearing in real time.
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        const prev = existing ? JSON.parse(existing) : {};
        await env.WEST_LIVE.put(key, JSON.stringify({
          ...prev,
          phase: 'RESULTS',
          entry: body.entry, horse: body.horse, rider: body.rider,
          place: body.place, score: body.score || '',
          isHunter: true,
          hunterResults: body.hunterResults || [],
          ts: new Date().toISOString()
        }), { expirationTtl: 600 });
        console.log(`[HUNTER_RESULT] ${slug}:${ring} — #${body.entry} ${body.place}`);
        return json({ ok: true, event: 'HUNTER_RESULT', entry: body.entry });
      }

      if (event === 'CLOCK_STOPPED') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        if (existing) {
          const oc = JSON.parse(existing);
          oc.paused = true;
          oc.elapsed = body.elapsed || oc.elapsed;
          await env.WEST_LIVE.put(key, JSON.stringify(oc), { expirationTtl: 300 });
        }
        console.log(`[CLOCK_STOPPED] ${slug}:${ring} — #${body.entry} el=${body.elapsed}`);
        return json({ ok: true, event: 'CLOCK_STOPPED' });
      }

      if (event === 'CLOCK_RESUMED') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        if (existing) {
          const oc = JSON.parse(existing);
          oc.paused = false;
          oc.elapsed = body.elapsed || oc.elapsed;
          oc.ts = new Date().toISOString(); // reset ts anchor to now
          await env.WEST_LIVE.put(key, JSON.stringify(oc), { expirationTtl: 300 });
        }
        console.log(`[CLOCK_RESUMED] ${slug}:${ring} — #${body.entry} el=${body.elapsed}`);
        return json({ ok: true, event: 'CLOCK_RESUMED' });
      }

      if (event === 'CLEAR_ONCOURSE') {
        await env.WEST_LIVE.delete(`oncourse:${slug}:${ring}`);
        console.log(`[CLEAR_ONCOURSE] ${slug}:${ring}`);
        return json({ ok: true, event: 'CLEAR_ONCOURSE' });
      }

      if (event === 'CLASS_SELECTED') {
        const now = new Date().toISOString();
        // Update selected (most recent Ctrl+A) for backward compat
        await env.WEST_LIVE.put(`selected:${slug}:${ring}`, JSON.stringify({
          classNum, className, ts: now
        }), { expirationTtl: 7200 });
        // Add to active classes array (concurrent classes in the ring)
        const activeKey = `active:${slug}:${ring}`;
        const activeRaw = await env.WEST_LIVE.get(activeKey);
        let active = activeRaw ? JSON.parse(activeRaw) : [];
        // Update existing or add new
        const idx = active.findIndex(a => String(a.classNum) === String(classNum));
        if (idx >= 0) {
          active[idx].ts = now;
          active[idx].className = className;
          active[idx].ring = ring;
        } else {
          active.push({ classNum, className, ring, ts: now });
        }
        await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
        // Reopen class if it was marked complete — operator reopened it on scoring PC
        ctx.waitUntil(reopenClassIfComplete(env, slug, ring, classNum));
        console.log(`[CLASS_SELECTED] ${slug}:${ring} — class ${classNum} (${active.length} active)`);
        return json({ ok: true, event: 'CLASS_SELECTED', classNum, activeCount: active.length });
      }

      if (event === 'CLASS_COMPLETE') {
        // Remove from active classes array
        const activeKey = `active:${slug}:${ring}`;
        const activeRaw = await env.WEST_LIVE.get(activeKey);
        let active = activeRaw ? JSON.parse(activeRaw) : [];
        active = active.filter(a => String(a.classNum) !== String(classNum));
        await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
        // Clear `selected` if it points at the completed class — otherwise
        // results/live pages keep showing the Live badge for a closed class
        const selectedKey = `selected:${slug}:${ring}`;
        const selRaw = await env.WEST_LIVE.get(selectedKey);
        if (selRaw) {
          try {
            const sel = JSON.parse(selRaw);
            if (String(sel.classNum) === String(classNum)) {
              await env.WEST_LIVE.delete(selectedKey);
            }
          } catch(e) { /* ignore parse errors */ }
        }
        // Add to recent completions list (30 min TTL, live page shows "Recent Results")
        const recentKey = `recent:${slug}:${ring}`;
        const recentRaw = await env.WEST_LIVE.get(recentKey);
        let recent = recentRaw ? JSON.parse(recentRaw) : [];
        // Remove if already present (re-complete), then add at top
        recent = recent.filter(r => String(r.classNum) !== String(classNum));
        recent.unshift({ classNum, className, ring, completedAt: new Date().toISOString() });
        await env.WEST_LIVE.put(recentKey, JSON.stringify(recent), { expirationTtl: 1800 });

        // Mark class complete in D1
        ctx.waitUntil(markClassComplete(env, slug, ring, classNum, className));
        console.log(`[CLASS_COMPLETE] ${slug}:${ring} — class ${classNum} (${active.length} remaining, ${recent.length} recent)`);
        return json({ ok: true, event: 'CLASS_COMPLETE', classNum });
      }

      if (event === 'ORDER_POSTED') {
        console.log(`[ORDER_POSTED] ${slug}:${ring} class ${classNum} (via peek)`);
        return json({ ok: true, event: 'ORDER_POSTED', classNum });
      }

      return err('Unknown event type');
    }

    // ── POST /postSchedule ──────────────────────────────────────────────────
    // Watcher posts tsked.csv data — updates scheduled_date, schedule_order, schedule_flag
    if (method === 'POST' && path === '/postSchedule') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classes: schedClasses } = body;
      if (!slug || !ring || !schedClasses) return err('Missing slug, ring, or classes');
      if (await isShowLocked(env, slug)) return json({ ok: false, locked: true });
      ctx.waitUntil(writeSchedule(env, slug, ring, schedClasses));
      console.log(`[postSchedule] ${slug}:${ring} — ${schedClasses.length} classes`);
      return json({ ok: true, count: schedClasses.length });
    }

    // ── POST /heartbeat ───────────────────────────────────────────────────────
    // Watcher posts every 60s to signal it is alive
    if (method === 'POST' && path === '/heartbeat') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { body = {}; }
      const slug = url.searchParams.get('slug') || body.slug || 'unknown';
      const ring = url.searchParams.get('ring') || body.ring || '1';

      // Reject heartbeat if show is locked (admin set to complete)
      const locked = await isShowLocked(env, slug);
      if (locked) {
        console.log(`[heartbeat] ${slug} LOCKED — rejecting`);
        return json({ ok: false, locked: true, message: 'Show is complete — watcher rejected' });
      }

      const payload = {
        ts: new Date().toISOString(),
        slug, ring,
        version: body.version || '2.0',
        scoreboardPort: body.scoreboardPort || '',
      };
      if (body.clock) payload.clock = body.clock;
      const key = `heartbeat:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(payload), { expirationTtl: 120 });
      // Persistent last-seen — never expires. Only refresh every ~10s to avoid
      // pounding a never-expiring key when watcher heartbeats at 1/sec.
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec % 10 === 0) {
        await env.WEST_LIVE.put(`lastseen:${slug}:${ring}`, JSON.stringify(payload));
      }
      ctx.waitUntil(activateShow(env, slug));
      return json({ ok: true });
    }

    // ── GET /getLiveClass ─────────────────────────────────────────────────────
    // Website polls to get current live class state + latest UDP event
    if (method === 'GET' && path === '/getLiveClass') {
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring') || '1';
      if (!slug) return err('Missing slug');
      const [activeRaw, eventRaw, heartbeatRaw, selectedRaw, oncourseRaw, lastseenRaw, recentRaw] = await Promise.all([
        env.WEST_LIVE.get(`active:${slug}:${ring}`),
        env.WEST_LIVE.get(`event:${slug}:${ring}`),
        env.WEST_LIVE.get(`heartbeat:${slug}:${ring}`),
        env.WEST_LIVE.get(`selected:${slug}:${ring}`),
        env.WEST_LIVE.get(`oncourse:${slug}:${ring}`),
        env.WEST_LIVE.get(`lastseen:${slug}:${ring}`),
        env.WEST_LIVE.get(`recent:${slug}:${ring}`),
      ]);
      const active = activeRaw ? JSON.parse(activeRaw) : [];
      const selected = selectedRaw ? JSON.parse(selectedRaw) : null;

      // Fetch per-class live data for all active classes
      const classDataMap = {};
      const computedMap = {};
      const hunterSeenMap = {};
      if (active.length) {
        const [classReads, resultsReads, seenReads] = await Promise.all([
          Promise.all(active.map(a => env.WEST_LIVE.get(`live:${slug}:${ring}:${a.classNum}`))),
          Promise.all(active.map(a => env.WEST_LIVE.get(`results:${slug}:${ring}:${a.classNum}`))),
          Promise.all(active.map(a => env.WEST_LIVE.get(`hunterseen:${slug}:${ring}:${a.classNum}`))),
        ]);
        active.forEach((a, i) => {
          if (classReads[i]) classDataMap[a.classNum] = JSON.parse(classReads[i]);
          if (resultsReads[i]) computedMap[a.classNum] = JSON.parse(resultsReads[i]);
          if (seenReads[i]) hunterSeenMap[a.classNum] = JSON.parse(seenReads[i]);
        });
      }

      // Filter recent completions — drop anything older than 30 min
      let recentClasses = recentRaw ? JSON.parse(recentRaw) : [];
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      recentClasses = recentClasses.filter(r => r.completedAt > thirtyMinAgo);

      return jsonWithEtag(request, {
        ok:             true,
        activeClasses:  active,
        recentClasses:  recentClasses,
        selected:       selected,
        classData:      classDataMap,
        computed:       computedMap,
        hunterSeen:     hunterSeenMap,
        latestEvent:    eventRaw     ? JSON.parse(eventRaw)     : null,
        onCourse:       oncourseRaw  ? JSON.parse(oncourseRaw)  : null,
        watcherAlive:   !!heartbeatRaw,
        watcherVersion: heartbeatRaw ? JSON.parse(heartbeatRaw).version : (lastseenRaw ? JSON.parse(lastseenRaw).version : null),
        heartbeatTs:    heartbeatRaw ? JSON.parse(heartbeatRaw).ts : null,
        heartbeatClock: heartbeatRaw ? JSON.parse(heartbeatRaw).clock || null : null,
        lastSeenTs:     lastseenRaw  ? JSON.parse(lastseenRaw).ts  : null,
      });
    }

    // ── GET /getShow ──────────────────────────────────────────────────────────
    // Public — show info + rings for the show hub page
    if (method === 'GET' && path === '/getShow') {
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      ctx.waitUntil(autoCompleteStaleClasses(env, slug));
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id, slug, name, venue, dates, location, year, status, rings_count, start_date, end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, show: null, rings: [] });
        const rings = await env.WEST_DB.prepare(
          'SELECT ring_num, ring_name, sort_order, status FROM rings WHERE show_id = ? ORDER BY sort_order ASC, CAST(ring_num AS INTEGER) ASC'
        ).bind(show.id).all();
        const classCounts = await env.WEST_DB.prepare(
          "SELECT ring, COUNT(*) as count, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete_count FROM classes WHERE show_id = ? AND (hidden = 0 OR hidden IS NULL) GROUP BY ring"
        ).bind(show.id).all();
        const countMap = {};
        (classCounts.results || []).forEach(r => { countMap[r.ring] = { total: r.count, complete: r.complete_count }; });
        const ringsData = (rings.results || []).map(r => ({
          ...r,
          class_count: countMap[r.ring_num] ? countMap[r.ring_num].total : 0,
          complete_count: countMap[r.ring_num] ? countMap[r.ring_num].complete : 0,
        }));
        return json({ ok: true, show, rings: ringsData });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getShowStats ─────────────────────────────────────────────────────
    // Aggregated show-level stats: top riders, top horses, prize money leaders
    if (method === 'GET' && path === '/getShowStats') {
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return json({ ok: true, stats: null });

        // Total entries, unique riders, unique horses
        const totals = await env.WEST_DB.prepare(`
          SELECT COUNT(*) as totalEntries,
                 COUNT(DISTINCT e.rider) as uniqueRiders,
                 COUNT(DISTINCT e.horse) as uniqueHorses
          FROM entries e
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
        `).bind(show.id).first();

        // Entries per day
        const perDay = await env.WEST_DB.prepare(`
          SELECT c.scheduled_date as date, COUNT(*) as entries
          FROM entries e
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND c.scheduled_date IS NOT NULL AND c.scheduled_date != ''
          GROUP BY c.scheduled_date
          ORDER BY c.scheduled_date
        `).bind(show.id).all();

        // Top riders by 1st places (blues) — excludes championship classes
        const topRiders = await env.WEST_DB.prepare(`
          SELECT e.rider,
                 COUNT(CASE WHEN r.place = '1' THEN 1 END) as blues,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 3 THEN 1 END) as podiums,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 6 THEN 1 END) as ribbons,
                 COUNT(DISTINCT c.id) as classes
          FROM entries e
          JOIN results r ON r.entry_id = e.id AND r.round = 1
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND COALESCE(json_extract(c.final_results, '$.isChampionship'), 0) != 1
            AND r.place IS NOT NULL AND r.place != '' AND CAST(r.place AS INTEGER) > 0
          GROUP BY UPPER(e.rider)
          HAVING blues > 0
          ORDER BY blues DESC, podiums DESC, ribbons DESC
          LIMIT 10
        `).bind(show.id).all();

        // Top horses by 1st places — excludes championship classes
        const topHorses = await env.WEST_DB.prepare(`
          SELECT e.horse, e.rider,
                 COUNT(CASE WHEN r.place = '1' THEN 1 END) as blues,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 3 THEN 1 END) as podiums,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 6 THEN 1 END) as ribbons,
                 COUNT(DISTINCT c.id) as classes
          FROM entries e
          JOIN results r ON r.entry_id = e.id AND r.round = 1
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND e.horse IS NOT NULL AND e.horse != ''
            AND COALESCE(json_extract(c.final_results, '$.isChampionship'), 0) != 1
            AND r.place IS NOT NULL AND r.place != '' AND CAST(r.place AS INTEGER) > 0
          GROUP BY UPPER(e.horse)
          HAVING blues > 0
          ORDER BY blues DESC, podiums DESC, ribbons DESC
          LIMIT 10
        `).bind(show.id).all();

        // Champions & Reserve Champions — parse H[11] from cls_raw header
        const champClasses = await env.WEST_DB.prepare(`
          SELECT c.id, c.class_name, c.cls_raw, c.class_type
          FROM classes c
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND c.class_type = 'H' AND c.cls_raw IS NOT NULL AND c.cls_raw != ''
        `).bind(show.id).all();
        const champClassIds = [];
        for (const cc of (champClasses.results || [])) {
          const header = cc.cls_raw.split(/\r?\n/)[0].split(',');
          if (header[11] === 'True') champClassIds.push(cc);
        }
        let champResults = [];
        for (const cc of champClassIds) {
          const rows = await env.WEST_DB.prepare(`
            SELECT e.horse, e.rider, r.place
            FROM entries e
            JOIN results r ON r.entry_id = e.id AND r.round = 1
            WHERE e.class_id = ? AND r.place IS NOT NULL AND r.place != ''
              AND CAST(r.place AS INTEGER) BETWEEN 1 AND 2
            ORDER BY CAST(r.place AS INTEGER)
          `).bind(cc.id).all();
          for (const row of (rows.results || [])) {
            champResults.push({ horse: row.horse, rider: row.rider, class_name: cc.class_name, place: row.place });
          }
        }
        champResults.sort((a, b) => a.class_name.localeCompare(b.class_name) || parseInt(a.place) - parseInt(b.place));

        // Prize money leaders (by horse)
        const prizeLeaders = await env.WEST_DB.prepare(`
          SELECT e.horse, e.rider, c.class_num, c.class_name,
                 r.place, c.cls_raw
          FROM entries e
          JOIN results r ON r.entry_id = e.id AND r.round = 1
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND r.place IS NOT NULL AND r.place != '' AND CAST(r.place AS INTEGER) > 0
            AND e.horse IS NOT NULL AND e.horse != ''
        `).bind(show.id).all();

        // Compute prize money from cls_raw @money rows
        const prizeTotals = {};
        const classMoneyCache = {};
        for (const row of (prizeLeaders.results || [])) {
          if (!row.cls_raw) continue;
          if (!classMoneyCache[row.class_num]) {
            const moneyLine = row.cls_raw.split(/\r?\n/).find(l => l.startsWith('@money'));
            classMoneyCache[row.class_num] = moneyLine ? moneyLine.split(',').slice(1).map(Number) : [];
          }
          const prizes = classMoneyCache[row.class_num];
          const p = parseInt(row.place);
          if (p > 0 && p <= prizes.length && prizes[p - 1] > 0) {
            const key = row.horse.toUpperCase();
            if (!prizeTotals[key]) prizeTotals[key] = { horse: row.horse, rider: row.rider, total: 0, classes: 0 };
            prizeTotals[key].total += prizes[p - 1];
            prizeTotals[key].classes++;
          }
        }
        const moneyLeaders = Object.values(prizeTotals)
          .sort((a, b) => b.total - a.total)
          .slice(0, 10);

        return jsonWithEtag(request, {
          ok: true,
          stats: {
            totalEntries: totals.totalEntries || 0,
            uniqueRiders: totals.uniqueRiders || 0,
            uniqueHorses: totals.uniqueHorses || 0,
            entriesPerDay: perDay.results || [],
            topRiders: topRiders.results || [],
            topHorses: topHorses.results || [],
            champions: champResults,
            moneyLeaders: moneyLeaders,
          }
        });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getShowWeather ──────────────────────────────────────────────────
    // Per-day weather for show dates. Checks D1 cache first, fetches from
    // Open-Meteo (historical or forecast) for missing days, stores permanently.
    if (method === 'GET' && path === '/getShowWeather') {
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id, location, start_date, end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show || !show.start_date || !show.location) return json({ ok: true, days: [] });

        const startDate = show.start_date;
        const endDate = show.end_date || show.start_date;

        // Get cached days from D1
        const cached = await env.WEST_DB.prepare(
          'SELECT date, temp_high, temp_low, weather_code, precip_mm, wind_max, humidity_mean FROM show_weather WHERE show_id = ? ORDER BY date'
        ).bind(show.id).all();
        const cachedMap = {};
        (cached.results || []).forEach(r => { cachedMap[r.date] = r; });

        // Build list of all show dates
        const allDates = [];
        let cur = new Date(startDate + 'T12:00:00Z');
        const end = new Date(endDate + 'T12:00:00Z');
        while (cur <= end) {
          allDates.push(cur.toISOString().split('T')[0]);
          cur.setDate(cur.getDate() + 1);
        }

        // Find missing dates
        const today = new Date().toISOString().split('T')[0];
        const missingPast = allDates.filter(d => d <= today && !cachedMap[d]);
        const missingFuture = allDates.filter(d => d > today && !cachedMap[d]);

        // Geocode location
        let lat = null, lon = null;
        if (missingPast.length || missingFuture.length) {
          const city = show.location.split(',')[0].trim();
          const geoR = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1');
          if (geoR.ok) {
            const geo = await geoR.json();
            if (geo.results && geo.results.length) {
              lat = geo.results[0].latitude;
              lon = geo.results[0].longitude;
            }
          }
        }

        // Fetch historical for past missing dates
        if (lat && missingPast.length) {
          const histStart = missingPast[0];
          const histEnd = missingPast[missingPast.length - 1];
          try {
            const hr = await fetch('https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon
              + '&start_date=' + histStart + '&end_date=' + histEnd
              + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,relative_humidity_2m_mean'
              + '&timezone=America/New_York&temperature_unit=fahrenheit');
            if (hr.ok) {
              const hd = await hr.json();
              if (hd.daily && hd.daily.time) {
                const now = new Date().toISOString().replace('T', ' ').split('.')[0];
                for (let i = 0; i < hd.daily.time.length; i++) {
                  const date = hd.daily.time[i];
                  if (!cachedMap[date]) {
                    const row = {
                      date, temp_high: hd.daily.temperature_2m_max[i],
                      temp_low: hd.daily.temperature_2m_min[i],
                      weather_code: hd.daily.weathercode[i],
                      precip_mm: hd.daily.precipitation_sum ? hd.daily.precipitation_sum[i] : null,
                      wind_max: hd.daily.windspeed_10m_max ? hd.daily.windspeed_10m_max[i] : null,
                      humidity_mean: hd.daily.relative_humidity_2m_mean ? hd.daily.relative_humidity_2m_mean[i] : null,
                    };
                    cachedMap[date] = row;
                    await env.WEST_DB.prepare(
                      'INSERT INTO show_weather (show_id, date, temp_high, temp_low, weather_code, precip_mm, wind_max, humidity_mean, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(show_id, date) DO UPDATE SET temp_high=excluded.temp_high, temp_low=excluded.temp_low, weather_code=excluded.weather_code, precip_mm=excluded.precip_mm, wind_max=excluded.wind_max, humidity_mean=excluded.humidity_mean, updated_at=excluded.updated_at'
                    ).bind(show.id, date, row.temp_high, row.temp_low, row.weather_code, row.precip_mm, row.wind_max, row.humidity_mean, now).run();
                  }
                }
              }
            }
          } catch(e) { console.error('[weather hist]', e.message); }
        }

        // Fetch forecast for future missing dates
        if (lat && missingFuture.length) {
          try {
            const fr = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon
              + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,relative_humidity_2m_mean'
              + '&timezone=America/New_York&temperature_unit=fahrenheit&forecast_days=14');
            if (fr.ok) {
              const fd = await fr.json();
              if (fd.daily && fd.daily.time) {
                for (let i = 0; i < fd.daily.time.length; i++) {
                  const date = fd.daily.time[i];
                  if (missingFuture.includes(date) && !cachedMap[date]) {
                    cachedMap[date] = {
                      date, temp_high: fd.daily.temperature_2m_max[i],
                      temp_low: fd.daily.temperature_2m_min[i],
                      weather_code: fd.daily.weathercode[i],
                      precip_mm: fd.daily.precipitation_sum ? fd.daily.precipitation_sum[i] : null,
                      wind_max: fd.daily.windspeed_10m_max ? fd.daily.windspeed_10m_max[i] : null,
                      humidity_mean: fd.daily.relative_humidity_2m_mean ? fd.daily.relative_humidity_2m_mean[i] : null,
                    };
                    // Don't persist forecasts — they change daily
                  }
                }
              }
            }
          } catch(e) { console.error('[weather forecast]', e.message); }
        }

        // Build response — only show dates
        const days = allDates.map(d => cachedMap[d] || { date: d }).filter(d => d.temp_high != null);

        return jsonWithEtag(request, { ok: true, days });
      } catch(e) { return err('Weather error: ' + e.message); }
    }

    // ── GET /searchShow ────────────────────────────────────────────────────────
    // Search for rider or horse across all classes at a show
    if (method === 'GET' && path === '/searchShow') {
      const slug = url.searchParams.get('slug');
      const q = (url.searchParams.get('q') || '').trim();
      if (!slug) return err('Missing slug');
      if (!q || q.length < 2) return json({ ok: true, results: [] });
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return json({ ok: true, results: [] });
        const pattern = '%' + q + '%';
        const rows = await env.WEST_DB.prepare(`
          SELECT e.entry_num, e.horse, e.rider, e.owner, e.sire, e.dam, e.city, e.state,
                 c.class_num, c.class_name, c.class_type, c.ring,
                 r.round, r.time, r.jump_faults, r.time_faults, r.total, r.place, r.status_code
          FROM entries e
          JOIN classes c ON e.class_id = c.id
          LEFT JOIN results r ON r.entry_id = e.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND (e.horse LIKE ? OR e.rider LIKE ?)
          ORDER BY e.horse, e.rider, c.class_num, r.round
        `).bind(show.id, pattern, pattern).all();

        // Group by unique horse+rider combo
        const grouped = {};
        for (const row of (rows.results || [])) {
          const key = (row.horse || '').toUpperCase() + '|' + (row.rider || '').toUpperCase();
          if (!grouped[key]) {
            grouped[key] = {
              entry_num: row.entry_num, horse: row.horse, rider: row.rider,
              owner: row.owner, sire: row.sire, dam: row.dam,
              city: row.city, state: row.state, classes: {}
            };
          }
          const cn = row.class_num;
          if (!grouped[key].classes[cn]) {
            grouped[key].classes[cn] = {
              class_num: cn, class_name: row.class_name,
              class_type: row.class_type, ring: row.ring, rounds: []
            };
          }
          if (row.round) {
            grouped[key].classes[cn].rounds.push({
              round: row.round, time: row.time, jump_faults: row.jump_faults,
              time_faults: row.time_faults, total: row.total,
              place: row.place, status_code: row.status_code
            });
          }
        }

        // Convert to array, classes as array
        const results = Object.values(grouped).map(g => ({
          ...g, classes: Object.values(g.classes)
        }));

        return jsonWithEtag(request, { ok: true, results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getClasses ───────────────────────────────────────────────────────
    // Website gets all classes for a show with status
    if (method === 'GET' && path === '/getClasses') {
      const slug = url.searchParams.get('slug');
      if (slug) ctx.waitUntil(autoCompleteStaleClasses(env, slug));
      const ring = url.searchParams.get('ring') || null;
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, classes: [] });

        let sql = `
          SELECT c.*, COUNT(e.id) as entry_count,
                 SUM(CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END) as competed_count
          FROM classes c
          LEFT JOIN entries e ON e.class_id = c.id
          WHERE c.show_id = ?
        `;
        const params = [show.id];
        if (ring) { sql += ' AND c.ring = ?'; params.push(ring); }
        // Public requests (no auth) hide hidden classes; admin sees all
        const isAdmin = isAuthed(request, env);
        if (!isAdmin) { sql += ' AND (c.hidden = 0 OR c.hidden IS NULL)'; }
        sql += ' GROUP BY c.id ORDER BY c.scheduled_date ASC, c.schedule_order ASC, CAST(c.class_num AS INTEGER) ASC';

        const result = await env.WEST_DB.prepare(sql).bind(...params).all();
        return jsonWithEtag(request, { ok: true, classes: result.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getResults ───────────────────────────────────────────────────────
    // Website gets full results for a specific class.
    // Priority: KV pre-computed results (live/recent) → D1 fallback (historical).
    // cls_raw is NEVER sent to the client — computation happens server-side.
    if (method === 'GET' && path === '/getResults') {
      const slug     = url.searchParams.get('slug');
      const classNum = url.searchParams.get('classNum');
      const ring     = url.searchParams.get('ring') || '1';
      if (!slug || !classNum) return err('Missing slug or classNum');
      try {
        // Try KV pre-computed results first (live or recently completed classes)
        const resultsKey = `results:${slug}:${ring}:${classNum}`;
        const kvResults = await env.WEST_LIVE.get(resultsKey);
        if (kvResults) {
          const computed = JSON.parse(kvResults);
          // For OOG classes with no results, attach pre-show stats (cached in KV)
          if (computed.orderOfGo && computed.orderOfGo.length && (!computed.entries || !computed.entries.length)) {
            const psKey = `prestats:${slug}:${ring}:${classNum}`;
            const cached = await env.WEST_LIVE.get(psKey);
            if (cached) {
              computed.preShowStats = JSON.parse(cached);
            } else {
              try {
                const ps = await buildPreShowStats(env, slug, computed.orderOfGo);
                computed.preShowStats = ps;
                if (ps) await env.WEST_LIVE.put(psKey, JSON.stringify(ps), { expirationTtl: 300 }); // 5 min cache
              } catch(e) { console.error('[preShowStats]', e.message); }
            }
          }
          return jsonWithEtag(request, { ok: true, source: 'live', computed });
        }

        // Fallback: D1 (historical/completed classes)
        const show = await env.WEST_DB.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, class: null, entries: [] });

        const cls = await env.WEST_DB.prepare(
          'SELECT * FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
        ).bind(show.id, ring, classNum).first();
        if (!cls) return json({ ok: true, class: null, entries: [] });

        // If we have final_results in D1 (frozen on CLASS_COMPLETE), serve that
        if (cls.final_results) {
          return jsonWithEtag(request, { ok: true, source: 'final', computed: JSON.parse(cls.final_results) });
        }

        // Last resort: compute on-the-fly from D1 cls_raw if available.
        // This handles historical classes completed before the computation engine
        // was deployed. Once computed, the result is NOT cached (one-off).
        if (cls.cls_raw) {
          try {
            // Fetch D1 entries to populate the body for jumper computation
            // (hunter derby reads from clsRaw, but jumper needs the entries array)
            const d1Entries = await env.WEST_DB.prepare(`
              SELECT e.entry_num, e.horse, e.rider, e.owner, e.country,
                     e.sire, e.dam, e.city, e.state, e.horse_fei, e.rider_fei,
                     r.round, r.time, r.jump_faults, r.time_faults,
                     r.total, r.place, r.status_code
              FROM entries e
              LEFT JOIN results r ON r.entry_id = e.id
              WHERE e.class_id = ?
              ORDER BY e.entry_num, r.round
            `).bind(cls.id).all();

            // Map D1 rows into the watcher's entry shape (grouped by entry_num)
            const entryMap = {};
            (d1Entries.results || []).forEach(row => {
              if (!entryMap[row.entry_num]) {
                entryMap[row.entry_num] = {
                  entryNum: row.entry_num, horse: row.horse, rider: row.rider,
                  owner: row.owner, country: row.country, sire: row.sire, dam: row.dam,
                  city: row.city, state: row.state, hasGone: false,
                  place: '', overallPlace: '', statusCode: '',
                };
              }
              const e = entryMap[row.entry_num];
              if (row.round === 1) {
                e.r1Time = row.time || ''; e.r1TotalTime = row.time || '';
                e.r1JumpFaults = row.jump_faults || '0'; e.r1TimeFaults = row.time_faults || '0';
                e.r1TotalFaults = row.total || '0'; e.hasGone = true;
                e.r1StatusCode = row.status_code || '';
              } else if (row.round === 2) {
                e.r2Time = row.time || ''; e.r2TotalTime = row.time || '';
                e.r2JumpFaults = row.jump_faults || '0'; e.r2TimeFaults = row.time_faults || '0';
                e.r2TotalFaults = row.total || '0';
                e.r2StatusCode = row.status_code || '';
              } else if (row.round === 3) {
                e.r3Time = row.time || ''; e.r3TotalTime = row.time || '';
                e.r3JumpFaults = row.jump_faults || '0'; e.r3TimeFaults = row.time_faults || '0';
                e.r3TotalFaults = row.total || '0';
              }
              if (row.place) { e.place = row.place; e.overallPlace = row.place; }
              if (row.status_code) e.statusCode = row.status_code;
            });

            const fakeBody = {
              filename: cls.class_num + '.cls',
              classType: cls.class_type || 'U',
              className: cls.class_name || '',
              sponsor: cls.sponsor || '',
              trophy: '',
              showFlags: !!cls.show_flags,
              clsRaw: cls.cls_raw,
              entries: Object.values(entryMap),
            };
            const computed = computeClassResults(fakeBody);
            return jsonWithEtag(request, { ok: true, source: 'computed-fallback', computed });
          } catch(e) {
            console.error('[getResults] On-the-fly compute failed:', e.message);
          }
        }

        // Absolute last resort: raw D1 entries (no cls_raw sent to client)
        const entries = await env.WEST_DB.prepare(`
          SELECT e.entry_num, e.horse, e.rider, e.owner, e.country,
                 e.sire, e.dam, e.city, e.state, e.horse_fei, e.rider_fei,
                 r.round, r.time, r.jump_faults, r.time_faults,
                 r.total, r.place, r.status_code
          FROM entries e
          LEFT JOIN results r ON r.entry_id = e.id
          WHERE e.class_id = ?
          ORDER BY CAST(r.place AS INTEGER), e.entry_num, r.round
        `).bind(cls.id).all();

        const { cls_raw: _raw, ...clsSafe } = cls;
        return jsonWithEtag(request, { ok: true, source: 'db', class: clsSafe, entries: entries.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getShows — public list of shows for the index page ──────────────
    if (method === 'GET' && path === '/getShows') {
      try {
        // Read hideUpcoming setting — if enabled, filter out pending shows
        const settingsRaw = await env.WEST_LIVE.get('settings');
        const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
        const hideUpcoming = !!settings.hideUpcoming;

        let sql = "SELECT slug, name, venue, dates, location, year, status, rings_count, start_date, end_date FROM shows WHERE status != 'hidden'";
        if (hideUpcoming) sql += " AND status != 'pending'";
        sql += " ORDER BY COALESCE(start_date, created_at) DESC";
        const result = await env.WEST_DB.prepare(sql).all();
        return json({ ok: true, shows: result.results || [] });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /admin/shows ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/shows') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const year   = url.searchParams.get('year')   || null;
      const status = url.searchParams.get('status') || null;
      let sql = 'SELECT * FROM shows', params = [], where = [];
      if (year)   { where.push('year = ?');   params.push(year); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY created_at DESC';
      try {
        const result = await env.WEST_DB.prepare(sql).bind(...params).all();
        // Add class counts per show
        const shows = result.results || [];
        for (const s of shows) {
          const counts = await env.WEST_DB.prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete FROM classes WHERE show_id = ?"
          ).bind(s.id).first();
          s.class_total = counts ? counts.total : 0;
          s.class_active = counts ? counts.active : 0;
          s.class_complete = counts ? counts.complete : 0;
        }
        return json({ ok: true, shows });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /admin/showData ───────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/showData') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, show: null, classes: [] });
        const classes = await env.WEST_DB.prepare(
          'SELECT * FROM classes WHERE show_id = ? ORDER BY CAST(class_num AS INTEGER) ASC'
        ).bind(show.id).all();
        return json({ ok: true, show, classes: classes.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/createShow ────────────────────────────────────────────────
    // Admin page creates a show before the watcher runs
    if (method === 'POST' && path === '/admin/createShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, name, venue, dates, location, rings_count, stats_eligible,
              start_date, end_date } = body;
      if (!slug) return err('Missing slug');
      const now  = new Date().toISOString().replace('T', ' ').split('.')[0];
      const year = new Date().getFullYear();
      try {
        await env.WEST_DB.prepare(`
          INSERT INTO shows (slug, name, venue, dates, location, year, rings_count,
                             stats_eligible, status, start_date, end_date,
                             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            name           = excluded.name,
            venue          = excluded.venue,
            dates          = excluded.dates,
            location       = excluded.location,
            rings_count    = excluded.rings_count,
            stats_eligible = excluded.stats_eligible,
            start_date     = excluded.start_date,
            end_date       = excluded.end_date,
            updated_at     = excluded.updated_at
        `).bind(
          slug, name || '', venue || '', dates || '', location || '',
          year, rings_count || 1,
          stats_eligible !== false ? 1 : 0,
          start_date || null, end_date || null,
          now, now
        ).run();
        const show = await env.WEST_DB.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        // Auto-create Ring 1 on new shows so the Watcher Status card has
        // something to point at immediately. No-op if rings already exist.
        if (show) {
          const ringCount = await env.WEST_DB.prepare(
            'SELECT COUNT(*) AS n FROM rings WHERE show_id = ?'
          ).bind(show.id).first();
          if (!ringCount || !ringCount.n) {
            await env.WEST_DB.prepare(`
              INSERT INTO rings (show_id, ring_num, ring_name, sort_order, status)
              VALUES (?, '1', 'Ring 1', 0, 'active')
              ON CONFLICT(show_id, ring_num) DO NOTHING
            `).bind(show.id).run();
            console.log(`[admin] Auto-created Ring 1 for new show ${slug}`);
          }
        }
        console.log(`[admin] Created show: ${slug}`);
        return json({ ok: true, show });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/updateShow ────────────────────────────────────────────────
    // Admin page updates show fields (name, stats_eligible, status etc)
    if (method === 'POST' && path === '/admin/updateShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ...fields } = body;
      if (!slug) return err('Missing slug');
      const allowed = ['name','venue','dates','location','rings_count',
                       'stats_eligible','status','notes','start_date','end_date'];
      const sets = [], params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
      }
      if (!sets.length) return err('No valid fields to update');
      // If admin is explicitly setting status=active, bump end_date if it's in the past
      // so autoCompleteShow doesn't immediately flip it back.
      if (fields.status === 'active' && !('end_date' in fields)) {
        const cur = await env.WEST_DB.prepare(
          'SELECT end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        const today = new Date().toISOString().split('T')[0];
        if (cur && cur.end_date && cur.end_date < today) {
          sets.push('end_date = ?');
          params.push(today);
        }
      }
      sets.push('updated_at = ?');
      params.push(new Date().toISOString().replace('T', ' ').split('.')[0]);
      params.push(slug);
      try {
        await env.WEST_DB.prepare(
          `UPDATE shows SET ${sets.join(', ')} WHERE slug = ?`
        ).bind(...params).run();
        const show = await env.WEST_DB.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        return json({ ok: true, show });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/deleteShow ────────────────────────────────────────────────
    // Cascade-delete a show and all its child data from D1. Pass
    // `?confirm=1` or { confirm: true } to actually run — otherwise we
    // return a preview of what would be deleted so the admin UI can show
    // the user a count before they pull the trigger.
    if (method === 'POST' && path === '/admin/deleteShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const slug = body.slug;
      const confirm = body.confirm === true || url.searchParams.get('confirm') === '1';
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id, name FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        const counts = await env.WEST_DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM classes WHERE show_id = ?) AS classes,
            (SELECT COUNT(*) FROM entries WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)) AS entries,
            (SELECT COUNT(*) FROM results WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)) AS results
        `).bind(show.id, show.id, show.id).first();
        if (!confirm) {
          return json({ ok: true, preview: true, show, counts });
        }
        // Delete children first, then the show.
        await env.WEST_DB.prepare(
          'DELETE FROM results WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)'
        ).bind(show.id).run();
        await env.WEST_DB.prepare(
          'DELETE FROM entries WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)'
        ).bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM classes WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM rings WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM ring_activity WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM show_weather WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM shows WHERE id = ?').bind(show.id).run();
        console.log(`[deleteShow] ${slug} — cascaded delete (classes=${counts.classes}, entries=${counts.entries}, results=${counts.results})`);
        return json({ ok: true, deleted: true, show, counts });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/migrate — run schema migrations ───────────────────────────
    if (method === 'POST' && path === '/admin/migrate') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const results = [];
      const migrations = [
        "ALTER TABLE classes ADD COLUMN clock_precision INTEGER DEFAULT 2",
        "ALTER TABLE classes ADD COLUMN cls_raw TEXT",
        "ALTER TABLE classes ADD COLUMN hidden INTEGER DEFAULT 0",
        "ALTER TABLE classes ADD COLUMN stats_exclude INTEGER DEFAULT 0",
        "ALTER TABLE rings ADD COLUMN sort_order INTEGER DEFAULT 0",
        "CREATE TABLE IF NOT EXISTS ring_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, show_id INTEGER NOT NULL, ring TEXT NOT NULL, date TEXT NOT NULL, first_post_at TEXT NOT NULL, last_post_at TEXT NOT NULL, UNIQUE(show_id, ring, date))",
        "ALTER TABLE ring_activity ADD COLUMN first_horse_at TEXT",
        "ALTER TABLE shows ADD COLUMN start_date TEXT",
        "ALTER TABLE shows ADD COLUMN end_date TEXT",
        "ALTER TABLE classes ADD COLUMN final_results TEXT",
        "CREATE TABLE IF NOT EXISTS show_weather (id INTEGER PRIMARY KEY AUTOINCREMENT, show_id INTEGER NOT NULL, date TEXT NOT NULL, temp_high REAL, temp_low REAL, weather_code INTEGER, precip_mm REAL, wind_max REAL, humidity_mean REAL, source TEXT DEFAULT 'open-meteo', updated_at TEXT, UNIQUE(show_id, date))",
      ];
      for (const sql of migrations) {
        try { await env.WEST_DB.prepare(sql).run(); results.push({ sql, ok: true }); }
        catch(e) { results.push({ sql, ok: false, error: e.message }); }
      }
      return json({ ok: true, results });
    }

    // ── POST /admin/removeLiveClass — remove a class from active array ────────
    if (method === 'POST' && path === '/admin/removeLiveClass') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classNum } = body;
      if (!slug || !ring || !classNum) return err('Missing slug, ring, or classNum');
      const activeKey = `active:${slug}:${ring}`;
      const activeRaw = await env.WEST_LIVE.get(activeKey);
      let active = activeRaw ? JSON.parse(activeRaw) : [];
      active = active.filter(a => String(a.classNum) !== String(classNum));
      await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
      console.log(`[admin] Removed class ${classNum} from live — ${active.length} remaining`);
      return json({ ok: true, classNum, remaining: active.length });
    }

    // ── GET /admin/rings — get rings for a show ────────────────────────────────
    if (method === 'GET' && path === '/admin/rings') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return json({ ok: true, rings: [] });
        const result = await env.WEST_DB.prepare(
          'SELECT * FROM rings WHERE show_id = ? ORDER BY sort_order ASC, CAST(ring_num AS INTEGER) ASC'
        ).bind(show.id).all();
        return json({ ok: true, rings: result.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/upsertRing — add or update a ring ────────────────────────
    if (method === 'POST' && path === '/admin/upsertRing') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const { slug, ring_num, ring_name, sort_order } = body;
      if (!slug || !ring_num) return err('Missing slug or ring_num');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found');
        await env.WEST_DB.prepare(`
          INSERT INTO rings (show_id, ring_num, ring_name, sort_order, status)
          VALUES (?, ?, ?, ?, 'active')
          ON CONFLICT(show_id, ring_num) DO UPDATE SET
            ring_name = excluded.ring_name,
            sort_order = excluded.sort_order
        `).bind(show.id, ring_num, ring_name || '', sort_order != null ? sort_order : 0).run();
        // Keep shows.rings_count in sync with actual ring count
        await env.WEST_DB.prepare(
          'UPDATE shows SET rings_count = (SELECT COUNT(*) FROM rings WHERE show_id = ?) WHERE id = ?'
        ).bind(show.id, show.id).run();
        return json({ ok: true, ring_num });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/deleteRing — remove a ring ─────────────────────────────
    if (method === 'DELETE' && path === '/admin/deleteRing') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      const ring_num = url.searchParams.get('ring_num');
      if (!slug || !ring_num) return err('Missing slug or ring_num');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found');
        await env.WEST_DB.prepare('DELETE FROM rings WHERE show_id = ? AND ring_num = ?').bind(show.id, ring_num).run();
        // Keep shows.rings_count in sync with actual ring count
        await env.WEST_DB.prepare(
          'UPDATE shows SET rings_count = (SELECT COUNT(*) FROM rings WHERE show_id = ?) WHERE id = ?'
        ).bind(show.id, show.id).run();
        return json({ ok: true, ring_num });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/uploadCls — manual cls file upload, bypasses show lock ────
    if (method === 'POST' && path === '/admin/uploadCls') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring } = extractSlugRing(body, url);
      if (!slug || !ring) return err('Missing slug or ring');
      const classNum = (body.filename || '').replace('.cls', '');
      if (!classNum) return err('Missing filename');

      // Check if this class exists and warn on mismatch
      const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
      if (!show) return err('Show not found');
      const existing = await env.WEST_DB.prepare(
        'SELECT class_num, class_name FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
      ).bind(show.id, ring, classNum).first();

      // Write to D1 — intentionally bypasses isShowLocked
      await writeToD1(env, body, slug, ring);

      console.log(`[admin/uploadCls] ${slug}:${ring} class ${classNum} — manual upload`);
      return json({
        ok: true,
        classNum,
        isNew: !existing,
        existingName: existing ? existing.class_name : null,
      });
    }

    // ── POST /admin/updateClass — toggle hidden, stats_exclude, status ────────
    if (method === 'POST' && path === '/admin/updateClass') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classNum } = body;
      if (!slug || !classNum) return err('Missing slug or classNum');
      const allowed = ['hidden', 'stats_exclude', 'status'];
      const sets = [], params = [];
      for (const [k, v] of Object.entries(body)) {
        if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
      }
      if (!sets.length) return err('No valid fields');
      sets.push('updated_at = datetime(\'now\')');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found');
        params.push(show.id, ring || '1', classNum);
        await env.WEST_DB.prepare(
          `UPDATE classes SET ${sets.join(', ')} WHERE show_id = ? AND ring = ? AND class_num = ?`
        ).bind(...params).run();
        console.log(`[updateClass] ${slug}:${classNum} — ${sets.join(', ')}`);
        return json({ ok: true, classNum });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/completeClass ─────────────────────────────────────────────
    // Watcher posts on 3x Ctrl+A — marks class complete in D1
    if (method === 'POST' && path === '/admin/completeClass') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classNum } = body;
      if (!slug || !classNum) return err('Missing slug or classNum');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found');
        const now = new Date().toISOString().replace('T', ' ').split('.')[0];
        await env.WEST_DB.prepare(`
          UPDATE classes SET status = 'complete', updated_at = ?
          WHERE show_id = ? AND ring = ? AND class_num = ?
        `).bind(now, show.id, ring || '1', classNum).run();
        console.log(`[completeClass] ${slug}:${ring} class ${classNum}`);
        return json({ ok: true, classNum, status: 'complete' });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearShow ───────────────────────────────────────────────
    if (method === 'DELETE' && path === '/admin/clearShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        await env.WEST_DB.prepare('PRAGMA foreign_keys = ON').run();
        const result = await env.WEST_DB.prepare(
          'DELETE FROM shows WHERE slug = ?'
        ).bind(slug).run();
        console.log(`[admin] Cleared show: ${slug}`);
        return json({ ok: true, message: `Show ${slug} cleared`, changes: result.meta.changes });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearAll ────────────────────────────────────────────────
    if (method === 'DELETE' && path === '/admin/clearAll') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        await env.WEST_DB.prepare('PRAGMA foreign_keys = ON').run();
        await env.WEST_DB.prepare('DELETE FROM shows').run();
        console.log('[admin] Cleared all data');
        return json({ ok: true, message: 'All data cleared from D1' });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearClassCache ─────────────────────────────────────────
    // Delete ONLY the cached computed-results KV entry for a specific class
    // so the next /getResults call rebuilds from D1 (e.g. after a D1 patch).
    // Does NOT delete the live:* class data KV — that has no D1 fallback
    // and deleting it blanks the live page until the watcher re-posts, which
    // is unsafe on a spotty scoring-PC network.
    if (method === 'DELETE' && path === '/admin/clearClassCache') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug     = url.searchParams.get('slug');
      const ring     = url.searchParams.get('ring') || '1';
      const classNum = url.searchParams.get('classNum');
      if (!slug || !classNum) return err('Missing slug or classNum');
      await env.WEST_LIVE.delete(`results:${slug}:${ring}:${classNum}`);
      console.log(`[admin] Cleared results cache: ${slug}:${ring}:${classNum}`);
      return json({ ok: true, message: `Results cache cleared for class ${classNum}` });
    }

    // ── DELETE /admin/clearLive ───────────────────────────────────────────────
    if (method === 'DELETE' && path === '/admin/clearLive') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring') || '1';
      if (!slug) return err('Missing slug');
      await Promise.all([
        env.WEST_LIVE.delete(`live:${slug}:${ring}`),
        env.WEST_LIVE.delete(`event:${slug}:${ring}`),
        env.WEST_LIVE.delete(`heartbeat:${slug}:${ring}`),
        env.WEST_LIVE.delete(`selected:${slug}:${ring}`),
        env.WEST_LIVE.delete(`active:${slug}:${ring}`),
        env.WEST_LIVE.delete(`oncourse:${slug}:${ring}`),
        env.WEST_LIVE.delete(`lastseen:${slug}:${ring}`),
      ]);
      console.log(`[admin] Cleared live KV: ${slug}:${ring}`);
      return json({ ok: true, message: `Live data cleared for ${slug} ring ${ring}` });
    }

    // ── GET /admin/dbStats ─────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/dbStats') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        const [shows, classes, entries, results] = await Promise.all([
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM shows').first(),
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM classes').first(),
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM entries').first(),
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM results').first(),
        ]);
        return json({ ok: true, shows: shows.c, classes: classes.c, entries: entries.c, results: results.c });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /admin/settings ────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/settings') {
      const raw = await env.WEST_LIVE.get('settings');
      return json({ ok: true, settings: raw ? JSON.parse(raw) : { showDifficultyGauge: false } });
    }

    // ── POST /admin/settings ───────────────────────────────────────────────
    if (method === 'POST' && path === '/admin/settings') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const raw = await env.WEST_LIVE.get('settings');
      const settings = raw ? JSON.parse(raw) : {};
      Object.assign(settings, body);
      await env.WEST_LIVE.put('settings', JSON.stringify(settings));
      console.log(`[admin] Settings updated: ${JSON.stringify(settings)}`);
      return json({ ok: true, settings });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // v3 endpoints — all gated by isV3Enabled(env). Reads/writes WEST_DB_V3
    // (separate D1 from v2's WEST_DB). Phase 1: shows + rings only.
    // Slug validation: ^[a-z][a-z0-9-]{2,59}$
    // ═══════════════════════════════════════════════════════════════════════

    // ── GET /v3/engineLatest ─────────────────────────────────────────────────
    // Returns the manifest for the latest engine asar release. Engine polls
    // this on boot + every 60min and surfaces "Update available" when the
    // manifest's version > ENGINE_VERSION.
    //
    // To publish a release:
    //   1. Bump ENGINE_VERSION in v3/engine/main.js
    //   2. npm run build → produces app.asar at v3/engine/dist/win-unpacked/resources/
    //   3. Compute SHA-256 of that asar
    //   4. Upload asar to Pages preview at /engine/<version>.asar
    //   5. Edit ENGINE_LATEST below + redeploy worker
    //
    // The hardcoded constant pattern keeps the release flow simple — no
    // KV/D1 dependency. When the release cadence picks up, swap to KV.
    if (method === 'GET' && path === '/v3/engineLatest') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const ENGINE_LATEST = {
              version: '3.1.5',
              asarUrl: 'https://preview.westscoring.pages.dev/engine/3.1.5.asar',
              sha256:  'be2fd2532ba22d57544f81392b54d7ec120cb3f65079b886372124d75ae9461f',
              releasedAt: '2026-05-06T20:14:45.686Z',
              releaseNotes: 'Flush live now wipes EVERY class off the live page (including finalized) with a 15-second cooldown to absorb trailing .cls writes from class-close. Worker-side fixes: Channel B {29}=F always wins (no more race-condition un-finalize), un-finalize requires same B+intro pair as live trigger, stale focus carries forward only within 20 minutes, hunter score box now shows the actually-displayed round (not just the highest scored), per-judge breakdown follows the displayed round.',
            };
      return json({ manifest: ENGINE_LATEST });
    }

    // ── GET /v3/listShowsWithRings ───────────────────────────────────────────
    // Index-page fetch. Shape: shows (same as listShows) + each show's
    // rings, + each ring's most-recent 3 classes that have entries. Used
    // by index.html to render a v2-style "what's running" preview under
    // each show card. One round-trip instead of 3-per-show.
    if (method === 'GET' && path === '/v3/listShowsWithRings') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        const { results: showRows } = await env.WEST_DB_V3.prepare(
          'SELECT id, slug, name, start_date, end_date, venue, location, status, stats_eligible, lock_override, logo_url, created_at, updated_at FROM shows ORDER BY start_date DESC, id DESC'
        ).all();
        const shows = (showRows || []);
        for (const s of shows) s.is_locked = computeShowLock(s).locked ? 1 : 0;
        if (!shows.length) return json({ ok: true, shows: [] });

        const showIds = shows.map(s => s.id);
        const ph = showIds.map(() => '?').join(',');

        // Rings + class counts in two cheap queries.
        const { results: ringRows } = await env.WEST_DB_V3.prepare(
          `SELECT id, show_id, ring_num, name FROM rings WHERE show_id IN (${ph}) ORDER BY ring_num`
        ).bind(...showIds).all();
        const rings = ringRows || [];

        // Recent classes per ring — pull all classes-with-entries for these
        // rings ordered most-recent first, then trim to top 3 per ring
        // server-side. Cheaper than a CTE/window query in D1.
        const ringIds = rings.map(r => r.id);
        let classes = [];
        if (ringIds.length) {
          const cph = ringIds.map(() => '?').join(',');
          const { results: cRows } = await env.WEST_DB_V3.prepare(
            `SELECT c.id, c.ring_id, c.class_id, c.class_name, c.scheduled_date, c.class_type,
                    (SELECT COUNT(*) FROM entries WHERE class_id = c.id) AS entry_count
             FROM classes c
             WHERE c.ring_id IN (${cph}) AND (c.deleted_at IS NULL)
             ORDER BY c.scheduled_date DESC NULLS LAST, c.class_id DESC`
          ).bind(...ringIds).all();
          classes = (cRows || []).filter(c => (c.entry_count || 0) > 0);
        }

        // Group classes by ring_id, top 3 each.
        const classesByRing = {};
        for (const c of classes) {
          const arr = classesByRing[c.ring_id] || (classesByRing[c.ring_id] = []);
          if (arr.length < 3) arr.push(c);
        }

        // Live-class detection: read each ring's KV ring-state snapshot
        // and check last_scoring.at recency. "Class live" = there was a
        // scoring frame in the last 2 min — distinct from engine alive
        // (engine could be on overnight). Window is generous enough to
        // survive a brief pause between entries but short enough that a
        // ring that just finished doesn't keep pulsing for hours.
        const LIVE_WINDOW_MS = 2 * 60 * 1000;
        const liveCutoff = Date.now() - LIVE_WINDOW_MS;
        const showsById = {};
        for (const s of shows) showsById[s.id] = s;
        const snapKeys = rings.map(r => ({
          ring_id: r.id,
          key: `ring-state:${showsById[r.show_id].slug}:${r.ring_num}`,
        }));
        const snaps = await Promise.all(snapKeys.map(k =>
          env.WEST_LIVE.get(k.key).then(raw => ({ ring_id: k.ring_id, raw })).catch(() => ({ ring_id: k.ring_id, raw: null }))
        ));
        // S46 — prefer the explicit is_live flag (B+intro trigger,
        // FINAL/30min un-live) over the legacy 2-min "scoring frame
        // received" heuristic. Falls back when an old snapshot didn't
        // carry is_live yet so the index/show pages keep working.
        const liveByRing = {};
        for (const { ring_id, raw } of snaps) {
          if (!raw) continue;
          try {
            const snap = JSON.parse(raw);
            if (typeof snap.is_live === 'boolean') {
              if (snap.is_live) liveByRing[ring_id] = true;
            } else {
              const ts = snap && snap.last_scoring && snap.last_scoring.at;
              if (ts && ts > liveCutoff) liveByRing[ring_id] = true;
            }
          } catch (e) { /* malformed snapshot, treat as not live */ }
        }

        // Group rings by show_id, attach classes + class_live.
        const ringsByShow = {};
        for (const r of rings) {
          (ringsByShow[r.show_id] || (ringsByShow[r.show_id] = [])).push({
            ring_num: r.ring_num,
            name: r.name,
            classes: classesByRing[r.id] || [],
            class_live: !!liveByRing[r.id],
          });
        }
        for (const s of shows) {
          s.rings = ringsByShow[s.id] || [];
          // Show-level rollup: any ring live = show shows the pulse.
          s.class_live = s.rings.some(r => r.class_live);
        }

        return json({ ok: true, shows });
      } catch (e) { return err('DB error: ' + e.message, 500); }
    }

    // ── POST /v3/uploadShowLogo ──────────────────────────────────────────────
    // Admin uploads a per-show logo. multipart/form-data with field "logo"
    // (image file) and "slug" (target show slug). File goes to R2 at key
    // "show-logos/<slug>.<ext>"; shows.logo_url is updated to that key.
    // Replaces existing logo for the same slug (R2 put overwrites).
    if (method === 'POST' && path === '/v3/uploadShowLogo') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        const form = await request.formData();
        const file = form.get('logo');
        const slug = (form.get('slug') || url.searchParams.get('slug') || '').trim();
        if (!slug) return err('Missing slug');
        if (!file || typeof file === 'string') return err('Missing logo file');
        if (!(file instanceof File) && !(file && file.arrayBuffer)) return err('Invalid logo file');
        const size = file.size || 0;
        if (size <= 0) return err('Empty logo file');
        if (size > 5 * 1024 * 1024) return err('Logo too large (max 5MB)');

        const ct = file.type || 'application/octet-stream';
        // Map content-type to extension. Default to png if unknown — most
        // operators upload PNG anyway, and the worker still serves with the
        // stored Content-Type.
        const extByType = {
          'image/png': 'png',
          'image/jpeg': 'jpg',
          'image/webp': 'webp',
          'image/svg+xml': 'svg',
          'image/gif': 'gif',
        };
        const ext = extByType[ct] || 'png';
        const key = `show-logos/${slug}.${ext}`;

        // Verify slug exists before writing — avoid orphaned R2 objects.
        const show = await env.WEST_DB_V3.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found', 404);

        await env.WEST_R2_CLS.put(key, file.stream(), {
          httpMetadata: { contentType: ct },
        });

        // If a previous upload used a different extension, clean it up.
        // Cheap shotgun delete — try common extensions; ignore misses.
        for (const oldExt of ['png', 'jpg', 'webp', 'svg', 'gif']) {
          if (oldExt === ext) continue;
          await env.WEST_R2_CLS.delete(`show-logos/${slug}.${oldExt}`).catch(() => {});
        }

        await env.WEST_DB_V3.prepare('UPDATE shows SET logo_url = ? WHERE slug = ?')
          .bind(key, slug).run();

        return json({ ok: true, key, contentType: ct, size });
      } catch (e) {
        return err('Upload failed: ' + e.message, 500);
      }
    }

    // ── DELETE /v3/uploadShowLogo ───────────────────────────────────────────
    // Admin removes a show's logo. R2 object deleted, logo_url cleared.
    if (method === 'DELETE' && path === '/v3/uploadShowLogo') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare('SELECT logo_url FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found', 404);
        if (show.logo_url) await env.WEST_R2_CLS.delete(show.logo_url).catch(() => {});
        await env.WEST_DB_V3.prepare('UPDATE shows SET logo_url = NULL WHERE slug = ?').bind(slug).run();
        return json({ ok: true });
      } catch (e) {
        return err('Delete failed: ' + e.message, 500);
      }
    }

    // ── GET /v3/showLogo ────────────────────────────────────────────────────
    // Public — spectator pages embed this URL as <img src>. Reads
    // shows.logo_url, streams the R2 object with the right Content-Type
    // and a cache header. 404 when no logo (browser hides via onerror).
    if (method === 'GET' && path === '/v3/showLogo') {
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare('SELECT logo_url FROM shows WHERE slug = ?').bind(slug).first();
        if (!show || !show.logo_url) return err('Not found', 404);
        const obj = await env.WEST_R2_CLS.get(show.logo_url);
        if (!obj) return err('Not found', 404);
        const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/png';
        return new Response(obj.body, {
          status: 200,
          headers: {
            'Content-Type': ct,
            // Cache 5min in browser/edge; admin re-upload is rare and
            // operator can hard-refresh. Keeps Pages bandwidth low.
            'Cache-Control': 'public, max-age=300',
            ...CORS,
          },
        });
      } catch (e) {
        return err('Logo error: ' + e.message, 500);
      }
    }

    // ── GET /v3/getShowWeather ────────────────────────────────────────────────
    // Per-day weather for a show's date range. D1 cache first; on miss,
    // fetches from Open-Meteo (archive API for past dates, forecast for
    // future). Historical days persist; forecast days are not stored.
    // Ported from v2's /getShowWeather — same logic against WEST_DB_V3.
    if (method === 'GET' && path === '/v3/getShowWeather') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id, location, start_date, end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show || !show.start_date || !show.location) return json({ ok: true, days: [] });

        const startDate = show.start_date;
        const endDate = show.end_date || show.start_date;

        const cached = await env.WEST_DB_V3.prepare(
          'SELECT date, temp_high, temp_low, weather_code, precip_mm, wind_max, humidity_mean FROM show_weather WHERE show_id = ? ORDER BY date'
        ).bind(show.id).all();
        const cachedMap = {};
        (cached.results || []).forEach(r => { cachedMap[r.date] = r; });

        const allDates = [];
        let cur = new Date(startDate + 'T12:00:00Z');
        const end = new Date(endDate + 'T12:00:00Z');
        while (cur <= end) {
          allDates.push(cur.toISOString().split('T')[0]);
          cur.setDate(cur.getDate() + 1);
        }

        const today = new Date().toISOString().split('T')[0];
        const missingPast = allDates.filter(d => d <= today && !cachedMap[d]);
        const missingFuture = allDates.filter(d => d > today && !cachedMap[d]);

        let lat = null, lon = null;
        if (missingPast.length || missingFuture.length) {
          const city = show.location.split(',')[0].trim();
          const geoR = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1');
          if (geoR.ok) {
            const geo = await geoR.json();
            if (geo.results && geo.results.length) {
              lat = geo.results[0].latitude;
              lon = geo.results[0].longitude;
            }
          }
        }

        // Past dates → archive API (real measurements). Persist.
        if (lat && missingPast.length) {
          const histStart = missingPast[0];
          const histEnd = missingPast[missingPast.length - 1];
          try {
            const hr = await fetch('https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon
              + '&start_date=' + histStart + '&end_date=' + histEnd
              + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,relative_humidity_2m_mean'
              + '&timezone=America/New_York&temperature_unit=fahrenheit');
            if (hr.ok) {
              const hd = await hr.json();
              if (hd.daily && hd.daily.time) {
                const now = new Date().toISOString().replace('T', ' ').split('.')[0];
                for (let i = 0; i < hd.daily.time.length; i++) {
                  const date = hd.daily.time[i];
                  if (!cachedMap[date]) {
                    const row = {
                      date, temp_high: hd.daily.temperature_2m_max[i],
                      temp_low: hd.daily.temperature_2m_min[i],
                      weather_code: hd.daily.weathercode[i],
                      precip_mm: hd.daily.precipitation_sum ? hd.daily.precipitation_sum[i] : null,
                      wind_max: hd.daily.windspeed_10m_max ? hd.daily.windspeed_10m_max[i] : null,
                      humidity_mean: hd.daily.relative_humidity_2m_mean ? hd.daily.relative_humidity_2m_mean[i] : null,
                    };
                    cachedMap[date] = row;
                    await env.WEST_DB_V3.prepare(
                      'INSERT INTO show_weather (show_id, date, temp_high, temp_low, weather_code, precip_mm, wind_max, humidity_mean, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(show_id, date) DO UPDATE SET temp_high=excluded.temp_high, temp_low=excluded.temp_low, weather_code=excluded.weather_code, precip_mm=excluded.precip_mm, wind_max=excluded.wind_max, humidity_mean=excluded.humidity_mean, updated_at=excluded.updated_at'
                    ).bind(show.id, date, row.temp_high, row.temp_low, row.weather_code, row.precip_mm, row.wind_max, row.humidity_mean, now).run();
                  }
                }
              }
            }
          } catch(e) { console.error('[weather hist]', e.message); }
        }

        // Future dates → forecast API. Don't persist (changes daily).
        if (lat && missingFuture.length) {
          try {
            const fr = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon
              + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,relative_humidity_2m_mean'
              + '&timezone=America/New_York&temperature_unit=fahrenheit&forecast_days=14');
            if (fr.ok) {
              const fd = await fr.json();
              if (fd.daily && fd.daily.time) {
                for (let i = 0; i < fd.daily.time.length; i++) {
                  const date = fd.daily.time[i];
                  if (missingFuture.includes(date) && !cachedMap[date]) {
                    cachedMap[date] = {
                      date, temp_high: fd.daily.temperature_2m_max[i],
                      temp_low: fd.daily.temperature_2m_min[i],
                      weather_code: fd.daily.weathercode[i],
                      precip_mm: fd.daily.precipitation_sum ? fd.daily.precipitation_sum[i] : null,
                      wind_max: fd.daily.windspeed_10m_max ? fd.daily.windspeed_10m_max[i] : null,
                      humidity_mean: fd.daily.relative_humidity_2m_mean ? fd.daily.relative_humidity_2m_mean[i] : null,
                    };
                  }
                }
              }
            }
          } catch(e) { console.error('[weather forecast]', e.message); }
        }

        const days = allDates.map(d => cachedMap[d] || { date: d }).filter(d => d.temp_high != null);
        return json({ ok: true, days });
      } catch(e) { return err('Weather error: ' + e.message); }
    }

    // ── GET /v3/listShows ─────────────────────────────────────────────────────
    // Each show carries an `engine_live` boolean — true when any of its
    // rings has a heartbeat in KV (TTL 600s, so presence ⇒ recent). Drives
    // the admin sidebar dot — a show whose end_date has passed but whose
    // engine is still posting stays visually "live" rather than dropping
    // to the gray Past dot.
    if (method === 'GET' && path === '/v3/listShows') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        const { results } = await env.WEST_DB_V3.prepare(
          'SELECT id, slug, name, start_date, end_date, venue, location, status, stats_eligible, lock_override, logo_url, created_at, updated_at FROM shows ORDER BY start_date DESC, id DESC'
        ).all();
        const shows = results || [];
        // Computed lock state — admin sidebar reads is_locked directly,
        // lock_override is the underlying setting for the show edit dialog.
        for (const s of shows) {
          s.is_locked = computeShowLock(s).locked ? 1 : 0;
        }
        if (shows.length) {
          const showIds = shows.map(s => s.id);
          const placeholders = showIds.map(() => '?').join(',');
          const { results: ringRows } = await env.WEST_DB_V3.prepare(
            `SELECT show_id, ring_num FROM rings WHERE show_id IN (${placeholders})`
          ).bind(...showIds).all();
          const ringsByShow = new Map();
          for (const r of (ringRows || [])) {
            if (!ringsByShow.has(r.show_id)) ringsByShow.set(r.show_id, []);
            ringsByShow.get(r.show_id).push(r.ring_num);
          }
          await Promise.all(shows.map(async s => {
            const rings = ringsByShow.get(s.id) || [];
            if (!rings.length) { s.engine_live = false; return; }
            const hbs = await Promise.all(rings.map(rn =>
              env.WEST_LIVE.get(`engine:${s.slug}:${rn}`)
            ));
            s.engine_live = hbs.some(h => h != null);
          }));
        }
        return json({ ok: true, shows });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/createShow ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/v3/createShow') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, name, start_date, end_date, venue, location, status, stats_eligible, timezone, results_layout } = body;
      if (!slug) return err('Missing slug');
      if (!/^[a-z][a-z0-9-]{2,59}$/.test(slug)) {
        return err('Invalid slug — must match ^[a-z][a-z0-9-]{2,59}$');
      }
      if (!name || !name.trim()) return err('Missing name');
      const statusVal = status && ['pending','active','complete','archived'].includes(status) ? status : 'pending';
      const statsVal = stats_eligible === false || stats_eligible === 0 ? 0 : 1;
      const tzVal = (timezone && typeof timezone === 'string' && timezone.trim()) ? timezone.trim() : 'America/New_York';
      const layoutVal = (results_layout === 'inline' || results_layout === 'stacked') ? results_layout : 'stacked';
      try {
        await env.WEST_DB_V3.prepare(`
          INSERT INTO shows (slug, name, start_date, end_date, venue, location, status, stats_eligible, timezone, results_layout)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          slug, name.trim(), start_date || null, end_date || null,
          (venue || '').trim() || null, (location || '').trim() || null,
          statusVal, statsVal, tzVal, layoutVal
        ).run();
        const show = await env.WEST_DB_V3.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        // Auto-create Ring 1 — every show needs at least one ring for the
        // engine to connect to. Matches v2 behavior. Operator can rename it
        // or add more rings via the admin.
        if (show) {
          await env.WEST_DB_V3.prepare(`
            INSERT INTO rings (show_id, ring_num, name, sort_order)
            VALUES (?, 1, 'Ring 1', 0)
            ON CONFLICT(show_id, ring_num) DO NOTHING
          `).bind(show.id).run();
          console.log(`[v3] Created show ${slug} + auto-created Ring 1`);
        }
        return json({ ok: true, show });
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) return err('Slug already exists', 409);
        return err('DB error: ' + e.message);
      }
    }

    // ── GET /v3/getShow?slug=X ────────────────────────────────────────────────
    if (method === 'GET' && path === '/v3/getShow') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        show.is_locked = computeShowLock(show).locked ? 1 : 0;
        return json({ ok: true, show });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/updateShow ───────────────────────────────────────────────────
    // Updates any editable show field. Slug is NOT editable — it's the
    // primary key operators key off of. Rename requires a full migration
    // that's its own future feature.
    if (method === 'POST' && path === '/v3/updateShow') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, name, start_date, end_date, venue, location, status, stats_eligible, timezone, results_layout, stats_config, split_decision_top_n, lock_override } = body;
      if (!slug) return err('Missing slug');
      const updates = [];
      const binds = [];
      if (name !== undefined) {
        if (!name || !name.trim()) return err('Name cannot be empty');
        updates.push('name = ?'); binds.push(name.trim());
      }
      if (start_date !== undefined) { updates.push('start_date = ?'); binds.push(start_date || null); }
      if (end_date   !== undefined) { updates.push('end_date = ?');   binds.push(end_date   || null); }
      if (venue      !== undefined) { updates.push('venue = ?');      binds.push((venue    || '').trim() || null); }
      if (location   !== undefined) { updates.push('location = ?');   binds.push((location || '').trim() || null); }
      if (status     !== undefined) {
        if (!['pending','active','complete','archived'].includes(status)) {
          return err('Invalid status — must be pending/active/complete/archived');
        }
        updates.push('status = ?'); binds.push(status);
      }
      if (stats_eligible !== undefined) {
        updates.push('stats_eligible = ?');
        binds.push(stats_eligible === false || stats_eligible === 0 ? 0 : 1);
      }
      if (timezone !== undefined) {
        if (!timezone || typeof timezone !== 'string' || !timezone.trim()) return err('Timezone cannot be empty');
        updates.push('timezone = ?'); binds.push(timezone.trim());
      }
      if (results_layout !== undefined) {
        if (results_layout !== 'inline' && results_layout !== 'stacked') {
          return err("Invalid results_layout — must be 'stacked' or 'inline'");
        }
        updates.push('results_layout = ?'); binds.push(results_layout);
      }
      if (stats_config !== undefined) {
        // null clears the override (back to "all on" default).
        // Otherwise expect an object; serialize to JSON for storage.
        if (stats_config === null) {
          updates.push('stats_config = ?'); binds.push(null);
        } else if (typeof stats_config === 'object') {
          updates.push('stats_config = ?'); binds.push(JSON.stringify(stats_config));
        } else {
          return err('Invalid stats_config — expected object or null');
        }
      }
      if (split_decision_top_n !== undefined) {
        const n = Number(split_decision_top_n);
        if (!Number.isInteger(n) || n < 2 || n > 10) {
          return err('Invalid split_decision_top_n — must be an integer 2-10');
        }
        updates.push('split_decision_top_n = ?'); binds.push(n);
      }
      if (lock_override !== undefined) {
        if (!['auto', 'unlocked', 'locked'].includes(lock_override)) {
          return err("Invalid lock_override — must be 'auto', 'unlocked', or 'locked'");
        }
        updates.push('lock_override = ?'); binds.push(lock_override);
      }
      if (!updates.length) return err('No fields to update');
      updates.push("updated_at = datetime('now')");
      binds.push(slug);
      try {
        const res = await env.WEST_DB_V3.prepare(
          `UPDATE shows SET ${updates.join(', ')} WHERE slug = ?`
        ).bind(...binds).run();
        if (!res.meta || !res.meta.changes) return err('Show not found', 404);
        const show = await env.WEST_DB_V3.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (show) show.is_locked = computeShowLock(show).locked ? 1 : 0;
        console.log(`[v3] Updated show: ${slug}`);
        return json({ ok: true, show });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── GET /v3/listRings?slug=X ──────────────────────────────────────────────
    // Returns rings for a show. Each ring includes last_heartbeat and
    // last_cls (if any) from KV so admin can render both freshness signals.
    if (method === 'GET' && path === '/v3/listRings') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        const { results } = await env.WEST_DB_V3.prepare(
          'SELECT id, ring_num, name, sort_order, created_at, updated_at FROM rings WHERE show_id = ? ORDER BY sort_order, ring_num'
        ).bind(show.id).all();
        const rings = results || [];
        // class_live: prefer the explicit S46 is_live flag (B+intro
        // trigger, with FINAL/30min-timeout un-live) when the snapshot
        // carries it; fall back to the legacy 2-min "scoring frame
        // received" heuristic when an old worker build wrote the
        // snapshot without is_live. Same fallback semantics for
        // /v3/listShowsWithRings consumers.
        const LIVE_WINDOW_MS = 2 * 60 * 1000;
        const liveCutoff = Date.now() - LIVE_WINDOW_MS;
        for (const r of rings) {
          const hbRaw = await env.WEST_LIVE.get(`engine:${slug}:${r.ring_num}`);
          r.last_heartbeat = hbRaw ? JSON.parse(hbRaw) : null;
          const clsRaw = await env.WEST_LIVE.get(`cls-last:${slug}:${r.ring_num}`);
          r.last_cls = clsRaw ? JSON.parse(clsRaw) : null;
          const stateRaw = await env.WEST_LIVE.get(`ring-state:${slug}:${r.ring_num}`);
          let class_live = false;
          let live_class_ids = [];
          let live_since = null;
          if (stateRaw) {
            try {
              const snap = JSON.parse(stateRaw);
              if (typeof snap.is_live === 'boolean') {
                class_live = snap.is_live;
                live_class_ids = Array.isArray(snap.live_class_ids) ? snap.live_class_ids : [];
                live_since = snap.live_since || null;
              } else {
                const ts = snap && snap.last_scoring && snap.last_scoring.at;
                if (ts && ts > liveCutoff) class_live = true;
              }
            } catch (e) { /* malformed snapshot, treat as not live */ }
          }
          r.class_live = class_live;
          r.live_class_ids = live_class_ids;
          r.live_since = live_since;
        }
        return json({ ok: true, rings });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/postCls ─────────────────────────────────────────────────────
    // Engine POSTs raw .cls file bytes every time the file changes on the
    // scoring PC. Identity via headers (simpler than multipart for bytes).
    // Writes to R2 at "{slug}/{ring_num}/{class_num}.cls" — one object per
    // class, overwritten per change. KV tracks last-seen for fast admin UI.
    //
    // Headers:
    //   X-West-Key    (auth, same as other endpoints)
    //   X-West-Slug   show slug
    //   X-West-Ring   ring number
    //   X-West-Class  class identifier (e.g. "51" or "51C" for championships)
    // Body: raw .cls bytes (application/octet-stream)
    if (method === 'POST' && path === '/v3/postCls') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug    = request.headers.get('X-West-Slug');
      const ringStr = request.headers.get('X-West-Ring');
      const classId = request.headers.get('X-West-Class');
      if (!slug || !ringStr || !classId) {
        return err('Missing X-West-Slug, X-West-Ring, or X-West-Class header');
      }
      const ringNum = parseInt(ringStr, 10);
      if (!Number.isFinite(ringNum)) return err('Invalid X-West-Ring');
      // Class identifier is operator-facing — can be numeric or have a
      // trailing 'C' for championships (e.g. 48C). Validate it's reasonable.
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(classId)) {
        return err('Invalid X-West-Class (expected short alphanumeric)');
      }
      // Verify the show/ring exists and grab both IDs for the classes upsert.
      // Lock check rolls into the same query — one round-trip.
      let showId, ringId;
      try {
        const row = await env.WEST_DB_V3.prepare(`
          SELECT r.id AS ring_id, s.id AS show_id, s.lock_override, s.end_date
          FROM rings r JOIN shows s ON s.id = r.show_id
          WHERE s.slug = ? AND r.ring_num = ?
        `).bind(slug, ringNum).first();
        if (!row) return err('Unknown show/ring pair', 404);
        const lk = computeShowLock(row);
        if (lk.locked) return lockedResponse(lk.reason);
        showId = row.show_id;
        ringId = row.ring_id;
      } catch (e) { return err('DB error: ' + e.message); }
      // Read the body bytes once and write to R2 overwrite-in-place
      const bytes = await request.arrayBuffer();
      const size = bytes.byteLength;
      if (size === 0) return err('Empty body');
      if (size > 5 * 1024 * 1024) return err('.cls file too large (>5MB)', 413);
      const r2Key = `${slug}/${ringNum}/${classId}.cls`;
      await env.WEST_R2_CLS.put(r2Key, bytes, {
        httpMetadata: { contentType: 'text/csv' },
        customMetadata: { slug, ring: String(ringNum), class: classId },
      });
      // Track "last-cls" in KV for admin UI. 24-hour TTL.
      const received_at = new Date().toISOString();
      const meta = { class_id: classId, filename: `${classId}.cls`, received_at, size, r2_key: r2Key };
      await env.WEST_LIVE.put(
        `cls-last:${slug}:${ringNum}`,
        JSON.stringify(meta),
        { expirationTtl: 86400 }
      );
      // Phase 2b: parse the header (Article 1 enforced) and upsert into
      // classes table. Archive is already safe (R2 above) — parse failure
      // never rejects the POST; it writes a parse_status row instead.
      let parsed;
      try { parsed = parseClsHeaderV3(bytes); }
      catch (e) { parsed = { class_type: 'U', class_name: null, parse_status: 'parse_error', parse_notes: 'parser threw: ' + e.message }; }
      let classDbId = null;
      try {
        await env.WEST_DB_V3.prepare(`
          INSERT INTO classes (show_id, ring_id, class_id, class_name, class_type,
                               scoring_method, scoring_modifier, class_mode,
                               scoring_type, num_judges, is_equitation,
                               num_rounds, score_method, ribbon_count,
                               is_championship, sponsor, ihsa, derby_type,
                               show_flags,
                               is_jogged, print_judge_scores, reverse_rank,
                               is_team, show_all_rounds, ribbons_only,
                               r1_time_allowed, r2_time_allowed, r3_time_allowed,
                               parse_status, parse_notes,
                               r2_key, first_seen_at, parsed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(show_id, ring_id, class_id) DO UPDATE SET
            class_name         = excluded.class_name,
            class_type         = excluded.class_type,
            scoring_method     = excluded.scoring_method,
            scoring_modifier   = excluded.scoring_modifier,
            class_mode         = excluded.class_mode,
            scoring_type       = excluded.scoring_type,
            num_judges         = excluded.num_judges,
            is_equitation      = excluded.is_equitation,
            num_rounds         = excluded.num_rounds,
            score_method       = excluded.score_method,
            ribbon_count       = excluded.ribbon_count,
            is_championship    = excluded.is_championship,
            sponsor            = excluded.sponsor,
            ihsa               = excluded.ihsa,
            derby_type         = excluded.derby_type,
            show_flags         = excluded.show_flags,
            is_jogged          = excluded.is_jogged,
            print_judge_scores = excluded.print_judge_scores,
            reverse_rank       = excluded.reverse_rank,
            is_team            = excluded.is_team,
            show_all_rounds    = excluded.show_all_rounds,
            ribbons_only       = excluded.ribbons_only,
            r1_time_allowed    = excluded.r1_time_allowed,
            r2_time_allowed    = excluded.r2_time_allowed,
            r3_time_allowed    = excluded.r3_time_allowed,
            parse_status       = excluded.parse_status,
            parse_notes        = excluded.parse_notes,
            r2_key             = excluded.r2_key,
            parsed_at          = datetime('now'),
            deleted_at         = NULL
        `).bind(
          showId, ringId, classId,
          parsed.class_name || null,
          parsed.class_type || 'U',
          parsed.scoring_method ?? null,
          parsed.scoring_modifier ?? null,
          parsed.class_mode ?? null,
          parsed.scoring_type ?? null,
          parsed.num_judges ?? null,
          parsed.is_equitation ?? null,
          parsed.num_rounds ?? null,
          parsed.score_method ?? null,
          parsed.ribbon_count ?? null,
          parsed.is_championship ?? null,
          parsed.sponsor ?? null,
          parsed.ihsa ?? null,
          parsed.derby_type ?? null,
          parsed.show_flags ?? 0,
          parsed.is_jogged ?? 0,
          parsed.print_judge_scores ?? 0,
          parsed.reverse_rank ?? 0,
          parsed.is_team ?? 0,
          parsed.show_all_rounds ?? 0,
          parsed.ribbons_only ?? 0,
          parsed.r1_time_allowed ?? null,
          parsed.r2_time_allowed ?? null,
          parsed.r3_time_allowed ?? null,
          parsed.parse_status || 'parse_error',
          parsed.parse_notes || null,
          r2Key,
        ).run();
        const row = await env.WEST_DB_V3.prepare(
          'SELECT id FROM classes WHERE show_id = ? AND ring_id = ? AND class_id = ?'
        ).bind(showId, ringId, classId).first();
        classDbId = row ? row.id : null;
      } catch (e) {
        console.log(`[v3/postCls] classes upsert failed for ${slug}/${ringNum}/${classId}: ${e.message}`);
        // Don't fail the POST — archive already succeeded.
      }

      // Phase 2c: parse + upsert entries. Skipped for U classes with no
      // method inferred (no lens to apply).
      let entriesStatus = 'not attempted';
      if (classDbId) {
        const lensKnown =
          parsed.class_type === 'H' ||
          parsed.class_type === 'J' ||
          parsed.class_type === 'T' ||
          (parsed.class_type === 'U' && parsed.scoring_method !== null && parsed.scoring_method !== undefined);
        try {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          const entryParse = parseClsEntriesV3(text, lensKnown);
          entriesStatus = entryParse.status;
          const currentNums = entryParse.entries.map(e => e.entry_num);
          // Trophy text comes from the body's @foot row, not the header.
          // Persist it on the class row regardless of entry-write outcome.
          try {
            await env.WEST_DB_V3.prepare(
              'UPDATE classes SET trophy = ? WHERE id = ?'
            ).bind(entryParse.trophy || null, classDbId).run();
          } catch (e) {
            console.log(`[v3/postCls] trophy update failed: ${e.message}`);
          }
          // Prize money (Bill 2026-05-06): @money row → JSON array of
          // amounts per place. class.html reads this to render prize
          // amounts under the ribbon SVGs on FINAL classes.
          try {
            const money = parseClsMoneyV3(bytes);
            await env.WEST_DB_V3.prepare(
              'UPDATE classes SET prize_money = ? WHERE id = ?'
            ).bind(money ? JSON.stringify(money) : null, classDbId).run();
          } catch (e) {
            console.log(`[v3/postCls] prize_money update failed: ${e.message}`);
          }
          // Tsked catch-up (Bill 2026-05-06): if this class was first
          // POSTed AFTER the operator's last tsked POST, its scheduled_date
          // never got set (worker UPDATEs only, never INSERTs from tsked).
          // Read the stored tsked.csv from R2 and apply this class's row
          // if present. Gated on scheduled_date IS NULL so a manual
          // re-tsked elsewhere can't get clobbered by stale R2 data.
          try {
            const tskedObj = await env.WEST_R2_CLS.get(`${slug}/tsked.csv`);
            if (tskedObj) {
              const tskedBytes = await tskedObj.arrayBuffer();
              const tskedText = new TextDecoder('utf-8', { fatal: false }).decode(tskedBytes);
              const tskedLines = tskedText.split(/\r?\n/);
              // Walk the file twice — first pass to compute the 1-indexed
              // position among VALID rows so schedule_order matches what
              // /v3/postTsked would have written. Second pass finds our
              // class and applies if present. Bill 2026-05-07.
              let tskedPos = 0;
              let matchedPos = null, matchedDate = null, matchedFlag = null;
              for (let li = 1; li < tskedLines.length; li++) {
                const tline = tskedLines[li];
                if (!tline.trim()) continue;
                const tcols = parseCsvLineV3(tline);
                const tcid = (tcols[0] || '').trim();
                if (!tcid) continue;
                tskedPos++;
                if (tcid !== classId) continue;
                const tdate = (tcols[2] || '').trim();
                const tflag = (tcols[3] || '').trim() || null;
                let tisoDate = null;
                const tm = tdate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (tm) tisoDate = `${tm[3]}-${tm[1].padStart(2, '0')}-${tm[2].padStart(2, '0')}`;
                if (tisoDate) {
                  matchedPos = tskedPos;
                  matchedDate = tisoDate;
                  matchedFlag = tflag;
                }
                break;
              }
              if (matchedPos != null) {
                await env.WEST_DB_V3.prepare(
                  `UPDATE classes SET scheduled_date = ?, schedule_flag = ?, schedule_order = ?
                   WHERE id = ? AND scheduled_date IS NULL`
                ).bind(matchedDate, matchedFlag, matchedPos, classDbId).run();
              }
            }
          } catch (e) {
            console.log(`[v3/postCls] tsked catch-up failed: ${e.message}`);
          }
          // Delete stale entries (removed by operator since last parse)
          if (lensKnown) {
            if (currentNums.length > 0) {
              const placeholders = currentNums.map(() => '?').join(',');
              await env.WEST_DB_V3.prepare(
                `DELETE FROM entries WHERE class_id = ? AND entry_num NOT IN (${placeholders})`
              ).bind(classDbId, ...currentNums).run();
            } else {
              await env.WEST_DB_V3.prepare(
                'DELETE FROM entries WHERE class_id = ?'
              ).bind(classDbId).run();
            }
            // Upsert each current entry
            for (const e of entryParse.entries) {
              await env.WEST_DB_V3.prepare(`
                INSERT INTO entries (class_id, entry_num, horse_name, rider_name, owner_name,
                                      horse_usef, rider_usef, owner_usef, city, state,
                                      country_code, sire, dam, raw_row, first_seen_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(class_id, entry_num) DO UPDATE SET
                  horse_name   = excluded.horse_name,
                  rider_name   = excluded.rider_name,
                  owner_name   = excluded.owner_name,
                  horse_usef   = excluded.horse_usef,
                  rider_usef   = excluded.rider_usef,
                  owner_usef   = excluded.owner_usef,
                  city         = excluded.city,
                  state        = excluded.state,
                  country_code = excluded.country_code,
                  sire         = excluded.sire,
                  dam          = excluded.dam,
                  raw_row      = excluded.raw_row,
                  updated_at   = datetime('now')
              `).bind(
                classDbId, e.entry_num, e.horse_name, e.rider_name, e.owner_name,
                e.horse_usef, e.rider_usef, e.owner_usef, e.city, e.state,
                e.country_code, e.sire, e.dam, e.raw_row
              ).run();
            }
          }

          // Phase 2d: jumper-scoring pass. Only runs for J and T lens.
          // Writes to entry_jumper_scores (linked table, keyed by entry_id).
          // Per-round status stored INDEPENDENTLY. No overall collapse.
          if (parsed.class_type === 'J' || parsed.class_type === 'T') {
            try {
              const scoreParse = parseEntriesScoreJ(text, parsed.class_type);
              // Build entry_num → id lookup once to avoid 25 SELECTs per class.
              const { results: idRows } = await env.WEST_DB_V3.prepare(
                'SELECT id, entry_num FROM entries WHERE class_id = ?'
              ).bind(classDbId).all();
              const idByNum = new Map(idRows.map(r => [r.entry_num, r.id]));
              // Write path is now TWO tables (per-round shape, Session 33 pivot):
              //   entry_jumper_summary — one row per entry, entry-scoped fields
              //   entry_jumper_rounds  — one row per entry PER round that has data
              // Absence of a round row = that round didn't happen.
              // Parser still emits a wide object per entry; we split it here.
              for (const s of scoreParse.entries) {
                const entryId = idByNum.get(s.entry_num);
                if (!entryId) continue;

                // Summary upsert (entry-scoped data)
                await env.WEST_DB_V3.prepare(`
                  INSERT INTO entry_jumper_summary (
                    entry_id, ride_order, overall_place,
                    score_parse_status, score_parse_notes,
                    first_seen_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                  ON CONFLICT(entry_id) DO UPDATE SET
                    ride_order=excluded.ride_order,
                    overall_place=excluded.overall_place,
                    score_parse_status=excluded.score_parse_status,
                    score_parse_notes=excluded.score_parse_notes,
                    updated_at=datetime('now')
                `).bind(
                  entryId, s.ride_order, s.overall_place,
                  s.score_parse_status, s.score_parse_notes
                ).run();

                // Round upserts — fresh-replace to handle the case where a
                // round used to have data and no longer does (operator edited
                // the class in Ryegate). Delete existing rounds for this
                // entry, then insert only rounds that currently have data.
                await env.WEST_DB_V3.prepare(
                  'DELETE FROM entry_jumper_rounds WHERE entry_id = ?'
                ).bind(entryId).run();

                for (const round of [1, 2, 3]) {
                  const p = `r${round}_`;
                  const time = s[p + 'time'];
                  const status = s[p + 'status'];
                  const numericStatus = s[p + 'numeric_status'];
                  // Skip rounds with zero data — absence of row = didn't happen.
                  const hasAnyData =
                    (time != null && time !== 0) ||
                    status != null ||
                    (numericStatus != null && numericStatus !== 0);
                  if (!hasAnyData) continue;
                  await env.WEST_DB_V3.prepare(`
                    INSERT INTO entry_jumper_rounds (
                      entry_id, round,
                      time, penalty_sec, total_time, time_faults, jump_faults, total_faults,
                      status, numeric_status,
                      first_seen_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                  `).bind(
                    entryId, round,
                    s[p + 'time'], s[p + 'penalty_sec'], s[p + 'total_time'],
                    s[p + 'time_faults'], s[p + 'jump_faults'], s[p + 'total_faults'],
                    s[p + 'status'], s[p + 'numeric_status']
                  ).run();
                }
              }
              entriesStatus += ` | ${scoreParse.status}`;
            } catch (scErr) {
              console.log(`[v3/postCls] jumper scoring failed for ${slug}/${ringNum}/${classId}: ${scErr.message}`);
              entriesStatus += ` | scoring error: ${scErr.message}`;
            }

            // Pre-compute class_jumper_stats. Mirrors the hunter
            // computeJudgeGridRanks pattern — reads what we just wrote;
            // failures here are logged but don't fail the whole POST.
            try {
              await computeJumperStats(env, classDbId);
              entriesStatus += ` | jumper-stats computed`;
            } catch (jsErr) {
              console.log(`[v3/postCls] jumper stats compute failed for ${slug}/${ringNum}/${classId}: ${jsErr.message}`);
              entriesStatus += ` | jumper-stats error: ${jsErr.message}`;
            }
          }

          // Phase 2d hunter: hunter-scoring pass. Only runs for H lens.
          // Writes to entry_hunter_summary + entry_hunter_rounds. Per-round
          // INDEPENDENT (same pattern as jumper side). Per-judge scores
          // NOT captured yet (deferred to future entry_hunter_judge_scores).
          if (parsed.class_type === 'H') {
            try {
              const scoreParse = parseEntriesScoreH(text, parsed.class_mode);
              const { results: idRows } = await env.WEST_DB_V3.prepare(
                'SELECT id, entry_num FROM entries WHERE class_id = ?'
              ).bind(classDbId).all();
              const idByNum = new Map(idRows.map(r => [r.entry_num, r.id]));
              for (const s of scoreParse.entries) {
                const entryId = idByNum.get(s.entry_num);
                if (!entryId) continue;

                // Summary upsert (entry-scoped)
                await env.WEST_DB_V3.prepare(`
                  INSERT INTO entry_hunter_summary (
                    entry_id, go_order, current_place, combined_total,
                    score_parse_status, score_parse_notes,
                    first_seen_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                  ON CONFLICT(entry_id) DO UPDATE SET
                    go_order=excluded.go_order,
                    current_place=excluded.current_place,
                    combined_total=excluded.combined_total,
                    score_parse_status=excluded.score_parse_status,
                    score_parse_notes=excluded.score_parse_notes,
                    updated_at=datetime('now')
                `).bind(
                  entryId, s.go_order, s.current_place, s.combined_total,
                  s.score_parse_status, s.score_parse_notes
                ).run();

                // Fresh-replace round rows (same pattern as jumper).
                await env.WEST_DB_V3.prepare(
                  'DELETE FROM entry_hunter_rounds WHERE entry_id = ?'
                ).bind(entryId).run();

                for (const round of [1, 2, 3]) {
                  const p = `r${round}_`;
                  const total = s[p + 'total'];
                  const status = s[p + 'status'];
                  const numericStatus = s[p + 'numeric_status'];
                  const hasAnyData =
                    (total != null && total !== 0) ||
                    status != null ||
                    (numericStatus != null && numericStatus !== 0);
                  if (!hasAnyData) continue;
                  await env.WEST_DB_V3.prepare(`
                    INSERT INTO entry_hunter_rounds (
                      entry_id, round, total, status, numeric_status,
                      first_seen_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                  `).bind(entryId, round, total, status, numericStatus).run();
                }
              }
              entriesStatus += ` | ${scoreParse.status}`;

              // Per-judge score capture (Phase 2d completion).
              // Runs after round totals — idempotent, CLASS-level fresh-replace.
              // Wiping at class level (not per-entry) so entries whose data
              // legitimately dropped to zero rows get their stale rows purged.
              try {
                const jsParse = parseHunterJudgeScores(
                  text,
                  parsed.class_mode,
                  parsed.num_judges,
                  parsed.scoring_type
                );
                // Wipe all existing judge rows for this class's entries.
                await env.WEST_DB_V3.prepare(
                  'DELETE FROM entry_hunter_judge_scores WHERE entry_id IN (SELECT id FROM entries WHERE class_id = ?)'
                ).bind(classDbId).run();
                // Insert current judge rows.
                for (const js of jsParse.entries) {
                  const entryId = idByNum.get(js.entry_num);
                  if (!entryId) continue;
                  for (const r of js.rows) {
                    await env.WEST_DB_V3.prepare(`
                      INSERT INTO entry_hunter_judge_scores (
                        entry_id, round, judge_idx,
                        base_score, high_options, handy_bonus,
                        first_seen_at, updated_at
                      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                    `).bind(
                      entryId, r.round, r.judge_idx,
                      r.base_score, r.high_options, r.handy_bonus
                    ).run();
                  }
                }
                entriesStatus += ` | ${jsParse.status}`;
              } catch (jsErr) {
                console.log(`[v3/postCls] hunter judge-scores failed for ${slug}/${ringNum}/${classId}: ${jsErr.message}`);
                entriesStatus += ` | judge-scores error: ${jsErr.message}`;
              }

              // Compute judge-grid ranks (judge_round_rank, round_overall_rank,
              // entry_hunter_judge_cards). Reads what we just wrote; mode-
              // agnostic SQL handles derby + non-derby alike. Failures here
              // are logged but don't fail the whole POST — raw data is still
              // good; ranks just go stale until next /v3/postCls or manual
              // recompute.
              try {
                await computeJudgeGridRanks(env, classDbId);
                entriesStatus += ` | ranks computed`;
              } catch (rkErr) {
                console.log(`[v3/postCls] judge-grid rank compute failed for ${slug}/${ringNum}/${classId}: ${rkErr.message}`);
                entriesStatus += ` | rank compute error: ${rkErr.message}`;
              }
            } catch (scErr) {
              console.log(`[v3/postCls] hunter scoring failed for ${slug}/${ringNum}/${classId}: ${scErr.message}`);
              entriesStatus += ` | hunter scoring error: ${scErr.message}`;
            }
          }
        } catch (e) {
          console.log(`[v3/postCls] entries upsert failed for ${slug}/${ringNum}/${classId}: ${e.message}`);
          entriesStatus = 'error: ' + e.message;
        }
      }
      // Phase 3b Chunk 13/14 — push fresh standings into the live
      // snapshot via the DO. /v3/postCls just updated D1; without this
      // ping the live page stays stale until the next UDP batch (which
      // may never come if the operator stops sending). DO gates on
      // focused class_id + lens so background postCls for a different
      // class or lens doesn't clobber the foreground leaderboard.
      try {
        const id = env.RING_STATE.idFromName(`${slug}:${ringNum}`);
        const stub = env.RING_STATE.get(id);
        if (parsed.class_type === 'H') {
          const hs = await pullHunterScoresV3(env, classDbId);
          if (hs) {
            ctx.waitUntil(stub.fetch('https://do/scores-update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug, ring_num: ringNum, class_id: classId, hunter_scores: hs }),
            }));
          }
        } else if (parsed.class_type === 'J' || parsed.class_type === 'T') {
          const js = await pullJumperScoresV3(env, classDbId);
          if (js) {
            ctx.waitUntil(stub.fetch('https://do/scores-update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug, ring_num: ringNum, class_id: classId, jumper_scores: js }),
            }));
          }
        }
      } catch (e) {
        console.log(`[v3/postCls] DO scores-update ping failed: ${e.message}`);
      }
      return json({ ok: true, r2_key: r2Key, size, received_at, parsed: {
        class_type: parsed.class_type,
        class_name: parsed.class_name,
        parse_status: parsed.parse_status,
        entries_status: entriesStatus,
      }});
    }

    // ── GET /v3/listClasses?slug=X[&ring=N] ──────────────────────────────────
    // Returns classes for a show (optionally filtered to one ring). Includes
    // ring_num for convenience so the admin can group client-side without
    // extra lookups.
    if (method === 'GET' && path === '/v3/listClasses') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      const ringStr = url.searchParams.get('ring');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        let query, params;
        if (ringStr !== null && ringStr !== undefined) {
          const ringNum = parseInt(ringStr, 10);
          if (!Number.isFinite(ringNum)) return err('Invalid ring');
          const ring = await env.WEST_DB_V3.prepare(
            'SELECT id FROM rings WHERE show_id = ? AND ring_num = ?'
          ).bind(show.id, ringNum).first();
          if (!ring) return err('Ring not found', 404);
          // Bill 2026-05-07: order by tsked schedule_order (the
          // operator's interleaved run order — 325, 925, 930, 330,
          // ...) inside each scheduled_date. Falls back to class_id
          // for any class without a schedule_order (catch-up cases /
          // unscheduled classes / pre-tsked-fix data). Numeric coerce
          // on class_id keeps "9" before "10" in fallback ordering.
          query = `SELECT c.*, ? AS ring_num,
                   (SELECT COUNT(*) FROM entries WHERE class_id = c.id) AS entry_count
                   FROM classes c WHERE c.ring_id = ?
                   ORDER BY c.scheduled_date IS NULL, c.scheduled_date,
                            c.schedule_order IS NULL, c.schedule_order,
                            CAST(c.class_id AS INTEGER), c.class_id`;
          params = [ringNum, ring.id];
        } else {
          query = `SELECT c.*, r.ring_num,
                   (SELECT COUNT(*) FROM entries WHERE class_id = c.id) AS entry_count
                   FROM classes c JOIN rings r ON r.id = c.ring_id
                   WHERE c.show_id = ?
                   ORDER BY r.ring_num, c.scheduled_date IS NULL, c.scheduled_date,
                            c.schedule_order IS NULL, c.schedule_order,
                            CAST(c.class_id AS INTEGER), c.class_id`;
          params = [show.id];
        }
        const { results } = await env.WEST_DB_V3.prepare(query).bind(...params).all();
        return json({ ok: true, classes: results || [] });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/deleteCls ───────────────────────────────────────────────────
    // Engine detected a .cls file was removed from Ryegate's Classes folder.
    // Soft-delete: set deleted_at, keep row + R2 archive intact. If the file
    // ever reappears via /v3/postCls, deleted_at clears automatically.
    if (method === 'POST' && path === '/v3/deleteCls') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, class_id } = body;
      if (!slug) return err('Missing slug');
      if (ring_num === undefined || ring_num === null) return err('Missing ring_num');
      if (!class_id) return err('Missing class_id');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      // Engine-write lock — locked shows reject the soft-delete signal so
      // a stray engine running on a finished show can't quietly hide rows.
      try {
        const showLk = await env.WEST_DB_V3.prepare(
          'SELECT lock_override, end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        const lk = computeShowLock(showLk);
        if (lk.locked) return lockedResponse(lk.reason);
      } catch (e) { /* non-fatal — fall through to UPDATE */ }
      try {
        const res = await env.WEST_DB_V3.prepare(`
          UPDATE classes
          SET deleted_at = datetime('now')
          WHERE class_id = ? AND deleted_at IS NULL
          AND ring_id = (
            SELECT r.id FROM rings r JOIN shows s ON s.id = r.show_id
            WHERE s.slug = ? AND r.ring_num = ?
          )
        `).bind(class_id, slug, ringNumInt).run();
        const changes = res.meta ? res.meta.changes : 0;
        console.log(`[v3/deleteCls] ${slug}/${ringNumInt}/${class_id} — ${changes} marked deleted`);
        return json({ ok: true, changes });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/hardDeleteCls ───────────────────────────────────────────────
    // Operator-initiated permanent removal of a class. Only allowed on
    // classes that are ALREADY soft-deleted (deleted_at IS NOT NULL), so
    // operators have to pull the file from Ryegate first — two-step safety
    // against accidental obliteration of an active class.
    //
    // Deletes: entries rows, classes row, R2 object. All three or nothing
    // meaningful — D1 doesn't do cross-statement transactions via the
    // binding API but each call is small and ordered so recovery is:
    //   1. delete entries (OK if zero)
    //   2. delete classes row
    //   3. delete R2 object (fails → orphan in R2, no DB impact)
    // Worst case: R2 object outlives the DB row. Manual cleanup via
    // wrangler r2 object delete is trivial.
    if (method === 'POST' && path === '/v3/hardDeleteCls') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, class_id } = body;
      if (!slug || ring_num === undefined || !class_id) return err('Missing fields');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      try {
        // Look up the class row and confirm it IS soft-deleted
        const cls = await env.WEST_DB_V3.prepare(`
          SELECT c.id, c.deleted_at, c.r2_key FROM classes c
          JOIN rings r ON r.id = c.ring_id
          JOIN shows s ON s.id = r.show_id
          WHERE s.slug = ? AND r.ring_num = ? AND c.class_id = ?
        `).bind(slug, ringNumInt, class_id).first();
        if (!cls) return err('Class not found', 404);
        if (!cls.deleted_at) {
          return err('Class is active — soft-delete first (remove from Ryegate folder) before permanent delete', 409);
        }
        const classDbId = cls.id;
        const r2Key = cls.r2_key;
        // 1. delete entries
        await env.WEST_DB_V3.prepare('DELETE FROM entries WHERE class_id = ?').bind(classDbId).run();
        // 2. delete class row
        await env.WEST_DB_V3.prepare('DELETE FROM classes WHERE id = ?').bind(classDbId).run();
        // 3. delete R2 object (best-effort; orphan is acceptable if this fails)
        try {
          if (r2Key) await env.WEST_R2_CLS.delete(r2Key);
        } catch (e) {
          console.log(`[v3/hardDeleteCls] R2 delete failed for ${r2Key}: ${e.message}`);
        }
        console.log(`[v3/hardDeleteCls] ${slug}/${ringNumInt}/${class_id} — permanently deleted`);
        return json({ ok: true, class_id });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── GET /v3/downloadCls?slug=X&ring=N&class=C ────────────────────────────
    // Streams the raw .cls bytes from R2 back as a file download so operators
    // can restore a deleted class by dropping the file back into Ryegate.
    if (method === 'GET' && path === '/v3/downloadCls') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring');
      const cls  = url.searchParams.get('class');
      if (!slug || !ring || !cls) return err('Missing slug/ring/class');
      const ringNumInt = parseInt(ring, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring');
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(cls)) return err('Invalid class');
      const r2Key = `${slug}/${ringNumInt}/${cls}.cls`;
      const obj = await env.WEST_R2_CLS.get(r2Key);
      if (!obj) return err('Not found in R2', 404);
      return new Response(obj.body, {
        headers: {
          ...CORS,
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${cls}.cls"`,
        },
      });
    }

    // ── POST /v3/postTsked ───────────────────────────────────────────────────
    // Engine POSTs raw tsked.csv bytes when content changes. Worker archives
    // to R2 and updates scheduled_date + schedule_flag on every matching
    // class row (by show_id + class_id). Only UPDATES — never creates
    // classes (those come from .cls POSTs). Classes tsked mentions that
    // don't exist yet are skipped silently with a count.
    //
    // Headers: X-West-Key, X-West-Slug.  Body: raw CSV bytes.
    //
    // tsked.csv format:
    //   Row 0: <ShowName>,"<DateRange>"
    //   Row 1+: <ClassNum>,<ClassName>,<Date M/D/YYYY>,<Flag>
    if (method === 'POST' && path === '/v3/postTsked') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = request.headers.get('X-West-Slug');
      if (!slug) return err('Missing X-West-Slug header');
      let showId;
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id, lock_override, end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Unknown show slug', 404);
        const lk = computeShowLock(show);
        if (lk.locked) return lockedResponse(lk.reason);
        showId = show.id;
      } catch (e) { return err('DB error: ' + e.message); }
      const bytes = await request.arrayBuffer();
      const size = bytes.byteLength;
      if (size === 0) return err('Empty body');
      if (size > 1024 * 1024) return err('tsked.csv too large (>1MB)', 413);
      const r2Key = `${slug}/tsked.csv`;
      await env.WEST_R2_CLS.put(r2Key, bytes, {
        httpMetadata: { contentType: 'text/csv' },
        customMetadata: { slug, kind: 'tsked' },
      });
      // Parse rows (skip row 0 — show header)
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const lines = text.split(/\r?\n/);
      let updated = 0, skipped = 0, invalid = 0;
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const cols = parseCsvLineV3(line);
        const classId = (cols[0] || '').trim();
        if (!classId) { invalid++; continue; }
        const dateStr = (cols[2] || '').trim();
        let isoDate = null;
        const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) isoDate = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        const flag = (cols[3] || '').trim() || null;
        rows.push({ classId, isoDate, flag });
      }
      // Clear scheduled_date / schedule_flag for classes previously scheduled
      // but no longer mentioned in tsked. They keep existing in admin (class
      // came from .cls archive) but fall into the "Unscheduled" bucket.
      // Admin behavior: show it under "Unscheduled" so no data is lost.
      // Public-facing pages will filter out Unscheduled classes — that's a
      // future UI concern, not a DB-level delete.
      let cleared = 0;
      const currentClassIds = rows.map(r => r.classId);
      try {
        if (currentClassIds.length > 0) {
          const placeholders = currentClassIds.map(() => '?').join(',');
          const res = await env.WEST_DB_V3.prepare(
            `UPDATE classes SET scheduled_date = NULL, schedule_flag = NULL
             WHERE show_id = ?
             AND (scheduled_date IS NOT NULL OR schedule_flag IS NOT NULL)
             AND class_id NOT IN (${placeholders})`
          ).bind(showId, ...currentClassIds).run();
          cleared = res.meta ? res.meta.changes : 0;
        } else {
          const res = await env.WEST_DB_V3.prepare(
            `UPDATE classes SET scheduled_date = NULL, schedule_flag = NULL
             WHERE show_id = ?
             AND (scheduled_date IS NOT NULL OR schedule_flag IS NOT NULL)`
          ).bind(showId).run();
          cleared = res.meta ? res.meta.changes : 0;
        }
      } catch (e) {
        console.log(`[v3/postTsked] clear-stale failed for ${slug}: ${e.message}`);
      }
      // Update classes (UPDATE-only, never INSERT — .cls POST is the
      // authority for class existence). schedule_order = 1-indexed
      // position in the tsked file. Bill 2026-05-07: this is what
      // ryegate.live uses to drive class display order; without it
      // the public ring page sorts by class_id alphabetically (325,
      // 330, 335, ...) instead of the operator's interleaved schedule
      // (325, 925, 930, 330, ...).
      for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx];
        try {
          const res = await env.WEST_DB_V3.prepare(
            `UPDATE classes SET scheduled_date = ?, schedule_flag = ?, schedule_order = ? WHERE show_id = ? AND class_id = ?`
          ).bind(r.isoDate, r.flag, idx + 1, showId, r.classId).run();
          if (res.meta && res.meta.changes > 0) updated++;
          else skipped++;
        } catch (e) {
          console.log(`[v3/postTsked] update failed for ${slug}/${r.classId}: ${e.message}`);
          invalid++;
        }
      }
      const received_at = new Date().toISOString();
      await env.WEST_LIVE.put(
        `tsked-last:${slug}`,
        JSON.stringify({ received_at, size, rows_total: rows.length, updated, skipped, cleared, invalid, r2_key: r2Key }),
        { expirationTtl: 86400 }
      );
      return json({ ok: true, received_at, rows_total: rows.length, updated, skipped, cleared, invalid });
    }

    // ── POST /v3/reprocessTsked?slug=X ───────────────────────────────────────
    // Backfill helper. Re-runs the existing /v3/postTsked write logic
    // against the tsked.csv currently stored in R2 for this show. Use
    // when a column was added (migration 034 schedule_order) and the
    // existing classes need their order populated without asking the
    // operator to re-post tsked from Ryegate.
    //
    // Auth-gated. Idempotent — re-running with no R2 changes just
    // re-writes the same values.
    if (method === 'POST' && path === '/v3/reprocessTsked') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug query param');
      let showId;
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Unknown show slug', 404);
        showId = show.id;
      } catch (e) { return err('DB error: ' + e.message); }
      let text;
      try {
        const obj = await env.WEST_R2_CLS.get(`${slug}/tsked.csv`);
        if (!obj) return err('No tsked.csv in R2 for this show', 404);
        const buf = await obj.arrayBuffer();
        text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      } catch (e) { return err('R2 read failed: ' + e.message); }
      const lines = text.split(/\r?\n/);
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const cols = parseCsvLineV3(line);
        const classId = (cols[0] || '').trim();
        if (!classId) continue;
        const dateStr = (cols[2] || '').trim();
        let isoDate = null;
        const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) isoDate = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        const flag = (cols[3] || '').trim() || null;
        rows.push({ classId, isoDate, flag });
      }
      let updated = 0;
      for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx];
        try {
          const res = await env.WEST_DB_V3.prepare(
            `UPDATE classes SET scheduled_date = ?, schedule_flag = ?, schedule_order = ? WHERE show_id = ? AND class_id = ?`
          ).bind(r.isoDate, r.flag, idx + 1, showId, r.classId).run();
          if (res.meta && res.meta.changes > 0) updated++;
        } catch (e) {
          console.log(`[v3/reprocessTsked] update failed for ${slug}/${r.classId}: ${e.message}`);
        }
      }
      return json({ ok: true, slug, rows_total: rows.length, updated });
    }

    // ── GET /v3/listEntries?class_id=N ───────────────────────────────────────
    // Returns all entries for a given class (by D1 PK id). Used by admin
    // when an operator expands a class row to view the entry roster.
    //
    // Storage is per-round (Session 33 pivot):
    //   entries               identity only
    //   entry_jumper_summary  one row per entry — ride_order, overall_place, parse meta
    //   entry_jumper_rounds   one row per entry PER round (absence = didn't happen)
    //
    // Admin expects a WIDE row shape per entry. This query pivots the
    // 3 round rows back into r1_* / r2_* / r3_* columns via LEFT JOINs
    // on (entry_id, round). Same output shape as pre-pivot — admin code
    // unchanged. Stats consumers (Phase 3+) read entry_jumper_rounds
    // natively without the pivot.
    if (method === 'GET' && path === '/v3/listEntries') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const classIdStr = url.searchParams.get('class_id');
      if (!classIdStr) return err('Missing class_id');
      const classDbId = parseInt(classIdStr, 10);
      if (!Number.isFinite(classDbId)) return err('Invalid class_id');
      try {
        const { results } = await env.WEST_DB_V3.prepare(
          `SELECT e.id, e.entry_num, e.horse_name, e.rider_name, e.owner_name,
                  e.horse_usef, e.rider_usef, e.owner_usef, e.city, e.state,
                  e.country_code, e.sire, e.dam,
                  e.first_seen_at, e.updated_at,
                  s.ride_order, s.overall_place,
                  s.score_parse_status, s.score_parse_notes,
                  r1.time AS r1_time, r1.penalty_sec AS r1_penalty_sec, r1.total_time AS r1_total_time,
                  r1.time_faults AS r1_time_faults, r1.jump_faults AS r1_jump_faults, r1.total_faults AS r1_total_faults,
                  r1.status AS r1_status, r1.numeric_status AS r1_numeric_status,
                  r2.time AS r2_time, r2.penalty_sec AS r2_penalty_sec, r2.total_time AS r2_total_time,
                  r2.time_faults AS r2_time_faults, r2.jump_faults AS r2_jump_faults, r2.total_faults AS r2_total_faults,
                  r2.status AS r2_status, r2.numeric_status AS r2_numeric_status,
                  r3.time AS r3_time, r3.penalty_sec AS r3_penalty_sec, r3.total_time AS r3_total_time,
                  r3.time_faults AS r3_time_faults, r3.jump_faults AS r3_jump_faults, r3.total_faults AS r3_total_faults,
                  r3.status AS r3_status, r3.numeric_status AS r3_numeric_status,
                  hs.go_order, hs.current_place, hs.combined_total,
                  hs.score_parse_status AS h_score_parse_status,
                  hs.score_parse_notes  AS h_score_parse_notes,
                  hr1.total AS r1_score_total,
                  hr1.status AS r1_h_status, hr1.numeric_status AS r1_h_numeric_status,
                  hr2.total AS r2_score_total,
                  hr2.status AS r2_h_status, hr2.numeric_status AS r2_h_numeric_status,
                  hr3.total AS r3_score_total,
                  hr3.status AS r3_h_status, hr3.numeric_status AS r3_h_numeric_status
           FROM entries e
           LEFT JOIN entry_jumper_summary s ON s.entry_id = e.id
           LEFT JOIN entry_jumper_rounds r1 ON r1.entry_id = e.id AND r1.round = 1
           LEFT JOIN entry_jumper_rounds r2 ON r2.entry_id = e.id AND r2.round = 2
           LEFT JOIN entry_jumper_rounds r3 ON r3.entry_id = e.id AND r3.round = 3
           LEFT JOIN entry_hunter_summary hs ON hs.entry_id = e.id
           LEFT JOIN entry_hunter_rounds hr1 ON hr1.entry_id = e.id AND hr1.round = 1
           LEFT JOIN entry_hunter_rounds hr2 ON hr2.entry_id = e.id AND hr2.round = 2
           LEFT JOIN entry_hunter_rounds hr3 ON hr3.entry_id = e.id AND hr3.round = 3
           WHERE e.class_id = ?
           ORDER BY
             CASE WHEN COALESCE(s.overall_place, hs.current_place) IS NULL THEN 999
                  ELSE COALESCE(s.overall_place, hs.current_place) END,
             CASE WHEN COALESCE(s.ride_order, hs.go_order) IS NULL
                    OR COALESCE(s.ride_order, hs.go_order) = 0 THEN 999
                  ELSE COALESCE(s.ride_order, hs.go_order) END,
             CAST(e.entry_num AS INTEGER)`
        ).bind(classDbId).all();
        return json({ ok: true, entries: results || [] });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── GET /v3/listJudgeGrid?class_id=N ──────────────────────────────────────
    // Returns grid-ready hunter judge data for one class. Reads pre-computed
    // ranks from the derived columns (judge_round_rank, round_overall_rank,
    // card_rank) so the client doesn't compute. Reshapes the flat join into
    // per-entry → per-round → per-judge JSON. Empty when class has no
    // judge data (jumper class, single-judge collapse, forced eq, etc.).
    if (method === 'GET' && path === '/v3/listJudgeGrid') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const classIdStr = url.searchParams.get('class_id');
      if (!classIdStr) return err('Missing class_id');
      const classDbId = parseInt(classIdStr, 10);
      if (!Number.isFinite(classDbId)) return err('Invalid class_id');
      try {
        const cls = await env.WEST_DB_V3.prepare(
          `SELECT id, class_id, class_name, class_type, class_mode,
                  scoring_type, num_rounds, num_judges, derby_type,
                  is_equitation, is_championship
           FROM classes WHERE id = ?`
        ).bind(classDbId).first();
        if (!cls) return err('Class not found', 404);

        // Pull the per-entry summary + per-round + per-judge in one
        // wide join. SQL ordering keeps it deterministic for the
        // reshape pass.
        const { results: rows } = await env.WEST_DB_V3.prepare(
          `SELECT e.id AS entry_id, e.entry_num, e.horse_name, e.rider_name,
                  e.country_code, e.sire, e.dam, e.owner_name, e.city, e.state,
                  hs.current_place, hs.combined_total,
                  hr.round, hr.total AS round_total, hr.status AS round_status,
                  hr.numeric_status AS round_numeric_status,
                  hr.round_overall_rank,
                  hjs.judge_idx, hjs.base_score, hjs.high_options, hjs.handy_bonus,
                  hjs.judge_round_rank,
                  hjc.card_total, hjc.card_rank
           FROM entries e
           LEFT JOIN entry_hunter_summary       hs  ON hs.entry_id  = e.id
           LEFT JOIN entry_hunter_rounds        hr  ON hr.entry_id  = e.id
           LEFT JOIN entry_hunter_judge_scores  hjs ON hjs.entry_id = e.id
                                                  AND hjs.round    = hr.round
           LEFT JOIN entry_hunter_judge_cards   hjc ON hjc.entry_id = e.id
                                                  AND hjc.judge_idx = hjs.judge_idx
           WHERE e.class_id = ?
           ORDER BY
             CASE WHEN hs.current_place IS NULL THEN 999
                  ELSE hs.current_place END,
             CAST(e.entry_num AS INTEGER),
             hr.round, hjs.judge_idx`
        ).bind(classDbId).all();

        // Reshape flat join → per-entry / per-round / per-judge tree.
        const byEntry = new Map();
        for (const row of (rows || [])) {
          let entry = byEntry.get(row.entry_id);
          if (!entry) {
            entry = {
              entry_id:    row.entry_id,
              entry_num:   row.entry_num,
              horse_name:  row.horse_name,
              rider_name:  row.rider_name,
              country_code: row.country_code,
              sire:        row.sire,
              dam:         row.dam,
              owner_name:  row.owner_name,
              city:        row.city,
              state:       row.state,
              place:       row.current_place,
              combined:    row.combined_total,
              rounds:      new Map(),
              judgeCards:  new Map(),
            };
            byEntry.set(row.entry_id, entry);
          }
          if (row.round != null) {
            let rd = entry.rounds.get(row.round);
            if (!rd) {
              rd = {
                round:       row.round,
                total:       row.round_total,
                status:      row.round_status,
                numericStatus: row.round_numeric_status,
                overallRank: row.round_overall_rank,
                judges:      [],
              };
              entry.rounds.set(row.round, rd);
            }
            if (row.judge_idx != null) {
              const exists = rd.judges.find(j => j.idx === row.judge_idx);
              if (!exists) {
                rd.judges.push({
                  idx:   row.judge_idx,
                  base:  row.base_score,
                  hiopt: row.high_options,
                  handy: row.handy_bonus,
                  rank:  row.judge_round_rank,
                });
              }
            }
          }
          if (row.judge_idx != null && row.card_total != null) {
            if (!entry.judgeCards.has(row.judge_idx)) {
              entry.judgeCards.set(row.judge_idx, {
                idx:   row.judge_idx,
                total: row.card_total,
                rank:  row.card_rank,
              });
            }
          }
        }

        const outRows = [...byEntry.values()].map(e => ({
          entry_id:    e.entry_id,
          entry_num:   e.entry_num,
          horse_name:  e.horse_name,
          rider_name:  e.rider_name,
          country_code: e.country_code,
          sire:        e.sire,
          dam:         e.dam,
          owner_name:  e.owner_name,
          city:        e.city,
          state:       e.state,
          place:       e.place,
          combined:    e.combined,
          rounds:      [...e.rounds.values()].sort((a, b) => a.round - b.round),
          judgeCards:  [...e.judgeCards.values()].sort((a, b) => a.idx - b.idx),
        }));

        return json({
          ok: true,
          class: {
            id:               cls.id,
            class_id:         cls.class_id,
            class_name:       cls.class_name,
            class_type:       cls.class_type,
            class_mode:       cls.class_mode,
            scoring_type:     cls.scoring_type,
            num_rounds:       cls.num_rounds,
            num_judges:       cls.num_judges,
            derby_type:       cls.derby_type,
            is_equitation:    cls.is_equitation,
            is_championship:  cls.is_championship,
          },
          rows: outRows,
        });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── GET /v3/listJumperStats?class_id=N ───────────────────────────────────
    // Returns the pre-computed class_jumper_stats row reshaped into the JSON
    // envelope the stats page consumes. Joins against entries (twice per
    // round, once for fastest_4fault) so horse/rider names ride alongside the
    // numbers — no extra fetch from the client. Empty rounds (no competed
    // entries) are filtered out so the consumer iterates only meaningful
    // rounds.
    if (method === 'GET' && path === '/v3/listJumperStats') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const classIdStr = url.searchParams.get('class_id');
      if (!classIdStr) return err('Missing class_id');
      const classDbId = parseInt(classIdStr, 10);
      if (!Number.isFinite(classDbId)) return err('Invalid class_id');
      try {
        const cls = await env.WEST_DB_V3.prepare(
          `SELECT id, show_id, class_id, class_name, class_type, scoring_method,
                  scoring_modifier, num_rounds,
                  r1_time_allowed, r2_time_allowed, r3_time_allowed
           FROM classes WHERE id = ?`
        ).bind(classDbId).first();
        if (!cls) return err('Class not found', 404);
        if (cls.class_type !== 'J' && cls.class_type !== 'T') {
          return err('Class is not a jumper class', 400);
        }
        // Show-level stats display config — operator un-checks what they
        // don't want shown publicly. NULL = all on (default). Parsed
        // here so /v3/listJumperStats responses carry the resolved
        // boolean map; client doesn't need a second fetch.
        const showRow = await env.WEST_DB_V3.prepare(
          `SELECT stats_config FROM shows WHERE id = ?`
        ).bind(cls.show_id).first();
        let statsConfig = {};
        if (showRow && showRow.stats_config) {
          try { statsConfig = JSON.parse(showRow.stats_config) || {}; }
          catch (e) { console.warn(`[v3/listJumperStats] stats_config parse failed for show ${cls.show_id}: ${e.message}`); }
        }
        const stats = await env.WEST_DB_V3.prepare(
          `SELECT * FROM class_jumper_stats WHERE class_id = ?`
        ).bind(classDbId).first();
        if (!stats) {
          // No stats row yet (newly added class, never posted). Return an
          // empty-but-valid envelope so the page renders a clean
          // placeholder instead of erroring.
          return json({
            ok: true,
            class: cls,
            stats_config: statsConfig,
            stats: { total_entries: 0, scratched: 0, eliminated: 0, rounds: [] }
          });
        }

        // Resolve fastest-clear entry FKs to horse/rider/entry_num for the
        // consumer. One SELECT per non-null FK keeps the join logic clean.
        async function resolveFastest(entryId) {
          if (entryId == null) return null;
          const e = await env.WEST_DB_V3.prepare(
            `SELECT id, entry_num, horse_name, rider_name FROM entries WHERE id = ?`
          ).bind(entryId).first();
          return e;
        }

        const rounds = [];
        for (const n of [1, 2, 3]) {
          const competed = stats[`r${n}_competed`] || 0;
          if (!competed) continue;
          const fastEntry = await resolveFastest(stats[`r${n}_fastest_4fault_entry_id`]);
          const fastTime  = stats[`r${n}_fastest_4fault_time`];
          let buckets = null;
          const raw = stats[`r${n}_fault_buckets`];
          if (raw) {
            try { buckets = JSON.parse(raw); }
            catch (e) { console.warn(`[v3/listJumperStats] r${n} bucket JSON parse failed for class ${classDbId}`); }
          }

          // Per-round standings — fully server-rendered. SQL computes
          // place_display, fault_class, fault_display, time_display,
          // gap_class, gap_display so other pages can drop in a row
          // without re-implementing display logic.
          //
          // Two paths:
          //   R1 of multi-round methods (II.2 family / 3R / Two-Phase /
          //     Winning Round / Optimum 2R) → JO mode: gap = total_time
          //     − r1_time_allowed (vs TA), JO badge for entries at the
          //     qualifying threshold (min_faults), qualifiers sorted by
          //     ride_order (go order), faulted by faults+time.
          //   Everything else → default: gap = vs leader, RANK number.
          //
          // Killed entries (EL/RF/DNF/OC) listed below clean rides;
          // DNS/WD/SC skipped entirely (didn't compete).
          const cMethod   = Number(cls.scoring_method);
          const cModifier = Number(cls.scoring_modifier);
          const useR1JoMode = (n === 1) && cls.r1_time_allowed && (
            (cMethod === 6 && cModifier === 1) ||
            [2, 3, 9, 10, 11, 13, 14, 15].includes(cMethod)
          );
          // Two-Phase (method 9, II.2d): R1 → Phase 2 advancement isn't
          // a "Jump-Off." Use JO-mode plumbing (vs-TA gap, ride_order
          // sort for qualifiers) but DROP the "JO" badge — qualifiers
          // get a numeric place like the rest. Bill 2026-04-27.
          const showJoBadge = useR1JoMode && cMethod !== 9 ? 1 : 0;
          let standingRows;
          if (useR1JoMode) {
            const { results } = await env.WEST_DB_V3.prepare(`
              WITH all_rows AS (
                SELECT
                  e.id AS entry_id, e.entry_num, e.horse_name, e.rider_name, e.country_code,
                  r.total_faults, r.total_time, r.time_faults, r.jump_faults, r.status,
                  s.ride_order
                FROM entry_jumper_rounds r
                JOIN entries e ON e.id = r.entry_id
                LEFT JOIN entry_jumper_summary s ON s.entry_id = e.id
                WHERE e.class_id = ?1
                  AND r.round = ?2
                  AND (r.status IS NULL OR r.status NOT IN ('DNS','WD','SC'))
              ),
              threshold AS (
                SELECT MIN(total_faults) AS min_faults
                FROM all_rows WHERE status IS NULL
              ),
              -- ROW_NUMBER over non-killed entries in the FINAL standing
              -- order (qualifiers in ride_order first, then faulted by
              -- faults+time). Killed entries excluded so they don't
              -- inflate the next number. JO qualifiers get pos 1-N but
              -- their place_display overrides to 'JO'; non-qualifiers
              -- show the numeric position N+1, N+2, …
              positions AS (
                SELECT
                  entry_id,
                  ROW_NUMBER() OVER (
                    ORDER BY
                      CASE WHEN total_faults = (SELECT min_faults FROM threshold) THEN 0 ELSE 1 END ASC,
                      CASE WHEN total_faults = (SELECT min_faults FROM threshold) THEN COALESCE(ride_order, 9999) END ASC,
                      total_faults ASC,
                      total_time ASC,
                      CAST(entry_num AS INTEGER) ASC
                  ) AS pos
                FROM all_rows
                WHERE status IS NULL
              )
              SELECT
                ar.entry_id, ar.entry_num, ar.horse_name, ar.rider_name, ar.country_code,
                ar.total_faults, ar.total_time, ar.time_faults, ar.jump_faults, ar.status,
                CASE
                  WHEN ar.status IS NOT NULL                                                       THEN ar.status
                  WHEN ar.total_faults = (SELECT min_faults FROM threshold) AND ?4 = 1             THEN 'JO'
                  ELSE CAST(p.pos AS TEXT)
                END AS place_display,
                CASE
                  WHEN ar.status IS NOT NULL                                                       THEN 'status'
                  WHEN ar.total_faults = (SELECT min_faults FROM threshold) AND ?4 = 1             THEN 'jo'
                  ELSE 'rank'
                END AS place_class,
                CASE
                  WHEN ar.status IS NOT NULL THEN 'elim'
                  WHEN ar.total_faults = 0   THEN 'clear'
                  ELSE 'faulted'
                END AS fault_class,
                CASE
                  WHEN ar.status IS NOT NULL                                THEN ar.status
                  WHEN ar.total_faults = CAST(ar.total_faults AS INTEGER)
                    THEN CAST(CAST(ar.total_faults AS INTEGER) AS TEXT)
                  ELSE printf('%.2f', ar.total_faults)
                END AS fault_display,
                CASE
                  WHEN ar.status IS NOT NULL OR ar.total_time IS NULL THEN '—'
                  ELSE printf('%.3f', ar.total_time)
                END AS time_display,
                -- Gap = signed distance from R1 TA. Color: over = fault-gap (red),
                -- comfortably under (>3s) = leader (green), else = behind (amber).
                CASE
                  WHEN ar.status IS NOT NULL OR ar.total_time IS NULL THEN 'fault-gap'
                  WHEN (ar.total_time - ?3) > 0                       THEN 'fault-gap'
                  WHEN (ar.total_time - ?3) < -3                      THEN 'leader'
                  ELSE 'behind'
                END AS gap_class,
                CASE
                  WHEN ar.status IS NOT NULL OR ar.total_time IS NULL THEN '—'
                  WHEN (ar.total_time - ?3) >= 0
                    THEN '+' || printf('%.3f', ar.total_time - ?3) || 's'
                  ELSE printf('%.3f', ar.total_time - ?3) || 's'
                END AS gap_display
              FROM all_rows ar
              LEFT JOIN positions p ON p.entry_id = ar.entry_id
              ORDER BY
                CASE WHEN ar.status IS NULL THEN 0 ELSE 1 END ASC,
                CASE
                  WHEN ar.status IS NULL AND ar.total_faults = (SELECT min_faults FROM threshold) THEN 0
                  WHEN ar.status IS NULL                                                          THEN 1
                  ELSE 2
                END ASC,
                CASE
                  WHEN ar.status IS NULL AND ar.total_faults = (SELECT min_faults FROM threshold)
                    THEN COALESCE(ar.ride_order, 9999)
                  ELSE NULL
                END ASC,
                COALESCE(ar.total_faults, 999) ASC,
                COALESCE(ar.total_time, 999999) ASC,
                CAST(ar.entry_num AS INTEGER) ASC
            `).bind(classDbId, n, cls.r1_time_allowed, showJoBadge).all();
            standingRows = results;
          } else {
          const { results } = await env.WEST_DB_V3.prepare(`
            WITH all_rows AS (
              SELECT
                e.id AS entry_id, e.entry_num, e.horse_name, e.rider_name, e.country_code,
                r.total_faults, r.total_time, r.time_faults, r.jump_faults, r.status
              FROM entry_jumper_rounds r
              JOIN entries e ON e.id = r.entry_id
              WHERE e.class_id = ?
                AND r.round = ?
                AND (r.status IS NULL OR r.status NOT IN ('DNS','WD','SC'))
            ),
            leader AS (
              SELECT total_faults AS leader_faults, total_time AS leader_time
              FROM all_rows
              WHERE status IS NULL
              ORDER BY total_faults ASC, total_time ASC
              LIMIT 1
            )
            SELECT
              ar.entry_id, ar.entry_num, ar.horse_name, ar.rider_name, ar.country_code,
              ar.total_faults, ar.total_time, ar.time_faults, ar.jump_faults, ar.status,
              CASE WHEN ar.status IS NULL THEN
                CAST(RANK() OVER (
                  PARTITION BY (CASE WHEN ar.status IS NULL THEN 0 ELSE 1 END)
                  ORDER BY ar.total_faults ASC, ar.total_time ASC
                ) AS TEXT)
              ELSE ar.status END AS place_display,
              CASE WHEN ar.status IS NULL THEN 'rank' ELSE 'status' END AS place_class,
              CASE
                WHEN ar.status IS NOT NULL THEN 'elim'
                WHEN ar.total_faults = 0 THEN 'clear'
                ELSE 'faulted'
              END AS fault_class,
              CASE
                WHEN ar.status IS NOT NULL                                THEN ar.status
                WHEN ar.total_faults = CAST(ar.total_faults AS INTEGER)
                  THEN CAST(CAST(ar.total_faults AS INTEGER) AS TEXT)
                ELSE printf('%.2f', ar.total_faults)
              END AS fault_display,
              CASE
                WHEN ar.status IS NOT NULL OR ar.total_time IS NULL THEN '—'
                ELSE printf('%.3f', ar.total_time)
              END AS time_display,
              CASE
                WHEN l.leader_faults IS NULL                                              THEN 'fault-gap'
                WHEN ar.status IS NOT NULL                                                THEN 'fault-gap'
                WHEN ar.total_faults = l.leader_faults AND ar.total_time = l.leader_time  THEN 'leader'
                WHEN ar.total_faults > l.leader_faults                                    THEN 'fault-gap'
                ELSE 'behind'
              END AS gap_class,
              CASE
                WHEN l.leader_faults IS NULL                                              THEN '—'
                WHEN ar.status IS NOT NULL                                                THEN '—'
                WHEN ar.total_faults = l.leader_faults AND ar.total_time = l.leader_time  THEN 'Leader'
                WHEN ar.total_faults > l.leader_faults
                  THEN '+' || CAST(ar.total_faults - l.leader_faults AS INTEGER) || ' flt'
                ELSE '+' || printf('%.3f', ar.total_time - l.leader_time) || 's'
              END AS gap_display
            FROM all_rows ar
            LEFT JOIN leader l ON 1=1
            ORDER BY
              CASE WHEN ar.status IS NULL THEN 0 ELSE 1 END ASC,
              COALESCE(ar.total_faults, 999) ASC,
              COALESCE(ar.total_time, 999999) ASC,
              CAST(ar.entry_num AS INTEGER) ASC
          `).bind(classDbId, n).all();
          standingRows = results;
          }

          // Header label for the gap column: "Gap from TA - 73s" when
          // R1 of a multi-round method shows distance-from-TA; plain
          // "Gap" everywhere else (gap-from-leader). Computed here so
          // the page renders verbatim with no JS-side mode detection.
          const gapLabel = useR1JoMode
            ? `Gap from TA - ${Math.round(cls.r1_time_allowed)}s`
            : 'Gap';

          rounds.push({
            round:           n,
            competed,
            clears:           stats[`r${n}_clears`]            || 0,
            time_faults:      stats[`r${n}_time_faults`]       || 0,
            avg_total_time:   stats[`r${n}_avg_total_time`],
            avg_clear_time:   stats[`r${n}_avg_clear_time`],
            avg_total_faults: stats[`r${n}_avg_total_faults`],
            time_fault_pct:   stats[`r${n}_time_fault_pct`],
            gap_label:       gapLabel,
            fastest_4fault:  fastEntry && fastTime != null ? {
              entry_id:    fastEntry.id,
              entry_num:   fastEntry.entry_num,
              horse_name:  fastEntry.horse_name,
              rider_name:  fastEntry.rider_name,
              time:        fastTime,
            } : null,
            fault_buckets:   buckets,
            standings:       standingRows || [],
          });
        }

        return jsonWithEtag(request, {
          ok: true,
          class: cls,
          stats_config: statsConfig,
          stats: {
            total_entries: stats.total_entries || 0,
            scratched:     stats.scratched     || 0,
            eliminated:    stats.eliminated    || 0,
            computed_at:   stats.computed_at,
            rounds,
            entry_stats: {
              unique_riders: stats.unique_riders || 0,
              unique_horses: stats.unique_horses || 0,
              unique_owners: stats.unique_owners || 0,
              countries:     parseStatsJson(stats.countries_json,    `class ${classDbId} countries_json`),
              multi_riders:  parseStatsJson(stats.multi_riders_json, `class ${classDbId} multi_riders_json`),
            },
          }
        });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/recomputeJudgeRanks ─────────────────────────────────────────
    // Manually re-runs the judge-grid compute pass for a class. Used as a
    // safety valve when raw rows change outside /v3/postCls (admin edit,
    // direct D1 console) so derived ranks don't go stale. Idempotent.
    // Body: { class_id: N }
    if (method === 'POST' && path === '/v3/recomputeJudgeRanks') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const classDbId = parseInt(body.class_id, 10);
      if (!Number.isFinite(classDbId)) return err('Invalid class_id');
      try {
        const cls = await env.WEST_DB_V3.prepare(
          'SELECT id, class_id FROM classes WHERE id = ?'
        ).bind(classDbId).first();
        if (!cls) return err('Class not found', 404);
        await computeJudgeGridRanks(env, classDbId);
        console.log(`[v3] recomputed judge ranks for class ${cls.class_id} (id=${classDbId})`);
        return json({ ok: true, class_id: cls.class_id });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── GET /v3/listShowJumperStats?slug=X ───────────────────────────────────
    // Show-level aggregation across all J/T classes in one show. Pure
    // on-read SQL — no pre-compute table because show-level data
    // changes whenever ANY class updates and viewers are intermittent;
    // pre-computing would burn unnecessary work during active scoring.
    // ETag-wrapped so repeat polls return 304 cheaply.
    //
    // Returns: top riders/horses (wins + podiums), championship list,
    // multi-ride riders (rider with ≥2 distinct horses across the
    // show), basic counts (jumper classes complete / total / entries).
    //
    // Hunter classes deliberately excluded (entry-list stats are
    // jumper-only per session 39 directive).
    if (method === 'GET' && path === '/v3/listShowJumperStats') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id, slug, name, start_date, end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);

        // Aggregate counts. classes_complete is omitted today — class
        // finalization is gated on engine UDP per session 36 notes;
        // when that lands, we'll add a status check here.
        const counts = await env.WEST_DB_V3.prepare(`
          SELECT
            COUNT(*)                                                      AS classes_total,
            COALESCE(SUM(js.total_entries), 0)                            AS total_entries
          FROM classes c
          LEFT JOIN class_jumper_stats js ON js.class_id = c.id
          WHERE c.show_id = ?
            AND c.class_type IN ('J','T')
            AND c.deleted_at IS NULL
        `).bind(show.id).first();

        // Top riders — Blues (1st), Clears (rounds with 0 total faults +
        // no killing status), Top 3 (overall_place 1-3), classes entered.
        // "Podiums" was Olympic-speak; this swaps to terminology native
        // to hunter/jumper. Bill 2026-05-08.
        const { results: riderRows } = await env.WEST_DB_V3.prepare(`
          SELECT
            MAX(e.rider_name) AS rider,
            SUM(CASE WHEN s.overall_place = 1             THEN 1 ELSE 0 END) AS blues,
            SUM(CASE WHEN s.overall_place BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3,
            COALESCE(SUM(
              (SELECT COUNT(*) FROM entry_jumper_rounds r
                WHERE r.entry_id = e.id
                  AND r.total_faults = 0
                  AND (r.status IS NULL OR r.status NOT IN
                       ('EL','RF','HF','OC','RO','DQ','RT','WD','DNS','SC')))
            ), 0) AS clears,
            COUNT(DISTINCT e.class_id) AS classes_entered
          FROM entries e
          JOIN classes c ON c.id = e.class_id
          LEFT JOIN entry_jumper_summary s ON s.entry_id = e.id
          WHERE c.show_id = ?
            AND c.class_type IN ('J','T')
            AND c.deleted_at IS NULL
            AND e.rider_name IS NOT NULL AND TRIM(e.rider_name) != ''
          GROUP BY UPPER(TRIM(e.rider_name))
          HAVING blues > 0 OR top3 > 0 OR clears > 0
          ORDER BY blues DESC, top3 DESC, clears DESC, rider ASC
          LIMIT 10
        `).bind(show.id).all();

        // Top horses — money won across the show (sum of prize_money[place]
        // where the horse placed in a money class). Falls back to nothing
        // when the show has no prize_money set anywhere; sample_rider stays
        // for the sub-line on the card.
        const { results: horseRows } = await env.WEST_DB_V3.prepare(`
          SELECT
            MAX(e.horse_name) AS horse,
            MAX(e.rider_name) AS sample_rider,
            COALESCE(SUM(
              CASE
                WHEN s.overall_place IS NOT NULL AND s.overall_place > 0
                     AND c.prize_money IS NOT NULL AND c.prize_money != ''
                THEN COALESCE(
                  CAST(json_extract(c.prize_money,
                    '$[' || (s.overall_place - 1) || ']') AS REAL),
                  0)
                ELSE 0
              END
            ), 0) AS money_won,
            COUNT(DISTINCT e.class_id) AS classes_entered
          FROM entries e
          JOIN classes c ON c.id = e.class_id
          LEFT JOIN entry_jumper_summary s ON s.entry_id = e.id
          WHERE c.show_id = ?
            AND c.class_type IN ('J','T')
            AND c.deleted_at IS NULL
            AND e.horse_name IS NOT NULL AND TRIM(e.horse_name) != ''
          GROUP BY UPPER(TRIM(e.horse_name))
          HAVING money_won > 0
          ORDER BY money_won DESC, horse ASC
          LIMIT 10
        `).bind(show.id).all();

        // Champion + Reserve list — pulled from is_championship classes.
        // Champion = overall_place 1, Reserve = overall_place 2.
        const { results: champRows } = await env.WEST_DB_V3.prepare(`
          SELECT
            c.class_id, c.class_name,
            e.entry_num, e.horse_name, e.rider_name,
            s.overall_place
          FROM classes c
          JOIN entries e ON e.class_id = c.id
          JOIN entry_jumper_summary s ON s.entry_id = e.id
          WHERE c.show_id = ?
            AND c.class_type IN ('J','T')
            AND c.is_championship = 1
            AND c.deleted_at IS NULL
            AND s.overall_place IN (1, 2)
          ORDER BY c.scheduled_date IS NULL, c.scheduled_date, CAST(c.class_id AS INTEGER), s.overall_place
        `).bind(show.id).all();

        // Reshape championships: one entry per class with champion + reserve.
        const champByClass = new Map();
        for (const r of champRows || []) {
          if (!champByClass.has(r.class_id)) {
            champByClass.set(r.class_id, { class_id: r.class_id, class_name: r.class_name, champion: null, reserve: null });
          }
          const slot = r.overall_place === 1 ? 'champion' : 'reserve';
          champByClass.get(r.class_id)[slot] = {
            entry_num: r.entry_num, horse_name: r.horse_name, rider_name: r.rider_name,
          };
        }
        const championships = Array.from(champByClass.values());

        // Multi-ride riders show-wide — riders with 2+ DISTINCT horses
        // across the show. Different from per-class multi-ride (same
        // rider with multiple horses in one class) — this is rider with
        // multiple mounts across the entire show schedule.
        // Bill 2026-04-27: not rendered on show.html today; kept in
        // the response shape because future surfaces may consume it
        // ("you never know when you need it").
        const { results: multiRows } = await env.WEST_DB_V3.prepare(`
          SELECT
            MAX(e.rider_name) AS rider,
            COUNT(DISTINCT UPPER(TRIM(e.horse_name))) AS horse_count,
            GROUP_CONCAT(DISTINCT e.horse_name) AS horses_blob,
            COUNT(DISTINCT e.class_id) AS class_count
          FROM entries e
          JOIN classes c ON c.id = e.class_id
          WHERE c.show_id = ?
            AND c.class_type IN ('J','T')
            AND c.deleted_at IS NULL
            AND e.rider_name IS NOT NULL AND TRIM(e.rider_name) != ''
            AND e.horse_name IS NOT NULL AND TRIM(e.horse_name) != ''
          GROUP BY UPPER(TRIM(e.rider_name))
          HAVING horse_count >= 2
          ORDER BY horse_count DESC, class_count DESC, rider ASC
          LIMIT 25
        `).bind(show.id).all();
        const multiRiders = (multiRows || []).map(r => ({
          rider: r.rider,
          horse_count: r.horse_count,
          class_count: r.class_count,
          horses: (r.horses_blob || '').split(',').filter(Boolean),
        }));

        return jsonWithEtag(request, {
          ok: true,
          show: {
            slug:       show.slug,
            name:       show.name,
            start_date: show.start_date,
            end_date:   show.end_date,
          },
          stats: {
            classes_total:    counts.classes_total    || 0,
            total_entries:    counts.total_entries    || 0,
            top_riders:       (riderRows  || []).map(r => ({
              rider: r.rider,
              blues:  r.blues  || 0,
              clears: r.clears || 0,
              top3:   r.top3   || 0,
              classes_entered: r.classes_entered || 0,
            })),
            top_horses:       (horseRows  || []).map(r => ({
              horse: r.horse,
              sample_rider: r.sample_rider,
              money_won: r.money_won || 0,
              classes_entered: r.classes_entered || 0,
            })),
            championships:    championships,
            multi_riders:     multiRiders,
          },
        });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/recomputeJumperStats ────────────────────────────────────────
    // Manual recompute of class_jumper_stats. Safety valve when raw rows
    // change outside /v3/postCls (admin edit, direct D1 console) so derived
    // stats don't go stale. Idempotent.
    //   Body: {}                       → recompute every J/T class
    //   Body: { slug: 'X' }            → recompute every J/T class in show
    //   Body: { class_id: N }          → recompute one class
    if (method === 'POST' && path === '/v3/recomputeJumperStats') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body = {};
      try { body = await request.json(); } catch (e) { /* empty body ok */ }
      const oneClassId = body && body.class_id != null ? parseInt(body.class_id, 10) : null;
      const slug       = body && body.slug ? String(body.slug) : null;
      try {
        let rows;
        if (oneClassId != null) {
          if (!Number.isFinite(oneClassId)) return err('Invalid class_id');
          const r = await env.WEST_DB_V3.prepare(
            `SELECT id FROM classes WHERE id = ? AND class_type IN ('J','T') AND deleted_at IS NULL`
          ).bind(oneClassId).all();
          rows = r.results || [];
        } else if (slug) {
          const r = await env.WEST_DB_V3.prepare(
            `SELECT c.id FROM classes c
             JOIN shows s ON s.id = c.show_id
             WHERE s.slug = ? AND c.class_type IN ('J','T') AND c.deleted_at IS NULL`
          ).bind(slug).all();
          rows = r.results || [];
        } else {
          const r = await env.WEST_DB_V3.prepare(
            `SELECT id FROM classes WHERE class_type IN ('J','T') AND deleted_at IS NULL`
          ).all();
          rows = r.results || [];
        }
        let updated = 0, errors = 0;
        for (const row of rows) {
          try {
            await computeJumperStats(env, row.id);
            updated++;
          } catch (e) {
            console.warn('[v3/recomputeJumperStats] class id=' + row.id + ': ' + e.message);
            errors++;
          }
        }
        return json({ ok: true, scanned: rows.length, updated, errors });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/reparseClassHeaders ─────────────────────────────────────────
    // Backfill / replay tool. Walks classes (optionally filtered by slug)
    // and re-runs parseClsHeaderV3 against each class's archived .cls bytes
    // in R2, then UPDATE classes SET ... with whatever the parser yields.
    // Used to populate columns added by later migrations on existing classes
    // without round-tripping through the engine. Idempotent.
    // Body: { slug?: 'show-slug' }   omit slug to reparse all classes.
    if (method === 'POST' && path === '/v3/reparseClassHeaders') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body = {};
      try { body = await request.json(); } catch (e) { /* empty body ok */ }
      const slug = body && body.slug ? String(body.slug) : null;
      try {
        let rows;
        if (slug) {
          const r = await env.WEST_DB_V3.prepare(
            `SELECT c.id, c.r2_key FROM classes c
             JOIN shows s ON s.id = c.show_id
             WHERE s.slug = ? AND c.r2_key IS NOT NULL AND c.deleted_at IS NULL`
          ).bind(slug).all();
          rows = r.results || [];
        } else {
          const r = await env.WEST_DB_V3.prepare(
            `SELECT id, r2_key FROM classes
             WHERE r2_key IS NOT NULL AND deleted_at IS NULL`
          ).all();
          rows = r.results || [];
        }
        let updated = 0, skipped = 0, errors = 0;
        for (const row of rows) {
          try {
            const obj = await env.WEST_R2_CLS.get(row.r2_key);
            if (!obj) { skipped++; continue; }
            const bytes = await obj.arrayBuffer();
            const parsed = parseClsHeaderV3(bytes);
            // Also re-parse @money so prize_money populates for classes
            // already in D1 from before migration 033 landed.
            const money = parseClsMoneyV3(bytes);
            await env.WEST_DB_V3.prepare(`
              UPDATE classes SET
                r1_time_allowed = ?,
                r2_time_allowed = ?,
                r3_time_allowed = ?,
                prize_money = ?
              WHERE id = ?
            `).bind(
              parsed.r1_time_allowed ?? null,
              parsed.r2_time_allowed ?? null,
              parsed.r3_time_allowed ?? null,
              money ? JSON.stringify(money) : null,
              row.id
            ).run();
            updated++;
          } catch (e) {
            console.warn('[v3/reparseClassHeaders] class id=' + row.id + ': ' + e.message);
            errors++;
          }
        }
        return json({ ok: true, scanned: rows.length, updated, skipped, errors });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/engineHeartbeat ─────────────────────────────────────────────
    // Engine identifies itself to the worker every ~10s. Proves the engine is
    // alive + reports its identity (show slug + ring num) + version. Stored in
    // KV with 10min TTL so admin page can render freshness. No D1 writes.
    if (method === 'POST' && path === '/v3/engineHeartbeat') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, engine_version, timestamp, hostname, uptime_seconds } = body;
      if (!slug) return err('Missing slug');
      if (ring_num === undefined || ring_num === null) return err('Missing ring_num');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      // Verify show + ring exist in v3 DB before accepting heartbeats —
      // prevents noise from misconfigured engines claiming shows we don't know.
      // Pull lock fields in the same query so the lock check is one round-trip.
      try {
        const row = await env.WEST_DB_V3.prepare(`
          SELECT r.id, s.lock_override, s.end_date FROM rings r
          JOIN shows s ON s.id = r.show_id
          WHERE s.slug = ? AND r.ring_num = ?
        `).bind(slug, ringNumInt).first();
        if (!row) return err('Unknown show/ring pair', 404);
        const lk = computeShowLock(row);
        if (lk.locked) return lockedResponse(lk.reason);
      } catch (e) { return err('DB error: ' + e.message); }
      const received_at = new Date().toISOString();
      const payload = {
        slug, ring_num: ringNumInt,
        engine_version: engine_version || 'unknown',
        timestamp: timestamp || null,
        hostname: hostname || null,
        uptime_seconds: Number.isFinite(uptime_seconds) ? uptime_seconds : null,
        received_at,
      };
      await env.WEST_LIVE.put(
        `engine:${slug}:${ringNumInt}`,
        JSON.stringify(payload),
        { expirationTtl: 600 } // 10 minutes
      );
      // Show-lifecycle auto-promotion: first heartbeat for a show flips
      // its status from 'pending' to 'active'. Idempotent — guarded
      // WHERE status='pending' so it's a no-op after the first flip.
      // Never demotes; manual status changes (→ complete / archived)
      // stay sticky and heartbeats don't overwrite them.
      let promoted = 0;
      try {
        const res = await env.WEST_DB_V3.prepare(
          `UPDATE shows SET status = 'active', updated_at = datetime('now')
           WHERE slug = ? AND status = 'pending'`
        ).bind(slug).run();
        promoted = res.meta ? res.meta.changes : 0;
        if (promoted > 0) {
          console.log(`[v3] Show ${slug} auto-promoted pending → active on first heartbeat`);
        }
      } catch (e) {
        console.log(`[v3/engineHeartbeat] status auto-promote failed for ${slug}: ${e.message}`);
      }
      return json({ ok: true, received_at, status_promoted: promoted > 0 });
    }

    // ── POST /v3/postUdpEvent (Phase 3a Chunk 2) ─────────────────────────────
    // Engine batches UDP events every ~250ms and POSTs them here. Body shape:
    //   { slug, ring_num, events: [{ at, channel, frame, class_id, tags }, ...] }
    // We snapshot the batch into KV (ring-state:{slug}:{ring_num}, 10min TTL)
    // for the public live page to poll, AND append every event into the D1
    // udp_events table for forensics + future stats. Lock check piggybacks
    // on the show/ring lookup like engineHeartbeat does. Auth via X-West-Key.
    if (method === 'POST' && path === '/v3/postUdpEvent') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, events, live_running_tenth } = body;
      if (!slug) return err('Missing slug');
      if (ring_num === undefined || ring_num === null) return err('Missing ring_num');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      if (!Array.isArray(events) || events.length === 0) {
        return err('events must be a non-empty array');
      }
      // Resolve show + ring + lock fields + (focus) class_kind in one
      // round-trip. S41 lock-pattern extended with a LEFT JOIN to classes
      // keyed on the LAST event's class_id — gives us the lens for free.
      // class_kind derivation: H → hunter, J/T → jumper (or equitation if
      // method=7 Timed Equitation), U with method 0..15 → jumper/equitation
      // by method, anything else → null (page falls back to raw {N}=value).
      const lastEventForLens = events[events.length - 1] || null;
      const lensClassId = (lastEventForLens && lastEventForLens.class_id) || null;
      let row;
      try {
        row = await env.WEST_DB_V3.prepare(`
          SELECT s.id AS show_id, s.lock_override, s.end_date,
                 c.id AS class_pk, c.class_type, c.scoring_method,
                 c.scoring_modifier, c.class_name, c.class_mode,
                 c.scoring_type, c.is_equitation, c.is_championship,
                 c.num_rounds, c.num_judges, c.derby_type,
                 c.show_flags, c.r1_time_allowed, c.r2_time_allowed,
                 c.r3_time_allowed, c.prize_money
          FROM rings r
          JOIN shows s ON s.id = r.show_id
          LEFT JOIN classes c
            ON c.ring_id = r.id AND c.class_id = ?
          WHERE s.slug = ? AND r.ring_num = ?
        `).bind(lensClassId, slug, ringNumInt).first();
      } catch (e) { return err('DB error: ' + e.message); }
      if (!row) return err('Unknown show/ring pair', 404);
      const lk = computeShowLock(row);
      if (lk.locked) return lockedResponse(lk.reason);
      const classKind = deriveClassKindV3(row.class_type, row.scoring_method);

      // Phase 3b Chunk 13 — when the focused class is hunter, pull
      // current standings from D1 so the page can render a leaderboard.
      // UDP frames 12/16 are TRIGGERS not data sources per S42; the .cls
      // is authoritative and is parsed into entry_hunter_summary on each
      // /v3/postCls. Reading here on every UDP batch is wasteful but
      // simple — score updates happen on .cls writes (1-2/sec at peak,
      // not per-frame), so we accept the 1Hz read overhead until a real
      // show surfaces a perf concern. Cache strategy can land later.
      const hunterScores = (classKind === 'hunter')
        ? await pullHunterScoresV3(env, row.class_pk)
        : null;
      const jumperScores = (classKind === 'jumper' || classKind === 'equitation')
        ? await pullJumperScoresV3(env, row.class_pk)
        : null;

      const received_at = new Date().toISOString();
      const batchId = crypto.randomUUID();
      const showId = row.show_id;

      // Snapshot shape — full batch + a `last` pointer so live.html can render
      // the most recent event without scanning the array.
      const lastEvent = events[events.length - 1] || null;
      // Per-channel "last" — splitting `last` into last_scoring (Channel A,
      // the actual on-course / clock-bearing frame) and last_focus
      // (Channel B operator-selected class context). Both are needed
      // because a single batch can contain a frame=11 with horse data
      // AND a focus heartbeat; older `last` would lose the horse data
      // if the focus event arrived later in the batch. The DO carries
      // these forward across batches so a focus-only batch doesn't blank
      // the on-course panel. (S43 Chunk 12 — Bill 2026-05-02.)
      let lastScoring = null;
      let lastFocus = null;
      let lastIdentity = null;
      // Channel A frames that carry "currently on course" identity tags
      // ({1}=entry, {2}=horse, {3}=rider, {4}=owner). Frames 0 (clear),
      // 12 (hunter Display Scores trigger), 16 (hunter derby trigger),
      // and Channel B (focus) are explicitly excluded — those don't
      // identify an active rider, even though they may carry the field
      // in cycling-page form (S42 rule).
      const IDENTITY_FRAMES = new Set([1, 11, 14]);
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (!lastScoring && e.channel === 'A') lastScoring = e;
        if (!lastFocus   && e.channel === 'B') lastFocus = e;
        if (!lastIdentity && e.channel === 'A' && IDENTITY_FRAMES.has(e.frame)) {
          lastIdentity = e;
        }
        if (lastScoring && lastFocus && lastIdentity) break;
      }
      // Channel B {29}="F" → operator marked the class FINAL on Ryegate
      // (the long-flagged "wiring TBD" CLASS_COMPLETE signal — Bill
      // 2026-05-05). Class-level state, captured per-focused-class.
      // Other values (empty / missing / anything else) → not final.
      const isFinal = !!(lastFocus && lastFocus.tags &&
        ((lastFocus.tags['29'] || '').replace(/\r/g, '').trim().toUpperCase() === 'F'));
      const snapshot = {
        slug, ring_num: ringNumInt,
        received_at,
        batch_id: batchId,
        events,
        last: lastEvent,           // backward-compat — last event of any channel
        last_scoring: lastScoring, // most recent Channel A event in this batch
        last_focus:   lastFocus,   // most recent Channel B event in this batch
        last_identity: lastIdentity, // most recent A-frame in {1,11,14} — carries
                                   // entry/horse/rider/owner tags; survives
                                   // trigger frames (12/16) so the page
                                   // can keep showing the last rider during
                                   // score display
        is_final: isFinal,         // operator-set class FINAL flag (Channel B {29}="F")
        // Lens-aware display flag (Phase 3b polish). Page uses class_kind
        // to render UDP tags with their human labels. Null → raw {N}=val.
        class_kind: classKind,
        // Class metadata for the page header + round-label rendering.
        // null when no class focus / class not yet parsed in D1.
        // Full cls shape needed by west-jumper-templates.js +
        // west-hunter-templates.js renderTable. Same shape class.html
        // consumes for /v3/listEntries — single source of truth so the
        // live page and the results page render identically.
        class_meta: row.class_pk ? {
          // class_id stamped on the meta so the DO can route it to the
          // RIGHT byClass entry instead of polluting whatever class is
          // currently focused (Bill 2026-05-06). Without this, opening
          // a different focus class while UDP is still firing for class
          // X would write class X's meta into byClass[focused], leaving
          // both with the wrong name.
          class_id: lensClassId,
          class_name: row.class_name || null,
          class_type: row.class_type || null,
          class_mode: row.class_mode != null ? row.class_mode : null,
          scoring_method: row.scoring_method != null ? row.scoring_method : null,
          scoring_modifier: row.scoring_modifier != null ? row.scoring_modifier : null,
          scoring_type: row.scoring_type != null ? row.scoring_type : null,
          is_equitation: row.is_equitation === 1 ? 1 : 0,
          is_championship: row.is_championship === 1 ? 1 : 0,
          num_rounds: row.num_rounds != null ? row.num_rounds : null,
          num_judges: row.num_judges != null ? row.num_judges : null,
          derby_type: row.derby_type != null ? row.derby_type : null,
          // ShowFlags = jumper class header H[26]. When 1, public surfaces
          // render the FEI 3-letter country flag next to the rider/horse.
          // Hunter's H[26] is Phase2Label so this only fires for J/T classes.
          show_flags: row.show_flags === 1 ? 1 : 0,
          r1_time_allowed: row.r1_time_allowed != null ? row.r1_time_allowed : null,
          r2_time_allowed: row.r2_time_allowed != null ? row.r2_time_allowed : null,
          r3_time_allowed: row.r3_time_allowed != null ? row.r3_time_allowed : null,
          // Prize money — JSON-encoded in D1 (text column); parse here
          // so consumers get a clean array of dollar amounts per place.
          prize_money: row.prize_money ? safeParsePrizeMoney(row.prize_money) : null,
        } : null,
        // Phase 3b Chunk 13/14 — D1-fed standings for live.html, lens-
        // dependent. hunter_scores populated when class_kind=hunter;
        // jumper_scores populated when class_kind=jumper or equitation.
        // The other is null so the page panel hides.
        hunter_scores: hunterScores,
        jumper_scores: jumperScores,
        // Engine-controlled display preferences. Default true so a missing
        // field on legacy engines doesn't switch the page to whole-seconds
        // (matches the engine-side default Bill set 2026-05-02).
        live_running_tenth: live_running_tenth === false ? false : true,
      };
      // Phase 3b Chunk 6 — route through the Durable Object instead of
      // writing KV directly. DO is now the authoritative state holder; it
      // handles the KV mirror so this stays a one-writer model. Chunk 7
      // will extend the DO to broadcast over WebSocket on each event.
      // S46: read the DO response body so we can echo is_live /
      // live_since / live_class_ids back to the engine — the engine's
      // "Live on website" panel reads these on every batch.
      let liveEcho = null;
      try {
        const id = env.RING_STATE.idFromName(`${slug}:${ringNumInt}`);
        const stub = env.RING_STATE.get(id);
        const doResp = await stub.fetch('https://do/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
        });
        if (!doResp.ok) {
          console.log(`[v3/postUdpEvent] DO write status ${doResp.status} for ${slug}/${ringNumInt}`);
        } else {
          try { liveEcho = await doResp.json(); }
          catch (e) { /* non-JSON DO response — ignore */ }
        }
      } catch (e) {
        console.log(`[v3/postUdpEvent] DO route failed for ${slug}/${ringNumInt}: ${e.message}`);
      }

      // D1 batch insert — one row per event. We accept partial validity:
      // skip events missing required fields rather than rejecting the whole
      // batch (any operator-visible drop will surface in the response).
      const stmt = env.WEST_DB_V3.prepare(`
        INSERT INTO udp_events
          (show_id, ring_num, class_id, channel, frame, tags, engine_at, received_at, batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const ops = [];
      let skipped = 0;
      for (const e of events) {
        if (!e || (e.channel !== 'A' && e.channel !== 'B')) { skipped++; continue; }
        ops.push(stmt.bind(
          showId,
          ringNumInt,
          e.class_id || null,
          e.channel,
          Number.isFinite(e.frame) ? e.frame : null,
          JSON.stringify(e.tags || {}),
          e.at || received_at,
          received_at,
          batchId,
        ));
      }
      let inserted = 0;
      let dbError = null;
      if (ops.length) {
        try {
          await env.WEST_DB_V3.batch(ops);
          inserted = ops.length;
        } catch (e) {
          dbError = e.message;
          console.log(`[v3/postUdpEvent] D1 batch insert failed for ${slug}/${ringNumInt}: ${e.message}`);
        }
      }

      // Spread the DO's response first so any field it returns flows
      // through automatically — the route's fields below override any
      // collisions (notably `ok`). Avoids the cherry-pick trap where
      // adding a new DO field requires also updating this list (which
      // bit us twice on S46 — Bill 2026-05-06: "just fix thats whare
      // we're here for"). When the DO call failed, liveEcho is null
      // and the spread is a no-op.
      return json({
        ...(liveEcho || {}),
        ok: true,
        received_at,
        batch_id: batchId,
        events_received: events.length,
        events_inserted: inserted,
        events_skipped: skipped,
        db_error: dbError,
      });
    }

    // ── GET /v3/live (Phase 3b Chunk 7) — WebSocket push ─────────────────────
    // Spectator endpoint. Upgrades to WebSocket and forwards to the
    // RingStateDO instance for that (slug, ring) pair. The DO accepts via
    // the hibernation API, sends an initial snapshot, then broadcasts on
    // every new event arriving through /v3/postUdpEvent. Public — no auth
    // (matches /v3/getRingState, spectator-facing).
    if (path === '/v3/live') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (request.headers.get('Upgrade') !== 'websocket') {
        return err('Expected WebSocket', 426);
      }
      const slug = url.searchParams.get('slug');
      const ringNumRaw = url.searchParams.get('ring_num');
      if (!slug) return err('Missing slug');
      if (ringNumRaw === null || ringNumRaw === '') return err('Missing ring_num');
      const ringNumInt = parseInt(ringNumRaw, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      const id = env.RING_STATE.idFromName(`${slug}:${ringNumInt}`);
      const stub = env.RING_STATE.get(id);
      // Forward the original request (Upgrade header preserved). Rewrite
      // the URL so the DO's internal router sees /ws and the slug+ring
      // params it needs for warm-up.
      const doUrl = `https://do/ws?slug=${encodeURIComponent(slug)}&ring_num=${ringNumInt}`;
      return stub.fetch(new Request(doUrl, request));
    }

    // ── GET /v3/getRingState (Phase 3a Chunk 4) ──────────────────────────────
    // Public read path for the live page. No auth — spectator-facing. Returns
    // the latest engine-posted snapshot from KV (ring-state:{slug}:{ring_num}),
    // or {snapshot: null} if nothing's been posted (or the 10-min TTL expired).
    // Phase 3b replaces this with a Durable Object + WebSocket push, but the
    // shape stays similar so live.html's render code keeps working.
    if (method === 'GET' && path === '/v3/getRingState') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      const slug = url.searchParams.get('slug');
      const ringNumRaw = url.searchParams.get('ring_num');
      if (!slug) return err('Missing slug');
      if (ringNumRaw === null || ringNumRaw === '') return err('Missing ring_num');
      const ringNumInt = parseInt(ringNumRaw, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      let snapshot = null;
      try {
        const raw = await env.WEST_LIVE.get(`ring-state:${slug}:${ringNumInt}`);
        if (raw) snapshot = JSON.parse(raw);
      } catch (e) {
        return err('KV error: ' + e.message);
      }
      return json({ ok: true, snapshot });
    }

    // ── POST /v3/setClassLiveState ───────────────────────────────────────────
    // Manual operator action from the engine right-click menu (Bill
    // 2026-05-06). Auth-required — engine-only mutation. Routes to the
    // ring's DO /class-action handler. action ∈ { clear | finalize | focus }.
    if (method === 'POST' && path === '/v3/setClassLiveState') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const slug = body.slug;
      const ringNumInt = parseInt(body.ring_num, 10);
      const classId = body.class_id != null ? String(body.class_id) : '';
      const action = String(body.action || '').toLowerCase();
      if (!slug) return err('Missing slug');
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      if (action !== 'clear' && action !== 'finalize' && action !== 'focus' && action !== 'flush_all') {
        return err('action must be clear|finalize|focus|flush_all');
      }
      if (action !== 'flush_all' && !classId) return err('Missing class_id');
      try {
        const id = env.RING_STATE.idFromName(`${slug}:${ringNumInt}`);
        const stub = env.RING_STATE.get(id);
        const doResp = await stub.fetch('https://do/class-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, ring_num: ringNumInt, class_id: classId, action }),
        });
        const data = await doResp.json().catch(() => null);
        if (!doResp.ok) return err((data && data.error) || `DO ${doResp.status}`, doResp.status);
        return json(data || { ok: true });
      } catch (e) {
        return err('DO route failed: ' + e.message, 500);
      }
    }

    // ── POST /v3/flushRing ───────────────────────────────────────────────────
    // Wipe ALL data for a (slug, ring_num) pair: classes, entries, scoring
    // tables, R2 .cls archives, KV state, and the DO's in-memory byClass.
    // Show row + ring row are PRESERVED — only the data inside the ring is
    // cleared. After this, the next /v3/postCls from the engine will rebuild
    // class rows fresh.
    //
    // Use case: operator points the engine at a venue with leftover .cls
    // files from a prior week. Engine uploads them all, mixing test/old
    // data with current. Operator stops the engine, hits Flush ring in
    // admin, restarts the engine.
    //
    // Auth-gated. Caller MUST stop the engine first — if /v3/postCls fires
    // while this runs, you'll get a partial flush (engine recreates rows
    // mid-delete). The endpoint doesn't enforce that; it's an operator
    // discipline thing flagged in the admin button's confirm dialog.
    if (method === 'POST' && path === '/v3/flushRing') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const slug = body.slug;
      const ringNumInt = parseInt(body.ring_num, 10);
      if (!slug) return err('Missing slug');
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      // Resolve ring + show ids up front so we can scope every delete by id
      // (faster than slug+ring_num joins on every statement).
      let showId, ringId;
      try {
        const row = await env.WEST_DB_V3.prepare(`
          SELECT r.id AS ring_id, s.id AS show_id
          FROM rings r JOIN shows s ON s.id = r.show_id
          WHERE s.slug = ? AND r.ring_num = ?
        `).bind(slug, ringNumInt).first();
        if (!row) return err('Unknown show/ring pair', 404);
        showId = row.show_id;
        ringId = row.ring_id;
      } catch (e) { return err('DB error: ' + e.message); }

      const summary = {
        entries_deleted: 0,
        classes_deleted: 0,
        udp_events_deleted: 0,
        ring_segments_deleted: 0,
        r2_objects_deleted: 0,
        kv_keys_deleted: 0,
        do_flushed: false,
      };

      // Delete order matters — child rows before parents to satisfy FKs.
      // class_jumper_stats has a FK to entries(id) via fastest_4fault columns,
      // so it must go BEFORE entries even though it lives at class scope.
      try {
        const entryFilter = '(SELECT e.id FROM entries e JOIN classes c ON c.id = e.class_id WHERE c.ring_id = ?)';
        await env.WEST_DB_V3.prepare(`DELETE FROM entry_jumper_summary WHERE entry_id IN ${entryFilter}`).bind(ringId).run();
        await env.WEST_DB_V3.prepare(`DELETE FROM entry_jumper_rounds  WHERE entry_id IN ${entryFilter}`).bind(ringId).run();
        await env.WEST_DB_V3.prepare(`DELETE FROM entry_hunter_summary WHERE entry_id IN ${entryFilter}`).bind(ringId).run();
        await env.WEST_DB_V3.prepare(`DELETE FROM entry_hunter_rounds  WHERE entry_id IN ${entryFilter}`).bind(ringId).run();
        await env.WEST_DB_V3.prepare(`DELETE FROM entry_hunter_judge_scores WHERE entry_id IN ${entryFilter}`).bind(ringId).run();
        await env.WEST_DB_V3.prepare(`DELETE FROM entry_hunter_judge_cards  WHERE entry_id IN ${entryFilter}`).bind(ringId).run();
        await env.WEST_DB_V3.prepare(`DELETE FROM class_jumper_stats WHERE class_id IN (SELECT id FROM classes WHERE ring_id = ?)`).bind(ringId).run();
        const entriesRes = await env.WEST_DB_V3.prepare(`DELETE FROM entries WHERE class_id IN (SELECT id FROM classes WHERE ring_id = ?)`).bind(ringId).run();
        summary.entries_deleted = (entriesRes.meta && entriesRes.meta.changes) || 0;
        const classesRes = await env.WEST_DB_V3.prepare(`DELETE FROM classes WHERE ring_id = ?`).bind(ringId).run();
        summary.classes_deleted = (classesRes.meta && classesRes.meta.changes) || 0;
        const udpRes = await env.WEST_DB_V3.prepare(`DELETE FROM udp_events WHERE show_id = ? AND ring_num = ?`).bind(showId, ringNumInt).run();
        summary.udp_events_deleted = (udpRes.meta && udpRes.meta.changes) || 0;
        const segRes = await env.WEST_DB_V3.prepare(`DELETE FROM ring_live_segment WHERE show_slug = ? AND ring_num = ?`).bind(slug, ringNumInt).run();
        summary.ring_segments_deleted = (segRes.meta && segRes.meta.changes) || 0;
      } catch (e) {
        return err('D1 flush failed: ' + e.message + ' — partial state, retry', 500);
      }

      // R2: list and delete all .cls archives under the ring's prefix.
      // Cursor through pages so a ring with >1000 classes still cleans fully.
      try {
        const prefix = `${slug}/${ringNumInt}/`;
        let cursor;
        do {
          const listed = await env.WEST_R2_CLS.list({ prefix, cursor });
          const keys = (listed.objects || []).map(o => o.key);
          if (keys.length) {
            await env.WEST_R2_CLS.delete(keys);
            summary.r2_objects_deleted += keys.length;
          }
          cursor = listed.truncated ? listed.cursor : null;
        } while (cursor);
      } catch (e) {
        console.log(`[v3/flushRing] R2 cleanup failed for ${slug}/${ringNumInt}: ${e.message}`);
        // Non-fatal — D1 is the source of truth, R2 orphans are reclaimable.
      }

      // KV: nuke the ring-state snapshot and last-cls pointer. Engine
      // heartbeat (engine:slug:ring) intentionally left alone — it'll
      // refresh on next engine batch, and clearing it would break the
      // index page's "ring is live" pulse for any operators watching.
      try {
        await env.WEST_LIVE.delete(`ring-state:${slug}:${ringNumInt}`);
        summary.kv_keys_deleted++;
      } catch (e) { console.log(`[v3/flushRing] KV ring-state delete: ${e.message}`); }
      try {
        await env.WEST_LIVE.delete(`cls-last:${slug}:${ringNumInt}`);
        summary.kv_keys_deleted++;
      } catch (e) { console.log(`[v3/flushRing] KV cls-last delete: ${e.message}`); }

      // DO: route flush_all through the existing /class-action handler so
      // the in-memory byClass + segment trackers reset cleanly. The
      // 15-second cls_lock cooldown set by flush_all is a feature here —
      // if the engine restarts immediately and Ryegate writes a trailing
      // .cls (no real new scoring), it won't relight a class.
      try {
        const id = env.RING_STATE.idFromName(`${slug}:${ringNumInt}`);
        const stub = env.RING_STATE.get(id);
        const doResp = await stub.fetch('https://do/class-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, ring_num: ringNumInt, action: 'flush_all' }),
        });
        summary.do_flushed = doResp.ok;
      } catch (e) {
        console.log(`[v3/flushRing] DO flush failed: ${e.message}`);
      }

      console.log(`[v3/flushRing] ${slug}/${ringNumInt} — ${JSON.stringify(summary)}`);
      return json({ ok: true, slug, ring_num: ringNumInt, summary });
    }

    // ── GET /v3/getShowLiveStatus ────────────────────────────────────────────
    // Bulk live-state read for a show's rings. Used by classes.html /
    // class.html / show.html to render "Live" pills/banners without
    // round-tripping the page through the DO. Returns one entry per
    // configured ring with its is_live + live_class_ids from the KV
    // mirror. Public — no auth.
    if (method === 'GET' && path === '/v3/getShowLiveStatus') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      let rings = [];
      try {
        const showRow = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!showRow) return err('Show not found', 404);
        const ringRows = await env.WEST_DB_V3.prepare(
          'SELECT ring_num, name FROM rings WHERE show_id = ? ORDER BY sort_order, ring_num'
        ).bind(showRow.id).all();
        rings = ringRows.results || [];
      } catch (e) {
        return err('DB error: ' + e.message);
      }
      const out = [];
      for (const r of rings) {
        let snap = null;
        try {
          const raw = await env.WEST_LIVE.get(`ring-state:${slug}:${r.ring_num}`);
          if (raw) snap = JSON.parse(raw);
        } catch (e) { /* tolerate per-ring KV error */ }
        out.push({
          ring_num: r.ring_num,
          ring_name: r.name || null,
          is_live: !!(snap && snap.is_live),
          live_since: snap && snap.live_since ? snap.live_since : null,
          live_class_ids: (snap && Array.isArray(snap.live_class_ids))
            ? snap.live_class_ids : [],
          focused_class_id: snap ? (snap.focused_class_id || null) : null,
          // S46 — focus_preview gives commentator-screen consumers a
          // single-call view of who's on course in each live ring
          // (entry/horse/rider/clock/rank/faults). Stats page strip uses
          // this to surface real-time on-course context without per-ring
          // /v3/getRingState round-trips.
          focus_preview: snap ? (snap.focus_preview || null) : null,
        });
      }
      return json({ ok: true, slug, rings: out });
    }

    // ── GET /v3/ringActivityReport ───────────────────────────────────────────
    // Manager report — sums ring active time per day from the
    // ring_live_segment table. Each row in the table is a CONTINUOUS live
    // span (one or more classes), so summing (ended_at - started_at) is
    // accurate without interval-merging.
    //
    // Query params:
    //   slug    — required, show slug
    //   from    — optional ISO date (YYYY-MM-DD), inclusive lower bound
    //   to      — optional ISO date (YYYY-MM-DD), inclusive upper bound
    //   ring    — optional ring_num to filter to one ring
    //
    // Returns: { ok, slug, segments: [...], totals: [{ ring, day, segments,
    //            active_minutes, classes_run }] }
    // segments[] includes the raw rows for drill-down. Open segments
    // (ended_at IS NULL — currently in progress) are EXCLUDED from totals
    // but listed in segments[] with active_so_far_minutes for transparency.
    if (method === 'GET' && path === '/v3/ringActivityReport') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      const fromDate = url.searchParams.get('from');
      const toDate   = url.searchParams.get('to');
      const ringStr  = url.searchParams.get('ring');
      const ringFilter = ringStr ? parseInt(ringStr, 10) : null;
      if (ringStr && !Number.isFinite(ringFilter)) return err('Invalid ring');
      const where = ['show_slug = ?'];
      const binds = [slug];
      if (fromDate) {
        const ms = Date.parse(fromDate + 'T00:00:00Z');
        if (!Number.isFinite(ms)) return err('Invalid from date');
        where.push('started_at >= ?');
        binds.push(ms);
      }
      if (toDate) {
        const ms = Date.parse(toDate + 'T23:59:59Z');
        if (!Number.isFinite(ms)) return err('Invalid to date');
        where.push('started_at <= ?');
        binds.push(ms);
      }
      if (ringFilter !== null) {
        where.push('ring_num = ?');
        binds.push(ringFilter);
      }
      let segments = [];
      try {
        const res = await env.WEST_DB_V3.prepare(
          `SELECT id, ring_num, started_at, ended_at, ended_reason,
                  classes_run, last_event_at
           FROM ring_live_segment
           WHERE ${where.join(' AND ')}
           ORDER BY started_at ASC`
        ).bind(...binds).all();
        segments = res.results || [];
      } catch (e) {
        return err('DB error: ' + e.message);
      }
      // Roll up daily totals per ring. Day key uses UTC date — show
      // timezone could be applied later if reports surface midnight-edge
      // segments. Open segments not counted toward totals.
      const totalsMap = new Map();
      const enriched = segments.map(s => {
        const closed = s.ended_at != null;
        const durMin = closed
          ? Math.max(0, Math.round((s.ended_at - s.started_at) / 60000))
          : null;
        const liveMin = !closed
          ? Math.max(0, Math.round((Date.now() - s.started_at) / 60000))
          : null;
        if (closed) {
          const dayKey = new Date(s.started_at).toISOString().slice(0, 10);
          const totalsKey = `${s.ring_num}|${dayKey}`;
          let bucket = totalsMap.get(totalsKey);
          if (!bucket) {
            bucket = { ring_num: s.ring_num, day: dayKey, segments: 0,
                       active_minutes: 0, classes_run: 0 };
            totalsMap.set(totalsKey, bucket);
          }
          bucket.segments += 1;
          bucket.active_minutes += durMin || 0;
          bucket.classes_run += s.classes_run || 0;
        }
        return {
          id: s.id,
          ring_num: s.ring_num,
          started_at: s.started_at,
          ended_at: s.ended_at,
          ended_reason: s.ended_reason,
          classes_run: s.classes_run,
          last_event_at: s.last_event_at,
          duration_minutes: durMin,
          active_so_far_minutes: liveMin,
          is_open: !closed,
        };
      });
      const totals = Array.from(totalsMap.values()).sort((a, b) => {
        if (a.day !== b.day) return a.day.localeCompare(b.day);
        return a.ring_num - b.ring_num;
      });

      // Rings on hold (Bill 2026-05-08): gaps BETWEEN consecutive
      // closed segments on the same ring + same day = the ring went
      // idle and came back. Cross-day gaps (overnight) excluded —
      // those aren't "on hold" in the operator sense.
      //
      // Threshold: gaps under HOLD_MIN_MINUTES are noise (operator
      // momentarily switched class focus, brief technical pause,
      // cls_lock cooldown after Flush). 10 min is the operator-side
      // threshold — anything shorter doesn't read as "the ring was on
      // hold," it reads as normal between-class pacing. Bill 2026-05-08.
      const HOLD_MIN_MINUTES = 10;
      const closedSegs = enriched.filter(s => !s.is_open && s.ended_at != null);
      const segsByRing = new Map();
      for (const s of closedSegs) {
        const arr = segsByRing.get(s.ring_num) || [];
        arr.push(s); segsByRing.set(s.ring_num, arr);
      }
      const holds = [];
      for (const [ringNum, arr] of segsByRing.entries()) {
        arr.sort((a, b) => a.started_at - b.started_at);
        for (let i = 1; i < arr.length; i++) {
          const prev = arr[i - 1], curr = arr[i];
          const prevDay = new Date(prev.ended_at).toISOString().slice(0, 10);
          const currDay = new Date(curr.started_at).toISOString().slice(0, 10);
          if (prevDay !== currDay) continue;  // overnight, not a hold
          const gapMs = curr.started_at - prev.ended_at;
          if (gapMs <= 0) continue;
          const gapMin = Math.max(0, Math.round(gapMs / 60000));
          if (gapMin < HOLD_MIN_MINUTES) continue;
          holds.push({
            ring_num: ringNum,
            day: prevDay,
            started_at: prev.ended_at,
            ended_at: curr.started_at,
            duration_minutes: gapMin,
            after_segment_id: prev.id,
            before_segment_id: curr.id,
          });
        }
      }
      holds.sort((a, b) => a.started_at - b.started_at);

      // Resolve show id ONCE for the money + horse-rider rollups.
      // Both queries need it; segment query above used show_slug
      // directly so didn't need the lookup.
      let showRow = null;
      try {
        showRow = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?').bind(slug).first();
      } catch (e) {
        console.log(`[v3/ringActivityReport] show lookup failed: ${e.message}`);
      }

      // Prize money awarded by ring + day. Same json_extract pattern
      // as the show-stats top-horses query, grouped at ring scope.
      // Filtered by date range when from/to provided so the totals
      // line up with the segments view.
      let moneyByRing = [];
      if (showRow) {
        try {
          const where2 = ['c.show_id = ?', "c.class_type IN ('J','T')",
                          'c.deleted_at IS NULL',
                          "c.prize_money IS NOT NULL", "c.prize_money != ''"];
          const binds2 = [showRow.id];
          if (fromDate) { where2.push('c.scheduled_date >= ?'); binds2.push(fromDate); }
          if (toDate)   { where2.push('c.scheduled_date <= ?'); binds2.push(toDate); }
          if (ringFilter !== null) { where2.push('r.ring_num = ?'); binds2.push(ringFilter); }
          const moneySql = `
            SELECT
              r.ring_num,
              r.name AS ring_name,
              c.scheduled_date AS day,
              SUM(CASE
                WHEN s.overall_place IS NOT NULL AND s.overall_place > 0
                THEN COALESCE(CAST(json_extract(c.prize_money,
                  '$[' || (s.overall_place - 1) || ']') AS REAL), 0)
                ELSE 0
              END) AS money_awarded,
              COUNT(DISTINCT c.id) AS money_classes
            FROM classes c
            JOIN rings r ON r.id = c.ring_id
            LEFT JOIN entries e ON e.class_id = c.id
            LEFT JOIN entry_jumper_summary s ON s.entry_id = e.id
            WHERE ${where2.join(' AND ')}
            GROUP BY r.id, c.scheduled_date
            HAVING money_awarded > 0
            ORDER BY c.scheduled_date, r.ring_num
          `;
          const mres = await env.WEST_DB_V3.prepare(moneySql).bind(...binds2).all();
          moneyByRing = mres.results || [];
        } catch (e) {
          console.log(`[v3/ringActivityReport] money rollup failed: ${e.message}`);
        }
      }

      // Riders with the most horses (across the whole show — date
      // filter doesn't apply since horse-count is a roster fact, not
      // a daily one). Hunter + jumper, ring filter applies.
      let topHorseRiders = [];
      if (showRow) {
        try {
          const where3 = ['c.show_id = ?', 'c.deleted_at IS NULL',
            "e.rider_name IS NOT NULL AND TRIM(e.rider_name) != ''",
            "e.horse_name IS NOT NULL AND TRIM(e.horse_name) != ''"];
          const binds3 = [showRow.id];
          if (ringFilter !== null) { where3.push('r.ring_num = ?'); binds3.push(ringFilter); }
          const ridersSql = `
            SELECT
              MAX(e.rider_name) AS rider,
              COUNT(DISTINCT UPPER(TRIM(e.horse_name))) AS horse_count,
              COUNT(DISTINCT e.class_id) AS classes_entered
            FROM entries e
            JOIN classes c ON c.id = e.class_id
            JOIN rings   r ON r.id = c.ring_id
            WHERE ${where3.join(' AND ')}
            GROUP BY UPPER(TRIM(e.rider_name))
            HAVING horse_count > 1
            ORDER BY horse_count DESC, rider ASC
            LIMIT 15
          `;
          const rres = await env.WEST_DB_V3.prepare(ridersSql).bind(...binds3).all();
          topHorseRiders = rres.results || [];
        } catch (e) {
          console.log(`[v3/ringActivityReport] horse-rider rollup failed: ${e.message}`);
        }
      }

      return json({ ok: true, slug, segments: enriched, totals,
        holds, money_by_ring: moneyByRing, top_horse_riders: topHorseRiders });
    }

    // ── POST /v3/updateRing ──────────────────────────────────────────────────
    // Update editable ring fields. ring_num stays immutable (same rationale
    // as slug on shows — it's the operator-facing key). Name and sort_order
    // are editable; empty name clears it back to null (UI falls back to
    // "Ring N" display).
    if (method === 'POST' && path === '/v3/updateRing') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, name, sort_order } = body;
      if (!slug) return err('Missing slug');
      if (ring_num === undefined || ring_num === null) return err('Missing ring_num');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      const updates = [];
      const binds = [];
      if (name !== undefined) {
        updates.push('name = ?');
        binds.push((name || '').trim() || null);
      }
      if (sort_order !== undefined) {
        const so = parseInt(sort_order, 10);
        if (!Number.isFinite(so)) return err('Invalid sort_order');
        updates.push('sort_order = ?');
        binds.push(so);
      }
      if (!updates.length) return err('No fields to update');
      updates.push("updated_at = datetime('now')");
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        binds.push(show.id, ringNumInt);
        const res = await env.WEST_DB_V3.prepare(
          `UPDATE rings SET ${updates.join(', ')} WHERE show_id = ? AND ring_num = ?`
        ).bind(...binds).run();
        if (!res.meta || !res.meta.changes) return err('Ring not found', 404);
        const ring = await env.WEST_DB_V3.prepare(
          'SELECT * FROM rings WHERE show_id = ? AND ring_num = ?'
        ).bind(show.id, ringNumInt).first();
        return json({ ok: true, ring });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/createRing ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/v3/createRing') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, name, sort_order } = body;
      if (!slug) return err('Missing slug');
      if (ring_num === undefined || ring_num === null) return err('Missing ring_num');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt) || ringNumInt < 1 || ringNumInt > 99) {
        return err('Invalid ring_num — must be integer 1-99');
      }
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        await env.WEST_DB_V3.prepare(`
          INSERT INTO rings (show_id, ring_num, name, sort_order)
          VALUES (?, ?, ?, ?)
        `).bind(
          show.id, ringNumInt, (name || '').trim() || null,
          Number.isFinite(parseInt(sort_order, 10)) ? parseInt(sort_order, 10) : 0
        ).run();
        const ring = await env.WEST_DB_V3.prepare(
          'SELECT * FROM rings WHERE show_id = ? AND ring_num = ?'
        ).bind(show.id, ringNumInt).first();
        console.log(`[v3] Created ring: ${slug}/ring-${ringNumInt}`);
        return json({ ok: true, ring });
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) return err('Ring already exists for this show', 409);
        return err('DB error: ' + e.message);
      }
    }

    return err('Not found', 404);
  }
};

// ── ACTIVATE SHOW ─────────────────────────────────────────────────────────────
// Called on heartbeat — flips status pending→active, updates name if set
// ── HUNTER JUDGE-GRID RANK COMPUTE PASS ──────────────────────────────────────
// Reads the raw per-judge / per-round / per-entry tables and writes back the
// derived rank columns + entry_hunter_judge_cards aggregate. Idempotent —
// safe to re-run any time the underlying raw data for a class changes
// (every /v3/postCls runs it; the standalone /v3/recomputeJudgeRanks
// endpoint also calls it for manual edits or backfill).
//
// Mode-agnostic: derby high_options + handy_bonus are nullable, so the
// COALESCE math works for non-derby (where they're null/0) and derby alike.
//
// All four steps scope strictly to entries WHERE class_id = ? — never
// touches other classes.
async function computeJudgeGridRanks(env, classDbId) {
  const db = env.WEST_DB_V3;

  // (1) judge_round_rank — RANK over (round, judge_idx) by effective score.
  await db.prepare(`
    UPDATE entry_hunter_judge_scores AS hjs
    SET judge_round_rank = (
      SELECT rk FROM (
        SELECT entry_id, round, judge_idx,
               RANK() OVER (
                 PARTITION BY round, judge_idx
                 ORDER BY (base_score + COALESCE(high_options, 0) + COALESCE(handy_bonus, 0)) DESC
               ) AS rk
        FROM entry_hunter_judge_scores
        WHERE entry_id IN (SELECT id FROM entries WHERE class_id = ?1)
      ) AS r
      WHERE r.entry_id  = hjs.entry_id
        AND r.round     = hjs.round
        AND r.judge_idx = hjs.judge_idx
    )
    WHERE hjs.entry_id IN (SELECT id FROM entries WHERE class_id = ?1)
  `).bind(classDbId).run();

  // (2) round_overall_rank — RANK over (round) by round total.
  await db.prepare(`
    UPDATE entry_hunter_rounds AS hr
    SET round_overall_rank = (
      SELECT rk FROM (
        SELECT entry_id, round,
               RANK() OVER (PARTITION BY round ORDER BY total DESC) AS rk
        FROM entry_hunter_rounds
        WHERE entry_id IN (SELECT id FROM entries WHERE class_id = ?1)
      ) AS r
      WHERE r.entry_id = hr.entry_id
        AND r.round    = hr.round
    )
    WHERE hr.entry_id IN (SELECT id FROM entries WHERE class_id = ?1)
  `).bind(classDbId).run();

  // (3) Refresh entry_hunter_judge_cards aggregate. Wipe + insert keeps
  //     stale rows from accumulating when a judge or entry drops out.
  await db.prepare(`
    DELETE FROM entry_hunter_judge_cards
    WHERE entry_id IN (SELECT id FROM entries WHERE class_id = ?)
  `).bind(classDbId).run();

  await db.prepare(`
    INSERT INTO entry_hunter_judge_cards (entry_id, judge_idx, card_total)
    SELECT entry_id, judge_idx,
           SUM(base_score + COALESCE(high_options, 0) + COALESCE(handy_bonus, 0))
    FROM entry_hunter_judge_scores
    WHERE entry_id IN (SELECT id FROM entries WHERE class_id = ?)
    GROUP BY entry_id, judge_idx
  `).bind(classDbId).run();

  // (4) card_rank — RANK over judge_idx by card_total (this entry vs other
  //     entries on the same judge's full card).
  await db.prepare(`
    UPDATE entry_hunter_judge_cards AS hjc
    SET card_rank = (
      SELECT rk FROM (
        SELECT entry_id, judge_idx,
               RANK() OVER (PARTITION BY judge_idx ORDER BY card_total DESC) AS rk
        FROM entry_hunter_judge_cards
        WHERE entry_id IN (SELECT id FROM entries WHERE class_id = ?1)
      ) AS r
      WHERE r.entry_id  = hjc.entry_id
        AND r.judge_idx = hjc.judge_idx
    )
    WHERE hjc.entry_id IN (SELECT id FROM entries WHERE class_id = ?1)
  `).bind(classDbId).run();
}

// ─── computeJumperStats ───────────────────────────────────────────────────
//
// Pre-compute per-class jumper aggregations into class_jumper_stats. The
// jumper analog of computeJudgeGridRanks. Runs synchronously inside
// /v3/postCls jumper branch right after entry_jumper_rounds writes —
// stats refresh the moment new .cls bytes land.
//
// One row per class. DELETE-then-INSERT pattern via UPSERT. Mode-aware:
// fault histogram scheme (standard / speed / optimum / none) selected
// per round via bucketSchemeFor(method, modifier, round).
//
// Design doc: docs/v3-planning/JUMPER-STATS-DESIGN.md
async function computeJumperStats(env, classDbId) {
  const db = env.WEST_DB_V3;

  // Class metadata — needed for scheme dispatch (method, modifier) and
  // optimum-scheme baseline (r1_time_allowed - 4).
  const cls = await db.prepare(
    'SELECT scoring_method, scoring_modifier, r1_time_allowed FROM classes WHERE id = ?'
  ).bind(classDbId).first();
  if (!cls) {
    console.warn('[computeJumperStats] class not found:', classDbId);
    return;
  }
  const method   = Number(cls.scoring_method);
  const modifier = Number(cls.scoring_modifier);

  // Entry-level counts.
  const counts = await db.prepare(`
    SELECT
      COUNT(*) AS total_entries,
      SUM(CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM entry_jumper_rounds r
          WHERE r.entry_id = e.id
            AND (r.status IS NULL OR r.status NOT IN ('DNS','WD','SC'))
        ) THEN 1 ELSE 0
      END) AS scratched,
      SUM(CASE
        WHEN EXISTS (
          SELECT 1 FROM entry_jumper_rounds r
          WHERE r.entry_id = e.id
            AND r.status IN ('EL','RF','DNF','OC')
        ) THEN 1 ELSE 0
      END) AS eliminated
    FROM entries e
    WHERE e.class_id = ?
  `).bind(classDbId).first();

  // Per-round stats (always run all 3; empty rounds produce zeros).
  const rounds = [null, null, null, null]; // 1-indexed
  for (let n = 1; n <= 3; n++) {
    rounds[n] = await computeJumperRoundStats(db, classDbId, n, method, modifier, cls.r1_time_allowed);
  }

  // Entry-list stats (V1 parity). Populate the moment entries land —
  // independent of any rides happening. Jumper-only per Bill's directive.
  const entryStats = await computeJumperEntryStats(db, classDbId);

  // UPSERT.
  const r1 = rounds[1], r2 = rounds[2], r3 = rounds[3];
  await db.prepare(`
    INSERT INTO class_jumper_stats (
      class_id,
      total_entries, scratched, eliminated,
      r1_competed, r1_clears, r1_time_faults, r1_avg_total_time, r1_avg_clear_time,
      r1_avg_total_faults, r1_time_fault_pct,
      r1_fastest_4fault_entry_id, r1_fastest_4fault_time, r1_fault_buckets,
      r2_competed, r2_clears, r2_time_faults, r2_avg_total_time, r2_avg_clear_time,
      r2_avg_total_faults, r2_time_fault_pct,
      r2_fastest_4fault_entry_id, r2_fastest_4fault_time, r2_fault_buckets,
      r3_competed, r3_clears, r3_time_faults, r3_avg_total_time, r3_avg_clear_time,
      r3_avg_total_faults, r3_time_fault_pct,
      r3_fastest_4fault_entry_id, r3_fastest_4fault_time, r3_fault_buckets,
      unique_riders, unique_horses, unique_owners,
      countries_json, multi_riders_json,
      computed_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      datetime('now')
    )
    ON CONFLICT(class_id) DO UPDATE SET
      total_entries             = excluded.total_entries,
      scratched                 = excluded.scratched,
      eliminated                = excluded.eliminated,
      r1_competed               = excluded.r1_competed,
      r1_clears                 = excluded.r1_clears,
      r1_time_faults            = excluded.r1_time_faults,
      r1_avg_total_time         = excluded.r1_avg_total_time,
      r1_avg_clear_time         = excluded.r1_avg_clear_time,
      r1_avg_total_faults       = excluded.r1_avg_total_faults,
      r1_time_fault_pct         = excluded.r1_time_fault_pct,
      r1_fastest_4fault_entry_id = excluded.r1_fastest_4fault_entry_id,
      r1_fastest_4fault_time     = excluded.r1_fastest_4fault_time,
      r1_fault_buckets          = excluded.r1_fault_buckets,
      r2_competed               = excluded.r2_competed,
      r2_clears                 = excluded.r2_clears,
      r2_time_faults            = excluded.r2_time_faults,
      r2_avg_total_time         = excluded.r2_avg_total_time,
      r2_avg_clear_time         = excluded.r2_avg_clear_time,
      r2_avg_total_faults       = excluded.r2_avg_total_faults,
      r2_time_fault_pct         = excluded.r2_time_fault_pct,
      r2_fastest_4fault_entry_id = excluded.r2_fastest_4fault_entry_id,
      r2_fastest_4fault_time     = excluded.r2_fastest_4fault_time,
      r2_fault_buckets          = excluded.r2_fault_buckets,
      r3_competed               = excluded.r3_competed,
      r3_clears                 = excluded.r3_clears,
      r3_time_faults            = excluded.r3_time_faults,
      r3_avg_total_time         = excluded.r3_avg_total_time,
      r3_avg_clear_time         = excluded.r3_avg_clear_time,
      r3_avg_total_faults       = excluded.r3_avg_total_faults,
      r3_time_fault_pct         = excluded.r3_time_fault_pct,
      r3_fastest_4fault_entry_id = excluded.r3_fastest_4fault_entry_id,
      r3_fastest_4fault_time     = excluded.r3_fastest_4fault_time,
      r3_fault_buckets          = excluded.r3_fault_buckets,
      unique_riders             = excluded.unique_riders,
      unique_horses             = excluded.unique_horses,
      unique_owners             = excluded.unique_owners,
      countries_json            = excluded.countries_json,
      multi_riders_json         = excluded.multi_riders_json,
      computed_at               = datetime('now')
  `).bind(
    classDbId,
    counts.total_entries || 0, counts.scratched || 0, counts.eliminated || 0,
    r1.competed, r1.clears, r1.time_faults, r1.avg_total_time, r1.avg_clear_time,
    r1.avg_total_faults, r1.time_fault_pct,
    r1.fastest_4fault_entry_id, r1.fastest_4fault_time, r1.fault_buckets,
    r2.competed, r2.clears, r2.time_faults, r2.avg_total_time, r2.avg_clear_time,
    r2.avg_total_faults, r2.time_fault_pct,
    r2.fastest_4fault_entry_id, r2.fastest_4fault_time, r2.fault_buckets,
    r3.competed, r3.clears, r3.time_faults, r3.avg_total_time, r3.avg_clear_time,
    r3.avg_total_faults, r3.time_fault_pct,
    r3.fastest_4fault_entry_id, r3.fastest_4fault_time, r3.fault_buckets,
    entryStats.unique_riders, entryStats.unique_horses, entryStats.unique_owners,
    entryStats.countries_json, entryStats.multi_riders_json,
  ).run();
}

// Defensive JSON parse for stats columns. Returns [] on null/blank or
// parse failure so the JSON envelope shape stays stable.
function parseStatsJson(raw, contextForLog) {
  if (!raw) return [];
  try { return JSON.parse(raw) || []; }
  catch (e) {
    console.warn(`[parseStatsJson] failed for ${contextForLog}: ${e.message}`);
    return [];
  }
}

async function computeJumperEntryStats(db, classDbId) {
  // Counts (DISTINCT case-insensitive after trim, NULL ignored).
  const counts = await db.prepare(`
    SELECT
      COUNT(DISTINCT UPPER(TRIM(rider_name))) AS unique_riders,
      COUNT(DISTINCT UPPER(TRIM(horse_name))) AS unique_horses,
      COUNT(DISTINCT UPPER(TRIM(owner_name))) AS unique_owners
    FROM entries
    WHERE class_id = ?
  `).bind(classDbId).first();

  // Country breakdown — only entries with a country code present.
  const { results: countryRows } = await db.prepare(`
    SELECT country_code AS code, COUNT(*) AS count
    FROM entries
    WHERE class_id = ? AND country_code IS NOT NULL AND TRIM(country_code) != ''
    GROUP BY country_code
    ORDER BY count DESC, country_code ASC
  `).bind(classDbId).all();
  const countries = (countryRows || []).map(r => ({ code: r.code, count: r.count }));

  // Multi-ride riders — riders with > 1 horse in this class. Group on
  // upper-trimmed key (collapse case-only duplicates) but render the
  // original-cased name from MAX(rider_name) (stable within a class).
  const { results: multiRows } = await db.prepare(`
    SELECT MAX(rider_name) AS rider,
           GROUP_CONCAT(horse_name, '|||') AS horses_blob,
           COUNT(*) AS horse_count
    FROM entries
    WHERE class_id = ? AND rider_name IS NOT NULL AND TRIM(rider_name) != ''
    GROUP BY UPPER(TRIM(rider_name))
    HAVING COUNT(*) > 1
    ORDER BY horse_count DESC, rider ASC
  `).bind(classDbId).all();
  const multiRiders = (multiRows || []).map(r => ({
    rider: r.rider,
    horses: (r.horses_blob || '').split('|||').filter(Boolean),
  }));

  return {
    unique_riders: counts.unique_riders || 0,
    unique_horses: counts.unique_horses || 0,
    unique_owners: counts.unique_owners || 0,
    countries_json:    countries.length    ? JSON.stringify(countries)   : null,
    multi_riders_json: multiRiders.length  ? JSON.stringify(multiRiders) : null,
  };
}

async function computeJumperRoundStats(db, classDbId, round, method, modifier, r1TimeAllowed) {
  const empty = {
    competed: 0, clears: 0, time_faults: 0,
    avg_total_time: null, avg_clear_time: null,
    avg_total_faults: null, time_fault_pct: null,
    fastest_4fault_entry_id: null, fastest_4fault_time: null,
    fault_buckets: null,
  };
  const agg = await db.prepare(`
    SELECT
      COUNT(*) AS competed,
      SUM(CASE WHEN r.total_faults = 0 AND r.status IS NULL THEN 1 ELSE 0 END) AS clears,
      SUM(CASE WHEN r.time_faults > 0 THEN 1 ELSE 0 END) AS time_faults,
      AVG(r.total_time) AS avg_total_time,
      AVG(CASE WHEN r.total_faults = 0 AND r.status IS NULL THEN r.total_time END) AS avg_clear_time,
      AVG(r.total_faults) AS avg_total_faults,
      100.0 * SUM(CASE WHEN r.time_faults > 0 THEN 1 ELSE 0 END) /
        NULLIF(COUNT(*), 0) AS time_fault_pct
    FROM entry_jumper_rounds r
    JOIN entries e ON e.id = r.entry_id
    WHERE e.class_id = ?
      AND r.round = ?
      AND (r.status IS NULL OR r.status NOT IN ('DNS','WD','SC'))
  `).bind(classDbId, round).first();
  if (!agg || (agg.competed || 0) === 0) return empty;

  // Fastest 4-faulter — scheme-aware:
  //   standard → total_faults = 4 (one rail clean)
  //   speed    → jump_faults  = 4 (one rail; time penalty stays in total_time)
  //   optimum / none → concept doesn't apply, returns null.
  const scheme = bucketSchemeFor(method, modifier, round);
  let fastest = null;
  if (scheme === 'standard') {
    fastest = await db.prepare(`
      SELECT r.entry_id, r.total_time
      FROM entry_jumper_rounds r
      JOIN entries e ON e.id = r.entry_id
      WHERE e.class_id = ?
        AND r.round = ?
        AND r.total_faults = 4
        AND r.status IS NULL
        AND r.total_time IS NOT NULL
      ORDER BY r.total_time ASC
      LIMIT 1
    `).bind(classDbId, round).first();
  } else if (scheme === 'speed') {
    fastest = await db.prepare(`
      SELECT r.entry_id, r.total_time
      FROM entry_jumper_rounds r
      JOIN entries e ON e.id = r.entry_id
      WHERE e.class_id = ?
        AND r.round = ?
        AND r.jump_faults = 4
        AND r.status IS NULL
        AND r.total_time IS NOT NULL
      ORDER BY r.total_time ASC
      LIMIT 1
    `).bind(classDbId, round).first();
  }

  const buckets = await computeJumperBuckets(db, classDbId, round, scheme, r1TimeAllowed);

  return {
    competed:                  agg.competed || 0,
    clears:                    agg.clears   || 0,
    time_faults:               agg.time_faults || 0,
    avg_total_time:            agg.avg_total_time,
    avg_clear_time:            agg.avg_clear_time,
    avg_total_faults:          agg.avg_total_faults,
    time_fault_pct:            agg.time_fault_pct,
    fastest_4fault_entry_id:   fastest ? fastest.entry_id   : null,
    fastest_4fault_time:       fastest ? fastest.total_time : null,
    fault_buckets:             buckets ? JSON.stringify(buckets) : null,
  };
}

// Method → bucket scheme. Round-aware so method 6 modifier=1 (1R optimum
// promoted to 2R+JO) can mix optimum (R1) + standard (R2 = JO).
function bucketSchemeFor(method, modifier, round) {
  if (method === 6) {
    if (round === 1) return 'optimum';
    if (Number(modifier) === 1 && round === 2) return 'standard';
    return 'none';
  }
  if ([2, 3, 8, 9, 10, 11, 13, 14, 15].includes(method)) return 'standard';
  if ([0, 4].includes(method)) return 'speed';
  return 'none';
}

async function computeJumperBuckets(db, classDbId, round, scheme, r1TimeAllowed) {
  if (scheme === 'none') return null;

  if (scheme === 'standard') {
    const r = await db.prepare(`
      SELECT
        SUM(CASE WHEN r.total_faults = 0 AND r.status IS NULL    THEN 1 ELSE 0 END) AS clear,
        SUM(CASE WHEN r.total_faults BETWEEN 1 AND 3             THEN 1 ELSE 0 END) AS flts1_3,
        SUM(CASE WHEN r.total_faults = 4                         THEN 1 ELSE 0 END) AS flts4,
        SUM(CASE WHEN r.total_faults BETWEEN 5 AND 7             THEN 1 ELSE 0 END) AS flts5_7,
        SUM(CASE WHEN r.total_faults = 8                         THEN 1 ELSE 0 END) AS flts8,
        SUM(CASE WHEN r.total_faults BETWEEN 9 AND 12            THEN 1 ELSE 0 END) AS flts9_12,
        SUM(CASE WHEN r.total_faults >= 13                       THEN 1 ELSE 0 END) AS flts13p,
        SUM(CASE WHEN r.status IN ('EL','RF','DNF','OC')         THEN 1 ELSE 0 END) AS elim
      FROM entry_jumper_rounds r
      JOIN entries e ON e.id = r.entry_id
      WHERE e.class_id = ? AND r.round = ?
        AND (r.status IS NULL OR r.status NOT IN ('DNS','WD','SC'))
    `).bind(classDbId, round).first();
    return {
      scheme: 'standard',
      buckets: [
        { label: 'Clear',     count: r.clear    || 0 },
        { label: '1-3 flts',  count: r.flts1_3  || 0 },
        { label: '4 flts',    count: r.flts4    || 0 },
        { label: '5-7 flts',  count: r.flts5_7  || 0 },
        { label: '8 flts',    count: r.flts8    || 0 },
        { label: '9-12 flts', count: r.flts9_12 || 0 },
        { label: '13+ flts',  count: r.flts13p  || 0 },
        { label: 'EL/RF/OC',  count: r.elim     || 0 },
      ],
    };
  }

  if (scheme === 'speed') {
    const r = await db.prepare(`
      SELECT
        SUM(CASE WHEN r.jump_faults = 0 AND r.status IS NULL THEN 1 ELSE 0 END) AS clean,
        SUM(CASE WHEN r.jump_faults BETWEEN 1 AND 4          THEN 1 ELSE 0 END) AS one_rail,
        SUM(CASE WHEN r.jump_faults BETWEEN 5 AND 8          THEN 1 ELSE 0 END) AS two_rails,
        SUM(CASE WHEN r.jump_faults >= 9                     THEN 1 ELSE 0 END) AS three_plus,
        SUM(CASE WHEN r.status IN ('EL','RF','DNF','OC')     THEN 1 ELSE 0 END) AS elim
      FROM entry_jumper_rounds r
      JOIN entries e ON e.id = r.entry_id
      WHERE e.class_id = ? AND r.round = ?
        AND (r.status IS NULL OR r.status NOT IN ('DNS','WD','SC'))
    `).bind(classDbId, round).first();
    return {
      scheme: 'speed',
      buckets: [
        { label: 'Clean',       count: r.clean      || 0 },
        { label: '1 rail (4)',  count: r.one_rail   || 0 },
        { label: '2 rails (8)', count: r.two_rails  || 0 },
        { label: '3+ rails',    count: r.three_plus || 0 },
        { label: 'EL/RF/OC',    count: r.elim       || 0 },
      ],
    };
  }

  if (scheme === 'optimum') {
    if (!r1TimeAllowed || r1TimeAllowed <= 4) return null;
    const optimum = r1TimeAllowed - 4;
    const r = await db.prepare(`
      SELECT
        SUM(CASE WHEN r.status IS NULL AND ABS(r.total_time - ?) <= 1                                         THEN 1 ELSE 0 END) AS d0_1,
        SUM(CASE WHEN r.status IS NULL AND ABS(r.total_time - ?) >  1 AND ABS(r.total_time - ?) <= 3          THEN 1 ELSE 0 END) AS d1_3,
        SUM(CASE WHEN r.status IS NULL AND ABS(r.total_time - ?) >  3 AND ABS(r.total_time - ?) <= 5          THEN 1 ELSE 0 END) AS d3_5,
        SUM(CASE WHEN r.status IS NULL AND ABS(r.total_time - ?) >  5                                         THEN 1 ELSE 0 END) AS d5p,
        SUM(CASE WHEN r.status IN ('EL','RF','DNF','OC')                                                       THEN 1 ELSE 0 END) AS elim
      FROM entry_jumper_rounds r
      JOIN entries e ON e.id = r.entry_id
      WHERE e.class_id = ? AND r.round = ?
        AND (r.status IS NULL OR r.status NOT IN ('DNS','WD','SC'))
    `).bind(optimum, optimum, optimum, optimum, optimum, optimum, classDbId, round).first();
    return {
      scheme: 'optimum',
      buckets: [
        { label: '0-1s off', count: r.d0_1 || 0 },
        { label: '1-3s off', count: r.d1_3 || 0 },
        { label: '3-5s off', count: r.d3_5 || 0 },
        { label: '5+s off',  count: r.d5p  || 0 },
        { label: 'EL/RF/OC', count: r.elim || 0 },
      ],
    };
  }

  return null;
}

async function activateShow(env, slug) {
  try {
    // Pending → Active on first heartbeat (never touches complete)
    const result = await env.WEST_DB.prepare(`
      UPDATE shows SET status = 'active', updated_at = datetime('now')
      WHERE slug = ? AND status = 'pending'
    `).bind(slug).run();
    if (result.meta.changes > 0) {
      console.log(`[activateShow] ${slug} — pending → active (first heartbeat)`);
    }
    await autoCompleteShow(env, slug);
    await autoCompleteStaleClasses(env, slug);
  } catch(e) {
    console.error(`[activateShow ERROR] ${e.message}`);
  }
}

// ── OVERLAY UDP FINISH STATUS ON LIVE ENTRY ──────────────────────────────────
// When a UDP FINISH event carries a non-time status (WD/RT/EL/…), Ryegate
// doesn't always write the text status into the .cls file (cols[82]/[83]).
// This overlay injects the status into the matching entry's
// r{round}StatusCode on both the classData live KV and the computed KV so
// the standings row renders the status label (e.g. "JO WD").
async function overlayFinishStatus(env, slug, ring, entryNum, round, statusCode) {
  try {
    const selRaw = await env.WEST_LIVE.get(`selected:${slug}:${ring}`);
    if (!selRaw) return;
    const sel = JSON.parse(selRaw);
    const classNum = String(sel.classNum || '');
    if (!classNum) return;
    const liveKey = `live:${slug}:${ring}:${classNum}`;
    const resultsKey = `results:${slug}:${ring}:${classNum}`;
    const roundStatusKey = `r${round}StatusCode`;
    const [liveRaw, resultsRaw] = await Promise.all([
      env.WEST_LIVE.get(liveKey), env.WEST_LIVE.get(resultsKey),
    ]);
    const writes = [];
    if (liveRaw) {
      const cd = JSON.parse(liveRaw);
      if (cd && cd.entries) {
        const e = cd.entries.find(x => String(x.entryNum) === entryNum);
        if (e && e[roundStatusKey] !== statusCode) {
          e[roundStatusKey] = statusCode;
          e.statusCode = statusCode;
          e.hasGone = true;
          writes.push(env.WEST_LIVE.put(liveKey, JSON.stringify(cd), { expirationTtl: 7200 }));
        }
      }
    }
    if (resultsRaw) {
      const comp = JSON.parse(resultsRaw);
      if (comp && comp.entries) {
        const e = comp.entries.find(x => String(x.entry_num) === entryNum);
        if (e && e[roundStatusKey] !== statusCode) {
          e[roundStatusKey] = statusCode;
          e.statusCode = statusCode;
          writes.push(env.WEST_LIVE.put(resultsKey, JSON.stringify(comp), { expirationTtl: 7200 }));
        }
      }
    }
    if (writes.length) {
      await Promise.all(writes);
      console.log(`[overlayFinishStatus] ${slug}:${ring} cls ${classNum} #${entryNum} r${round}=${statusCode}`);
    }
    // Persist to D1 so the status survives KV expiry (historical view).
    try {
      const classRow = await env.WEST_DB.prepare(
        'SELECT c.id FROM classes c JOIN shows s ON c.show_id = s.id WHERE s.slug = ? AND c.class_num = ? AND c.ring = ?'
      ).bind(slug, classNum, ring).first();
      if (classRow && classRow.id) {
        const entryRow = await env.WEST_DB.prepare(
          'SELECT id FROM entries WHERE class_id = ? AND entry_num = ?'
        ).bind(classRow.id, entryNum).first();
        if (entryRow && entryRow.id) {
          const now = new Date().toISOString().replace('T', ' ').split('.')[0];
          await upsertResult(env, entryRow.id, classRow.id, round,
            '', '0', '0', '', '', statusCode, now);
          console.log(`[overlayFinishStatus D1] cls ${classNum} #${entryNum} r${round}=${statusCode}`);
        }
      }
    } catch(d1e) {
      console.error(`[overlayFinishStatus D1 ERROR] ${d1e.message}`);
    }
  } catch(e) {
    console.error(`[overlayFinishStatus ERROR] ${e.message}`);
  }
}

// ── AUTO-COMPLETE SHOW AFTER END DATE ─────────────────────────────────────────
// If end_date has passed and show is still active, auto-flip to complete
async function autoCompleteShow(env, slug) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const result = await env.WEST_DB.prepare(`
      UPDATE shows SET status = 'complete', updated_at = datetime('now')
      WHERE slug = ? AND status = 'active' AND end_date IS NOT NULL AND end_date < ?
    `).bind(slug, today).run();
    if (result.meta.changes > 0) {
      console.log(`[autoCompleteShow] ${slug} — end_date passed, auto-completed`);
    }
  } catch(e) {
    console.error(`[autoCompleteShow ERROR] ${e.message}`);
  }
}

// ── AUTO-COMPLETE STALE CLASSES ──────────────────────────────────────────────
// Classes not updated in 15 min get marked complete (unless show is locked).
// Safe because any .cls write or Ctrl+A reopens the class immediately.
async function autoCompleteStaleClasses(env, slug) {
  try {
    const result = await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'complete', updated_at = datetime('now')
      WHERE show_id = (SELECT id FROM shows WHERE slug = ? AND status != 'complete')
        AND status = 'active'
        AND updated_at < datetime('now', '-60 minutes')
    `).bind(slug).run();
    if (result.meta.changes > 0) {
      console.log(`[autoComplete] ${slug} — ${result.meta.changes} class(es) auto-completed`);
    }
  } catch(e) {
    console.error(`[autoComplete ERROR] ${e.message}`);
  }
}

// ── REOPEN CLASS IF COMPLETE ─────────────────────────────────────────────────
// Called on CLASS_SELECTED — flips class back to active unless show is locked
async function reopenClassIfComplete(env, slug, ring, classNum) {
  try {
    await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'active', updated_at = datetime('now')
      WHERE show_id = (SELECT id FROM shows WHERE slug = ? AND status != 'complete')
        AND ring = ? AND class_num = ? AND status = 'complete'
    `).bind(slug, ring, classNum).run();
  } catch(e) {
    console.error(`[reopenClass ERROR] ${e.message}`);
  }
}

// ── RECORD FIRST HORSE ───────────────────────────────────────────────────────
// Sets first_horse_at on ring_activity — only if not already set for today
async function recordFirstHorse(env, slug, ring) {
  try {
    const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
    if (!show) return;
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    const today = now.split(' ')[0];
    // Only set if first_horse_at is null for today — never overwrite
    await env.WEST_DB.prepare(`
      UPDATE ring_activity SET first_horse_at = ?
      WHERE show_id = ? AND ring = ? AND date = ? AND first_horse_at IS NULL
    `).bind(now, show.id, ring, today).run();
  } catch(e) {
    console.error(`[recordFirstHorse ERROR] ${e.message}`);
  }
}

// ── CHECK SHOW LOCKED ────────────────────────────────────────────────────────
async function isShowLocked(env, slug) {
  try {
    const show = await env.WEST_DB.prepare(
      'SELECT status FROM shows WHERE slug = ?'
    ).bind(slug).first();
    return show && show.status === 'complete';
  } catch(e) { return false; }
}

// ── MARK CLASS COMPLETE ───────────────────────────────────────────────────────
// Called from /postClassEvent when CLASS_COMPLETE fires
async function markClassComplete(env, slug, ring, classNum, className) {
  try {
    const show = await env.WEST_DB.prepare(
      'SELECT id FROM shows WHERE slug = ?'
    ).bind(slug).first();
    if (!show) return;
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Freeze pre-computed results into D1 — permanent record
    const resultsKey = `results:${slug}:${ring}:${classNum}`;
    const kvResults = await env.WEST_LIVE.get(resultsKey);
    const finalResults = kvResults || null;

    await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'complete', updated_at = ?, final_results = ?
      WHERE show_id = ? AND ring = ? AND class_num = ?
    `).bind(now, finalResults, show.id, ring, classNum).run();
    console.log(`[markClassComplete] ${slug}:${ring} class ${classNum} — ${className}${finalResults ? ' [results frozen]' : ''}`);
  } catch(e) {
    console.error(`[markClassComplete ERROR] ${e.message}`);
  }
}

// ── D1 WRITE ──────────────────────────────────────────────────────────────────
// Called via ctx.waitUntil — runs after response is sent, never slows watcher
async function writeToD1(env, body, slug, ring) {
  try {
    const year = new Date().getFullYear();
    const now  = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Look up show — must be created in admin first, watcher does not create shows
    const show = await env.WEST_DB.prepare(
      'SELECT id, status FROM shows WHERE slug = ?'
    ).bind(slug).first();
    if (!show) {
      console.log(`[D1] Show ${slug} not found — create it in admin first`);
      return;
    }
    // Update timestamp
    await env.WEST_DB.prepare(
      'UPDATE shows SET updated_at = ? WHERE id = ?'
    ).bind(now, show.id).run();

    // Upsert ring
    await env.WEST_DB.prepare(`
      INSERT INTO rings (show_id, ring_num, status) VALUES (?, ?, 'active')
      ON CONFLICT(show_id, ring_num) DO UPDATE SET status = 'active'
    `).bind(show.id, ring).run();

    // Track ring activity — first and last post per day
    const today = now.split(' ')[0]; // YYYY-MM-DD
    await env.WEST_DB.prepare(`
      INSERT INTO ring_activity (show_id, ring, date, first_post_at, last_post_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(show_id, ring, date) DO UPDATE SET last_post_at = excluded.last_post_at
    `).bind(show.id, ring, today, now, now).run();

    // Upsert class
    const classNum = (body.filename || '').replace('.cls', '');
    if (!classNum) return;

    await env.WEST_DB.prepare(`
      INSERT INTO classes (show_id, ring, class_num, class_name, class_type,
                           scoring_method, is_fei, show_flags, clock_precision, cls_raw, sponsor, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(show_id, ring, class_num) DO UPDATE SET
        class_name      = excluded.class_name,
        class_type      = excluded.class_type,
        scoring_method  = excluded.scoring_method,
        is_fei          = excluded.is_fei,
        show_flags      = excluded.show_flags,
        clock_precision = excluded.clock_precision,
        cls_raw         = excluded.cls_raw,
        sponsor         = excluded.sponsor,
        status          = CASE WHEN classes.cls_raw = excluded.cls_raw THEN classes.status ELSE 'active' END,
        updated_at      = CASE WHEN classes.cls_raw = excluded.cls_raw THEN classes.updated_at ELSE excluded.updated_at END
    `).bind(
      show.id, ring, classNum,
      body.className      || '',
      body.classType      || '',
      body.scoringMethod  || '',
      body.isFEI ? 1 : 0,
      body.showFlags ? 1 : 0,
      parseInt(body.clockPrecision) || 2,
      body.clsRaw         || '',
      body.sponsor        || '',
      now, now
    ).run();

    const cls = await env.WEST_DB.prepare(
      'SELECT id FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
    ).bind(show.id, ring, classNum).first();
    if (!cls) return;

    const isJumper = body.classType === 'J' || body.classType === 'T';

    for (const e of (body.entries || [])) {
      if (!e.hasGone) continue;

      // Upsert entry
      await env.WEST_DB.prepare(`
        INSERT INTO entries (class_id, entry_num, horse, rider, owner, country, sire, dam, city, state, horse_fei, rider_fei, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(class_id, entry_num) DO UPDATE SET
          horse = excluded.horse,
          rider = excluded.rider,
          owner = excluded.owner,
          country = excluded.country,
          sire = excluded.sire,
          dam = excluded.dam,
          city = excluded.city,
          state = excluded.state,
          horse_fei = excluded.horse_fei,
          rider_fei = excluded.rider_fei
      `).bind(cls.id, e.entryNum, e.horse || '', e.rider || '', e.owner || '',
        e.country || '', e.sire || '', e.dam || '', e.city || '', e.state || '',
        e.horseFEI || '', e.riderFEI || '', now).run();

      const entry = await env.WEST_DB.prepare(
        'SELECT id FROM entries WHERE class_id = ? AND entry_num = ?'
      ).bind(cls.id, e.entryNum).first();
      if (!entry) continue;

      // ── JUMPER results ────────────────────────────────────────────────────
      // Watcher field names confirmed 2026-03-22 from live class 221.
      // Also write status-only rows (e.g. WD in JO) so declined rounds
      // persist to D1 where Ryegate would normally have recorded them.
      if (isJumper && (e.r1TotalTime || e.r1StatusCode)) {
        await upsertResult(env, entry.id, cls.id, 1,
          e.r1TotalTime, e.r1JumpFaults, e.r1TimeFaults,
          e.r1TotalFaults, e.overallPlace, e.r1StatusCode || e.statusCode, now);
      }
      if (isJumper && (e.r2TotalTime || e.r2StatusCode)) {
        await upsertResult(env, entry.id, cls.id, 2,
          e.r2TotalTime, e.r2JumpFaults, e.r2TimeFaults,
          e.r2TotalFaults, e.overallPlace, e.r2StatusCode || e.statusCode, now);
      }
      if (isJumper && (e.r3TotalTime || e.r3StatusCode)) {
        await upsertResult(env, entry.id, cls.id, 3,
          e.r3TotalTime, e.r3JumpFaults, e.r3TimeFaults,
          e.r3TotalFaults, e.overallPlace, e.r3StatusCode || e.statusCode, now);
      }

      // ── HUNTER result ─────────────────────────────────────────────────────
      if (!isJumper && e.hasGone) {
        const score  = e.score    || '';
        const total  = e.combined || e.r1Total || e.score || '';
        const place  = e.place    || '';
        const status = e.statusCode || '';
        await env.WEST_DB.prepare(`
          INSERT INTO results (entry_id, class_id, round, time, total, place,
                               status_code, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entry_id, round) DO UPDATE SET
            time        = excluded.time,
            total       = excluded.total,
            place       = excluded.place,
            status_code = excluded.status_code,
            updated_at  = excluded.updated_at
        `).bind(entry.id, cls.id, score, total, place, status, now, now).run();
      }
    }

    console.log(`[D1] Written: ${slug}:${ring} class ${classNum} (${body.classType})`);
  } catch(e) {
    console.error(`[D1 ERROR] ${e.message}`);
  }
}

// ── UPSERT RESULT ─────────────────────────────────────────────────────────────
async function upsertResult(env, entryId, classId, round,
  time, jumpFaults, timeFaults, total, place, statusCode, now) {
  await env.WEST_DB.prepare(`
    INSERT INTO results (entry_id, class_id, round, time, jump_faults, time_faults,
                         total, place, status_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id, round) DO UPDATE SET
      time        = excluded.time,
      jump_faults = excluded.jump_faults,
      time_faults = excluded.time_faults,
      total       = excluded.total,
      place       = excluded.place,
      status_code = excluded.status_code,
      updated_at  = excluded.updated_at
  `).bind(
    entryId, classId, round,
    time        || '',
    jumpFaults  || '0',
    timeFaults  || '0',
    total       || '',
    place       || '',
    statusCode  || '',
    now, now
  ).run();
}

// ── WRITE SCHEDULE ───────────────────────────────────────────────────────────
// Updates classes with scheduled_date, schedule_order, schedule_flag from tsked data
async function writeSchedule(env, slug, ring, schedClasses) {
  try {
    const show = await env.WEST_DB.prepare(
      'SELECT id FROM shows WHERE slug = ?'
    ).bind(slug).first();
    if (!show) return;

    for (const sc of schedClasses) {
      await env.WEST_DB.prepare(`
        UPDATE classes
        SET scheduled_date = ?, schedule_order = ?, schedule_flag = ?,
            updated_at = datetime('now')
        WHERE show_id = ? AND ring = ? AND class_num = ?
      `).bind(
        sc.date || null,
        sc.order != null ? sc.order : null,
        sc.flag || null,
        show.id, ring, sc.classNum
      ).run();
    }
    console.log(`[writeSchedule] ${slug}:${ring} — ${schedClasses.length} classes updated`);

    // Auto-recompute classes with JO flag — if the class has live KV data,
    // re-run computeClassResults so the OOG populates immediately when the
    // operator sets the JO flag in tsked. Without this, the OOG wouldn't
    // show until the next .cls write.
    const joClasses = schedClasses.filter(sc => (sc.flag || '').toUpperCase() === 'JO');
    for (const sc of joClasses) {
      try {
        const liveKey = `live:${slug}:${ring}:${sc.classNum}`;
        const raw = await env.WEST_LIVE.get(liveKey);
        if (raw) {
          const body = JSON.parse(raw);
          const computed = computeClassResults(body);
          if (computed.orderOfGo && computed.orderOfGo.length) {
            const resultsKey = `results:${slug}:${ring}:${sc.classNum}`;
            await env.WEST_LIVE.put(resultsKey, JSON.stringify(computed), { expirationTtl: 7200 });
            console.log(`[writeSchedule] recomputed class ${sc.classNum} — OOG ${computed.orderOfGo.length} entries`);
          }
        }
      } catch (e) { /* best-effort recompute */ }
    }
  } catch(e) {
    console.error(`[writeSchedule ERROR] ${e.message}`);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
// ── PRE-SHOW STATS — cross-class data for OOG entries ────────────────────────
// For each horse in the order of go, query D1 for their results across all
// other classes at this show. Returns per-entry stats + class-level summary.
async function buildPreShowStats(env, slug, orderOfGo) {
  const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
  if (!show) return null;

  // Get all horses from the OOG
  const horses = orderOfGo.map(e => e.horse).filter(Boolean);
  if (!horses.length) return null;

  // Query all results for these horses at this show
  // Using LIKE matching since horse names should be exact in the same show
  const placeholders = horses.map(() => '?').join(',');
  const results = await env.WEST_DB.prepare(`
    SELECT e.horse, e.rider, e.entry_num, e.country, e.sire, e.dam, e.city, e.state,
           c.class_num, c.class_name, c.class_type, c.scoring_method,
           r.round, r.time, r.jump_faults, r.time_faults, r.total, r.place, r.status_code
    FROM entries e
    JOIN classes c ON c.id = e.class_id
    LEFT JOIN results r ON r.entry_id = e.id
    WHERE c.show_id = ? AND e.horse IN (${placeholders}) AND c.class_type IN ('J','T')
    ORDER BY e.horse, c.class_num, r.round
  `).bind(show.id, ...horses).all();

  // Get prize money per class — parse @money from cls_raw
  const allClassNums = [...new Set((results.results || []).map(r => r.class_num))];
  const classPrizes = {};
  if (allClassNums.length) {
    const cp = allClassNums.map(() => '?').join(',');
    const clsRows = await env.WEST_DB.prepare(
      `SELECT class_num, cls_raw FROM classes WHERE show_id = ? AND class_num IN (${cp})`
    ).bind(show.id, ...allClassNums).all();
    (clsRows.results || []).forEach(row => {
      if (!row.cls_raw) return;
      const moneyLine = row.cls_raw.split(/\r?\n/).find(l => l.startsWith('@money'));
      if (moneyLine) {
        classPrizes[row.class_num] = moneyLine.split(',').slice(1).map(Number);
      }
    });
  }

  // Group by horse
  const byHorse = {};
  (results.results || []).forEach(row => {
    if (!byHorse[row.horse]) {
      byHorse[row.horse] = {
        horse: row.horse, rider: row.rider, entry_num: row.entry_num,
        country: row.country, sire: row.sire, dam: row.dam,
        city: row.city, state: row.state,
        classes: {},
      };
    }
    const h = byHorse[row.horse];
    if (!h.classes[row.class_num]) {
      h.classes[row.class_num] = {
        class_num: row.class_num, class_name: row.class_name,
        class_type: row.class_type, scoring_method: row.scoring_method,
        rounds: [],
      };
    }
    if (row.round) {
      h.classes[row.class_num].rounds.push({
        round: row.round, time: row.time, jump_faults: row.jump_faults,
        time_faults: row.time_faults, total: row.total,
        place: row.place, status_code: row.status_code,
      });
    }
  });

  // Build per-horse summary
  const entryStats = orderOfGo.map(oogEntry => {
    const h = byHorse[oogEntry.horse];
    if (!h) return { ...oogEntry, classCount: 0, clearRounds: 0, totalRounds: 0, clearPct: 0, results: [], breeding: '' };

    const classList = Object.values(h.classes);
    let clearRounds = 0, totalRounds = 0;
    const classResults = classList.map(cl => {
      const r1 = cl.rounds.find(r => r.round === 1);
      if (r1 && r1.total !== null) {
        totalRounds++;
        if (parseFloat(r1.total) === 0) clearRounds++;
      }
      const p = r1 && r1.place ? parseInt(r1.place) : 0;
      const cPrizes = classPrizes[cl.class_num] || [];
      const prize = (p > 0 && p <= cPrizes.length) ? cPrizes[p - 1] : 0;
      return {
        class_num: cl.class_num, class_name: cl.class_name, class_type: cl.class_type,
        place: r1 ? r1.place : null,
        faults: r1 ? r1.total : null,
        time: r1 ? r1.time : null,
        status: r1 ? r1.status_code : null,
        prize: prize,
      };
    });

    // Sort by best place (lowest first), take top 3
    const bestResults = classResults
      .filter(cr => !cr.status && cr.place)
      .sort((a, b) => (parseInt(a.place) || 999) - (parseInt(b.place) || 999))
      .slice(0, 3);

    // Total prize money won at the show
    const totalPrize = classResults.reduce((sum, cr) => sum + (cr.prize || 0), 0);

    const breeding = [h.sire, h.dam].filter(Boolean).join(' x ');
    return {
      ...oogEntry,
      breeding: breeding,
      city: h.city || oogEntry.city, state: h.state || oogEntry.state,
      classCount: classList.length,
      clearRounds: clearRounds,
      totalRounds: totalRounds,
      clearPct: totalRounds > 0 ? Math.round(clearRounds / totalRounds * 1000) / 10 : 0,
      totalPrize: totalPrize,
      results: bestResults,
    };
  });

  // Class-level summary
  const countries = {};
  orderOfGo.forEach(e => { if (e.country) countries[e.country] = (countries[e.country] || 0) + 1; });
  const uniqueRiders = new Set(orderOfGo.map(e => e.rider)).size;

  return {
    entryCount: orderOfGo.length,
    uniqueRiders: uniqueRiders,
    countries: Object.entries(countries).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    countryCount: Object.keys(countries).length,
    entries: entryStats,
  };
}

function extractSlugRing(body, url) {
  let slug = url.searchParams.get('slug');
  let ring = url.searchParams.get('ring');
  if (!slug) slug = body.slug || null;
  if (!ring) ring = body.ring || '1';
  return { slug, ring };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE COMPUTATION — pre-compute results from watcher data
// Runs once in the Worker on every postClassData. Pages receive the finished
// result object and just render — no parsing, no ranking, no cls_raw needed.
//
// The .cls file is the source of truth. Ryegate scores and places. We only:
//   1. Parse — structure raw columns into clean fields
//   2. Rank per-judge — the ONE thing Ryegate doesn't give us (derby only)
//   3. Aggregate — fault buckets, averages, leaderboard (jumper stats)
//   4. Package — one JSON object, ready to render
// ═══════════════════════════════════════════════════════════════════════════════

// ── CLS PARSING (ported from display-config.js) ─────────────────────────────

function parseClsHeader(clsRaw) {
  if (!clsRaw) return [];
  const line = clsRaw.split(/\r?\n/)[0] || '';
  const r = []; let c = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { r.push(c.trim()); c = ''; }
    else c += ch;
  }
  r.push(c.trim());
  return r;
}

function parseClsRows(clsRaw) {
  if (!clsRaw) return [];
  const lines = clsRaw.split(/\r?\n/);
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line || line.charAt(0) === '@') continue;
    const r = []; let c = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { r.push(c); c = ''; }
      else c += ch;
    }
    r.push(c);
    if (r[0] && /^\d/.test(r[0])) rows.push(r);
  }
  return rows;
}

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── HUNTER HEADER INTERPRETATION ────────────────────────────────────────────
// H[2]=ClassMode (0=OverFences, 1=Flat, 2=Derby, 3=Special)
// H[5]=ScoringType (0=Forced, 1=Scored, 2=HiLo)
// H[7]=NumJudges
// H[10]=IsEquitation, H[11]=IsChampionship
// H[37]=DerbyType (only when H[2]=2)

const DERBY_TYPES = {
  '0': { label: 'International',       judges: 2 },
  '1': { label: 'National',            judges: 1 },
  '2': { label: 'National H&G',        judges: 1 },
  '3': { label: 'International H&G',   judges: 2 },
  '4': { label: 'USHJA Pony Derby',    judges: 1 },
  '5': { label: 'USHJA Pony Derby H&G',judges: 1 },
  '6': { label: 'USHJA 2\'6 Jr Derby', judges: 1 },
  '7': { label: 'USHJA 2\'6 Jr Derby H&G', judges: 1 },
  '8': { label: 'WCHR Derby Spec',     judges: 1 },
};

function getHunterClassInfo(h) {
  const classMode = h[2] || '0';
  const isDerby = classMode === '2';
  const isFlat = classMode === '1';
  const isSpecial = classMode === '3';
  const isEquitation = h[10] === 'True';
  const isChampionship = h[11] === 'True';
  const scoringType = h[5] || '0'; // 0=forced, 1=scored, 2=hilo
  const scoreMethod = h[6] || '0'; // 0=total, 1=average
  let judgeCount = parseInt(h[7]) || 1;
  if (isDerby) {
    const dt = DERBY_TYPES[String(h[37] || '0')];
    judgeCount = dt ? dt.judges : 1;
  }
  let label = 'Hunter';
  if (isDerby) {
    const dt = DERBY_TYPES[String(h[37] || '0')];
    label = dt ? dt.label : 'Hunter Derby';
  } else if (isSpecial) label = 'Hunter Special';
  else if (isFlat) label = 'Hunter Flat';
  else if (isEquitation) label = 'Equitation';
  else if (isChampionship) label = 'Hunter Championship';

  // H[3] = NumRounds (1, 2, or 3). Ryegate max is 3.
  let numRounds = parseInt(h[3]) || 1;
  if (numRounds < 1) numRounds = 1;
  if (numRounds > 3) numRounds = 3;

  // H[4] = CurrentRound — which round tab the operator currently has selected
  // in Ryegate. 1/2/3 map to R1/R2/R3. Values > numRounds (e.g. 4 in a 3-round
  // class) mean the operator is on the "Overall" view; emit null in that case.
  let currentRound = parseInt(h[4]) || 0;
  if (currentRound < 1 || currentRound > numRounds) currentRound = null;

  // H[25]/H[26]/H[27] = phase labels. Custom labels are ONLY available on
  // Special classes in Ryegate — all other class types force "Phase 1"/"Phase 2"/
  // "Phase 3" defaults which we render as "R1"/"R2"/"R3". So we only emit
  // roundLabels when isSpecial is true; renderers fall back to R1/R2/R3 otherwise.
  const roundLabels = isSpecial
    ? [h[25] || 'R1', h[26] || 'R2', h[27] || 'R3']
    : null;

  return { classMode, isDerby, isFlat, isSpecial, isEquitation, isChampionship,
           scoringType, scoreMethod, judgeCount, numRounds, currentRound,
           roundLabels, label };
}

// ── HUNTER DERBY: PARSE PER-JUDGE FROM CLS ROW ──────────────────────────────
// Column map (confirmed 2026-04-05):
//   R1:  [15]=hiOpt  [16]=J1base  [17]=hiOpt(mirror)  [18]=J2base
//   R2:  [24]=hiOpt  [25]=J1base  [26]=J1bonus  [27]=hiOpt(mirror)  [28]=J2base  [29]=J2bonus
//   [42]=R1total  [43]=R2total  [14]=place
//   [46]/[47]=R1/R2 numeric status  [52]/[53]=R1/R2 text status

function parseDerbyEntry(cols, judgeCount) {
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const r1 = [], r2 = [];
  const r1HiOpt = num(cols[15]), r2HiOpt = num(cols[24]);

  const j1r1b = num(cols[16]), j1r2b = num(cols[25]), j1r2bonus = num(cols[26]);
  r1.push({ base: j1r1b, hiopt: r1HiOpt, bonus: 0, phaseTotal: j1r1b + r1HiOpt });
  r2.push({ base: j1r2b, hiopt: r2HiOpt, bonus: j1r2bonus, phaseTotal: j1r2b + r2HiOpt + j1r2bonus });

  if (judgeCount >= 2) {
    const j2r1b = num(cols[18]), j2r2b = num(cols[28]), j2r2bonus = num(cols[29]);
    r1.push({ base: j2r1b, hiopt: r1HiOpt, bonus: 0, phaseTotal: j2r1b + r1HiOpt });
    r2.push({ base: j2r2b, hiopt: r2HiOpt, bonus: j2r2bonus, phaseTotal: j2r2b + r2HiOpt + j2r2bonus });
  }

  return {
    entry_num: cols[0] || '', horse: cols[1] || '', rider: cols[2] || '',
    country: cols[4] || '', owner: cols[5] || '', sire: cols[6] || '', dam: cols[7] || '',
    city: cols[8] || '', state: cols[9] || '',
    place: (cols[14] && cols[14] !== '0') ? cols[14] : '',
    r1, r2,
    r1Total: num(cols[42]), r2Total: num(cols[43]),
    combined: num(cols[42]) + num(cols[43]),
    r1NumericStatus: cols[46] || '', r2NumericStatus: cols[47] || '',
    r1TextStatus: cols[52] || '', r2TextStatus: cols[53] || '',
  };
}

// ── RANKING ENGINE ──────────────────────────────────────────────────────────
// Standard competition ranking (1,1,3). Ties share rank, next rank is skipped.

function assignRanks(items) {
  items.sort((a, b) => b.val - a.val);
  const ranks = {};
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && items[i].val === items[i - 1].val) {
      ranks[items[i].key] = ranks[items[i - 1].key];
    } else {
      ranks[items[i].key] = i + 1;
    }
  }
  return ranks;
}

function hasR1(e) {
  if (e.r1TextStatus) return false;
  return e.r1 && e.r1.some(p => p.phaseTotal > 0);
}
function hasR2(e) {
  if (e.r2TextStatus) return false;
  return e.r2 && e.r2.some(p => p.phaseTotal > 0);
}
function hasR3(e) {
  if (e.r3TextStatus) return false;
  return e.r3 && e.r3.some(p => p.phaseTotal > 0);
}

function computeDerbyRankings(entries, judgeCount) {
  entries.forEach(e => {
    e.r1Ranks = []; e.r2Ranks = []; e.r3Ranks = [];
    e.judgeCardTotals = []; e.judgeCardRanks = [];
    e.r1OverallRank = null; e.r2OverallRank = null; e.r3OverallRank = null;
    e.movement = null; e.combinedRank = null;
  });

  // Per-judge per-round ranks
  for (let j = 0; j < judgeCount; j++) {
    let items = entries.filter(hasR1).map(e => ({ key: e.entry_num, val: e.r1[j].phaseTotal }));
    let ranks = assignRanks(items);
    entries.forEach(e => { e.r1Ranks[j] = ranks[e.entry_num] || null; });

    items = entries.filter(hasR2).map(e => ({ key: e.entry_num, val: e.r2[j].phaseTotal }));
    ranks = assignRanks(items);
    entries.forEach(e => { e.r2Ranks[j] = ranks[e.entry_num] || null; });

    items = entries.filter(hasR3).map(e => ({ key: e.entry_num, val: e.r3[j].phaseTotal }));
    ranks = assignRanks(items);
    entries.forEach(e => { e.r3Ranks[j] = ranks[e.entry_num] || null; });
  }

  // Judge card totals + ranks.
  // Per hunter rule "earlier rounds always hold" — if a later round is EL/RT/WD
  // the entry still keeps prior-round scores and competes for ribbons. So sum
  // whichever rounds are actually done. Null only when R1 never happened
  // (R1 elimination kills the entire card — earlier rounds don't exist).
  for (let j = 0; j < judgeCount; j++) {
    entries.forEach(e => {
      if (!hasR1(e)) { e.judgeCardTotals[j] = null; return; }
      let t = e.r1[j].phaseTotal;
      if (hasR2(e)) t += e.r2[j].phaseTotal;
      if (hasR3(e)) t += e.r3[j].phaseTotal;
      e.judgeCardTotals[j] = t;
    });
    const items = entries.filter(e => e.judgeCardTotals[j] !== null)
      .map(e => ({ key: e.entry_num, val: e.judgeCardTotals[j] }));
    const ranks = assignRanks(items);
    entries.forEach(e => { e.judgeCardRanks[j] = ranks[e.entry_num] || null; });
  }

  // R1/R2/R3 overall ranks (aggregate across judges)
  let r1Items = entries.filter(hasR1).map(e => {
    let sum = 0; for (let j = 0; j < judgeCount; j++) sum += e.r1[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  const r1Ranks = assignRanks(r1Items);

  let r2Items = entries.filter(hasR2).map(e => {
    let sum = 0; for (let j = 0; j < judgeCount; j++) sum += e.r2[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  const r2Ranks = assignRanks(r2Items);

  let r3Items = entries.filter(hasR3).map(e => {
    let sum = 0; for (let j = 0; j < judgeCount; j++) sum += e.r3[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  const r3Ranks = assignRanks(r3Items);

  entries.forEach(e => {
    e.r1OverallRank = r1Ranks[e.entry_num] || null;
    e.r2OverallRank = r2Ranks[e.entry_num] || null;
    e.r3OverallRank = r3Ranks[e.entry_num] || null;
    e.combinedRank = parseInt(e.place) || null;
    if (e.r1OverallRank && e.combinedRank && hasR2(e)) {
      e.movement = e.r1OverallRank - e.combinedRank;
    }
  });

  return entries;
}

// Split decision check — judges disagree on the placed top 3 entries.
// Compare each judge's top-N (by card total) against the overall placed
// top-N where N = min(3, number of entries the operator has actually placed).
// This avoids false positives mid-class when only some entries have been placed.
function isSplitDecision(entries, judgeCount) {
  if (judgeCount < 2) return false;

  // Overall placed entries, in place order
  const placed = entries
    .filter(e => parseInt(e.place) > 0)
    .sort((a, b) => parseInt(a.place) - parseInt(b.place));
  if (placed.length < 2) return false; // Need at least 2 placings to compare

  // Compare against top-N where N = min(3, placed.length). If the operator
  // has only placed 2, we compare top-2 — splits over the 3rd spot can't
  // be flagged until that 3rd ribbon exists.
  const N = Math.min(3, placed.length);
  const overallTopN = placed.slice(0, N).map(e => e.entry_num).sort().join(',');

  for (let j = 0; j < judgeCount; j++) {
    const sorted = entries
      .filter(e => e.judgeCardTotals && e.judgeCardTotals[j] != null && e.judgeCardTotals[j] > 0)
      .slice()
      .sort((a, b) => {
        const diff = (b.judgeCardTotals[j] || 0) - (a.judgeCardTotals[j] || 0);
        if (diff !== 0) return diff;
        // Tie-break by overall place to match final standings
        return (parseInt(a.place) || 999) - (parseInt(b.place) || 999);
      });
    const judgeTopN = sorted.slice(0, N).map(e => e.entry_num).sort().join(',');
    if (judgeTopN !== overallTopN) return true;
  }
  return false;
}

// ── COMPUTE CLASS RESULTS ────────────────────────────────────────────────────
// Main entry point. Takes the body from postClassData (parsed .cls + clsRaw).
// Returns a pre-computed results object ready for page rendering.

function computeClassResults(body) {
  const clsRaw = body.clsRaw || '';
  const h = parseClsHeader(clsRaw);
  // Watcher is authoritative on class type — it applies U→T inference from
  // scoring method / UDP hints. Prefer body.classType over raw header when
  // watcher has resolved a non-U type.
  const bodyType = (body.classType || '').toUpperCase();
  const headerType = (h[0] || '').toUpperCase();
  const classType = (bodyType && bodyType !== 'U') ? bodyType : (headerType || 'U');

  // Build Order of Go from ALL entries (regardless of hasGone), sorted by ride order.
  // Farmtek classes often have rideOrder=0 for all entries — fall back to .cls file
  // order (the sequence entries appear in the file IS the ride order).
  const allEntries = body.entries || [];
  const hasRideOrder = allEntries.some(e => parseInt(e.rideOrder) > 0);
  const oog = (hasRideOrder
    ? allEntries.filter(e => parseInt(e.rideOrder) > 0)
    : allEntries
  ).map((e, idx) => ({
      order: hasRideOrder ? (parseInt(e.rideOrder) || 0) : (idx + 1),
      entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
      owner: e.owner || '', country: e.country || '',
      city: e.city || '', state: e.state || '',
    }))
    .sort((a, b) => a.order - b.order);

  // Prize money: array indexed by place (0=1st, 1=2nd, etc.)
  const prizes = (body.prizes && body.prizes.length) ? body.prizes : null;

  const base = {
    classNum: (body.filename || '').replace('.cls', ''),
    className: body.className || h[1] || '',
    classType,
    sponsor: body.sponsor || '',
    trophy: body.trophy || '',
    orderOfGo: oog.length ? oog : null,
    hasRealOrder: hasRideOrder,
    prizes: prizes,
  };

  let result;
  if (classType === 'H') result = computeHunterResults(body, h, base);
  else if (classType === 'J' || classType === 'T') result = computeJumperResults(body, h, base);
  else {
    // Truly unformatted: watcher doesn't populate hasGone (no jumper/hunter
    // parsing runs), so only apply the hasGone filter if at least one entry
    // has it set. Otherwise fall through to showing all entries.
    const allEntries = body.entries || [];
    const anyGone = allEntries.some(e => e.hasGone);
    const filtered = anyGone ? allEntries.filter(e => e.hasGone) : allEntries;
    result = { ...base, label: 'Unformatted', entries: filtered.map(e => ({
      entry_num: e.entryNum, horse: e.horse, rider: e.rider, owner: e.owner,
      place: e.place || '', hasGone: e.hasGone,
    })) };
  }

  // Assign prize money per entry based on place
  if (prizes && result.entries) {
    result.entries.forEach(e => {
      const p = parseInt(e.place);
      if (p > 0 && p <= prizes.length) {
        e.prize = prizes[p - 1]; // prizes[0] = 1st place
      }
    });
  }

  return result;
}

// ── HUNTER RESULTS ──────────────────────────────────────────────────────────

function computeHunterResults(body, h, base) {
  const info = getHunterClassInfo(h);
  const clsRaw = body.clsRaw || '';

  const result = {
    ...base,
    label: info.label,
    isDerby: info.isDerby,
    isFlat: info.isFlat,
    isSpecial: info.isSpecial,
    isEquitation: info.isEquitation,
    isChampionship: info.isChampionship,
    judgeCount: info.judgeCount,
    numRounds: info.numRounds,
    currentRound: info.currentRound,
    roundLabels: info.roundLabels,
    scoringType: info.scoringType,
    scoreMethod: info.scoreMethod,
    classMode: info.classMode,
    clockPrecision: parseInt(h[5]) || 0,
    showFlags: body.showFlags || false,
    isSplitDecision: false,
    entries: [],
  };

  // Numeric status map: 0=none, 1=DNS, 2=EL, 3=RT, 4=WD, 5=RF, 6=OC, 7=MR, 8=HC
  const numStatusMap = {'1':'DNS','2':'EL','3':'RT','4':'WD','5':'RF','6':'OC','7':'MR','8':'HC'};
  // Normalize text + numeric status into one canonical statusCode per round.
  // Used by both derby and non-derby paths (and the renderers downstream).
  const normalizeHunterStatus = (e) => {
    e.r1StatusCode = e.r1TextStatus || numStatusMap[e.r1NumericStatus] || '';
    e.r2StatusCode = e.r2TextStatus || numStatusMap[e.r2NumericStatus] || '';
    e.r3StatusCode = e.r3TextStatus || numStatusMap[e.r3NumericStatus] || '';
    e.statusCode = e.r3StatusCode || e.r2StatusCode || e.r1StatusCode || '';
  };

  if (info.isDerby) {
    // Parse per-judge data from cls rows
    const rows = parseClsRows(clsRaw);
    let entries = rows.map(r => parseDerbyEntry(r, info.judgeCount));
    entries.forEach(normalizeHunterStatus);
    entries = computeDerbyRankings(entries, info.judgeCount);
    result.isSplitDecision = isSplitDecision(entries, info.judgeCount);

    // Per-round competed counts. Same evidence-based rule as the non-derby
    // path: an entry counts as "gone" for a round if it has a real score on
    // that round OR a status code (EL/RT/etc.). Stuck hasGone flags alone
    // don't count. Derbies are 2-round in Ryegate so R3 is always 0 here.
    result.roundCompleted = [0, 0, 0];
    entries.forEach(e => {
      if (hasR1(e) || e.r1StatusCode) result.roundCompleted[0]++;
      if (hasR2(e) || e.r2StatusCode) result.roundCompleted[1]++;
      if (hasR3(e) || e.r3StatusCode) result.roundCompleted[2]++;
    });
    result.roundCompleted = result.roundCompleted.slice(0, info.numRounds);

    // Sort: placed first by place, then by combined desc
    entries.sort((a, b) => {
      const pa = parseInt(a.place) || 999, pb = parseInt(b.place) || 999;
      if (pa !== pb) return pa - pb;
      return (b.combined || 0) - (a.combined || 0);
    });

    result.entries = entries;
  } else if (info.scoringType === '1' || info.scoringType === '2') {
    // Non-derby scored hunter (scored or hi-lo) — watcher sends rN Judges arrays.
    // Build per-judge phase cards and compute rankings (same engine as derby).
    // Column map: R1=col[15+j], R2=col[24+j], R3=col[33+j] (confirmed 2026-04-08
    // for R1+R2 from class 1002, R3 confirmed 2026-04-10 from class 925 Special).
    // Special classes (H[2]=3) reuse this exact layout but support 1-3 rounds.
    const jc = info.judgeCount;
    const numRounds = info.numRounds || 2;
    let entries = (body.entries || []).filter(e => e.hasGone).map(e => {
      // Non-derby: phase cards are just { score, phaseTotal } — no hiopt/bonus fields.
      // The ABSENCE of hiopt/bonus tells the renderer to show score only.
      const buildPhases = (judgesArr) => {
        const arr = (judgesArr || []).map(v => {
          const s = parseFloat(v) || 0;
          return { score: s, phaseTotal: s };
        });
        while (arr.length < jc) arr.push({ score: 0, phaseTotal: 0 });
        return arr;
      };
      const r1 = buildPhases(e.r1Judges);
      const r2 = buildPhases(e.r2Judges);
      const r3 = buildPhases(e.r3Judges);

      const r1Total = parseFloat(e.r1Total) || 0;
      const r2Total = parseFloat(e.r2Total) || 0;
      const r3Total = parseFloat(e.r3Total) || 0;
      // Compute combined ourselves — col[45] is unreliable mid-class (only
      // accurate when operator views Overall in Ryegate). Sum the rounds we
      // actually have data for, capped by numRounds.
      let combined = r1Total;
      if (numRounds >= 2) combined += r2Total;
      if (numRounds >= 3) combined += r3Total;

      return {
        entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
        owner: e.owner || '', country: e.country || '',
        sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
        place: e.place || '',
        r1, r2, r3,
        r1Total, r2Total, r3Total,
        combined,
        r1NumericStatus: e.r1NumericStatus || '',
        r2NumericStatus: e.r2NumericStatus || '',
        r3NumericStatus: e.r3NumericStatus || '',
        r1TextStatus: e.r1TextStatus || '',
        r2TextStatus: e.r2TextStatus || '',
        r3TextStatus: e.r3TextStatus || '',
        hasGone: e.hasGone, statusCode: e.statusCode || '',
      };
    });

    // Normalize status codes (text + numeric → r1/r2/r3 StatusCode)
    entries.forEach(normalizeHunterStatus);

    // Normalize status codes (text + numeric → r1/r2/r3 StatusCode)
    entries.forEach(normalizeHunterStatus);

    // Compute per-judge rankings using the same engine as derby
    entries = computeDerbyRankings(entries, jc);
    result.isSplitDecision = isSplitDecision(entries, jc);

    // Per-round competed counts. Evidence-based: an entry counts as "gone"
    // for a round if it has a real score on that round OR a status code
    // (EL/RT/etc.). Stuck hasGone flags alone don't count.
    result.roundCompleted = [0, 0, 0];
    entries.forEach(e => {
      if (hasR1(e) || e.r1StatusCode) result.roundCompleted[0]++;
      if (hasR2(e) || e.r2StatusCode) result.roundCompleted[1]++;
      if (hasR3(e) || e.r3StatusCode) result.roundCompleted[2]++;
    });
    result.roundCompleted = result.roundCompleted.slice(0, numRounds);

    // Sort by place
    entries.sort((a, b) => {
      const pa = parseInt(a.place) || 999, pb = parseInt(b.place) || 999;
      if (pa !== pb) return pa - pb;
      return (b.combined || 0) - (a.combined || 0);
    });

    result.entries = entries;
  } else {
    // Forced/flat hunter (no scores) — only entries that competed
    result.entries = (body.entries || []).filter(e => e.hasGone).map(e => ({
      entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
      owner: e.owner || '', country: e.country || '',
      sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
      place: e.place || '', score: e.score || '',
      r1Total: e.r1Total || '', r2Total: e.r2Total || '',
      combined: e.combined || '',
      hasGone: e.hasGone, statusCode: e.statusCode || '',
    }));
  }

  return result;
}

// ── JUMPER RESULTS + STATS ──────────────────────────────────────────────────

function computeJumperResults(body, h, base) {
  const entries = body.entries || [];
  const sm = h[2] || '';
  const clockPrecision = parseInt(h[5]) || 0;
  const ta = { r1: parseFloat(h[8]) || 0, r2: parseFloat(h[11]) || 0, r3: parseFloat(h[14]) || 0 };
  const isOptimum = sm === '6';
  const isFaultsConverted = sm === '0';
  const optimumTime = isOptimum && ta.r1 > 0 ? ta.r1 - 4 : 0;

  // Build structured entries with all round data — only entries that competed
  const structured = entries.filter(e => e.hasGone).map(e => {
    // Table III: compute final time = clockTime + jumpFaults + penaltySeconds
    // Ryegate doesn't write the converted time to .cls, only sends it via UDP
    let r1FinalTime = e.r1TotalTime || e.r1Time || '';
    if (isFaultsConverted && r1FinalTime) {
      const clock = parseFloat(e.r1Time) || 0;
      const jf = parseFloat(e.r1JumpFaults) || 0;
      const ps = parseFloat(e.r1PenaltySec) || 0;
      r1FinalTime = (clock + jf + ps).toFixed(3);
    }
    return {
    entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
    owner: e.owner || '', country: e.country || '',
    sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
    place: e.overallPlace || e.place || '',
    rideOrder: parseInt(e.rideOrder) || 0,
    hasGone: e.hasGone, statusCode: e.statusCode || '',
    r1StatusCode: e.r1StatusCode || '', r2StatusCode: e.r2StatusCode || '',
    r1Time: e.r1Time || '', r1TotalTime: r1FinalTime,
    r1JumpFaults: e.r1JumpFaults || '0', r1TimeFaults: e.r1TimeFaults || '0',
    r1TotalFaults: e.r1TotalFaults || '0',
    r2Time: e.r2Time || '', r2TotalTime: e.r2TotalTime || '',
    r2JumpFaults: e.r2JumpFaults || '0', r2TimeFaults: e.r2TimeFaults || '0',
    r2TotalFaults: e.r2TotalFaults || '0',
    r3Time: e.r3Time || '', r3TotalTime: e.r3TotalTime || '',
    r3JumpFaults: e.r3JumpFaults || '0', r3TimeFaults: e.r3TimeFaults || '0',
    r3TotalFaults: e.r3TotalFaults || '0',
  }; });

  // ── Stats computation ──────────────────────────────────────────────────────
  const elimStatuses = ['EL','RF','HF','OC','WD','DNS','DNF','SC','RT'];
  const isElim = sc => elimStatuses.includes((sc || '').toUpperCase());
  const competed = structured.filter(e => e.hasGone);

  // Per-round stats builder
  function buildRoundStats(entries, rnd) {
    const fKey = `r${rnd}TotalFaults`, tKey = `r${rnd}TotalTime`, tfKey = `r${rnd}TimeFaults`, scKey = `r${rnd}StatusCode`;
    const valid = entries.filter(e => e[tKey] && !isElim(e[scKey]) && !isElim(e.statusCode));
    if (!valid.length) return null;
    const elim = entries.filter(e => e[tKey] && (isElim(e[scKey]) || isElim(e.statusCode)));
    const faults = valid.map(e => parseFloat(e[fKey]) || 0);
    const times = valid.map(e => parseFloat(e[tKey]) || 0).filter(t => t > 0);
    const clearCount = faults.filter(f => f === 0).length;
    const avgFaults = faults.length ? faults.reduce((a, b) => a + b, 0) / faults.length : 0;
    const timeFaultCount = valid.filter(e => parseFloat(e[tfKey]) > 0).length;
    const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const clearTimes = valid.filter(e => parseFloat(e[fKey]) === 0).map(e => parseFloat(e[tKey]) || 0).filter(t => t > 0);
    const avgClearTime = clearTimes.length ? clearTimes.reduce((a, b) => a + b, 0) / clearTimes.length : 0;

    // Fault buckets
    const faultBuckets = [];
    const faultSet = {};
    faults.forEach(f => { faultSet[f] = true; });
    Object.keys(faultSet).map(Number).sort((a, b) => a - b).filter(f => f <= 8).forEach(f => {
      faultBuckets.push({ label: f + ' faults', value: f, count: faults.filter(x => x === f).length });
    });
    const mid = faults.filter(f => f >= 9 && f <= 11);
    if (mid.length) faultBuckets.push({ label: '9-11 faults', value: 'mid', count: mid.length });
    const high = faults.filter(f => f >= 12);
    if (high.length) faultBuckets.push({ label: '12+ faults', value: 'high', count: high.length });
    if (elim.length) faultBuckets.push({ label: 'Eliminated', value: 'elim', count: elim.length });

    // Fastest 4-fault
    const f4 = valid.filter(e => parseFloat(e[fKey]) === 4);
    let fastest4Fault = null;
    if (f4.length) {
      const best = f4.reduce((b, e) => {
        const t = parseFloat(e[tKey]) || 999;
        return t < (b.time || 999) ? { entry_num: e.entry_num, horse: e.horse, rider: e.rider, time: t } : b;
      }, { time: 999 });
      if (best.entry_num) fastest4Fault = best;
    }

    // Leaderboard
    const leaderboard = valid.slice().sort((a, b) => {
      const fa = parseFloat(a[fKey]) || 0, fb = parseFloat(b[fKey]) || 0;
      if (fa !== fb) return fa - fb;
      return (parseFloat(a[tKey]) || 0) - (parseFloat(b[tKey]) || 0);
    });
    const leaderTime = leaderboard.length ? (parseFloat(leaderboard[0][tKey]) || 0) : 0;
    const leaderFaults = leaderboard.length ? (parseFloat(leaderboard[0][fKey]) || 0) : 0;
    const leaderboardWithGap = leaderboard.map((e, i) => {
      const f = parseFloat(e[fKey]) || 0;
      const t = parseFloat(e[tKey]) || 0;
      let gap = '';
      if (i > 0) {
        if (f > leaderFaults) gap = '+' + (f - leaderFaults) + ' flt';
        else if (t > leaderTime) gap = '+' + (t - leaderTime).toFixed(3) + 's';
      }
      return { ...e, rank: i + 1, gap };
    });

    return {
      total: valid.length,
      eliminated: elim.length,
      clearRounds: clearCount,
      clearPct: faults.length ? Math.round(clearCount / faults.length * 1000) / 10 : 0,
      avgFaults: Math.round(avgFaults * 100) / 100,
      timeFaultCount,
      avgTime: Math.round(avgTime * 1000) / 1000,
      avgClearTime: Math.round(avgClearTime * 1000) / 1000,
      faultBuckets,
      fastest4Fault,
      leaderboard: leaderboardWithGap,
    };
  }

  const r1Stats = buildRoundStats(competed, 1);
  const r2Stats = buildRoundStats(competed, 2);
  const r3Stats = buildRoundStats(competed, 3);

  return {
    ...base,
    label: 'Jumper',
    scoringMethod: sm,
    clockPrecision,
    showFlags: body.showFlags || false,
    ta,
    isOptimum,
    isFaultsConverted: sm === '0',
    optimumTime,
    entries: structured,
    stats: {
      totalEntries: structured.length,
      competed: competed.length,
      eliminated: r1Stats ? r1Stats.eliminated : 0,
      // Legacy R1 fields for backward compat
      clearRounds: r1Stats ? r1Stats.clearRounds : 0,
      clearPct: r1Stats ? r1Stats.clearPct : 0,
      avgFaults: r1Stats ? r1Stats.avgFaults : 0,
      timeFaultCount: r1Stats ? r1Stats.timeFaultCount : 0,
      avgTime: r1Stats ? r1Stats.avgTime : 0,
      avgClearTime: r1Stats ? r1Stats.avgClearTime : 0,
      faultBuckets: r1Stats ? r1Stats.faultBuckets : [],
      fastest4Fault: r1Stats ? r1Stats.fastest4Fault : null,
      leaderboard: r1Stats ? r1Stats.leaderboard : [],
      // Per-round stats
      r1: r1Stats,
      r2: r2Stats,
      r3: r3Stats,
    },
  };
}
