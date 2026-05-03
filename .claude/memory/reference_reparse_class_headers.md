---
name: /v3/reparseClassHeaders backfill endpoint
description: Worker endpoint that re-runs parseClsHeaderV3 against R2-archived .cls bytes for existing classes. The standard recipe for backfilling any classes-level migration without round-tripping through the engine.
type: reference
originSessionId: 9024d026-0951-451f-8a07-0033a87c38ac
---
`POST /v3/reparseClassHeaders` is the v3 backfill / replay tool for
class-header columns. Lives in west-worker.js next to
/v3/recomputeJudgeRanks.

**Body:** `{ slug?: 'show-slug' }` — omit slug to reparse every class.
**Auth:** `X-West-Key` (same as every v3 admin endpoint).
**Returns:** `{ ok, scanned, updated, skipped, errors }`.

It walks `classes` (optionally filtered by show), pulls each class's
archived `.cls` bytes from R2 at the stored `r2_key`, runs
`parseClsHeaderV3`, and UPDATEs the columns the endpoint is configured
to write. Idempotent.

**Recipe — "I added a column to `classes` that the parser should
populate":**
1. Migration adds the column(s).
2. Update `parseClsHeaderV3` to return the new field(s).
3. Update the `/v3/postCls` UPSERT (INSERT cols + VALUES placeholders +
   ON CONFLICT update list + bind params).
4. Update the UPDATE statement inside `/v3/reparseClassHeaders` to write
   the new field(s).
5. Apply migration → deploy worker → curl the endpoint once.

**Why this exists:** Migration 019 (jumper time_allowed) needed to
backfill 71 existing classes. Hand-rolled scripts would have been
fragile; reparseClassHeaders gave a one-curl idempotent path. Future
classes-level migrations follow the same recipe.

**Curl template:**
```
curl -X POST https://west-worker.bill-acb.workers.dev/v3/reparseClassHeaders \
  -H 'X-West-Key: <auth-key from west-api.js or env>' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

**Note:** the UPDATE inside the endpoint hard-codes the columns it
writes today (r1/r2/r3_time_allowed). When adding new column-on-classes
fields, EXTEND the UPDATE, don't replace it — older fields should keep
backfilling cleanly.
