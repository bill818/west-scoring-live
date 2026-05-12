---
name: UDP port manual override — DONE 2026-05-11 (engine v3.1.9)
description: Shipped. Routing pane on Scoreboard tab has editable Listen / Forward host / Forward port inputs with a Lock checkbox. Blank = auto-detect.
type: project
originSessionId: 2c0d6cb2-afca-4968-8604-3704ce41ab60
---
**SHIPPED 2026-05-11 in engine v3.1.9.** Bill 2026-05-10.

**What ships:**
- Unlock UDP port selection in the engine UI.
- **Default behavior unchanged** — auto-detect from Ryegate's
  `config.dat` (current `detectInputPort()` in
  `v3/engine/main.js:546`). Operators with standard installs see no
  difference.
- **NEW:** four optional manual override fields. When set, the
  override wins; when null, fall back to auto-detect.

**Config fields to add** (`config.json`):
```
inputPortOverride:    null,   // channel A listen port
inputPortBOverride:   null,   // channel B listen port (focus / 31000)
rsserverHostOverride: null,   // relay target host (currently hardcoded 127.0.0.1)
rsserverPortOverride: null,   // relay target port (currently hardcoded inputPort+1)
```

**UI:** new collapsible **"UDP Ports (advanced)"** section in Data
Settings. Hidden behind a "Show advanced" toggle so casual operators
don't get confused. Each field shows the current resolved value
(auto-detect or override) with a small "manual" badge when an
override is in effect.

**Why now:** field troubleshooting is currently impossible if
config.dat is unreadable or the install uses a non-standard port
mapping — operators have to edit a Windows file by hand. Manual
override unblocks support without a Ryegate reinstall.

**Don't:**
- Don't remove the auto-detect path — it's the right default.
- Don't change `rsserverPort = inputPort + 1` math when both override
  fields are null — that's the existing convention.

**Reference:** full plan in
`docs/v3-planning/ENGINE-VMIX-INTEGRATION.md` (the "Unlock UDP port
selection" section). This is Step 1 of the broader vMix integration
rollout but is independent — can ship ahead.
