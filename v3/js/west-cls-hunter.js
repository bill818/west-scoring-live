// v3/js/west-cls-hunter.js
//
// Hunter .cls entry-row column layout. SINGLE SOURCE OF TRUTH for what
// each column position means in a hunter (H) entry row.
//
// VERSIONED (mirror of v3/js/west-cls-jumper.js pattern). When Ryegate
// shifts column positions, add a new version entry with the new layout
// and bump `current`. DO NOT edit existing versions — old R2 archives
// need to re-parse against the layout they were written with.
//
// Authoritative narrative:
//   docs/v3-planning/CLS-FORMAT.md (hunter entry section)
//   docs/v3-planning/HUNTER-METHODS-REFERENCE.md (per-mode behavior)
//   docs/v3-planning/SESSION-32-JUMPER-STATUS-FINDINGS.md (per-round pattern)
//
// Article 1 reminder: under the hunter lens (class_type = 'H') ONLY.
// Never cross-reference against jumper column meanings.
//
// Dual-env IIFE — browser pages load via <script> tag, worker mirrors
// the current version inline.

(function(root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.cls = WEST.cls || {};

  WEST.cls.hunter = {

    current: 'v_2026_04_24',

    versions: {

      // ─────────────────────────────────────────────────────────────────
      'v_2026_04_24': {
        notes: 'Initial v3 hunter layout. Derived from CLS-FORMAT.md ' +
               'hunter section + Devon Fall 2025 test data. Per-judge ' +
               'positions noted for future entry_hunter_judge_scores ' +
               'table; round totals at col[42-44] are the Phase 2d ' +
               'capture target. col[45] CombinedTotal stored entry-' +
               'scoped on summary.',

        // Identity block (cols 0-12) — shared layout with jumper.
        identity: {
          entry_num:    0,
          horse_name:   1,
          rider_name:   2,
          country_code: 4,
          owner_name:   5,
          sire:         6,
          dam:          7,
          city:         8,
          state:        9,
          horse_usef:  10,
          rider_usef:  11,
          owner_usef:  12,
        },

        // Ride metadata
        go_order:      13,   // hunter uses "go_order" (vs jumper "ride_order")
        current_place: 14,   // hunter uses "current_place" (vs jumper "overall_place")

        // Per-judge score positions (NOT captured in Phase 2d — deferred to
        // a future entry_hunter_judge_scores table keyed by entry_id+round+judge).
        // Structure: judge J's R{N} score = cols[judges[N].start + J]
        // numJudges from the class header (classes.num_judges).
        judges: {
          1: { start: 15 },  // col[15 + j] for j = 0..numJudges-1 (max col[21])
          2: { start: 24 },  // col[24 + j] ... (max col[30])
          3: { start: 33 },  // col[33 + j] ... (max col[39])
        },

        // Per-round totals and statuses.
        //   total            = sum of judge scores for that round
        //   numeric_status   = hunter numeric code (lens-specific map)
        //   text_status      = text code (EL/RF/HF/OC/RO/DQ/RT/WD/HC/EX/DNS)
        rounds: {
          1: { total: 42, numeric_status: 46, text_status: 52 },
          2: { total: 43, numeric_status: 47, text_status: 53 },
          3: { total: 44, numeric_status: 48, text_status: 54 },
        },

        // Combined total across all rounds scored. Entry-scoped (lives
        // on entry_hunter_summary, not repeated per round).
        combined_total: 45,

        // has_gone per round (cols 49/50/51) INTENTIONALLY NOT CAPTURED.
        // Same unreliability as jumper col[36] — can stick from testing.
        // Derive "did they ride round N" from
        //   entry_hunter_rounds row exists AND (total IS NOT NULL OR status IS NOT NULL)
        // at render time.
        //
        //   has_gone_r1_unknown: 49,   // intentionally not exposed
        //   has_gone_r2_unknown: 50,
        //   has_gone_r3_unknown: 51,

        // Derby (classMode=2) component breakdown NOT captured in this
        // version. Positions reserved for future extension:
        //   R1_HighOptionsTaken:  15  (same col as Judge 1 score — context-dependent)
        //   Judge1_R1_BaseScore:  16
        //   Judge2_R1_BaseScore:  18  (for multi-judge derby)
        //   R2_HighOptionsTaken:  24
        //   Judge1_R2_BaseScore:  25
        //   Judge1_R2_HandyBonus: 26
        //   etc.
        // Parser logs parse_warning for classMode=2 classes noting
        // "derby components not captured" — totals at col[42-45] still land.

        // Hunter row length VARIES by numJudges + rounds + derby. No fixed
        // expected_cols check here — parser validates differently (e.g.,
        // col[42] must exist for round totals to land).
        min_cols: 55,  // enough to reach col[54] (R3 text status)
      },

      // Future versions append here. Do not mutate existing.
    },

    forCurrent: function() { return this.versions[this.current]; },
    forVersion: function(v) { return this.versions[v] || this.versions[this.current]; },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.cls.hunter;
  }
})(typeof window !== 'undefined' ? window : global);
