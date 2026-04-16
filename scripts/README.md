# scripts/

## lint-show.js

Post-show (or mid-show) linter. Crawls a show's worker API and flags
data-shape anomalies that tend to surface later as UI bugs, missing
entries, or "silent misses."

### Usage

```bash
# Lint every class in a show
node scripts/lint-show.js --slug=hits-culpeper-april

# Lint a single class
node scripts/lint-show.js --slug=hits-culpeper-april --class-num=291

# Point at a different worker (e.g. staging)
node scripts/lint-show.js --slug=X --worker=https://west-worker.bill-acb.workers.dev
```

### Exit codes

- `0` — no findings or WARN-only
- `1` — at least one FAIL
- `2` — linter crashed (bad args, worker unreachable, etc.)

### Current rules (expand as new bug patterns are spotted)

| Rule | Level | Catches |
|---|---|---|
| `partial-ingest` | FAIL | cls_raw has entries but D1 entry_count=0 (the Culpeper class 291 fingerprint) |
| `missing-class-type` | FAIL/WARN | class_type empty or outside J/H/T/E/U |
| `stale-active-class` | WARN | status=active but not updated in > 2 hours |
| `completed-but-no-entries` | WARN | status=complete with 0 entries and no cls_raw to explain |
| `missing-scoring-method` | FAIL | J/T class with null scoring_method |
| `future-dated-class` | WARN | scheduled_date > 2 years out (typo) |
| `entry-no-place-no-status` | WARN | entries with no place, status, or run time |
| `zero-scores-no-status` | WARN | entries with all-zero fields and no status code |

### Adding a new rule

Append an object to the `RULES` array in `lint-show.js`:

```js
{
  name: 'my-new-rule',
  desc: 'one-line description',
  requiresEntries: true, // set if the rule needs /getResults per class
  run(ctx) {
    for (const cls of ctx.classes) {
      if (/* bug condition */) {
        ctx.push('FAIL', this.name, cls, 'message explaining the problem and fix');
      }
    }
  },
},
```

Rule runner is inline for now. Split into `scripts/lint-rules/` if the
set grows past ~15.
