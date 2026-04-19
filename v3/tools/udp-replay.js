#!/usr/bin/env node
// v3 UDP log replay harness.
//
// Parses a v2 west_udp_log.txt and replays the [RAW] frames over UDP at
// original cadence (or a speed multiplier). Useful for testing the engine,
// parser, or downstream worker without needing a live Ryegate.
//
// Usage:
//   node udp-replay.js <logfile> [--host 127.0.0.1] [--port 29696]
//                                [--speed 1] [--loop] [--dry]
//
//   --speed N   Time multiplier. 1 = realtime, 10 = 10x faster, 0.5 = half.
//   --loop      Restart from the top when end of file reached.
//   --dry       Parse-only; don't open a socket or send anything.
//
// Log format reminder (from v2 west-watcher):
//   WEST UDP Log started: 2026-04-17T13:42:51.250Z
//   [HH:MM:SS] [RAW] {RYESCR}{fr}1{1}...     ← these are what we replay
//   [HH:MM:SS] [UDP] fr=1 {1}=... {fr}=1     ← parsed view; skip
//   [HH:MM:SS] [EVENT:INTRO] {...}           ← watcher-emitted; skip
//
// We only care about [RAW] lines. Timestamps are HH:MM:SS (no ms), so cadence
// resolution is 1 second. Good enough for logic testing; engine-level latency
// testing needs a different harness.

const fs = require('fs');
const dgram = require('dgram');
const path = require('path');

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 29696, speed: 1, loop: false, dry: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--speed') args.speed = parseFloat(argv[++i]);
    else if (a === '--loop') args.loop = true;
    else if (a === '--dry') args.dry = true;
    else if (a === '--help' || a === '-h') { args.help = true; }
    else positional.push(a);
  }
  args.logfile = positional[0];
  return args;
}

function parseLogToEvents(text) {
  // Returns array of { secondsFromStart, payload } for every [RAW] line.
  const events = [];
  let firstSecs = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\] \[RAW\] (.+)$/);
    if (!m) continue;
    const secs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    if (firstSecs === null) firstSecs = secs;
    let fromStart = secs - firstSecs;
    // Log may roll past midnight; treat negative deltas as +24h.
    if (fromStart < 0) fromStart += 86400;
    events.push({ secondsFromStart: fromStart, payload: m[4] });
  }
  return events;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.logfile) {
    console.log('Usage: node udp-replay.js <logfile> [--host H] [--port P] [--speed N] [--loop] [--dry]');
    process.exit(args.help ? 0 : 1);
  }

  const logPath = path.resolve(args.logfile);
  if (!fs.existsSync(logPath)) {
    console.error(`log file not found: ${logPath}`);
    process.exit(1);
  }

  const text = fs.readFileSync(logPath, 'utf8');
  const events = parseLogToEvents(text);
  if (events.length === 0) {
    console.error('no [RAW] lines found — is this a v2 west_udp_log.txt?');
    process.exit(1);
  }
  const spanSecs = events[events.length - 1].secondsFromStart;
  console.log(`Loaded ${events.length} frames spanning ${spanSecs}s of original time.`);
  console.log(`Replay speed: ${args.speed}x → expected duration ${(spanSecs / args.speed).toFixed(1)}s`);
  console.log(`Target: ${args.host}:${args.port}${args.dry ? ' (DRY RUN)' : ''}`);

  const sock = args.dry ? null : dgram.createSocket('udp4');

  const startWall = Date.now();

  do {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const wallTargetMs = (ev.secondsFromStart * 1000) / args.speed;
      const elapsedMs = Date.now() - startWall;
      await sleep(wallTargetMs - elapsedMs);

      if (!args.dry) {
        const buf = Buffer.from(ev.payload, 'ascii');
        sock.send(buf, args.port, args.host);
      }
      if (i % 50 === 0 || i === events.length - 1) {
        process.stdout.write(`\r  ${i + 1}/${events.length}  t=${(elapsedMs / 1000).toFixed(1)}s  last=${ev.payload.slice(0, 60)}${ev.payload.length > 60 ? '…' : ''}`.padEnd(120));
      }
    }
    process.stdout.write('\n');
  } while (args.loop);

  if (sock) sock.close();
  console.log('Replay complete.');
}

main().catch(err => { console.error(err); process.exit(1); });
