# WEST Engine Spike

Throwaway Electron app proving the v3 engine's synchronous UDP fan-out pattern.
Delete after Phase 0 gate passes.

## What it does

- Reads `C:\Ryegate\Jumper\config.dat` col[1] for INPUT_PORT (default 29696)
- Listens on INPUT_PORT
- Forwards every packet to `127.0.0.1:INPUT_PORT+1` SYNCHRONOUSLY (before any logging or parsing)
- Tray icon with live tooltip (rx/tx counts, p50/p99/max latency in microseconds)
- Log file at `c:\west-spike\spike_log.txt`

## Build

```
cd v3/spike
npm install
npm run build
```

Output: `v3/spike/dist/WestEngineSpike.exe`. Copy to `C:\west-spike\` to run.

## Smoke test on this machine (no Ryegate needed)

Three terminals:

```
# Terminal 1 — fake RSServer, counts forwarded packets
node test-listener.js

# Terminal 2 — run the spike (or double-click the packaged .exe)
npm start

# Terminal 3 — blast 20 packets/sec for 30s at the spike's input
node test-sender.js
```

Watch:
- Listener count rises in step with sender count
- Tray tooltip shows rx/tx counts and p99 latency
- `spike_log.txt` grows with periodic stats

## Acceptance criteria (from START-HERE)

- Runs on a Windows scoring PC
- Packet-to-forward latency < 1ms (1000µs) 99%+ of the time
- No packet loss over ~1 hour of real show traffic
- RSServer receives every packet as if the engine weren't there
- Tray icon appears, hover tooltip works
- Engine crash/restart does not affect RSServer
