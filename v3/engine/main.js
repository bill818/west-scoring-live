// WEST v3 Engine — Phase 1 build.
//
// What it does TODAY:
//   - Reads config from c:\west\v3\config.json
//   - Every 10s, POSTs a heartbeat to the worker's /v3/engineHeartbeat
//   - Tray icon + tooltip reflect heartbeat success/failure
//   - Logs to c:\west\v3\engine_log.txt
//
// What it does NOT do yet (future phases):
//   - UDP capture + fan-out to RSServer (spike pattern reintegrated later)
//   - .cls file watching
//   - Parsing anything
//
// Config file shape (c:\west\v3\config.json):
//   {
//     "workerUrl":  "https://west-worker.bill-acb.workers.dev",
//     "authKey":    "west-scoring-2026",
//     "showSlug":   "v3-smoke-test-2026-04",
//     "ringNum":    1
//   }

const { app, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_VERSION = '3.0.0-dev';
const CONFIG_PATH = 'c:\\west\\v3\\config.json';
const LOG_PATH = 'c:\\west\\v3\\engine_log.txt';
const HEARTBEAT_INTERVAL_MS = 10_000;

let tray = null;
let config = null;
let configError = null;
let lastHeartbeatAt = 0;
let lastHeartbeatOk = false;
let lastHeartbeatError = null;
let heartbeatCount = 0;
let heartbeatFailCount = 0;
const startedAt = Date.now();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch (e) {}
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const missing = [];
    if (!cfg.workerUrl) missing.push('workerUrl');
    if (!cfg.authKey) missing.push('authKey');
    if (!cfg.showSlug) missing.push('showSlug');
    if (cfg.ringNum === undefined || cfg.ringNum === null) missing.push('ringNum');
    if (missing.length) throw new Error(`Missing config fields: ${missing.join(', ')}`);
    config = cfg;
    configError = null;
    log(`Config loaded: ${cfg.workerUrl} slug=${cfg.showSlug} ring=${cfg.ringNum}`);
  } catch (e) {
    configError = e.message;
    config = null;
    log(`[CONFIG ERROR] ${e.message}`);
  }
}

async function sendHeartbeat() {
  if (!config) return;
  const payload = {
    slug: config.showSlug,
    ring_num: config.ringNum,
    engine_version: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  };
  try {
    const res = await fetch(`${config.workerUrl}/v3/engineHeartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-West-Key': config.authKey,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    lastHeartbeatAt = Date.now();
    lastHeartbeatOk = true;
    lastHeartbeatError = null;
    heartbeatCount++;
    if (heartbeatCount === 1 || heartbeatCount % 60 === 0) {
      log(`Heartbeat OK (${heartbeatCount} total, ${heartbeatFailCount} failed)`);
    }
  } catch (e) {
    lastHeartbeatAt = Date.now();
    lastHeartbeatOk = false;
    lastHeartbeatError = e.message;
    heartbeatFailCount++;
    log(`[HEARTBEAT FAIL] ${e.message}`);
  }
}

function updateTray() {
  if (!tray) return;
  const ageSec = lastHeartbeatAt ? Math.floor((Date.now() - lastHeartbeatAt) / 1000) : null;
  const lines = [`WEST Engine v${ENGINE_VERSION}`];
  if (configError) {
    lines.push(`⚠ CONFIG ERROR: ${configError}`);
    lines.push(`Expected: ${CONFIG_PATH}`);
  } else if (config) {
    lines.push(`Show: ${config.showSlug}`);
    lines.push(`Ring: ${config.ringNum}`);
    lines.push(`Target: ${config.workerUrl}`);
    if (lastHeartbeatAt === 0) {
      lines.push(`Status: starting…`);
    } else if (lastHeartbeatOk) {
      lines.push(`Status: 🟢 online (${heartbeatCount} heartbeats)`);
      lines.push(`Last OK: ${ageSec}s ago`);
    } else {
      lines.push(`Status: 🔴 failing`);
      lines.push(`Last error: ${lastHeartbeatError || 'unknown'}`);
    }
  }
  tray.setToolTip(lines.join('\n'));
}

process.on('uncaughtException', (err) => {
  log(`[CRASH] uncaughtException: ${err && err.stack ? err.stack : err}`);
  app.relaunch();
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log(`[CRASH] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
  app.relaunch();
  app.exit(1);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.whenReady().then(() => {
  loadConfig();

  // Tray icon — WEST compass from shared assets. Windows will rescale 64×64
  // down to 16×16 for the tray.
  const iconPath = path.join(__dirname, 'icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip(`WEST Engine v${ENGINE_VERSION} — starting…`);

  const menu = Menu.buildFromTemplate([
    { label: `WEST Engine v${ENGINE_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Reload config', click: () => { loadConfig(); updateTray(); } },
    { label: 'Send heartbeat now', click: async () => { await sendHeartbeat(); updateTray(); } },
    { label: 'Open log folder', click: () => {
      require('electron').shell.openPath(path.dirname(LOG_PATH));
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);

  log(`WEST Engine v${ENGINE_VERSION} starting — heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s`);

  // Fire first heartbeat immediately, then on interval
  sendHeartbeat().then(updateTray);
  setInterval(async () => { await sendHeartbeat(); updateTray(); }, HEARTBEAT_INTERVAL_MS);

  // Tray tooltip refreshes tick between heartbeats so "Xs ago" stays current
  setInterval(updateTray, 2000);
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
