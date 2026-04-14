/**
 * WEST Scoring Live — Class File Watcher (pcap edition)
 *
 * Watches C:\Ryegate\Jumper\Classes for .cls file changes,
 * captures UDP scoreboard frames via npcap (bypasses Windows'
 * SO_EXCLUSIVEADDRUSE that RSServer.exe holds on port 29696).
 *
 * Requirements on the scoring PC:
 *   - Node.js LTS
 *   - npcap driver (https://npcap.com/) — installs cleanly,
 *     Wireshark ships it
 *   - `npm install` in this folder to pull the `cap` binding
 *   - Run as Administrator (pcap capture requires it)
 */

const WATCHER_VERSION = '2.0.0-draft1';

const fs   = require('fs');
const path = require('path');

// ── PCAP CAPTURE (npcap on Windows, libpcap elsewhere) ───────────────────────
// RSServer.exe exclusive-binds UDP 29696 on the scoring PC. Instead of
// fighting for the socket, we tap the packet stream at the driver level.
// Requires npcap installed (https://npcap.com — Wireshark ships it) and
// the process running as Administrator.
let Cap, decoders, PROTOCOL;
try {
  const capMod = require('cap');
  Cap       = capMod.Cap;
  decoders  = capMod.decoders;
  PROTOCOL  = decoders.PROTOCOL;
} catch (e) {
  console.error('[PCAP] cap module not installed. Run "npm install" in this folder.');
  console.error('       Also install npcap from https://npcap.com if not already present.');
  process.exit(1);
}

// Capture UDP frames on `dstPort`, decode Eth+IPv4+UDP, call handler(payload).
// Opens a capture on every non-loopback IPv4 device so we catch Ryegate
// broadcasts regardless of which NIC is the primary.
function startPcapListener(dstPort, handler, label) {
  const devices = Cap.deviceList();
  const filter  = `udp and dst port ${dstPort}`;
  const bufSize = 10 * 1024 * 1024;
  let opened = 0;

  devices.forEach(dev => {
    // Skip loopback + adapters without an IPv4 address
    const hasIpv4 = (dev.addresses || []).some(a => a.addr && a.addr.indexOf('.') >= 0);
    if (!hasIpv4) return;
    if ((dev.flags || '').toLowerCase().indexOf('loopback') >= 0) return;

    try {
      const c        = new Cap();
      const buffer   = Buffer.alloc(65535);
      const linkType = c.open(dev.name, filter, bufSize, buffer);

      c.on('packet', function (nbytes /*, trunc */) {
        try {
          if (linkType !== 'ETHERNET') return;
          let r = decoders.Ethernet(buffer);
          if (r.info.type !== PROTOCOL.ETHERNET.IPV4) return;
          r = decoders.IPV4(buffer, r.offset);
          if (r.info.protocol !== PROTOCOL.IP.UDP) return;
          const udp = decoders.UDP(buffer, r.offset);
          // udp.info.length INCLUDES the 8-byte UDP header
          const payloadLen = udp.info.length - 8;
          if (payloadLen <= 0) return;
          const payload = Buffer.from(buffer.slice(udp.offset, udp.offset + payloadLen));
          handler(payload);
        } catch (err) {
          // Log and continue — malformed frames shouldn't kill the listener.
          try { console.error(`[PCAP ${label}] decode error: ${err.message}`); } catch(_) {}
        }
      });

      opened++;
      try { console.log(`[PCAP ${label}] capturing ${filter} on ${dev.description || dev.name}`); } catch(_) {}
    } catch (err) {
      try { console.error(`[PCAP ${label}] failed to open ${dev.name}: ${err.message}`); } catch(_) {}
    }
  });

  if (!opened) throw new Error(`[PCAP ${label}] no devices opened — is npcap installed and are you Administrator?`);
  return opened;
}

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
let LOG_PATH        = (process.env.USERPROFILE || 'C:\\Users\\Public') + '\\Desktop\\west_log.txt';
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

async function peekClass(classNum) {
  const url = buildPeekUrl(classNum);
  if (!url) return null;

  try {
    const https = require('https');
    const http = require('http');
    const mod = url.startsWith('https') ? https : http;

    return new Promise((resolve, reject) => {
      const req = mod.get(url, { timeout: 8000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (/please\s+check\s+back/i.test(body))       return resolve('NOT_STARTED');
          if (/ON COURSE/i.test(body))                    return resolve('LIVE');
          if (/\d+\s+of\s+\d+\s+Competed/i.test(body))   return resolve('IN_PROGRESS');
          // Order of Go posted — page has entries but no scores yet.
          // Without this check, peek would see "no ON COURSE, no Competed,
          // has table" and wrongly classify it as UPLOADED (final results).
          if (/order\s+of\s+go/i.test(body))              return resolve('ORDER_POSTED');
          // No live indicators and not an order of go — results have been uploaded
          // Verify there's actually content (not an empty/error page)
          if (/<table/i.test(body) && /class="CBody"/i.test(body)) return resolve('UPLOADED');
          resolve('UNKNOWN');
        });
      });
      req.on('error', (e) => resolve('ERROR'));
      req.on('timeout', () => { req.destroy(); resolve('ERROR'); });
    });
  } catch(e) {
    return 'ERROR';
  }
}

function startPeekPolling(classNum) {
  stopPeekPolling();
  if (!ryegateLivePath) {
    log('[PEEK] No ryegate.live path configured — peek disabled');
    return;
  }
  // Skip peek for test/nonexistent paths — NONWEST is the default test path
  // that doesn't exist on ryegate.live. Real shows have paths like
  // SHOWS/West/2026/Culpeper/wk1/ring1 with at least 3 path segments.
  var segments = ryegateLivePath.replace(/^SHOWS\//i, '').split('/').filter(Boolean);
  if (segments.length < 3 || /^NONWEST$/i.test(segments[0])) {
    log('[PEEK] Test path detected (' + ryegateLivePath + ') — peek disabled until real show configured');
    return;
  }
  const url = buildPeekUrl(classNum);
  log(`[PEEK] Starting poll for class ${classNum}: ${url}`);
  peekLastState[classNum] = null; // reset

  function scheduleNext() {
    // Randomized 15–30 second interval — no fixed cadence
    const delay = 15000 + Math.floor(Math.random() * 15000);
    peekTimer = setTimeout(async () => {
      if (!selectedClassNum || selectedClassNum !== classNum) {
        log(`[PEEK] class ${classNum} no longer active — stopping`);
        return;
      }

      const state = await peekClass(classNum);
      const prev = peekLastState[classNum];

      if (state === 'ERROR' || state === 'UNKNOWN' || state === null) {
        // Can't get definitive proof — go dormant, let other signals handle it.
        // Don't keep polling a page that returns garbage.
        if (state === 'ERROR') {
          // Network issue — retry a few more times then go dormant
          peekErrorCount = (peekErrorCount || 0) + 1;
          if (peekErrorCount >= 3) {
            log(`[PEEK] class ${classNum}: 3 consecutive errors — going dormant`);
            return; // stop polling
          }
          scheduleNext();
          return;
        }
        // UNKNOWN or null — page exists but isn't a recognizable results page
        log(`[PEEK] class ${classNum}: unrecognizable page — going dormant`);
        return; // stop polling, other signals will handle detection
      }
      peekErrorCount = 0; // reset on any successful read

      if (state !== prev) {
        log(`[PEEK] class ${classNum}: ${prev || '(init)'} → ${state}`);
        peekLastState[classNum] = state;
      }

      // Forward ORDER_POSTED state to Worker — live page can show an OOG badge
      if (state === 'ORDER_POSTED' && prev !== 'ORDER_POSTED') {
        postToWorker('/postClassEvent',
          { event: 'ORDER_POSTED', classNum },
          `ORDER_POSTED class ${classNum} (via peek)`);
      }

      // Detect LIVE/IN_PROGRESS → UPLOADED transition
      if (state === 'UPLOADED' && (prev === 'LIVE' || prev === 'IN_PROGRESS')) {
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
          handleClassComplete(classNum, className);
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

// ── IDLE TIMEOUT ─────────────────────────────────────────────────────────────
// If no .cls changes occur for 30 minutes on the active class, fire
// CLASS_COMPLETE as a final safety net. Resets on every .cls write.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let idleTimer = null;

function resetIdleTimer(classNum) {
  if (idleTimer) clearTimeout(idleTimer);
  if (!classNum) return;

  idleTimer = setTimeout(() => {
    if (!selectedClassNum || selectedClassNum !== classNum) return;
    if (!shouldCommit(classNum, '30-min idle')) return;

    let className = '';
    const clsContent = fileStates[classNum + '.cls'];
    if (clsContent) {
      try {
        const parsed = parseCls(clsContent, classNum + '.cls');
        if (parsed && parsed.className) className = parsed.className;
      } catch(e) {}
    }

    logSeparator();
    log(`★ CLASS COMPLETE — class ${classNum} via 30-minute idle timeout`);
    logSeparator();
    handleClassComplete(classNum, className);
  }, IDLE_TIMEOUT_MS);
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
  const url = WORKER_URL + endpoint;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-West-Key': AUTH_KEY },
    body:    JSON.stringify({ ...body, slug: SHOW_SLUG, ring: SHOW_RING }),
    signal:  ctrl.signal,
  })
  .then(async r => {
    clearTimeout(timer);
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      log(`[POST] ${label || endpoint} — HTTP ${r.status}: ${text.slice(0, 300)}`);
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(text); } catch {}
    if (parsed.locked) {
      log(`[POST] ${label || endpoint} — show is locked, worker rejected (will retry on next trigger)`);
      return;
    }
    if (parsed.ok && onSuccess) onSuccess(parsed);
  })
  .catch(e => {
    clearTimeout(timer);
    if (e.name !== 'AbortError') log(`[POST] ${label || endpoint} failed: ${e.message}`);
  });
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
      // * Farmtek: col[39]. TIMY: col[82]=R1 status, col[83]=R2 status (updated 2026-04-03)
      if (isFarmtek) {
        entry.statusCode = cols[39] || '';
      } else {
        entry.r1StatusCode = cols[82] || '';
        entry.r2StatusCode = cols[83] || '';
        // Numeric status fallback — Ryegate writes numeric codes at
        // col[21]=R1 status and col[28]=R2 status but often leaves the text
        // columns (col[82]/[83]) blank for R2 declines like WD. Map numeric
        // → text when text is empty so the .cls is self-sufficient even if
        // the UDP finish frame is missed. Confirmed: 3=HF, 4=WD.
        const NUM_STATUS = { '1':'EL', '2':'RF', '3':'HF', '4':'WD', '5':'RT', '6':'DNS' };
        if (!entry.r1StatusCode && cols[21] && cols[21] !== '0') {
          entry.r1StatusCode = NUM_STATUS[cols[21]] || entry.r1StatusCode;
        }
        if (!entry.r2StatusCode && cols[28] && cols[28] !== '0') {
          entry.r2StatusCode = NUM_STATUS[cols[28]] || entry.r2StatusCode;
        }
        entry.statusCode   = entry.r2StatusCode || entry.r1StatusCode || ''; // most recent round's status
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
  lines.forEach((line, i) => {
    const cols = parseCSVLine(line);
    if (i === 0) {
      log(`  Show: ${cols[0]} | Dates: ${cols[1]}`);
    } else {
      const classNum = (cols[0] || '').trim();
      const date     = (cols[2] || '').trim();
      const flag     = (cols[3] || '').trim();
      log(`  Class ${classNum}: ${cols[1]} | Date: ${date} | Flag: ${flag}`);

      if (classNum && date) {
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
      }
    }
  });

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

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
// Sends alive signal to Worker every 60 seconds
// Worker uses this to flip show status from pending → active
setInterval(() => {
  postToWorker('/heartbeat', {
    version:       '2.2',
    scoreboardPort: scoreboardPort || '',
  }, 'heartbeat');
}, 60000);

// Send one immediately on startup
setTimeout(() => {
  postToWorker('/heartbeat', {
    version:       '2.2',
    scoreboardPort: scoreboardPort || '',
  }, 'heartbeat (startup)');
  log('Heartbeat sent to Worker');
}, 2000);

// ── UDP LOGGING ───────────────────────────────────────────────────────────────

let UDP_LOG_PATH = null;

function initUdpLog() {
  const candidates = [
    (process.env.USERPROFILE || '') + '\\Desktop\\west_udp_log.txt',
    'C:\\Users\\Public\\Desktop\\west_udp_log.txt',
    'C:\\west_udp_log.txt',
    path.join(path.dirname(process.execPath || ''), 'west_udp_log.txt'),
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
  try {
    const opened = startPcapListener(CLASS_COMPLETE_PORT, handlePort31000Packet, '31000');
    log(`[PCAP] class-complete capture on ${opened} device(s)`);
  } catch (err) {
    log(`[PCAP] class-complete capture failed: ${err.message}`);
  }
}

function handlePort31000Packet(msg) {
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
}

let selectedClassNum = null; // tracks most recent Ctrl+A class for inferRound
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
  log(`CLASS SELECTED: class ${classNum} — ${className}`);
  log(`  Screens watching this class will refresh`);
  logSeparator();

  postToWorker('/postClassEvent',
    { event: 'CLASS_SELECTED', classNum, className },
    `CLASS_SELECTED class ${classNum}`);

  // Start ryegate.live peek polling for this class (randomized 15–30s interval)
  startPeekPolling(classNum);

  // Start 30-minute idle timer — resets on every .cls write
  resetIdleTimer(classNum);

  // Re-post this class's current data 300ms later so the Worker's live: KV
  // gets populated with the right class immediately after selected: KV is set.
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

  // Stop peek polling and idle timer — class is done
  stopPeekPolling();
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

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
let clockStopTimer = null;
let cdStopTimer    = null;

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

      // ── PRIMARY: TA matching ────────────────────────────────────────────
      // Each round has its own r{N}TimeAllowed. Whichever the UDP TA matches
      // is unambiguously the round Ryegate is currently running. This works
      // for any scoring method that has multiple rounds with different TAs,
      // including two-phase (different TA per phase). Robust against parse
      // races where parsed.entries might not contain the current entry yet.
      const ta1 = parseFloat(parsed.r1TimeAllowed);
      const ta2 = parseFloat(parsed.r2TimeAllowed);
      const ta3 = parseFloat(parsed.r3TimeAllowed);
      const r1Match = taNum > 0 && taNum === ta1;
      const r2Match = taNum > 0 && taNum === ta2;
      const r3Match = taNum > 0 && taNum === ta3;

      if (r1Match && !r2Match && !r3Match) return result(1);
      if (r2Match && !r1Match && !r3Match) return result(2);
      if (r3Match && !r1Match && !r2Match) return result(3);

      // ── FALLBACK 1: two-phase entry inspection ──────────────────────────
      // When TAs are ambiguous (e.g. r1TA == r2TA), use whether the entry
      // already has r2 data. If yes → on PH2, otherwise → on PH1.
      if (isTwoPhase) {
        const entry = parsed.entries.find(e => e.entryNum === entryNum);
        if (entry && entry.r2TotalTime) return result(2);
        return result(1);
      }

      // ── FALLBACK 2: roundsCompleted counter from class header ──────────
      // Cap at the method's max rounds so single-round classes (II.1, Optimum)
      // never advance to "round 2" / "Jump Off" after all entries have gone.
      const rc = parseInt(parsed.roundsCompleted) || 0;
      if (rc === 0) return result(1);
      if (rc >= maxRounds) return result(maxRounds);
      if (rc === 1) return result(2);
      return result(3);
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
  // FINISH re-fires when rank changes (Display Scores sends a second FINISH
  // frame with the actual rank — e.g. equitation first FINISH has empty rank,
  // then Display Scores adds "RANK 1" with the equitation score).
  const isRepeatIntro = (phase === 'INTRO' && lastPhase === 'INTRO' && entry === lastEntry);
  // Score frame ({19}=SCORE) = equitation Display Scores — always re-fire FINISH
  // with the actual rank and score, even though phase/entry haven't changed.
  if (phase !== lastPhase || entry !== lastEntry || ta !== lastTa || isRepeatIntro || isScoreFrame) {
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
      if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
      if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
      const ri = inferRound(entry, ta);
      fireEvent('RIDE_START', { entry, horse, rider, ta, jumpFaults: jump, timeFaults: time, round: ri.round, label: ri.label });
      postToWorker('/postClassEvent',
        { event: 'ON_COURSE', entry, horse, rider, owner, city, state,
          elapsed: parseInt(elapsed) || 0, ta: ta || '',
          round: ri.round, label: ri.label,
          faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
        `ON_COURSE #${entry}`);
    }
    // TA changed mid-run (two-phase: PH1→PH2) — re-post with new round/TA
    if (phase === 'ONCOURSE' && lastPhase === 'ONCOURSE' && ta !== lastTa && entry === lastEntry) {
      const ri = inferRound(entry, ta);
      postToWorker('/postClassEvent',
        { event: 'ON_COURSE', entry, horse, rider, owner, city, state,
          elapsed: parseInt(elapsed) || 0, ta: ta || '',
          round: ri.round, label: ri.label,
          faultsPerInterval: ri.faultsPerInterval, timeInterval: ri.timeInterval, penaltySeconds: ri.penaltySeconds },
        `ON_COURSE #${entry} (TA change: ${ri.label})`);
    }
    if (phase === 'FINISH') {
      if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
      if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
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
}

// Module-scoped reference to the active scoreboard UDP socket so we can
// close + recreate it when the operator changes the scoreboard port in
// Ryegate mid-session (config.dat watcher catches the change).
let udpSocket = null;
let currentScoreboardPort = null;

function startUdpListener(scoreboardPort) {
  currentScoreboardPort = scoreboardPort;
  // v2.0 pcap path — capture UDP off the wire instead of binding a socket.
  // Works alongside RSServer.exe's exclusive bind on Windows.
  try {
    const opened = startPcapListener(scoreboardPort, handleScoreboardPacket, 'scoreboard');
    udpLog(`Capturing scoreboard port ${scoreboardPort} via pcap on ${opened} device(s)`);
  } catch (err) {
    log(`[PCAP] scoreboard capture failed: ${err.message}`);
    udpLog(`[PCAP] scoreboard capture failed: ${err.message}`);
  }
}

// Extracted from startUdpListener's socket.on('message', ...) so both the
// dgram path (v1) and pcap path (v2) can feed the same logic.
function handleScoreboardPacket(msg) {
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
}

// pcap path doesn't support mid-flight port changes (would need to tear
// down and reopen every device's capture). Log and ignore — operator
// must restart the watcher if Ryegate's scoreboard port changes.
function restartUdpListener(newPort) {
  log(`[PCAP] scoreboard port change to ${newPort} — restart watcher to rebind capture filter`);
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

startUdpListener(scoreboardPort);
startPort31000Listener();
watchConfigFile();

