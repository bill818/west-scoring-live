// WEST v3 — interpolating clock module (Phase 3b post-shipment polish).
//
// Ports v1.11's tickOnCourse pattern from v2 display-config.js into a v3
// dual-environment shared module. Takes 1Hz UDP snapshots, renders at
// ~30Hz by interpolating wall-clock elapsed time since the last server
// update. Eliminates the "1Hz step jerk" the WS push exposed.
//
// API
//   WEST.clock.set(snapshot)         — feed a fresh snapshot (WS msg or poll)
//   WEST.clock.start(callback)       — begin tick; callback(text, phase)
//   WEST.clock.stop()                — stop ticking + drop callback
//   WEST.clock.setMode('tenth'|'whole') — on-course display mode (default 'tenth')
//
// Per-phase rendering (Bill's rule, 2026-05-02):
//   intro     — "-45" placeholder (v2-style hold), no interpolation
//   countdown — ALWAYS whole seconds (integer, no interpolation)
//   on_course — depends on mode:
//                 'tenth' (default) → 1 decimal, 10Hz interpolation
//                 'whole'           → integer, no interpolation
//   finished  — exact decimal value Ryegate sent (e.g. "93.367"); locked,
//                 no interpolation, 3 decimals
//   idle      — em-dash placeholder
//
// Tag derivation (from Channel A frame 1 tags only):
//   {17} present, integer  → on_course (interpolate or whole per mode)
//   {17} present, decimal  → finished
//   {23} present, negative → countdown
//   {1} entry, no {17}/{23}→ INTRO (v2 watcher logic at west-watcher.js:2614)
//   none of the above      → keep last state (don't flicker to idle on a
//                            single missing frame)
//
// Round detection from TA ({13} = "TA: <num>"):
//   First TA observed for a class           → round 1
//   TA changes to a different value         → round number increments
//   Class change                            → reset, count from 1 again
// Used by callers to render method-aware "Round 1" / "Jump Off" / "PH 2"
// labels via WEST.format.roundLabel(method, modifier, n).
//
// 3-decimal high-precision interpolation is intentionally NOT exposed —
// 30Hz on the thousandths place reads as visual noise, per S43 testing.
//
// Dual-environment IIFE pattern (per CENTRALIZED-JS-ARCHITECTURE.txt):
// browser <script> tag attaches to window.WEST; engine require() attaches
// to global.WEST. No DOM refs in this module — render is callback-driven.

(function (root) {
  var WEST = root.WEST || (root.WEST = {});

  WEST.clock = (function () {
    var TICK_HZ = 10;
    var TICK_MS = Math.round(1000 / TICK_HZ);

    var state = {
      phase: 'idle',          // 'idle' | 'intro' | 'countdown' | 'on_course' | 'finished'
      baseValue: null,        // numeric value at the last server update
      baseAt: 0,              // Date.now() at the last server update
      classId: null,          // last seen class_id for change detection
      mode: 'tenth',          // 'tenth' (default) | 'whole' — on-course display
      finalValue: null,       // FINISH lock — exact value, no interpolation
      // Round-from-TA tracking (Chunk 16 — Bill 2026-05-02 INTRO trigger).
      // taSeen accumulates distinct TA values observed across the current
      // class. roundNum = taSeen.length. Reset on class change.
      currentTa: null,
      taSeen: [],
      roundNum: 0,
      lastEntryNum: null,     // {1} on frame 1 — supports new-rider detection
    };

    var tickIntervalHandle = null;
    var renderCallback = null;

    function setMode(mode) {
      if (mode === 'tenth' || mode === 'whole') state.mode = mode;
    }

    function reset() {
      state.phase = 'idle';
      state.baseValue = null;
      state.baseAt = 0;
      state.finalValue = null;
      state.currentTa = null;
      state.taSeen = [];
      state.roundNum = 0;
      state.lastEntryNum = null;
    }

    // "25" → { value: 25, isDecimal: false }
    // "93.367" → { value: 93.367, isDecimal: true }
    // "-15\r" → { value: -15, isDecimal: false }
    // "" / null → null
    function parseTag(raw) {
      if (raw === undefined || raw === null) return null;
      var s = String(raw).replace(/[\r\n]/g, '').trim();
      if (!s) return null;
      var v = parseFloat(s);
      if (isNaN(v)) return null;
      return { value: v, isDecimal: s.indexOf('.') > -1 };
    }

    function set(snapshot) {
      // Prefer last_scoring (Channel A) — that's where clock tags live.
      // Fall back to snapshot.last for legacy snapshots that predate the
      // S43 Chunk 12 split. snapshot.last_focus (Channel B) carries no
      // clock data so we never read it here.
      var last = snapshot && (snapshot.last_scoring || snapshot.last);
      // Capture clock_precision off the focused class_meta. Drives the
      // FINISH-frame decimal count (Ryegate H[05]: 0=.001, 1=.01, 2=whole).
      // Null when meta hasn't arrived yet — falls back to 3 decimals.
      state.clockPrecision = (snapshot && snapshot.class_meta && snapshot.class_meta.clock_precision != null)
        ? snapshot.class_meta.clock_precision
        : null;
      if (!snapshot || !last) {
        // Can happen at boot before any data arrives, or on idle DO.
        // Don't reset class state — class focus survives no-data windows.
        if (state.classId === null) reset();
        return;
      }

      // Class change → re-baseline. Phase boundaries within a class are
      // handled by the tag-presence logic below; only a different class_id
      // wipes finalValue / phase outright.
      if (last.class_id !== state.classId) {
        state.classId = last.class_id;
        reset();
      }

      // Channel A frame 0 — Ryegate "clear scoreboard" / idle signal.
      // Operator hits Clear SB or clears impulses → Ryegate stops sending
      // frame 1 and emits frame 0. Reset to idle so the display stops
      // ticking. (Bill 2026-05-02 — S43 fix.)
      if (last.channel === 'A' && last.frame === 0) {
        reset();
        return;
      }

      // Clock tags ride on Channel A frame 1 only. Channel B (focus) and
      // other Channel A frames don't carry clock data — leave state alone.
      if (last.channel !== 'A' || last.frame !== 1) return;

      var tags = last.tags || {};

      // ── TA tracking (round-number derivation) ──────────────────────────
      // {13} arrives as "TA: 71" or similar. Strip prefix, parse number.
      // First value seen for a class = round 1; each change increments.
      var rawTa = tags['13'];
      if (rawTa != null) {
        var taStr = String(rawTa).replace(/[\r\n]/g, '').trim();
        var taMatch = taStr.match(/(\d+(?:\.\d+)?)/);
        if (taMatch) {
          var ta = parseFloat(taMatch[1]);
          if (Number.isFinite(ta) && ta > 0 && ta !== state.currentTa) {
            state.currentTa = ta;
            if (state.taSeen.indexOf(ta) === -1) state.taSeen.push(ta);
            state.roundNum = state.taSeen.length;
          }
        }
      }

      // ── Entry-number tracking (new-rider INTRO trigger) ────────────────
      // {1} = entry number. When it changes mid-class (operator picks the
      // next horse), drop back to INTRO so the clock holds at the
      // placeholder until the new countdown fires.
      var rawEntry = tags['1'];
      var entryNum = rawEntry != null
        ? String(rawEntry).replace(/[\r\n]/g, '').trim() : null;

      // {17} — on-course or finished. Decimal → FINISH lock; integer →
      // on-course (interpolate). The integer→decimal handoff at finish
      // happens in the same Ryegate second per S42 / project_v3_rebuild.
      //
      // Same-value guard (S43 fix): when Ryegate sends the SAME integer
      // value back-to-back (e.g. ring is idle but engine keeps relaying
      // a stale frame=1), we DON'T reset baseAt — that would visually
      // restart the interpolation every second. Phase tracking still
      // updates so a stuck idle ring renders cleanly.
      var t17 = parseTag(tags['17']);
      if (t17) {
        if (t17.isDecimal) {
          state.phase = 'finished';
          state.finalValue = t17.value;
        } else {
          var changed = (state.phase !== 'on_course' || state.baseValue !== t17.value);
          state.phase = 'on_course';
          if (changed) {
            state.baseValue = t17.value;
            state.baseAt = Date.now();
          }
        }
        return;
      }

      // {23} — countdown (negative integer ticking up to 0). Same
      // same-value guard as {17}.
      var t23 = parseTag(tags['23']);
      if (t23) {
        var cdChanged = (state.phase !== 'countdown' || state.baseValue !== t23.value);
        state.phase = 'countdown';
        state.lastEntryNum = entryNum || state.lastEntryNum;
        if (cdChanged) {
          state.baseValue = t23.value;
          state.baseAt = Date.now();
        }
        return;
      }

      // INTRO (v2 watcher inference at west-watcher.js:2614):
      //   entry data present but no clock activity yet (no {17}, no {23},
      //   no rank). Operator selected the rider; CD hasn't fired yet.
      //   Show a static "-45" hold until the countdown trigger arrives.
      // Also re-enters INTRO when entry changes mid-class (new horse on
      // course, same class continuing).
      if (entryNum) {
        var newRider = state.lastEntryNum && state.lastEntryNum !== entryNum;
        if (state.phase === 'idle' || state.phase === 'finished' || newRider) {
          state.phase = 'intro';
          state.lastEntryNum = entryNum;
          // baseValue / baseAt unused in INTRO — display is static.
          return;
        }
        state.lastEntryNum = entryNum;
      }

      // Neither tag in this frame → keep last state. Phase boundaries
      // sometimes drop a single frame; flickering to idle would look worse
      // than holding the last good interpolation.
    }

    function tick() {
      if (!renderCallback) return;
      var phase = state.phase;
      if (phase === 'idle') {
        renderCallback('—', 'idle');
        return;
      }
      if (phase === 'intro') {
        // v2-style hold at "-45" until countdown fires. Numeric value is
        // static (matches v2 display-config.js:786). Caller styles via
        // the 'intro' phase string.
        renderCallback('-45', 'intro');
        return;
      }
      if (phase === 'finished') {
        // FINISH renders the class's clock_precision (Ryegate H[05]):
        //   0 → 3 decimals  (thousandths)
        //   1 → 2 decimals  (hundredths — FEI default)
        //   2 → 0 decimals  (whole seconds)
        //   null → 3 decimals (legacy fallback)
        // Previously this hardcoded toFixed(3), padding "32.75" → "32.750"
        // even when Ryegate told us hundredths. Bill 2026-05-14.
        var cp = state.clockPrecision;
        var decimals = cp === 2 ? 0 : cp === 1 ? 2 : 3;
        var fv = (state.finalValue !== null)
          ? state.finalValue.toFixed(decimals) : '—';
        renderCallback(fv, 'finished');
        return;
      }
      if (state.baseValue === null) {
        renderCallback('—', phase);
        return;
      }
      // Countdown — ALWAYS whole seconds, no interpolation. Bill's rule:
      // tenths on the countdown read as noise, the value's only meaningful
      // at the integer-second boundary anyway.
      if (phase === 'countdown') {
        renderCallback(state.baseValue.toFixed(0), 'countdown');
        return;
      }
      // on_course — mode-dependent. 'tenth' interpolates from baseValue
      // at 10Hz with 1 decimal; 'whole' just shows the integer baseline.
      if (state.mode === 'whole') {
        renderCallback(state.baseValue.toFixed(0), 'on_course');
        return;
      }
      var elapsed = (Date.now() - state.baseAt) / 1000;
      var v = state.baseValue + elapsed;
      renderCallback(v.toFixed(1), 'on_course');
    }

    function start(cb) {
      renderCallback = cb;
      tick();    // immediate render so the UI doesn't show '…' for TICK_MS
      if (!tickIntervalHandle) {
        tickIntervalHandle = setInterval(tick, TICK_MS);
      }
    }

    function stop() {
      if (tickIntervalHandle) {
        clearInterval(tickIntervalHandle);
        tickIntervalHandle = null;
      }
      renderCallback = null;
    }

    return {
      set: set,
      start: start,
      stop: stop,
      setMode: setMode,
      // Exposed for testability + future enrichment chunks (FEI flag set
      // from class metadata, multi-clock displays per ring, etc.).
      _state: state,
    };
  })();
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
