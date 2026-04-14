============================================================
  WEST Scoring Live — Scoring PC Watcher (PCAP EDITION)
  Version 2.0.0-draft1   **EXPERIMENTAL — NOT PRODUCTION**
============================================================

WHY THIS EXISTS
---------------
The v1 watcher binds a UDP socket on port 29696 to receive
Ryegate's scoreboard broadcasts. On a real scoring PC, Ryegate's
own RSServer.exe holds that port exclusively
(SO_EXCLUSIVEADDRUSE — Windows socket default) so v1 can't
coexist and falls back to degraded mode (no live on-course data).

v2.0 uses **npcap** to tap the packet stream at the driver layer
instead of binding a socket. RSServer keeps its exclusive bind;
we read the broadcasts without interfering.


REQUIREMENTS
------------
1. Node.js LTS  (same as v1)
2. npcap driver — https://npcap.com/
   - Single installer, free for non-commercial use
   - Install WinPcap API-compatible mode for best compatibility
   - Wireshark ships it, so it may already be present
3. Node native addon (installed via npm):
   - In this folder, run once:  npm install
   - Pulls the `cap` package with prebuilt Windows binaries
4. **Run the watcher as Administrator**
   - Raw packet capture requires elevated privileges on Windows


INSTALL STEPS (manual for now, bat pending)
-------------------------------------------
1. Install npcap from https://npcap.com (default options).
2. Copy this whole folder to C:\west\ on the scoring PC.
3. Open an Administrator command prompt in C:\west\.
4. Run: npm install
   (downloads the cap package, ~10MB, needs internet)
5. Edit config.json, set the show slug.
6. Start the watcher:  node west-watcher.js
   (or use start-watcher.bat if you've set one up)


WHAT'S DIFFERENT FROM v1
------------------------
- UDP receive paths replaced with pcap capture (BPF filter:
  "udp and dst port 29696" for scoreboard, and port 31000 for
  class-complete detection).
- Opens a capture on every non-loopback IPv4 NIC at startup.
- Mid-flight scoreboard-port changes are not hot-swapped — if
  Ryegate's UDP port changes, restart the watcher.
- File watching (.cls, tsked.csv, config.dat) is unchanged.
- Posts to the worker are unchanged.


KNOWN WORK LEFT
---------------
- Install script (install-watcher-v2.bat) — auto-check npcap,
  run `npm install`, drop files into C:\west\.
- NIC selection tuning — currently opens ALL non-loopback IPv4
  adapters. Could be pinned to the scoring LAN interface only.
- restartUdpListener no-op on port change — either tear down
  and reopen all captures, or force a process restart.
- Add admin elevation check at startup with a clear error.
- Validate under load — hundreds of UDP frames/sec during a
  busy class. Buffer sizes may need bumping.


VERSION HISTORY
---------------
v2.0.0-draft1  (2026-04-14)
  Initial pcap port of the v1.1.4 watcher. Swaps dgram for the
  `cap` native addon, adds startPcapListener() helper that opens
  captures on every IPv4 NIC with a BPF filter on the target
  port. Extracts the UDP packet handlers into named functions
  (handleScoreboardPacket, handlePort31000Packet) so the capture
  path and the legacy dgram path share the same parser logic.
  Experimental — needs on-scoring-PC validation.
