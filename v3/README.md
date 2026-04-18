# v3 — west-scoring-live rebuild

This subfolder is the v3 codebase developed alongside v2 (at repo root). v2 continues to serve live shows throughout the rebuild.

**Do not deploy anything from this folder to production until the cutover checklist in `docs/v3-planning/V3-BUILD-PLAN.txt` Phase 10 is complete.**

---

## Structure

```
v3/
├── js/              # Shared JS modules — 6 files, global WEST namespace
│   ├── west-format.js    # Pure formatters (time, rank, faults)
│   ├── west-rules.js     # Class kind + scoring method + ladder logic
│   ├── west-clock.js     # THE clock — sole DOM writer, heartbeat-authority
│   ├── west-display.js   # UI primitives (standings row, phase pill, etc.)
│   ├── west-stats.js     # Live (sync) + history (async) stats
│   └── west-data.js      # Transport — polling first, WebSocket later
│
├── pages/           # HTML pages using the shared modules
│                    # NOTE: layout + look-and-feel PRESERVED from v2,
│                    # modernized under the hood. See "Design continuity" below.
│
├── worker/          # Cloudflare Worker with Durable Objects
│
└── tests/
    ├── README.md
    └── fixtures/
        └── cls/
            ├── H/   # Hunter .cls fixtures
            ├── J/   # Farmtek jumper .cls fixtures
            ├── T/   # TOD jumper .cls fixtures
            └── U/   # Unformatted .cls fixtures (for parse-everything testing)
```

---

## Design continuity (Bill's directive, 2026-04-18)

**v3 preserves the existing visual language. It is a REBUILD under the hood, not a REDESIGN on the surface.**

Users should open the new site and feel at home — same standings layout, same phase pills, same clock placement, same color semantics (gold active, red fault, green clear). The differences they notice should be:
- Things load faster
- The clock doesn't flicker anymore
- Mobile layout works better
- Pages feel snappier (because they use WebSocket push, not polling)

Things they should NOT notice:
- Different grid layouts
- New column arrangements
- Renamed sections
- Different fonts / spacing / colors (unless they're genuine accessibility improvements)

**What "modernized" means:**
- CSS structured via shared stylesheets (not per-page `<style>` duplication)
- HTML using the shared `WEST.display.*` primitives (consistent markup across pages)
- Responsive improvements where v2 was desktop-only
- Accessibility improvements (ARIA labels, keyboard nav, contrast ratios) without changing visuals
- Performance: lazy-loaded heavy sections, smaller JS payload per page

**What "modernized" does NOT mean:**
- Tailwind / component framework rewrite (we stay vanilla JS + CSS to match project philosophy)
- New color scheme, typography, or spacing system
- Removing features operators or spectators rely on
- Any change that would confuse a returning spectator

**Reference for v2 look/feel:** the current root-level pages — `live.html`, `index.html`, `classes.html`, `display.html`, `stats.html`, `results.html`, `admin.html` — are the visual source of truth. v3 pages match them. When in doubt, open the v2 page in one tab and the v3 page in another; they should feel like the same product.

---

## Watcher — NOT in this folder

The watcher stays at repo root (`west-watcher.js`, v1.x line, field-deployed on scoring PCs). v3 doesn't rebuild the watcher. Watcher evolution is independent of v3.

---

## Planning docs

All v3 specs live at `docs/v3-planning/` (repo root, NOT in this folder). Read them before starting any v3 work:

- `WEBSOCKETS-OVERVIEW.txt` — push architecture primer
- `CENTRALIZED-JS-ARCHITECTURE.txt` — shared module design
- `STATS-MODULE-ADDENDUM.txt` — stats module (6th module) + the seven alleys
- `V3-BUILD-PLAN.txt` — 11-phase playbook
- `CLASS-RULES-CATALOG.txt` — behavioral rules (pre-Session 28 labels, needs reframe pass)
- `DATABASE-SCHEMA-EXPANSION.md` — 14 new D1 tables + R2 bucket
- `JUMPER-METHODS-REFERENCE.md` — canonical jumper method spec

**Read `project_v3_rebuild.md` in Claude memory first** for current state and settled decisions.

---

## Getting started (Phase 0 checklist — from V3-BUILD-PLAN)

1. [ ] Tag current production as `v2.x-pre-rebuild` baseline
2. [ ] Create long-lived `v3-rebuild` branch for risky work (main stays v2-only until cutover)
3. [x] `/v3/` folder + skeleton files created (this commit)
4. [ ] V3_ENABLED feature flag added to v2 worker for staged rollout
5. [ ] Test harness (Vitest) installed + sample test passing
6. [ ] Page contracts documented (one per v2 page)
7. [ ] UDP log replay harness built
