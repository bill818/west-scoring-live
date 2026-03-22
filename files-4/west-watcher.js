/**
 * WEST Scoring Live — Class File Watcher
 * Watches C:\Ryegate\Jumper\Classes for .cls file changes
 * Logs parsed data to west_log.txt
 * 
 * Usage: node west-watcher.js
 * Requirements: Node.js installed on scoring computer
 */

const fs   = require('fs');
const path = require('path');

const CLASSES_DIR   = 'C:\\Ryegate\\Jumper\\Classes';
const TSKED_PATH    = 'C:\\Ryegate\\Jumper\\tsked.csv';
const CONFIG_PATH   = 'C:\\Ryegate\\Jumper\\config.dat';
let LOG_PATH        = (process.env.USERPROFILE || 'C:\\Users\\Public') + '\\Desktop\\west_log.txt';
const SNAPSHOTS_DIR = 'C:\\west_snapshots';

// Track previous file states to detect changes
const fileStates = {};

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

      const isJumperHeader = cols[0] === 'J' || cols[0] === 'T';
      const isHunterHeader = cols[0] === 'H';

      if (isJumperHeader) {
        // Jumper header — confirmed 2026-03-22 from class 221 live session
        result.scoringMethod    = cols[2] || '';   // H[02] ScoringMethodCode
        result.roundsCompleted  = cols[4] || '0';  // H[04] RoundsCompleted counter (0→1→2→3)
        result.clockPrecision   = cols[5] || '0';  // H[05] ClockPrecision
        result.immediateJO      = cols[6] === '1'; // H[06] ImmediateJumpoff
        result.r1FaultsPerInt   = cols[7] || '1';  // H[07] R1_FaultsPerInterval
        result.r1TimeAllowed    = cols[8] || '';    // H[08] R1_TimeAllowed (seconds)
        result.r1TimeInterval   = cols[9] || '1';  // H[09] R1_TimeInterval
        result.r2FaultsPerInt   = cols[10] || '1'; // H[10] R2_FaultsPerInterval
        result.r2TimeAllowed    = cols[11] || '';   // H[11] R2_TimeAllowed
        result.r2TimeInterval   = cols[12] || '1'; // H[12] R2_TimeInterval
        result.r3FaultsPerInt   = cols[13] || '1'; // H[13] R3_FaultsPerInterval (stale if <3 rounds)
        result.r3TimeAllowed    = cols[14] || '';   // H[14] R3_TimeAllowed
        result.r3TimeInterval   = cols[15] || '1'; // H[15] R3_TimeInterval
        result.californiaSplit  = cols[16] === '1' || cols[16] === 'True'; // H[16]
        result.isFEI            = cols[17] === '1' || cols[17] === 'True'; // H[17]
        result.caliSplitSecs    = cols[21] || '2'; // H[21] CaliSplitSections
        result.penaltySeconds   = cols[22] || '6'; // H[22] PenaltySeconds
        result.noRank           = cols[23] === 'True'; // H[23]
        result.showStandingsTime = cols[25] === 'True'; // H[25]
        result.showFlags        = cols[26] === 'True'; // H[26]
        result.showFaultsAsDecimals = cols[28] === 'True'; // H[28]
        const rawSponsor = cols[19] || '';
        result.sponsor = (rawSponsor === 'True' || rawSponsor === 'False' || !rawSponsor.trim()) ? '' : rawSponsor;
      }

      if (isHunterHeader) {
        // Hunter header — confirmed 2026-03-22 from toggle test
        result.scoringMethod    = cols[2] || '';   // H[02] ScoreType (0=standard, 2=Derby, 3=Special)
        result.numRounds        = cols[3] || '1';  // H[03] NumRounds
        result.isFlat           = cols[5] === '1'; // H[05] IsFlat
        result.numScores        = cols[7] || '1';  // H[07] NumScores
        result.ribbons          = cols[8] || '';   // H[08] Ribbons
        result.sbDelay          = cols[9] || '4';  // H[09] SBDelay
        result.isEquitation     = cols[10] === 'True'; // H[10]
        result.isChampionship   = cols[11] === 'True'; // H[11]
        result.isJogged         = cols[12] === 'True'; // H[12]
        result.onCourseSB       = cols[13] === 'True'; // H[13]
        result.ignoreSireDam    = cols[14] === 'True'; // H[14]
        result.printJudgeScores = cols[15] === 'True'; // H[15]
        result.reverseRank      = cols[16] === 'True'; // H[16]
        result.californiaSplit  = cols[17] === 'True'; // H[17]
        result.caliSplitSections = cols[33] || '2'; // H[33] CaliSplitSections
        result.showAllRounds    = cols[35] === 'True'; // H[35]
        result.derbyType        = parseInt(cols[37] || '0'); // H[37] 0=none,1-8=derby types
        result.ihsa             = cols[38] === 'True'; // H[38]
        result.ribbonsOnly      = cols[39] === 'True'; // H[39]
        result.phaseLabels      = [cols[25]||'', cols[26]||'', cols[27]||''].filter(Boolean);
        result.message          = cols[28] || '';
        const rawSponsor        = cols[29] || '';
        result.sponsor = (rawSponsor === 'True' || rawSponsor === 'False' || !rawSponsor.trim()) ? '' : rawSponsor;
        // numJudges for display
        result.numJudges        = cols[7] || '1';
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
      entryNum: cols[0],
      horse:    cols[1] || '',
      rider:    cols[2] || '',
      // cols[3,4] = empty
      owner:    cols[5] || '',
      sire:     cols[6] || '',
      dam:      cols[7] || '',
      city:     cols[8] || '',
      state:    cols[9] || '',
      notes:    cols[10] || '',
      usef:     cols[11] || '',
      // col[12] = rarely populated
      hasGone:  false,
      place:    '',
    };

    if (isHunter || result.classType === 'U') {
      // Hunter entry cols — confirmed 2026-03-20 (97-class analysis)
      // col[13]=GoOrder, col[14]=CurrentPlace, col[15]=R1Score
      // col[42]=R1Total, col[45]=CombinedTotal
      // col[49]=HasGone_R1, col[50]=HasGone_R2, col[52]=StatusCode_R1
      entry.place      = cols[14] && cols[14] !== '0' ? cols[14] : '';
      entry.score      = cols[15] && cols[15] !== '0' ? cols[15] : '';
      entry.r1Total    = cols[42] && cols[42] !== '0' ? cols[42] : '';
      entry.combined   = cols[45] && cols[45] !== '0' ? cols[45] : '';
      entry.hasGone    = cols[49] === '1' || cols[50] === '1';
      entry.hasGoneR1  = cols[49] === '1';
      entry.hasGoneR2  = cols[50] === '1';
      entry.statusCode = cols[52] || '';
      // Two-round classic: R2 score at col[24]
      entry.r2Score    = cols[24] && cols[24] !== '0' ? cols[24] : '';
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
      entry.statusCode    = isFarmtek ? (cols[39] || '') : (cols[35] || '');
    }

    result.entries.push(entry);
  }

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
    else if (parsed.isFlat) typeStr += ' Flat';
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

function readTsked() {
  const content = safeRead(TSKED_PATH);
  if (!content) return;
  saveSnapshot('tsked.csv', content, 'startup');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  log('');
  log('TSKED FILE:');
  lines.forEach((line, i) => {
    const cols = parseCSVLine(line);
    if (i === 0) {
      log(`  Show: ${cols[0]} | Dates: ${cols[1]}`);
    } else {
      log(`  Class ${cols[0]}: ${cols[1]} | Date: ${cols[2]} | Flag: ${cols[3]}`);
    }
  });
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
    log('  Show URL:     ' + (cols[24] || '?'));
    log('  Show Name:    ' + (lines[3] ? lines[3].trim() : '?'));
    log('  Show Dates:   ' + (lines[4] ? lines[4].trim() : '?'));
    log('  Location:     ' + (lines[5] ? lines[5].trim() : '?'));
    // Extract ring number from FTP path
    const pathMatch = (cols[4] || '').match(/r(\d+)$/);
    if (pathMatch) log('  Ring #:       ' + pathMatch[1]);
  } catch(e) {
    log('  (Could not parse config fields: ' + e.message + ')');
  }
}

// ── SCAN ALL CLS FILES ────────────────────────────────────────────────────────

function scanAll() {
  try {
    const files = fs.readdirSync(CLASSES_DIR).filter(f => f.endsWith('.cls'));
    log(`Found ${files.length} .cls files in ${CLASSES_DIR}`);
    files.forEach(f => {
      const fullPath = path.join(CLASSES_DIR, f);
      const content = safeRead(fullPath);
      if (!content) return;
      const parsed = parseCls(content, f);
      if (parsed) {
        fileStates[f] = content;
        saveSnapshot(f, content, 'initial scan');
        logClass(parsed, false);
      }
    });
  } catch(e) {
    log(`ERROR scanning directory: ${e.message}`);
  }
}

// ── WATCH FOR CHANGES ────────────────────────────────────────────────────────

function startWatcher() {
  try {
    fs.watch(CLASSES_DIR, { persistent: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.cls')) return;
      const fullPath = path.join(CLASSES_DIR, filename);

      // Small delay to let Ryegate finish writing
      setTimeout(() => {
        const content = safeRead(fullPath);
        if (!content) return;

        // Only log if content actually changed
        if (content === fileStates[filename]) return;
        fileStates[filename] = content;

        const parsed = parseCls(content, filename);
        if (parsed) {
          saveSnapshot(filename, content, 'changed');
          logClass(parsed, true);
        }
      }, 200);
    });
    log(`Watching ${CLASSES_DIR} for changes...`);
  } catch(e) {
    log(`ERROR starting watcher: ${e.message}`);
  }
}

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

// Read config and tsked first
readConfig();
readTsked();

// Initial scan of all existing cls files
log('');
log('INITIAL SCAN:');
scanAll();

// Start watching for changes
log('');
startWatcher();

log('Running — press Ctrl+C to stop');
log('');
