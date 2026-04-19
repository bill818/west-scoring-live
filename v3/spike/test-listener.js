// Standalone UDP receiver — simulates RSServer on port 29697.
//
//   node test-listener.js [port]
//     default: 29697

const dgram = require('dgram');

const PORT = parseInt(process.argv[2] || '29697', 10);
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

let count = 0;
let firstAt = 0;
let lastAt = 0;

sock.on('message', (msg) => {
  count++;
  lastAt = Date.now();
  if (!firstAt) firstAt = lastAt;
});

sock.on('error', (err) => console.error('listener err', err.message));

sock.bind(PORT, () => {
  console.log(`Listening on 127.0.0.1:${PORT}. Ctrl-C to stop.`);
});

setInterval(() => {
  const span = lastAt ? ((lastAt - firstAt) / 1000).toFixed(1) : '0.0';
  const rate = lastAt && firstAt !== lastAt ? (count / ((lastAt - firstAt) / 1000)).toFixed(1) : '0.0';
  console.log(`rx=${count}  span=${span}s  rate=${rate}/s`);
}, 2000);
