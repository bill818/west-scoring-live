# vMix Pipeline — Production / After Effects Integration

**For the WEST production manager / graphics designer.**
**Status:** Working document. Started 2026-05-11.
**Companion to:** `ENGINE-VMIX-INTEGRATION.md` (engine architecture).

This document explains **what WEST will provide** as the data + trigger
source for your vMix graphics pipeline, **how After Effects fits in**,
and **what decisions we need from you** before we build.

---

## Locked decisions (Bill 2026-05-11)

- **Data format: XML.** WEST writes a `scoring.xml` file on the vMix
  PC that vMix Data Source binds to.
- **Output target: house videowalls** (in-venue LED panels), NOT
  broadcast stream. This matters for the latency budget — spectators
  in the arena hear the announcer in real time, so graphics on the
  walls need to keep up. We're targeting **under 100ms** end-to-end
  from operator action to wall update.
- **After Effects role: pre-rendered transition stingers.** AE
  produces the look (wipes, score-reveals, brand swooshes). vMix
  plays them on cue. WEST fires the cue. No live AE+NDI rig needed.
- **No replay graphics in scope.** Clean camera feed comes from house
  videographers; we add graphics over it.
- **No videowall scoreboard hardware path** — the existing
  RSServer/Ryegate scoreboard pipe is separate from vMix and stays
  on its own channel.

---

## What WEST provides

WEST runs a small "broadcast engine" on the vMix PC. It listens to
Ryegate's UDP feed on the LAN (same source the operator engine uses)
and exposes four things locally — no cloud round-trip, sub-100ms
latency:

### 1. `scoring.xml` — for vMix Title Designer

A single file rewritten atomically every time scoring state changes.
vMix's **Data Source** feature polls this file and binds its fields
to text elements in a Title template. Each "row" is selectable in
vMix; we expose one row representing what's currently on screen.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<list>
  <item>
    <ring>1</ring>
    <class_num>1161</class_num>
    <class_name>The Little Big Man Challenge Trophy Class</class_name>

    <!-- Currently on course -->
    <oncourse_entry>53</oncourse_entry>
    <oncourse_horse>UBILUC</oncourse_horse>
    <oncourse_rider>Mark Bluman</oncourse_rider>
    <oncourse_owner>Mark Bluman</oncourse_owner>
    <oncourse_country>COL</oncourse_country>
    <oncourse_faults>0</oncourse_faults>
    <oncourse_status></oncourse_status>

    <!-- Just finished — for the "score reveal" graphic -->
    <prev_entry>52</prev_entry>
    <prev_horse>STARDUST</prev_horse>
    <prev_rider>Bill Worthington</prev_rider>
    <prev_country>USA</prev_country>
    <prev_rank>5</prev_rank>
    <prev_faults>4</prev_faults>
    <prev_time>33.45</prev_time>
    <prev_status>clear</prev_status>

    <!-- Class progress -->
    <gone>27</gone>
    <total>40</total>
    <remaining>13</remaining>
    <time_allowed>90</time_allowed>
  </item>
</list>
```

Add/remove fields as your Title designs need — the spec evolves with
your design. We can extend the XML on request.

**Polling:** vMix Data Sources poll at minimum 1 second. That's fine
for rider names, horse names, faults, ranks — anything that doesn't
change mid-ride. For the **ticking countdown clock**, see #3 below.

### 2. `http://localhost:8765/cues` — local WebSocket event stream

While the XML carries continuous DATA (what's currently on screen),
the WebSocket carries LIFECYCLE EVENTS (when state changes meaningfully).
This is what drives transition cues — the moment a rider finishes is
when an AE stinger should play.

Your overlay HTML (or any local consumer) subscribes to
`ws://localhost:8765/cues` and gets JSON events like:

```json
{ "type": "oncourse",       "entry_num": "53", "at": "2026-05-11T18:33:02Z" }
{ "type": "score_displayed","entry_num": "53", "rank": "1", "faults": "0", "time": "34.20" }
{ "type": "finish",         "entry_num": "53", "at": "2026-05-11T18:34:08Z" }
{ "type": "class_start",    "class_num": "1161" }
{ "type": "class_complete", "class_num": "1161" }
{ "type": "focus_change",   "class_num": "1162" }
{ "type": "cd_tick",        "entry_num": "53", "clock": "34.20", "remaining_seconds": "55.80" }
```

**CD (CountDown) ticks** stream continuously while a rider is on
course — about 10 Hz from Ryegate, which we forward. That's how the
HTML clock overlay (#3) stays sub-second smooth.

### 3. `http://localhost:8765/overlay/clock` — HTML clock overlay

vMix Title Designer can't redraw fast enough for a smoothly ticking
countdown clock (1-second poll = jerky). The fix: load this URL as a
**vMix Web Browser Source** with transparent background. The page
subscribes to the WebSocket and redraws the clock on every CD tick.

Variants we'll provide:
- `/overlay/clock` — small clock card, can sit in a corner
- `/overlay/lower-third` — full identity + clock + faults (Devon-style)
- `/overlay/just-finished` — score-reveal banner that fades in/out

You'd use the HTML overlay for anything that needs sub-second timing
or complex animations driven by data. Everything else can stay in
vMix's native Title system.

### 4. `http://localhost:8765/api/cue?...` — direct vMix HTTP triggers (optional)

If you'd rather have WEST drive vMix directly (rather than your own
listener wrapping the WebSocket), the engine can call vMix's HTTP API
on each lifecycle event. Example: on `finish`, the engine sends:

```
GET http://localhost:8088/api/?Function=Stinger1
GET http://localhost:8088/api/?Function=CueTitleDesigner&Input=ScoreReveal&SelectedIndex=0
```

That fires the AE-rendered "score reveal" stinger and cues the matching
Title. Producer-side this means **no custom code on your end** — you
just design the AE assets and the vMix Titles, and WEST drives both.

This option is **recommended** for simplicity. The WebSocket is the
escape hatch if you want custom logic between event and graphic.

---

## How After Effects fits

### Workflow at a glance

1. You design transitions and graphic frames in AE — rider intro
   swoosh, score reveal animation, class title card, sponsor flash,
   etc.
2. Render each as MOV with alpha channel (ProRes 4444 recommended,
   PNG sequence as fallback). 1080p or 4K, depending on the videowall
   resolution.
3. Load each into vMix:
   - **Stinger Transitions** — assigned to vMix's transition slots
     (Stinger 1, 2, etc.), played between cuts
   - **Inputs** — added as media inputs, cut to / overlaid as standalone
     layers
   - **Title backgrounds** — assigned to Title Designer templates,
     text overlaid on top
4. Design vMix Titles using your AE backgrounds + text fields bound
   to `scoring.xml`. Each text element points at an XML column (e.g.
   `oncourse_rider`, `prev_faults`).
5. WEST broadcast engine handles the **timing** — fires the cue on
   each scoring event so your AE assets play at the right moment with
   the right text underneath.

### What stays in AE vs what stays in vMix

| Element                            | Where it lives   | Why                          |
|------------------------------------|------------------|------------------------------|
| Brand intro animation              | AE → MOV+alpha   | Pre-rendered, one-shot       |
| Lower-third frame design (the box) | AE → MOV+alpha or PNG | Static or anim'd background  |
| Rider name / horse / faults TEXT   | vMix Title       | Bound to XML, updates live   |
| Score reveal animation             | AE → MOV+alpha   | Pre-rendered transition      |
| The actual score NUMBER on reveal  | vMix Title       | Bound to XML, varies per ride|
| Live countdown clock (ticking)     | WEST HTML overlay| Needs sub-second update      |
| Class title card flourish          | AE → MOV+alpha   | Pre-rendered, plays on class start |
| Sponsor strip                      | AE → MOV+alpha   | Pre-rendered, layered on top |

Key principle: **AE designs the LOOK, vMix Titles render the DATA,
WEST drives the TIMING.**

### If you'd rather do data-driven AE (Pattern C)

This is the more advanced path: AE running on a dedicated machine
with NDI Live Output, reading our `scoring.xml` via expressions,
streaming animated graphics over NDI into vMix. Heavier setup, more
moving parts, but allows AE to animate the data itself (rider's name
flying in letter-by-letter, particle FX driven by fault count, etc.).

**This is not what we're planning.** Locked decision above is Pattern A.
Flag if you want to revisit.

---

## Event vocabulary — what WEST emits

WEST's broadcast engine separates Ryegate's UDP stream into three
categories of signal. Each maps to a different way you'd use it:

### Continuous Data (CD)

The **CountDown clock** — sub-second updates streamed via WebSocket
while a rider is actively on course (~10 Hz). Carries elapsed time,
faults accruing in real time, jump status, time-remaining-of-allowed.

- **Use for:** the live ticking clock on the wall
- **Channel:** WebSocket only (XML can't keep up)
- **Stops when:** rider finishes round, class breaks for course walk,
  no one is on course

### Lifecycle events

Moment-in-time signals. Each is a discrete event the broadcast should
react to with a transition.

| Event              | When it fires                                        | Typical reaction       |
|--------------------|------------------------------------------------------|------------------------|
| `class_start`      | New class becomes the focused class                  | Class title card       |
| `oncourse`         | Rider goes on course (intro frame from Ryegate)      | Rider intro stinger    |
| `score_displayed`  | Operator hits "Display Scores" — final score set     | Score reveal stinger   |
| `finish`           | Round ends (status determined)                       | Standings update       |
| `class_complete`   | Class is marked complete                             | Class results card     |
| `focus_change`     | Operator switches focused class on the ring          | Switch graphic context |

You'd map each event to a specific vMix HTTP API call (cue a stinger,
load a Title, switch input). WEST can do that mapping for you
(recommended path) or expose the events for your own logic to act on.

### Snapshot data

The static state of "what's on screen right now" — names, horse,
class, rank, etc. Carried in `scoring.xml`, rewritten on every
meaningful change. Polled by vMix Title Designer for text binding.

---

## How the setup goes (practical)

1. **WEST installs the broadcast engine** on the vMix PC. Bundles a
   small local server (no incoming firewall rule needed beyond
   localhost). Config: ring number, output paths.

2. **You design AE assets** for transitions / backgrounds. Render
   each as MOV+alpha. Hand them over to WEST (or drop into a known
   folder on the vMix PC).

3. **vMix project setup:**
   - Add a **Data Source** pointing at `C:\WEST\broadcast\scoring.xml`.
     Set Refresh = 1 second.
   - Build **Title Designer** templates for each graphic state (lower
     third, class title, score reveal). Bind text fields to Data
     Source columns.
   - Load **Stinger Transitions** from your AE renders into the
     transition slots.
   - Add **Web Browser Source** pointing at
     `http://localhost:8765/overlay/clock` (or the lower-third
     variant) for the ticking clock — transparent background, layered
     over your Title.
   - Mark the program output that feeds the house videowall.

4. **WEST drives cues** via vMix HTTP API. Engine watches scoring
   events, fires the matching `Function=Stinger1` / `Function=CueTitleDesigner`
   calls. Your AE stingers play at the right moment with the right text
   underneath.

5. **Show day:** operator runs the class normally on the operator PC.
   Broadcast engine on vMix PC is passive — listens to Ryegate UDP,
   writes XML, fires cues. No operator interaction needed once
   configured.

---

## Open questions for the producer

These shape the final XML schema, the AE asset inventory, and the
event-to-cue mapping. Bill is collecting answers — please reply on
the items below.

### 1. Direct vMix HTTP API integration?

The recommended approach is WEST calls vMix HTTP API directly to cue
your stingers + titles on each lifecycle event. Less code on your
side, more reliable timing.

Alternative: WEST fires events on the WebSocket, you write a small
listener that maps events to vMix actions yourself.

**Question:** are you OK with WEST driving vMix directly, or do you
want event signals and you'll write your own listener?

### 2. Lower-third spec

We need to nail down:

- **Fields shown on screen:** rider name, horse, country flag, faults,
  time, rank, class number, class name — which of these appear, in
  what visual hierarchy?
- **Dwell time:** how long does the lower-third stay up after a rider
  goes on course? Until the next rider? Hard-timed (e.g. 8 seconds
  then auto-fade)?
- **Transition style:** the IN animation (rider goes on course) and
  the OUT animation. Same stinger or two different ones?

**Question:** can you mock up the lower-third and send a still + a
~5 second motion test? That'll let us draft the XML schema to match.

### 3. Score reveal

Different broadcasts handle the "score is in" moment differently:

- Some show a big number that lands with impact
- Some show the rank changing in real time as the standings rebuild
- Some hold the rider's lower-third and update the faults field in
  place
- Some do all three in sequence

**Question:** what's your concept for the score reveal moment?

### 4. Class transitions

When the operator moves from class 1161 to 1162, what should appear
on the wall?

- Brief "Up next: Class 1162 — The Welcome Stake" title card?
- Standings of the just-completed class held for N seconds?
- Hard cut to the next class's first rider?

**Question:** what's the inter-class graphic flow?

### 5. Sponsor / overlay states

Any moments where additional overlays sit ON TOP of the lower-third?

- Sponsor flash between rides
- Stats strip ("Class avg: 4.2 faults · Clears: 3 of 27")
- Promotional crawls

**Question:** what extra overlay states are in scope, and how do they
interact with the lower-third (replace it, layer on top, fade it
out)?

### 6. AE asset inventory

What assets do you already have? Anything WEST can see in advance
will help us build the XML schema with the right fields and match
your visual language.

**Question:** can you share the existing AE project files, or sample
MOGRT exports, or even just stills of the current look? Even a brand
guide would help.

### 7. Multi-ring

Some shows run two rings simultaneously. Does the vMix machine drive
graphics for one ring at a time (operator switches between them) or
both rings simultaneously (split screen / picture-in-picture / two
walls)?

**Question:** is this single-ring or multi-ring?

### 8. Network topology

Per `ENGINE-VMIX-INTEGRATION.md`, the broadcast engine listens to
Ryegate's UDP broadcast on the LAN — same source the operator engine
uses. This assumes vMix PC is on the same LAN as Ryegate (typical).

**Question:** confirm vMix PC, operator PC, and Ryegate are on the
same LAN. Flag any network segmentation we'd need to design around.

---

## Next concrete build steps (once questions answered)

These are WEST-side. Producer's parallel work is AE asset design.

1. Add **BROADCAST mode** to the engine (5th mode alongside
   WEBSITE+PASS-THROUGH / WEBSITE ONLY / PASS-THROUGH ONLY / IDLE).
2. Build local HTTP + WS server (Node, `http` + `ws` modules).
3. XML writer — atomic rewrite of `scoring.xml` on every state change.
4. WebSocket trigger emitter — fire lifecycle events from existing
   UDP/postCls event detection.
5. CD tick forwarder — stream Ryegate's ~10 Hz clock to the WS at
   live cadence.
6. HTML overlay bundle:
   - `/overlay/clock` — ticking countdown card
   - `/overlay/lower-third` — Devon-style full lower-third
   - `/overlay/just-finished` — score-reveal banner
7. Optional: vMix HTTP API caller (driven by config — map each
   lifecycle event to a vMix function call).
8. Installer flow — one-button broadcast engine install on the vMix
   PC.

---

**Last updated 2026-05-11.** Update as producer questions get
answered.
