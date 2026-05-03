---
name: JS-MODULES-AND-PAGES.md — current-state quick reference
description: Living doc listing every shared module + every public page + the single-source-of-truth ledger ("when you want to change X, edit Y"). Bump its date when modules or pages change.
type: reference
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
`docs/v3-planning/JS-MODULES-AND-PAGES.md` is the current-state quick
reference for the v3 frontend.

Sections:
- Shared modules table — file → responsibility → key exports
- Public pages table — page → URL pattern → modules loaded → what it renders
- Single-source-of-truth ledger — `when you want to change X, edit Y`
- Data flow ASCII diagram — Ryegate → engine → worker → page
- "Adding a new page" cookbook

Companion to (not replacement for):
- `docs/v3-planning/CENTRALIZED-JS-ARCHITECTURE.txt` — 2026-04-17
  PLANNING doc (different audience: pre-build sketch).
- `docs/v3-planning/JUMPER-METHODS-REFERENCE.md` — domain spec the
  templates module codes against.

**When to use:**
- Starting work on a new public page → consult the cookbook section.
- Wondering "where does X live?" → check the ledger.
- Adding a new shared module or page → bump the "Last updated" date
  and add the new entry to the relevant table.

**When NOT to update:**
- Per-session work logs — those go in session-notes/SESSION-NOTES-N.txt.
- Architectural rationale / planning thoughts — those belong in
  CENTRALIZED-JS-ARCHITECTURE.txt or a dedicated planning doc.
