// v3/js/west-rules.js
//
// Method-aware placement rules. The "train yard" module.
// Consumed by admin drill-down, public results page, stats aggregations,
// and anything else that needs to know "is this entry placed under its
// class's scoring method?"
//
// Depends on west-status.js for isKillingStatus.
//
// Per SESSION-32-JUMPER-STATUS-FINDINGS.md §8: the canonical table of
// jumper method behavior is here. Contributing sources:
//   - docs/v3-planning/JUMPER-METHODS-REFERENCE.md (method specs)
//   - Bill's train analogy (ladder semantics)
//   - Live observation of methods 9 + 13 at Culpeper 2026-04
//
// Dual-env IIFE — browser pages load via <script> tag.

(function(root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.rules = WEST.rules || {};

  // ── Jumper method table ──────────────────────────────────────────────
  //
  // scoreRounds:   which rounds feed placement (cumulative when >1).
  // tiebreak:      round used to break ties after scoreRounds tied, or null.
  // wipesOnFail:   train-car coupling. { laterRound: [earlierRoundsAlsoWiped] }.
  //                If laterRound has a killing status, the listed earlier
  //                rounds are treated as wiped (ladder propagation).
  //                Empty object = no ladder (later-round failure is local).
  //
  // See JUMPER-METHODS-REFERENCE.md for full per-method behavior.
  WEST.rules.JUMPER_METHODS = {
    0:  { scoreRounds:[1],   tiebreak:null, wipesOnFail:{} },           // Table III
    2:  { scoreRounds:[1],   tiebreak:2,    wipesOnFail:{} },           // II.2a R1+JO
    3:  { scoreRounds:[1,2], tiebreak:3,    wipesOnFail:{2:[1]} },      // 2-round + JO (ladder)
    4:  { scoreRounds:[1],   tiebreak:null, wipesOnFail:{} },           // II.1 Speed
    6:  { scoreRounds:[1],   tiebreak:null, wipesOnFail:{} },           // IV.1 Optimum (mod=1 → [1,2])
    7:  { scoreRounds:[1],   tiebreak:null, wipesOnFail:{} },           // Timed Equitation
    9:  { scoreRounds:[1,2], tiebreak:null, wipesOnFail:{2:[1]} },      // II.2d two-phase (ladder, one ride)
    11: { scoreRounds:[1,2], tiebreak:null, wipesOnFail:{} },           // II.2c qualifier advance (no ladder — PH2 fail keeps PH1)
    13: { scoreRounds:[1],   tiebreak:2,    wipesOnFail:{} },           // II.2b Immediate JO
    14: { scoreRounds:[1,2], tiebreak:3,    wipesOnFail:{2:[1]} },      // Team (ladder)
    15: { scoreRounds:[2],   tiebreak:null, wipesOnFail:{} },           // Winning Round (R2 IS the final)
  };

  // ── Placement check (Decision 2) ─────────────────────────────────────
  //
  // Given a scoring method and per-round statuses, returns true if the
  // entry retains its placement under the method's rules. Used by admin
  // to decide whether to show overall_place, and (eventually) by public
  // results + stats aggregation.
  //
  // statuses: { 1: r1_status, 2: r2_status, 3: r3_status }
  //           each value null, empty, or a TEXT_CODES key.
  //
  // Walks the wipesOnFail ladder: any round with a killing status
  // propagates through the ladder. If ANY round in scoreRounds ends
  // up killed, entry is NOT placed.
  //
  // Unknown method: falls back to "R1 killed → unplaced" approximation.
  // Safe because round-1 elimination always means unplaced across all
  // jumper methods.
  WEST.rules.jumperIsPlaced = function(scoringMethod, statuses) {
    var isKilling = WEST.status.isKillingStatus;
    var rule = WEST.rules.JUMPER_METHODS[scoringMethod];
    if (!rule) {
      return !isKilling(statuses && statuses[1]);
    }
    var killed = {};
    [1, 2, 3].forEach(function(r) {
      if (isKilling(statuses && statuses[r])) {
        killed[r] = true;
        var wiped = rule.wipesOnFail[r];
        if (wiped) wiped.forEach(function(n) { killed[n] = true; });
      }
    });
    for (var i = 0; i < rule.scoreRounds.length; i++) {
      if (killed[rule.scoreRounds[i]]) return false;
    }
    return true;
  };

  // ── Placement with place value ───────────────────────────────────────
  //
  // Returns the displayable place number, or null if unplaced.
  // Wraps jumperIsPlaced + the stored overall_place from Ryegate.
  //
  // Display consumers defer to Ryegate's placement (col[14]) with our
  // suppression rules layered on top. Stats (Phase 3+) may compute
  // placement from scratch — that'll be a separate entry point.
  WEST.rules.jumperPlaceFor = function(overallPlace, scoringMethod, statuses) {
    if (!WEST.rules.jumperIsPlaced(scoringMethod, statuses)) return null;
    if (overallPlace == null) return null;
    return overallPlace;
  };

  // ── Hunter placement ─────────────────────────────────────────────────
  //
  // Hunter placement depends on scoring_type (classes.scoring_type, from
  // header col[5]):
  //
  //   scoringType = 0 (Forced): operator pins placements manually. No
  //     computed totals. Placement evidence is current_place presence.
  //     Rule: R1 status must not be killing; that's the only check.
  //
  //   scoringType = 1 (Scored) or 2 (Hi-Lo): judge-computed totals.
  //     R1 is the GATE — must have a valid total AND non-killing status.
  //     Past R1 = placed (later-round failures local — no ladder).
  //
  // Universal across class modes (Over Fences, Flat, Derby, Special).
  // No method table needed. Simpler than jumper.
  WEST.rules.hunterIsPlaced = function(scoringType, r1Total, r1Status) {
    var isKilling = WEST.status.isKillingStatus;
    // Forced: placement is purely operator-pinned; killing status still hides.
    if (scoringType === 0) {
      return !isKilling(r1Status);
    }
    // Scored / Hi-Lo / unknown: R1 gate with score requirement.
    if (isKilling(r1Status)) return false;
    if (r1Total == null || r1Total === 0) return false;
    return true;
  };

  WEST.rules.hunterPlaceFor = function(currentPlace, scoringType, r1Total, r1Status) {
    if (!WEST.rules.hunterIsPlaced(scoringType, r1Total, r1Status)) return null;
    if (currentPlace == null) return null;
    return currentPlace;
  };

  // ── DNS / no-data filter (cross-lens) ────────────────────────────────
  //
  // True when an entry has zero competition data: no place, no round
  // times/scores, no round statuses, no combined total. Public results
  // pages hide these entries entirely — they're registered in the .cls
  // but never rode. Operator still sees them in admin for visibility.
  //
  // Distinct from EL/RT/WD: those entries have status codes and are
  // shown (with their status). DNS-like entries don't even have that —
  // pure zeros across the board, the ".cls says nothing happened" shape.
  //
  // Cross-lens helper: works on the wide-projection shape returned by
  // /v3/listEntries (jumper r1_time/r1_status etc. + hunter
  // r1_score_total/r1_h_status etc.).
  WEST.rules.isDnsLike = function(entry) {
    if (!entry) return false;
    // Any placement counts as "competed" — even unplaced entries with
    // EL get a position-by-time at the bottom of the field.
    // Wide-shape (listEntries): overall_place / current_place
    if (Number(entry.overall_place) > 0) return false;
    if (Number(entry.current_place) > 0) return false;
    // Grid-shape (listJudgeGrid): place
    if (Number(entry.place) > 0) return false;
    // Any combined / overall total — wide vs grid field names
    if (Number(entry.combined_total) > 0) return false;
    if (Number(entry.combined) > 0) return false;
    // Wide-shape round fields — listEntries projection.
    for (var n = 1; n <= 3; n++) {
      if (entry['r' + n + '_time'])         return false;
      if (entry['r' + n + '_status'])       return false;
      if (entry['r' + n + '_total_faults']) return false;
      if (entry['r' + n + '_score_total'])  return false;
      if (entry['r' + n + '_h_status'])     return false;
    }
    // Grid-shape rounds array — listJudgeGrid response.
    if (entry.rounds && entry.rounds.length) {
      for (var i = 0; i < entry.rounds.length; i++) {
        var rd = entry.rounds[i];
        if (rd.total != null && Number(rd.total) > 0) return false;
        if (rd.status) return false;
      }
    }
    // Pure-zero, statusless entry — never competed.
    return true;
  };

  // CommonJS export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.rules;
  }
})(typeof window !== 'undefined' ? window : global);
