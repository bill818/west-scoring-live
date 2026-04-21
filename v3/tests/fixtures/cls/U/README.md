# True-U .cls fixtures

These are fixtures for classes Ryegate has created but not yet configured —
the "U" (unformatted) classType per Article 1. The operator has given the
class a name but hasn't pressed Ctrl+A yet, hasn't assigned a scoring
method, and no entries exist.

## Shape

Single row, two columns:
```
U,"<class name>"
```

No header column layout, no entry rows. The class literally exists only as
a name and a number in Ryegate's folder until the operator configures it.

## When the parser will see these

A true-U file shows up whenever a class is pre-loaded into Ryegate (e.g.,
a show manager imports the schedule but hasn't walked through each class
yet) OR when the show is generated from a template. Real examples on Bill's
disk:

- `31.cls` — `U,"$1,000 1.25M  JUNIOR JUMPER  II.1"`
- `32.cls` — `U,"$5,000 1.25M  JUNIOR JPR CLASSIC  II.2b"`

Recreated here along with 6 more Jr/AO-range variants matching the real
Devon naming patterns, so the parser has enough variety to exercise:

- Height ranges: 1.00M, 1.05M, 1.10M, 1.15M, 1.20M, 1.25M, 1.30M
- Categories: JUNIOR JUMPER, AMATEUR JUMPER, AMATEUR OWNER JUMPER, JR/AO
- Methods in the name text (NOT yet in a column): II.1, II.2b, II.2d
- Prize prefixes: $1,000 / $5,000 / $10,000
- CLASSIC suffix variants

## IMPORTANT — Article 1

These files have classType=`U`. The parser MUST NOT assume jumper OR hunter
column meanings when classType=U. Per Article 1, U means "no lens yet" —
read only col[0] (the `U`) and col[1] (the quoted name). Inferring method
from the name text is fragile (operator-entered strings are not
canonical) — wait for the real header or a UDP hint before committing
to a lens.

## Other classType fixtures

- `../H/` — hunter lens fixtures
- `../J/` — Farmtek jumper lens fixtures
- `../T/` — TOD jumper lens fixtures

Populated as real data becomes available or is invented for test coverage.
