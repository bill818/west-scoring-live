# WEST v3 Engine — Phase 1

Heartbeat-only build. Proves the engine ↔ worker pipe. No UDP, no .cls
watching, no parsing — just identity + "I'm alive" every 10 seconds.

## What it does

- Reads `C:\west\v3\config.json` at startup
- POSTs a heartbeat to `<workerUrl>/v3/engineHeartbeat` every 10 seconds
- Tray icon tooltip shows current status (config errors, heartbeat count, last success)
- Logs to `C:\west\v3\engine_log.txt`

## Setup

1. Copy `config.sample.json` to `C:\west\v3\config.json` and edit it:
   ```json
   {
     "workerUrl": "https://west-worker.bill-acb.workers.dev",
     "authKey":   "west-scoring-2026",
     "showSlug":  "v3-smoke-test-2026-04",
     "ringNum":   1
   }
   ```
2. The show + ring must already exist in the v3 database — create them via
   the v3 admin page if they don't.

## Run from source (dev)

```
cd v3/engine
npm install
npm start
```

## Build portable .exe

```
npm run build
```

Output lands in `dist/win-unpacked/WestEngine.exe`. Copy the whole
`win-unpacked` folder (it contains all the sibling DLLs the exe needs)
to wherever you want to run it from — e.g. `C:\west-engine\`.

## Verify it's working

- Tray icon appears in the Windows system tray
- Hover tooltip shows heartbeat count + "last OK: Xs ago"
- `C:\west\v3\engine_log.txt` has periodic `Heartbeat OK` lines
- Load the v3 admin page, select the show, ring row shows
  🟢 "Engine 3.0.0-dev — online, last seen Ns ago"

## Tray menu

- **Reload config** — re-reads `config.json` without restarting
- **Send heartbeat now** — force a heartbeat outside the normal cadence
- **Open log folder** — pops a file explorer to the log location
- **Quit** — clean shutdown
