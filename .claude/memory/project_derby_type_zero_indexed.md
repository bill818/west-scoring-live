---
name: Derby type field is zero-indexed in Ryegate output
description: H[37] derby_type is 0-indexed in the .cls (0=International, 1=National, 2=National H&G, ...). The HUNTER-METHODS-REFERENCE.md table is 1-indexed and wrong; code is the source of truth.
type: project
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
Hunter header column **H[37]** (`derby_type`, applies when
`class_mode === 2`) is **zero-indexed**. Ryegate's dropdown writes 0
for the first option:

| `derby_type` | Variant |
|---|---|
| 0 | International Derby |
| 1 | National Derby |
| 2 | National H&G |
| 3 | International H&G |
| 4 | USHJA Pony |
| 5 | USHJA Pony H&G |
| 6 | USHJA 2'6" Junior |
| 7 | USHJA 2'6" Junior H&G |
| 8 | WCHR Spec |

**Why:** Verified empirically by Bill 2026-04-25 — set the Ryegate
dropdown to "National," opened the resulting .cls, header H[37] read
as `1`. Therefore International is `0`, and the index runs zero-based.

**How to apply:**
- `WEST.format.DERBY_TYPES` map in `v3/js/west-format.js` is the
  source of truth and is correctly zero-indexed as of session 35.
- `docs/v3-planning/HUNTER-METHODS-REFERENCE.md` (line 313+) shows the
  old 1-indexed table — it's WRONG and needs an update. Until that
  doc is fixed, prefer code over doc when the two disagree.
- `derby_type=0` on a class with `class_mode === 2` means
  "International Derby," not "Not a derby" (which is what the spec
  doc claims).
- Test class 1001 in WEST_DB_V3 has `class_mode=2, derby_type=0` —
  renders as "International Derby."
