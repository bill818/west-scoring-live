// WEST Engine — scoreboard funnel helpers.
//
// Absorbs v2 west-funnel.js logic (extract/replace/inject Ryegate UDP tags +
// HOLD target state machine + RUNNING tenth interpolation) into the engine.
// main.js will wire these in when the UDP listener is attached during S42.
//
// HOLD TARGET — what it does:
//   Ryegate sends the time-to-beat in tag {18} on intro/countdown frames, but
//   OMITS {18} from on-course frames while a rider is going. The scoreboard
//   then has nothing to display in the target field and goes blank until the
//   next ride arrives. HOLD target re-injects the last operator-set {18}
//   value into those on-course frames so the rider/audience keep seeing the
//   target throughout the round.
//
// Authority rule (per Bill 2026-05-01):
//   - {18}<value>   → heldTarget = value   (operator entered target)
//   - {18}<empty>   → heldTarget = null    (operator cleared target — DO NOT
//                                              keep injecting the previous one)
//   - {18} omitted  → heldTarget unchanged (the on-course persist case —
//                                              this is when we re-inject)
//   - 31000 focus packet for a new class → heldTarget = null (class change)
//
//   v2 funnel only ever WROTE heldTarget — empty was treated as a real value,
//   so the previous class's target stuck on the scoreboard when the next
//   class started. The empty-clears branch + class-change clear are the fix.

'use strict';

// ── FRAME PREDICATES ────────────────────────────────────────────────────────

// True iff this UDP packet looks like a Ryegate scoreboard frame. Some frames
// carry leading control bytes (\r\n etc) before the {RYESCR} marker — strip
// before matching.
function isRyegateScoreFrame(msg) {
  if (!msg || msg.length < 10) return false;
  let i = 0;
  while (i < msg.length && msg[i] < 0x20) i++;
  if (msg.length - i < 9) return false;
  return msg.slice(i, i + 9).toString('ascii') === '{RYESCR}{';
}

// ── TAG EXTRACT / REPLACE / INJECT ──────────────────────────────────────────

// Extract a tag value (e.g. '17' for {17}elapsed). Returns the string value
// (which may be empty) if the tag is present, or null if absent.
function extractTag(msg, tag) {
  const ascii = msg.toString('ascii');
  const needle = '{' + tag + '}';
  const i = ascii.indexOf(needle);
  if (i < 0) return null;
  const start = i + needle.length;
  let end = ascii.indexOf('{', start);
  if (end < 0) end = ascii.length;
  return ascii.substring(start, end);
}

// Replace the value of tag {N} with a new string. Returns a new Buffer.
function replaceTag(msg, tag, newValue) {
  const ascii = msg.toString('ascii');
  const needle = '{' + tag + '}';
  const i = ascii.indexOf(needle);
  if (i < 0) return msg;
  const start = i + needle.length;
  let end = ascii.indexOf('{', start);
  if (end < 0) end = ascii.length;
  return Buffer.from(ascii.substring(0, start) + newValue + ascii.substring(end), 'ascii');
}

// Inject {18}value into a frame that doesn't already have it. Appends before
// trailing CR/LF. No-op if {18} is already present.
function injectTag18(msg, value) {
  const ascii = msg.toString('ascii');
  if (ascii.indexOf('{18}') >= 0) return msg;
  if (ascii.lastIndexOf('}') < 0) return msg; // not a valid frame
  let insertAt = ascii.length;
  while (insertAt > 0 && (ascii.charCodeAt(insertAt - 1) === 13 || ascii.charCodeAt(insertAt - 1) === 10)) insertAt--;
  return Buffer.from(ascii.substring(0, insertAt) + '{18}' + value + ascii.substring(insertAt), 'ascii');
}

// ── HOLD TARGET STATE ───────────────────────────────────────────────────────

// One instance per engine. Encapsulates the corrected heldTarget logic.
function createHoldTargetState() {
  let heldTarget = null;

  return {
    get value() { return heldTarget; },

    // Call on every Ryegate score frame. Updates heldTarget per the
    // authority rule above. Returns true if state changed.
    observe(msg) {
      const t18 = extractTag(msg, '18');
      if (t18 === null) return false;        // tag omitted — keep heldTarget
      const next = (t18.trim() === '') ? null : t18;
      if (next === heldTarget) return false;
      heldTarget = next;
      return true;
    },

    // Call when a 31000 focus packet for a new class arrives, OR when the
    // operator switches show/ring. Clears the held target so we don't carry
    // a stale value into a fresh class.
    clearForNewClass() {
      if (heldTarget === null) return false;
      heldTarget = null;
      return true;
    },

    // Decide whether the engine should inject {18}heldTarget into an
    // outbound frame. Mirrors v2 logic: only inject when both {18} AND
    // {8} (RANK) are absent in this frame, and we have a held value.
    shouldInject(msg) {
      if (heldTarget === null) return false;
      const t18 = extractTag(msg, '18');
      if (t18 !== null) return false;        // frame already has {18}
      const t8 = extractTag(msg, '8');
      const rankShowing = t8 !== null && t8.trim() !== '';
      return !rankShowing;
    },

    // Convenience: observe + return the buffer to send (with injection if
    // appropriate). Caller doesn't need to know the state machine internals.
    process(msg) {
      this.observe(msg);
      return this.shouldInject(msg) ? injectTag18(msg, heldTarget) : msg;
    },
  };
}

// ── RUNNING TENTH STATE ─────────────────────────────────────────────────────
//
// Ryegate fires {fr}=1 ONCOURSE frames at 1Hz with whole-second {17} elapsed
// values: 1, 2, 3, ... The scoreboard would jump a full second between
// updates. Running tenth interpolates 10Hz between real frames so the time
// counts up smoothly: 1.0, 1.1, 1.2, ..., 1.9, 2.0 — and Ryegate's next real
// frame arrives at 2 right around the 2.0 mark, no jump.
//
// State machine:
//   - On each real Ryegate frame, classify phase:
//       'oncourse'      → {17} numeric integer + no {23} countdown
//       'cd'            → {23} countdown present
//       'finish-time'   → {17} has a decimal (Ryegate's authoritative final)
//       'finish-status' → {17} non-numeric (EL/RT/etc.)
//       'other'         → none of the above
//   - 'oncourse' rewrites {17} to "<elapsed>.0" baseline and starts the
//     ticker. Ticker fires every 100ms, sends a synthesized frame with
//     {17}=<base+dt>.toFixed(1).
//   - Any non-oncourse phase stops the ticker (real frame's content takes
//     over the scoreboard).
//   - Pause detection: two consecutive real frames with the same {17}
//     value → clock froze, stop the ticker so we don't keep ticking
//     past the held value.
//   - Silence timeout: 1.5s with no real frame → stop ticker.
//
// Composes with HOLD target: feed the HOLD-injected buffer in, the
// rewritten buffer comes out. Tenth only touches {17}, HOLD only touches
// {18}, no conflict.

function createRunningTenth(deps) {
  const sendTo     = deps.sendTo;
  const intervalMs = deps.intervalMs || 100;
  const silenceMs  = deps.silenceMs  || 1500;

  let baseElapsed   = 0;
  let baseTimeMs    = 0;
  let baseTemplate  = null;
  let lastElapsed   = null;
  let interpolating = false;
  let timer         = null;
  let tickCount     = 0;

  function stopTicker() {
    if (timer) { clearInterval(timer); timer = null; }
    interpolating = false;
  }

  function startTicker() {
    if (interpolating) return;
    interpolating = true;
    timer = setInterval(() => {
      try {
        if (!baseTemplate) return;
        const now = Date.now();
        if (now - baseTimeMs > silenceMs) { stopTicker(); return; }
        const dt = (now - baseTimeMs) / 1000;
        const interpolated = (baseElapsed + dt).toFixed(1);
        const pkt = replaceTag(baseTemplate, '17', interpolated);
        sendTo(pkt);
        tickCount++;
      } catch (e) { /* swallow tick errors */ }
    }, intervalMs);
  }

  return {
    get tickCount()      { return tickCount; },
    get isInterpolating(){ return interpolating; },

    // Feed every Ryegate frame in. Returns the buffer to forward — for
    // ONCOURSE that's the .0-decimal-baseline rewrite; otherwise the
    // original buffer. State machine handles ticker start/stop.
    process(msg) {
      if (!isRyegateScoreFrame(msg)) return msg;
      const t17 = extractTag(msg, '17');
      const t23 = extractTag(msg, '23');
      let phase = 'other';
      let elapsedNum = null;
      if (t17 !== null && t23 === null) {
        const trimmed = (t17 || '').trim();
        if (trimmed.indexOf('.') >= 0) phase = 'finish-time';
        else if (/^-?\d+$/.test(trimmed)) {
          phase = 'oncourse';
          elapsedNum = parseInt(trimmed, 10);
        } else {
          phase = 'finish-status';
        }
      } else if (t23 !== null) {
        phase = 'cd';
      }
      if (phase !== 'oncourse') {
        stopTicker();
        lastElapsed = null;
        return msg;                       // forward real frame as-is
      }
      // Oncourse — rewrite to .0 baseline + update interpolation state.
      const rewritten = replaceTag(msg, '17', elapsedNum.toFixed(1));
      baseElapsed  = elapsedNum;
      baseTimeMs   = Date.now();
      baseTemplate = rewritten;
      if (lastElapsed !== null && elapsedNum === lastElapsed) {
        stopTicker();                     // clock paused at this value
      } else {
        startTicker();
      }
      lastElapsed = elapsedNum;
      return rewritten;
    },

    // Reset state — called on show switch / focus class change so the
    // ticker doesn't keep running off old data.
    reset() {
      stopTicker();
      baseElapsed = 0;
      baseTimeMs = 0;
      baseTemplate = null;
      lastElapsed = null;
    },

    teardown() {
      stopTicker();
    },
  };
}

module.exports = {
  isRyegateScoreFrame,
  extractTag,
  replaceTag,
  injectTag18,
  createHoldTargetState,
  createRunningTenth,
};
