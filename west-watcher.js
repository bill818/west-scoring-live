/**
 * WEST Scoring Live — Class File Watcher
 * Watches C:\Ryegate\Jumper\Classes for .cls file changes
 * Logs parsed data to Desktop\west_log.txt
 *
 * Usage: node west-watcher.js
 * Requirements: Node.js installed on scoring computer
 */

const fs   = require('fs');
const path = require('path');

const CLASSES_DIR   = 'C:\\Ryegate\\Jumper\\Classes';
const TSKED_PATH    = 'C:\\Ryegate\\Jumper\\tsked.csv';
const CONFIG_PATH   = 'C:\\Ryegate\\Jumper\\config.dat';
const SNAPSHOTS_DIR = 'C:\\west_snapshots';
const POLL_INTERVAL = 500;  // ms

// ── KNOWN COLUMN LABELS ───────────────────────────────────────────────────────
// Used in diff/dump output so Skippy can interpret the log

// Shared header cols 0-6 (same for Hunter and Jumper)
const HEADER_LABELS_SHARED = {
  0:  'ClassType',
  1:  'ClassName',
  2:  'ScoringMethodCode',   // jumper: 2=2a, 3=twoRounds+JO, 4=speed, 9=twoPhase, 13=2b
  3:  '?',
  // H[04]: 1=Farmtek, 2=TIMY — correlates with H[00] but may have additional meaning
  // WATCH: note if this changes value during or after a live class run
  4:  '?hardwareType_1=J_2=T',
  5:  'ClockPrecision',
  6:  'ImmediateJumpoff',    // jumper only: 1=immediate JO (2b), 0=clears return (2a)
};

// Jumper header cols (J and T) — confirmed by live raw data 2026-03-19
// Pattern per round: FaultsPerInterval, TimeAllowed, TimeInterval (3 cols, starts H[07])
const HEADER_LABELS_JUMPER = {
  ...HEADER_LABELS_SHARED,
  7:  'R1_FaultsPerInterval',
  8:  'R1_TimeAllowed',
  9:  'R1_TimeInterval',
  10: 'R2_FaultsPerInterval',
  11: 'R2_TimeAllowed',
  12: 'R2_TimeInterval',
  13: 'R3_FaultsPerInterval',
  14: 'R3_TimeAllowed',
  15: 'R3_TimeInterval',
  16: 'CaliforniaSplit',
  17: 'IsFEI',
  // H[18]: always False — suspected legacy trophy field (moved to @foot row)
  // WATCH: if this ever flips during a live class, note exactly what triggered it
  18: '?legacy_alwaysFalse',
  19: 'Sponsor',
  // H[20]: always empty — unknown, possibly old secondary sponsor field
  // WATCH: if this ever gets a value, note what triggered it
  20: '?alwaysEmpty',
  21: 'CaliSplitSections',
  22: 'PenaltySeconds',
  23: 'NoRank',
  // H[24]: always False — suspected legacy flag
  // WATCH: if this ever flips during a live class, note exactly what triggered it
  24: '?legacy_alwaysFalse',
  25: 'ShowStandingsTime',
  26: 'ShowFlags',
  // H[27]: always True — suspected legacy flag (possibly old ShowTimes)
  // WATCH: if this ever flips during a live class, note exactly what triggered it
  27: '?legacy_alwaysTrue',
  28: 'ShowFaultsAsDecimals',
  // H[04] in shared: always 1 for Farmtek, 2 for TIMY — correlates with H[00]
  // but may have additional meaning e.g. results finalized, hardware connected
  // WATCH: note if H[04] changes value during or after a live class run
};

// Hunter header cols 10+ — confirmed by live toggle testing
const HEADER_LABELS_HUNTER = {
  ...HEADER_LABELS_SHARED,
  8:  'Ribbons',
  10: 'IsEquitation',
  11: 'IsChampionship',
  12: 'IsJogged',
  13: 'OnCourseSB',
  14: 'IgnoreSireDam',
  15: 'PrintJudgeScores',
  16: 'ReverseRank',
  17: 'RunOff',
  22: 'PhaseWeight1',
  23: 'PhaseWeight2',
  24: 'PhaseWeight3',
  25: 'Phase1Label',
  26: 'Phase2Label',
  27: 'Phase3Label',
  28: 'Message',
  29: 'Sponsor',
};

const HUNTER_LABELS = {
  0:  'EntryNum',
  1:  'Horse',
  2:  'Rider',
  5:  'Owner',
  6:  'Sire',
  7:  'Dam',
  8:  'City',
  9:  'State',
  10: 'Notes',
  13: '?flag',
  14: '?goOrder',
  15: 'CurrentPlace',
  16: 'Score',
  40: 'HasGone',
};

const JUMPER_LABELS = {
  0:  'EntryNum',
  1:  'Horse',
  2:  'Rider',
  4:  'Country',
  5:  'Owner',
  6:  'Sire',
  7:  'Dam',
  8:  'City',
  9:  'State',
  10: 'Notes',
  11: 'FEI_USEF_num',
  13: 'RideOrder',
  14: 'R1Place',
  15: 'R1Time',              // confirmed — elapsed seconds e.g. 36.36
  16: 'R1JumpFaults',        // confirmed — fault points e.g. 6
  17: 'R1Total',             // confirmed — time + faults e.g. 42.36
  18: '?',
  19: '?rawFaults',          // seen 4, 8 — possibly raw rail count x 4
  20: '?rawFaultsMirror',    // mirrors col 19
  21: '?',
  22: 'R2Time',              // confirmed — JO elapsed seconds
  23: '?',
  24: 'R2Total',             // confirmed — JO total
  25: 'R2JumpFaults',
  26: '?totalFaults',
  27: '?runningTotal',
  28: '?',
  29: '?',
  30: '?',
  31: '?',
  32: '?',
  33: '?',
  34: '?',
  35: 'StatusCode',          // RF=RiderFall, EL=Eliminated, WD=Withdrawn etc
  // TIMY timestamp blocks — confirmed from live data 2026-03-20
  // Block structure per round: HasGone/CDStart flag, CDStart TOD, 6xCDPause/Resume, RideStart, 6xRidePause/Resume, RideEnd
  // Col 36 = HasGone flag (Farmtek=1 when competed) or CDStart (TIMY=TOD)
  // Pause/Resume cols only populated if clock actually paused — otherwise 00:00:00
  // Status codes (RF, EL etc) written into pause slot when applicable
  // Round 1 block (cols 36-51) — confirmed from live TIMY test
  36: 'R1_HasGone_or_CDStart',  // Farmtek: 1=competed | TIMY: CDStart TOD
  37: 'R1_CDStart',             // TIMY: CDStart TOD
  38: 'R1_CDPause1',
  39: 'R1_CDResume1',
  40: 'R1_CDPause2',
  41: 'R1_CDResume2',
  42: 'R1_CDPause3',
  43: 'R1_CDResume3',
  44: 'R1_RideStart',           // confirmed — ride start TOD
  45: 'R1_RidePause1',
  46: 'R1_RideResume1',
  47: 'R1_RidePause2',
  48: 'R1_RideResume2',
  49: 'R1_RidePause3',
  50: 'R1_RideResume3',
  51: 'R1_RideEnd',             // confirmed — ride end TOD
  // Round 2 / JO block (cols 52-66) — confirmed from live TIMY test
  52: 'R2_CDStart',             // confirmed
  53: 'R2_CDPause1',
  54: 'R2_CDResume1',
  55: 'R2_CDPause2',
  56: 'R2_CDResume2',
  57: 'R2_CDPause3',
  58: 'R2_CDResume3',
  59: 'R2_RideStart',           // confirmed
  60: 'R2_RidePause1',
  61: 'R2_RideResume1',
  62: 'R2_RidePause2',
  63: 'R2_RideResume2',
  64: 'R2_RidePause3',
  65: 'R2_RideResume3',
  66: 'R2_RideEnd',             // confirmed
  // Round 3 block (cols 67-81) — unused for standard 2-round classes
  67: 'R3_CDStart',
  68: 'R3_CDPause1',
  69: 'R3_CDResume1',
  70: 'R3_CDPause2',
  71: 'R3_CDResume2',
  72: 'R3_CDPause3',
  73: 'R3_CDResume3',
  74: 'R3_RideStart',
  75: 'R3_RidePause1',
  76: 'R3_RideResume1',
  77: 'R3_RidePause2',
  78: 'R3_RideResume2',
  79: 'R3_RidePause3',
  80: 'R3_RideResume3',
  81: 'R3_RideEnd',
};

// ── LOG PATH — TRY MULTIPLE LOCATIONS ────────────────────────────────────────

let LOG_PATH = null;

const LOG_CANDIDATES = [
  process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Desktop', 'west_log.txt')
    : null,
  process.env.HOMEDRIVE && process.env.HOMEPATH
    ? path.join(process.env.HOMEDRIVE + process.env.HOMEPATH, 'Desktop', 'west_log.txt')
    : null,
  'C:\\Users\\Public\\Desktop\\west_log.txt',
  'C:\\west_log.txt',
  path.join(__dirname, 'west_log.txt'),
].filter(Boolean);

for (const candidate of LOG_CANDIDATES) {
  try {
    fs.writeFileSync(candidate, 'WEST Watcher started: ' + new Date().toISOString() + '\r\n');
    LOG_PATH = candidate;
    console.log('✓ Log file: ' + LOG_PATH);
    break;
  } catch(e) {
    console.log('✗ Cannot write: ' + candidate + ' (' + e.message + ')');
  }
}

if (!LOG_PATH) {
  console.error('FATAL: Cannot write log anywhere. Exiting.');
  process.exit(1);
}

// ── ENSURE REQUIRED FOLDERS EXIST ────────────────────────────────────────────

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('✓ Created: ' + dir);
    }
  } catch(e) {
    console.error('✗ Could not create: ' + dir + ' (' + e.message + ')');
  }
}

ensureDir(SNAPSHOTS_DIR);

// ── LOGGING ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\r\n'); } catch(e) {}
}

function logSep() {
  const line = '─'.repeat(70);
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\r\n'); } catch(e) {}
}

// ── SNAPSHOT ──────────────────────────────────────────────────────────────────

function saveSnapshot(filename, content, label) {
  try {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${ts}_${filename}`;
    fs.writeFileSync(path.join(SNAPSHOTS_DIR, name), content);
    log(`SNAPSHOT: ${name} [${label}]`);
  } catch(e) {
    log(`SNAPSHOT ERROR: ${e.message}`);
  }
}

// ── SAFE READ ─────────────────────────────────────────────────────────────────

function safeRead(filePath) {
  try {
    const fd  = fs.openSync(filePath, 'r');
    const sz  = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(sz);
    fs.readSync(fd, buf, 0, sz, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch(e) {
    log(`READ ERROR ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

// ── CSV PARSE ─────────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      result.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

// ── CLS PARSE ─────────────────────────────────────────────────────────────────

function parseCls(content, filename) {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return null;

  const result = {
    filename,
    classType:      'U',
    className:      '',
    numRounds:      '',
    numJudges:      '',
    ribbons:        '',
    isEquitation:   false,
    isChampionship: false,
    isJogged:       false,
    onCourseSB:     false,
    isFEI:          false,
    scoringMethod:  '',
    sponsor:        '',
    message:        '',
    trophy:         '',
    prizes:         [],
    // Round config (FaultsPerInterval, TimeAllowed, TimeInterval per round)
    r1Fpi: '', r1Ta: '', r1Ti: '',
    r2Fpi: '', r2Ta: '', r2Ti: '',
    r3Fpi: '', r3Ta: '', r3Ti: '',
    entries:        [],
    rawHeader:      [],
  };

  for (let i = 0; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);

    if (i === 0) {
      result.classType      = cols[0]  || 'U';
      result.className      = cols[1]  || '';
      result.numRounds      = cols[4]  || '';
      result.ribbons        = cols[8]  || '';
      result.numJudges      = cols[9]  || '';

      const isJumperHdr = result.classType === 'J' || result.classType === 'T';

      if (isJumperHdr) {
        result.scoringMethod  = cols[2]  || '';
        result.r1Fpi          = cols[7]  || '';
        result.r1Ta           = cols[8]  || '';
        result.r1Ti           = cols[9]  || '';
        result.r2Fpi          = cols[10] || '';
        result.r2Ta           = cols[11] || '';
        result.r2Ti           = cols[12] || '';
        result.r3Fpi          = cols[13] || '';
        result.r3Ta           = cols[14] || '';
        result.r3Ti           = cols[15] || '';
        result.isFEI          = cols[17] === 'True';
        result.sponsor        = cols[19] || '';
        result.noRank         = cols[23] === 'True';
        result.showFlags      = cols[26] === 'True';
        result.californiaSplit = cols[16] === '1' || cols[16] === 'True';
        result.showFaultsAsDecimals = cols[28] === 'True';
      } else {
        // Hunter
        result.isEquitation   = cols[10] === 'True';
        result.isChampionship = cols[11] === 'True';
        result.isJogged       = cols[12] === 'True';
        result.onCourseSB     = cols[13] === 'True';
        result.message        = cols[28] || '';
        result.sponsor        = cols[29] || '';
        if (result.sponsor === 'True' || result.sponsor === 'False') result.sponsor = '';
      }
      result.rawHeader      = cols;
      continue;
    }

    if (lines[i].startsWith('@foot')) {
      result.trophy = cols[1] || '';
      continue;
    }

    if (lines[i].startsWith('@money')) {
      result.prizes = cols.slice(1).filter(v => v && v !== '0').map(Number);
      continue;
    }

    if (!cols[0] || !/^\d+$/.test(cols[0])) continue;

    const isJ = result.classType === 'J' || result.classType === 'T';

    const entry = {
      entryNum: cols[0],
      horse:    cols[1] || '',
      rider:    cols[2] || '',
      hasGone:  false,
      rawCols:  cols,
    };

    if (result.classType === 'H') {
      entry.place   = cols[15] && cols[15] !== '0' ? cols[15] : '';
      entry.score   = cols[16] && cols[16] !== '0' ? cols[16] : '';
      entry.hasGone = cols[40] === '1';
    }

    if (isJ) {
      entry.rideOrder    = cols[13] && cols[13] !== '0' ? cols[13] : '';
      entry.r1Place      = cols[14] && cols[14] !== '0' ? cols[14] : '';
      entry.r1Time       = cols[15] && cols[15] !== '0' ? cols[15] : '';  // confirmed col 15
      entry.r1JumpFaults = cols[16] || '0';                               // confirmed col 16
      entry.r1Total      = cols[17] && cols[17] !== '0' ? cols[17] : '';  // confirmed col 17
      entry.r2Time       = cols[22] && cols[22] !== '0' ? cols[22] : '';  // confirmed col 22
      entry.r2Total      = cols[24] && cols[24] !== '0' ? cols[24] : '';  // confirmed col 24
      entry.r2JumpFaults = cols[25] || '0';
      entry.statusCode   = cols[35] || '';  // RF=RiderFall, EL=Eliminated, WD=Withdrawn etc
      // TIMY timestamp blocks — confirmed from live test 2026-03-20
      // Block positions corrected: R1=36-51, R2=52-66, R3=67-81
      const tod = i => (cols[i] && cols[i] !== '00:00:00' && cols[i] !== '0') ? cols[i] : '';
      entry.r1HasGone   = tod(36);   // Farmtek: '1'=competed | TIMY: CDStart TOD
      entry.r1CdStart   = tod(37);   // TIMY CDStart TOD
      entry.r1RideStart = tod(44);   // confirmed
      entry.r1RideEnd   = tod(51);   // confirmed
      entry.r2CdStart   = tod(52);   // confirmed
      entry.r2RideStart = tod(59);   // confirmed
      entry.r2RideEnd   = tod(66);   // confirmed
      entry.r3CdStart   = tod(67);
      entry.r3RideStart = tod(74);
      entry.r3RideEnd   = tod(81);
      entry.hasGone     = !!(entry.r1Time || entry.r1Total || entry.r1Place);
    }

    result.entries.push(entry);
  }

  return result;
}

// ── RAW COLUMN DUMP ───────────────────────────────────────────────────────────
// Prints every non-empty column with known labels for Skippy to interpret

function logRawDump(parsed) {
  const isJ     = parsed.classType === 'J' || parsed.classType === 'T';
  const eLabels = isJ ? JUMPER_LABELS : HUNTER_LABELS;
  const hLabels = isJ ? HEADER_LABELS_JUMPER : HEADER_LABELS_HUNTER;

  log(`  [HEADER COLS]`);
  parsed.rawHeader.forEach((val, i) => {
    if (val === '' || val === undefined) return;
    const label = hLabels[i] || '?';
    log(`    H[${String(i).padStart(2,'0')}] ${label.padEnd(22)} = ${val}`);
  });

  log(`  [ENTRY COLS — all entries, non-empty only]`);
  parsed.entries.forEach(e => {
    log(`    #${e.entryNum} ${e.horse} / ${e.rider}`);
    e.rawCols.forEach((val, i) => {
      if (i < 3) return;                               // skip entryNum/horse/rider
      if (val === '' || val === '0' || val === '00:00:00') return;
      const label = eLabels[i] || '?';
      log(`      [${String(i).padStart(2,'0')}] ${label.padEnd(18)} = ${val}`);
    });
  });
}

// ── DIFF ──────────────────────────────────────────────────────────────────────
// Shows exactly which columns changed between two file states

function logDiff(oldContent, newContent, filename) {
  const oldLines = oldContent.split(/\r?\n/).filter(l => l.trim()).map(parseCSVLine);
  const newLines = newContent.split(/\r?\n/).filter(l => l.trim()).map(parseCSVLine);

  const classType = (newLines[0] && newLines[0][0]) || 'U';
  const isJ       = classType === 'J' || classType === 'T';
  const eLabels   = isJ ? JUMPER_LABELS : HUNTER_LABELS;
  const hLabels   = isJ ? HEADER_LABELS_JUMPER : HEADER_LABELS_HUNTER;

  log(`  [DIFF: ${filename}]`);

  // Header diff
  const oH = oldLines[0] || [], nH = newLines[0] || [];
  const hDiffs = [];
  for (let i = 0; i < Math.max(oH.length, nH.length); i++) {
    if ((oH[i]||'') !== (nH[i]||'')) {
      hDiffs.push(`H[${String(i).padStart(2,'0')}] ${(hLabels[i]||'?').padEnd(22)}: "${oH[i]||''}" → "${nH[i]||''}"`);
    }
  }
  if (hDiffs.length) {
    log(`    HEADER:`);
    hDiffs.forEach(d => log(`      ${d}`));
  }

  // Entry diff — map by entry number
  const oEntries = {}, nEntries = {};
  oldLines.forEach(c => { if (c[0] && /^\d+$/.test(c[0])) oEntries[c[0]] = c; });
  newLines.forEach(c => { if (c[0] && /^\d+$/.test(c[0])) nEntries[c[0]] = c; });

  const allNums = new Set([...Object.keys(oEntries), ...Object.keys(nEntries)]);
  let anyEntry  = false;

  allNums.forEach(num => {
    const oE = oEntries[num] || [], nE = nEntries[num] || [];
    const diffs = [];
    for (let i = 0; i < Math.max(oE.length, nE.length); i++) {
      if ((oE[i]||'') !== (nE[i]||'')) {
        diffs.push(`[${String(i).padStart(2,'0')}] ${(eLabels[i]||'?').padEnd(18)}: "${oE[i]||''}" → "${nE[i]||''}"`);
      }
    }
    if (diffs.length) {
      anyEntry = true;
      const horse = nE[1] || oE[1] || '?';
      const rider = nE[2] || oE[2] || '?';
      log(`    ENTRY #${num} ${horse} / ${rider}:`);
      diffs.forEach(d => log(`      ${d}`));
    }
  });

  if (!hDiffs.length && !anyEntry) {
    log(`    (no column changes — whitespace/line-ending only)`);
  }
}

// ── LOG CLASS SUMMARY ─────────────────────────────────────────────────────────

function logClass(parsed, changed) {
  const isJ   = parsed.classType === 'J' || parsed.classType === 'T';
  const isH   = parsed.classType === 'H';
  const gone  = parsed.entries.filter(e => e.hasGone);
  const pend  = parsed.entries.filter(e => !e.hasGone);

  logSep();
  log(`FILE: ${parsed.filename} [${changed ? 'CHANGED' : 'INITIAL'}]`);
  log(`CLASS: ${parsed.className}`);

  let typeStr = parsed.classType;
  if (isH) typeStr = 'Hunter' + (parsed.isEquitation ? ' Equitation' : '') + (parsed.isChampionship ? ' Championship' : '');
  if (isJ) typeStr = 'Jumper' + (parsed.classType === 'T' ? ' (TIMY)' : ' (Farmtek)');
  if (parsed.classType === 'U') typeStr = 'Unformatted';

  log(`TYPE: ${typeStr} | Rounds: ${parsed.numRounds||'?'} | Judges: ${parsed.numJudges||'?'} | Ribbons: ${parsed.ribbons||'?'}`);
  log(`FLAGS: Equitation=${parsed.isEquitation} | Championship=${parsed.isChampionship} | Jogged=${parsed.isJogged} | OnCourseSB=${parsed.onCourseSB}`);
  if (parsed.sponsor) log(`SPONSOR: ${parsed.sponsor}`);
  if (parsed.message) log(`MESSAGE: ${parsed.message}`);
  if (parsed.trophy)  log(`TROPHY:  ${parsed.trophy}`);
  if (parsed.prizes.length) log(`PRIZES:  $${parsed.prizes.slice(0,5).join(', $')}${parsed.prizes.length > 5 ? '...' : ''}`);
  log(`ENTRIES: ${parsed.entries.length} total | ${gone.length} competed | ${pend.length} pending`);

  if (gone.length) {
    log(`--- COMPETED ---`);
    [...gone].sort((a,b) => parseInt(a.place||a.r1Place||99) - parseInt(b.place||b.r1Place||99))
      .forEach(e => {
        if (isH) {
          log(`  Place:${(e.place||'--').padEnd(4)} #${e.entryNum.padEnd(6)} ${e.horse} / ${e.rider} | Score: ${e.score||'--'}`);
        } else if (isJ) {
          const f1 = parseInt(e.r1JumpFaults||0) + parseInt(e.r1TimeFaults||0);
          let s = `R1: ${e.r1Time ? e.r1Time+'s' : '--'} (${f1 ? f1+' faults' : 'clear'})`;
          if (e.r2Time) {
            const f2 = parseInt(e.r2JumpFaults||0) + parseInt(e.r2TimeFaults||0);
            s += ` | JO: ${e.r2Time}s (${f2 ? f2+' faults' : 'clear'})`;
          }
          if (e.rideStart) s += ` | RideStart:${e.rideStart}`;
          if (e.cdStart)   s += ` | CDStart:${e.cdStart}`;
          log(`  Place:${(e.r1Place||'--').padEnd(4)} #${e.entryNum.padEnd(6)} ${e.horse} / ${e.rider} | ${s}`);
        }
      });
  }

  if (pend.length) {
    log(`--- PENDING (${pend.length}) ---`);
    pend.forEach(e => log(`  #${e.entryNum.padEnd(6)} ${e.horse} / ${e.rider}`));
  }

  // Research mode: always dump full raw columns
  log(`--- RAW DUMP ---`);
  logRawDump(parsed);
}

// ── TSKED ─────────────────────────────────────────────────────────────────────

function readTsked() {
  const content = safeRead(TSKED_PATH);
  if (!content) { log('tsked.csv not found'); return; }
  saveSnapshot('tsked.csv', content, 'startup');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  log('');
  log('TSKED:');
  lines.forEach((line, i) => {
    const c = parseCSVLine(line);
    if (i === 0) log(`  Show: ${c[0]} | Dates: ${c[1]}`);
    else         log(`  Class ${c[0]}: ${c[1]} | Date: ${c[2]} | Flag: ${c[3]||'(none)'}`);
  });
}

// ── CONFIG ────────────────────────────────────────────────────────────────────

function readConfig() {
  const content = safeRead(CONFIG_PATH);
  if (!content) { log('config.dat not found'); return {}; }
  saveSnapshot('config.dat', content, 'startup');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  log('');
  log('CONFIG.DAT (raw):');
  lines.forEach((line, i) => log(`  [${i}] ${line}`));
  try {
    const c = parseCSVLine(lines[0]);
    const scoreboardPort = parseInt(c[1]) || 0;
    const liveDataPort   = scoreboardPort - 496;  // always 496 apart
    log('');
    log('CONFIG PARSED:');
    log('  Scoreboard Port: ' + scoreboardPort);
    log('  Live Data Port:  ' + liveDataPort + ' (derived: scoreboard - 496)');
    log('  Server IP: ' + (c[3]  || '?'));
    log('  FTP Path:  ' + (c[4]  || '?'));
    log('  FTP User:  ' + (c[5]  || '?'));
    log('  Show URL:  ' + (c[26] || '?'));
    if (lines[3]) log('  Show Name: ' + lines[3].trim());
    if (lines[4]) log('  Dates:     ' + lines[4].trim());
    if (lines[5]) log('  Location:  ' + lines[5].trim());
    const rm = (c[4]||'').match(/r(\d+)$/i);
    if (rm) log('  Ring #:    ' + rm[1]);
    return { scoreboardPort, liveDataPort };
  } catch(e) {
    log('  (parse error: ' + e.message + ')');
    return {};
  }
}

// ── DATA OUTPUT ───────────────────────────────────────────────────────────────
// Writes a clean JSON snapshot of the active class to west_data.json
// Overwrites on every .cls change — open in browser to see live state
// This is the payload shape that will eventually POST to the Worker

let DATA_PATH = null;

function initDataFile() {
  const candidates = LOG_CANDIDATES
    .map(p => p ? p.replace('west_log.txt', 'west_data.json') : null)
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.writeFileSync(candidate, JSON.stringify({ status: 'started', ts: new Date().toISOString() }, null, 2));
      DATA_PATH = candidate;
      console.log('✓ Data file: ' + DATA_PATH);
      break;
    } catch(e) {
      console.log('✗ Cannot write data file: ' + candidate);
    }
  }
}

function buildClassData(parsed) {
  const isJ = parsed.classType === 'J' || parsed.classType === 'T';
  const isH = parsed.classType === 'H';

  // Build rounds array from header (always 3, zeros if unused)
  const rounds = [
    { ta: parsed.r1Ta || '', faultsPerInterval: parsed.r1Fpi || '', timeInterval: parsed.r1Ti || '' },
    { ta: parsed.r2Ta || '', faultsPerInterval: parsed.r2Fpi || '', timeInterval: parsed.r2Ti || '' },
    { ta: parsed.r3Ta || '', faultsPerInterval: parsed.r3Fpi || '', timeInterval: parsed.r3Ti || '' },
  ];

  const entries = parsed.entries.map(e => {
    const base = {
      entryNum:   e.entryNum,
      horse:      e.horse,
      rider:      e.rider,
      owner:      e.owner || '',
      rideOrder:  e.rideOrder || e.place || '',
      hasGone:    e.hasGone,
      statusCode: e.statusCode || '',
    };
    if (isJ) {
      return {
        ...base,
        r1Place:      e.r1Place      || '',
        r1Time:       e.r1Time       || '',
        r1JumpFaults: e.r1JumpFaults || '',
        r1Total:      e.r1Total      || '',
        r2Place:      e.r2Place      || '',
        r2Time:       e.r2Time       || '',
        r2JumpFaults: e.r2JumpFaults || '',
        r2Total:      e.r2Total      || '',
      };
    }
    if (isH) {
      return {
        ...base,
        place: e.place || '',
        score: e.score || '',
      };
    }
    return base;
  });

  return {
    updatedAt:     new Date().toISOString(),
    filename:      parsed.filename,
    className:     parsed.className,
    classType:     parsed.classType,
    scoringMethod: parsed.scoringMethod || '',
    isFEI:         parsed.isFEI        || false,
    sponsor:       parsed.sponsor      || '',
    numEntries:    parsed.entries.length,
    competed:      parsed.entries.filter(e => e.hasGone).length,
    pending:       parsed.entries.filter(e => !e.hasGone).length,
    rounds,
    entries,
    liveState,   // current UDP state
  };
}

function writeDataFile(parsed) {
  if (!DATA_PATH) return;
  try {
    const data = buildClassData(parsed);
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    log(`DATA: west_data.json updated (${parsed.entries.filter(e=>e.hasGone).length}/${parsed.entries.length} competed)`);
  } catch(e) {
    log(`DATA ERROR: ${e.message}`);
  }
}

// ── SCAN + POLL ───────────────────────────────────────────────────────────────

const fileStates = {};

function scanAll() {
  let files;
  try { files = fs.readdirSync(CLASSES_DIR).filter(f => f.endsWith('.cls')); }
  catch(e) { log(`ERROR reading dir: ${e.message}`); return; }

  log(`Found ${files.length} .cls files`);
  files.forEach(f => {
    const content = safeRead(path.join(CLASSES_DIR, f));
    if (!content) return;
    fileStates[f] = content;
    const parsed = parseCls(content, f);
    if (parsed) {
      saveSnapshot(f, content, 'initial');
      logClass(parsed, false);
    }
  });
}

function startPoller() {
  log(`Polling every ${POLL_INTERVAL}ms...`);
  setInterval(() => {
    let files;
    try { files = fs.readdirSync(CLASSES_DIR).filter(f => f.endsWith('.cls')); }
    catch(e) { log(`POLL ERROR: ${e.message}`); return; }

    files.forEach(f => {
      const content = safeRead(path.join(CLASSES_DIR, f));
      if (!content || content === fileStates[f]) return;

      const old = fileStates[f];
      fileStates[f] = content;

      saveSnapshot(f, content, 'changed');
      logSep();
      log(`CHANGE DETECTED: ${f}`);

      if (old) logDiff(old, content, f);

      const parsed = parseCls(content, f);
      if (parsed) {
        logClass(parsed, true);
        writeDataFile(parsed);  // write clean JSON output
      }
    });
  }, POLL_INTERVAL);
}

// ── UDP LISTENER ──────────────────────────────────────────────────────────────
// Listens on scoreboard port only (live data port locked by Ryegate)
// Scoreboard port = config.dat col[1]
// Live data port  = scoreboard - 496 (locked, not used)
//
// PROTOCOL: {RYESCR}{tag}value{tag}value...
// Tags confirmed from live testing:
//   fr  = ring number
//   1   = entry number
//   2   = horse name
//   3   = rider name
//   4   = owner
//   5   = separator (empty)
//   8   = rank (finish signal — appears with final placing)
//   13  = time allowed (format: "TA: 78" — strip prefix)
//   14  = jump faults  (format: "JUMP 4" — strip prefix)
//   15  = time faults  (format: "TIME 2" — strip prefix)
//   17  = elapsed seconds (whole number while running, decimal at finish)
//   18  = target       (format: "TARGET 4" — strip prefix)
//   23  = countdown    (format: "-44" — negative = seconds remaining)
//
// PHASES detected from which tags are present:
//   INTRO    = entry/horse/rider present, no cd or elapsed
//   CD       = {23} countdown present
//   ONCOURSE = {17} elapsed present, no {8} rank
//   FINISH   = {8} rank present

let UDP_LOG_PATH = null;

// Clean value by stripping known label prefixes
function cleanUdpVal(tag, val) {
  if (!val) return val;
  const v = val.trim();
  switch(tag) {
    case '13': return v.replace(/^TA:\s*/i, '');
    case '14': return v.replace(/^JUMP\s*/i, '');
    case '15': return v.replace(/^TIME\s*/i, '');
    case '18': return v.replace(/^TARGET\s*/i, '');  // TTB = Time To Beat
    case '8':  return v.replace(/^RANK\s*/i, '');
    case '23': return v; // already clean e.g. "-44"
    default:   return v;
  }
}

// Known tags for unknown-tag filtering
const UDP_KNOWN_TAGS = new Set(['fr','1','2','3','4','5','8','13','14','15','17','18','23']);

// Current live state — will be used by poster later
// Updated on every meaningful UDP event
let liveState = {
  phase:    'IDLE',   // IDLE | INTRO | CD | ONCOURSE | FINISH
  entry:    '',
  horse:    '',
  rider:    '',
  owner:    '',
  ring:     '',
  ta:       '',
  elapsed:  '',
  countdown:'',
  jumpFaults:'',
  timeFaults:'',
  rank:     '',
  updatedAt: null,
};

// Track last logged state per entry to suppress duplicate packets
const udpLastLogged = {};

function initUdpLog() {
  const candidates = LOG_CANDIDATES
    .map(p => p ? p.replace('west_log.txt', 'west_udp_log.txt') : null)
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.writeFileSync(candidate, 'WEST UDP Log started: ' + new Date().toISOString() + '\r\n');
      UDP_LOG_PATH = candidate;
      console.log('✓ UDP log: ' + UDP_LOG_PATH);
      break;
    } catch(e) {
      console.log('✗ Cannot write UDP log: ' + candidate);
    }
  }
  if (!UDP_LOG_PATH) log('WARNING: Could not create UDP log file');
}

function udpLog(msg) {
  const ts   = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (UDP_LOG_PATH) {
    try { fs.appendFileSync(UDP_LOG_PATH, line + '\r\n'); } catch(e) {}
  }
}

// Parse {tag}value{tag}value... into clean object
function parseUdpPacket(msg) {
  const ascii = msg.toString('ascii').replace(/^\r|\r$/g, '');
  const body  = ascii.replace(/^\{RYESCR\}/, '');
  const tags  = {};
  const re    = /\{([^}]+)\}([^{]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    tags[m[1]] = cleanUdpVal(m[1], m[2]);
  }
  return tags;
}

// ── ROUND INFERENCE ───────────────────────────────────────────────────────────
// Determines which round is active for a given entry + TA from UDP
// Priority:
//   1. Match UDP TA to round config in header
//   2. If ambiguous (same TA multiple rounds), fall back to .cls entry state
//   3. ScoringMethodCode=9 (two-phase) overrides — uses R2/R3 blocks

function inferRound(entryNum, udpTa) {
  for (const filename of Object.keys(fileStates)) {
    const content = fileStates[filename];
    if (!content) continue;
    const parsed = parseCls(content, filename);
    if (!parsed) continue;
    const entry = parsed.entries.find(e => e.entryNum === entryNum);
    if (!entry) continue;

    // Two-phase override — Phase 1 writes to R2 block, Phase 2 to R3
    if (parsed.scoringMethod === '9') {
      if (!entry.r2Time && !entry.r2Total) return { round: 1, label: 'Phase 1' };
      return { round: 2, label: 'Phase 2' };
    }

    // Try to match TA to round config
    const taNum = parseFloat(udpTa) || 0;
    const r1Match = taNum === parseFloat(parsed.r1Ta);
    const r2Match = taNum === parseFloat(parsed.r2Ta);
    const r3Match = taNum === parseFloat(parsed.r3Ta);

    // Unambiguous TA match
    if (r1Match && !r2Match && !r3Match) return { round: 1, label: 'Round 1' };
    if (r2Match && !r1Match && !r3Match) return { round: 2, label: 'Jump Off' };
    if (r3Match && !r1Match && !r2Match) return { round: 3, label: 'Round 3' };

    // Ambiguous — fall back to .cls entry state
    if (!entry.r1Time && !entry.r1Total && !entry.r1Place) return { round: 1, label: 'Round 1' };
    if (!entry.r2Time && !entry.r2Total)                   return { round: 2, label: 'Jump Off' };
    return { round: 3, label: 'Round 3' };
  }
  return { round: 1, label: 'Round 1' };
}


// Fires clean events on meaningful state transitions rather than every packet
// Events are queued here — poster will drain and send them to Worker later

const udpEvents = [];  // queue of events ready to POST

function fireEvent(type, data) {
  const event = {
    event:     type,
    timestamp: new Date().toISOString(),
    ...data,
  };
  udpEvents.push(event);
  udpLog(`[EVENT:${type}] ${JSON.stringify(data)}`);

  // Write data file on every UDP event so local JSON stays live
  // Find the most recently changed cls file and write with updated liveState
  const files = Object.keys(fileStates);
  if (files.length) {
    // Use the file that matches the current entry if possible
    let targetFile = files[files.length - 1];
    for (const f of files) {
      const content = fileStates[f];
      if (!content) continue;
      const parsed = parseCls(content, f);
      if (parsed && parsed.entries.find(e => e.entryNum === data.entry)) {
        targetFile = f;
        break;
      }
    }
    const content = fileStates[targetFile];
    if (content) {
      const parsed = parseCls(content, targetFile);
      if (parsed) writeDataFile(parsed);
    }
  }
}

// Track last known phase and elapsed for transition detection
let lastPhase    = 'IDLE';
let lastEntry    = '';
let lastElapsed  = '';
let lastCd       = '';
let lastJump     = '';
let clockStopTimer = null;  // timeout handle for clock-stopped detection
let cdStopTimer    = null;  // timeout handle for cd-stopped detection

function detectEvents(phase, entry, horse, rider, ta, cd, elapsed, jump, time, rank) {

  // New horse — reset tracking
  if (entry !== lastEntry) {
    if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
    if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
    lastElapsed = '';
    lastJump    = '';
    lastCd      = '';
  }

  // Phase transitions
  if (phase !== lastPhase || entry !== lastEntry) {

    if (phase === 'INTRO' && lastPhase !== 'INTRO') {
      fireEvent('INTRO', { entry, horse, rider, ta });
    }

    if (phase === 'CD' && lastPhase !== 'CD') {
      const { round, label } = inferRound(entry, ta);
      fireEvent('CD_START', { entry, horse, rider, ta, countdown: cd, round, label });
    }

    if (phase === 'ONCOURSE' && lastPhase !== 'ONCOURSE') {
      if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
      if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
      const { round, label } = inferRound(entry, ta);
      fireEvent('RIDE_START', { entry, horse, rider, ta, jumpFaults: jump, timeFaults: time, round, label });
    }

    if (phase === 'FINISH') {
      if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
      if (cdStopTimer)    { clearTimeout(cdStopTimer);    cdStopTimer    = null; }
      const { round, label } = inferRound(entry, ta);
      fireEvent('FINISH', { entry, horse, rider, rank, jumpFaults: jump, timeFaults: time, round, label });
    }
  }

  // Fault change while on course
  if (phase === 'ONCOURSE' && jump !== lastJump && lastJump !== '') {
    fireEvent('FAULT', { entry, horse, rider, jumpFaults: jump, timeFaults: time, elapsed });
  }

  // CD stopped detection — countdown stops moving during CD phase
  if (phase === 'CD') {
    if (cd !== lastCd) {
      // Countdown is moving — cancel any pending cd-stop timer
      if (cdStopTimer) { clearTimeout(cdStopTimer); cdStopTimer = null; }
      // CD resumed after stop
      const lastEvent = udpEvents[udpEvents.length - 1];
      if (lastEvent && lastEvent.event === 'CD_STOPPED' && lastEvent.entry === entry) {
        fireEvent('CD_RESUMED', { entry, horse, rider, countdown: cd });
      }
      lastCd = cd;
    } else {
      // Countdown unchanged — start a stop timer if not already running
      if (!cdStopTimer) {
        cdStopTimer = setTimeout(() => {
          cdStopTimer = null;
          fireEvent('CD_STOPPED', { entry, horse, rider, countdown: cd });
        }, 2500);
      }
    }
  }

  // Clock stopped detection — if elapsed stops moving for 2.5s while ONCOURSE
  if (phase === 'ONCOURSE') {
    if (elapsed !== lastElapsed) {
      // Clock is moving — cancel any pending stop timer
      if (clockStopTimer) { clearTimeout(clockStopTimer); clockStopTimer = null; }
      lastElapsed = elapsed;
    } else {
      // Elapsed unchanged — start a stop timer if not already running
      if (!clockStopTimer) {
        clockStopTimer = setTimeout(() => {
          clockStopTimer = null;
          fireEvent('CLOCK_STOPPED', { entry, horse, rider, elapsed });
        }, 2500);
      }
    }
  }

  // Clock resumed — elapsed moved again after a stop
  if (phase === 'ONCOURSE' && elapsed !== lastElapsed && lastPhase === 'ONCOURSE') {
    // If we previously fired CLOCK_STOPPED, fire CLOCK_RESUMED
    const lastEvent = udpEvents[udpEvents.length - 1];
    if (lastEvent && lastEvent.event === 'CLOCK_STOPPED' && lastEvent.entry === entry) {
      fireEvent('CLOCK_RESUMED', { entry, horse, rider, elapsed });
    }
  }

  lastPhase   = phase;
  lastEntry   = entry;
  lastJump    = jump;
}



function startUdpListener(scoreboardPort) {
  const dgram  = require('dgram');
  const socket = dgram.createSocket('udp4');

  socket.on('error', (err) => {
    udpLog(`ERROR: ${err.message}`);
    socket.close();
  });

  socket.on('listening', () => {
    udpLog(`Listening on scoreboard port ${scoreboardPort}`);
  });

  socket.on('message', (msg) => {
    const tags     = parseUdpPacket(msg);
    const entry    = tags['1']  || '';
    const horse    = tags['2']  || '';
    const rider    = tags['3']  || '';
    const owner    = tags['4']  || '';
    const ring     = tags['fr'] || '';
    const ta       = tags['13'] || '';
    const jump     = tags['14'] || '';
    const time     = tags['15'] || '';
    const elapsed  = tags['17'] || '';
    const ttb      = tags['18'] || '';  // Time To Beat
    const cd       = tags['23'] || '';
    const rank     = tags['8']  || '';

    // Determine phase
    let phase = 'IDLE';
    if (entry && !cd && !elapsed && !rank) phase = 'INTRO';
    if (cd)                                phase = 'CD';
    if (elapsed && !rank)                  phase = 'ONCOURSE';
    if (rank)                              phase = 'FINISH';

    // Suppress duplicate log lines (not events — those are transition-based)
    const stateKey = entry || 'idle';
    const stateStr = JSON.stringify({ phase, entry, elapsed, cd, jump, time, rank });
    const prevStr  = udpLastLogged[stateKey];
    udpLastLogged[stateKey] = stateStr;

    // Detect and fire events on meaningful transitions
    detectEvents(phase, entry, horse, rider, ta, cd, elapsed, jump, time, rank);

    // Suppress identical log lines
    if (stateStr === prevStr) return;

    // Update live state object
    liveState = {
      phase,
      entry,
      horse,
      rider,
      owner,
      ring,
      ta,
      ttb,
      elapsed,
      countdown: cd,
      jumpFaults: jump,
      timeFaults: time,
      rank,
      updatedAt: new Date().toISOString(),
    };

    // Build clean log line
    let line = `[UDP:${phase}]`;
    if (entry)   line += ` #${entry}`;
    if (horse)   line += ` ${horse}`;
    if (rider)   line += ` / ${rider}`;
    if (ta)      line += ` | TA:${ta}`;
    if (ttb)     line += ` | TTB:${ttb}`;
    if (cd)      line += ` | CD:${cd}s`;
    if (elapsed) line += ` | ELAPSED:${elapsed}s`;
    if (jump)    line += ` | JUMP:${jump}`;
    if (time)    line += ` | TIME:${time}`;
    if (rank)    line += ` | RANK:${rank}`;

    // Log any unknown tags for future research
    const unknown = Object.entries(tags)
      .filter(([k]) => !UDP_KNOWN_TAGS.has(k))
      .map(([k,v]) => `{${k}}=${v}`)
      .join(' ');
    if (unknown) line += ` | ?UNKNOWN: ${unknown}`;

    udpLog(line);
  });

  try {
    socket.bind(scoreboardPort);
  } catch(e) {
    udpLog(`BIND ERROR on port ${scoreboardPort}: ${e.message}`);
  }
}


// ── KEYPRESS MARKER ───────────────────────────────────────────────────────────
// Press any key in the CMD window to drop a marker in the log
// Tell Skippy in chat what you just changed — he'll match it to the next diff

let markerCount = 0;

function startKeyListener() {
  try {
    const readline = require('readline');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    process.stdin.on('keypress', (str, key) => {
      // Ctrl+C to exit
      if (key && key.ctrl && key.name === 'c') {
        log('');
        log('Watcher stopped by user.');
        process.exit();
      }
      // Any other key = marker
      markerCount++;
      const keyName = (key && key.name) ? key.name : (str || '?');
      log('');
      log(`${'★'.repeat(60)}`);
      log(`★ MARKER #${markerCount} — key: [${keyName}] — tell Skippy what you changed`);
      log(`${'★'.repeat(60)}`);
      log('');
    });

    log('Keypress marker ready — press any key to mark a change');
  } catch(e) {
    log('Keypress listener not available: ' + e.message);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

log('');
log('════════════════════════════════════════════════════════════════════════');
log('WEST Scoring Live — Class File Watcher [RESEARCH MODE]');
log('Log:       ' + LOG_PATH);
log('Snapshots: ' + SNAPSHOTS_DIR);
log('════════════════════════════════════════════════════════════════════════');

const config = readConfig();
readTsked();

log('');
log('INITIAL SCAN:');
scanAll();

initDataFile();
log('');
startPoller();

// Start UDP listener on scoreboard port
initUdpLog();
if (config.scoreboardPort) {
  udpLog('');
  udpLog('════════════════════════════════════════════════════════════════════════');
  udpLog('WEST UDP Listener — scoreboard port only');
  udpLog(`Scoreboard: ${config.scoreboardPort} | Live data: ${config.liveDataPort} (locked by Ryegate)`);
  udpLog('════════════════════════════════════════════════════════════════════════');
  startUdpListener(config.scoreboardPort);
} else {
  log('WARNING: Could not determine scoreboard port — UDP listener not started');
}

startKeyListener();
log('Running — press any key to mark a change, Ctrl+C to stop');
