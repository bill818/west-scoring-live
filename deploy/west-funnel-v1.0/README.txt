============================================================
  WEST Scoring Live — UDP Funnel
  Version 1.4.0
============================================================

WHAT THIS IS
------------
A tiny pass-through UDP relay that runs alongside the watcher
on the scoring PC. Solves the single-PC case where Ryegate,
RSServer, and the watcher all live on the same Windows host
and RSServer's exclusive bind on the scoreboard port blocks
any other listener.

  Ryegate ──> funnel (29696) ──> 127.0.0.1:29697 → RSServer
                              └> 127.0.0.1:29698 → watcher

Funnel is dumb on purpose: receives UDP bytes, sends the same
bytes to each configured output port. No parsing, no logic,
no state. Tiny codebase = tiny bug surface.


NOT NEEDED AT BIG SHOWS
-----------------------
At shows like Devon where scoring and the production house's
video wall live on separate computers, the funnel is NOT needed:
Ryegate broadcasts to the LAN, RSServer and the watcher each
bind their own hosts independently, no port conflict exists.

The funnel only matters when one PC is doing both jobs.


CONFIG
------
config.json (next to west-funnel.js):

  {
    "outputPorts": [29697, 29698]
  }

  - Input port: auto-detected from C:\Ryegate\Jumper\config.dat
    col[1] (matches whatever Ryegate is sending to — single
    source of truth, follows automatically if you change
    Ryegate's scoreboard output port).
  - outputPorts: up to 2 loopback ports to copy each packet to.
    First entry typically RSServer's listen port, second entry
    the watcher's scoreboardListenPort.


SETUP
-----
1. Install Node.js LTS (same requirement as the watcher).
2. Copy this folder to C:\west-funnel\ on the scoring PC.
3. Reconfigure RSServer's listen port to one of the outputPorts
   in config.json (e.g. 29697).
4. Edit C:\west\config.json (the watcher's config) and add:
     "scoreboardListenPort": 29698
   (or whatever the second outputPort is set to).
5. Double-click start-funnel.bat to run the funnel. Auto-
   restarts on crash.
6. Start the watcher normally via start-watcher.bat.


LOG
---
west-funnel.log (next to this folder).
  - Startup banner + config values
  - Bind confirmation / errors
  - Heartbeat every 60 seconds with packet counters:
      [HB] seen=NN sent=NN errs=NN
  - Send errors (if any)

Packet-by-packet logging is intentionally OFF — during a busy
class Ryegate sends hundreds of packets per second.


HARDENING
---------
  - Process-level uncaughtException / unhandledRejection
    catchers — logged, process continues.
  - Per-packet try/catch on send — one bad send does not kill
    the process.
  - EADDRINUSE exit(1) → start-funnel.bat restart loop takes
    over after its 5-second wait.
  - Other socket errors → close + reopen after 2 seconds.
  - Clean SIGINT/SIGTERM shutdown (closes sockets before exit
    to avoid Windows TIME_WAIT).


FAILURE MODES (KNOW BEFORE A SHOW)
----------------------------------
  - Funnel crash → scoreboard blank for ~5 seconds while
    start-funnel.bat relaunches. Visible, tolerable.
  - Funnel hang without crash → scoreboard dead until operator
    manually restarts. Watch for the heartbeat lines stopping
    in the log.
  - 127.0.0.1 loopback not reaching RSServer → RSServer must
    listen on 0.0.0.0 or 127.0.0.1. Most network apps default
    to 0.0.0.0, so loopback is received. If RSServer binds a
    specific non-loopback IP, this will not work and we need to
    switch to broadcast (255.255.255.255 with setBroadcast).
  - Hardware scoreboard on the LAN → a physical board on a
    different machine that expects Ryegate's broadcast directly
    won't see our loopback-only forwards. Use that case as a
    signal that this setup isn't the right architecture for
    that show (run the watcher on a separate LAN PC instead).


VERSION HISTORY
---------------
v1.2.0  (2026-04-15)
  + All UDP ports are now AUTO-DERIVED from Ryegate's
    scoreboard port (config.dat col[1]):
      INPUT     = ryegate port
      RSServer  = ryegate port + 1            (Ryegate constraint)
      Watcher   = 28000 + (ryegate port - 29696)
    e.g. Ryegate 29696 → RSServer 29697, Watcher 28000.
  + config.json simplified — only "runningTenth" remains.
    "outputPorts" and "runningTenthPort" keys are gone.
  + Companion west-watcher (v1.4.0+) computes the same
    watcher port identically — no manual sync needed.
  + Running tenth always operates on the RSServer-facing
    output (the watcher output is always pure pass-through).

v1.1.0  (2026-04-15)
  + Optional running-tenth mode for the scoreboard-facing output
    port: the funnel rewrites the elapsed field {17} to a one-
    decimal value (e.g. 15.0 → 15.1 → 15.2) and synthesizes
    interpolated frames at 10 Hz between Ryegate's 1 Hz real
    frames. Other output port (watcher) stays byte-identical
    pass-through always.
  + Pause detection: if the next real frame repeats the previous
    elapsed, the ticker stops and the scoreboard holds at
    <elapsed>.0. Also stops on 1.5s silence.
  + FINISH non-numeric elapsed (EL/RT status) stops tenth mode
    and passes Ryegate's raw frame through.
  + Config keys:
      "runningTenth":     0/1   (default 0 = pure pass-through)
      "runningTenthPort": N     (defaults to outputPorts[0])

v1.0.0  (2026-04-15)
  Initial pass-through funnel. Pure observer-to-two-observers
  relay with crash hardening and 60s heartbeat logging.
