// WEST v3 Engine — main process.
//
// Responsibilities (today):
//   - Reads c:\west\v3\config.json (slug, ringNum, workerUrl, authKey)
//   - Heartbeats /v3/engineHeartbeat every 10s
//   - Watches C:\Ryegate\Jumper\Classes\*.cls — POSTs additions/edits,
//     soft-deletes via /v3/deleteCls when a file disappears
//   - Watches C:\Ryegate\Jumper\tsked.csv (content-hash gated, no-op skip
//     when Ryegate just touches mtime)
//   - Tray icon + tooltip
//   - Operator window (renderer/) with show/ring switcher, status pane,
//     event log, manual controls
//
// What it does NOT do yet (Track A — UDP integration coming in S42):
//   - UDP capture on Ryegate scoring port (4950)
//   - Port 31000 focus-signal listener
//   - Forwarding to RSServer port+1
//   - Posting parsed UDP events to /v3/postUdpEvent
//
// Window-lifecycle rules (locked in S42 spec):
//   - Tray click → open or focus window
//   - Minimize button → hide to tray
//   - X button → confirm dialog: Yes (quit) / No (cancel) / Minimize to tray
//   - Tray menu has explicit "Exit" — only "real" way to quit besides
//     the X-dialog "Yes" branch.
//
// Config file shape (c:\west\v3\config.json):
//   {
//     "workerUrl":  "https://west-worker.bill-acb.workers.dev",
//     "authKey":    "west-scoring-2026",
//     "showSlug":   "v3-smoke-test-2026-04",   // can be empty after S42 — picker writes it
//     "ringNum":    1                          // can be empty after S42 — picker writes it
//   }

const { app, Tray, Menu, BrowserWindow, ipcMain, dialog, nativeImage, shell } = require('electron');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sbFunnel = require('./scoreboard-funnel');

const ENGINE_VERSION = '3.0.1';
const CONFIG_PATH = 'c:\\west\\v3\\config.json';
const LOG_PATH = 'c:\\west\\v3\\engine_log.txt';
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_CLS_DIR = 'C:\\Ryegate\\Jumper\\Classes';
const DEFAULT_TSKED_PATH = 'C:\\Ryegate\\Jumper\\tsked.csv';
const DEFAULT_RYEGATE_CONF = 'C:\\Ryegate\\Jumper\\config.dat';
const FOCUS_PORT = 31000;        // fixed — Ryegate's selection-signal channel
const FALLBACK_INPUT_PORT = 29696; // default when config.dat unreadable
const CLS_DEBOUNCE_MS = 2000;
const CLS_STARTUP_SYNC_DELAY_MS = 150;
const TSKED_DEBOUNCE_MS = 2000;
const STATE_PUSH_THROTTLE_MS = 250; // never push faster than 4Hz; renderer ticks "Xs ago" on its own
const RECENT_EVENTS_MAX = 50;
const EVENT_BATCH_INTERVAL_MS = 250; // Phase 3a — batch UDP events for the worker pipe

let tray = null;
let win = null;
let isQuitting = false;          // set true when operator confirms exit
let config = null;
let configError = null;

let lastHeartbeatAt = 0;
let lastHeartbeatOk = false;
let lastHeartbeatError = null;
let heartbeatCount = 0;
let heartbeatFailCount = 0;
let authStatus = 'unknown';      // 'ok' | 'fail' | 'unknown'
let showLocked = false;          // worker returned 423 — pause writes

let clsPostCount = 0;
let clsPostFailCount = 0;
let lastClsPostAt = 0;
let lastClsPostFile = null;
let lastClsPostError = null;
let clsWatcher = null;
const clsDebounceTimers = new Map();

let tskedWatcher = null;
let tskedDebounceTimer = null;
let tskedLastHash = null;
let tskedPostCount = 0;
let tskedSkipCount = 0;
let tskedLastPostAt = 0;
let tskedLastError = null;

// UDP placeholders — fields exist so renderer doesn't have to special-case.
// Real values land when the listeners get wired up later in S42.
let udpListening = false;
let udpFrameCount = null;
let lastUdpAt = 0;
let lastFocusAt = 0;
let currentFocus = null;         // { classId, className, meta, at }
let rsserverConnected = false;
// Pass-through (UDP IN → RSServer relay) is read from config.passthrough,
// defaults true if missing. Persists across reboots — multi-PC setups want
// the scoring box to remember it's pass-through-off, downstream box to
// remember it's pass-through-on.
let liveScoringPaused = false;   // Top bar — pauses ALL worker writes
const recentEvents = [];         // newest first; capped at RECENT_EVENTS_MAX

// Phase 3a — UDP event batcher. Events from both channels queue here and
// flush every EVENT_BATCH_INTERVAL_MS. The flush handler logs locally AND
// (Chunk 3) POSTs to /v3/postUdpEvent. Gated by liveScoringPaused +
// showLocked + configReady — same pattern as postCls / postTsked.
const udpEventBatch = [];
let udpEventBatchTimer = null;
let udpBatchFlushCount = 0;        // # of batches flushed since boot
let udpBatchEventCount = 0;        // # of events queued since boot
let udpLastBatchAt = 0;
let udpLastBatchSize = 0;
let udpBatchPostOkCount = 0;       // # of successful POSTs
let udpBatchPostFailCount = 0;     // # of failed POSTs
let udpBatchEventsInserted = 0;    // sum of events_inserted reported by worker
let udpLastPostAt = 0;
let udpLastPostError = null;

// Port auto-detection — read Ryegate's config.dat col[1] like v2 funnel does.
// detectedInputPort is recomputed on config load; the renderer shows it
// read-only in Settings + Scoreboard tabs.
let detectedInputPort = FALLBACK_INPUT_PORT;

// Per-frame sample of the raw payload so the operator can inspect what's
// in the frame when describing unknown tags. Keyed `${ch}:${fr}` —
// channel + frame number. Truncated to keep the state push light.
const FRAME_SAMPLE_MAX_LEN = 600;
const lastFrameSamples = {};   // { 'A:1': { at, text }, 'B:*': {...}, ... }
// Frozen sample of the EXACT packet that triggered each discovery.
// Useful when the unknown tag only appears intermittently — the regular
// lastFrameSamples might overwrite with a packet that lacks it. Keyed
// the same way: 'A:fr' for frame discoveries, 'A:fr:tag' for tags.
const discoverySamples = {};

// UDP sockets — created by startUdpListeners(), torn down by stop.
let udpInSocket    = null;     // Channel A — Ryegate scoreboard frames in
let udpOutSocket   = null;     // shared sender for forwarding to RSServer
let udpFocusSocket = null;     // Channel B — port 31000 focus signal
const holdState = sbFunnel.createHoldTargetState();
let tenthState = null;         // built per startUdpListeners — needs send target

// What we expect to see in normal operation. Anything outside these sets
// fires the discovery pipeline (renderer auto-adds entries with "auto"
// badge). Mirrors the renderer-side DEFAULT_MAP — keep in sync.
const KNOWN_FRAMES_A = new Set([0, 1, 11, 12, 13, 14, 15, 16]);
const KNOWN_TAGS_BY_FRAME_A = {
  0:  new Set([1]),
  1:  new Set([1, 2, 3, 4, 5, 8, 13, 14, 15, 17, 18, 19, 23]),
  11: new Set([1, 2, 3, 4, 5, 6, 7, 14, 15, 17, 18, 19, 20]),
  12: new Set([1, 2, 3, 8, 14, 21, 22, 23, 24, 25, 26]),  // 21+ judges expected
  13: new Set([1, 2, 3]),
  14: new Set([1, 2, 3, 4, 8, 14]),
  15: new Set([1, 2, 3]),
  16: new Set([1, 2, 3, 8, 11, 14, 15, 21, 22, 23, 24, 25, 26]),  // {11/14/25} are page-dependent; {23/24/26} expected for additional judges
};
// Channel B (31000) tags are constant regardless of the {fr} number Ryegate
// reports — per UDP-PROTOCOL-REFERENCE.md the {fr} on 31000 isn't meaningful.
const KNOWN_TAGS_FOCUS = new Set([26, 27, 28]);

const startedAt = Date.now();

// ── Logging ─────────────────────────────────────────────────────────────────
const LOG_MAX_BYTES = 50 * 1024 * 1024;  // rotate at 50MB
const LOG_CHECK_INTERVAL_LINES = 5000;    // amortize size check across writes
let logLinesSinceCheck = 0;

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < LOG_MAX_BYTES) return;
    const backup = LOG_PATH + '.1';
    try { fs.unlinkSync(backup); } catch (e) {}
    fs.renameSync(LOG_PATH, backup);
  } catch (e) {
    // file doesn't exist or can't stat — both fine, log() will create it
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    if (++logLinesSinceCheck >= LOG_CHECK_INTERVAL_LINES) {
      logLinesSinceCheck = 0;
      rotateLogIfNeeded();
    }
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch (e) {}
}

// ── Config ──────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    // workerUrl + authKey are ALWAYS required — no UI to set them.
    // showSlug + ringNum can be empty — the picker writes them at runtime.
    const missing = [];
    if (!cfg.workerUrl) missing.push('workerUrl');
    if (!cfg.authKey)   missing.push('authKey');
    if (missing.length) throw new Error(`Missing config fields: ${missing.join(', ')}`);
    // Treat empty-string slug or zero ringNum as "no show selected".
    if (!cfg.showSlug || cfg.ringNum === undefined || cfg.ringNum === null || cfg.ringNum === '') {
      config = { workerUrl: cfg.workerUrl, authKey: cfg.authKey, showSlug: null, ringNum: null, showName: null,
                 clsDir: cfg.clsDir, tskedPath: cfg.tskedPath, ryegateConfPath: cfg.ryegateConfPath,
                 runningTenth: cfg.runningTenth, holdTarget: cfg.holdTarget,
                 liveRunningTenth: cfg.liveRunningTenth,
                 passthrough: cfg.passthrough, autoStart: cfg.autoStart };
      configError = null;
      detectedInputPort = detectInputPort();
      log(`Config loaded — no show selected yet (input port ${detectedInputPort}).`);
      return;
    }
    config = cfg;
    configError = null;
    detectedInputPort = detectInputPort();
    log(`Config loaded: ${cfg.workerUrl} slug=${cfg.showSlug} ring=${cfg.ringNum} (input port ${detectedInputPort})`);
  } catch (e) {
    configError = e.message;
    config = null;
    log(`[CONFIG ERROR] ${e.message}`);
  }
}

function writeConfig(updates) {
  // Read-modify-write so we don't clobber unknown future fields.
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  Object.assign(cfg, updates);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\r\n', 'utf8');
}

function configReady() {
  return !!(config && config.showSlug && Number.isFinite(config.ringNum));
}

// ── Updater ────────────────────────────────────────────────────────────────
// Polls /v3/engineLatest on boot + every UPDATE_CHECK_INTERVAL_MS. If the
// manifest's version > ENGINE_VERSION, sets updateState.available so the
// renderer can surface "Update available." On install:
//   1. Download asar to c:\west\v3\update.asar.tmp
//   2. Verify SHA-256 against manifest
//   3. Move to resources/app.asar.new
//   4. Write a swap batch to c:\west\v3\update-swap.bat
//   5. Spawn batch detached, exit engine
//   6. Batch waits 2s (gives OS time to release asar lock), renames
//      app.asar.new → app.asar, relaunches WestEngine.exe, self-deletes.
//
// Why a batch helper: app.asar is mapped into the running process and
// can't be replaced from inside the same process on Windows. A separate
// shell invocation handles the swap after the engine has exited.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
let updateState = {
  checking:       false,
  available:      false,
  latestVersion:  null,
  releaseNotes:   '',
  asarUrl:        null,
  sha256:         null,
  lastCheckAt:    0,
  lastCheckError: null,
  installing:     false,
  installError:   null,
};

// Strip pre-release suffixes (e.g. "-dev") for version comparison. A
// numbered release is always considered newer than a pre-release of the
// same numeric tuple (3.0.0 > 3.0.0-dev).
function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  const parse = v => String(v).replace(/-.*$/, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  // Same numeric tuple: latest is newer iff current has a pre-release
  // tag and latest doesn't.
  return /-/.test(current) && !/-/.test(latest);
}

async function checkForUpdate() {
  if (!configReady() || !config.workerUrl || !config.authKey) return;
  updateState.checking = true;
  pushState();
  try {
    const res = await fetch(`${config.workerUrl}/v3/engineLatest`, {
      headers: { 'X-West-Key': config.authKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const m = data && data.manifest;
    if (!m || !m.version) throw new Error('Bad manifest shape');
    updateState.lastCheckAt    = Date.now();
    updateState.lastCheckError = null;
    if (isNewerVersion(m.version, ENGINE_VERSION) && m.asarUrl && m.sha256) {
      updateState.available     = true;
      updateState.latestVersion = m.version;
      updateState.releaseNotes  = m.releaseNotes || '';
      updateState.asarUrl       = m.asarUrl;
      updateState.sha256        = m.sha256;
    } else {
      updateState.available = false;
    }
  } catch (e) {
    updateState.lastCheckError = e.message;
    log(`[UPDATE] check failed: ${e.message}`);
  } finally {
    updateState.checking = false;
    pushState();
  }
}

async function installUpdate() {
  if (!app.isPackaged) {
    return { ok: false, error: 'Updates only run on packaged builds (npm start = dev mode)' };
  }
  if (!updateState.available || !updateState.asarUrl || !updateState.sha256) {
    return { ok: false, error: 'No update available' };
  }
  updateState.installing = true;
  updateState.installError = null;
  pushState();
  try {
    log(`[UPDATE] downloading ${updateState.asarUrl}`);
    const res = await fetch(updateState.asarUrl);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash.toLowerCase() !== updateState.sha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch (expected ${updateState.sha256}, got ${hash})`);
    }
    log(`[UPDATE] download OK (${buf.length} bytes, sha256 verified)`);

    const resourcesDir = process.resourcesPath;
    const newAsarPath  = path.join(resourcesDir, 'app.asar.new');
    const asarPath     = path.join(resourcesDir, 'app.asar');
    fs.writeFileSync(newAsarPath, buf);

    const swapBatPath = 'c:\\west\\v3\\update-swap.bat';
    const enginePath  = process.execPath;
    const batchContent = [
      '@echo off',
      'ping 127.0.0.1 -n 3 > nul 2>&1',
      `move /Y "${newAsarPath}" "${asarPath}"`,
      `start "" "${enginePath}"`,
      '(goto) 2>nul & del "%~f0"',
    ].join('\r\n');
    fs.mkdirSync(path.dirname(swapBatPath), { recursive: true });
    fs.writeFileSync(swapBatPath, batchContent, 'utf8');

    log(`[UPDATE] launching swap helper, exiting`);
    const child = spawn('cmd.exe', ['/c', swapBatPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    setTimeout(() => app.exit(0), 200);
    return { ok: true };
  } catch (e) {
    updateState.installError = e.message;
    updateState.installing = false;
    log(`[UPDATE] install failed: ${e.message}`);
    pushState();
    return { ok: false, error: e.message };
  }
}

// ── Health watchdog ────────────────────────────────────────────────────────
// Runs every WATCHDOG_INTERVAL_MS, inspects each subsystem, and recovers
// the ones that have gone silent. Targets the failure modes the engine
// can self-diagnose:
//   - UDP IN socket null/unbound  → re-bind via startUdpListeners()
//   - UDP FOCUS socket null       → re-bind (same call rebuilds both)
//   - CLS watcher null            → recreate via startClsWatcher()
//   - TSKED watcher null          → recreate via startTskedWatcher()
//   - heartbeat failing > 90s     → flag degraded (no recovery action;
//     network/worker problem, retries already in flight)
const WATCHDOG_INTERVAL_MS = 30_000;
const HEARTBEAT_DEGRADED_AFTER_MS = 90_000;
let watchdogInterval = null;
let watchdogState = {
  lastCheckAt: 0,
  recoveriesPerformed: 0,
  recentRecoveries: [],   // newest first, capped 10
  degraded: [],           // strings — current degraded-but-not-recoverable issues
};

function watchdogTick() {
  watchdogState.lastCheckAt = Date.now();
  const issues = [];
  const recoveries = [];

  // UDP IN socket — engine SHOULD be listening regardless of show selection.
  // udpListening flag is set by the 'listening' event; null socket OR
  // false flag means we're not.
  if (!udpInSocket || !udpListening) {
    issues.push('UDP IN socket not bound');
    try {
      log(`[WATCHDOG] UDP listeners stuck — re-binding`);
      startUdpListeners();
      recoveries.push('udp-rebind');
    } catch (e) {
      log(`[WATCHDOG] UDP re-bind failed: ${e.message}`);
    }
  } else if (!udpFocusSocket) {
    // udpInSocket OK but focus socket gone — single-side recovery requires
    // a full rebind since startUdpListeners is the only path that builds both.
    issues.push('UDP FOCUS socket gone');
    try {
      log(`[WATCHDOG] FOCUS socket gone — re-binding`);
      startUdpListeners();
      recoveries.push('udp-rebind');
    } catch (e) {
      log(`[WATCHDOG] UDP re-bind failed: ${e.message}`);
    }
  }

  // Watchers — only meaningful when a show is selected. CLS + TSKED watchers
  // are torn down to null on stop; if we have a show but they're null,
  // recover.
  if (configReady()) {
    if (!clsWatcher) {
      issues.push('CLS watcher gone');
      try {
        log(`[WATCHDOG] CLS watcher gone — restarting`);
        startClsWatcher();
        if (clsWatcher) recoveries.push('cls-watcher');
      } catch (e) {
        log(`[WATCHDOG] CLS watcher restart failed: ${e.message}`);
      }
    }
    if (!tskedWatcher) {
      issues.push('TSKED watcher gone');
      try {
        log(`[WATCHDOG] TSKED watcher gone — restarting`);
        startTskedWatcher();
        if (tskedWatcher) recoveries.push('tsked-watcher');
      } catch (e) {
        log(`[WATCHDOG] TSKED watcher restart failed: ${e.message}`);
      }
    }
  }

  // Heartbeat health — degraded but not auto-recoverable. If lastHeartbeatOk
  // is old, surface it. The heartbeat interval is already retrying.
  const heartbeatAge = lastHeartbeatAt ? (Date.now() - lastHeartbeatAt) : Infinity;
  if (configReady() && lastHeartbeatAt && !lastHeartbeatOk && heartbeatAge > HEARTBEAT_DEGRADED_AFTER_MS) {
    issues.push(`heartbeat failing for ${Math.floor(heartbeatAge / 1000)}s`);
  }

  watchdogState.degraded = issues;
  if (recoveries.length) {
    watchdogState.recoveriesPerformed += recoveries.length;
    watchdogState.recentRecoveries = [
      { at: Date.now(), actions: recoveries },
      ...watchdogState.recentRecoveries,
    ].slice(0, 10);
    pushState();
  }
}

function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    try { watchdogTick(); }
    catch (e) { log(`[WATCHDOG] tick threw: ${e.message}`); }
  }, WATCHDOG_INTERVAL_MS);
}

// Backfill the friendly show name when configReady() but showName is missing
// (engines that selected their show before showName was tracked). One-shot
// fetch on startup; failure is silent — the slug still renders, name fills
// in next time the operator opens the picker.
async function backfillShowNameIfMissing() {
  if (!configReady() || config.showName) return;
  try {
    const res = await fetch(`${config.workerUrl}/v3/listShows`, {
      headers: { 'X-West-Key': config.authKey },
    });
    if (!res.ok) return;
    const data = await res.json();
    const found = (data.shows || []).find(s => s.slug === config.showSlug);
    if (found && found.name) {
      writeConfig({ showName: found.name });
      loadConfig();
      log(`Backfilled show name: ${found.name}`);
      pushState();
    }
  } catch (e) {
    // ignore — best-effort
  }
}

// Auto-start on Windows boot — config.autoStart is the source of truth.
// applyAutoStartFromConfig syncs Windows' login items with our config.
// Defaults FALSE so existing installs don't surprise the operator with
// a new auto-launch entry; opt-in via the Settings tab.
function isAutoStartEnabled() {
  return !!(config && (config.autoStart === true || config.autoStart === 1));
}
function applyAutoStartFromConfig() {
  try {
    app.setLoginItemSettings({
      openAtLogin: isAutoStartEnabled(),
      // Args could include '--hidden' if we ever want silent boot-up to tray,
      // but for now first launch shows the window so the operator sees state.
    });
  } catch (e) {
    log(`[AUTOSTART] failed to apply: ${e.message}`);
  }
}

// Pass-through (UDP → RSServer relay) defaults TRUE — operator opts OUT
// to defer fan-out to a downstream PC. Persisted in config.json.
function isPassthroughEnabled() {
  return !(config && (config.passthrough === false || config.passthrough === 0));
}

// Mirrors v2 funnel detectInputPort — col[1] of config.dat row 0 is Ryegate's
// scoreboard output port. Default 29696 if the file's missing or malformed.
function detectInputPort() {
  const ryegatePath = (config && config.ryegateConfPath) || DEFAULT_RYEGATE_CONF;
  try {
    const content = fs.readFileSync(ryegatePath, 'utf8');
    const firstLine = (content.split(/\r?\n/)[0] || '').trim();
    // Lightweight CSV parse — handles quoted/unquoted col[1].
    const cols = firstLine.split(',').map(s => s.replace(/^"|"$/g, '').trim());
    const port = parseInt(cols[1], 10);
    if (port && port > 0 && port < 65536) return port;
  } catch (e) {
    log(`[CONFIG] could not read ${ryegatePath}: ${e.message}`);
  }
  log(`[CONFIG] falling back to default input port ${FALLBACK_INPUT_PORT}`);
  return FALLBACK_INPUT_PORT;
}

// ── State push to renderer ──────────────────────────────────────────────────
let stateThrottleTimer = null;
function pushState() {
  if (stateThrottleTimer) return;
  stateThrottleTimer = setTimeout(() => {
    stateThrottleTimer = null;
    if (!win || win.isDestroyed()) return;
    const state = buildStateSnapshot();
    win.webContents.send('state', state);
  }, STATE_PUSH_THROTTLE_MS);
}

function buildStateSnapshot() {
  return {
    engineVersion: ENGINE_VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    config: configReady() ? { showSlug: config.showSlug, ringNum: config.ringNum, showName: config.showName || null } : null,
    configError,
    authStatus,
    showLocked,
    lastHeartbeatAt, lastHeartbeatOk, lastHeartbeatError, heartbeatCount, heartbeatFailCount,
    clsPostCount, clsPostFailCount, lastClsPostAt, lastClsPostFile, lastClsPostError,
    tskedPostCount, tskedSkipCount, tskedLastPostAt, tskedLastError,
    udpListening, udpFrameCount, lastUdpAt, lastFocusAt,
    udpBatchFlushCount, udpBatchEventCount, udpLastBatchAt, udpLastBatchSize,
    udpBatchPostOkCount, udpBatchPostFailCount, udpBatchEventsInserted,
    udpLastPostAt, udpLastPostError,
    currentFocus,
    rsserverConnected, passthrough: isPassthroughEnabled(), liveScoringPaused,
    watchdog: {
      lastCheckAt: watchdogState.lastCheckAt,
      recoveriesPerformed: watchdogState.recoveriesPerformed,
      recentRecoveries: watchdogState.recentRecoveries,
      degraded: watchdogState.degraded,
    },
    update: { ...updateState },
    recentEvents: recentEvents.slice(0, RECENT_EVENTS_MAX),
    // Settings — what the renderer's settings pane edits. Defaults applied
    // here so empty config.json fields render as the defaults rather than
    // blank inputs. Ports are auto-detected (not editable) per v2 funnel rule.
    settings: config ? {
      clsDir:          config.clsDir          || DEFAULT_CLS_DIR,
      tskedPath:       config.tskedPath       || DEFAULT_TSKED_PATH,
      ryegateConfPath: config.ryegateConfPath || DEFAULT_RYEGATE_CONF,
      inputPort:       detectedInputPort,
      rsserverPort:    detectedInputPort + 1,
      focusPort:       FOCUS_PORT,
      workerUrl:       config.workerUrl       || '',
      authKey:         config.authKey         || '',
    } : null,
    // Scoreboard feature flags — funnel-side toggles. Persisted in config.json.
    // HOLD target state machine lives in scoreboard-funnel.js with the v2 bug
    // fix baked in (empty {18} clears, class change clears).
    features: config ? {
      runningTenth:     !!(config.runningTenth     === 1 || config.runningTenth     === true),
      holdTarget:       !!(config.holdTarget       === 1 || config.holdTarget       === true),
      // liveRunningTenth defaults to TRUE — operator opts OUT to get
      // whole-seconds-only on the public live page (per Bill 2026-05-02).
      liveRunningTenth: !(config.liveRunningTenth === false || config.liveRunningTenth === 0),
      autoStart:        isAutoStartEnabled(),
    } : null,
    // Per-frame raw samples — last packet seen for each (channel, frame)
    // pair, truncated. Renderer surfaces these on the Protocol tab so the
    // operator can inspect raw bytes while describing unknown tags.
    frameSamples: lastFrameSamples,
    // Frozen samples of the EXACT packet that first triggered each
    // discovery, keyed `${ch}:${fr}` for frame discoveries and
    // `${ch}:${fr}:${tag}` for tag discoveries. Useful when the
    // unknown tag only shows up on intermittent packets.
    discoverySamples,
  };
}

function recordEvent(type, detail) {
  recentEvents.unshift({ at: Date.now(), type, detail });
  if (recentEvents.length > RECENT_EVENTS_MAX) recentEvents.length = RECENT_EVENTS_MAX;
  pushState();
}

// ── PROTOCOL DISCOVERY HOOKS ────────────────────────────────────────────────
// Called by the UDP listener (when wired in S42) any time a frame number or
// tag arrives that isn't in the renderer's protocol map. Renderer auto-adds
// the entry with an "auto-discovered" badge so the operator can document it
// post-show. seenFrames / seenTags suppress repeats so we don't spam the
// renderer for every packet of the same unknown frame.
const seenDiscoveredFrames = new Set();   // `${ch}:${fr}`
const seenDiscoveredTags   = new Set();   // `${ch}:${fr}:${tag}`

// Capture a printable sample of a frame so the operator can inspect raw
// payload when working out an unknown tag. Non-printable bytes are
// rendered as \xNN escapes so the operator can still see structure.
function saveFrameSample(ch, fr, msg) {
  lastFrameSamples[`${ch}:${fr}`] = sampleFrameText(msg);
}

function reportDiscoveredFrame(ch, fr, msg) {
  const key = `${ch}:${fr}`;
  if (seenDiscoveredFrames.has(key)) return;
  seenDiscoveredFrames.add(key);
  if (msg) discoverySamples[key] = sampleFrameText(msg);
  log(`[DISCOVERY] new frame ${ch}:{fr}=${fr}`);
  recordEvent('unknown', `discovered frame ${ch}:{fr}=${fr}`);
  if (win && !win.isDestroyed()) win.webContents.send('discovered-frame', { ch, fr });
}

function reportDiscoveredTag(ch, fr, tag, msg) {
  const key = `${ch}:${fr}:${tag}`;
  if (seenDiscoveredTags.has(key)) return;
  seenDiscoveredTags.add(key);
  if (msg) discoverySamples[key] = sampleFrameText(msg);
  log(`[DISCOVERY] new tag ${ch}:{fr}=${fr}:{${tag}}`);
  recordEvent('unknown', `discovered tag ${ch}:{fr}=${fr}:{${tag}}`);
  if (win && !win.isDestroyed()) win.webContents.send('discovered-tag', { ch, fr, tag });
}

// Pure helper extracted from saveFrameSample — turn a buffer into the
// printable-with-escapes text we surface to the renderer.
function sampleFrameText(msg) {
  const ascii = msg.toString('ascii');
  let text = '';
  for (let i = 0; i < ascii.length && text.length < FRAME_SAMPLE_MAX_LEN; i++) {
    const c = ascii.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) text += ascii[i];
    else if (c === 0x0d) text += '\\r';
    else if (c === 0x0a) text += '\\n';
    else text += '\\x' + c.toString(16).padStart(2, '0');
  }
  if (msg.length > FRAME_SAMPLE_MAX_LEN) text += ' …(truncated)';
  return { at: Date.now(), text };
}

// Single gate for any operation that would write to the worker. Live-scoring
// pause is the operator's emergency mute switch — when set, every outbound
// write becomes a no-op (logged once per call site so the operator can see
// what would have been sent).
function workerWritesAllowed() {
  return !liveScoringPaused;
}

// ── HTTP helper — captures auth + lock state across all worker calls ────────
async function workerFetch(path, opts) {
  const url = config.workerUrl + path;
  const res = await fetch(url, opts);
  // Non-JSON 4xx (rare) — capture status only
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401) authStatus = 'fail';
  else authStatus = 'ok';
  if (res.status === 423 || data.locked === true) {
    if (!showLocked) {
      showLocked = true;
      log(`[LOCK] Worker returned locked=true. Engine pausing writes for ${config.showSlug}.`);
      pushState();
    }
  } else if (res.ok) {
    if (showLocked) {
      showLocked = false;
      log(`[LOCK] Lock cleared on next OK response.`);
      pushState();
    }
  }
  return { res, data };
}

// ── .cls posting ────────────────────────────────────────────────────────────
function classIdFromFilename(filename) {
  if (!filename.toLowerCase().endsWith('.cls')) return null;
  const base = filename.slice(0, -4);
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(base)) return null;
  return base;
}

async function postClsFile(filename) {
  if (!configReady() || showLocked || !workerWritesAllowed()) return;
  const clsDir = config.clsDir || DEFAULT_CLS_DIR;
  const classId = classIdFromFilename(filename);
  if (!classId) return;
  const full = path.join(clsDir, filename);
  let bytes;
  try { bytes = fs.readFileSync(full); }
  catch (e) { log(`[CLS READ FAIL] ${filename}: ${e.message}`); return; }
  if (!bytes.length) { log(`[CLS SKIP] ${filename}: empty`); return; }
  try {
    const { res, data } = await workerFetch('/v3/postCls', {
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
    if (data.locked) { recordEvent('unknown', `cls ${filename} dropped — show locked`); return; }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    clsPostCount++;
    lastClsPostAt = Date.now();
    lastClsPostFile = filename;
    lastClsPostError = null;
    log(`CLS POST OK ${filename} (${bytes.length} bytes) — total ${clsPostCount}`);
  } catch (e) {
    clsPostFailCount++;
    lastClsPostError = e.message;
    log(`[CLS POST FAIL] ${filename}: ${e.message}`);
  }
  pushState();
}

async function deleteClsOnWorker(filename) {
  if (!configReady() || showLocked || !workerWritesAllowed()) return;
  const classId = classIdFromFilename(filename);
  if (!classId) return;
  try {
    const { res, data } = await workerFetch('/v3/deleteCls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-West-Key': config.authKey },
      body: JSON.stringify({ slug: config.showSlug, ring_num: config.ringNum, class_id: classId }),
    });
    if (data.locked) { recordEvent('unknown', `cls delete ${filename} dropped — show locked`); return; }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    log(`CLS DELETE OK ${filename}`);
  } catch (e) {
    log(`[CLS DELETE FAIL] ${filename}: ${e.message}`);
  }
}

function scheduleClsEvent(filename) {
  const existing = clsDebounceTimers.get(filename);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    clsDebounceTimers.delete(filename);
    const clsDir = config && (config.clsDir || DEFAULT_CLS_DIR);
    const full = clsDir ? path.join(clsDir, filename) : null;
    const exists = full ? fs.existsSync(full) : false;
    if (exists) postClsFile(filename).catch(e => log(`[CLS POST UNCAUGHT] ${filename}: ${e.message}`));
    else        deleteClsOnWorker(filename).catch(e => log(`[CLS DELETE UNCAUGHT] ${filename}: ${e.message}`));
  }, CLS_DEBOUNCE_MS);
  clsDebounceTimers.set(filename, timer);
}

async function syncAllCls() {
  if (!configReady()) return { ok: 0, failed: 0 };
  const clsDir = config.clsDir || DEFAULT_CLS_DIR;
  let entries;
  try { entries = fs.readdirSync(clsDir); }
  catch (e) { log(`[CLS DIR READ FAIL] ${clsDir}: ${e.message}`); return { ok: 0, failed: 0 }; }
  const files = entries.filter(f => classIdFromFilename(f));
  if (!files.length) { log(`CLS sync: no .cls in ${clsDir}`); return { ok: 0, failed: 0 }; }
  log(`CLS sync: ${files.length} .cls files`);
  const beforeOk = clsPostCount;
  const beforeFail = clsPostFailCount;
  for (const f of files) {
    await postClsFile(f);
    await new Promise(r => setTimeout(r, CLS_STARTUP_SYNC_DELAY_MS));
  }
  const ok = clsPostCount - beforeOk;
  const failed = clsPostFailCount - beforeFail;
  log(`CLS sync done — ${ok} ok, ${failed} failed`);
  return { ok, failed };
}

function startClsWatcher() {
  stopClsWatcher();
  if (!configReady()) return;
  const clsDir = config.clsDir || DEFAULT_CLS_DIR;
  try {
    clsWatcher = fs.watch(clsDir, { persistent: true }, (_evt, filename) => {
      if (!filename || !classIdFromFilename(filename)) return;
      scheduleClsEvent(filename);
    });
    clsWatcher.on('error', err => log(`[CLS WATCHER ERROR] ${err.message}`));
    log(`CLS watcher started on ${clsDir}`);
  } catch (e) {
    log(`[CLS WATCHER START FAIL] ${clsDir}: ${e.message}`);
  }
}
function stopClsWatcher() {
  if (clsWatcher) { try { clsWatcher.close(); } catch (e) {} clsWatcher = null; }
}

// ── tsked.csv ───────────────────────────────────────────────────────────────
async function postTskedIfChanged(reason) {
  if (!configReady() || showLocked) return { ok: false, error: 'no show selected or locked' };
  if (!workerWritesAllowed()) return { ok: false, error: 'live scoring paused' };
  const tskedPath = config.tskedPath || DEFAULT_TSKED_PATH;
  let bytes;
  try { bytes = fs.readFileSync(tskedPath); }
  catch (e) { log(`[TSKED READ FAIL] ${tskedPath}: ${e.message}`); return { ok: false, error: e.message }; }
  if (!bytes.length) return { ok: false, error: 'empty file' };
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash === tskedLastHash && reason !== 'manual') {
    tskedSkipCount++;
    pushState();
    return { ok: true, skipped: true };
  }
  try {
    const { res, data } = await workerFetch('/v3/postTsked', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-West-Key': config.authKey,
        'X-West-Slug': config.showSlug,
      },
      body: bytes,
    });
    if (data.locked) { recordEvent('unknown', 'tsked dropped — show locked'); return { ok: false, error: 'locked' }; }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    tskedLastHash = hash;
    tskedPostCount++;
    tskedLastPostAt = Date.now();
    tskedLastError = null;
    log(`TSKED POST OK (${bytes.length}b, ${data.rows_total || '?'} rows) — ${reason}`);
    pushState();
    return { ok: true };
  } catch (e) {
    tskedLastError = e.message;
    log(`[TSKED POST FAIL] ${e.message}`);
    pushState();
    return { ok: false, error: e.message };
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
  stopTskedWatcher();
  if (!configReady()) return;
  const tskedPath = config.tskedPath || DEFAULT_TSKED_PATH;
  try {
    const dir = path.dirname(tskedPath);
    const name = path.basename(tskedPath);
    tskedWatcher = fs.watch(dir, { persistent: true }, (_evt, filename) => {
      if (!filename || filename.toLowerCase() !== name.toLowerCase()) return;
      scheduleTskedPost('fs.watch event');
    });
    tskedWatcher.on('error', err => log(`[TSKED WATCHER ERROR] ${err.message}`));
    log(`TSKED watcher started on ${tskedPath}`);
  } catch (e) {
    log(`[TSKED WATCHER START FAIL] ${e.message}`);
  }
}
function stopTskedWatcher() {
  if (tskedWatcher) { try { tskedWatcher.close(); } catch (e) {} tskedWatcher = null; }
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
async function sendHeartbeat() {
  if (!configReady()) return;
  if (!workerWritesAllowed()) return;
  const payload = {
    slug: config.showSlug,
    ring_num: config.ringNum,
    engine_version: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  };
  try {
    const { res, data } = await workerFetch('/v3/engineHeartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-West-Key': config.authKey },
      body: JSON.stringify(payload),
    });
    if (data.locked) {
      lastHeartbeatAt = Date.now();
      lastHeartbeatOk = false;
      lastHeartbeatError = 'show locked';
      heartbeatFailCount++;
    } else if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    } else {
      lastHeartbeatAt = Date.now();
      lastHeartbeatOk = true;
      lastHeartbeatError = null;
      heartbeatCount++;
      if (heartbeatCount === 1 || heartbeatCount % 60 === 0) {
        log(`Heartbeat OK (${heartbeatCount} total, ${heartbeatFailCount} failed)`);
      }
    }
  } catch (e) {
    lastHeartbeatAt = Date.now();
    lastHeartbeatOk = false;
    lastHeartbeatError = e.message;
    heartbeatFailCount++;
    log(`[HEARTBEAT FAIL] ${e.message}`);
  }
  pushState();
}

// ── UDP LISTENERS ───────────────────────────────────────────────────────────
//
// Two independent sockets. Channel A is the Ryegate scoreboard port (auto-
// detected from config.dat) — frames forward to RSServer at port+1, with
// optional HOLD target injection. Channel B is fixed at 31000 and carries
// operator focus packets (which class / class-complete signals; pending
// Ryegate update will also fire on Hunter INTRO clicks and add a "final"
// tag on Upload Results).

// Pull every {N}value tag out of an ASCII frame. Returns array of
// { n: <int>, v: <string> }. Frames look like:
//   {RYESCR}{fr}11{1}123{2}HORSE{3}RIDER{17}SB MSG
function parseFrameTags(msg) {
  const ascii = msg.toString('ascii');
  const tags = [];
  // Walk via regex — tag = '{<digits>}', value = until next '{' or EOF.
  const re = /\{(\d+)\}([^{]*)/g;
  let m;
  while ((m = re.exec(ascii)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) tags.push({ n, v: m[2] });
  }
  return tags;
}

// Returns the {fr} number if present (the second {N} in a {RYESCR} frame
// is conventionally {fr}), else null. We special-case {fr} because it's
// non-numeric inside the braces ('fr' literal).
function parseFrameNumber(msg) {
  const ascii = msg.toString('ascii');
  const m = ascii.match(/\{fr\}(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ── UDP EVENT BATCHER (Phase 3a Chunk 1) ────────────────────────────────────
//
// Both UDP channels feed parsed events into this queue. Every
// EVENT_BATCH_INTERVAL_MS the queue is drained into a "batch" — that batch
// IS the wire payload that Chunk 3 will POST to /v3/postUdpEvent. Today's
// flush handler logs only.
//
// Article 1 note: lens (jumper / hunter / equitation) is NOT set here. The
// engine knows the focus class_id but not the .cls's classType, so we
// leave lens null and let the worker resolve it via the classes table
// when /v3/postUdpEvent lands. Per-frame meaning still belongs to its
// frame's lens (S42 rule 6) — never inferred cross-frame on the engine
// side.
//
// slug + ring_num are NOT per-event — they ride at the batch level on the
// POST body. stopUdpListeners() drops the in-flight batch on show-switch,
// so a single batch is guaranteed to be slug/ring-uniform.
function makeUdpEvent(channel, frame, tags) {
  return {
    at:       new Date().toISOString(),
    class_id: (currentFocus && currentFocus.classId) || null,
    channel,
    frame:    (frame != null) ? frame : null,
    tags:     Object.fromEntries(tags.map(t => [t.n, t.v])),
  };
}

function enqueueUdpEvent(evt) {
  udpEventBatch.push(evt);
  udpBatchEventCount++;
  if (!udpEventBatchTimer) {
    udpEventBatchTimer = setTimeout(flushUdpEventBatch, EVENT_BATCH_INTERVAL_MS);
  }
}

async function flushUdpEventBatch() {
  udpEventBatchTimer = null;
  if (!udpEventBatch.length) return;
  const batch = udpEventBatch.splice(0, udpEventBatch.length);
  udpBatchFlushCount++;
  udpLastBatchAt = Date.now();
  udpLastBatchSize = batch.length;
  // One-line summary surfaced to engine_log + recent-events. First few
  // batches always logged so the operator can see the cadence kicked in;
  // after that throttle to every 10th to keep the log readable on long runs.
  const aCount = batch.filter(e => e.channel === 'A').length;
  const bCount = batch.length - aCount;
  const first = batch[0];
  const firstHint = first
    ? ` first=${first.channel}` + (first.frame != null ? `:fr=${first.frame}` : '')
    : '';
  const summary = `batch #${udpBatchFlushCount}: ${batch.length} event(s) (A=${aCount} B=${bCount})${firstHint}`;
  if (udpBatchFlushCount <= 5 || udpBatchFlushCount % 10 === 0) {
    log(`[BATCH] ${summary}`);
  }
  recordEvent('batch', summary);

  // Phase 3a Chunk 3 — POST to /v3/postUdpEvent. Same gating pattern as
  // postCls: bail early if no show selected, scoring paused, or lock is
  // cached (the heartbeat carries lock-release detection — when it
  // succeeds, workerFetch clears showLocked and the next batch flows).
  // We DO NOT retry dropped batches: each batch is a 250ms slice of live
  // truth; replaying old events confuses snapshot semantics. The next
  // batch is along in 250ms.
  if (!configReady() || !workerWritesAllowed() || showLocked) return;
  try {
    const { res, data } = await workerFetch('/v3/postUdpEvent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-West-Key': config.authKey,
      },
      body: JSON.stringify({
        slug: config.showSlug,
        ring_num: config.ringNum,
        events: batch,
        // Live page display preferences ride with each batch — operator
        // can flip without page reload. Defaults to TRUE (running tenth
        // on) per Bill 2026-05-02; operator opts OUT to whole seconds.
        live_running_tenth: !(config.liveRunningTenth === false || config.liveRunningTenth === 0),
      }),
    });
    if (data && data.locked) return;             // workerFetch already set showLocked
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    udpBatchPostOkCount++;
    udpBatchEventsInserted += (data.events_inserted || 0);
    udpLastPostAt = Date.now();
    udpLastPostError = null;
  } catch (e) {
    udpBatchPostFailCount++;
    udpLastPostAt = Date.now();
    udpLastPostError = e.message;
    log(`[BATCH POST FAIL] ${e.message}`);
  }
  pushState();
}

function startUdpListeners() {
  stopUdpListeners();
  if (!config) return;
  const inputPort = detectedInputPort;
  const focusPort = FOCUS_PORT;
  const rsserverPort = inputPort + 1;
  const rsserverHost = '127.0.0.1';

  // Shared outbound socket — one ephemeral bind, fan-out via .send().
  udpOutSocket = dgram.createSocket({ type: 'udp4' });
  udpOutSocket.on('error', err => log(`[UDP-OUT ERROR] ${err.message}`));

  // Running-tenth ticker — sends synthesized frames between Ryegate's 1Hz
  // real frames so the scoreboard counts smoothly. Closure captures the
  // current rsserverPort/Host so a settings change rebinds cleanly.
  tenthState = sbFunnel.createRunningTenth({
    sendTo: (buf) => {
      if (!udpOutSocket) return;
      try { udpOutSocket.send(buf, rsserverPort, rsserverHost); } catch (e) {}
    },
  });

  // Channel A — Ryegate scoreboard.
  udpInSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpInSocket.on('error', err => {
    log(`[UDP-IN ERROR] port=${inputPort} ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log(`[UDP-IN] port ${inputPort} in use — expected on the scoring PC if Ryegate's not yet running. Will keep retrying via rebind on next show-switch / settings-save.`);
    }
    udpListening = false;
    pushState();
  });
  udpInSocket.on('listening', () => {
    const a = udpInSocket.address();
    log(`[UDP-IN] listening on ${a.address}:${a.port}`);
    udpListening = true;
    pushState();
  });
  udpInSocket.on('message', (msg) => onChannelA(msg, rsserverHost, rsserverPort));
  try { udpInSocket.bind(inputPort); }
  catch (e) { log(`[UDP-IN BIND FAIL] ${e.message}`); }

  // Channel B — focus signal. Same bind pattern; failure is non-fatal
  // (engine can run without focus tracking).
  udpFocusSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpFocusSocket.on('error', err => log(`[UDP-FOCUS ERROR] ${err.message}`));
  udpFocusSocket.on('listening', () => {
    const a = udpFocusSocket.address();
    log(`[UDP-FOCUS] listening on ${a.address}:${a.port}`);
  });
  udpFocusSocket.on('message', onChannelB);
  try { udpFocusSocket.bind(focusPort); }
  catch (e) { log(`[UDP-FOCUS BIND FAIL] ${e.message}`); }
}

function stopUdpListeners() {
  if (tenthState) { try { tenthState.teardown(); } catch (e) {} tenthState = null; }
  for (const sock of [udpInSocket, udpFocusSocket, udpOutSocket]) {
    if (sock) { try { sock.close(); } catch (e) {} }
  }
  udpInSocket = udpFocusSocket = udpOutSocket = null;
  udpListening = false;
  rsserverConnected = false;
  // Drop the in-flight event batch on teardown — its slug/ring/class_id
  // metadata may be stale once the operator switches show or restarts the
  // listeners. Clean state on the new bind.
  if (udpEventBatchTimer) { clearTimeout(udpEventBatchTimer); udpEventBatchTimer = null; }
  udpEventBatch.length = 0;
}

// Channel A — Ryegate scoreboard frames. Forward to RSServer (with
// HOLD target injection if enabled), record event, fire discovery for
// unknown frames/tags.
function onChannelA(msg, rsserverHost, rsserverPort) {
  udpFrameCount = (udpFrameCount || 0) + 1;
  lastUdpAt = Date.now();

  // Only treat real Ryegate scoreboard frames as content. Anything else is
  // logged but otherwise ignored (we don't want to spam discovery for noise).
  const isScore = sbFunnel.isRyegateScoreFrame(msg);
  const fr = parseFrameNumber(msg);

  // Discovery — only meaningful for Ryegate-shaped frames.
  if (isScore && fr !== null) {
    // Save a sample of this frame so the operator can inspect raw payload
    // when describing unknown tags. One per (ch, fr) — overwritten on the
    // next packet of the same frame.
    saveFrameSample('A', fr, msg);
    if (!KNOWN_FRAMES_A.has(fr)) {
      reportDiscoveredFrame('A', fr, msg);
    } else {
      const knownTags = KNOWN_TAGS_BY_FRAME_A[fr];
      if (knownTags) {
        for (const { n } of parseFrameTags(msg)) {
          if (!knownTags.has(n)) reportDiscoveredTag('A', fr, n, msg);
        }
      }
    }
  }

  // Forward to RSServer — only when pass-through is enabled. Lock state
  // DOES NOT gate forwarding (operator intent for lock is "don't post to
  // worker", local scoreboard should keep working). Pass-through defaults
  // ON; operator opts OUT in Data Settings when a downstream PC handles
  // the fan-out.
  if (isPassthroughEnabled()) {
    let outBuf = msg;
    const holdEnabled  = !!(config && (config.holdTarget   === 1 || config.holdTarget   === true));
    const tenthEnabled = !!(config && (config.runningTenth === 1 || config.runningTenth === true));
    // Compose: HOLD target injection FIRST so its result becomes the base
    // template for tenth interpolation. Tenth replaces {17} on the
    // (possibly-injected) buffer, so synthesized frames carry HOLD too.
    if (holdEnabled && isScore) outBuf = holdState.process(outBuf);
    if (tenthEnabled && tenthState) outBuf = tenthState.process(outBuf);
    else if (tenthState) tenthState.reset();   // disable cleanly if toggled off mid-class
    if (udpOutSocket) {
      udpOutSocket.send(outBuf, rsserverPort, rsserverHost, (err) => {
        if (err) {
          if (rsserverConnected) { log(`[UDP-OUT FAIL] ${err.message}`); pushState(); }
          rsserverConnected = false;
        } else if (!rsserverConnected) {
          rsserverConnected = true;
          pushState();
        }
      });
    }
  }

  // Recent events list — log every nth frame to avoid flooding when
  // Ryegate is firing 1Hz on idle frames, but log every score frame for
  // debugging. Throttle: 1 per second per frame number.
  if (isScore && fr !== null) {
    const tags = parseFrameTags(msg);
    const detail = `fr=${fr}` +
      (tags.slice(0, 3).map(t => ` {${t.n}}=${t.v.slice(0, 12)}`).join(''));
    recordEvent('scoring', detail);
    // Phase 3a Chunk 1 — queue this frame as a batched UDP event. Wire
    // payload only logged today; Chunk 3 wires the worker POST.
    enqueueUdpEvent(makeUdpEvent('A', fr, tags));
  }
  pushState();
}

// Channel B — focus signal. Updates currentFocus state, clears HOLD target
// on class change. Discovery + recent-events.
function onChannelB(msg) {
  lastFocusAt = Date.now();
  // Save sample (one bucket — fr is meaningless on 31000 per the protocol doc).
  saveFrameSample('B', '*', msg);
  const tags = parseFrameTags(msg);
  // Discovery — flag any tag we don't already know on this channel.
  for (const { n } of tags) {
    if (!KNOWN_TAGS_FOCUS.has(n)) reportDiscoveredTag('B', '*', n, msg);
  }
  // Pull class number ({27}) and class name ({28}) — operator-facing signal.
  const t27 = tags.find(t => t.n === 27);
  const t28 = tags.find(t => t.n === 28);
  const t27v = t27 && t27.v.replace(/[\r\n]/g, '').trim();
  const t28v = t28 && t28.v.replace(/[\r\n]/g, '').trim();
  if (t27v) {
    const newClassId = t27v;
    const prev = currentFocus && currentFocus.classId;
    if (newClassId !== prev) {
      // Class changed — HOLD target must clear and the tenth ticker must
      // reset so neither carries state onto the new class's frames.
      holdState.clearForNewClass();
      if (tenthState) tenthState.reset();
    }
    currentFocus = {
      classId: newClassId,
      className: t28v || '',
      meta: '',
      at: Date.now(),
    };
  }
  recordEvent('focus', `class=${t27v || '?'}` + (t28v ? ` name=${t28v}` : ''));
  // Phase 3a Chunk 1 — every focus packet becomes a batched event. Channel
  // B's frame number isn't meaningful (per UDP-PROTOCOL-REFERENCE.md), so
  // we pass null. class_id reflects the post-update focus.
  enqueueUdpEvent(makeUdpEvent('B', null, tags));
  pushState();
}

// ── Tray ────────────────────────────────────────────────────────────────────
function updateTrayTooltip() {
  if (!tray) return;
  const lines = [`WEST Engine v${ENGINE_VERSION}`];
  if (configError) {
    lines.push(`⚠ CONFIG ERROR: ${configError}`);
    lines.push(`Expected: ${CONFIG_PATH}`);
  } else if (configReady()) {
    lines.push(`Show: ${config.showSlug}`);
    lines.push(`Ring: ${config.ringNum}`);
    if (liveScoringPaused) lines.push(`⏸ Live scoring PAUSED`);
    else if (showLocked) lines.push(`🔒 LOCKED — engine writes rejected`);
    else if (lastHeartbeatAt && lastHeartbeatOk) lines.push(`🟢 online (${heartbeatCount} heartbeats)`);
    else if (lastHeartbeatAt) lines.push(`🔴 ${lastHeartbeatError || 'failing'}`);
    else lines.push(`starting…`);
  } else {
    lines.push(`No show selected — click the icon to open the picker.`);
  }
  tray.setToolTip(lines.join('\n'));
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // Tell the renderer to snap back to Status so operators always see
    // the dashboard when bringing the window forward from tray.
    if (win.webContents) win.webContents.send('window-shown');
  }
  pushState();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `WEST Engine v${ENGINE_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Open window', click: showWindow },
    { type: 'separator' },
    { label: 'Reload config', click: () => { loadConfig(); rebindWatchers(); pushState(); updateTrayTooltip(); } },
    { label: 'Send heartbeat now', click: async () => { await sendHeartbeat(); updateTrayTooltip(); } },
    { label: 'Re-sync all .cls now', click: () => { syncAllCls().then(updateTrayTooltip); } },
    { label: 'Re-send tsked.csv now', click: async () => {
        tskedLastHash = null;
        await postTskedIfChanged('manual');
        updateTrayTooltip();
    }},
    { label: 'Open log folder', click: () => shell.openPath(path.dirname(LOG_PATH)) },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

// ── BrowserWindow ───────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 600,
    minHeight: 500,
    title: `WEST Engine v${ENGINE_VERSION}`,
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    pushState();
  });
  // Surface load errors — silent failures otherwise mean white-screen mystery.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`[RENDERER FAIL-LOAD] code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    log(`[RENDERER PRELOAD ERROR] path=${preloadPath} err=${err && err.stack || err}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`[RENDERER PROCESS GONE] reason=${details.reason} exitCode=${details.exitCode}`);
  });

  // X button: confirm dialog with three branches. We always preventDefault
  // first so the window stays put while the dialog blocks. The Yes branch
  // calls app.exit(0) — graceful app.quit() can stall when the close event
  // we just preventDefault'd has marked the window as "close cancelled."
  win.on('close', (e) => {
    if (isQuitting) return; // tray-menu Exit flow — let it close
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Quit engine', 'Minimize to tray', 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
      title: 'Close engine?',
      message: 'Do you want to quit the WEST Engine?',
      detail: 'Quitting stops UDP forwarding to the scoreboard and stops .cls / heartbeat posts to the worker.',
    });
    log(`Close dialog choice=${choice} (0=quit, 1=minimize, 2=cancel)`);
    if (choice === 0) {
      isQuitting = true;
      app.exit(0);              // forceful — skips event chain, exits process
    } else if (choice === 1) {
      win.hide();
    }
    // choice === 2 → cancel, dialog dismissed, window stays open
  });

  // Minimize button → tray (don't show in taskbar)
  win.on('minimize', (e) => {
    e.preventDefault();
    win.hide();
  });
}

// ── IPC handlers ────────────────────────────────────────────────────────────
function setupIpc() {
  ipcMain.on('state-request', () => pushState());

  ipcMain.handle('fetch-shows', async () => {
    if (!config || !config.workerUrl || !config.authKey) {
      throw new Error('Worker URL or auth key missing in config.json');
    }
    const res = await fetch(`${config.workerUrl}/v3/listShows`, {
      headers: { 'X-West-Key': config.authKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Lock state is the single gate. If an operator wants a past show to
    // appear here (e.g. to backfill a correction the morning after), they
    // flip lock_override to 'unlocked' on the website. Don't second-guess
    // with a separate date filter — that would surface as "why isn't my
    // show in the dropdown after I unlocked it" friction.
    const shows = (data.shows || [])
      .filter(s => !s.is_locked)
      .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
    return shows;
  });

  ipcMain.handle('fetch-rings', async (_evt, slug) => {
    const res = await fetch(`${config.workerUrl}/v3/listRings?slug=${encodeURIComponent(slug)}`, {
      headers: { 'X-West-Key': config.authKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.rings || [];
  });

  ipcMain.handle('switch-show', async (_evt, { slug, ring, name }) => {
    writeConfig({ showSlug: slug, ringNum: ring, showName: name || null });
    log(`Switched to ${slug} · Ring ${ring}${name ? ` (${name})` : ''} via picker`);
    loadConfig();
    rebindWatchers();
    showLocked = false;             // re-evaluate against new show
    tskedLastHash = null;            // force re-post on switch
    holdState.clearForNewClass();    // don't carry HOLD target across shows
    currentFocus = null;             // and clear focus context
    pushState();
    updateTrayTooltip();
    // Fire heartbeat + sync immediately so the new pairing is reflected fast
    sendHeartbeat().catch(() => {});
    syncAllCls().catch(() => {});
    postTskedIfChanged('show-switch').catch(() => {});
    return { ok: true };
  });

  // First-run wizard — operator pastes workerUrl + authKey, we validate
  // by hitting /v3/listShows. On success, persist + reload + push state so
  // the renderer's main UI takes over from the wizard.
  ipcMain.handle('check-for-update', async () => {
    await checkForUpdate();
    return { ok: true };
  });

  ipcMain.handle('install-update', async () => {
    return await installUpdate();
  });

  ipcMain.handle('save-credentials', async (_evt, { workerUrl, authKey }) => {
    workerUrl = String(workerUrl || '').trim().replace(/\/$/, '');
    authKey   = String(authKey   || '').trim();
    if (!workerUrl) return { ok: false, error: 'Worker URL is required' };
    if (!/^https?:\/\//i.test(workerUrl)) return { ok: false, error: 'Worker URL must start with http:// or https://' };
    if (!authKey)   return { ok: false, error: 'Auth key is required' };
    try {
      const res = await fetch(`${workerUrl}/v3/listShows`, {
        headers: { 'X-West-Key': authKey },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Auth rejected (HTTP ${res.status}) — check the key` };
      }
      if (!res.ok) return { ok: false, error: `Worker returned HTTP ${res.status}` };
      const data = await res.json();
      if (!data || !Array.isArray(data.shows)) return { ok: false, error: 'Unexpected response from worker' };
    } catch (e) {
      return { ok: false, error: `Connection failed: ${e.message}` };
    }
    writeConfig({ workerUrl, authKey });
    loadConfig();
    log(`Credentials saved — worker=${workerUrl}`);
    pushState();
    return { ok: true };
  });

  ipcMain.handle('clear-show', async () => {
    writeConfig({ showSlug: null, ringNum: null, showName: null });
    log(`Show cleared — engine in pass-through-only mode (if pass-through enabled)`);
    loadConfig();
    showLocked = false;
    tskedLastHash = null;
    holdState.clearForNewClass();
    currentFocus = null;
    pushState();
    updateTrayTooltip();
    return { ok: true };
  });

  ipcMain.handle('repost-cls', async () => {
    return await syncAllCls();
  });

  ipcMain.handle('repost-tsked', async () => {
    tskedLastHash = null;
    return await postTskedIfChanged('manual');
  });

  ipcMain.handle('toggle-forwarding', async () => {
    const next = !isPassthroughEnabled();
    writeConfig({ passthrough: next });
    loadConfig();
    log(`Pass-through ${next ? 'ENABLED' : 'DISABLED'} by operator (saved)`);
    pushState();
    return { passthrough: next };
  });

  ipcMain.handle('save-settings', async (_evt, patch) => {
    // Validate before writing — bad data here would brick the engine.
    // Ports are NOT in this handler — they're auto-detected from
    // config.dat per the v2 funnel rule. Only paths are editable.
    const errors = [];
    const updates = {};
    if (patch.clsDir !== undefined) {
      const v = String(patch.clsDir || '').trim();
      if (!v) errors.push('clsDir cannot be empty');
      else updates.clsDir = v;
    }
    if (patch.tskedPath !== undefined) {
      const v = String(patch.tskedPath || '').trim();
      if (!v) errors.push('tskedPath cannot be empty');
      else updates.tskedPath = v;
    }
    if (patch.ryegateConfPath !== undefined) {
      const v = String(patch.ryegateConfPath || '').trim();
      if (!v) errors.push('ryegateConfPath cannot be empty');
      else updates.ryegateConfPath = v;
    }
    if (errors.length) {
      return { ok: false, error: errors.join('; ') };
    }
    writeConfig(updates);
    log(`Settings saved: ${Object.keys(updates).join(', ')}`);
    loadConfig();             // re-detects port from new config.dat path
    rebindWatchers();
    pushState();
    return { ok: true };
  });

  ipcMain.handle('toggle-live-scoring', async () => {
    liveScoringPaused = !liveScoringPaused;
    log(`Live scoring ${liveScoringPaused ? 'PAUSED' : 'RESUMED'} by operator`);
    pushState();
    updateTrayTooltip();
    if (!liveScoringPaused) {
      // Catching up after a resume — fire heartbeat + sync immediately
      // so the worker sees the engine again rather than waiting for the
      // next interval tick.
      sendHeartbeat().catch(() => {});
      syncAllCls().catch(() => {});
      postTskedIfChanged('resume').catch(() => {});
    }
    return { paused: liveScoringPaused };
  });

  ipcMain.handle('forget-discovered', async (_evt, key) => {
    if (!key || !key.ch || key.fr == null) return { ok: false };
    if (key.tag != null) {
      seenDiscoveredTags.delete(`${key.ch}:${key.fr}:${key.tag}`);
    } else {
      seenDiscoveredFrames.delete(`${key.ch}:${key.fr}`);
      // Also forget any tags we'd recorded under that frame so they
      // re-discover too if the frame comes back.
      for (const k of Array.from(seenDiscoveredTags)) {
        if (k.startsWith(`${key.ch}:${key.fr}:`)) seenDiscoveredTags.delete(k);
      }
    }
    return { ok: true };
  });

  ipcMain.handle('save-feature', async (_evt, { key, value }) => {
    if (!['runningTenth', 'holdTarget', 'liveRunningTenth', 'autoStart'].includes(key)) {
      return { ok: false, error: `unknown feature ${key}` };
    }
    const updates = {};
    updates[key] = !!value;
    writeConfig(updates);
    log(`Feature ${key} = ${!!value} (saved)`);
    loadConfig();
    if (key === 'autoStart') applyAutoStartFromConfig();
    pushState();
    return { ok: true };
  });

  ipcMain.on('open-log', () => shell.openPath(path.dirname(LOG_PATH)));
  ipcMain.on('open-admin', () => {
    const u = config && config.workerUrl ? config.workerUrl : '';
    // Admin lives on Pages preview, not the worker. Hardcoded for now.
    shell.openExternal('https://preview.westscoring.pages.dev/v3/pages/admin.html');
  });
  ipcMain.on('minimize-to-tray', () => { if (win && !win.isDestroyed()) win.hide(); });
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function rebindWatchers() {
  startClsWatcher();
  startTskedWatcher();
  startUdpListeners();
}

// ── Crash recovery — relaunch on uncaught (matches v1.x watcher pattern) ───
// Crash-loop guard: if the engine crashes 3+ times within 60s, stop
// relaunching. The relaunch chain is tracked via a small JSON file in the
// state dir — each crash appends timestamp; on startup we trim entries
// older than the window and check the count before allowing more relaunches.
const CRASH_LOG_PATH = 'c:\\west\\v3\\crash_log.json';
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX = 3;

function readCrashLog() {
  try { return JSON.parse(fs.readFileSync(CRASH_LOG_PATH, 'utf8')) || []; }
  catch (e) { return []; }
}
function writeCrashLog(arr) {
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG_PATH), { recursive: true });
    fs.writeFileSync(CRASH_LOG_PATH, JSON.stringify(arr), 'utf8');
  } catch (e) {}
}
function recordCrashAndShouldRelaunch() {
  const now = Date.now();
  const recent = readCrashLog().filter(t => (now - t) < CRASH_LOOP_WINDOW_MS);
  recent.push(now);
  writeCrashLog(recent);
  return recent.length < CRASH_LOOP_MAX;
}

function handleFatal(label, err) {
  log(`[CRASH] ${label}: ${err && err.stack ? err.stack : err}`);
  if (recordCrashAndShouldRelaunch()) {
    log(`[CRASH] relaunching engine`);
    try { app.relaunch(); } catch (e) {}
    app.exit(1);
  } else {
    log(`[CRASH-LOOP] ${CRASH_LOOP_MAX} crashes within ${CRASH_LOOP_WINDOW_MS / 1000}s — refusing further relaunch. Manual restart required.`);
    app.exit(1);
  }
}
process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));

// ── Single-instance lock ────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => { showWindow(); });

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(() => {
  rotateLogIfNeeded();
  loadConfig();
  applyAutoStartFromConfig();

  const iconPath = path.join(__dirname, 'icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon);
  tray.setToolTip(`WEST Engine v${ENGINE_VERSION} — starting…`);
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showWindow);          // single click → window
  tray.on('double-click', showWindow);   // belt + suspenders

  setupIpc();
  createWindow();

  // First-run: if workerUrl + authKey are populated but show/ring isn't,
  // auto-open the picker once the window is ready. Saves the operator a
  // hunt for the Switch button on their first launch.
  if (config && config.workerUrl && config.authKey && !configReady()) {
    win.once('ready-to-show', () => {
      // Trip the renderer to open its own picker — preload exposes nothing
      // for opening UI from main, so we send a custom event.
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('open-picker');
      }, 400);
    });
  }

  log(`WEST Engine v${ENGINE_VERSION} starting — heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s`);

  // UDP listeners bind regardless of show selection — local scoreboard
  // forwarding works standalone, and operators set up engine + Ryegate
  // before they pick a show in the picker.
  startUdpListeners();

  if (configReady()) {
    sendHeartbeat().then(updateTrayTooltip);
    setInterval(async () => { await sendHeartbeat(); updateTrayTooltip(); }, HEARTBEAT_INTERVAL_MS);
    startClsWatcher();
    startTskedWatcher();
    syncAllCls().then(updateTrayTooltip).catch(e => log(`[SYNC UNCAUGHT] ${e.message}`));
    postTskedIfChanged('startup').catch(e => log(`[TSKED STARTUP UNCAUGHT] ${e.message}`));
    backfillShowNameIfMissing().catch(() => {});
  } else {
    log('No show selected — heartbeat / .cls / tsked watchers paused until picker is used.');
    setInterval(() => {
      if (configReady()) sendHeartbeat().catch(() => {});
      updateTrayTooltip();
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Tray + state-tick refresh — keeps "Xs ago" current for the tray tooltip
  // without spamming the renderer (renderer ticks itself on a 1Hz timer).
  setInterval(() => { updateTrayTooltip(); }, 2000);

  // Health watchdog — recover silent-stuck subsystems. Runs whether or not
  // a show is selected (UDP listeners are show-independent).
  startWatchdog();

  // Periodic update check — initial check after 30s (gives heartbeat time
  // to settle), then hourly.
  setTimeout(() => { checkForUpdate().catch(() => {}); }, 30_000);
  setInterval(() => { checkForUpdate().catch(() => {}); }, UPDATE_CHECK_INTERVAL_MS);
});

app.on('window-all-closed', (e) => {
  if (!isQuitting) e.preventDefault();
});

app.on('before-quit', () => { isQuitting = true; });
