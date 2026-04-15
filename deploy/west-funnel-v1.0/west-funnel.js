/**
 * WEST Scoring Live — UDP Funnel
 *
 * Receives UDP broadcasts on Ryegate's scoreboard port and fans out
 * byte-identical copies to up to 2 loopback destinations (e.g. RSServer.exe
 * on one port, the watcher on another). Pure pass-through — no parsing,
 * no interpretation, no modification.
 *
 * Solves the single-PC case where Ryegate, RSServer, and the watcher all
 * live on the same Windows host and RSServer's exclusive bind on the
 * scoreboard port blocks any other listener. The funnel owns that port;
 * both real consumers read their own private port.
 *
 * Config:
 *   config.json (next to this file):
 *     { "outputPorts": [29697, 29698] }
 *   Input port auto-detected from C:\Ryegate\Jumper\config.dat col[1]
 *   (matches whatever Ryegate is sending to — single source of truth).
 *
 * Requirements: Node.js LTS. No npm deps.
 */

const FUNNEL_VERSION = '1.0.0';

const fs   = require('fs');
const path = require('path');
const dgram = require('dgram');

// ── CRASH PROTECTION ─────────────────────────────────────────────────────────
// Log and keep running. A live show can't afford a silent crash.
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

if (!OUTPUT_PORTS.length) {
  log(`[CONFIG] WARNING: no valid outputPorts in config.json — funnel will listen but drop every packet.`);
}

log('═'.repeat(60));
log(`WEST Scoring Live Funnel v${FUNNEL_VERSION}`);
log(`Input port:  ${INPUT_PORT}  (from Ryegate config.dat)`);
log(`Output ports: ${OUTPUT_PORTS.length ? OUTPUT_PORTS.join(', ') : '(none)'}`);
log('═'.repeat(60));

// ── SOCKETS ─────────────────────────────────────────────────────────────────
let inSocket  = null;
let outSocket = null;
let heartbeatTimer = null;
let packetsSeen = 0;
let packetsSent = 0;
let packetErrors = 0;

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
      // Another process holds the port exclusively. Exit with non-zero so
      // the start-funnel.bat restart loop retries after its 5s wait.
      log(`[IN] port ${INPUT_PORT} in use — exiting for restart loop`);
      process.exit(1);
    }
    // Any other socket error — reopen after a short delay.
    setTimeout(openInSocket, 2000);
  });

  s.on('listening', () => {
    const info = s.address();
    log(`[IN] listening on ${info.address}:${info.port}`);
  });

  s.on('message', (msg /*, rinfo */) => {
    packetsSeen++;
    if (!outSocket || !OUTPUT_PORTS.length) return;
    for (const port of OUTPUT_PORTS) {
      try {
        outSocket.send(msg, 0, msg.length, port, '127.0.0.1', (err) => {
          if (err) { packetErrors++; }
          else     { packetsSent++; }
        });
      } catch (e) {
        packetErrors++;
        // Swallow — one bad send cannot kill the process.
      }
    }
  });

  try { s.bind(INPUT_PORT); }
  catch (e) { log(`[IN] bind threw: ${e.message}`); }
}

// ── HEARTBEAT ───────────────────────────────────────────────────────────────
function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    log(`[HB] seen=${packetsSeen} sent=${packetsSent} errs=${packetErrors}`);
  }, 60000);
}

// ── SHUTDOWN ────────────────────────────────────────────────────────────────
function shutdown(reason) {
  log(`[SHUTDOWN] ${reason}`);
  try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch (_) {}
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
