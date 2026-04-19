// Standalone UDP blaster for the spike. No Electron, pure Node.
// Sends fake {RYESCR} frames to 127.0.0.1:INPUT_PORT at a steady rate.
//
//   node test-sender.js [port] [ratePerSec] [durationSec]
//     defaults: 29696, 20, 30

const dgram = require('dgram');

const PORT = parseInt(process.argv[2] || '29696', 10);
const RATE = parseInt(process.argv[3] || '20', 10);
const DURATION = parseInt(process.argv[4] || '30', 10);

const sock = dgram.createSocket('udp4');
const intervalMs = Math.max(1, Math.floor(1000 / RATE));
let n = 0;
const total = RATE * DURATION;

console.log(`Sending ${total} packets to 127.0.0.1:${PORT} at ${RATE}/s (${intervalMs}ms spacing) for ${DURATION}s`);

const timer = setInterval(() => {
  const frame = `{RYESCR}{fr}1{1}${n}{17}${(n * 0.1).toFixed(3)}`;
  const buf = Buffer.from(frame, 'ascii');
  sock.send(buf, PORT, '127.0.0.1', (err) => {
    if (err) console.error('send err', err.message);
  });
  n++;
  if (n >= total) {
    clearInterval(timer);
    setTimeout(() => {
      console.log(`Done. Sent ${n} packets.`);
      sock.close();
    }, 200);
  }
}, intervalMs);
