# JS Modules and Pages — Current State

> Quick reference for "where does X live?" and "who consumes Y?"
> Last updated: 2026-04-25 (Session 38, jumper time-allowed in hero).
> Companion to [CENTRALIZED-JS-ARCHITECTURE.txt](CENTRALIZED-JS-ARCHITECTURE.txt) (the planning doc).

---

## Shared modules — `v3/js/`

Every public page loads these via `<script>` tags. Worker and engine share them where applicable (CommonJS export).

| File | Responsibility | Key exports |
|---|---|---|
| [west-api.js](../../v3/js/west-api.js) | Worker URL + auth + fetch helper. Single place to change `BASE` or `AUTH`. | `WEST.api.BASE`, `WEST.api.AUTH`, `WEST.api.fetchJson(path)`, `WEST.api.queryParam(name)` |
| [west-format.js](../../v3/js/west-format.js) | Pure formatting primitives (no state, no DOM). | `escapeHtml`, `time(sec)`, `faults(n)`, `ordinal(n)`, `date(iso)`, `dayLabel(iso)`, `dayLabelLong(iso)`, `dateWithDay(iso)`, `methodLabel(...)`, `scheduleFlagLabel(flag)`, `flag(code)`, `flagFor(cls,entry)`, `roundLabel(method,modifier,n)`, `timeAllowedSummary(cls)`, `classDescription(cls)`, `derbyTypeLabel(cls)`, `judgesGridApplies(cls)`, `championshipMarker(place,isChamp)` |
| [west-status.js](../../v3/js/west-status.js) | Status code dictionary. ELIM/PARTIAL/HIDDEN categories. | `WEST.status.TEXT_CODES`, `categoryOf(code)`, `isKillingStatus(code)`, `publicLabel(code)` (collapses ELIM family → "EL") |
| [west-rules.js](../../v3/js/west-rules.js) | Method-aware placement rules ("ladder" model). | `WEST.rules.JUMPER_METHODS`, `jumperIsPlaced`, `jumperPlaceFor`, `hunterIsPlaced`, `hunterPlaceFor` |
| [west-jumper-templates.js](../../v3/js/west-jumper-templates.js) | Detection + per-template renderers for the jumper lens (1R/2R/3R/EQ/TEAM). | `WEST.jumperTemplates.detect(cls)`, `templates['1R']`, `templates['2R']`, `templates['3R']`, `templates['EQ']`, `templates['TEAM']`, `renderTable(cls, entries)` |
| [west-hunter-templates.js](../../v3/js/west-hunter-templates.js) | Hunter lens templates — EQ / OVER_FENCES / FLAT / DERBY / SPECIAL. Detection on `is_equitation` then `class_mode`. Inline judges-grid drop-down for multi-judge classes. | `WEST.hunterTemplates.detect(cls)`, `templates['EQ' / 'OVER_FENCES' / 'FLAT' / 'DERBY' / 'SPECIAL']`, `renderTable(cls, entries, { layout, judgeGrid })` (judgeGrid optional — when present and `judgesGridApplies` fires, each row gets a "▸ View judges" chip + hidden drop-down detail) |
| [west-cls-jumper.js](../../v3/js/west-cls-jumper.js) | Jumper lens .cls column-position spec. Read by parser. | layout descriptor object |
| [west-cls-hunter.js](../../v3/js/west-cls-hunter.js) | Hunter lens .cls column-position spec. Read by parser. | layout descriptor object |
| [west-data.js](../../v3/js/west-data.js) | Network/transport layer (planned future home for WebSocket subscription). | (currently minimal) |
| [west-display.js](../../v3/js/west-display.js) | Reusable UI building blocks — phase pills, badges, ribbons (planned). | (currently minimal) |
| [west-clock.js](../../v3/js/west-clock.js) | Live ticking clock (planned, for live + display pages). | (currently minimal) |
| [west-stats.js](../../v3/js/west-stats.js) | Live + history stats helpers (planned). | (currently minimal) |

Module load order in pages: `west-api` → `west-status` → `west-format` → `west-rules` → `west-jumper-templates` → page glue.

---

## Public pages — `v3/pages/`

| Page | URL pattern | Loads modules | Renders |
|---|---|---|---|
| [index.html](../../v3/pages/index.html) | `/index.html` | format, api | All-shows landing; status-aware groups (Active / Upcoming / Past) honoring show timezone |
| [show.html](../../v3/pages/show.html) | `/show.html?slug=X` | format, api | Per-show landing — hero (name, dates, venue, location, status badge), ring cards with class counts |
| [ring.html](../../v3/pages/ring.html) | `/ring.html?slug=X&ring=N` | format, api | Per-ring class list — 4-mode sort toggle (Scheduled / Class Name / Class Number / Unscheduled), day groupings, asc/desc on name + number |
| [class.html](../../v3/pages/class.html) | `/class.html?slug=X&ring=N&class=C` | api, status, format, rules, jumper-templates | Per-class results — hero with method label, results table via jumper-templates module |
| [admin.html](../../v3/pages/admin.html) | `/admin.html` | format, status, rules (inline) | Operator UI — show/ring/class CRUD, entry table with per-round scoring drill-down |

Future pages (planned, not built):
- `live.html` — live scoreboard for currently-running class. Will load west-clock.
- `display.html` — sponsor-wall display variant.
- `stats.html` — show + season aggregates. Will reuse jumper/hunter templates for standings rows.

---

## Single-source-of-truth ledger

When you want to change X, edit Y. Nowhere else.

| Concern | Edit here |
|---|---|
| Worker URL / auth header | [west-api.js](../../v3/js/west-api.js) — `BASE`, `AUTH` constants |
| HTML escape | [west-format.js](../../v3/js/west-format.js) — `escapeHtml` |
| Time / faults / score formatting | [west-format.js](../../v3/js/west-format.js) — `time`, `faults`, `ordinal` |
| Date display | [west-format.js](../../v3/js/west-format.js) — `date`, `dayLabel`, `dayLabelLong`, `dateWithDay` |
| Country flag emoji map / FEI codes | [west-format.js](../../v3/js/west-format.js) — `FLAGS` constant + `flag(code)` primitive |
| **Show flags policy** (operator's Ryegate ShowFlags toggle) | [west-format.js](../../v3/js/west-format.js) — `flagFor(cls, entry)`. **All public surfaces must route through this**, never `flag(code)` directly. |
| Method human-readable label | [west-format.js](../../v3/js/west-format.js) — `methodLabel`, `JUMPER_METHODS` map |
| Status code dictionary (EL, RT, WD, etc.) | [west-status.js](../../v3/js/west-status.js) — `TEXT_CODES` |
| ELIM family → "EL" public collapse | [west-status.js](../../v3/js/west-status.js) — `publicLabel(code)` |
| Killing-status definition | [west-status.js](../../v3/js/west-status.js) — `isKillingStatus(code)` |
| Jumper method placement rules (ladder, JO, scoreRounds) | [west-rules.js](../../v3/js/west-rules.js) — `JUMPER_METHODS` table |
| Hunter Forced vs Scored placement gate | [west-rules.js](../../v3/js/west-rules.js) — `hunterIsPlaced` |
| Jumper template detection (method → 1R/2R/3R/EQ/TEAM) | [west-jumper-templates.js](../../v3/js/west-jumper-templates.js) — `METHOD_TEMPLATE` map + `detect(cls)` |
| Per-template column layout / row HTML | [west-jumper-templates.js](../../v3/js/west-jumper-templates.js) — `templates[id]` |
| Round-cell rendering (faults / time / status code) | [west-jumper-templates.js](../../v3/js/west-jumper-templates.js) — `renderRoundCell` |

---

## Where data flows

```
Ryegate (.cls + .tsked + UDP)
     │
     ▼
Engine (west-watcher / electron) — Windows-side
     │  HTTP POST /v3/postCls
     ▼
Cloudflare Worker (west-worker.js)
     │  parses with west-cls-{jumper,hunter}.js layout
     │  writes RAW tables (entries, entry_*_summary,
     │                     entry_*_rounds, entry_hunter_judge_scores)
     │
     │  HUNTER STATS: SQL window-function compute pass writes
     │   DERIVED columns / tables (judge_round_rank,
     │   round_overall_rank, entry_hunter_judge_cards)
     │
     │  GET /v3/listEntries, /v3/listClasses, /v3/getShow,
     │     /v3/listJudgeGrid …
     ▼
Public page (show.html / ring.html / class.html)
     │  west-api.fetchJson()
     │  west-{jumper,hunter}-templates.renderTable() ← uses
     │    status/rules/format
     ▼
DOM
```

**Worker endpoints (the read API surface):**

| Endpoint | Returns |
|---|---|
| `GET /v3/listShows` | All shows (admin + public landing) |
| `GET /v3/getShow?slug=X` | One show with full metadata |
| `GET /v3/listRings?slug=X` | Rings for a show |
| `GET /v3/listClasses?slug=X[&ring=N]` | Classes (entry counts included) |
| `GET /v3/listEntries?class_id=N` | Wide-shape entries with both jumper + hunter round projections (single big JOIN) |
| `GET /v3/listJudgeGrid?class_id=N` | Hunter judges-grid response — per-entry → per-round → per-judge tree with pre-computed ranks |
| `POST /v3/postCls` | Engine .cls upload — parses + writes raw + runs compute pass |
| `POST /v3/recomputeJudgeRanks` | Manual safety valve to re-run hunter judges-grid compute pass for one class |

---

## Adding a new template page (cookbook)

E.g. wiring a new public stats page that needs to render a "rider standings row":

1. Create `v3/pages/stats.html` with the standard `<header>`, `<nav.breadcrumbs>`, and a `<div id="content">`.
2. Load shared modules in this order:
   ```
   <script src="../js/west-api.js"></script>
   <script src="../js/west-status.js"></script>
   <script src="../js/west-format.js"></script>
   <script src="../js/west-rules.js"></script>
   <script src="../js/west-jumper-templates.js"></script>
   ```
3. Use `WEST.api.fetchJson('/v3/...')` for any worker call. Don't hardcode the URL.
4. For rider rows that include a flag: `WEST.format.flagFor(cls, entry)` — never `flag(code)` directly. The class context carries the operator's ShowFlags toggle.
5. For status codes: render via `WEST.status.publicLabel(code)` so ELIM family collapses correctly.
6. For placement: gate via `WEST.rules.jumperPlaceFor(...)` so killing statuses suppress place.
7. Page-local code stays page-local: breadcrumb wiring, hero composition, fetch orchestration, error states.

If you find yourself copy-pasting a primitive from another page, it belongs in a shared module — add it to `west-format.js` (or the appropriate module) and use it from both.
