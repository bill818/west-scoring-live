// v3/js/west-status.js
//
// Status code DICTIONARY. Pure semantic lookup — no placement decisions,
// no method awareness. Just "what does this code mean?" and "what
// category does it fall under?"
//
// Per SESSION-32-JUMPER-STATUS-FINDINGS.md §9: this is the shared
// dictionary consumed by admin, public pages, and (eventually)
// stats rendering. Adding a new code = edit one file, every
// consumer picks it up.
//
// Dual-env IIFE — browser pages load via <script> tag, worker
// currently mirrors the small bits it needs inline.

(function(root) {
  var WEST = root.WEST || (root.WEST = {});
  WEST.status = WEST.status || {};

  // Authoritative catalog of text status codes.
  //
  //   category determines two downstream behaviors:
  //     ELIM    — elimination family. Round cell shows status, suppresses
  //               time/faults (Decision 1). Public pages collapse to "EL".
  //     PARTIAL — partial completion family (RT, WD, HC, EX). Round cell
  //               suppresses time/faults but shows the specific code.
  //     HIDDEN  — entry didn't compete at all (DNS). Usually filtered from
  //               results pages entirely. Admin shows for operator visibility.
  WEST.status.TEXT_CODES = {
    EL:  { label:'EL',  full:'Eliminated',     category:'ELIM'    },
    RF:  { label:'RF',  full:'Rider Fall',     category:'ELIM'    },
    HF:  { label:'HF',  full:'Horse Fall',     category:'ELIM'    },
    OC:  { label:'OC',  full:'Off Course',     category:'ELIM'    },
    RO:  { label:'RO',  full:'Refused Out',    category:'ELIM'    },
    DQ:  { label:'DQ',  full:'Disqualified',   category:'ELIM'    },
    RT:  { label:'RT',  full:'Retired',        category:'PARTIAL' },
    WD:  { label:'WD',  full:'Withdrew',       category:'PARTIAL' },
    HC:  { label:'HC',  full:'Hors Concours',  category:'PARTIAL' },
    EX:  { label:'EX',  full:'Excused',        category:'PARTIAL' },
    DNS: { label:'DNS', full:'Did Not Start',  category:'HIDDEN'  },
  };

  // Returns the category of a code, or null if unknown.
  // Used by Decision 1 (round cell suppression) — any ELIM or PARTIAL
  // code causes the round's time/faults to be suppressed in display.
  WEST.status.categoryOf = function(code) {
    if (!code) return null;
    var entry = WEST.status.TEXT_CODES[code];
    return entry ? entry.category : null;
  };

  // True if the code causes round-cell time/faults to be hidden AND
  // causes the round to be treated as "killed" for placement purposes
  // (Decision 2). Covers both ELIM and PARTIAL families.
  WEST.status.isKillingStatus = function(code) {
    var cat = WEST.status.categoryOf(code);
    return cat === 'ELIM' || cat === 'PARTIAL';
  };

  // Public-facing label collapse. Per Bill's directive:
  // "we dont want rider falls etc on public pages — just standard EL when
  //  we get there."
  //   ELIM-family      → "EL"        (RF, HF, OC, RO, DQ all collapse)
  //   anything else    → code as-is  (RT/WD/HC/EX/DNS stay specific)
  //   unknown code     → returned verbatim (don't invent a label)
  // Admin should call with raw code; public pages call this first.
  WEST.status.publicLabel = function(code) {
    if (!code) return null;
    return WEST.status.categoryOf(code) === 'ELIM' ? 'EL' : code;
  };

  // CommonJS export for Node consumers (future engine local-parse, tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WEST.status;
  }
})(typeof window !== 'undefined' ? window : global);
