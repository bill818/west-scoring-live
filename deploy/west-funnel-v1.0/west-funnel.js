/**
 * WEST Scoring Live — UDP Funnel
 *
 * Receives UDP broadcasts on Ryegate's scoreboard port and fans out
 * byte-identical copies to up to 2 loopback destinations (e.g. RSServer.exe
 * on one port, the watcher on another).
 *
 * Default mode: pure pass-through — no parsing, no modification.
 *
 * Optional "runningTenth" mode (config.json "runningTenth": 1): on ONE
 * output port only (configurable, defaults to outputPorts[0] — the
 * scoreboard side), the funnel interpolates the elapsed time field
 * ({17}) at 10 Hz between Ryegate's 1 Hz frames so the scoreboard shows
 * smooth tenths instead of jumping whole seconds. Other output port is
 * ALWAYS byte-identical pass-through.
 *
 * Solves the single-PC case where Ryegate, RSServer, and the watcher all
 * live on the same Windows host and RSServer's exclusive bind on the
 * scoreboard port blocks any other listener.
 *
 * Config (config.json):
 *   {
 *     "outputPorts":       [29697, 29698],
 *     "runningTenth":      0,          // optional, default 0 (pass-through)
 *     "runningTenthPort":  29697       // optional, defaults to outputPorts[0]
 *   }
 *
 * Input port auto-detected from C:\Ryegate\Jumper\config.dat col[1]
 * (single source of truth — follows Ryegate's scoreboard port changes).
 *
 * Requirements: Node.js LTS. No npm deps.
 */

const FUNNEL_VERSION = '1.1.0';

const fs   = require('fs');
const path = require('path');
const dgram = require('dgram');

// ── CRASH PROTECTION ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  try { log(`[CRASH CAUGHT] uncaughtException: ${err.message}\n${err.stack}`); } catch(_) {}
});
process.on('unhandledRejection', (reason) => {
  try { log(`[CRASH CAUGHT] unhandledRejection: ${reason}`); } catch(_) {}
});

// ── PATHS / CONFIG ──────────────────────────────────────────────────────────
const CONFIG_JSON   = path.join(__dirname, 'config.json');
const RYEGATE_CONF  = 'C:\\Ryegate\\Jumper\\config.dat';
const LOG_PATH      = path.join(__dirname, 'west-funnel.log');

function log(msg) {
  const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\r\n'); } catch (e) {}
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return {}; }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function detectInputPort() {
  try {
    const content = fs.readFileSync(RYEGATE_CONF, 'utf8');
    const cols = parseCsvLine(content.split(/\r?\n/)[0] || '');
    const port = parseInt(cols[1]);
    if (port && port > 0 && port < 65536) return port;
  } catch (e) { log(`[CONFIG] could not read ${RYEGATE_CONF}: ${e.message}`); }
  log(`[CONFIG] falling back to default input port 29696`);
  return 29696;
}

// ── LOAD CONFIG ─────────────────────────────────────────────────────────────
const cfg = readJson(CONFIG_JSON);
const INPUT_PORT  = detectInputPort();
let   OUTPUT_PORTS = Array.isArray(cfg.outputPorts) ? cfg.outputPorts.slice(0, 2) : [];
OUTPUT_PORTS = OUTPUT_PORTS
  .map(p => parseInt(p))
  .filter(p => p > 0 && p < 65536 && p !== INPUT_PORT);

const RUNNING_TENTH = cfg.runningTenth === 1 || cfg.runningTenth === true;
const RUNNING_TENTH_PORT = (() => {
  const cand = parseInt(cfg.runningTenthPort);
  if (cand > 0 && cand < 65536 && OUTPUT_PORTS.indexOf(cand) >= 0) return cand;
  return OUTPUT_PORTS[0] || null;
})();

if (!OUTPUT_PORTS.length) {
  log(`[CONFIG] WARNING: no valid outputPorts in config.json — funnel will listen but drop every packet.`);
}

log('═'.repeat(60));
log(`WEST Scoring Live Funnel v${FUNNEL_VERSION}`);
log(`Input port:  ${INPUT_PORT}  (from Ryegate config.dat)`);
log(`Output ports: ${OUTPUT_PORTS.length ? OUTPUT_PORTS.join(', ') : '(none)'}`);
if (RUNNING_TENTH && RUNNING_TENTH_PORT) {
  log(`Running tenth: ENABLED on port ${RUNNING_TENTH_PORT} (other output is pass-through)`);
} else {
  log(`Running tenth: OFF (pure pass-through on all outputs)`);
}
log('═'.repeat(60));

// ── RYEGATE SCOREBOARD FRAME PARSER ─────────────────────────────────────────
// Packet format: {RYESCR}{fr}1{1}value{2}value...{17}elapsed...
// We only need to detect ONCOURSE vs other phases, and rewrite {17} for
// interpolation. Everything else passes through untouched.
//
// Phase heuristic from observed west_udp_log.txt samples:
//   ONCOURSE : has {17} (elapsed), NO {23} (countdown), has {14}/{15}
//   CD       : has {23} (negative countdown), NO {17}
//   INTRO    : neither {17} nor {23}
//   FINISH   : has {17}, usually has rank-style tags; treat same as ONCOURSE
//              for phase detection — interpolation logic will stop when
//              elapsed text contains non-numeric chars (EL/RT/etc.)

function isRyegateScoreFrame(msg) {
  // Quick header check before any decoding. Some Ryegate packets carry
  // a leading \r\n (or other control bytes) before the {RYESCR} marker —
  // strip leading non-printable bytes before matching.
  if (msg.length < 10) return false;
  let i = 0;
  while (i < msg.length && msg[i] < 0x20) i++;
  if (msg.length - i < 9) return false;
  const head = msg.slice(i, i + 9).toString('ascii');
  return head === '{RYESCR}{';
}

// Extract the value of a given tag (e.g. '17') from a {RYESCR} payload.
// Returns the string value, or null if the tag isn't present.
function extractTag(msg, tag) {
  const ascii = msg.toString('ascii');
  const needle = '{' + tag + '}';
  const i = ascii.indexOf(needle);
  if (i < 0) return null;
  const start = i + needle.length;
  // Value runs until the next '{' tag opener or end of string.
  let end = ascii.indexOf('{', start);
  if (end < 0) end = ascii.length;
  return ascii.substring(start, end);
}

// Replace the value of tag {17} with a new string. Returns a new Buffer.
// Writes bytes (ASCII safe since tags are ASCII).
function replaceTag17(msg, newValue) {
  const ascii = msg.toString('ascii');
  const needle = '{17}';
  const i = ascii.indexOf(needle);
  if (i < 0) return msg; // no tag to replace, return original
  const start = i + needle.length;
  let end = ascii.indexOf('{', start);
  if (end < 0) end = ascii.length;
  const before = ascii.substring(0, start);
  const after  = ascii.substring(end);
  return Buffer.from(before + newValue + after, 'ascii');
}

// ── SOCKETS ─────────────────────────────────────────────────────────────────
let inSocket  = null;
let outSocket = null;
let heartbeatTimer = null;
let packetsSeen = 0;
let packetsSent = 0;
let packetErrors = 0;
let tenthTicks   = 0;

// ── RUNNING TENTH STATE ─────────────────────────────────────────────────────
// Base for interpolation = the elapsed value from the most recent real
// ONCOURSE packet + the wall-clock time that packet arrived.
const SILENCE_TIMEOUT_MS = 1500;
const TENTH_INTERVAL_MS  = 100;

let tenthTimer   = null;
let baseElapsed  = 0;           // last real integer elapsed
let baseTimeMs   = 0;           // arrival time of that packet
let baseTemplate = null;        // Buffer of the last real ONCOURSE packet (used as template for synthesized frames)
let lastElapsed  = null;        // previous real elapsed — used to detect pause (same value = clock frozen)
let interpolating = false;

function stopInterpolation(/* reason */) {
  if (!interpolating && !tenthTimer) return;
  if (tenthTimer) { clearInterval(tenthTimer); tenthTimer = null; }
  interpolating = false;
}

function startInterpolation() {
  if (interpolating) return;
  interpolating = true;
  tenthTimer = setInterval(() => {
    try {
      if (!baseTemplate) return;
      // Silence timeout — nothing arrived recently, assume pause/end
      const now = Date.now();
      if (now - baseTimeMs > SILENCE_TIMEOUT_MS) {
        stopInterpolation('silence timeout');
        return;
      }
      const dt = (now - baseTimeMs) / 1000;
      const interpolated = (baseElapsed + dt).toFixed(1);
      const pkt = replaceTag17(baseTemplate, interpolated);
      sendTo(RUNNING_TENTH_PORT, pkt);
      tenthTicks++;
    } catch (e) {
      // Don't let tick errors kill the process.
    }
  }, TENTH_INTERVAL_MS);
}

// Forward a buffer to a specific port. Used both for normal pass-through
// and for synthesized tenths.
function sendTo(port, buf) {
  if (!outSocket) return;
  try {
    outSocket.send(buf, 0, buf.length, port, '127.0.0.1', (err) => {
      if (err) { packetErrors++; }
      else     { packetsSent++; }
    });
  } catch (e) {
    packetErrors++;
  }
}

function openOutSocket() {
  try {
    const s = dgram.createSocket('udp4');
    s.on('error', (err) => {
      log(`[OUT] socket error: ${err.message} — reopening in 2s`);
      try { s.close(); } catch (_) {}
      if (outSocket === s) outSocket = null;
      setTimeout(openOutSocket, 2000);
    });
    outSocket = s;
    log(`[OUT] send socket ready`);
  } catch (e) {
    log(`[OUT] failed to create send socket: ${e.message} — retry in 2s`);
    setTimeout(openOutSocket, 2000);
  }
}

function openInSocket() {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  inSocket = s;

  s.on('error', (err) => {
    log(`[IN] bind error on port ${INPUT_PORT}: ${err.message}`);
    try { s.close(); } catch (_) {}
    if (inSocket === s) inSocket = null;
    if (err.code === 'EADDRINUSE') {
      log(`[IN] port ${INPUT_PORT} in use — exiting for restart loop`);
      process.exit(1);
    }
    setTimeout(openInSocket, 2000);
  });

  s.on('listening', () => {
    const info = s.address();
    log(`[IN] listening on ${info.address}:${info.port}`);
  });

  s.on('message', (msg /*, rinfo */) => {
    packetsSeen++;
    if (!outSocket || !OUTPUT_PORTS.length) return;

    // Parse once if we may care (tenth mode + Ryegate frame).
    const tenthCandidate = RUNNING_TENTH && RUNNING_TENTH_PORT && isRyegateScoreFrame(msg);
    let phase = 'passthrough', elapsedNum = null, rewritten = null;
    if (tenthCandidate) {
      const t17 = extractTag(msg, '17');
      const t23 = extractTag(msg, '23');
      if (t17 !== null && t23 === null) {
        const trimmed = (t17 || '').trim();
        if (trimmed.indexOf('.') >= 0) {
          // Decimal = Ryegate's precise final time (e.g. "12.560") — a
          // FINISH packet. Don't interpolate, don't rewrite; pass the real
          // bytes through so the scoreboard shows the authoritative time.
          phase = 'finish-time';
        } else if (/^-?\d+$/.test(trimmed)) {
          phase = 'oncourse';
          elapsedNum = parseInt(trimmed, 10);
        } else {
          // Non-numeric (EL/RT/WD/etc.) — FINISH with status
          phase = 'finish-status';
        }
      } else if (t23 !== null) {
        phase = 'cd';
      } else {
        phase = 'other';
      }
    }

    // Fan out to every output port, with the scoreboard-facing port
    // getting the .0-decimal rewrite during ONCOURSE in tenth mode.
    for (const port of OUTPUT_PORTS) {
      if (port === RUNNING_TENTH_PORT && phase === 'oncourse') {
        if (!rewritten) rewritten = replaceTag17(msg, elapsedNum.toFixed(1));
        sendTo(port, rewritten);
      } else {
        sendTo(port, msg);
      }
    }

    // Tenth-mode state machine (only touches interpolation, not fan-out).
    if (!tenthCandidate) return;

    if (phase === 'cd' || phase === 'other' || phase === 'finish-status' || phase === 'finish-time') {
      // Non-ONCOURSE → stop the ticker. The real Ryegate frame we just
      // forwarded carries the correct state (countdown, final decimal
      // time, EL status, etc.), so the scoreboard ends up showing it.
      stopInterpolation(`phase=${phase}`);
      lastElapsed = null;
      return;
    }

    // ONCOURSE — update interpolation base.
    baseElapsed  = elapsedNum;
    baseTimeMs   = Date.now();
    baseTemplate = rewritten || Buffer.from(msg); // use rewritten form so subsequent tenths inherit the .0 baseline

    if (lastElapsed !== null && elapsedNum === lastElapsed) {
      // Pause detected — same elapsed as last real frame. Stop the
      // ticker and leave the scoreboard sitting at <elapsedNum>.0
      // (the real packet we just forwarded had that value rewritten).
      stopInterpolation(`clock paused at ${elapsedNum}.0`);
    } else {
      startInterpolation();
    }
    lastElapsed = elapsedNum;
  });

  try { s.bind(INPUT_PORT); }
  catch (e) { log(`[IN] bind threw: ${e.message}`); }
}

// ── HEARTBEAT ───────────────────────────────────────────────────────────────
function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    const extra = RUNNING_TENTH ? ` tenths=${tenthTicks}` : '';
    log(`[HB] seen=${packetsSeen} sent=${packetsSent} errs=${packetErrors}${extra}`);
  }, 60000);
}

// ── SHUTDOWN ────────────────────────────────────────────────────────────────
function shutdown(reason) {
  log(`[SHUTDOWN] ${reason}`);
  try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch (_) {}
  try { stopInterpolation('shutdown'); } catch (_) {}
  try { if (inSocket)  inSocket.close();  } catch (_) {}
  try { if (outSocket) outSocket.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 150);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── GO ──────────────────────────────────────────────────────────────────────
openOutSocket();
openInSocket();
startHeartbeat();
