/**
 * WEST Scoring Live — Class File Watcher
 * Watches C:\Ryegate\Jumper\Classes for .cls file changes
 * Logs parsed data to west_log.txt
 *
 * Usage: node west-watcher.js
 * Requirements: Node.js LTS installed on scoring computer
 */

const WATCHER_VERSION = '1.11.0';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

// Persistent connection pool for POSTs to the worker. Reusing a warm TCP/TLS
// socket avoids the ~500-2000ms handshake tax per event on spotty networks.
// One idle connection is kept open for keepAliveMsecs after the last POST.
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 });
const HTTP_AGENT  = new http.Agent ({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 4 });

// ── CRASH PROTECTION ─────────────────────────────────────────────────────────
// Catch any unhandled exceptions/rejections so the watcher never silently dies.
// Log the error and keep running. At a live show, a crashed watcher = no data.
process.on('uncaughtException', (err) => {
  const msg = `[CRASH CAUGHT] uncaughtException: ${err.message}\n${err.stack}`;
  console.error(msg);
  try { fs.appendFileSync(path.join(__dirname, 'west_log.txt'), '[' + new Date().toLocaleTimeString('en-US', { hour12: false }) + '] ' + msg + '\r\n'); } catch(e) {}
});
process.on('unhandledRejection', (reason) => {
  const msg = `[CRASH CAUGHT] unhandledRejection: ${reason}`;
  console.error(msg);
  try { fs.appendFileSync(path.join(__dirname, 'west_log.txt'), '[' + new Date().toLocaleTimeString('en-US', { hour12: false }) + '] ' + msg + '\r\n'); } catch(e) {}
});

const CLASSES_DIR   = 'C:\\Ryegate\\Jumper\\Classes';
const TSKED_PATH    = 'C:\\Ryegate\\Jumper\\tsked.csv';
const CONFIG_PATH   = 'C:\\Ryegate\\Jumper\\config.dat';
// Log next to the watcher script (c:\west\) — consistent across PCs,
// no dependency on Desktop path / OneDrive-synced profile folders.
let LOG_PATH        = path.join(__dirname, 'west_log.txt');
const SNAPSHOTS_DIR = 'C:\\west_snapshots';

// Track previous file states to detect changes
const fileStates = {};

// Track .tod file sizes per class number so we can detect first-time creation
// and subsequent size deltas. A NEW .tod or a grown .tod both mean the operator
// pressed Finish Results / Upload & Close with new data to commit. No-op
// re-presses leave .tod size unchanged and are ignored.
//   todSizes[classNum] = last known byte size (or undefined if never seen)
const todSizes = {};

// ── CLASS COMMIT DEDUPLICATION ────────────────────────────────────────────────
// Multiple signals can detect the same class finalize event (Ctrl+A, peek,
// .tod, idle). This shared timestamp ensures only the FIRST signal fires
// CLASS_COMPLETE. Subsequent signals within the dedup window are ignored.
const lastClassCommitted = {};  // classNum → timestamp ms
const COMMIT_DEDUP_WINDOW = 5 * 60 * 1000; // 5 minutes

function shouldCommit(classNum, source) {
  const t = lastClassCommitted[classNum];
  if (t && (Date.now() - t) < COMMIT_DEDUP_WINDOW) {
    log(`[DEDUP] class ${classNum} already committed ${Math.round((Date.now() - t) / 1000)}s ago — skipping ${source}`);
    return false;
  }
  lastClassCommitted[classNum] = Date.now();
  return true;
}

// ── RYEGATE.LIVE PEEK ────────────────────────────────────────────────────────
// Polls the ryegate.live results page for the active class at randomized
// 15–30s intervals. Detects the LIVE → UPLOADED transition (ON COURSE and
// "X of Y Competed" indicators disappear when Upload Results is pressed).
// This is the universal finalize detector — works for ALL timer brands.
let ryegateLivePath = '';   // set from config.dat cols[4], e.g. "SHOWS/West/2025/..."
let peekTimer = null;
let peekLastState = {};     // classNum → 'NOT_STARTED' | 'LIVE' | 'IN_PROGRESS' | 'UPLOADED' | 'ERROR'
let peekErrorCount = 0;     // consecutive errors — goes dormant after 3

function buildPeekUrl(classNum) {
  if (!ryegateLivePath) return null;
  const livePath = ryegateLivePath.replace(/^SHOWS\//i, '');
  return `https://ryegate.live/${livePath}/results.php?class=${classNum}`;
}

// Returns a rich result: { state, url, httpStatus, bytes, ms, signals, errorKind? }
// Classifier matches real ryegate.live HTML verified 2026-04-15:
//   NOT_STARTED   — "Please Check Back"
//   ORDER_POSTED  — "Order of Go" in header
//   IN_PROGRESS   — "ON COURSE" or "PREVIOUS EXHIBITOR" or "N of N Competed"
//   UPLOADED      — has Plc column + CBody tables AND none of the above
//   UNKNOWN       — page served but matched no rule (also 404 pages)
//   ERROR         — network/timeout/exception
async function peekClass(classNum) {
  const url = buildPeekUrl(classNum);
  if (!url) return { state: null, url: null, httpStatus: 0, bytes: 0, ms: 0, signals: {} };

  const startMs = Date.now();
  try {
    const mod = url.startsWith('https') ? https : http;

    return new Promise((resolve) => {
      const req = mod.get(url, { timeout: 8000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          const ms = Date.now() - startMs;
          const signals = {
            pleaseCheckBack:   (body.match(/please\s+check\s+back/i)        || []).length,
            onCourse:          (body.match(/ON\s+COURSE/i)                   || []).length,
            previousExhibitor: (body.match(/PREVIOUS\s+EXHIBITOR/i)          || []).length,
            orderOfGo:         (body.match(/order\s+of\s+go/i)               || []).length,
            nOfNCompeted:      (body.match(/\d+\s+of\s+\d+\s+Competed/i)     || []).length,
            tableCount:        (body.match(/<table/gi)                       || []).length,
            cbodyCount:        (body.match(/class\s*=\s*"CBody"/gi)           || []).length,
            plcHeader:         (body.match(/>\s*Plc\s*</i)                   || []).length,
          };
          let state;
          if (signals.pleaseCheckBack > 0)                           state = 'NOT_STARTED';
          else if (signals.orderOfGo > 0)                            state = 'ORDER_POSTED';
          else if (signals.onCourse + signals.previousExhibitor + signals.nOfNCompeted > 0)
                                                                     state = 'IN_PROGRESS';
          else if (signals.plcHeader > 0 && signals.cbodyCount > 0)  state = 'UPLOADED';
          else                                                       state = 'UNKNOWN';
          resolve({ state, url, httpStatus: res.statusCode, bytes: body.length, ms, signals });
        });
      });
      req.on('error', (e) => resolve({ state: 'ERROR', url, httpStatus: 0, bytes: 0, ms: Date.now() - startMs, signals: {}, errorKind: 'network:' + (e && e.code || e && e.message || 'unknown') }));
      req.on('timeout', () => { req.destroy(); resolve({ state: 'ERROR', url, httpStatus: 0, bytes: 0, ms: Date.now() - startMs, signals: {}, errorKind: 'timeout' }); });
    });
  } catch(e) {
    return { state: 'ERROR', url, httpStatus: 0, bytes: 0, ms: Date.now() - startMs, signals: {}, errorKind: 'exception:' + (e && e.message || 'unknown') };
  }
}

// Cooldown used after 3 consecutive errors or an UNKNOWN classification.
// Keeps the polling loop alive (self-healing) instead of killing peek for
// the whole session on a transient network hiccup or odd page response.
const PEEK_DORMANT_MS = 5 * 60 * 1000; // 5 minutes

function startPeekPolling(classNum) {
  stopPeekPolling();
  if (!ryegateLivePath) {
    log(`[PEEK] DISABLED class=${classNum} reason=no ryegate.live path in config.dat`);
    peekLog(`DISABLED class=${classNum} reason=no ryegate.live path in config.dat`);
    return;
  }
  // Skip peek for test/nonexistent paths — NONWEST is the default test path
  // that doesn't exist on ryegate.live. Real shows have paths like
  // SHOWS/West/2026/Culpeper/wk1/ring1 with at least 3 path segments.
  var segments = ryegateLivePath.replace(/^SHOWS\//i, '').split('/').filter(Boolean);
  if (segments.length < 3 || /^NONWEST$/i.test(segments[0])) {
    log(`[PEEK] DISABLED class=${classNum} reason=test path (${ryegateLivePath})`);
    peekLog(`DISABLED class=${classNum} reason=test path (${ryegateLivePath})`);
    return;
  }
  const url = buildPeekUrl(classNum);
  log(`[PEEK] READY class=${classNum} path=${ryegateLivePath} url=${url}`);
  peekLog(`READY class=${classNum} path=${ryegateLivePath} url=${url}`);
  peekLastState[classNum] = null;
  peekErrorCount = 0;

  function scheduleNext(delayMsOverride) {
    // Randomized 15–30 second interval — no fixed cadence. Override used
    // for cooldown after error/UNKNOWN.
    const delay = delayMsOverride != null ? delayMsOverride
                                          : (15000 + Math.floor(Math.random() * 15000));
    peekTimer = setTimeout(async () => {
      if (!selectedClassNum || selectedClassNum !== classNum) {
        log(`[PEEK] class ${classNum} no longer active — stopping`);
        peekLog(`STOP class=${classNum} reason=class no longer active`);
        return;
      }

      const result = await peekClass(classNum);
      const state  = result.state;
      const prev   = peekLastState[classNum];
      const sig    = result.signals || {};
      const sigStr = `pleaseCheckBack=${sig.pleaseCheckBack||0} onCourse=${sig.onCourse||0} prevExhibitor=${sig.previousExhibitor||0} orderOfGo=${sig.orderOfGo||0} nOfNCompeted=${sig.nOfNCompeted||0} table=${sig.tableCount||0} cbody=${sig.cbodyCount||0} plc=${sig.plcHeader||0}`;
      peekLog(`POLL class=${classNum} state=${state} prev=${prev||'(init)'} http=${result.httpStatus} bytes=${result.bytes} ms=${result.ms} ${sigStr}${result.errorKind?' err='+result.errorKind:''}`);

      if (state === 'ERROR') {
        peekErrorCount++;
        if (peekErrorCount >= 3) {
          log(`[PEEK] class ${classNum}: 3 consecutive errors — cooling down ${PEEK_DORMANT_MS/60000}min before retry`);
          peekLog(`COOLDOWN class=${classNum} reason=3 consecutive errors delayMs=${PEEK_DORMANT_MS}`);
          peekErrorCount = 0;
          scheduleNext(PEEK_DORMANT_MS);
          return;
        }
        scheduleNext();
        return;
      }
      if (state === 'UNKNOWN' || state === null) {
        log(`[PEEK] class ${classNum}: UNKNOWN page — cooling down ${PEEK_DORMANT_MS/60000}min before retry`);
        peekLog(`COOLDOWN class=${classNum} reason=UNKNOWN classification delayMs=${PEEK_DORMANT_MS}`);
        scheduleNext(PEEK_DORMANT_MS);
        return;
      }
      peekErrorCount = 0; // reset on any successful read

      if (state !== prev) {
        log(`[PEEK] class ${classNum}: ${prev || '(init)'} → ${state}`);
        peekLog(`TRANSITION class=${classNum} ${prev || '(init)'} → ${state}`);
        peekLastState[classNum] = state;
      }

      // Forward ORDER_POSTED state to Worker — live page can show an OOG badge
      if (state === 'ORDER_POSTED' && prev !== 'ORDER_POSTED') {
        postToWorker('/postClassEvent',
          { event: 'ORDER_POSTED', classNum },
          `ORDER_POSTED class ${classNum} (via peek)`);
      }

      // Fire CLASS_COMPLETE on ANY transition INTO UPLOADED. shouldCommit()
      // dedupes against other signals (5-min window) and the worker-side
      // markClassComplete is idempotent, so a restart-storm on an already
      // uploaded class stays contained.
      if (state === 'UPLOADED' && prev !== 'UPLOADED') {
        if (shouldCommit(classNum, 'peek')) {
          let className = '';
          const clsContent = fileStates[classNum + '.cls'];
          if (clsContent) {
            try {
              const parsed = parseCls(clsContent, classNum + '.cls');
              if (parsed && parsed.className) className = parsed.className;
            } catch(e) {}
          }
          logSeparator();
          log(`★ CLASS COMPLETE — class ${classNum} via ryegate.live peek (UPLOADED detected)`);
          logSeparator();
          peekLog(`★ CLASS_COMPLETE class=${classNum} prev=${prev||'(init)'} → UPLOADED`);
          handleClassComplete(classNum, className);
        } else {
          peekLog(`SKIP class=${classNum} reason=already committed via another signal`);
        }
      }

      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

function stopPeekPolling() {
  if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
}

// resetIdleTimer — repurposed as tsked wake-up trigger (v1.9.0).
// Called from UDP processing and class events. Kicks tsked into ACTIVE mode
// if it's idle, so UDP activity wakes up the ring-level poll.
function resetIdleTimer() {
  tskedWakeUp('UDP activity');
}

// ── TSKED.PHP RING-LEVEL PEEK (v1.9.0) ─────────────────────────────────────
// Replaces the stale-peek sweep. One fetch of tsked.php covers every class in
// the ring — returns badge state (OrderOfGo.jpg = OOG, live.jpg = LIVE, none).
// Per-class peek only fires on demand when tsked.php detects a transition.
// Modes: IDLE (no polling, UDP socket listening) → ACTIVE (tsked poll ~45s).

const TSKED_POLL_MS        = 45000;  // ~45s between tsked.php polls
const TSKED_IDLE_THRESHOLD = 3;      // consecutive clean polls before going idle

let tskedTimer      = null;
let tskedBadgeMap   = {};    // classNum → 'OOG' | 'LIVE' | 'NONE'
let tskedMode       = 'IDLE';  // 'IDLE' | 'ACTIVE'
let tskedCleanPolls = 0;     // consecutive polls with zero badges
let tskedErrorCount = 0;     // consecutive fetch errors

function buildTskedUrl() {
  if (!ryegateLivePath) return null;
  const livePath = ryegateLivePath.replace(/^SHOWS\//i, '');
  return `https://ryegate.live/${livePath}/tsked.php`;
}

// Fetch tsked.php and return raw HTML (or null on error).
async function fetchTsked() {
  const url = buildTskedUrl();
  if (!url) return null;
  const startMs = Date.now();
  try {
    const mod = url.startsWith('https') ? https : http;
    return new Promise((resolve) => {
      const req = mod.get(url, { timeout: 10000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          peekLog(`TSKED fetch url=${url} http=${res.statusCode} bytes=${body.length} ms=${Date.now() - startMs}`);
          resolve(body);
        });
      });
      req.on('error', (e) => {
        peekLog(`TSKED fetch ERROR url=${url} ms=${Date.now() - startMs} err=${e.code || e.message}`);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        peekLog(`TSKED fetch TIMEOUT url=${url} ms=${Date.now() - startMs}`);
        resolve(null);
      });
    });
  } catch(e) {
    return null;
  }
}

// Parse tsked.php HTML → { classNum: 'OOG' | 'LIVE' | 'NONE' }
// Each class row has: <a href="results.php?class=NNN">...</a>
// Badge images: OrderOfGo.jpg → OOG, live.jpg → LIVE, no image → NONE.
// The badge image appears right after the class link text on the same line.
function parseTskedPage(html) {
  const map = {};
  // Split into lines and look for class links + nearby badge images.
  // Pattern: results.php?class=NNN followed by optional badge image on same line.
  const classPattern = /results\.php\?class=(\d+)/g;
  const lines = html.split(/\n/);
  for (const line of lines) {
    let match;
    classPattern.lastIndex = 0;
    while ((match = classPattern.exec(line)) !== null) {
      const classNum = match[1];
      // Check for badge images on this line AFTER the class link
      const afterMatch = line.slice(match.index);
      if (/live\.jpg/i.test(afterMatch)) {
        map[classNum] = 'LIVE';
      } else if (/OrderOfGo\.jpg/i.test(afterMatch)) {
        map[classNum] = 'OOG';
      } else {
        map[classNum] = 'NONE';
      }
    }
  }
  return map;
}

// Main tsked poll — fetch, diff, fire transitions.
async function pollTsked() {
  const html = await fetchTsked();
  if (!html) {
    tskedErrorCount++;
    if (tskedErrorCount >= 3) {
      log(`[TSKED] 3 consecutive errors — cooling down 5min`);
      peekLog(`TSKED COOLDOWN reason=3 consecutive errors`);
      tskedErrorCount = 0;
      scheduleTskedPoll(5 * 60 * 1000);
      return;
    }
    scheduleTskedPoll();
    return;
  }
  tskedErrorCount = 0;

  const newMap = parseTskedPage(html);
  const allClasses = new Set([...Object.keys(tskedBadgeMap), ...Object.keys(newMap)]);
  let anyBadge = false;

  for (const classNum of allClasses) {
    const prev = tskedBadgeMap[classNum] || 'NONE';
    const curr = newMap[classNum] || 'NONE';
    if (curr !== 'NONE') anyBadge = true;

    if (prev === curr) continue; // no change

    log(`[TSKED] class ${classNum}: ${prev} → ${curr}`);
    peekLog(`TSKED TRANSITION class=${classNum} ${prev} → ${curr}`);

    // ── OOG appeared — class opened, order posted ──
    if (curr === 'OOG' && prev === 'NONE') {
      // Informational — the class is open with OOG but not yet live.
      // Don't fire CLASS_COMPLETE or CLASS_SELECTED — Ctrl+A handles that.
      postToWorker('/postClassEvent',
        { event: 'ORDER_POSTED', classNum },
        `ORDER_POSTED class ${classNum} (via tsked)`);
    }

    // ── OOG → LIVE — first horse on course ──
    if (curr === 'LIVE' && (prev === 'OOG' || prev === 'NONE')) {
      // Trigger a per-class peek to get detailed state (IN_PROGRESS confirmation).
      log(`[TSKED] class ${classNum} went LIVE — triggering per-class peek`);
      triggerOneShotPeek(classNum);
    }

    // ── LIVE → NONE — class finished or closed ──
    if (curr === 'NONE' && prev === 'LIVE') {
      // Badge timer expired after last publish. Confirm with a per-class peek.
      log(`[TSKED] class ${classNum} LIVE badge dropped — confirming with per-class peek`);
      triggerOneShotPeek(classNum);
    }

    // ── OOG → NONE — class 417 case: opened, OOG posted, closed without running ──
    if (curr === 'NONE' && prev === 'OOG') {
      log(`[TSKED] class ${classNum} OOG → NONE — class opened and closed without running`);
      peekLog(`TSKED class=${classNum} OOG→NONE — firing CLASS_COMPLETE (abandoned)`);
      if (shouldCommit(classNum, 'tsked-oog-dropped')) {
        logSeparator();
        log(`★ CLASS COMPLETE — class ${classNum} via tsked (OOG dropped without going LIVE)`);
        logSeparator();
        handleClassComplete(classNum, '');
      }
    }
  }

  tskedBadgeMap = newMap;

  // Idle detection — go idle after N consecutive polls with zero badges
  if (anyBadge) {
    tskedCleanPolls = 0;
  } else {
    tskedCleanPolls++;
    if (tskedCleanPolls >= TSKED_IDLE_THRESHOLD) {
      log(`[TSKED] ${TSKED_IDLE_THRESHOLD} clean polls — going IDLE`);
      peekLog(`TSKED → IDLE (${TSKED_IDLE_THRESHOLD} clean polls, no badges)`);
      setTskedMode('IDLE');
      return; // don't schedule next poll
    }
  }

  scheduleTskedPoll();
}

// One-shot per-class peek triggered by a tsked.php transition.
// Checks the individual results page and fires CLASS_COMPLETE if UPLOADED.
async function triggerOneShotPeek(classNum) {
  const result = await peekClass(classNum);
  if (!result || !result.state) return;
  const prev = peekLastState[classNum];
  peekLog(`ONE_SHOT class=${classNum} state=${result.state} prev=${prev||'(none)'}`);

  if (result.state !== prev) {
    peekLastState[classNum] = result.state;
    log(`[PEEK] class ${classNum}: ${prev || '(init)'} → ${result.state}`);
  }

  if (result.state === 'UPLOADED') {
    if (shouldCommit(classNum, 'tsked-oneshot-peek')) {
      logSeparator();
      log(`★ CLASS COMPLETE — class ${classNum} via tsked-triggered peek (UPLOADED)`);
      logSeparator();
      handleClassComplete(classNum, '');
    }
  }
}

function scheduleTskedPoll(delayOverride) {
  if (tskedTimer) { clearTimeout(tskedTimer); tskedTimer = null; }
  const delay = delayOverride != null ? delayOverride : TSKED_POLL_MS;
  tskedTimer = setTimeout(pollTsked, delay);
}

function stopTskedPoll() {
  if (tskedTimer) { clearTimeout(tskedTimer); tskedTimer = null; }
}

function setTskedMode(mode) {
  if (mode === tskedMode) return;
  tskedMode = mode;
  log(`[TSKED] mode → ${mode}`);
  if (mode === 'ACTIVE') {
    tskedCleanPolls = 0;
    tskedErrorCount = 0;
    // Immediate first poll, then scheduled
    pollTsked();
  } else {
    stopTskedPoll();
  }
}

// Wake-up: called by CLASS_SELECTED, UDP activity, config.dat change.
function tskedWakeUp(reason) {
  if (tskedMode === 'ACTIVE') return; // already running
  if (!ryegateLivePath) return;
  log(`[TSKED] wake-up: ${reason}`);
  peekLog(`TSKED WAKE_UP reason=${reason}`);
  setTskedMode('ACTIVE');
}

// ── WORKER CONFIG ─────────────────────────────────────────────────────────────
// Loaded from config.json in same folder as this script

let WORKER_URL  = '';
let AUTH_KEY    = '';
let SHOW_SLUG   = '';
let SHOW_RING   = '1';

function loadWorkerConfig() {
  const configPath = path.join(path.dirname(process.argv[1] || __filename), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    WORKER_URL = (cfg.workerUrl || '').replace(/\/$/, '');
    AUTH_KEY   = cfg.authKey   || '';
    // Slug override — used if config.dat col[24] is blank or missing
    if (cfg.slug && cfg.slug.trim()) {
      SHOW_SLUG = cfg.slug.trim();
      log('Worker config loaded: ' + WORKER_URL + ' | slug override: ' + SHOW_SLUG);
    } else {
      log('Worker config loaded: ' + WORKER_URL);
    }
    // Ring override — set explicitly via admin's Export Config button.
    // Overrides the auto-detect from Ryegate's config.dat FTP path.
    if (cfg.ring && String(cfg.ring).trim()) {
      SHOW_RING = String(cfg.ring).trim();
      log('Ring override from config.json: ' + SHOW_RING);
    }
  } catch(e) {
    log('WARNING: config.json not found or invalid — Worker posting disabled');
    log('  Expected at: ' + configPath);
  }
}

// ── POST TO WORKER ────────────────────────────────────────────────────────────
// Fire-and-forget — never awaited, never blocks the watcher
// 3 second timeout — if internet is down, give up and move on

// postToWorker accepts an optional onSuccess callback that fires ONLY when:
//   - HTTP status is 2xx
//   - Response body has { ok: true } (worker acks success, not locked/rejected)
// Used by readTsked() to cache content only after a confirmed-accepted post,
// so a show-locked rejection triggers a retry on the next touch.
function postToWorker(endpoint, body, label, onSuccess) {
  if (!WORKER_URL || !AUTH_KEY) return;
  let u;
  try { u = new URL(WORKER_URL + endpoint); }
  catch (e) { log(`[POST] bad URL: ${e.message}`); return; }
  const isHttps = u.protocol === 'https:';
  const payload = JSON.stringify({ ...body, slug: SHOW_SLUG, ring: SHOW_RING });
  const opts = {
    hostname: u.hostname,
    port:     u.port || (isHttps ? 443 : 80),
    path:     u.pathname + u.search,
    method:   'POST',
    agent:    isHttps ? HTTPS_AGENT : HTTP_AGENT,
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-West-Key':     AUTH_KEY,
    },
  };
  const req = (isHttps ? https : http).request(opts, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data',  (chunk) => { data += chunk; });
    res.on('end',   () => {
      if (res.statusCode !== 200) {
        log(`[POST] ${label || endpoint} — HTTP ${res.statusCode}: ${data.slice(0,300)}`);
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(data); } catch (e) {}
      if (parsed.locked) {
        log(`[POST] ${label || endpoint} — show is locked, worker rejected (will retry on next trigger)`);
        return;
      }
      if (parsed.ok && onSuccess) onSuccess(parsed);
    });
    res.on('error', (e) => log(`[POST] ${label || endpoint} response error: ${e.message}`));
  });
  // 10s timeout — covers slow TCP/TLS setup + slow Cloudflare response on
  // spotty cell networks (Culpeper-class conditions). keepAlive reuses warm
  // sockets so only the first POST in a burst pays the handshake cost.
  req.setTimeout(10000, () => {
    req.destroy(new Error('timeout'));
  });
  req.on('error', (e) => {
    // Swallow aborts (expected) and log real errors at a lower tone than
    // the previous version — under bad network they're routine.
    if (e.message === 'timeout' || e.code === 'ECONNRESET') return;
    log(`[POST] ${label || endpoint} failed: ${e.message}`);
  });
  req.write(payload);
  req.end();
}

// ── LOGGING ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch(e) {
    console.error('LOG WRITE FAILED: ' + e.message);
    console.error('Tried to write to: ' + LOG_PATH);
  }
}

function logSeparator() {
  const line = '─'.repeat(60);
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\r\n'); } catch(e) {}
}

// ── SAVE SNAPSHOT ────────────────────────────────────────────────────────────

function saveSnapshot(filename, content, label) {
  try {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snapName = `${ts}_${filename}`;
    const snapPath = path.join(SNAPSHOTS_DIR, snapName);
    fs.writeFileSync(snapPath, content);
    log(`SNAPSHOT SAVED: ${snapName}${label ? ' — ' + label : ''}`);
  } catch(e) {
    log(`SNAPSHOT ERROR: ${e.message}`);
  }
}

// ── SAFE FILE READ ───────────────────────────────────────────────────────────
// Opens with shared read access — won't conflict with Ryegate writing

function safeRead(filePath) {
  try {
    // Use 'r' flag — read only, shared access on Windows
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch(e) {
    log(`READ ERROR on ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

// ── CSV PARSER ───────────────────────────────────────────────────────────────
// Handles quoted fields with commas inside

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── CLS PARSER ───────────────────────────────────────────────────────────────

// UDP-based type hints — when the watcher sees a jumper UDP frame (fr=1)
// for the currently-selected class, it remembers "this class is a jumper"
// even if Ryegate's .cls header still says U (unformatted, the placeholder
// state before timing equipment is connected). The hint persists for the
// life of the watcher process. Once Ryegate writes the real type to the
// .cls header, the hint is moot — the parsed value already matches.
const udpTypeHints = {}; // classNum -> 'T' (or 'J')
const loggedTypeInfer = {}; // classNum -> last logged inferred type (dedupe log spam)
// Default jumper type for U→? header inference. Ryegate's config.dat col[2]
// identifies the timing system (e.g. "Farmtek Display System" or "FDS" = J,
// other values = T). Updated at startup and when config.dat changes.
let defaultJumperType = 'T';

function parseCls(content, filename) {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return null;

  const result = {
    filename,
    classType:    'U',   // H=Hunter, J=Jumper, T=Table jumper, U=Unformatted
    className:    '',
    isEquitation: false,
    ribbons:      0,
    numJudges:    0,
    phaseLabels:  [],
    sponsor:      '',
    trophy:       '',
    message:      '',
    timeAllowed1: '',
    timeAllowed2: '',
    onCourse:     null,
    prizes:       [],
    entries:      [],
    raw:          {}
  };

  for (let i = 0; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);

    // ── ROW 0: Class header ──────────────────────────────────────────────────
    if (i === 0) {
      result.classType    = cols[0] || 'U';
      result.className    = cols[1] || '';

      // UDP type hint — applied BEFORE the isJumperHeader / isHunterHeader
      // checks so that the hint affects which parsing block runs. Without
      // this, a U-typed jumper class wouldn't extract scoringMethod / time
      // allowed / round params, and inferRound would default to "Round 1"
      // even after the hint flipped classType later.
      const classNumFromName = (filename || '').replace(/\.cls$/, '');
      if (result.classType === 'U' && udpTypeHints[classNumFromName]) {
        const hinted = udpTypeHints[classNumFromName];
        if (!loggedTypeInfer[classNumFromName]) {
          log(`[TYPE HINT] applied at parse: class ${classNumFromName} U -> ${hinted}`);
          loggedTypeInfer[classNumFromName] = hinted;
        }
        result.classType = hinted;
      }

      // Header-based type inference: if still U but the header has a scoring
      // method in H[2], this is a formatted-but-unopened jumper/equitation class.
      // Infer the type from the scoring method so jumper field parsing runs
      // without needing a UDP hint. This covers the show-office import case
      // where classes arrive formatted with entries but type still U.
      if (result.classType === 'U' && cols[2] && /^\d+$/.test(cols[2])) {
        const method = parseInt(cols[2]);
        // Known jumper scoring methods: 0,2,3,4,6,7,9,13,14
        if (method >= 0 && method <= 15) {
          if (!loggedTypeInfer[classNumFromName]) {
            log(`[TYPE INFER] class ${classNumFromName} U -> ${defaultJumperType} (scoring method ${method} + config.dat timer default)`);
            loggedTypeInfer[classNumFromName] = defaultJumperType;
          }
          result.classType = defaultJumperType;
        }
      }

      const isJumperHeader = result.classType === 'J' || result.classType === 'T';
      const isHunterHeader = result.classType === 'H';

      if (isJumperHeader) {
        // Jumper header — CONFIRMED 2026-04-08 by cycling ALL Ryegate settings
        result.scoringMethod    = cols[2] || '';    // H[02] ScoringMethodCode (see CLS-FORMAT.md)
        result.scoringModifier  = cols[3] || '0';   // H[03] Context-dependent modifier per H[02]
        result.roundsCompleted  = cols[4] || '0';   // H[04] RoundsCompleted counter (0→1→2→3)
        result.clockPrecision   = cols[5] || '0';   // H[05] 0=.001, 1=.01, 2=whole
        result.immediateJO      = cols[6] === '1';  // H[06] 1=immediate (2b/2c/2d), 0=clears return
        result.r1FaultsPerInt   = cols[7] || '1';   // H[07] 0=no time faults (top score)
        result.r1TimeAllowed    = cols[8] || '';     // H[08] 0 for faults converted/top score
        result.r1TimeInterval   = cols[9] || '1';   // H[09]
        result.r2FaultsPerInt   = cols[10] || '1';  // H[10]
        result.r2TimeAllowed    = cols[11] || '';    // H[11]
        result.r2TimeInterval   = cols[12] || '1';  // H[12]
        result.r3FaultsPerInt   = cols[13] || '1';  // H[13] stale if <3 rounds
        result.r3TimeAllowed    = cols[14] || '';    // H[14]
        result.r3TimeInterval   = cols[15] || '1';  // H[15]
        // H[16] unknown — always 1 in all tests
        result.californiaSplit  = cols[17] === '1' || cols[17] === 'True'; // H[17] CORRECTED (was H[16])
        result.isFEI            = cols[18] === 'True'; // H[18] CORRECTED (was H[17])
        const rawSponsor = cols[19] || '';
        result.sponsor = (rawSponsor === 'True' || rawSponsor === 'False' || !rawSponsor.trim()) ? '' : rawSponsor;
        result.caliSplitSecs    = cols[21] || '2';  // H[21]
        result.penaltySeconds   = cols[22] || '6';  // H[22]
        result.noRank           = cols[23] === 'True'; // H[23]
        result.showStandingsTime = cols[25] === 'True'; // H[25]
        result.showFlags        = cols[26] === 'True'; // H[26]
        result.feiWdTiedWithEl  = cols[27] === 'True'; // H[27] CORRECTED (was "always True")
        result.showFaultsAsDecimals = cols[28] === 'True'; // H[28]
        // Derived convenience flags
        result.isTimedEq        = cols[2] === '7';
        result.isTopScore       = cols[2] === '5';
        result.isFaultsConverted = cols[2] === '0';
        result.isTeam           = cols[2] === '14';
      }

      if (isHunterHeader) {
        // Hunter header — CONFIRMED 2026-04-06 by cycling all Ryegate settings
        result.classMode        = cols[2] || '0';  // H[02] 0=OverFences, 1=Flat, 2=Derby, 3=Special
        result.scoringMethod    = cols[2] || '0';  // alias for backward compat
        result.numRounds        = cols[3] || '1';  // H[03] NumRounds
        result.ribbons          = cols[4] || '';    // H[04] Ribbons
        result.scoringType      = cols[5] || '0';  // H[05] 0=Forced, 1=Scored, 2=HiLo
        result.scoreMethod      = cols[6] || '0';  // H[06] 0=Total, 1=Average
        result.numJudges        = cols[7] || '1';  // H[07] NumJudges (1-5+)
        result.sbRibbons        = cols[8] || '';    // H[08] Scoreboard ribbon count
        result.sbDelay          = cols[9] || '4';   // H[09] SBDelay
        result.isEquitation     = cols[10] === 'True'; // H[10]
        result.isChampionship   = cols[11] === 'True'; // H[11]
        result.isJogged         = cols[12] === 'True'; // H[12]
        result.onCourseSB       = cols[13] === 'True'; // H[13]
        result.ignoreSireDam    = cols[14] === 'True'; // H[14]
        result.printJudgeScores = cols[15] === 'True'; // H[15]
        result.reverseRank      = cols[16] === 'True'; // H[16]
        result.californiaSplit   = cols[17] === 'True'; // H[17]
        result.r1TieBreak       = cols[18] || '0';  // H[18] 0=LeaveTied, 1-N=ByJudgeN
        result.r2TieBreak       = cols[19] || '0';  // H[19]
        result.r3TieBreak       = cols[20] || '0';  // H[20]
        result.overallTieBreak  = cols[21] || '0';  // H[21] 0=LeaveTied, 20=ByOverallScore
        result.phaseWeights     = [cols[22]||'100', cols[23]||'100', cols[24]||'100'];
        result.phaseLabels      = [cols[25]||'', cols[26]||'', cols[27]||''].filter(Boolean);
        result.message          = cols[28] || '';
        const rawSponsor        = cols[29] || '';
        result.sponsor = (rawSponsor === 'True' || rawSponsor === 'False' || !rawSponsor.trim()) ? '' : rawSponsor;
        result.runOff           = cols[30] === 'True'; // H[30]
        result.avgRounds        = cols[31] === 'True'; // H[31]
        result.noCutOff         = cols[32] === 'True'; // H[32]
        result.caliSplitSections = cols[33] || '2';    // H[33]
        result.isTeam           = cols[34] === 'True';  // H[34] Team flag (Special Team)
        result.showAllRounds    = cols[35] === 'True'; // H[35]
        result.displayNATTeam   = cols[36] === 'True'; // H[36]
        result.derbyType        = parseInt(cols[37] || '0'); // H[37] 0-8 derby types
        result.ihsa             = cols[38] === 'True'; // H[38]
        result.ribbonsOnly      = cols[39] === 'True'; // H[39]
        // Derived convenience flags
        result.isFlat           = cols[2] === '1';
        result.isDerby          = cols[2] === '2';
        result.isSpecial        = cols[2] === '3';
        result.isForced         = cols[5] === '0';
        result.isScored         = cols[5] === '1';
        result.isHiLo           = cols[5] === '2';
      }

      result.raw.header = cols;
      continue;
    }

    // ── ROW @foot: Trophy/footer text ────────────────────────────────────────
    if (lines[i].startsWith('@foot')) {
      result.trophy = cols[1] || '';
      continue;
    }

    // ── ROW @money: Prize money ──────────────────────────────────────────────
    if (lines[i].startsWith('@money')) {
      result.prizes = cols.slice(1).filter(v => v && v !== '0').map(Number);
      continue;
    }

    // ── Entry rows — first col is entry number ───────────────────────────────
    if (!cols[0] || !/^\d+$/.test(cols[0])) continue;

    const isJumper = result.classType === 'J' || result.classType === 'T';
    const isHunter = result.classType === 'H';

    const entry = {
      entryNum:  cols[0],
      horse:     cols[1] || '',
      rider:     cols[2] || '',
      // col[3] = unknown/empty
      country:   cols[4] || '',   // FEI country code e.g. USA, GER — confirmed 2026-03-31
      owner:     cols[5] || '',
      sire:      cols[6] || '',
      dam:       cols[7] || '',
      city:      cols[8] || '',
      state:     cols[9] || '',
      horseFEI:  cols[10] || '',   // horse FEI/USEF number or passport
      riderFEI:  cols[11] || '',   // rider FEI/USEF number
      ownerFEI:  cols[12] || '',   // owner FEI/USEF number (rarely populated — unconfirmed)
      hasGone:  false,
      place:    '',
    };

    if (isHunter || result.classType === 'U') {
      // Hunter entry cols
      // col[13]=GoOrder, col[14]=CurrentPlace
      // col[42]=R1Total, col[43]=R2Total, col[44]=R3Total, col[45]=CombinedTotal
      // col[49/50/51]=HasGone_R1/R2/R3, col[52/53/54]=StatusText_R1/R2/R3
      // col[46/47/48]=NumericStatus_R1/R2/R3
      entry.rideOrder  = cols[13] && cols[13] !== '0' ? cols[13] : '';
      entry.place      = cols[14] && cols[14] !== '0' ? cols[14] : '';
      entry.r1Total    = cols[42] && cols[42] !== '0' ? cols[42] : '';
      entry.r2Total    = cols[43] && cols[43] !== '0' ? cols[43] : '';
      entry.r3Total    = cols[44] && cols[44] !== '0' ? cols[44] : '';
      entry.combined   = cols[45] && cols[45] !== '0' ? cols[45] : '';
      entry.hasGoneR1  = cols[49] === '1';
      entry.hasGoneR2  = cols[50] === '1';
      entry.hasGoneR3  = cols[51] === '1';
      entry.statusCode = cols[52] || '';
      entry.r1TextStatus = cols[52] || '';
      entry.r2TextStatus = cols[53] || '';
      entry.r3TextStatus = cols[54] || '';
      entry.r1NumericStatus = cols[46] || '';
      entry.r2NumericStatus = cols[47] || '';
      entry.r3NumericStatus = cols[48] || '';

      // Per-judge scores — layout depends on class mode (derby vs non-derby)
      const numJudges = parseInt(result.numJudges) || 1;

      if (result.isDerby) {
        // Derby layout: col[15]=hiopt, col[16]=J1base, [17]=hiopt mirror, [18]=J2base
        // R2: col[24]=hiopt, col[25]=J1base, [26]=J1bonus, [27]=hiopt mirror, [28]=J2base, [29]=J2bonus
        entry.r1HiOpt = cols[15] || '0';
        entry.r1Judges = [cols[16] || '0'];
        if (numJudges >= 2) entry.r1Judges.push(cols[18] || '0');
        entry.r2HiOpt = cols[24] || '0';
        entry.r2Judges = [cols[25] || '0'];
        entry.r2Bonus  = [cols[26] || '0'];
        if (numJudges >= 2) {
          entry.r2Judges.push(cols[28] || '0');
          entry.r2Bonus.push(cols[29] || '0');
        }
      } else {
        // Non-derby scored / Special: sequential from col[15] for R1, col[24]
        // for R2, col[33] for R3. Clean +9 stride per round.
        // Confirmed 2026-04-08: 7 judges at cols 15-21 (R1) and 24-30 (R2)
        // Confirmed 2026-04-10: R3 at cols 33-39 from class 925 Special test
        entry.r1Judges = [];
        entry.r2Judges = [];
        entry.r3Judges = [];
        for (let j = 0; j < numJudges; j++) {
          entry.r1Judges.push(cols[15 + j] || '0');
          entry.r2Judges.push(cols[24 + j] || '0');
          entry.r3Judges.push(cols[33 + j] || '0');
        }
      }

      // Backward compat: single "score" field = first judge R1 or R1 total
      entry.score = cols[15] && cols[15] !== '0' ? cols[15] : '';
      entry.r2Score = cols[24] && cols[24] !== '0' ? cols[24] : '';

      // hasGone = evidence-based. Don't trust col[49]/col[50] — they can get stuck.
      // Score, place, or real status code = competed. DNS = not competed.
      // Hunter forced classes have place but no score — place IS the evidence.
      const hSc = (entry.statusCode || '').toUpperCase();
      const hasScore = !!(entry.score || entry.r1Total);
      const hasPlace = !!(entry.place);
      const hasHunterStatus = !!(hSc && hSc !== 'DNS');
      entry.hasGone = hasScore || hasPlace || hasHunterStatus;
    }

    if (isJumper) {
      // Jumper entry cols — CONFIRMED 2026-03-22 from live class 221 (3 rounds, TIMY)
      // TIMY (T): col[13]=RideOrder, col[36]=HasGone, col[35]=StatusCode(unconfirmed)
      // Farmtek (J): col[13]=0, col[35]=RideOrder, col[36]=HasGone, col[39]=StatusCode
      const isFarmtek = result.classType === 'J';
      const isTIMY    = result.classType === 'T';

      entry.rideOrder     = isTIMY ? (cols[13] || '') : (cols[35] || '');
      entry.overallPlace  = cols[14] && cols[14] !== '0' ? cols[14] : '';

      // R1 block: cols 15-20
      entry.r1Time        = cols[15] && cols[15] !== '0' ? cols[15] : '';
      entry.r1PenaltySec  = cols[16] && cols[16] !== '0' ? cols[16] : '';
      entry.r1TotalTime   = cols[17] && cols[17] !== '0' ? cols[17] : '';
      entry.r1TimeFaults  = cols[18] || '0';
      entry.r1JumpFaults  = cols[19] || '0';
      entry.r1TotalFaults = cols[20] || '0';
      // col[21] unknown, always 0

      // R2/JO block: cols 22-27
      entry.r2Time        = cols[22] && cols[22] !== '0' ? cols[22] : '';
      entry.r2PenaltySec  = cols[23] && cols[23] !== '0' ? cols[23] : '';
      entry.r2TotalTime   = cols[24] && cols[24] !== '0' ? cols[24] : '';
      entry.r2TimeFaults  = cols[25] || '0';
      entry.r2JumpFaults  = cols[26] || '0';
      entry.r2TotalFaults = cols[27] || '0';
      // col[28] unknown, always 0

      // R3/JO block: cols 29-34
      entry.r3Time        = cols[29] && cols[29] !== '0' ? cols[29] : '';
      entry.r3PenaltySec  = cols[30] && cols[30] !== '0' ? cols[30] : '';
      entry.r3TotalTime   = cols[31] && cols[31] !== '0' ? cols[31] : '';
      entry.r3TimeFaults  = cols[32] || '0';
      entry.r3JumpFaults  = cols[33] || '0';
      entry.r3TotalFaults = cols[34] || '0';

      // HasGone and StatusCode
      entry.hasGone       = cols[36] === '1';
      // Column layout (confirmed):
      //   TIMY (T):    text status → col[82]=R1, col[83]=R2
      //                numeric code → col[21]=R1, col[28]=R2 (fallback)
      //   Farmtek (J): text status → col[38] (single field, any round)
      //                numeric code → col[21]=R1, col[28]=R2 (same as TIMY)
      // Numeric → text map (from live observations): 3=HF, 4=WD, others tentative.
      const NUM_STATUS = { '1':'EL', '2':'RF', '3':'HF', '4':'WD', '5':'RT', '6':'DNS' };
      if (isFarmtek) {
        // Farmtek writes a text status code (EL/RF/OC/HF/WD/RT/DNS/DQ/RO/EX/HC)
        // somewhere in the tail columns. Ryegate is NOT consistent about which
        // column — observed at col[37] on some entries, col[38] on others.
        // Scan cols[35]-[39] for any recognized status code instead of
        // relying on a fixed column offset.
        const KNOWN_STATUS = /^(EL|RF|OC|HF|WD|RT|DNS|DQ|RO|EX|HC)$/i;
        let textStatus = '';
        for (let si = 36; si <= 39 && si < cols.length; si++) {
          const val = (cols[si] || '').trim();
          if (val && KNOWN_STATUS.test(val)) { textStatus = val.toUpperCase(); break; }
        }
        // Numeric fallback — see WEST.numericStatusMap in display-config.js
        // for the authoritative mapping table. Values 1-6 only; >6 is scoring data.
        const NUM_STATUS = { '1':'EL', '2':'RT', '3':'OC', '4':'WD', '5':'RF', '6':'DNS' };
        const r1Num = cols[21] || '0';
        const r2Num = cols[28] || '0';
        const r3Num = cols[35] || '0';
        entry.r1StatusCode = '';
        entry.r2StatusCode = '';
        entry.r3StatusCode = '';
        if (textStatus) {
          // Text scan found something — attribute to round using numeric flags
          const r1HasStatus = r1Num !== '0';
          const r2HasStatus = r2Num !== '0';
          if (r2HasStatus) entry.r2StatusCode = textStatus;
          else             entry.r1StatusCode = textStatus;
        } else {
          // No text status — fall back to numeric codes (1-6 only)
          if (NUM_STATUS[r1Num]) entry.r1StatusCode = NUM_STATUS[r1Num];
          if (NUM_STATUS[r2Num]) entry.r2StatusCode = NUM_STATUS[r2Num];
          if (NUM_STATUS[r3Num]) entry.r3StatusCode = NUM_STATUS[r3Num];
        }
        entry.statusCode = entry.r2StatusCode || entry.r1StatusCode || entry.r3StatusCode || '';
      } else {
        entry.r1StatusCode = cols[82] || '';
        entry.r2StatusCode = cols[83] || '';
        // Numeric status fallback — Ryegate writes numeric codes at col[21]
        // and col[28] but often leaves the text columns blank for R2
        // declines like WD. Map numeric → text when text is empty so the
        // .cls is self-sufficient even if the UDP finish frame is missed.
        if (!entry.r1StatusCode && cols[21] && cols[21] !== '0') {
          entry.r1StatusCode = NUM_STATUS[cols[21]] || entry.r1StatusCode;
        }
        if (!entry.r2StatusCode && cols[28] && cols[28] !== '0') {
          entry.r2StatusCode = NUM_STATUS[cols[28]] || entry.r2StatusCode;
        }
        entry.statusCode   = entry.r2StatusCode || entry.r1StatusCode || '';
      }
      // hasGone = evidence of actually competing.
      // Round time is the ultimate proof — if no time and no status, treat as not gone.
      // Ryegate may leave hasGone=1 or place stuck from testing — ignore those without time.
      // DNS = did not start, not competed.
      const sc = (entry.statusCode || entry.r1StatusCode || '').toUpperCase();
      const hasTime = !!(entry.r1TotalTime);
      const hasStatus = !!(sc && sc !== 'DNS');
      entry.hasGone = hasTime || hasStatus;
    }

    result.entries.push(entry);
  }

  // Note: UDP type hint override is applied in the row-0 header block above
  // (so the isJumperHeader branch runs and extracts scoringMethod, TAs, etc.)

  return result;
}

// ── LOG PARSED CLASS ─────────────────────────────────────────────────────────

function logClass(parsed, changed) {
  const isJumper = parsed.classType === 'J' || parsed.classType === 'T';
  const isHunter = parsed.classType === 'H';
  const gone     = parsed.entries.filter(e => e.hasGone);
  const pending  = parsed.entries.filter(e => !e.hasGone);

  logSeparator();
  log(`FILE: ${parsed.filename} ${changed ? '(CHANGED)' : '(NEW)'}`);
  log(`CLASS: ${parsed.className}`);

  let typeStr = parsed.classType;
  if (isHunter) {
    typeStr = 'Hunter';
    if (parsed.derbyType > 0) typeStr += ' Derby';
    else if (parsed.isFlat) typeStr = 'Hunter Flat';
    else if (parsed.isSpecial) typeStr = 'Hunter Special' + (parsed.isTeam ? ' (Team)' : '');
    else if (parsed.isForced) typeStr += ' (Forced)';
    else if (parsed.isHiLo) typeStr += ' (Hi-Lo)';
    if (parsed.isEquitation) typeStr += ' Equitation';
    if (parsed.isChampionship) typeStr += ' Championship';
  }
  if (isJumper)  typeStr = `Jumper (${parsed.classType === 'T' ? 'TIMY' : 'Farmtek'})`;
  if (parsed.classType === 'U') typeStr = 'Unformatted';

  const roundsInfo = isJumper ? ` | Rounds completed: ${parsed.roundsCompleted || 0}` : (parsed.numRounds ? ` | Rounds: ${parsed.numRounds}` : '');
  log(`TYPE: ${typeStr}${roundsInfo} | Ribbons: ${parsed.ribbons || '?'}`);
  if (isJumper && parsed.r1TimeAllowed) log(`TA: R1=${parsed.r1TimeAllowed}s R2=${parsed.r2TimeAllowed||'?'}s R3=${parsed.r3TimeAllowed||'?'}s | Penalty: ${parsed.penaltySeconds||6}s`);
  if (parsed.sponsor && parsed.sponsor !== 'sponsored field') log(`SPONSOR: ${parsed.sponsor}`);
  if (parsed.trophy  && parsed.trophy  !== 'trophies field')  log(`TROPHY: ${parsed.trophy}`);
  if (parsed.prizes.length) log(`PRIZES: $${parsed.prizes.slice(0,5).join(', $')}${parsed.prizes.length > 5 ? '...' : ''}`);

  if (parsed.onCourse) {
    log(`ON COURSE: #${parsed.onCourse.entryNum} ${parsed.onCourse.horse} / ${parsed.onCourse.rider}`);
  }

  log(`ENTRIES: ${parsed.entries.length} total | ${gone.length} competed | ${pending.length} pending`);

  if (gone.length) {
    log(`--- COMPETED ---`);
    // Sort by place for display
    const sorted = [...gone].sort((a, b) => {
      const ap = parseInt(a.place || a.overallPlace || '99');
      const bp = parseInt(b.place || b.overallPlace || '99');
      return ap - bp;
    });
    sorted.forEach(e => {
      if (isHunter) {
        const placeStr = e.place ? `Place: ${e.place}` : 'Place: --';
        log(`  ${placeStr.padEnd(12)} #${e.entryNum.padEnd(6)} ${e.horse} / ${e.rider} | Score: ${e.score || '--'}`);
      } else if (isJumper) {
        const placeStr = e.overallPlace ? `Place: ${e.overallPlace}` : 'Place: --';
        const jFaults = parseFloat(e.r1TotalFaults||'0');
        let scoreStr = `R1: ${e.r1TotalTime ? e.r1TotalTime + 's' : '--'}`;
        if (jFaults > 0) scoreStr += ` (${jFaults} faults)`;
        else scoreStr += ` (clear)`;
        if (e.r2Time) {
          const j2Faults = parseFloat(e.r2TotalFaults||'0');
          scoreStr += ` | R2: ${e.r2TotalTime}s`;
          if (j2Faults > 0) scoreStr += ` (${j2Faults} faults)`;
          else scoreStr += ` (clear)`;
        }
        if (e.r3Time) {
          const j3Faults = parseFloat(e.r3TotalFaults||'0');
          scoreStr += ` | JO: ${e.r3TotalTime}s`;
          if (j3Faults > 0) scoreStr += ` (${j3Faults} faults)`;
          else scoreStr += ` (clear)`;
        }
        if (e.statusCode) scoreStr += ` [${e.statusCode}]`;
        log(`  ${placeStr.padEnd(12)} #${e.entryNum.padEnd(6)} ${e.horse} / ${e.rider} | ${scoreStr}`);
      } else {
        log(`  #${e.entryNum.padEnd(6)} ${e.horse} / ${e.rider}`);
      }
    });
  }

  if (pending.length) {
    log(`--- PENDING (${pending.length}) ---`);
    pending.forEach(e => {
      log(`  #${e.entryNum.padEnd(6)} ${e.horse} / ${e.rider}`);
    });
  }

}

// ── READ TSKED ───────────────────────────────────────────────────────────────

// Cache the last tsked.csv content we posted so we can detect real changes
// (new classes added by Ryegate) vs no-op touches (Upload Results mtime bumps).
let lastTskedContent = '';

// Track which classes are already in tsked.csv so we can detect new arrivals.
// A class appearing in tsked.csv means the operator posted an OOG or intro'd
// a horse — that's the signal to make the class live on the website (v1.9.0).
let tskedKnownClasses = new Set();

function readTsked(reason) {
  reason = reason || 'startup';
  const content = safeRead(TSKED_PATH);
  if (!content) return;
  // Skip if content identical to what we already SUCCESSFULLY posted.
  // lastTskedContent is only updated after the Worker acks ok:true — if the
  // show was locked at the last attempt, the cache stays stale and the next
  // touch triggers a retry. This prevents "stuck" schedules when the show
  // is reactivated after a rejected post.
  if (reason !== 'startup' && content === lastTskedContent) return;
  saveSnapshot('tsked.csv', content, reason);
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  log('');
  log('TSKED FILE (' + reason + '):');

  const schedClasses = [];
  const currentClasses = new Set();
  lines.forEach((line, i) => {
    const cols = parseCSVLine(line);
    if (i === 0) {
      log(`  Show: ${cols[0]} | Dates: ${cols[1]}`);
    } else {
      const classNum = (cols[0] || '').trim();
      const className = (cols[1] || '').trim();
      const date     = (cols[2] || '').trim();
      const flag     = (cols[3] || '').trim();
      log(`  Class ${classNum}: ${className} | Date: ${date} | Flag: ${flag}`);

      if (classNum && date) {
        currentClasses.add(classNum);

        // Normalize date from M/D/YYYY to YYYY-MM-DD for D1
        let isoDate = '';
        const dm = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (dm) isoDate = dm[3] + '-' + dm[1].padStart(2, '0') + '-' + dm[2].padStart(2, '0');
        else isoDate = date;

        schedClasses.push({
          classNum,
          date: isoDate,
          order: i,
          flag: flag || ''
        });

        // v1.9.0: Detect new classes — fire CLASS_SELECTED when a class
        // appears in tsked.csv for the first time (not on startup scan).
        if (reason !== 'startup' && !tskedKnownClasses.has(classNum)) {
          logSeparator();
          log(`★ CLASS ACTIVATED — class ${classNum} (${className}) appeared in tsked.csv`);
          logSeparator();
          activateClassFromTsked(classNum, className);
        }
      }
    }
  });

  tskedKnownClasses = currentClasses;

  // Post schedule to Worker. On startup, delay so initial .cls scan finishes first.
  // Cache content only after the Worker acks ok:true (via onSuccess callback).
  // If the show was locked and the post was rejected, lastTskedContent stays
  // at the previous value — next tsked touch will retry the post.
  if (schedClasses.length) {
    const delay = reason === 'startup' ? 5000 : 500;
    setTimeout(() => {
      postToWorker('/postSchedule',
        { classes: schedClasses },
        `postSchedule (${schedClasses.length} classes, ${reason})`,
        () => {
          lastTskedContent = content; // only cache after confirmed success
          log(`[TSKED] Posted ${schedClasses.length} class schedules to Worker (${reason}) — accepted`);
        });
    }, delay);
  }
}

// Called when a new class appears in tsked.csv — this is the real "go live" signal.
// Posts CLASS_SELECTED to the worker so the class shows up on the website.
function activateClassFromTsked(classNum, className) {
  postToWorker('/postClassEvent',
    { event: 'CLASS_SELECTED', classNum, className },
    `CLASS_SELECTED class ${classNum} (via tsked.csv)`);

  // Re-post the .cls data so standings are available immediately
  const filename = classNum + '.cls';
  const content = fileStates[filename];
  if (content) {
    const parsed = parseCls(content, filename);
    if (parsed) {
      postToWorker('/postClassData', { ...parsed, clsRaw: content }, `postClassData ${filename} (tsked activation)`);
    }
  }
}

// Watch tsked.csv for content changes and re-post the schedule.
// Ryegate touches tsked.csv on many events (Upload Results, class selection)
// but only changes content when classes are added/removed/edited in the
// schedule. The content-diff check in readTsked() skips no-op touches.
function startTskedWatcher() {
  try {
    const dir = path.dirname(TSKED_PATH);
    const fname = path.basename(TSKED_PATH);
    let debounceTimer = null;
    fs.watch(dir, { persistent: true }, (event, filename) => {
      if (!filename || filename.toLowerCase() !== fname.toLowerCase()) return;
      // Debounce rapid touch bursts (Ryegate fires 3 events in <100ms on Upload)
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        readTsked('changed');
      }, 300);
    });
    log(`Watching ${TSKED_PATH} for schedule changes...`);
  } catch (e) {
    log(`ERROR starting tsked watcher: ${e.message}`);
  }
}

// ── READ CONFIG ──────────────────────────────────────────────────────────────

function readConfig() {
  const content = safeRead(CONFIG_PATH);
  if (!content) { log('config.dat not found or unreadable'); return; }
  saveSnapshot('config.dat', content, 'startup');
  log('');
  log('CONFIG.DAT:');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  lines.forEach(line => log('  ' + line));

  // Parse key fields from first line
  try {
    const cols = parseCSVLine(lines[0]);
    log('');
    log('CONFIG PARSED:');
    log('  UDP Port:     ' + (cols[1] || '?'));
    log('  Server IP:    ' + (cols[3] || '?'));
    log('  FTP Path:     ' + (cols[4] || '?'));
    log('  FTP User:     ' + (cols[5] || '?'));
    log('  Show URL:     ' + (cols[24] || '?') + ' (ignored — slug from config.json)');
    log('  Show Name:    ' + (lines[3] ? lines[3].trim() : '?'));
    log('  Show Dates:   ' + (lines[4] ? lines[4].trim() : '?'));
    log('  Location:     ' + (lines[5] ? lines[5].trim() : '?'));

    // Extract ring number from FTP path — store as module var for Worker POSTs
    const pathMatch = (cols[4] || '').match(/r(\d+)$/);
    if (pathMatch) {
      SHOW_RING = pathMatch[1];
      log('  Ring #:       ' + SHOW_RING);
    }

    // Store full FTP path for ryegate.live peek polling
    // e.g. "SHOWS/West/2025/SaratogaJune/wk1/ring1" → peek URL base
    ryegateLivePath = (cols[4] || '').trim();
    if (ryegateLivePath) {
      log('  Peek URL:     https://ryegate.live/' + ryegateLivePath.replace(/^SHOWS\//i, '') + '/results.php?class=...');
      log('  Tsked URL:    ' + buildTskedUrl());
    }

    // Slug comes from config.json only — Ryegate col[24] is ignored
    // col[24] is unreliable (often "False" or stale) — we own our slugs
    if (SHOW_SLUG) {
      log('  Slug:         ' + SHOW_SLUG + ' (from config.json)');
    } else {
      log('  Slug:         NOT SET — Worker posting will not work');
      log('  Set "slug" in config.json before running');
    }
  } catch(e) {
    log('  (Could not parse config fields: ' + e.message + ')');
  }
}

// ── SCAN ALL CLS FILES ────────────────────────────────────────────────────────

function scanAll() {
  try {
    const allFiles = fs.readdirSync(CLASSES_DIR);
    const files = allFiles.filter(f => f.endsWith('.cls'));
    log(`Found ${files.length} .cls files in ${CLASSES_DIR}`);
    files.forEach((f, i) => {
      const fullPath = path.join(CLASSES_DIR, f);
      const content = safeRead(fullPath);
      if (!content) return;
      const parsed = parseCls(content, f);
      if (parsed) {
        fileStates[f] = content;
        saveSnapshot(f, content, 'initial scan');
        logClass(parsed, false);
        // Stagger posts 150ms apart — prevents D1 write contention and Worker 500s
        const rawContent = content;
        setTimeout(() => {
          postToWorker('/postClassData', { ...parsed, clsRaw: rawContent }, `postClassData ${f}`);
        }, i * 150);
      }
    });

    // Snapshot baseline .tod sizes so existing .tod files aren't mistaken
    // for NEW on the first fs.watch event after startup.
    const todFiles = allFiles.filter(f => f.endsWith('.tod'));
    todFiles.forEach(f => {
      const classNum = f.replace(/\.tod$/, '');
      try {
        const st = fs.statSync(path.join(CLASSES_DIR, f));
        todSizes[classNum] = st.size;
      } catch(e) {}
    });
    if (todFiles.length) {
      log(`Found ${todFiles.length} .tod files — baseline sizes captured`);
    }
  } catch(e) {
    log(`ERROR scanning directory: ${e.message}`);
  }
}

// ── WATCH FOR CHANGES ────────────────────────────────────────────────────────

function startWatcher() {
  try {
    fs.watch(CLASSES_DIR, { persistent: true }, (eventType, filename) => {
      if (!filename) return;

      // .cls file — score save path
      if (filename.endsWith('.cls')) {
        const fullPath = path.join(CLASSES_DIR, filename);

        // Small delay to let Ryegate finish writing
        setTimeout(() => {
          const content = safeRead(fullPath);
          if (!content) return;

          // Only log if content actually changed
          if (content === fileStates[filename]) return;
          fileStates[filename] = content;

          // Reset 30-min idle timer — class is still active
          const clsClassNum = filename.replace(/\.cls$/, '');
          if (selectedClassNum && clsClassNum === selectedClassNum) {
            resetIdleTimer(selectedClassNum);
          }

          const parsed = parseCls(content, filename);
          if (parsed) {
            saveSnapshot(filename, content, 'changed');
            logClass(parsed, true);
            postToWorker('/postClassData', { ...parsed, clsRaw: content }, `postClassData ${filename}`);

            // FINISH metric #3: .cls file shows a time for the on-course entry.
            // This is the Farmtek fallback — Farmtek pauses emit decimal UDP
            // times that look like FINISH, but the .cls only gets a time when
            // the score is ACTUALLY saved. Also catches manual time entry
            // (no UDP FINISH frame at all). Deduplicates naturally: if UDP
            // FINISH already fired, lastPhase won't be ONCOURSE anymore.
            if (lastEntry && (lastPhase === 'ONCOURSE' || lastPhase === 'CD') && clsClassNum === selectedClassNum && parsed.entries) {
              const ocEntry = parsed.entries.find(e => e.entryNum === lastEntry);
              if (ocEntry) {
                const hasTime = parseFloat(ocEntry.r1TotalTime) > 0;
                const hasStatus = ocEntry.statusCode && ocEntry.statusCode !== '';
                if (hasTime || hasStatus) {
                  log(`[CLS FINISH] entry #${lastEntry} has time=${ocEntry.r1TotalTime || ''} status=${ocEntry.statusCode || ''} in .cls — confirming FINISH`);
                  fireEvent('FINISH', { entry: lastEntry, horse: ocEntry.horse, rider: ocEntry.rider, elapsed: ocEntry.r1TotalTime || '', rank: ocEntry.place || '' });
                  postToWorker('/postClassEvent',
                    { event: 'FINISH', entry: lastEntry, horse: ocEntry.horse || '', rider: ocEntry.rider || '',
                      elapsed: ocEntry.r1TotalTime || '', rank: ocEntry.place || '',
                      jumpFaults: ocEntry.r1JumpFaults || '0', timeFaults: ocEntry.r1TimeFaults || '0',
                      totalFaults: ocEntry.r1TotalFaults || '0' },
                    `FINISH #${lastEntry} (cls confirm)`);
                  lastPhase = 'IDLE';
                  lastEntry = '';
                }
              }
            }
          }
        }, 200);
        return;
      }

      // .tod file — finalize journal. A NEW file or a size delta means the
      // operator pressed Finish Results / Upload & Close with new data. A
      // touch with unchanged size means a no-op re-press, ignore.
      if (filename.endsWith('.tod')) {
        const classNum = filename.replace(/\.tod$/, '');
        const fullPath = path.join(CLASSES_DIR, filename);

        setTimeout(() => {
          let stat;
          try { stat = fs.statSync(fullPath); }
          catch(e) { return; }  // file vanished between event and stat

          const prevSize = todSizes[classNum];
          const isNew = prevSize === undefined;
          const grew = !isNew && stat.size > prevSize;

          // Always update the stored size so subsequent touches are compared
          // against the latest known state.
          todSizes[classNum] = stat.size;

          if (!isNew && !grew) {
            // No-op re-press — size unchanged. Ignore silently.
            return;
          }

          // Dedup: if peek or Ctrl+A already committed this class, skip
          if (!shouldCommit(classNum, '.tod ' + (isNew ? 'NEW' : 'grew ' + prevSize + '→' + stat.size))) {
            return;
          }

          // Look up className from cached .cls parse if we have one
          let className = '';
          const clsContent = fileStates[classNum + '.cls'];
          if (clsContent) {
            try {
              const parsed = parseCls(clsContent, classNum + '.cls');
              if (parsed && parsed.className) className = parsed.className;
            } catch(e) {}
          }

          logSeparator();
          log(`★ CLASS COMPLETE — class ${classNum} via .tod ${isNew ? 'NEW' : 'grew ' + prevSize + '→' + stat.size}`);
          logSeparator();

          handleClassComplete(classNum, className);
        }, 200);
        return;
      }
    });
    log(`Watching ${CLASSES_DIR} for changes...`);
  } catch(e) {
    log(`ERROR starting watcher: ${e.message}`);
  }
}

// ── LOG.TXT ERROR WATCHER (COMMENTED OUT — NUCLEAR OPTION) ──────────────────
// FUTURE SELF: This is the "bad path" finalize detector. If Bill decides to
// stop populating ryegate.live (relationship with Ryegate owner goes south),
// he changes config.dat's upload IP to 127.0.0.1 or a dead IP. Every upload
// attempt then FAILS, and Ryegate logs the error to log.txt.
//
// How to activate:
//   1. Set config.dat col[4] FTP path to a nonexistent directory (e.g. SHOWS/NONWEST)
//      — server IP stays real (68.178.203.100), connection succeeds, but the bad
//      path causes a 553 "File name not allowed" error per upload attempt.
//      The REAL show path on ryegate.live stays empty = no results published there.
//   2. Uncomment this block
//   3. Optionally disable the peek polling (set ryegateLivePath = '' in readConfig)
//
// Detection logic: log.txt grows = upload attempt. But auto-sync ALSO fails
// and writes errors, so we need to filter: a log.txt growth that correlates
// with a .cls change (within ±2s) is auto-sync noise. A log.txt growth with
// NO .cls change nearby is an explicit Upload Results click.
//
// const LOG_TXT_PATH = 'C:\\Ryegate\\Jumper\\log.txt';
// let lastLogTxtSize = null;
// let lastClsChangeTime = 0;  // timestamp of most recent .cls content change
//
// function startLogTxtWatcher() {
//   try {
//     const initStat = fs.statSync(LOG_TXT_PATH);
//     lastLogTxtSize = initStat.size;
//     log(`[LOG.TXT] Baseline size: ${lastLogTxtSize} bytes`);
//   } catch(e) {
//     log(`[LOG.TXT] Could not stat ${LOG_TXT_PATH}: ${e.message}`);
//     return;
//   }
//
//   fs.watch(path.dirname(LOG_TXT_PATH), { persistent: true }, (event, filename) => {
//     if (!filename || filename.toLowerCase() !== 'log.txt') return;
//
//     setTimeout(() => {
//       let stat;
//       try { stat = fs.statSync(LOG_TXT_PATH); }
//       catch(e) { return; }
//
//       if (lastLogTxtSize === null) { lastLogTxtSize = stat.size; return; }
//       if (stat.size <= lastLogTxtSize) { lastLogTxtSize = stat.size; return; }
//
//       const delta = stat.size - lastLogTxtSize;
//       lastLogTxtSize = stat.size;
//
//       // Was there a .cls change within the last 2 seconds?
//       // If yes, this error is from auto-sync (piggybacked on score save) — ignore.
//       // If no, this error is from an explicit Upload Results click — that's the signal.
//       const timeSinceClsChange = Date.now() - lastClsChangeTime;
//       if (timeSinceClsChange < 2000) {
//         log(`[LOG.TXT] +${delta} bytes — auto-sync error (cls changed ${timeSinceClsChange}ms ago), ignoring`);
//         return;
//       }
//
//       log(`[LOG.TXT] +${delta} bytes — no recent cls change → Upload Results detected`);
//
//       if (selectedClassNum && shouldCommit(selectedClassNum, 'log.txt error')) {
//         let className = '';
//         const clsContent = fileStates[selectedClassNum + '.cls'];
//         if (clsContent) {
//           try {
//             const parsed = parseCls(clsContent, selectedClassNum + '.cls');
//             if (parsed && parsed.className) className = parsed.className;
//           } catch(e) {}
//         }
//         logSeparator();
//         log(`★ CLASS COMPLETE — class ${selectedClassNum} via log.txt error (bad-path mode)`);
//         logSeparator();
//         handleClassComplete(selectedClassNum, className);
//       }
//     }, 300);
//   });
//   log(`[LOG.TXT] Watching for upload errors (bad-path mode active)`);
// }
//
// To wire it in, also uncomment these lines in the MAIN section:
//   startLogTxtWatcher();
// And in the .cls handler, add:
//   lastClsChangeTime = Date.now();
// (This is needed for the auto-sync filter to work.)

// ── MAIN ──────────────────────────────────────────────────────────────────────

// Test log write on startup
try {
  fs.writeFileSync(LOG_PATH, 'WEST Watcher started: ' + new Date().toISOString() + '\r\n');
  console.log('Log file created at: ' + LOG_PATH);
} catch(e) {
  console.error('Cannot write to: ' + LOG_PATH);
  console.error('Error: ' + e.message);
  // Fallback to same folder as script
  LOG_PATH = 'west_log.txt';
  console.log('Falling back to: ' + LOG_PATH);
  try { fs.writeFileSync(LOG_PATH, 'WEST Watcher started\r\n'); } catch(e2) {}
}

log('');
log('WEST Scoring Live — Class File Watcher');
log('Log file: ' + LOG_PATH);
log('');

// Load Worker posting config first
loadWorkerConfig();

// Read Ryegate config and extract show slug + ring
readConfig();
readTsked();
startTskedWatcher();

// Initial scan of all existing cls files
log('');
log('INITIAL SCAN:');
scanAll();

// Start watching for changes
log('');
startWatcher();

log('Running — press Ctrl+C to stop');
log('');

// Cold-start tsked.php check — see if anything is already live on ryegate.live.
// Delayed 3s so config is fully loaded.
setTimeout(() => {
  if (ryegateLivePath) {
    log('[TSKED] Cold-start check...');
    tskedWakeUp('cold-start');
  }
}, 3000);

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
// Adaptive heartbeat: 1s when a class is active — carries the clock snapshot
// every second so the website is authoritative on {phase, elapsed, countdown}
// without cross-clock timestamp extrapolation. 60s when idle.
let selectedClassNum = null;
const HEARTBEAT_ACTIVE_MS = 1000;
const HEARTBEAT_IDLE_MS   = 60000;
let heartbeatTimer = null;

function buildHeartbeat() {
  const hb = {
    version:        WATCHER_VERSION,
    scoreboardPort: scoreboardPort || '',
  };
  if (selectedClassNum && lastPhase && lastPhase !== 'IDLE') {
    hb.clock = {
      classNum:   selectedClassNum,
      entry:      lastEntry   || '',
      elapsed:    lastElapsed || '',
      countdown:  lastCd      || '',
      ta:         lastTa      || '',
      phase:      lastPhase   || '',
      jumpFaults: lastJump    || '0',
      rank:       lastRank    || '',
    };
  }
  return hb;
}

function scheduleHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const interval = selectedClassNum ? HEARTBEAT_ACTIVE_MS : HEARTBEAT_IDLE_MS;
  heartbeatTimer = setInterval(() => {
    postToWorker('/heartbeat', buildHeartbeat(), 'heartbeat');
  }, interval);
}

scheduleHeartbeat();

// Send one immediately on startup
setTimeout(() => {
  postToWorker('/heartbeat', buildHeartbeat(), 'heartbeat (startup)');
  log('Heartbeat sent to Worker');
}, 2000);

// ── UDP LOGGING ───────────────────────────────────────────────────────────────

let UDP_LOG_PATH = null;

function initUdpLog() {
  const candidates = [
    path.join(__dirname, 'west_udp_log.txt'), // next to watcher (c:\west\)
    'C:\\west_udp_log.txt',
    (process.env.USERPROFILE || '') + '\\Desktop\\west_udp_log.txt',
    'C:\\Users\\Public\\Desktop\\west_udp_log.txt',
    'west_udp_log.txt',
  ];
  for (const candidate of candidates) {
    try {
      fs.writeFileSync(candidate, 'WEST UDP Log started: ' + new Date().toISOString() + '\r\n');
      UDP_LOG_PATH = candidate;
      log('UDP log: ' + UDP_LOG_PATH);
      return;
    } catch(e) {}
  }
  log('WARNING: Could not create UDP log file');
}

function udpLog(msg) {
  const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (UDP_LOG_PATH) {
    try { fs.appendFileSync(UDP_LOG_PATH, line + '\r\n'); } catch(e) {}
  }
}

// ── PEEK LOGGING ──────────────────────────────────────────────────────────────
// Dedicated log for the ryegate.live peek checker. Full per-poll detail so we
// can diagnose "why didn't peek fire CLASS_COMPLETE at time T" after the fact.
// Does NOT write to console — peek is verbose (every 15-30s) and would drown
// the main log. State transitions and CLASS_COMPLETE fires still go through
// the main log() too.

let PEEK_LOG_PATH = null;

function initPeekLog() {
  const candidates = [
    path.join(__dirname, 'west_peek_log.txt'),
    'C:\\west_peek_log.txt',
    (process.env.USERPROFILE || '') + '\\Desktop\\west_peek_log.txt',
    'C:\\Users\\Public\\Desktop\\west_peek_log.txt',
    'west_peek_log.txt',
  ];
  for (const candidate of candidates) {
    try {
      fs.writeFileSync(candidate, 'WEST Peek Log started: ' + new Date().toISOString() + '\r\n');
      PEEK_LOG_PATH = candidate;
      log('Peek log: ' + PEEK_LOG_PATH);
      return;
    } catch(e) {}
  }
  log('WARNING: Could not create peek log file');
}

function peekLog(msg) {
  const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  if (PEEK_LOG_PATH) {
    try { fs.appendFileSync(PEEK_LOG_PATH, line + '\r\n'); } catch(e) {}
  }
}

// ── UDP PACKET PARSER ─────────────────────────────────────────────────────────

function parseUdpPacket(msg) {
  const ascii = msg.toString('ascii').replace(/^\r|\r$/g, '');
  const body  = ascii.replace(/^\{RYESCR\}/, '');
  const tags  = {};
  const re    = /\{([^}]+)\}([^{]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    tags[m[1]] = m[2].trim();
  }
  return tags;
}

function cleanUdpVal(tag, val) {
  val = (val || '').trim();
  if (tag === '8')  val = val.replace(/^RANK\s*/i, '').replace(/^:\s*/, '');  // strip 'RANK ' and ': ' prefixes
  if (tag === '13') val = val.replace(/^TA:\s*/i,  '');
  if (tag === '14') val = val.replace(/^JUMP\s*/i, '').replace(/^H:/i, '');    // strip 'JUMP ' and 'H:' prefixes
  if (tag === '15') val = val.replace(/^TIME\s*/i, '');
  return val;
}

// ── PORT 31000 — CLASS COMPLETE DETECTOR ─────────────────────────────────────
// Ryegate video wall port — always-on checkbox in settings
// Sends class number (and possibly sponsor text) when operator presses Ctrl+A
// Three rapid presses of Ctrl+A with the same class number = CLASS_COMPLETE
// Threshold: 3 identical packets within 2 seconds

const CLASS_COMPLETE_PORT    = 31000;
const CLASS_COMPLETE_COUNT   = 3;    // presses needed
const CLASS_COMPLETE_WINDOW  = 2000; // ms window
const CLASS_COMPLETE_COOLDOWN = 5000; // ms — ignore any Ctrl+A on the same
                                       // class for 5s after CLASS_COMPLETE
                                       // fires, so a trigger-happy 4th press
                                       // doesn't accidentally re-select and
                                       // reopen the class.

let port31000LastClassNum  = null;
let port31000PressCount    = 0;
let port31000WindowTimer   = null;
const port31000RecentlyCompleted = {}; // classNum -> timestamp ms

function startPort31000Listener() {
  const dgram  = require('dgram');
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    log(`Port 31000 ERROR: ${err.message}`);
    if (err.code === 'EADDRINUSE' || err.code === 'ENOTSUP') {
      log(`[UDP] DEGRADED MODE — port 31000 unavailable (${err.code}). Class-complete detection disabled; .cls watcher still active.`);
      try { socket.close(); } catch (e) {}
      return; // continue without port 31000
    }
    try { socket.close(); } catch (e) {}
  });

  socket.on('listening', () => {
    log(`Port 31000 listener active — class complete detection ready`);
  });

  socket.on('message', (msg) => {
    const raw = msg.toString('ascii').trim();

    // Log every packet to both logs
    udpLog(`[31000] RAW: ${raw}`);
    log(`[31000] RAW: ${raw}`);

    // Confirmed packet format (2026-03-23 live test):
    // {RYESCR}{fr}[frame]{26}[classNum]s{27}[classNum]{28}[className]{ }
    // {fr}  = Ryegate frame number — ignore
    // {26}  = classNum + "s" (sponsor graphic filename) — ignore
    // {27}  = clean class number ← use this
    // {28}  = class name ← bonus
    const tags     = parseUdpPacket(msg);
    const classNum = (tags['27'] || '').trim();
    const className = (tags['28'] || '').trim();

    if (!classNum) {
      udpLog(`[31000] No class number in packet — skipping`);
      return;
    }

    log(`[31000] Class: ${classNum} — ${className}`);
    udpLog(`[31000] Class number: ${classNum} | Name: ${className}`);

    // Cooldown — if this class fired CLASS_COMPLETE in the last
    // CLASS_COMPLETE_COOLDOWN ms, ignore any further Ctrl+A presses on it.
    // Stops a trigger-happy 4th press from re-selecting the class and
    // reopening it on the live page.
    const lastComplete = port31000RecentlyCompleted[classNum];
    if (lastComplete && (Date.now() - lastComplete) < CLASS_COMPLETE_COOLDOWN) {
      const remaining = Math.round((CLASS_COMPLETE_COOLDOWN - (Date.now() - lastComplete)) / 1000);
      log(`[31000] IGNORED — class ${classNum} just completed (${remaining}s cooldown remaining)`);
      udpLog(`[31000] IGNORED — class ${classNum} cooldown ${remaining}s`);
      return;
    }

    if (classNum === port31000LastClassNum) {
      // Same class — increment counter
      port31000PressCount++;
      log(`[31000] Press ${port31000PressCount}/${CLASS_COMPLETE_COUNT} for class ${classNum}`);
      udpLog(`[31000] Press ${port31000PressCount}/${CLASS_COMPLETE_COUNT} for class ${classNum}`);

      if (port31000PressCount >= CLASS_COMPLETE_COUNT) {
        // 3 presses — CLASS_COMPLETE
        if (port31000WindowTimer) { clearTimeout(port31000WindowTimer); port31000WindowTimer = null; }
        port31000PressCount   = 0;
        port31000LastClassNum = null;
        // Mark the cooldown so any further Ctrl+A on this class is ignored
        port31000RecentlyCompleted[classNum] = Date.now();
        // Dedup against peek/.tod — if already committed, skip
        if (!shouldCommit(classNum, '3x Ctrl+A')) {
          udpLog(`[31000] CLASS_COMPLETE skipped (already committed via other signal)`);
        } else {
          log(`★ CLASS COMPLETE — class ${classNum} ${className} (3x Ctrl+A confirmed)`);
          udpLog(`[31000] CLASS_COMPLETE fired for class ${classNum}`);
          handleClassComplete(classNum, className);
        }
      }
    } else {
      // New class — single press = CLASS_SELECTED, start window for potential CLASS_COMPLETE
      if (port31000WindowTimer) { clearTimeout(port31000WindowTimer); port31000WindowTimer = null; }
      port31000LastClassNum = classNum;
      port31000PressCount   = 1;

      // Fire CLASS_SELECTED immediately on first press
      log(`◆ CLASS SELECTED — class ${classNum} ${className}`);
      udpLog(`[31000] CLASS_SELECTED fired for class ${classNum}`);
      handleClassSelected(classNum, className);

      // Start window — if 2 more presses come within 2s, it becomes CLASS_COMPLETE
      log(`[31000] Press 1/${CLASS_COMPLETE_COUNT} for class ${classNum} — watching for CLASS_COMPLETE`);
      port31000WindowTimer = setTimeout(() => {
        port31000WindowTimer  = null;
        port31000PressCount   = 0;
        port31000LastClassNum = null;
        log(`[31000] Window expired for class ${classNum} — stayed as CLASS_SELECTED`);
        udpLog(`[31000] Window expired for class ${classNum} — reset`);
      }, CLASS_COMPLETE_WINDOW);
    }
  });

  try {
    socket.bind(CLASS_COMPLETE_PORT);
  } catch(e) {
    log(`Port 31000 bind ERROR: ${e.message}`);
  }
}

// selectedClassNum declared above (before heartbeat section) — assigned here
let flatEntriesSeen = {};   // tracks entries seen in fr=11 rotation for flat classes — { entryNum: { entry, horse, rider } }
let hunterResults = [];       // tracks placements from fr=14 results frames — [{ entry, horse, rider, place }] in announcement order

function handleClassSelected(classNum, className) {
  selectedClassNum = classNum;
  flatEntriesSeen = {}; // reset flat entry tracking on new class selection
  hunterResults = [];     // reset flat results on new class selection

  // Clear the commit dedup so the class can be re-committed after being reopened.
  // Without this, shouldCommit() would block a second CLASS_COMPLETE within 5 min
  // of the first — which is wrong if the operator intentionally reopened + re-closed.
  delete lastClassCommitted[classNum];

  logSeparator();
  log(`CLASS SELECTED: class ${classNum} — ${className} (internal — waiting for tsked.csv)`);
  logSeparator();

  // v1.9.0: Ctrl+A is internal bookkeeping only. CLASS_SELECTED is NOT posted
  // to the worker here — the class doesn't go live on the website until it
  // appears in tsked.csv (OOG posted or first horse intro'd). This prevents
  // phantom "live" classes when the operator is just browsing/setting up.
  // The tsked.csv watcher fires activateClassFromTsked() when a new class appears.

  // Start tsked.php ring-level poll — watches for badge transitions on ryegate.live.
  tskedWakeUp('CLASS_SELECTED class ' + classNum);

  // Switch heartbeat to 10s active cadence (carries clock snapshot)
  scheduleHeartbeat();

  resetIdleTimer(classNum);

  // Re-post this class's current data 300ms later so standings are fresh
  // when the class eventually goes live via tsked.csv.
  setTimeout(() => {
    const filename = classNum + '.cls';
    const content = fileStates[filename];
    log(`[CLASS_SELECTED] fileStates[${filename}]: ${content ? content.length + ' bytes' : 'NOT FOUND'}`);
    if (content) {
      const parsed = parseCls(content, filename);
      if (parsed) {
        postToWorker('/postClassData', { ...parsed, clsRaw: content }, `postClassData ${filename} (on-select)`);
        log(`[CLASS_SELECTED] Re-posted ${filename} standings to Worker`);
      }
    }
  }, 300);
}

function handleClassComplete(classNum, className) {
  logSeparator();
  log(`CLASS COMPLETE: class ${classNum} — ${className}`);
  logSeparator();

  // Stop per-class peek — class is done. tsked.php poll keeps running
  // (other classes may still be active in the ring).
  stopPeekPolling();

  // Switch heartbeat back to idle cadence (no clock snapshot)
  selectedClassNum = null;
  scheduleHeartbeat();

  // Force-read the .cls file and post fresh data BEFORE the CLASS_COMPLETE
  // event. For forced/flat hunter classes, the .cls may have just been written
  // with final placements — we need that data in D1 before marking complete.
  const filename = classNum + '.cls';
  const fullPath = path.join(CLASSES_DIR, filename);
  const content = safeRead(fullPath);
  if (content) {
    fileStates[filename] = content;
    const parsed = parseCls(content, filename);
    if (parsed) {
      postToWorker('/postClassData', { ...parsed, clsRaw: content }, `postClassData ${filename} (class-complete forced)`);
      log(`[CLASS_COMPLETE] Forced re-post of ${filename}`);
    }
  }

  postToWorker('/postClassEvent',
    { event: 'CLASS_COMPLETE', classNum, className },
    `CLASS_COMPLETE class ${classNum}`);
}

// ── SCOREBOARD UDP LISTENER ───────────────────────────────────────────────────

const udpEvents  = [];
const udpLastLogged = {};

let lastPhase   = 'IDLE';
let lastEntry   = '';
let lastTa      = '';
let lastElapsed = '';
let lastCd      = '';
let lastJump    = '';
let lastRank    = '';
let clockStopTimer = null;
let cdStopTimer    = null;
let finishLockUntil = 0;  // timestamp — suppress ONCOURSE re-fires after FINISH

// inferRound state — tracks the most recent UDP TA we inferred a round for
// and the round we decided on, per selected class. When UDP TA changes to
// a value the .cls header doesn't know about yet (Ryegate hasn't flushed
// the new round's TA), we advance the round based on the change rather
// than waiting for the .cls to catch up.
const inferRoundState = {}; // classNum -> { lastTa: number, lastRound: 1|2|3 }

function fireEvent(type, data) {
  const event = { event: type, timestamp: new Date().toISOString(), ...data };
  udpEvents.push(event);
  udpLog(`[EVENT:${type}] ${JSON.stringify(data)}`);
}

function inferRound(entryNum, udpTa) {
  const taNum = parseFloat(udpTa) || 0;

  // Use the selected class file — we know which class is in the ring.
  // If selectedClassNum is null (e.g. watcher restart with no Ctrl+A yet),
  // self-discover by scanning fileStates for a .cls that contains entryNum
  // in its parsed entries. Caches the discovered class for next time.
  let filename = selectedClassNum ? selectedClassNum + '.cls' : null;
  let content = filename ? fileStates[filename] : null;

  if (!content && entryNum) {
    // Self-discovery: find a .cls with this entry. Filter aggressively to
    // avoid cross-class entry collisions:
    //   1. Only files modified in the last hour (active scoring window)
    //   2. Only jumper-type files (J/T) — we're being called from a jumper
    //      UDP handler, so a hunter file with the same entry# is wrong
    //   3. Prefer the most recently modified match
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let bestFname = null;
    let bestMtime = 0;
    for (const fname in fileStates) {
      if (!fname.endsWith('.cls')) continue;
      const c = fileStates[fname];
      if (!c) continue;
      // mtime filter — skip stale files from prior shows
      let mt = 0;
      try { mt = fs.statSync(path.join(CLASSES_DIR, fname)).mtimeMs; } catch (e) { continue; }
      if (mt < oneHourAgo) continue;
      // Type filter — must be jumper (the jumper UDP path is the only caller)
      let p;
      try { p = parseCls(c, fname); } catch (e) { continue; }
      if (!p || !p.entries) continue;
      if (p.classType !== 'J' && p.classType !== 'T') continue;
      // Entry# must match
      if (!p.entries.some(e => e.entryNum === entryNum)) continue;
      // Prefer the most recently changed file
      if (mt >= bestMtime) {
        bestMtime = mt;
        bestFname = fname;
      }
    }
    if (bestFname) {
      filename = bestFname;
      content = fileStates[bestFname];
      // Promote to selectedClassNum so subsequent calls don't re-scan
      const discovered = bestFname.replace(/\.cls$/, '');
      udpLog(`[inferRound] self-discovered selectedClassNum=${discovered} for entry ${entryNum}`);
      selectedClassNum = discovered;
    }
  }

  if (content) {
    const parsed = parseCls(content, filename);
    if (parsed) {
      const sm = String(parsed.scoringMethod || '');
      // Two-phase methods use Phase 1 / Phase 2 labels:
      //   9 = II.2d (all advance), 11 = II.2c (clears only advance)
      const isTwoPhase = sm === '9' || sm === '11';
      const isThreeRound = sm === '3' || sm === '14';
      // Single-round methods with no jump-off. Must stay in sync with
      // WEST.jumper.singleRound in display-config.js.
      //   0 = Table III (faults converted), 4 = II.1 Speed,
      //   6 = Optimum Time IV.1, 7 = Timed Equitation
      const noJumpOff = sm === '0' || sm === '4' || sm === '6' || sm === '7';
      // Two-round methods where round 2 is NOT a Jump Off (no JO label).
      // Method 15 = Winning Round (R1 + R2).
      const twoRoundNoJO = sm === '15';
      const maxRounds = isThreeRound ? 3 : (isTwoPhase || !noJumpOff) ? 2 : 1;

      // Time fault formula values per round from .cls header
      const roundParams = {
        1: { fpi: parseFloat(parsed.r1FaultsPerInt) || 1, ti: parseFloat(parsed.r1TimeInterval) || 1, ps: parseFloat(parsed.penaltySeconds) || 6 },
        2: { fpi: parseFloat(parsed.r2FaultsPerInt) || 1, ti: parseFloat(parsed.r2TimeInterval) || 1, ps: parseFloat(parsed.penaltySeconds) || 6 },
        3: { fpi: parseFloat(parsed.r3FaultsPerInt) || 1, ti: parseFloat(parsed.r3TimeInterval) || 1, ps: parseFloat(parsed.penaltySeconds) || 6 },
      };

      // Method-aware label for a given round number.
      //   Two-phase → Phase 1 / Phase 2
      //   Three-round (3, 14 team) → Round 1 / Round 2 / Jump Off
      //   Two-round-no-JO (15 winning round) → Round 1 / Round 2
      //   Single-round (0/4/6/7) → Round 1
      //   Default (2 II.2a, 13 II.2b) → Round 1 / Jump Off
      function labelFor(round) {
        if (isTwoPhase)    return round === 1 ? 'Phase 1' : round === 2 ? 'Phase 2' : 'Phase ' + round;
        if (isThreeRound)  return round === 1 ? 'Round 1' : round === 2 ? 'Round 2' : 'Jump Off';
        if (twoRoundNoJO)  return round === 1 ? 'Round 1' : round === 2 ? 'Round 2' : 'Round ' + round;
        if (noJumpOff)     return 'Round 1';
        return round === 1 ? 'Round 1' : round === 2 ? 'Jump Off' : 'Round ' + round;
      }

      function result(round) {
        const rp = roundParams[round] || roundParams[1];
        return {
          round,
          label: labelFor(round),
          faultsPerInterval: rp.fpi,
          timeInterval: rp.ti,
          penaltySeconds: rp.ps,
        };
      }

      // ── PRIMARY: UDP TA matches a known header TA ───────────────────────
      // When the .cls header has all round TAs populated, matching against
      // them is unambiguous. Works for every multi-round scoring method.
      const ta1 = parseFloat(parsed.r1TimeAllowed);
      const ta2 = parseFloat(parsed.r2TimeAllowed);
      const ta3 = parseFloat(parsed.r3TimeAllowed);
      const r1Match = taNum > 0 && taNum === ta1;
      const r2Match = taNum > 0 && taNum === ta2;
      const r3Match = taNum > 0 && taNum === ta3;

      const classKey = filename || 'unknown';
      const prevState = inferRoundState[classKey] || null;

      function remember(round) {
        inferRoundState[classKey] = { lastTa: taNum, lastRound: round };
        return result(round);
      }

      if (r1Match && !r2Match && !r3Match) return remember(1);
      if (r2Match && !r1Match && !r3Match) return remember(2);
      if (r3Match && !r1Match && !r2Match) return remember(3);

      // ── UDP-TRUST PATH (no header match) ────────────────────────────────
      // Ryegate's UDP carries the TA of the round currently being run. If
      // it doesn't match any header value, the .cls header hasn't caught
      // up yet (or operator changed TA mid-class). Trust the UDP:
      //   - Same TA as last seen → same round as last time
      //   - Different TA → round has advanced; step forward, capped at
      //     maxRounds. If we've never inferred a round for this class yet,
      //     start at round 1.
      if (taNum > 0 && prevState) {
        if (taNum === prevState.lastTa) return remember(prevState.lastRound);
        const next = Math.min((prevState.lastRound || 1) + 1, maxRounds);
        return remember(next);
      }

      // ── FALLBACK 1: two-phase entry inspection ──────────────────────────
      // When TAs are ambiguous (e.g. r1TA == r2TA), use whether the entry
      // already has r2 data. If yes → on PH2, otherwise → on PH1.
      if (isTwoPhase) {
        const entry = parsed.entries.find(e => e.entryNum === entryNum);
        if (entry && entry.r2TotalTime) return remember(2);
        return remember(1);
      }

      // ── FALLBACK 2: roundsCompleted counter from class header ──────────
      // Cap at the method's max rounds so single-round classes (II.1, Optimum)
      // never advance to "round 2" / "Jump Off" after all entries have gone.
      const rc = parseInt(parsed.roundsCompleted) || 0;
      if (rc === 0) return remember(1);
      if (rc >= maxRounds) return remember(maxRounds);
      if (rc === 1) return remember(2);
      return remember(3);
    }
  }

  // No selected class or no .cls cached — default with standard 1 fault/sec
  return { round: 1, label: 'Round 1', faultsPerInterval: 1, timeInterval: 1, penaltySeconds: 6 };
}

// Enrich on-course entry data from .cls cache. Ryegate's UDP may swap fields
// (equitation puts rider in {2}/horse field, leaves {3}/rider empty) or have
// missing data. The .cls file is authoritative for horse/rider/city/state/owner.
function enrichFromCls(entryNum, udpHorse, udpRider) {
  if (!selectedClassNum) return { horse: udpHorse, rider: udpRider, owner: '', city: '', state: '' };
  const content = fileStates[selectedClassNum + '.cls'];
  if (!content) return { horse: udpHorse, rider: udpRider, owner: '', city: '', state: '' };
  const parsed = parseCls(content, selectedClassNum + '.cls');
  if (!parsed || !parsed.entries) return { horse: udpHorse, rider: udpRider, owner: '', city: '', state: '' };
  const e = parsed.entries.find(x => x.entryNum === entryNum);
  if (!e) return { horse: udpHorse, rider: udpRider, owner: '', city: '', state: '' };
  return {
    horse: e.horse || udpHorse || '',
    rider: e.rider || udpRider || '',
    owner: e.owner || '',
    city:  e.city  || '',
    state: e.state || '',
  };
}

function detectEvents(phase, entry, horse, rider, ta, cd, elapsed, jump, time, rank, hunterScore, isHunterScore, isScoreFrame, eqScore) {
  // Enrich with .cls data — fixes equitation's swapped horse/rider in UDP
  // and ensures city/state/owner are available for on-course display.
  var enriched = enrichFromCls(entry, horse, rider);
  horse = enriched.horse;
  rider = enriched.rider;
  var owner = enriched.owner;
  var city = enriched.city;
  var state = enriched.state;

  if (entry !== lastEntry) {
    if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
    if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
    lastElapsed = '';
    lastJump    = '';
    lastCd      = '';
  }

  // Entry changed mid-stream. Two scenarios:
  //
  // (A) Entry switch during active phase (CD/ONCOURSE) — operator clicked
  //     the wrong horse and corrected it. The physical timer keeps running,
  //     so we carry the clock forward and just swap the entry. No INTRO flash.
  //
  // (B) New entry from IDLE or without a prior INTRO — watcher restarted
  //     mid-entry, intro UDP lost, or operator skipped the intro step.
  //     Synthesize an INTRO so the live page sets up the on-course banner.
  if (entry && entry !== lastEntry && phase !== 'INTRO' && phase !== 'IDLE' && phase !== 'FINISH') {
    const ri = inferRound(entry, ta);

    if (lastPhase === 'ONCOURSE' || lastPhase === 'CD') {
      // (A) Entry switch mid-run — carry the timestamps, keep the current phase
      log(`[ENTRY SWITCH] #${lastEntry} → #${entry} mid-${lastPhase} — clock carries forward`);
      fireEvent('ENTRY_SWITCH', { from: lastEntry, to: entry, horse, rider, elapsed });

      // Post the correct event for the CURRENT phase, not always ON_COURSE
      if (phase === 'CD') {
        postToWorker('/postClassEvent',
          { event: 'CD_START', entry, horse, rider, owner, city, state,
            countdown: parseInt(cd) || 0, ta: ta || '',
            round: ri.round, label: ri.label,
            faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
          `CD_START #${entry} (entry switch from #${lastEntry})`);
      } else {
        postToWorker('/postClassEvent',
          { event: 'ON_COURSE', entry, horse, rider, owner, city, state,
            elapsed: parseInt(elapsed) || 0, ta: ta || '',
            round: ri.round, label: ri.label,
            faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
          `ON_COURSE #${entry} (entry switch from #${lastEntry})`);
      }
      lastEntry = entry;
      lastTa    = ta;
      // DON'T change lastPhase — keep clock running in correct phase
    } else {
      // (B) New entry without prior INTRO.
      // If the incoming phase is CD, skip the synthetic INTRO — CD_START has
      // all the data needed and firing both causes a race condition where
      // INTRO can arrive at the Worker AFTER CD_START (both are fire-and-forget
      // fetch()) and overwrite the countdown state with a 45s intro clock.
      // For ONCOURSE, still synthesize INTRO so the banner shows entry info
      // (ONCOURSE event doesn't include all metadata the page needs).
      if (phase === 'CD') {
        // Just update state — the main event block below will fire CD_START
        // with the full entry data.
        log(`[DIRECT TO CD] #${entry} ${horse} — no intro received, going straight to countdown`);
        lastPhase = 'IDLE'; // forces the main block to fire CD_START (CD !== IDLE)
        lastEntry = entry;
        lastTa    = ta;
      } else {
        log(`[SYNTHETIC INTRO] #${entry} ${horse} — no intro received, synthesizing from ${phase} frame`);
        fireEvent('INTRO', { entry, horse, rider, ta, hunterScore: '', isHunter: false });
        postToWorker('/postClassEvent',
          { event: 'INTRO', entry, horse, rider, owner, city, state, ta: ta || '',
            round: ri.round, label: ri.label,
            faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
          `INTRO #${entry} (synthetic)`);
        lastPhase = 'INTRO';
        lastEntry = entry;
        lastTa    = ta;
      }
    }
  }

  // Fire events on phase change, entry change, OR TA change (round switch).
  // INTRO always re-fires (explicit operator action, KV TTL may expire).
  // FINISH re-fires when rank changes — Ryegate sends a first FINISH frame
  // on timer stop with rank empty, then a second frame after the operator
  // presses RANK with the actual placement. We need to forward both so the
  // live page shows the final rank, not just the bare finish time.
  const isRepeatIntro = (phase === 'INTRO' && lastPhase === 'INTRO' && entry === lastEntry);
  const isRankUpdate  = (phase === 'FINISH' && entry === lastEntry && rank !== lastRank);
  // Score frame ({19}=SCORE) = equitation Display Scores — always re-fire FINISH
  // with the actual rank and score, even though phase/entry haven't changed.
  if (phase !== lastPhase || entry !== lastEntry || ta !== lastTa || isRepeatIntro || isScoreFrame || isRankUpdate) {
    if (phase === 'INTRO' && (lastPhase !== 'INTRO' || isRepeatIntro)) {
      const ri = inferRound(entry, ta);
      fireEvent('INTRO', { entry, horse, rider, ta, hunterScore: hunterScore || '', isHunter: !!isHunterScore });
      postToWorker('/postClassEvent',
        { event: 'INTRO', entry, horse, rider, owner, city, state, ta: ta || '',
          round: ri.round, label: ri.label,
          faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
        `INTRO #${entry}`);
    }
    if (phase === 'CD' && lastPhase !== 'CD') {
      const ri = inferRound(entry, ta);
      fireEvent('CD_START', { entry, horse, rider, ta, countdown: cd, round: ri.round, label: ri.label });
      postToWorker('/postClassEvent',
        { event: 'CD_START', entry, horse, rider, owner, city, state,
          countdown: parseInt(cd) || 0, ta: ta || '',
          round: ri.round, label: ri.label,
          faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
        `CD_START #${entry}`);
    }
    if (phase === 'ONCOURSE' && lastPhase !== 'ONCOURSE') {
      // Post-FINISH stabilization: after a decimal FINISH time, Farmtek may
      // oscillate between integer (looks like ONCOURSE) and decimal (FINISH)
      // for a few seconds — especially on buzzer/elimination. Suppress false
      // ONCOURSE re-fires for the same entry UNLESS:
      //   - The TA changed (legitimate phase transition — two-phase PH1→PH2)
      //   - The entry changed (new horse)
      //   - The lock expired (5s — long enough for buzzer noise to settle)
      if (entry === lastEntry && ta === lastTa && Date.now() < finishLockUntil) {
        // Buzzer noise — suppress. Don't fire RIDE_START.
      } else {
        if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
        if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
        const ri = inferRound(entry, ta);
        const isPhaseTransition = entry === lastEntry && ta !== lastTa;
        if (isPhaseTransition) {
          logSeparator();
          log(`PHASE TRANSITION: #${entry} ${horse} — TA ${lastTa}→${ta} elapsed=${elapsed} ${ri.label}`);
          logSeparator();
        }
        fireEvent('RIDE_START', { entry, horse, rider, ta, jumpFaults: jump, timeFaults: time, round: ri.round, label: ri.label });
        postToWorker('/postClassEvent',
          { event: 'ON_COURSE', entry, horse, rider, owner, city, state,
            elapsed: parseInt(elapsed) || 0, ta: ta || '',
            round: ri.round, label: ri.label,
            faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
          isPhaseTransition ? `ON_COURSE #${entry} (PHASE TRANSITION: ${ri.label})` : `ON_COURSE #${entry}`);
      }
    }
    // TA changed mid-run (two-phase: PH1→PH2) — re-post with new round/TA
    if (phase === 'ONCOURSE' && lastPhase === 'ONCOURSE' && ta !== lastTa && entry === lastEntry) {
      const ri = inferRound(entry, ta);
      logSeparator();
      log(`PHASE TRANSITION (mid-course): #${entry} ${horse} — TA ${lastTa}→${ta} elapsed=${elapsed} ${ri.label}`);
      logSeparator();
      postToWorker('/postClassEvent',
        { event: 'ON_COURSE', entry, horse, rider, owner, city, state,
          elapsed: parseInt(elapsed) || 0, ta: ta || '',
          round: ri.round, label: ri.label,
          faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
        `ON_COURSE #${entry} (PHASE TRANSITION: ${ri.label})`);
    }
    if (phase === 'FINISH') {
      if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
      if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
      // Lock out false ONCOURSE re-fires for 5s. Farmtek oscillates between
      // decimal (FINISH) and integer (looks like ONCOURSE) after buzzer/elim.
      // The lock allows legitimate phase transitions through (TA change check).
      finishLockUntil = Date.now() + 5000;
      const { round, label } = inferRound(entry, ta);
      if (isHunterScore) {
        fireEvent('FINISH', { entry, horse, rider, rank, hunterScore, isHunter: true, round, label });
        postToWorker('/postClassEvent',
          { event: 'FINISH', entry, horse, rider, owner, city, state,
            rank, hunterScore, isHunter: true, round, label },
          `FINISH #${entry}`);
      } else {
        // For score frames ({19}=SCORE), {17} is the equitation score, not elapsed.
        // Don't overwrite the real elapsed with the score value.
        const finishElapsed = isScoreFrame ? '' : (elapsed || '');
        fireEvent('FINISH', { entry, horse, rider, rank, jumpFaults: jump, timeFaults: time, eqScore: eqScore || '', round, label });
        postToWorker('/postClassEvent',
          { event: 'FINISH', entry, horse, rider, owner, city, state,
            elapsed: finishElapsed, jumpFaults: jump, timeFaults: time,
            eqScore: eqScore || '', rank, round, label },
          `FINISH #${entry}` + (isScoreFrame ? ' (SCORE frame)' : ''));
      }
    }
  }

  if (phase === 'ONCOURSE' && jump !== lastJump && lastJump !== '') {
    fireEvent('FAULT', { entry, horse, rider, jumpFaults: jump, timeFaults: time, elapsed });
    postToWorker('/postClassEvent',
      { event: 'FAULT', entry, jumpFaults: jump, timeFaults: time },
      `FAULT #${entry} jf=${jump}`);
  }

  if (phase === 'CD') {
    if (cd !== lastCd) {
      if (cdStopTimer) { clearTimeout(cdStopTimer); cdStopTimer = null; }
      const lastEvent = udpEvents[udpEvents.length - 1];
      if (lastEvent && lastEvent.event === 'CD_STOPPED' && lastEvent.entry === entry) {
        fireEvent('CD_RESUMED', { entry, horse, rider, countdown: cd });
      }
      lastCd = cd;
    } else {
      if (!cdStopTimer) {
        cdStopTimer = setTimeout(() => {
          cdStopTimer = null;
          fireEvent('CD_STOPPED', { entry, horse, rider, countdown: cd });
        }, 2500);
      }
    }
  }

  if (phase === 'ONCOURSE') {
    if (elapsed !== lastElapsed) {
      if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
      const lastEvent = udpEvents[udpEvents.length - 1];
      if (lastEvent && lastEvent.event === 'CLOCK_STOPPED' && lastEvent.entry === entry) {
        fireEvent('CLOCK_RESUMED', { entry, horse, rider, elapsed });
        postToWorker('/postClassEvent',
          { event: 'CLOCK_RESUMED', entry, elapsed: parseInt(elapsed) || 0 },
          `CLOCK_RESUMED #${entry}`);
      }
      lastElapsed = elapsed;
    } else {
      if (!clockStopTimer) {
        clockStopTimer = setTimeout(() => {
          clockStopTimer = null;
          fireEvent('CLOCK_STOPPED', { entry, horse, rider, elapsed });
          postToWorker('/postClassEvent',
            { event: 'CLOCK_STOPPED', entry, elapsed: parseInt(elapsed) || 0 },
            `CLOCK_STOPPED #${entry}`);
        }, 2500);
      }
    }
  }

  lastPhase = phase;
  lastEntry = entry;
  lastTa    = ta;
  lastJump  = jump;
  lastRank  = rank || '';
}

// Module-scoped reference to the active scoreboard UDP socket so we can
// close + recreate it when the operator changes the scoreboard port in
// Ryegate mid-session (config.dat watcher catches the change).
let udpSocket = null;
let currentScoreboardPort = null;

function startUdpListener(scoreboardPort) {
  const dgram  = require('dgram');
  // reuseAddr: rebind through Windows TIME_WAIT (cleanup after restart).
  // (reusePort is Linux-only — would throw ENOTSUP on Windows.)
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpSocket = socket;
  currentScoreboardPort = scoreboardPort;

  socket.on('error', (err) => {
    udpLog(`ERROR: ${err.message}`);
    log(`[UDP] bind error on port ${scoreboardPort}: ${err.message}`);
    // EADDRINUSE on Windows when RSServer.exe (Ryegate scoreboard
    // software) holds the port with SO_EXCLUSIVEADDRUSE. We can't
    // coexist — run in DEGRADED MODE: no UDP events fire, but the
    // .cls / tsked / config.dat watchers keep posting schedule + class
    // data to the worker. Live pages lose on-course banners + clock
    // but still get standings, schedule, and final results. Post-show
    // fix is a pcap-based capture that bypasses the socket layer.
    if (err.code === 'EADDRINUSE' || err.code === 'ENOTSUP') {
      log(`[UDP] DEGRADED MODE — ${scoreboardPort} unavailable (${err.code}). File watchers still running; no live on-course events.`);
      try { socket.close(); } catch (e) {}
      if (udpSocket === socket) udpSocket = null;
      return; // don't exit — keep the .cls / tsked watchers alive
    }
    try { socket.close(); } catch (e) {}
    if (udpSocket === socket) udpSocket = null;
  });

  socket.on('listening', () => {
    udpLog(`Listening on scoreboard port ${scoreboardPort}`);
  });

  socket.on('message', (msg) => {
    const raw  = msg.toString('ascii').trim();
    const tags = parseUdpPacket(msg);
    const fr = tags['fr'] || '';

    // ── Raw packet log — always log every unique packet for research ──────────
    // Hunter and jumper have different tag sets — log everything so we can map them
    const allTags = Object.entries(tags).map(([k,v]) => `{${k}}=${v}`).join(' ');
    udpLog(`[UDP] fr=${fr} ${allTags}`);
    udpLog(`[RAW] ${raw.substring(0, 200)}`);

    // ── Hunter {fr}=11 — ON COURSE signal ─────────────────────────────────────
    // {17} in hunter packets is scoreboard message text, NOT elapsed time.
    // Page A (has {3} rider) = entry info → track + post ON_COURSE
    // Page B (has {18} sire) = breeding info → ignore (display only)
    //
    // Flat classes rotate all entries rapidly (~2s per page). We track every
    // entry seen in flatEntriesSeen and include the full list in each post
    // so the live page can show "entries in the ring" instead of flickering
    // between individual on-course cards.
    if (fr === '11') {
      const allFr11Tags = Object.entries(tags).map(([k,v]) => `{${k}}=${v}`).join(' ');
      udpLog(`[FR11 FULL] ${allFr11Tags}`);
      // Equitation uses {7}=rider, {6}=city/state, {2}=empty (no horse)
      // Normal hunter uses {3}=rider, {2}=horse, {4}=owner
      const isEqFrame = !tags['3'] && !!tags['7'];
      if (tags['3'] || isEqFrame) {
        const hEntry = (tags['1'] || '').trim();
        const hHorse = isEqFrame ? '' : (tags['2'] || '').trim();
        const hRider = isEqFrame ? (tags['7'] || '').trim() : (tags['3'] || '').trim();
        const hOwner = isEqFrame ? '' : (tags['4'] || '').trim();
        const hLocale = isEqFrame ? (tags['6'] || '').trim() : '';

        // Track this entry in the flat rotation set
        const isNew = !flatEntriesSeen[hEntry];
        flatEntriesSeen[hEntry] = { entry: hEntry, horse: hHorse, rider: hRider, owner: hOwner, locale: hLocale, isEq: isEqFrame };

        if (isNew) {
          udpLog(`[HUNTER ON_COURSE] #${hEntry} ${hHorse} / ${hRider}`);
        }

        // Build ordered list of entries seen so far
        const flatList = Object.values(flatEntriesSeen);

        postToWorker('/postClassEvent',
          { event: 'ON_COURSE', entry: hEntry, horse: hHorse, rider: hRider, owner: hOwner,
            isHunter: true, flatEntries: flatList },
          isNew ? `ON_COURSE #${hEntry}` : `ON_COURSE #${hEntry} (rotation)`);
      }
      return;
    }

    // ── Hunter {fr}=14 — RESULTS DISPLAY (flat/forced classes) ─────────────────
    // Operator announces ribbons one at a time. Each fr=14 frame carries one
    // entry + its placement. We accumulate them in hunterResults and post each
    // as a HUNTER_RESULT event so the live page can render ribbons in real time.
    // tags: {1}=entry {2}=horse {3}=rider {4}=owner {8}=place ("1st","2nd",...)  {14}=score (empty for forced)
    if (fr === '14') {
      const rEntry = (tags['1'] || '').trim();
      const rHorse = (tags['2'] || '').trim();
      const rRider = (tags['3'] || '').trim();
      const rOwner = (tags['4'] || '').trim();
      const rPlace = (tags['8'] || '').trim();
      const rScore = (tags['14'] || '').trim();

      // Dedupe — don't re-add if we already have this entry in the results
      if (!hunterResults.some(function(r) { return r.entry === rEntry; })) {
        hunterResults.push({ entry: rEntry, horse: rHorse, rider: rRider, owner: rOwner, place: rPlace, score: rScore });
        udpLog(`[HUNTER RESULT] #${rEntry} ${rHorse} / ${rRider} — ${rPlace}${rScore ? ' score=' + rScore : ''}`);

        postToWorker('/postClassEvent',
          { event: 'HUNTER_RESULT', entry: rEntry, horse: rHorse, rider: rRider, owner: rOwner,
            place: rPlace, score: rScore, isHunter: true, hunterResults: hunterResults.slice() },
          `HUNTER_RESULT #${rEntry} ${rPlace}`);
      }
      return;
    }

    // ── Hunter {fr}=12 / {fr}=16 — DISPLAY SCORES signal ─────────────────────
    // Operator pressed "Display Scores" in Ryegate.
    //   fr=12 = regular hunter (per-judge scores in {21}/{22}/...)
    //   fr=16 = derby (larger fields for hi-opt + bonus)
    // Both do the same thing: force a fresh read of the selected class file
    // and post it FIRST so the Worker has the latest standings by the time
    // the FINISH event hits the live page. Otherwise there's a race where
    // fs.watch lags the UDP frame and the live page briefly shows stale data.
    // tags: {1}=entry {2}=horse {3}=rider {8}="RANK: N" {14}=total {21}+=judge scores
    if (fr === '12' || fr === '16') {
      const dEntry = (tags['1'] || '').trim();
      const dHorse = (tags['2'] || '').trim();
      const dRider = (tags['3'] || '').trim();
      const dRank  = (tags['8'] || '').replace(/^RANK:\s*/i, '').trim();
      udpLog(`[HUNTER DISPLAY SCORES fr=${fr}] #${dEntry} ${dHorse} / ${dRider} rank=${dRank}`);

      // Fresh read + post class data BEFORE the FINISH event
      if (selectedClassNum) {
        const filename = selectedClassNum + '.cls';
        const fullPath = path.join(CLASSES_DIR, filename);
        const content = safeRead(fullPath);
        if (content) {
          // Update cache so the subsequent fs.watch event doesn't re-post
          fileStates[filename] = content;
          const parsed = parseCls(content, filename);
          if (parsed) {
            postToWorker('/postClassData', { ...parsed, clsRaw: content }, `postClassData ${filename} (fr=${fr} forced)`);
            udpLog(`[HUNTER fr=${fr}] Forced re-post of ${filename}`);
          }
        }
      }

      postToWorker('/postClassEvent',
        { event: 'FINISH', entry: dEntry, horse: dHorse, rider: dRider, rank: dRank, isHunter: true },
        `HUNTER FINISH #${dEntry}`);
      return;
    }

    // ── {fr}=0 — CLEAR FRAME — scoreboard wiped ────────────────────────────────
    if (fr === '0') {
      udpLog(`[CLEAR FRAME] Scoreboard cleared`);
      postToWorker('/postClassEvent',
        { event: 'CLEAR_ONCOURSE' },
        'CLEAR_ONCOURSE (frame 0)');
      lastPhase = 'IDLE';
      lastEntry = '';
      lastTa    = '';
      return;
    }

    // ── Skip other hunter frames ({fr}=12-16) — .cls is authoritative ─────────
    if (fr && fr !== '1') return;

    // ── UDP type hint — first jumper frame for the selected class flags it ───
    // as a jumper even if Ryegate hasn't yet written T/J to the .cls header.
    // Only triggers when there's an actual entry in the packet (avoids
    // hinting on heartbeat / placeholder frames).
    const hintEntry = (tags['1'] || '').trim();
    if (selectedClassNum && hintEntry && !udpTypeHints[selectedClassNum]) {
      udpTypeHints[selectedClassNum] = 'T';
      udpLog(`[TYPE HINT] class ${selectedClassNum} = T (first jumper UDP frame)`);
      // Force a re-post of the .cls so the worker picks up the type override
      // immediately, instead of waiting for the next .cls write.
      try {
        const fname = selectedClassNum + '.cls';
        const fp = path.join(CLASSES_DIR, fname);
        const cnt = safeRead(fp);
        if (cnt) {
          fileStates[fname] = cnt;
          const reparsed = parseCls(cnt, fname);
          if (reparsed) {
            postToWorker('/postClassData', { ...reparsed, clsRaw: cnt }, `postClassData ${fname} (type-hint forced)`);
          }
        }
      } catch (e) { udpLog(`[TYPE HINT] re-post failed: ${e.message}`); }
    }

    // ── Known jumper tags ─────────────────────────────────────────────────────
    const entry   = cleanUdpVal('1',  tags['1']  || '');
    const horse   = cleanUdpVal('2',  tags['2']  || '');
    const rider   = cleanUdpVal('3',  tags['3']  || '');
    const ta      = cleanUdpVal('13', tags['13'] || '');
    let   jump    = cleanUdpVal('14', tags['14'] || '');
    let   time    = cleanUdpVal('15', tags['15'] || '');
    const elapsed = cleanUdpVal('17', tags['17'] || '');
    const cd      = cleanUdpVal('23', tags['23'] || '');
    const rank    = cleanUdpVal('8',  tags['8']  || '');
    // Equitation sends {14}=TIME and {15}=FLTS as text labels instead of
    // numeric values. Sanitize to '0' so downstream pages don't get NaN.
    if (jump && isNaN(parseFloat(jump))) jump = '0';
    if (time && isNaN(parseFloat(time))) time = '0';

    // Equitation Display Scores: tag {19}=SCORE signals this is a score frame.
    // When present, {17} = equitation score (not elapsed time), {8} = final rank.
    const isScoreFrame = (tags['19'] || '').toUpperCase().includes('SCORE');
    const eqScore = isScoreFrame ? elapsed : ''; // {17} is the score, not time

    // ── Hunter-specific tags (confirmed 2026-03-23) ───────────────────────────
    // tag {14} = H:XX.XXX when hunter score present (H: prefix)
    // tag {8}  = ': 1st' / ': EL' format (colon-space prefix — strip it)
    const isHunterScore = (tags['14'] || '').startsWith('H:');
    const hunterScore   = isHunterScore ? (tags['14'] || '').replace('H:', '').trim() : '';
    const rankClean     = (tags['8'] || '').replace(/^:\s*/, '').trim();  // strip ': ' prefix

    let phase = 'IDLE';
    if (entry && !cd && !elapsed && !rankClean) phase = 'INTRO';
    if (cd)                                      phase = 'CD';
    if (elapsed && !rankClean)                   phase = 'ONCOURSE';
    if (rankClean)                               phase = 'FINISH';
    // FINISH metric #2: precise decimal time in elapsed field.
    // Physical timers count in whole seconds during a run (8, 9, 10...) then
    // snap to precise millisecond time on stop (28.990). If elapsed has a
    // decimal AND no rank tag, the timer has likely stopped.
    // NOTE: Farmtek timers may emit decimal times on PAUSE too — the clock
    // can resume after a pause. For now, classify as FINISH on decimal time.
    // If Farmtek pause causes false FINISH, the next ONCOURSE frame (when
    // timer resumes) will re-trigger a synthetic INTRO or ENTRY_SWITCH and
    // the clock restarts. Acceptable trade-off: brief false finish on pause
    // is better than a clock that never stops on equitation/manual-time.
    if (phase === 'ONCOURSE' && elapsed && elapsed.includes('.') && !rankClean) {
      phase = 'FINISH';
    }

    // Suppress duplicate log lines
    const stateKey = entry || 'idle';
    const stateStr = JSON.stringify({ phase, entry, elapsed, cd, jump, time, rankClean, hunterScore });
    if (udpLastLogged[stateKey] !== stateStr) {
      udpLastLogged[stateKey] = stateStr;
      if (phase !== 'IDLE') {
        if (isHunterScore) {
          udpLog(`[${phase}] #${entry} ${horse} | score=${hunterScore} rank=${rankClean}`);
        } else {
          udpLog(`[${phase}] #${entry} ${horse} | cd=${cd} el=${elapsed} jmp=${jump} rank=${rankClean}`);
        }
      }
    }

    detectEvents(phase, entry, horse, rider, ta, cd, elapsed, jump, time, rankClean, hunterScore, isHunterScore, isScoreFrame, eqScore);
  });

  socket.bind(scoreboardPort);
}

// Restart the UDP listener on a new port. Closes the existing socket cleanly
// then opens a new one. Used by the config.dat watcher when the operator
// changes the scoreboard port in Ryegate's hardware settings.
function restartUdpListener(newPort) {
  if (currentScoreboardPort === newPort) {
    udpLog(`[CONFIG] scoreboard port unchanged (${newPort}), skipping restart`);
    return;
  }
  udpLog(`[CONFIG] scoreboard port changing: ${currentScoreboardPort} -> ${newPort}, restarting UDP listener`);
  if (udpSocket) {
    try { udpSocket.close(); } catch(e) { udpLog(`[CONFIG] error closing old socket: ${e.message}`); }
    udpSocket = null;
  }
  // Slight delay to make sure the OS releases the port
  setTimeout(() => {
    startUdpListener(newPort);
  }, 200);
}

// Watch config.dat for changes. Ryegate flushes config.dat on hardware
// settings changes (UDP port etc.) and on clean exit. Live Scoring toggles
// alone don't trigger a flush — see CLS-FORMAT.md "config.dat is partially
// in-memory cached" caveat.
//
// Debounced because Windows fs.watch fires the change event twice for one
// write (once for metadata, once for content). We re-read on each event but
// only act on actual content diffs vs the last-known state.
function watchConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    log(`[CONFIG] watch skipped — ${CONFIG_PATH} does not exist`);
    return;
  }
  let lastContent = safeRead(CONFIG_PATH) || '';
  let debounceTimer = null;

  function handleChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const content = safeRead(CONFIG_PATH);
      if (!content) return;
      if (content === lastContent) return; // mtime touched, no real diff

      // Snapshot the new state for the change log
      saveSnapshot('config.dat', content, 'live-change');

      const oldCols = (lastContent.split(/\r?\n/)[0] || '').split(',');
      const newCols = (content.split(/\r?\n/)[0] || '').split(',');

      // Diff every line-0 column and log meaningful changes
      const interesting = {
        1:  'UDPPort',
        7:  'col[7]',
        8:  'LiveScoring',
        9:  'col[9]',
      };
      const changes = [];
      const maxLen = Math.max(oldCols.length, newCols.length);
      for (let i = 0; i < maxLen; i++) {
        if (oldCols[i] !== newCols[i]) {
          const label = interesting[i] || ('col[' + i + ']');
          changes.push(`${label}: ${JSON.stringify(oldCols[i])} -> ${JSON.stringify(newCols[i])}`);
        }
      }
      if (changes.length) {
        log('');
        log('[CONFIG CHANGED]');
        changes.forEach(c => log('  ' + c));
      }

      // Act on UDP port changes — restart the listener on the new port
      const newPort = parseInt(newCols[1]);
      if (newPort && newPort > 0 && newPort !== currentScoreboardPort) {
        restartUdpListener(newPort);
      }

      // Re-evaluate timer-system default for U→? inference
      const newTimer = String(newCols[2] || '').toLowerCase();
      const newDefault = newTimer.indexOf('farmtek') >= 0 ? 'J' : 'T';
      if (newDefault !== defaultJumperType) {
        log(`[CONFIG] Timer default changed: ${defaultJumperType} → ${newDefault}`);
        defaultJumperType = newDefault;
      }

      lastContent = content;
    }, 150);
  }

  try {
    fs.watch(CONFIG_PATH, (event) => {
      if (event === 'change') handleChange();
    });
    log(`[CONFIG] watching ${CONFIG_PATH} for changes`);
  } catch(e) {
    log(`[CONFIG] watch failed: ${e.message}`);
  }
}

// ── START UDP ─────────────────────────────────────────────────────────────────

initUdpLog();
initPeekLog();

// Read scoreboard port + timer-system default from config.dat
const configContent = safeRead(CONFIG_PATH);
let scoreboardPort = 29711; // default
if (configContent) {
  try {
    const configCols = parseCSVLine(configContent.split(/\r?\n/)[0]);
    const rawPort    = parseInt(configCols[1]);
    if (rawPort && rawPort > 0) scoreboardPort = rawPort;
    // col[2] identifies the timing system. Farmtek setups → default U to J.
    // Anything else (TIMY, FDS, blank) → keep default T.
    const timerField = String(configCols[2] || '').toLowerCase();
    defaultJumperType = timerField.indexOf('farmtek') >= 0 ? 'J' : 'T';
    log(`[CONFIG] Timer system: ${configCols[2] || '(blank)'} → default U→${defaultJumperType}`);
  } catch(e) {}
}

udpLog('');
udpLog('═'.repeat(72));
udpLog(`WEST Scoring Live Watcher v${WATCHER_VERSION}`);
udpLog(`Scoreboard port: ${scoreboardPort} | Class complete port: ${CLASS_COMPLETE_PORT}`);
udpLog('═'.repeat(72));
log(`WEST Scoring Live Watcher v${WATCHER_VERSION} starting`);

// Watcher is a pure UDP observer (v1.3.0+). UDP port is auto-derived
// from Ryegate's scoreboard port:
//   watcherUdpPort = 28000 + (ryegateScoreboardPort - 29696)
// Funnel uses the same formula for its watcher-facing output. Nothing
// to configure — operator only changes Ryegate's scoreboard port if at
// all, everything else shifts in lockstep.
//
// Big-show setup (separate scoring + production PCs with no funnel) is
// a follow-up: add an explicit override key when that case actually
// comes up.
const watcherUdpPort = 28000 + (scoreboardPort - 29696);
log(`[UDP] watcher UDP port = ${watcherUdpPort} (auto-derived from Ryegate scoreboard port ${scoreboardPort})`);

startUdpListener(watcherUdpPort);
startPort31000Listener();
watchConfigFile();

