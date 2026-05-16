# vMix XML Data Source Schema

Contract for the two XML feeds the WEST worker exposes so a vMix graphics
operator can bind Title fields directly to live show data.

Both endpoints are **public-read** (no auth, no CORS issues — vMix Data
Sources aren't browsers) and serve `application/xml; charset=utf-8`.

---

## URLs

### Sandbox — for building / testing Title bindings now

Drive these feeds with synthetic data via the control page at
[`v3/pages/vmix-sandbox.html`](../v3/pages/vmix-sandbox.html) (deployed at
`https://preview.westscoring.pages.dev/vmix-sandbox.html`).

```
https://west-worker.bill-acb.workers.dev/v3/vmixLive?slug=vmix-sandbox&ring_num=1
https://west-worker.bill-acb.workers.dev/v3/vmixStandings?slug=vmix-sandbox&ring_num=1
```

### Old Salem Farm Spring II — for the live show

```
https://west-worker.bill-acb.workers.dev/v3/vmixLive?slug=osf-spring-ii&ring_num=1
https://west-worker.bill-acb.workers.dev/v3/vmixStandings?slug=osf-spring-ii&ring_num=1
```

**Same endpoint, same columns** — only the slug param changes between
sandbox and a live show. No Title rebuilds needed; Title bindings stay
identical when you swap.

### General form

| URL | Shape | Purpose |
|---|---|---|
| `GET /v3/vmixLive?slug=<slug>&ring_num=<n>` | 1 row | Active rider + frame state. Drives the "now showing" Titles. |
| `GET /v3/vmixStandings?slug=<slug>&ring_num=<n>` | Up to 10 rows | Current standings for the focused class, sorted by rank ascending. Drives leaderboard Titles. |

Slug + ring match what the rest of the v3 stack uses (e.g. `?slug=osf-spring-ii&ring_num=1`).

### Update cadence

End-to-end latency from ring event → vMix Title update is **typically
≤1 second, worst case ≤2 seconds**:

| Stage | Cadence | Notes |
|---|---|---|
| Ryegate scoring PC → watcher | Real-time (UDP) | Per event |
| Watcher → worker `/postClassEvent` | Real-time (HTTPS) | One POST per `INTRO` / `CD_START` / `ON_COURSE` / `FAULT` / `FINISH` / `HUNTER_RESULT` / `CLOCK_STOPPED` / `CLOCK_RESUMED` event. `ONCOURSE` clock + fault updates also flow at ~1 Hz while a ride is in progress. |
| Worker → KV write | Immediate (≤50ms) | KV is the source of truth the XML endpoints read |
| KV → vMix XML endpoint | Per request | Both endpoints read live from KV on every poll |
| vMix Data Source poll | **1 second minimum** | Set to 1s in vMix; higher values just add latency |

For sub-second cues (e.g. countdown threshold crossings) the engine can
fire a direct vMix TCP shortcut on port 8099 in parallel with the XML
poll; see "Sub-second cuing" below.

### KV TTLs (how long data lingers without new events)

The worker writes each KV key with a TTL. After the TTL expires without
a refresh, the row reverts to `frame="IDLE"`:

| KV key | TTL | Purpose |
|---|---|---|
| `oncourse:` (`INTRO`, `CD`) | 120s | Short — operator shouldn't linger between intro and clock start |
| `oncourse:` (`ONCOURSE`) | 300s | Clock running; refreshed on every fault / clock event |
| `oncourse:` (`FINISH`, `RESULTS`) | 600s | Held longer so the finish frame stays visible after the ride ends |
| `ring-state:` | ~600s | Refreshed on every score / class event |
| `selected:` | 7200s | Class selection persists across operator breaks |
| Sandbox keys (all) | 600s | Refreshed on every button press in the control page |

### Idle / no data

When the ring is idle (no class focused, no on-course rider) the endpoint
still returns valid XML with a single row where `frame="IDLE"` and all
other columns are empty strings. Standings returns `<scoring/>` (zero
rows) when there is no focused class.

---

## Frame state machine

The `frame` column on `live.xml` is the canonical signal for which Title
to show. Values are taken **verbatim** from the watcher's UDP-derived
`oncourse.phase` field — they are stable, universal across the WEST stack,
and **case-sensitive** in trigger rules.

### Jumper

| `frame` | Trigger | What it means |
|---|---|---|
| `INTRO` | Watcher posts `INTRO` event (Ctrl+A class-select + intro UDP pair) | Entry walking in; no clock yet |
| `CD` | Watcher posts `CD_START` event | Countdown to start; `countdown` column is seconds remaining |
| `ONCOURSE` | Watcher posts `ON_COURSE` event (clock running) | Live ride; `elapsed` + fault columns update as faults accrue |
| `FINISH` | Watcher posts `FINISH` event | Round complete; `elapsed`, `jump_faults`, `time_faults`, `rank` populated |

### Hunter

| `frame` | Trigger | What it means |
|---|---|---|
| `INTRO` | Watcher posts `INTRO` event | Entry walking in |
| `ONCOURSE` | Watcher posts `ON_COURSE` event | Round in progress (hunters have no live clock) |
| `RESULTS` | Watcher posts `HUNTER_RESULT` event (flat / forced placement classes) | Ribbon announcement; `hunter_place` + `hunter_score` populated |

---

## live.xml — columns

Single `<row>` element. Empty string when a column does not apply to the
current `frame` or `discipline`.

### Column reference

| Column | Type | Source | Notes |
|---|---|---|---|
| `frame` | enum | `oncourse.phase` | `INTRO` \| `CD` \| `ONCOURSE` \| `FINISH` \| `RESULTS` \| `IDLE` |
| `discipline` | enum | derived | `jumper` \| `hunter` |
| `ring` | int | URL | matches `ring_num` param |
| `class_num` | string | snapshot `class_meta` / `selected` KV | Ryegate class number |
| `class_name` | string | snapshot `class_meta` / `selected` KV | e.g. `"$50,000 Old Salem Farm Grand Prix"` |
| `round` | int | `oncourse.round` | `1` \| `2` \| `3` |
| `round_label` | string | `oncourse.label` | e.g. `"Jump Off"`, `"Round 2"` |
| `entry_num` | string | `oncourse.entry` | back number |
| `horse` | string | `oncourse.horse` | |
| `rider` | string | `oncourse.rider` | |
| `owner` | string | `oncourse.owner` | |
| `country` | string | snapshot entry row, looked up by `entry_num` | 3-letter IOC/FEI code. **Jumpers only**; blank for hunter. |
| `city` | string | `oncourse.city` | |
| `state` | string | `oncourse.state` | |
| `ta` | string | `oncourse.ta` | Time allowed (jumper) |
| `countdown` | int | `oncourse.countdown` | Seconds remaining; **populated only on `CD` frame** |
| `elapsed` | string | `oncourse.elapsed` | Live clock (`ONCOURSE`) or final time (`FINISH`) |
| `jump_faults` | string | `oncourse.jumpFaults` | |
| `time_faults` | string | `oncourse.timeFaults` | |
| `total_faults` | string | derived | `jump_faults + time_faults`, **only on FINISH** |
| `rank` | string | `oncourse.rank` | **only on FINISH**. Usually a place number. In a **jump-off class**, a clear Round-1 finisher who has qualified for the jump-off emits the literal text **`JO`** (Ryegate withholds a scoreboard rank for clears; they're "in the jump-off"). Bind this field as **text**, not numeric — it can be `12`, `JO`, or empty. |
| `fpi` | int | `oncourse.fpi` | Faults per interval (jumper config) |
| `ti` | int | `oncourse.ti` | Time interval (jumper config) |
| `ps` | int | `oncourse.ps` | Penalty seconds (jumper config) |
| `hunter_score` | string | `oncourse.hunterScore` | Hunter `FINISH` / `RESULTS` |
| `hunter_place` | string | `oncourse.place` | Hunter `RESULTS` (ribbon order) |
| `round1_score` | string | snapshot hunter entry row, looked up by entry_num | `r1_score_total` |
| `round2_score` | string | snapshot hunter entry row | `r2_score_total` |
| `round3_score` | string | snapshot hunter entry row | `r3_score_total` |
| `combined_score` | string | snapshot hunter entry row | `combined_total` |

### Example — Jumper `ONCOURSE`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<scoring>
  <row frame="ONCOURSE" discipline="jumper" ring="1"
       class_num="501" class_name="$50,000 Old Salem Farm Grand Prix"
       round="1" round_label="Round 1"
       entry_num="42" horse="Indigo de Reve" rider="J. Smith" owner="Doe Farm LLC"
       country="USA" city="Wellington" state="FL"
       ta="82.00" countdown="" elapsed="48.21"
       jump_faults="0" time_faults="0" total_faults=""
       rank="" fpi="1" ti="1" ps="6"
       hunter_score="" hunter_place=""
       round1_score="" round2_score="" round3_score="" combined_score=""/>
</scoring>
```

### Example — Idle ring

```xml
<?xml version="1.0" encoding="UTF-8"?>
<scoring>
  <row frame="IDLE" discipline="jumper" ring="1" class_num="" class_name=""
       round="" round_label="" entry_num="" horse="" rider="" owner=""
       country="" city="" state="" ta="" countdown="" elapsed=""
       jump_faults="" time_faults="" total_faults="" rank=""
       fpi="" ti="" ps="" hunter_score="" hunter_place=""
       round1_score="" round2_score="" round3_score="" combined_score=""/>
</scoring>
```

---

## standings.xml — columns

Up to 10 `<row>` elements, sorted by rank ascending. Columns are a
superset across jumper + hunter; blanks where N/A.

### Column reference

| Column | Type | Jumper source | Hunter source |
|---|---|---|---|
| `rank` | int | `overall_place` | `current_place` |
| `entry_num` | string | `entry_num` | `entry_num` |
| `horse` | string | `horse_name` | `horse_name` |
| `rider` | string | `rider_name` | `rider_name` |
| `owner` | string | `owner_name` | `owner_name` |
| `country` | string | `country_code` (3-letter IOC) | blank |
| `discipline` | enum | `"jumper"` | `"hunter"` |
| `time` | string | `r{active}_total_time` | blank |
| `faults` | string | `r{active}_total_faults` | blank |
| `status` | string | `r{active}_status` | `r{active}_h_status` |
| `score` | string | blank | `combined_total` |
| `round1_score` | string | blank | `r1_score_total` |
| `round2_score` | string | blank | `r2_score_total` |
| `round3_score` | string | blank | `r3_score_total` |
| `combined_score` | string | blank | `combined_total` |

`{active}` = the currently-running round on the focused class (highest
round with any non-null total).

### Example — Jumper standings

```xml
<?xml version="1.0" encoding="UTF-8"?>
<scoring>
  <row rank="1" entry_num="42" horse="Indigo de Reve" rider="J. Smith"
       owner="Doe Farm LLC" country="USA" discipline="jumper"
       time="48.21" faults="0" status="" score=""
       round1_score="" round2_score="" round3_score="" combined_score=""/>
  <row rank="2" entry_num="17" horse="Storm Front" rider="M. Garcia"
       owner="Garcia Sport Horses" country="MEX" discipline="jumper"
       time="49.05" faults="0" status="" score=""
       round1_score="" round2_score="" round3_score="" combined_score=""/>
  <row rank="3" entry_num="88" horse="Vesper" rider="K. Larsen"
       owner="Nordic Equestrian" country="DEN" discipline="jumper"
       time="49.84" faults="0" status="" score=""
       round1_score="" round2_score="" round3_score="" combined_score=""/>
  <!-- ...up to 10 rows... -->
</scoring>
```

### Example — Hunter standings

```xml
<?xml version="1.0" encoding="UTF-8"?>
<scoring>
  <row rank="1" entry_num="118" horse="Catch The Sun" rider="A. Brown"
       owner="Sunfield Stable" country="" discipline="hunter"
       time="" faults="" status="" score="177.5"
       round1_score="88.5" round2_score="89.0" round3_score="" combined_score="177.5"/>
  <row rank="2" entry_num="206" horse="Skylight" rider="E. Wong"
       owner="Wong Show Stables" country="" discipline="hunter"
       time="" faults="" status="" score="172.0"
       round1_score="85.0" round2_score="87.0" round3_score="" combined_score="172.0"/>
  <!-- ...up to 10 rows... -->
</scoring>
```

---

## vMix wiring (in vMix)

1. **Add Data Source** → XML → URL → paste one of the URLs at the top of
   this doc. Set the poll interval to **1 second** (vMix minimum).
2. **Bind Title fields** to column names — vMix references columns as
   `{column.Value}` in Title text (e.g. `{horse.Value}`, `{rider.Value}`,
   `{elapsed.Value}`, `{country.Value}`).
3. **Add Data Source Triggers** for frame-driven In/Out animations:
   *"when column `frame` changes to `<value>`, run shortcut
   `<TitleIn / TitleOut>`."* One Title per frame value (`INTRO`, `CD`,
   `ONCOURSE`, `FINISH`, `RESULTS`). Triggers fire on the next poll cycle
   (≤1s latency).
4. **Bind leaderboard Titles** to `standings.xml` with row indices 1..10.

### Sub-second cuing (optional)

For cues that need < 1s precision (e.g. countdown threshold crossings),
the engine can additionally fire a direct vMix TCP shortcut to port 8099
at the exact moment the threshold hits. Pattern:

```
FUNCTION OverlayInput1In Input=Countdown.gtzip
```

The XML still updates on the next poll for binding consistency, but the
TCP push handles the animation cue. Not required for v1.

---

## XML escaping

The endpoints XML-escape `& < > " '` in every attribute value. vMix
handles UTF-8 cleanly; no transliteration is performed for names with
accents or non-ASCII characters.

---

## Column stability promise

- **Adding** columns is non-breaking.
- **Renaming** or **removing** columns IS breaking — vMix Title bindings
  pin against column names.
- Frame values (`INTRO`, `CD`, `ONCOURSE`, `FINISH`, `RESULTS`, `IDLE`)
  are taken verbatim from the worker; treat them as case-sensitive
  constants in trigger rules.

---

## Implementation notes (for WEST devs)

- Both endpoints read existing KV — no new storage, no engine changes:
  - `oncourse:{slug}:{ring}` — live frame state (written by watcher's `/postClassEvent`)
  - `ring-state:{slug}:{ring_num}` — full snapshot (written by `_buildSnapshot`)
  - `selected:{slug}:{ring}` — class_num + class_name (written by watcher's `CLASS_SELECTED` event)
- Country code lookup on `live.xml` cross-references `oncourse.entry`
  against the snapshot's `jumper_scores` / `hunter_scores` array, since
  the watcher does not carry `country_code` in oncourse events.
- Hunter derby breakdown uses raw round totals (`r1_score_total`,
  `r2_score_total`, `r3_score_total`, `combined_total`) — the operator
  binds whichever Title fields they need per class type rather than the
  worker imposing derby semantics.
- The sandbox slug `vmix-sandbox` is driven by
  `POST /v3/vmixSandboxSet` (auth-gated). It writes the same KV keys the
  real pipeline uses, so `/v3/vmixLive` and `/v3/vmixStandings` serve
  synthetic data through the production code path — no special-casing.
