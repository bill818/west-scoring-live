---
name: Named gates for conditional rendering
description: Every "should I show X" decision lives in a named gate function in west-format.js, never inline conditional chains in templates. Bill's session-35 directive — applies to derby labels, judges grid, combined total, forced layouts, championship markers, etc.
type: feedback
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
Every conditional render decision gets a NAMED gate function that
bakes in EVERY relevant condition. Callers get a single yes/no.
Templates / pages NEVER reach into class fields directly to compose
a condition.

**Why:** Bill 2026-04-25 — "make sure that logic test is in there ...
lots this will be used for." Started with the derby-type override
needing `class_mode === 2` gate; expanded into general policy.
Future surfaces (judges grid, derby components, stats, live ticker)
all consult the same gate; the policy can never be skipped or
reimplemented inconsistently.

**How to apply:**
- New conditional render decisions → add a named gate to
  `v3/js/west-format.js` next to the existing cluster
  (`derbyTypeLabel`, `judgesGridApplies`, `combinedTotalApplies`,
  `derbyComponentsApply`, `forcedPlacings`, `riderPrimary`,
  `championshipMarker`).
- Templates call the gate. They don't repeat the conditions.
- Bad pattern (smell): `if (cls.class_mode === 2 && cls.derby_type !=
  null && DERBY_TYPES[cls.derby_type]) { ... }` inline in a template.
- Good pattern: `const derbyName = WEST.format.derbyTypeLabel(cls);
  if (derbyName) { ... }`
- Each gate's docstring lists every condition it bakes in, so the
  caller doesn't need to know the rules — just the result.
- Gates are small, focused functions. If a gate gets > ~10 lines,
  consider whether the rule itself is too tangled.
