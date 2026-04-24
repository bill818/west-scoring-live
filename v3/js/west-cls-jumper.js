// v3/js/west-cls-jumper.js
//
// Jumper .cls entry-row column layout. SINGLE SOURCE OF TRUTH for what
// each column position means in a Farmtek (J) or TOD (T) entry row.
//
// VERSIONED: every historical layout is preserved so old R2 archives
// can always be re-parsed against the layout they were written with.
// When Ryegate shifts column positions, DO NOT edit an existing version.
// Add a new version entry and bump `current`.
//
// Normal parser usage:
//     const L = WEST.cls.jumper.forCurrent();
//     const r1Time = cols[L.rounds[1].time];
//
// Archive re-parse (Phase 3+):
//     const L = WEST.cls.jumper.forVersion(archive.layout_version);
//
// Authoritative narrative: docs/v3-planning/SESSION-32-JUMPER-STATUS-FINDINGS.md
//
// Article 1 reminder: under the jumper lens (class_type J or T). Never
// cross-reference against hunter column meanings.
//
// Dual-env IIFE — attaches to window.WEST in browser, global.WEST in Node.

(function(root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.cls = WEST.cls || {};

  WEST.cls.jumper = {

    // Which version is used for all active parsing. Bump this when Ryegate
    // ships a layout change. Existing versions stay frozen.
    current: 'v_2026_04_23',

    versions: {

      // ─────────────────────────────────────────────────────────────────
      'v_2026_04_23': {
        notes: 'Initial v3 layout. Derived from Culpeper April 2026 live ' +
               'Farmtek + v2 watcher findings. Identity block confirmed ' +
               'shared with hunter cols 0-12. Jumper round scoring at ' +
               'cols 13-35 identical between J and T; text-status location ' +
               'diverges (J tail-scans 37-39, T direct at 82-84).',

        // Identity block (cols 0-12) — shared layout with hunter identity rows.
        identity: {
          entry_num:    0,
          horse_name:   1,
          rider_name:   2,
          // col[3]     — always empty in observed data; purpose unknown
          country_code: 4,  // FEI 3-letter code
          owner_name:   5,
          sire:         6,
          dam:          7,
          city:         8,
          state:        9,
          horse_usef:  10,  // also accepts FEI passport number
          rider_usef:  11,
          owner_usef:  12,
        },

        // Ride metadata (both J and T use col[13] for ride_order — confirmed
        // from Culpeper 212 real data, contradicting CLS-FORMAT.md line 489).
        ride_order:    13,
        overall_place: 14,

        // Round scoring blocks (cols 13-35 identical between J and T).
        rounds: {
          1: {
            time:           15,
            penalty_sec:    16,
            total_time:     17,
            time_faults:    18,
            jump_faults:    19,
            total_faults:   20,
            numeric_status: 21,
          },
          2: {
            time:           22,
            penalty_sec:    23,
            total_time:     24,
            time_faults:    25,
            jump_faults:    26,
            total_faults:   27,
            numeric_status: 28,
          },
          3: {
            // R3 positions are STRUCTURAL INFERENCE. No 3-round jumper
            // class has ever been scored into v2. Parser reads these but
            // should log a parse_warning on first non-zero value so the
            // evidence trail builds up.
            time:           29,
            penalty_sec:    30,
            total_time:     31,
            time_faults:    32,
            jump_faults:    33,
            total_faults:   34,
            numeric_status: 35,
          },
        },

        // col[36] is UNKNOWN — binary 0/1 flag, purpose unconfirmed.
        // Proven unreliable 2026-04-23 (7 entries across 2,357 rows had
        // col[36]=1 with zero scoring evidence; three verified on Ryegate's
        // live page, none displayed). Parser does NOT read col[36].
        //
        //   unknown_flag_36: 36,   // intentionally not exposed

        // Text status location — diverges by hardware type.
        text_status: {
          J: {
            // Farmtek: Ryegate writes text at variable position 37-39.
            // Parser tail-scans this range and attributes to the round
            // whose numeric_status fired (col[21], [28], or [35]).
            // col[36] is EXCLUDED — it's the unknown flag, never text.
            scan_range: [37, 38, 39],
          },
          T: {
            // TOD: direct per-round text columns at the 85-col row tail.
            // col[84] R3 position is UNCONFIRMED — no 3-round T class
            // scored yet. Sweep of 959 local T rows showed col[84] always
            // empty, which neither confirms nor refutes the hypothesis.
            1: 82,
            2: 83,
            3: 84,
          },
        },

        // Row length validation. Parser should verify cols.length and
        // log parse_warning on mismatch — guards against layout drift.
        expected_cols: {
          J: 40,  // Farmtek
          T: 85,  // TOD
        },
      },
      // ─────────────────────────────────────────────────────────────────

      // FUTURE VERSIONS GO HERE.
      //
      // When Ryegate shifts column positions:
      //   1. Do NOT touch any existing version above.
      //   2. Add a new version entry with a date-stamped key.
      //   3. Set `current` to the new key.
      //   4. Add a `notes` field explaining what changed and why.
      //
      // Example (hypothetical):
      //
      //   'v_2027_01_ryegate_v7': {
      //     notes: 'Ryegate v7 inserted a new column between identity ' +
      //            'and scoring. All positions from col[13] onward shift +1.',
      //     ride_order: 14,
      //     overall_place: 15,
      //     rounds: { 1: { time: 16, penalty_sec: 17, ... }, ... },
      //     text_status: { J: { scan_range: [38, 39, 40] }, ... },
      //     expected_cols: { J: 41, T: 86 },
      //   },
    },

    // Convenience: return the current version's layout object.
    forCurrent() {
      return this.versions[this.current];
    },

    // Look up by version string. Falls back to current if unknown version
    // requested (logs indicate a silent fallback — caller should handle).
    forVersion(v) {
      return this.versions[v] || this.versions[this.current];
    },
  };

  // CommonJS export for worker / Node consumers (engine local-parse)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.cls.jumper;
  }
})(typeof window !== 'undefined' ? window : global);
