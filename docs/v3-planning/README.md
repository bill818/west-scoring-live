# v3 Planning — Start Here

The docs in this folder are the specification for the v3.0 rebuild of West Scoring Live. They represent 8+ months of earned knowledge (live shows, UDP log analysis, Ryegate toggle cycling) plus Session 28's architectural commitments.

**If you're a future Claude instance or human collaborator:** read this file first. The 17 docs are grouped below by reading order.

---

## ⚠️ ARTICLE 1 (non-negotiable)

Before reading any doc in this folder that mentions `.cls` columns: **classType at col[0] of row 0 is THE lens.** `H` = hunter lens. `J`/`T` = jumper lens. `U` = no lens yet.

A .cls is strictly typed. The same column number means different things under different lenses. Never translate field meanings across lenses.

See Claude memory `feedback_class_type_commandment.md` for the full rationale. The commandment is repeated at the top of every class-related doc in this folder.

---

## Reading order for a fresh session

### 1. Orient first (5 min)
- **This README** — you're reading it
- **Claude memory `project_v3_rebuild.md`** — master v3 state, pending work, what's live vs what's planned
- **Claude memory `project_stakes.md`** — "a lot is riding on this working" — the weight of every decision

### 2. Understand the architecture (20 min)
- **`V3-BUILD-PLAN.txt`** — 11-phase code playbook with acceptance criteria + rollbacks + session estimates. Addendum A (.cls as truth) + Addendum B (same D1, new tables).
- **`V3-ROLLOUT-SEQUENCE.md`** — 11-stage operator-facing rollout. Bill's brick-by-brick order. Locks watcher→engine rename + Electron packaging.
- **`WEBSOCKETS-OVERVIEW.txt`** — primer on push vs poll, Durable Objects.
- **`CENTRALIZED-JS-ARCHITECTURE.txt`** — 5 shared JS modules (format, rules, clock, display, data). Part 4 "alley" section is must-read.
- **`ENGINE-ELECTRON-DECISIONS.md`** — 14 locked Electron choices with rationale. Read BEFORE writing engine code.

### 3. Understand the data (30 min)
- **`CLS-FORMAT.md`** — column-level .cls + tsked.csv + UDP spec. 1,326 lines. Source of truth for field positions. Hunter and jumper sections are strictly separated by lens.
- **`UDP-PROTOCOL-REFERENCE.md`** — authoritative UDP reference. Frames 0-16, two-channel architecture (UDP in + port 31000 focus signal), hunter/jumper split.
- **`JUMPER-METHODS-REFERENCE.md`** — all jumper methods (0-15). Ladder model. Cross-refs to live classes.
- **`HUNTER-METHODS-REFERENCE.md`** — all hunter classModes (0-3) + 17 flags. Derby vs non-derby layouts. Judges grid design. Credits all v2 infrastructure already built.
- **`CLASS-DETECTION-SCHEMAS.md`** — lifecycle state machine, detection triggers, tsked/peek rules, FINISH_LOCK, Culpeper .cls-change fix (HIGH priority).
- **`CLASS-RULES-CATALOG.txt`** — behavioral rules by classType. **Note:** some pre-Session 28 entries may conflict with newer method references. Defer to method reference docs when in conflict.

### 4. Understand the UI (20 min)
- **`PAGE-INTENT.md`** — design philosophy for live/display/stats. Who each page serves, ≤3-second user questions, pitfalls.
- **`ADMIN-UI-SPEC.md`** — admin page: every button, 18 endpoints, 7 known v2 bugs for v3 fix.
- **`PUBLIC-PAGES-UI-SPEC.md`** — index/show/classes structural inventory.
- **`LIVE-PAGES-UI-SPEC.md`** — live/display/results/stats structural inventory + shared live-display vocabulary.

### 5. Understand the storage (15 min)
- **`DATABASE-SCHEMA-EXPANSION.md`** — 14 new D1 tables + R2 bucket. Identity, descriptor, rollups, observability.
- **`STATS-MODULE-ADDENDUM.txt`** — stats module (6th shared JS module). Live half (sync) vs history half (async, D1-backed). Seven alleys.

### 6. Before coding, check the testing punch list (5 min)
- **`UNCERTAIN-PROTOCOLS-CHECKLIST.txt`** — master checklist of ~73 unverified items grouped by area. Close items by evidence, not speculation.

---

## What each doc is FOR — one-line summary

| Doc | Purpose |
|---|---|
| `ADMIN-UI-SPEC.md` | Admin page spec: every control, endpoint, workflow, v2 bug |
| `CENTRALIZED-JS-ARCHITECTURE.txt` | 5 shared JS modules, migration path, alley warnings |
| `CLASS-DETECTION-SCHEMAS.md` | Class lifecycle state machine + detection triggers |
| `CLASS-RULES-CATALOG.txt` | Behavioral rules by classType (legacy — defer to method refs) |
| `CLS-FORMAT.md` | .cls + tsked.csv + UDP column-level spec (source of truth) |
| `DATABASE-SCHEMA-EXPANSION.md` | 14 new D1 tables + R2 bucket for v3 |
| `ENGINE-ELECTRON-DECISIONS.md` | 14 locked Electron architecture choices |
| `HUNTER-METHODS-REFERENCE.md` | All hunter classModes + flags + column maps (hunter lens) |
| `JUMPER-METHODS-REFERENCE.md` | All jumper methods 0-15 + ladder model (jumper lens) |
| `LIVE-PAGES-UI-SPEC.md` | live/display/results/stats structural inventory |
| `PAGE-INTENT.md` | Design philosophy for live/display/stats pages |
| `PUBLIC-PAGES-UI-SPEC.md` | index/show/classes structural inventory |
| `README.md` | This file — reading order and one-line summaries |
| `STATS-MODULE-ADDENDUM.txt` | Stats module design (live + history halves) |
| `UDP-PROTOCOL-REFERENCE.md` | UDP frames 0-16 + port 31000 two-channel architecture |
| `UNCERTAIN-PROTOCOLS-CHECKLIST.txt` | Master punch list of ~73 unverified items for testing |
| `V3-BUILD-PLAN.txt` | 11-phase code playbook with acceptance criteria |
| `V3-ROLLOUT-SEQUENCE.md` | 11-stage operator-facing rollout (brick by brick) |
| `WEBSOCKETS-OVERVIEW.txt` | Push vs poll primer + Durable Objects intro |

---

## When in doubt — the priority order

1. **Read Article 1** (in this doc, above). classType lens. Non-negotiable.
2. **Understand what's LIVE vs what's PLANNED.** v2 is still in production. v3 is rebuild. `project_v3_rebuild.md` memory makes this explicit.
3. **Check `UNCERTAIN-PROTOCOLS-CHECKLIST.txt`** before claiming something is true.
4. **Before writing any parser code** — JUMPER-METHODS-REFERENCE + HUNTER-METHODS-REFERENCE + CLS-FORMAT.
5. **Before writing any UI code** — PAGE-INTENT (philosophy) + ADMIN/PUBLIC/LIVE-UI-SPEC (structure).
6. **Before writing any engine code** — ENGINE-ELECTRON-DECISIONS + V3-ROLLOUT-SEQUENCE.
7. **Before writing any D1 code** — DATABASE-SCHEMA-EXPANSION + V3-BUILD-PLAN Addendum B.

---

## What's NOT in this folder

- **v2 live production code** — repo root, untouched during v3 development
- **Session handoff notes** — `/session-notes/` folder (SESSION-NOTES-NN.txt pattern)
- **Watcher deploy artifacts** — `/deploy/west-watcher-v1.0/` (v2 watcher, field-deployed)
- **v3 code skeleton** — `/v3/` folder (module stubs, populated during build)
- **Older archived docs** — `/files old/` folder

---

## When to update this README

- When a new doc is added to `docs/v3-planning/` — add to the one-line summary table + reading order
- When a doc's purpose changes substantially — update the entry
- When session-count milestones happen — noted inline if structural
- When the reading order should change (e.g. a new "orient first" doc added) — update Section "Reading order"

Keep this doc short. It's a map, not a manual.
