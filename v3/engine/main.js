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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_VERSION = '3.0.0-dev';
const CONFIG_PATH = 'c:\\west\\v3\\config.json';
const LOG_PATH = 'c:\\west\\v3\\engine_log.txt';
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_CLS_DIR = 'C:\\Ryegate\\Jumper\\Classes';
const DEFAULT_TSKED_PATH = 'C:\\Ryegate\\Jumper\\tsked.csv';
const CLS_DEBOUNCE_MS = 2000;
const CLS_STARTUP_SYNC_DELAY_MS = 150; // space out initial POSTs
const TSKED_DEBOUNCE_MS = 2000;

let tray = null;
let config = null;
let configError = null;
let lastHeartbeatAt = 0;
let lastHeartbeatOk = false;
let lastHeartbeatError = null;
let heartbeatCount = 0;
let heartbeatFailCount = 0;
let clsPostCount = 0;
let clsPostFailCount = 0;
let lastClsPostAt = 0;
let lastClsPostFile = null;
let lastClsPostError = null;
let clsWatcher = null;
const clsDebounceTimers = new Map(); // filename → setTimeout handle
let tskedWatcher = null;
let tskedDebounceTimer = null;
let tskedLastHash = null;
let tskedPostCount = 0;
let tskedSkipCount = 0; // content unchanged, didn't POST
let tskedLastPostAt = 0;
let tskedLastError = null;
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

function classIdFromFilename(filename) {
  // "1005.cls" → "1005", "48C.cls" → "48C"
  if (!filename.toLowerCase().endsWith('.cls')) return null;
  const base = filename.slice(0, -4);
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(base)) return null;
  return base;
}

async function postClsFile(filename) {
  if (!config) return;
  const clsDir = config.clsDir || DEFAULT_CLS_DIR;
  const classId = classIdFromFilename(filename);
  if (!classId) return; // non-.cls or malformed filename
  const full = path.join(clsDir, filename);
  let bytes;
  try {
    bytes = fs.readFileSync(full);
  } catch (e) {
    log(`[CLS READ FAIL] ${filename}: ${e.message}`);
    return;
  }
  if (!bytes.length) {
    log(`[CLS SKIP] ${filename}: empty file`);
    return;
  }
  try {
    const res = await fetch(`${config.workerUrl}/v3/postCls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-West-Key': config.authKey,
        'X-West-Slug': config.showSlug,
        'X-West-Ring': String(config.ringNum),
        'X-West-Class': classId,
      },
      body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    clsPostCount++;
    lastClsPostAt = Date.now();
    lastClsPostFile = filename;
    lastClsPostError = null;
    log(`CLS POST OK ${filename} (${bytes.length} bytes) — total ${clsPostCount}/${clsPostCount + clsPostFailCount}`);
  } catch (e) {
    clsPostFailCount++;
    lastClsPostError = e.message;
    log(`[CLS POST FAIL] ${filename}: ${e.message}`);
  }
}

function scheduleClsPost(filename) {
  // Debounce: coalesce multiple fs.watch events for the same file within
  // CLS_DEBOUNCE_MS into one POST with the latest bytes. Guards against
  // Ryegate's atomic-write pattern firing 3-5 fs.watch events per save.
  const existing = clsDebounceTimers.get(filename);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    clsDebounceTimers.delete(filename);
    postClsFile(filename).catch(e => log(`[CLS POST UNCAUGHT] ${filename}: ${e.message}`));
  }, CLS_DEBOUNCE_MS);
  clsDebounceTimers.set(filename, timer);
}

async function syncAllCls() {
  // Startup sync: post every .cls currently in the directory so the worker
  // has the latest state even if the engine was offline while files changed.
  if (!config) return;
  const clsDir = config.clsDir || DEFAULT_CLS_DIR;
  let entries;
  try {
    entries = fs.readdirSync(clsDir);
  } catch (e) {
    log(`[CLS DIR READ FAIL] ${clsDir}: ${e.message}`);
    return;
  }
  const clsFiles = entries.filter(f => classIdFromFilename(f));
  if (!clsFiles.length) {
    log(`CLS startup sync: no .cls files in ${clsDir}`);
    return;
  }
  log(`CLS startup sync: found ${clsFiles.length} .cls files in ${clsDir}`);
  for (const f of clsFiles) {
    await postClsFile(f);
    await new Promise(r => setTimeout(r, CLS_STARTUP_SYNC_DELAY_MS));
  }
  log(`CLS startup sync complete — ${clsPostCount} ok, ${clsPostFailCount} failed`);
}

async function postTskedIfChanged(reason) {
  if (!config) return;
  const tskedPath = config.tskedPath || DEFAULT_TSKED_PATH;
  let bytes;
  try { bytes = fs.readFileSync(tskedPath); }
  catch (e) {
    log(`[TSKED READ FAIL] ${tskedPath}: ${e.message}`);
    return;
  }
  if (!bytes.length) {
    log(`[TSKED SKIP] ${tskedPath}: empty file`);
    return;
  }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash === tskedLastHash) {
    tskedSkipCount++;
    // Session 25 lesson: Ryegate's "Upload Results" button touches mtime
    // without changing content. Skip silently.
    return;
  }
  try {
    const res = await fetch(`${config.workerUrl}/v3/postTsked`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-West-Key': config.authKey,
        'X-West-Slug': config.showSlug,
      },
      body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    tskedLastHash = hash;
    tskedPostCount++;
    tskedLastPostAt = Date.now();
    tskedLastError = null;
    log(`TSKED POST OK (${bytes.length} bytes, ${data.rows_total} rows: ${data.updated} updated, ${data.skipped} unmatched) — reason=${reason}`);
  } catch (e) {
    tskedLastError = e.message;
    log(`[TSKED POST FAIL] ${e.message}`);
  }
}

function scheduleTskedPost(reason) {
  if (tskedDebounceTimer) clearTimeout(tskedDebounceTimer);
  tskedDebounceTimer = setTimeout(() => {
    tskedDebounceTimer = null;
    postTskedIfChanged(reason).catch(e => log(`[TSKED UNCAUGHT] ${e.message}`));
  }, TSKED_DEBOUNCE_MS);
}

function startTskedWatcher() {
  if (!config) return;
  const tskedPath = config.tskedPath || DEFAULT_TSKED_PATH;
  try {
    // Watch the parent dir for the specific filename — fs.watch on a
    // non-existent file throws, and watching the dir survives file
    // creation/deletion too.
    const dir = path.dirname(tskedPath);
    const name = path.basename(tskedPath);
    tskedWatcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
      if (!filename || filename.toLowerCase() !== name.toLowerCase()) return;
      scheduleTskedPost('fs.watch event');
    });
    tskedWatcher.on('error', err => log(`[TSKED WATCHER ERROR] ${err.message}`));
    log(`TSKED watcher started on ${tskedPath}`);
  } catch (e) {
    log(`[TSKED WATCHER START FAIL] ${e.message}`);
  }
}

function startClsWatcher() {
  if (!config) return;
  const clsDir = config.clsDir || DEFAULT_CLS_DIR;
  try {
    clsWatcher = fs.watch(clsDir, { persistent: true }, (eventType, filename) => {
      if (!filename) return;
      if (!classIdFromFilename(filename)) return;
      scheduleClsPost(filename);
    });
    clsWatcher.on('error', err => log(`[CLS WATCHER ERROR] ${err.message}`));
    log(`CLS watcher started on ${clsDir}`);
  } catch (e) {
    log(`[CLS WATCHER START FAIL] ${clsDir}: ${e.message}`);
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
    lines.push(`.cls posts: ${clsPostCount} ok, ${clsPostFailCount} failed`);
    if (lastClsPostFile) {
      const clsAge = Math.floor((Date.now() - lastClsPostAt) / 1000);
      lines.push(`Last .cls: ${lastClsPostFile} (${clsAge}s ago)`);
    }
    lines.push(`tsked: ${tskedPostCount} posts, ${tskedSkipCount} skipped (no-op)`);
    if (tskedLastPostAt) {
      const tAge = Math.floor((Date.now() - tskedLastPostAt) / 1000);
      lines.push(`Last tsked POST: ${tAge}s ago`);
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
    { label: 'Re-sync all .cls now', click: async () => { await syncAllCls(); updateTray(); } },
    { label: 'Re-send tsked.csv now', click: async () => {
        tskedLastHash = null; // bust cache
        await postTskedIfChanged('manual');
        updateTray();
    }},
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

  // .cls watching: startup sync + live watcher for subsequent changes
  startClsWatcher();
  syncAllCls().then(updateTray).catch(e => log(`[SYNC UNCAUGHT] ${e.message}`));

  // tsked watching: send current content at startup, then on content changes
  startTskedWatcher();
  postTskedIfChanged('startup').then(updateTray).catch(e => log(`[TSKED STARTUP UNCAUGHT] ${e.message}`));

  // Tray tooltip refreshes tick between heartbeats so "Xs ago" stays current
  setInterval(updateTray, 2000);
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
