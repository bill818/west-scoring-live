# V2 Consolidation Audit — for v3 Module Design

**Purpose:** capture where v2 has duplication or structural repetition that v3's modular architecture should cleanly eliminate. **NOT a v2 optimization roadmap** — we're not refactoring v2. This is input for how v3's shared modules get structured.

Bill, Session 28: "we're not going to optimize v2 i just want all this documented of how we're going centralize."

Paired with: `CENTRALIZED-JS-ARCHITECTURE.txt` (how v3 modules split) and the `*-METHODS-REFERENCE.md` docs (the specs those modules implement).

---

## What v2 has today

`display-config.js` is 2,579 lines — a monolith that mixes:
- Pure formatters (time, rank, faults)
- Class kind detection (isJumper, isHunter, isDerby, isEquitation)
- Jumper-specific rules (~900 lines: method map, round logic, JO placement, ladder, status carry)
- Hunter-specific rules (~1000 lines: derby types, judge grid rendering, champion ribbons, flat/special layouts)
- Shared utilities (~250 lines)
- On-course clock logic (~150 lines — now partially in west-clock per v1.11)
- Ribbon SVG module
- Country flag lookup
- Status code display labels

Pages each have their own:
- URL parameter parsing (slug, ring, classNum, name) — duplicated 8×
- `WORKER = 'https://west-worker.bill-acb.workers.dev'` — hardcoded 8×
- Polling loops (try/fetch/json/catch → render → setTimeout) — 6 variants
- Header CSS (black sticky header + 3px red border + logo pattern) — 6×
- Responsive `@media` queries at 480px and 768px — 5×
- On-course card layout — 3× with variations

Worker (`west-worker.js`) has:
- `if (!isAuthed(request, env)) return err('Unauthorized', 401);` — 15+ times
- `const raw = await KV.get(key); const obj = raw ? JSON.parse(raw) : {};` — 20+ times
- SELECT shows/rings/classes with repeated JOIN patterns — multiple endpoints

---

## How v3 centralizes this (the plan)

Two orthogonal splits:

### Split 1: By CONCERN (already in V3-BUILD-PLAN)

- `west-format.js` — pure formatters (time, rank, faults, money, phase labels) — discipline-agnostic
- `west-clock.js` — THE clock (sole DOM writer for ticking) — discipline-agnostic
- `west-data.js` — transport layer (polling now, WebSocket later) — discipline-agnostic
- `west-rules.js` — interpretation: class_kind derivation, scoring rules, ladder logic
- `west-display.js` — UI primitives: standings row, phase pill, status badge, on-course card
- `west-stats.js` — aggregation: live (sync) + history (async)

### Split 2: By DISCIPLINE (Bill's Session 28 refinement)

For modules that contain discipline-specific behavior — rules, display, possibly stats — further split into:

- `*-core.js` — discipline-agnostic primitives (status badge, phase pill, format helpers, shared validators)
- `*-jumper.js` — jumper-specific (classType == J or T lens)
- `*-hunter.js` — hunter-specific (classType == H lens)

**Why the discipline split:** Article 1 (classType gatekeeper) becomes enforced at the MODULE LEVEL. The hunter module doesn't know jumper field names exist. The jumper module doesn't know hunter field names exist. Cross-lens bugs become physically impossible to write.

### Combined structure for v3 `/v3/js/`

```
/v3/js/
  ├── west-format.js              ← pure formatters (both disciplines use)
  ├── west-clock.js               ← sole clock (both disciplines use)
  ├── west-data.js                ← transport (both disciplines use)
  │
  ├── west-rules-core.js          ← classType gate, lens dispatch,
  │                                 shared validators (entry normalize,
  │                                 has-gone evidence logic)
  ├── west-rules-jumper.js        ← jumper methods 0-15, ladder model,
  │                                 JO placement, optimum math
  ├── west-rules-hunter.js        ← classMode + scoringType + 17 flags,
  │                                 derby types, tie-break logic
  │
  ├── west-display-core.js        ← status badge, phase pill, staleness
  │                                 indicator, breadcrumbs, cards,
  │                                 ribbons, country flags
  ├── west-display-jumper.js      ← jumper standings row, rounds block,
  │                                 JO tag, optimum-distance display
  ├── west-display-hunter.js      ← hunter standings row, judge grid,
  │                                 derby bonus rows, hunter score display
  │
  └── west-stats.js               ← live (sync) + history (async).
                                    Probably doesn't need discipline split
                                    since stats are mostly aggregate
                                    counts; discipline-specific bits
                                    delegate to rules-jumper/hunter.
```

That's 9 files instead of 6. More granular, but each is smaller, focused, and physically enforces Article 1.

---

## How the pieces fit together (Bill's question)

This was the clarifying question: **"how the display and the methods reference interact and fit together?"**

Three layers, each with its own role:

```
  ┌──────────────────────────────────────────────────────┐
  │  METHODS REFERENCE DOCS (spec)                        │
  │    JUMPER-METHODS-REFERENCE.md                         │
  │    HUNTER-METHODS-REFERENCE.md                         │
  │    CLS-FORMAT.md                                        │
  │                                                         │
  │  These are HUMAN-READABLE SPECS. They describe:         │
  │  - What each method MEANS                               │
  │  - What columns carry what data                         │
  │  - What the ladder/stack rules are                      │
  │  - What status codes exist and what they mean           │
  │                                                         │
  │  The spec is updated FIRST when a new quirk is found.   │
  │  Code implements the spec, not the other way around.    │
  └────────────────────────┬─────────────────────────────┘
                            │ implements
                            ▼
  ┌──────────────────────────────────────────────────────┐
  │  RULES MODULES (interpretation)                        │
  │    west-rules-core.js                                   │
  │    west-rules-jumper.js                                 │
  │    west-rules-hunter.js                                 │
  │                                                         │
  │  These READ the spec and IMPLEMENT it as code.          │
  │  Given raw .cls data, they produce a normalized         │
  │  CLASS DESCRIPTOR — a structured object that says:      │
  │    "this is a 2-round jumper with JO via method 3,      │
  │     ladder between R1 and R2, status-carry family       │
  │     CARRY-BACK, time allowed 90s, no FEI flag, ..."     │
  │                                                         │
  │  rules-jumper.js reads JUMPER-METHODS-REFERENCE.md      │
  │  rules-hunter.js reads HUNTER-METHODS-REFERENCE.md      │
  │  rules-core.js routes: classType → pick lens → delegate │
  └────────────────────────┬─────────────────────────────┘
                            │ produces descriptor
                            ▼
  ┌──────────────────────────────────────────────────────┐
  │  DISPLAY MODULES (rendering)                           │
  │    west-display-core.js                                 │
  │    west-display-jumper.js                               │
  │    west-display-hunter.js                               │
  │                                                         │
  │  These take the DESCRIPTOR + current state and produce  │
  │  HTML. They don't know scoring — they just render.      │
  │                                                         │
  │  display-jumper.js knows "render a jumper standings     │
  │  row with round blocks." It doesn't know what method 9  │
  │  IS; it just reads descriptor.methodLabel = 'II.2d'     │
  │  and renders accordingly.                                │
  │                                                         │
  │  display-core.js renders things that don't care about   │
  │  discipline: phase pill, status badge, ribbons, cards.  │
  └──────────────────────────────────────────────────────┘
                            │
                            ▼
                      HTML in the page
```

### Concrete example flow

A page renders a class:

1. `data` module fetches the raw class from worker → `/getLiveClass` response
2. Page calls `rules-core.normalize(classData)` — classType gate dispatches
3. `classType === 'J'` → `rules-jumper.buildDescriptor(classData)` returns:
   ```
   {
     class_kind: 'jumper',
     method: '13',
     method_label: 'II.2b Immediate JO',
     rounds: [{ idx: 1, has_jo: true }],
     ladder: [],   // method 13 has no cumulative ladder
     status_carry: 'R1-HOLDS',
     has_jo: true,
     ...
   }
   ```
4. Page calls `display-core.renderCard(entry, descriptor)` for generic bits, then `display-jumper.renderStandingsRow(entry, descriptor)` for the jumper-specific row
5. Page assembles HTML, inserts into DOM
6. `clock.tick()` writes the clock value separately (discipline-agnostic)

### Why this separation matters

- **Methods reference** = what's true about the world (the spec)
- **Rules module** = mechanical translation of spec into usable descriptor
- **Display module** = rendering, unaware of scoring

You can rewrite display without touching rules. You can add a new method by updating the reference doc + adding rules logic without touching display. **The spec drives; code follows.**

---

## What the v2 consolidation audit found (saved for reference)

### Top 5 consolidation wins (apply during v3 module build)

1. **Worker URL + config centralization** ⭐⭐⭐⭐⭐
   - v2: hardcoded 8×. v3: `WEST.CONFIG.WORKER` in a config module, imported once.

2. **URL parameter parsing helper** ⭐⭐⭐⭐⭐
   - v2: identical parsing in 6+ pages. v3: `WEST.getUrlParams()` in rules-core or format.

3. **Shared CSS (header, logo, responsive breakpoints)** ⭐⭐⭐⭐
   - v2: ~200 lines duplicated across 6 pages. v3: `shared-styles.css` loaded by all pages.

4. **Worker KV read+parse helper** ⭐⭐⭐⭐
   - v2: `const raw = await KV.get(key); const obj = raw ? JSON.parse(raw) : {};` 20+ times. v3 worker: `kvGetJson(key, default)` wrapper.

5. **Worker auth middleware** ⭐⭐⭐
   - v2: `if (!isAuthed(request, env)) return err('Unauthorized', 401);` in 15+ handlers. v3 worker: `withAuth(handler)` wrapper or route-level guard.

### Second tier (real but lower leverage)

- **Polling loop factory** — `WEST.createPollFactory(fetcher, renderer, opts)` replaces per-page poll boilerplate. Medium risk (timing-sensitive).
- **Data-shape normalizers** — `WEST.normalizeEntry(e)`, `WEST.normalizeClassData(cd)` protect against upstream shape changes. Pages assume fields today; validation would make v3 robust to schema drift.
- **Toast / notification helper** — currently only admin.html has it. Move to display-core for reuse.
- **display-config.js 2,579-line split** — happens naturally as we extract into the module structure above.

### Deliberately NOT consolidating

- **display.html vs live.html polling cadences** — both are 1s active / 10s idle but they render completely different things (stadium view vs spectator view). Polling patterns look similar; render costs are different. Keep intentional divergence.
- **Hunter vs jumper standings rendering branches** — consolidating into a mega-switch would be worse than splitting into dedicated modules. The discipline split (display-jumper vs display-hunter) IS the consolidation; it just doesn't collapse them into one function.
- **Results page vs admin page fetch patterns** — different security models (admin requires auth header, results doesn't). Don't merge fetch wrappers blindly.

---

## v3 module build order (when coding starts)

Aligns with V3-BUILD-PLAN.txt phases. Recommended extraction order:

1. **Phase 1** — `west-format.js` (easiest, pure, extracts from display-config cleanly)
2. **Phase 2a** — `west-rules-core.js` (classType gate + dispatch + shared validators)
3. **Phase 2b** — `west-rules-jumper.js` (extracts jumper-specific rules from display-config)
4. **Phase 2c** — `west-rules-hunter.js` (extracts hunter-specific rules from display-config)
5. **Phase 3** — `west-clock.js` (already partially v1.11-proven, consolidate across pages)
6. **Phase 4a** — `west-display-core.js` (shared primitives: badges, cards, ribbons)
7. **Phase 4b** — `west-display-jumper.js`
8. **Phase 4c** — `west-display-hunter.js`
9. **Phase 5** — `west-stats.js` (live half first, history half when D1 rollups exist)
10. **Phase 6** — `west-data.js` (polling first, WebSocket later)

At each step, existing v2 pages can be migrated one at a time to use the new shared module. Nothing breaks. Each migration is a separable commit with its own rollback.

---

## The v2 optimizations we're NOT doing

Per Bill's directive. Documented here for completeness:

- Not refactoring v2's display-config.js
- Not consolidating v2's duplicated page headers
- Not adding a config module to v2
- Not adding middleware to v2's worker
- Not touching v2 at all except for live-show patches

These consolidations happen NATURALLY as we build v3 modules. Each extraction becomes a v3 module. v2 keeps running unchanged until cutover.

---

## What to read next

If you're resuming v3 module work:
- `CENTRALIZED-JS-ARCHITECTURE.txt` — the original architecture doc (now cross-references this file)
- `JUMPER-METHODS-REFERENCE.md` — spec for rules-jumper.js
- `HUNTER-METHODS-REFERENCE.md` — spec for rules-hunter.js
- `CLS-FORMAT.md` — spec for the parser (worker side)
- `V3-BUILD-PLAN.txt` — phased extraction playbook
- `ENGINE-ELECTRON-DECISIONS.md` — engine architecture (where rules-core might be shared with engine)
- Memory: `feedback_class_type_commandment.md` — Article 1

If you're debating whether to do a v2 consolidation NOW vs waiting for v3:
- Don't. Bill's directive is clear: v2 stays as-is. Consolidation happens during v3 module extraction. Doing both creates migration risk.
