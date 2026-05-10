# Engine → vMix Local Integration Plan

**Status:** Planning. Not yet built.
**Bill 2026-05-10:** "have the engine drive this locally... can install
an engine right onto the vMix computer that drives the JSON files."

## Goal

Get live scoring data into vMix on the venue's broadcast computer with
sub-100ms latency, no internet round-trip, and a clean separation of
concerns between the public web app (Cloudflare-backed) and the
broadcast graphics path (local).

## Architecture (proposed)

```
Ryegate UDP broadcast (LAN)
  ├─→ Operator engine (.exe on operator PC)
  │     └─→ /v3/postCls + /v3/postUdpEvent → Worker → WS → live.html
  │         (existing — public spectator path)
  │
  └─→ Broadcast engine (.exe on vMix PC)              ← NEW
        ├─→ scoring.json (file, polled by vMix Titles)
        └─→ http://localhost:PORT/ (WS + REST)
              ↑
              vMix Web Browser Source loads overlay.html which
              subscribes to local WS for real-time clock + identity
```

Both engines listen to the same Ryegate UDP broadcast on the LAN.
Each does its own thing — operator engine handles the cloud / .cls
archival path, broadcast engine handles the local vMix output. They
don't talk to each other; Ryegate is the shared source of truth.

## What the broadcast engine outputs

### 1. `scoring.json` — for vMix Titles (XML/JSON Data Source)

Single file, rewritten atomically on every state change. Layout
mirrors the worker's snapshot but flattened for easy vMix Title
binding (no nested arrays where vMix can't reach):

```json
{
  "ring_num": 1,
  "class_id": "1161",
  "class_name": "The Little Big Man Challenge Trophy Class",
  "is_live": true,
  "is_final": false,
  "remaining": 13,
  "total": 40,
  "gone": 27,
  "on_course": {
    "entry_num": "53",
    "horse_name": "Ubiluc",
    "rider_name": "Mark Bluman",
    "owner_name": "...",
    "country_code": "COL",
    "ta": 90
  },
  "live": {
    "clock": "34.20",
    "jump_faults": 0,
    "time_faults": 0,
    "total_faults": 0,
    "rank": null,
    "status": null
  },
  "previous_entry": {
    "entry_num": "52",
    "horse_name": "...",
    "rider_name": "...",
    "rank": "5",
    "total_faults": 4,
    "clock": "33.45"
  }
}
```

vMix Titles bind text fields to dotted paths (`live.clock`,
`on_course.rider_name`, etc.). The broadcast team designs the look
in vMix's GT Designer using their own brand templates. We just
provide the data.

### 2. `http://localhost:8765/overlay.html` — HTML browser source

For the live broadcast graphics WE design (the Devon-style overlay
in `scoreboard-lab.html`). vMix Web Browser Source loads it; it
connects to `ws://localhost:8765/live` for real-time push updates.

Same overlay variants we want anyway:
- `/overlay/full` — the full Devon-style 3:1 layout
- `/overlay/lower-third` — just identity + clock + faults
- `/overlay/clock-only` — minimal clock card, e.g. for course-cam corner
- `/overlay/just-finished` — banner that pops up after each ride

Each is a separate URL the production team can switch between as
broadcast cuts demand.

## Engine code changes

The existing engine watches .cls files and posts to the worker.
For broadcast deployment we need three changes (toggleable):

1. **UDP listen mode**: instead of (or in addition to) reading .cls
   files, listen directly to Ryegate's UDP broadcast on the LAN.
   This is what gives us sub-100ms updates — .cls writes are slower.
2. **Local state model**: an in-memory snapshot built from UDP events
   alone (entry, identity, clock, faults). Mirrors a subset of the
   worker's `_buildSnapshot` logic.
3. **Local server**: tiny HTTP + WS server on a configurable port.
   Serves `scoring.json` (rebuilt on each event) + the overlay HTML
   bundle + a WS endpoint for push updates.

Configuration via a JSON config file (or CLI flags):

```json
{
  "ryegate_udp_host": "0.0.0.0",
  "ryegate_udp_port": 31000,
  "broadcast_mode": true,
  "local_server_port": 8765,
  "scoring_json_path": "C:\\vMix\\scoring.json",
  "overlay_dir": "C:\\WEST\\overlays",
  "post_to_cloud": false,
  "ring_num": 1
}
```

`post_to_cloud: false` on the vMix machine — it's a passive consumer,
not a source-of-truth. The operator's engine still posts to
Cloudflare for the public web. The vMix engine just watches the same
UDP and outputs locally.

## vMix setup (broadcast team docs)

1. Install the WEST engine on the vMix computer
2. Configure (config.json or installer wizard):
   - Ryegate UDP port (typically 31000 / 31001)
   - Output paths (where to write `scoring.json`, where the overlay
     HTML lives)
   - Ring number
3. In vMix:
   - **Add a Web Browser Input** pointing to
     `http://localhost:8765/overlay/full` (or whichever variant).
     Set Update Interval = "Continuous" (real-time).
     Use as a graphic overlay layer.
   - **Add a Title** using one of vMix's GT templates. Bind text
     fields to JSON paths on `scoring.json`. Set Data Source poll
     interval to 1 second (or whatever feels right — clock should
     stay in the HTML overlay because JSON polling is too slow for
     ticking digits).
4. Output the program feed to broadcast / streaming as usual.

## Latency budget

Operator presses Display Scores → Ryegate UDP broadcast → vMix engine
parses → writes JSON + WS push → vMix renders.

Target: under 100ms end to end. Realistic on a clean LAN: 30-60ms.

For comparison, the cloud path (operator engine → worker → WS →
spectator browser) is 300-800ms. Public spectators don't notice.
Broadcast over-the-air viewers comparing to the announcer's call
WOULD notice — hence the local path.

## What this DOESN'T cover

- Multi-ring vMix setups (one vMix machine driving overlays for
  ring 1 and ring 2 simultaneously). Easy extension: run two
  engine instances on different ports, vMix loads two browser
  sources. Or single engine with `?ring=N` query parameter on the
  overlay URLs. Decide later.
- Replays / instant replay graphics. Production team's own thing.
- Scoreboard hardware (LED walls). Different signal path entirely.
  The vMix output could be one source feeding both the broadcast
  stream AND a scoreboard if the LED controller takes a video feed,
  but that's a venue-by-venue setup.
- Disaster recovery if the local engine crashes mid-show. Should
  fail open — last known state stays on screen, no broadcast outage.
  vMix's browser source caches the last render; the JSON file stays
  on disk; new events queue when the engine comes back.

## Build order (when ready)

1. **UDP port manual override** (small, ship first). Add the four
   config fields + the Data Settings advanced section. Independent
   of the broadcast work; immediately useful for field troubleshooting.
2. Extract a "snapshot core" library from west-worker.js — the pure
   logic of "given UDP events, what's the current state." Make it
   runnable in Node (so the engine can use it) AND in a Worker (so
   the cloud path keeps using it). Single source of truth for
   scoring state.
3. Add the UDP listener to the engine in broadcast mode (Windows,
   Node + dgram). The existing engine already listens to UDP — this
   is reusing that infrastructure without the relay/post side
   effects.
4. Add local HTTP + WS server to the engine.
5. Build `overlay.html` page with the Devon-style layout, transparent
   background, WS subscription.
6. Wire `scoring.json` writer that runs on each snapshot rebuild.
7. Add BROADCAST as a 5th option to the Mode pill UI. Hides the
   show picker / makes it optional. Toggles `broadcastLocal`,
   `passthrough=false`, `liveScoringPaused=true` together.
8. Test on a single ring with a real Ryegate feed.
9. Document the vMix setup steps for the broadcast team.

Step 2 is the big one — extracting the snapshot core. That unblocks
everything else and also de-duplicates code with the worker. Worth
doing carefully so the cloud path doesn't drift from the local path.

Step 1 (port override) is independent — can ship to operators
ahead of the broadcast work as a standalone improvement.

## Existing engine modes (current build, found 2026-05-10)

The engine already has a **Mode pill** in the header that combines two
axes: `(show selected × pass-through enabled)` → 4 named modes. Found
in `v3/engine/renderer/index.html:43-70`.

| Mode                     | Show selected | UDP → RSServer relay | Worker writes |
|--------------------------|---------------|----------------------|---------------|
| WEBSITE + PASS-THROUGH   | ✅            | ✅                   | ✅            |
| WEBSITE ONLY             | ✅            | ❌                   | ✅            |
| PASS-THROUGH ONLY        | ❌            | ✅                   | ❌            |
| IDLE                     | ❌            | ❌                   | ❌            |

**Relevant flags / runtime state:**
- `config.passthrough` (bool, default true) — UDP → RSServer relay
- `liveScoringPaused` (runtime, top-bar pause) — pauses ALL worker writes
- `showLocked` (runtime, set on worker 423) — pauses writes
- `config.workerUrl` + `config.authKey` — required for any cloud post

## Add a 5th mode: BROADCAST (vMix-local)

| Mode                     | Show     | RSServer | Worker | Local JSON | Local HTTP/WS |
|--------------------------|----------|----------|--------|------------|----------------|
| **BROADCAST**            | optional | ❌       | ❌     | ✅         | ✅             |

- Show selection is optional. Ring number is what matters (so the
  engine knows which UDP frames belong to it).
- No cloud post — operator engine handles that.
- No RSServer relay — vMix is the consumer, not a downstream RS box.
- New: writes `scoring.json` on each event AND mounts a localhost
  HTTP+WS server with `overlay.html` for the vMix Web Browser Source.

Implementation:
- New config field: `broadcastLocal: true | false` (default false).
- New config field: `broadcastPort: 8765` (default).
- New config field: `scoringJsonPath: "C:\\vMix\\scoring.json"` (or
  similar venue-specific path).
- Mode pill UI gets a 5th item:
  ```
  BROADCAST
  ring locked · vMix overlay + scoring.json (no cloud)
  ```
- Picking it sets `passthrough=false`, `liveScoringPaused=true`,
  `broadcastLocal=true`. Hides the show picker (or makes it
  optional / readonly to "ring N").

## Unlock UDP port selection (also Bill 2026-05-10)

**Current:** UDP ports are auto-detected from Ryegate's `config.dat`,
no UI override. See `detectInputPort()` in `main.js:546`. Defaults:
- `inputPort` = `config.dat` row 0 col 1, fallback **29696** (channel A)
- `rsserverPort` = `inputPort + 1` (hardcoded in `main.js:1147`)
- `rsserverHost` = `127.0.0.1` (hardcoded in `main.js:1148`)

There's also a Channel B port (focus / CLASS_COMPLETE — typically
31000) that's currently auto-derived elsewhere.

**Wanted:** manual override in Data Settings so operators can:
- Force a specific input port (e.g. 31000) when Ryegate's config.dat
  isn't where the engine expects it
- Point the relay at a non-localhost host (multi-PC fan-out where
  RSServer runs on a different machine)
- Pick a non-default rsserverPort (not always inputPort+1 — some
  installs use different mapping)

Add config fields:
- `inputPortOverride: <int | null>` — explicit channel A listen port
- `inputPortBOverride: <int | null>` — explicit channel B listen port
- `rsserverHostOverride: <string | null>` — relay target host
- `rsserverPortOverride: <int | null>` — relay target port

When `null`, fall back to the existing auto-detection. When set,
honor the override and surface a small "manual" badge in the UI so
the operator knows they're not reading config.dat.

UI: Data Settings tab gets a new "UDP Ports (advanced)" collapsible
section with four numeric/string inputs. Locked by default behind a
"Show advanced" toggle so casual operators don't see it.

Rationale: troubleshooting in the field is currently impossible —
if config.dat is unreadable or the port mapping is non-standard, the
operator has to edit a Windows file by hand. Manual override unblocks
that without a Ryegate reinstall.

## Confirmed decisions (Bill 2026-05-10)

- **Devon production is on.** This isn't a hypothetical anymore — the
  broadcast engine ships for the Devon show.
- **Local-only broadcast engine.** Devon has OK internet but the
  local LAN path is more reliable. The broadcast engine writes
  ONLY to the local vMix consumers (scoring.json + localhost server).
  No cloud post.
- **Operator engine continues to write to Cloudflare** for the
  public spectator website. That's the score computer's existing
  job and it stays unchanged.
- **Possible existing local-only flag:** Bill recalls the engine
  may already have a "local broadcasting only" setting. Investigate
  before adding a new one — reuse if it exists.

## Open questions

- Who installs / configures the engine on the vMix machine — us, the
  broadcast team, or a one-click installer? Affects how much config
  UI we need to build.
