// WEST Engine Spike — validates synchronous UDP fan-out inside Electron main.
// Listens on INPUT_PORT (from C:\Ryegate\Jumper\config.dat col[1], default 29696),
// forwards every packet to 127.0.0.1:INPUT_PORT+1 SYNCHRONOUSLY (before any
// logging or parsing), then records latency. Tray icon shows state.
//
// Throwaway. Not production. Deleted after Phase 0 gate passes.

const { app, Tray, Menu, nativeImage } = require('electron');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const RYEGATE_CONF = 'C:\\Ryegate\\Jumper\\config.dat';
const LOG_PATH = 'c:\\west-spike\\spike_log.txt';

function readInputPort() {
  try {
    const line = fs.readFileSync(RYEGATE_CONF, 'utf8').split(/\r?\n/)[0] || '';
    const cols = line.split(',');
    const p = parseInt(cols[1], 10);
    if (p > 0 && p < 65536) return p;
  } catch (e) {}
  return 29696;
}

const INPUT_PORT = readInputPort();
const RSSERVER_PORT = INPUT_PORT + 1;
const RSSERVER_HOST = '127.0.0.1';

let tray = null;
let rxCount = 0;
let txCount = 0;
let lastRxAt = 0;
const latencies = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch (e) {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
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

app.whenReady().then(() => {
  const inSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const outSocket = dgram.createSocket({ type: 'udp4' });

  inSocket.on('message', (packet) => {
    const t0 = process.hrtime.bigint();
    outSocket.send(packet, RSSERVER_PORT, RSSERVER_HOST);
    const t1 = process.hrtime.bigint();

    rxCount++;
    txCount++;
    lastRxAt = Date.now();
    const microsBetween = Number(t1 - t0) / 1000;
    latencies.push(microsBetween);
    if (latencies.length > 10000) latencies.shift();
  });

  inSocket.on('error', (err) => log(`[UDP IN ERROR] ${err.message}`));
  outSocket.on('error', (err) => log(`[UDP OUT ERROR] ${err.message}`));

  inSocket.bind(INPUT_PORT, () => {
    log(`UDP listening on ${INPUT_PORT}, forwarding to ${RSSERVER_HOST}:${RSSERVER_PORT}`);
  });

  const iconPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR42mNkYPhfz0AEYBxVSF6F4zWOKiSvQgBHcAIBpJuVOwAAAABJRU5ErkJggg==',
    'base64'
  );
  const trayIcon = nativeImage.createFromBuffer(iconPng);
  tray = new Tray(trayIcon);
  tray.setToolTip('WEST Engine Spike — starting');

  const menu = Menu.buildFromTemplate([
    { label: 'WEST Engine Spike v0.0.1', enabled: false },
    { type: 'separator' },
    { label: 'Open log folder', click: () => {
        require('electron').shell.openPath(path.dirname(LOG_PATH));
    }},
    { label: 'Force Crash (test)', click: () => {
        log('[CRASH] user-triggered via tray menu');
        setTimeout(() => { throw new Error('user-triggered crash for auto-restart test'); }, 10);
    }},
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);

  setInterval(() => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.50)] : 0;
    const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;
    const max = sorted.length ? sorted[sorted.length - 1] : 0;
    const age = lastRxAt ? Math.floor((Date.now() - lastRxAt) / 1000) + 's' : 'never';
    tray.setToolTip(
      `WEST Engine Spike\n` +
      `In: ${INPUT_PORT}  Out: ${RSSERVER_HOST}:${RSSERVER_PORT}\n` +
      `rx=${rxCount}  tx=${txCount}  lastRx=${age}\n` +
      `latency µs  p50=${p50.toFixed(1)}  p99=${p99.toFixed(1)}  max=${max.toFixed(1)}`
    );
  }, 2000);

  let lastLoggedRx = 0;
  setInterval(() => {
    if (rxCount === lastLoggedRx) return;
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.50)] : 0;
    const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;
    const max = sorted.length ? sorted[sorted.length - 1] : 0;
    log(`STATS rx=${rxCount} (+${rxCount - lastLoggedRx}) tx=${txCount} p50=${p50.toFixed(1)}µs p99=${p99.toFixed(1)}µs max=${max.toFixed(1)}µs`);
    lastLoggedRx = rxCount;
  }, 5000);

  log(`WEST Engine Spike ready. INPUT_PORT=${INPUT_PORT} from ${fs.existsSync(RYEGATE_CONF) ? RYEGATE_CONF : 'DEFAULT (no config.dat)'}`);
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
