# Cloudflare Resources for v3 — Setup Checklist

**Purpose:** list of every Cloudflare resource v3 needs, what already exists, what to create, when, and how. Use as a walkthrough when Cloudflare setup day arrives.

Paired with `V3-BUILD-PLAN.txt` (phases) and `DATABASE-SCHEMA-EXPANSION.md` (what the D1 tables look like).

---

## What exists today (v2, stays untouched)

| Resource | Identifier | Binding in worker | v3 role |
|---|---|---|---|
| **Worker** | `west-worker` (west-worker.bill-acb.workers.dev) | — | Upgraded with DO + R2 bindings, still one worker |
| **KV namespace** | `WEST_LIVE` (ID `838b38e150d24177be0bbdccf7a3e530`) | `WEST_LIVE` | Keeps role: live-cache + edge-fast reads |
| **D1 database** | `west-scoring` (ID `085ce299-f591-441b-8edf-b4327b924422`) | `WEST_DB` | Same DB, adds 14 new tables via migrations |
| **Pages project** | `westscoring` (westscoring.pages.dev + preview.westscoring.pages.dev) | — | Preview + prod flow unchanged, deploys v3 pages when ready |

No new accounts. No new workers. No new D1. No new KV. No new Pages project. Everything scales within the current setup.

---

## What to CREATE (new for v3)

### 1. Durable Object class — `RingRoom`

**What it is:** one persistent stateful instance per ring (identified by `slug:ring`). Holds WebSocket sessions, broadcasts updates, manages ring state in memory.

**Lives in:** `west-worker.js` as an exported class. Same worker, not a separate worker.

**wrangler.toml additions:**
```toml
[[durable_objects.bindings]]
name = "RING_ROOMS"
class_name = "RingRoom"

[[migrations]]
tag = "v1"
new_classes = ["RingRoom"]
```

**When:** Phase 7 of V3-BUILD-PLAN. Skeleton can land earlier (Phase 0) behind V3_ENABLED flag.

**Cost:** $0.15/million requests + $12.50/million GB-s duration. For 500 spectators × 1 update/sec × 8hr × 5 rings ≈ 14.4M requests/day during shows. ~$2-3/day during active show, ~$0 otherwise.

**First-time setup:** deploy worker with the binding; Cloudflare creates the DO namespace automatically. No dashboard action needed.

---

### 2. R2 bucket — for log + .cls archive

**What it is:** object storage for raw UDP logs (gzipped daily) + archived .cls files (keyed by hash).

**Proposed name:** `west-scoring-archive` (or whatever Bill prefers)

**wrangler.toml additions:**
```toml
[[r2_buckets]]
binding = "R2_ARCHIVE"
bucket_name = "west-scoring-archive"
```

**When:** Phase 7-9 of V3-BUILD-PLAN. Bucket can be created earlier (stub binding) — sits empty until archival code writes to it.

**Cost:** $0.015/GB/month storage + $4.50/million Class A (writes) + $0.36/million Class B (reads). UDP logs ~30MB/day gzipped across all rings. First year cost ~$5-10 total.

**Setup commands:**
```bash
npx wrangler r2 bucket create west-scoring-archive
# then add binding to wrangler.toml
# then npx wrangler deploy
```

**Bucket structure (per DATABASE-SCHEMA-EXPANSION.md):**
```
west-scoring-archive/
  udp-logs/
    {slug}/{ring}/{YYYY-MM-DD}.log.gz
  cls/
    {cls_source_hash}
```

Accompanied by D1 table `udp_log_shipments` (slug, ring, date, r2_key, line_count, uploaded_at) for indexing.

---

### 3. Cron Trigger — nightly stats rollup (2am ET)

**What it is:** scheduled invocation of the worker that rebuilds `rider_season_stats`, `horse_season_stats`, `show_summary_stats`, etc. from raw entries/results.

**wrangler.toml additions:**
```toml
[triggers]
crons = [
  "0 6 * * *",        # 2am ET = 6am UTC, runs nightly
  "*/15 13-23 * * *"  # every 15 min during US show hours (9am-7pm ET)
]
```

**Worker handler:** `scheduled(controller, env, ctx)` exported from west-worker.js. Dispatches to rollup function based on cron schedule.

**When:** Phase 9 of V3-BUILD-PLAN (after identity + rollup tables exist).

**Cost:** free (up to 5 cron triggers on free plan; we use 2).

---

### 4. Cron Trigger — 15-min incremental (active show hours)

Second cron trigger for per-active-competitor incremental rebuilds during show days (see above, combined with nightly in one `crons = [...]` array).

Only rebuilds rollups for riders/horses competing today — much faster than full nightly rebuild.

---

### 5. Environment variable — `V3_ENABLED`

**What it is:** feature flag gating v3 code paths in the worker during rollout. Existing v2 endpoints keep working; new v3 endpoints only respond when flag is true.

**wrangler.toml:**
```toml
[vars]
V3_ENABLED = "false"
```

**When:** Phase 0 of V3-BUILD-PLAN. Must exist before any v3 worker code ships.

**How to flip on preview vs prod:**
- Preview deploys: edit wrangler.toml var, deploy to preview
- Production: same, but only flip to true when cutover is ready

**Cost:** free.

---

## Total list (short form)

```
TO CREATE in v3:
  [ ] Durable Object class "RingRoom"          (Phase 7)
  [ ] R2 bucket "west-scoring-archive"         (Phase 7-9)
  [ ] Cron trigger: nightly stats rollup       (Phase 9)
  [ ] Cron trigger: 15-min incremental rollup  (Phase 9)
  [ ] Env var: V3_ENABLED = false              (Phase 0)

KEEP AS-IS (existing v2 resources):
  [x] Worker "west-worker"
  [x] KV "WEST_LIVE"
  [x] D1 "west-scoring" (new tables added via migrations array)
  [x] Pages "westscoring"
```

---

## What v3 does NOT need

Documented so no one gets fancy and adds unneeded complexity:

- ❌ **New Worker** — reuse west-worker
- ❌ **New D1 database** — same DB, new tables via `west-worker.js` migrations array
- ❌ **New KV namespace** — WEST_LIVE keeps its role
- ❌ **New Pages project** — preview + prod flow handles the v3 frontend cutover
- ❌ **Hyperdrive** — we're not proxying Postgres / MySQL
- ❌ **Queues** — stats rollup uses crons, not message queues
- ❌ **Workers for Platforms** — single-tenant, don't need it
- ❌ **Zero Trust / Access** — admin auth is app-level (OAuth/JWT in v3), not Cloudflare
- ❌ **Smart Placement** — not needed at our scale
- ❌ **Analytics Engine** — we roll our own stats into D1 tables
- ❌ **Email routing** — N/A
- ❌ **Workflow** — not using temporal-style orchestration

---

## Sequencing — Electron spike vs Cloudflare setup

**Recommendation:** Electron spike FIRST. Cloudflare setup can happen in parallel, but spike is the architectural gate.

**Why Electron first:**
- The spike validates that synchronous UDP fan-out inside Electron main works. If this fails, the engine architecture needs revisiting. HIGH-RISK assumption to de-risk early.
- Cost of "wrong assumption caught early" = zero. Caught late = weeks of rework.
- Cloudflare setup doesn't help until v3 code exists to use it.

**Why Cloudflare CAN happen in parallel (low-risk):**
- Creating a DO class declaration + R2 bucket costs basically nothing and breaks nothing
- No data in new resources until code writes to them
- Empty resources sitting ready doesn't hurt anything

**Recommended sequence:**

```
Step 1 — Electron spike (half day, CRITICAL GATE)
  50-line throwaway Electron app. UDP in + fan-out to RSServer.
  Validates the architecture. Throw away after.

Step 2 — Cloudflare Phase 0 prep (30 min, parallel-safe)
  - Add R2_ARCHIVE bucket binding to wrangler.toml (stub, not used)
  - Add V3_ENABLED=false env var
  - Create empty RingRoom class scaffold (behind V3_ENABLED check)
  - wrangler deploy → should be no-op behavior change

Step 3 — v2 baseline prep (30 min)
  - git tag v2.x-pre-rebuild
  - npm install vitest + sample test
  - Populate /v3/tests/fixtures/cls/{H,J,T,U}/

Step 4 — Parallel tracks begin
  Track A: Real Electron engine build
  Track B: Shared JS modules + worker DO code
```

Don't wait on Cloudflare setup to start coding — most of it can be declared in `wrangler.toml` and deployed incrementally as each phase needs it.

---

## Step-by-step for the Cloudflare Phase 0 prep (when ready)

1. **Update wrangler.toml:**
   ```toml
   # existing bindings stay
   [[kv_namespaces]]
   binding = "WEST_LIVE"
   id = "838b38e150d24177be0bbdccf7a3e530"

   [[d1_databases]]
   binding = "WEST_DB"
   database_name = "west-scoring"
   database_id = "085ce299-f591-441b-8edf-b4327b924422"

   # NEW bindings for v3:
   [vars]
   V3_ENABLED = "false"

   [[r2_buckets]]
   binding = "R2_ARCHIVE"
   bucket_name = "west-scoring-archive"

   [[durable_objects.bindings]]
   name = "RING_ROOMS"
   class_name = "RingRoom"

   [[migrations]]
   tag = "v1"
   new_classes = ["RingRoom"]
   ```

2. **Create R2 bucket:**
   ```bash
   npx wrangler r2 bucket create west-scoring-archive
   ```

3. **Add RingRoom stub to west-worker.js:**
   ```javascript
   export class RingRoom {
     constructor(state, env) { this.state = state; this.env = env; }
     async fetch(request) {
       return new Response('RingRoom stub (v3 not yet active)', { status: 200 });
     }
   }
   ```

4. **Deploy and verify:**
   ```bash
   npx wrangler deploy
   ```
   - Should succeed
   - Existing v2 endpoints keep working (V3_ENABLED is false)
   - DO namespace created automatically

5. **Later: crons** (Phase 9):
   ```toml
   [triggers]
   crons = ["0 6 * * *", "*/15 13-23 * * *"]
   ```
   Only add when `scheduled()` handler is implemented; otherwise worker logs errors hourly.

---

## Cost summary

**Today (v2):** ~free (under free-tier limits)

**v3 at typical show load (500 spectators, 5 rings, 8hr show):**
- DO requests: ~$2-3/day during shows, $0 otherwise
- R2 storage + operations: ~$1-2/month
- Cron triggers: free
- Env vars: free
- **Total new v3 Cloudflare cost: ~$60-100/month during active show season**

**v3 at scale (larger shows, more spectators):** costs scale linearly with spectator WebSocket messages. Even at 10× current load, under $1000/month is achievable. Cloudflare is cheap at this scale.

---

## When setup is done

Mark these complete in `UNCERTAIN-PROTOCOLS-CHECKLIST.txt`:
- Part 6: `[x] electron-updater from GitHub Releases` (once auto-update flow tested)
- Part 10: `[x] V3_ENABLED feature flag in v2 worker`

Update memory `project_v3_rebuild.md` with "Cloudflare Phase 0 complete — DO + R2 bindings declared, V3_ENABLED false in prod, ready for Phase 1."

---

## Quick reference

When someone asks "what do we need to create on Cloudflare for v3?":
- 1 Durable Object class (RingRoom)
- 1 R2 bucket (west-scoring-archive)
- 2 cron triggers (stats rollup nightly + 15-min incremental)
- 1 env var (V3_ENABLED flag)

That's it. Four things. Everything else reuses existing v2 resources.
