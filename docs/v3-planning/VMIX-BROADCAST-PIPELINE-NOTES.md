# vMix Broadcast Pipeline — Production / After Effects Notes

**Status:** Open notepad. Started 2026-05-11.
**Companion to:** `ENGINE-VMIX-INTEGRATION.md` (engine architecture).
**Honest scope:** Passing knowledge of vMix + AE workflows below. The
production manager is the authority on what they need; this doc is to
get us speaking the same vocabulary and to give Bill enough to drive
the conversation.

## Confirmed decisions (Bill 2026-05-11)

- **Data format: XML.** We emit `scoring.xml` for vMix Data Source +
  Title Designer binding. (May also emit `scoring.json` cheap-cost
  for any future consumer.)
- **No replay graphics.** Clean feed comes from house videographers;
  no replay overlays, no slo-mo, no X-Y graphics in scope.
- **WEST controls the house videowalls** — vMix is one of WEST's
  outputs. (Confirm whether vMix output target is broadcast stream,
  videowalls, or both — see Open Questions.)
- **After Effects role: Pattern A — pre-rendered stingers / titles.**
  AE produces transition assets (MOV+alpha); engine fires cue signals
  via vMix HTTP API; vMix plays the AE stinger. Data text comes from
  our XML, not from AE. We do NOT need the more complex AE+NDI live
  pipeline.

## What we already have on our side

- Engine v3.2.0+ ships UDP events as separate categories. Bill's
  shorthand: **CD / oncourse / finish signals** (need to confirm exact
  mapping — see Open Questions).
- The cloud path puts these on the WebSocket pipe today; the broadcast
  engine on the vMix PC can subscribe to the same Ryegate UDP source
  and emit them locally without cloud round-trip.
- `scoring.json` is the proposed data-source file (sub-100ms updates
  via atomic file rewrite). Format documented in
  `ENGINE-VMIX-INTEGRATION.md`.

## How vMix actually ingests data

vMix exposes three data-handling surfaces. The producer probably uses
one or more of these depending on the look they want.

**1. Data Sources (XML / CSV / JSON / Google Sheets / Excel)**
- vMix polls a file every N seconds (configurable, minimum ~1s)
- Each row's fields become bindable text variables in a Title template
- Best for: rider name, horse, owner, rank, prize money — anything
  that changes once per rider, not faster
- Format vMix likes best: **XML or CSV**. JSON works but vMix's JSON
  path picker is clunky vs XML.

Recommended XML format (one row per "what's currently on screen"):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<list>
  <item>
    <ring>1</ring>
    <class_num>1161</class_num>
    <class_name>The Little Big Man Challenge Trophy Class</class_name>
    <oncourse_entry>53</oncourse_entry>
    <oncourse_horse>UBILUC</oncourse_horse>
    <oncourse_rider>Mark Bluman</oncourse_rider>
    <oncourse_owner>...</oncourse_owner>
    <oncourse_country>COL</oncourse_country>
    <oncourse_clock>34.20</oncourse_clock>
    <oncourse_faults>0</oncourse_faults>
    <oncourse_status></oncourse_status>
    <prev_entry>52</prev_entry>
    <prev_horse>...</prev_horse>
    <prev_rider>...</prev_rider>
    <prev_rank>5</prev_rank>
    <prev_faults>4</prev_faults>
    <prev_time>33.45</prev_time>
    <gone>27</gone>
    <total>40</total>
    <remaining>13</remaining>
  </item>
</list>
```

We can emit both `scoring.json` AND `scoring.xml` from the engine —
costs nothing, gives the producer flexibility.

**2. Title Designer (vMix GT)**
- Where the producer designs the actual graphic LOOK
- Text fields bind to Data Source columns (above)
- Supports basic animation: in/out transitions, simple keyframes
- Not as fancy as After Effects but real-time
- Trigger: "Cue" the Title and it animates in; another action to hide

**3. Web Browser Source**
- Full HTML/CSS/JS overlay rendered as a transparent layer
- Best for sub-second clocks, complex animations, anything that needs
  more than vMix Titles can do
- We control everything from the WEST side
- `scoreboard-lab.html` Layout C (Devon ultra-wide) is the prototype
- Add transparency, point vMix at `http://localhost:8765/overlay/...`
- Subscribes to local WS for push updates

## How After Effects typically fits in

AE doesn't connect to vMix as a live data source. It's used as a
**design + asset production** tool. Common patterns:

**Pattern A — Pre-rendered stingers and transitions**
- AE designs the WIPE / GLITCH / SWOOP between graphics
- Renders as `.mov` with alpha channel (ProRes 4444 or PNG sequence)
- Imported into vMix as a **Stinger Transition** or **Effect Layer**
- vMix triggers them on demand (between titles, between camera cuts)
- Data text overlays still come from vMix Titles or our HTML overlay
- **This is the most common AE-vMix workflow.** AE makes the look, vMix
  drives the data and triggers.

**Pattern B — Motion Graphics Templates (.mogrt)**
- Designed in AE, exported via "Essential Graphics" panel
- Loaded into **Premiere Pro** or **Adobe Live Output Module**
- Doesn't load directly into vMix
- Would require an extra layer (NDI output from a Premiere/AE rig
  into vMix as an NDI input)
- More complex, more powerful, requires Adobe rig running concurrently

**Pattern C — AE rendered live via Adobe Creative Cloud Live (NDI)**
- AE running with NDI Output enabled
- AE expressions read data from a local JSON file (our scoring.json)
- AE composition updates in real-time, streamed via NDI
- vMix takes NDI as an input source, overlays on program
- High-end production workflow, requires dedicated AE machine

**Pattern D — Web Browser Source (our overlay.html)**
- Skip AE for data overlays entirely
- All data-driven graphics in HTML/CSS/JS
- AE used only for branded backgrounds, lower-third frames, transitions
- This is the most reliable for sub-second timing
- Matches what we've been building (`scoreboard-lab.html`)

## Recommended layered pipeline

Three planes, each independent. Producer chooses what they want at
each layer.

**Data plane** — what scoring data is available
- `scoring.json` (atomic rewrite on every event)
- `scoring.xml` (same data, XML shape for vMix Data Source binding)
- Both files in a known location (e.g. `C:\WEST\broadcast\`)
- vMix reads either; producer picks based on Title template approach

**Trigger plane** — moment-in-time events the broadcast should react to
- This is where Bill's CD / oncourse / finish signals live
- Our engine fires events on the local WebSocket:
  ```
  { "type": "oncourse", "entry_num": "53", "at": "..." }
  { "type": "score_displayed", "entry_num": "52", "at": "..." }
  { "type": "finish", "entry_num": "52", "rank": 5, "at": "..." }
  { "type": "class_complete", "class_num": "1161", "at": "..." }
  ```
- Two ways the producer can consume them:
  1. **vMix HTTP API** — engine POSTs to vMix's local API (default
     port 8088) to cue Titles / fire transitions on the producer's
     behalf. e.g. `http://localhost:8088/api/?Function=CueTitleDesigner&Input=Lower3&SelectedIndex=0`
  2. **Browser overlay WS** — overlay.html subscribes to the WS, runs
     CSS animations on its own when events arrive. No vMix API needed.

**Asset plane** — the visual design itself
- vMix Title Designer for simple text overlays
- AE-rendered stingers (.mov + alpha) for transitions between graphics
- HTML overlay (our `scoreboard-lab` evolved into `overlay.html`) for
  complex live-data graphics
- All three coexist — vMix layers them in priority order

## What "transitions FX" means (best guess)

Probably: between rider info graphic for rider A finishing and rider
info graphic for rider B going on course, the producer wants an
animated wipe / glitch / brand-swoosh / etc — designed in AE.

Our part:
- Fire the **trigger** ("rider A finished" + "rider B oncourse") with
  precise timestamps
- Producer's AE stingers handle the visual transition
- Our data source updates between the two so the new graphic shows B's
  info when it lands

If they want **live data-driven transitions** (the SCORE itself flies
in animated, particle FX based on faults, etc), that lives in the
HTML overlay using CSS / Lottie / GSAP animations driven by WS events.

## Our CD / oncourse / finish signals — where they map

(Bill — need to confirm exact event boundaries; check
`UDP-PROTOCOL-REFERENCE.md` for canonical names.)

| Engine signal     | Broadcast meaning                              |
|-------------------|------------------------------------------------|
| oncourse start    | Show "rider on course" lower-third             |
| oncourse finish   | Score popped, fire AE finish stinger, show standings |
| Display Scores    | Promote ride to "just finished" banner         |
| class start       | Show class title card                          |
| class complete    | Show "class results" board                     |
| focus change      | Switch graphics to focused class               |

Each of these is a trigger the producer wires to a vMix Title or AE
stinger. We just fire the event; they decide what plays.

## Open questions for the production manager

Some questions are answered (struck through); the rest still need
producer input before we start building.

1. ~~**vMix data ingest preference**: XML Data Source + Title
   Designer, or HTML Web Browser Source, or both?~~ → **XML** locked.
   (HTML Web Browser Source can still be added later as an additional
   layer for sub-second clock if Title-poll lag becomes a problem.)

2. ~~**After Effects role**: rendering branded stingers/transitions
   only, OR live-data-driven graphics via NDI?~~ → **Pattern A**
   (pre-rendered stingers). No live AE+NDI rig needed.

3. **Trigger consumption**: should the engine call vMix's HTTP API
   directly to cue titles + fire stingers, OR fire events to a
   listener that wraps the HTTP API on the producer's machine?
   (Recommend: engine calls vMix HTTP API directly — fewer moving
   parts.) **Open for producer.**

4. **Lower-third format**: what fields, what time-on-screen, what
   transition style? Determines XML row shape and which AE stingers
   we expect (rider-intro / score-reveal / class-title / etc.).
   **Open for producer.**

5. **Multi-graphic states**: any time a sponsor strip or stats board
   overlays the lower-third? Stacking order matters for the layered
   approach. **Open for producer.**

6. ~~**Replay graphics**~~ → out of scope. Clean feed only.

7. **Branding sources**: AE projects the production team already
   owns? Sample MOGRT / final-render files would let us know what
   shape they're in so our XML row design doesn't lock them out.
   **Open for producer.**

8. **Network setup**: vMix PC on the same LAN as Ryegate AND/OR the
   operator engine? Multicast vs unicast? Confirms whether our
   "vMix engine listens to same Ryegate UDP" assumption holds.
   **Open — engineering question for the venue.**

9. **Multi-ring**: one vMix machine driving graphics for ring 1 and
   2 simultaneously? Affects whether we run one engine per ring or
   one engine that exposes both rings. **Open for producer.**

10. **vMix output target**: what is vMix's program output going to?
    Broadcast stream (TV / web), house videowalls (in-venue LED
    panels), or both? Bill flagged that WEST controls the videowalls
    — confirm vMix is the source for them too vs. a separate path.
    **Open for Bill / producer.**

## Next concrete steps (once questions answered)

- Add **BROADCAST mode** to engine (5th mode in the existing pill).
  Disables cloud post, enables local server.
- Implement local HTTP + WS server (Node http + ws module — small).
- Add atomic `scoring.json` writer + `scoring.xml` writer on every
  state change.
- Port `scoreboard-lab.html` Layout C → `overlay/full.html` with
  WS subscription + transparent body background.
- Implement trigger event emitter (engine → WS) using the existing
  oncourse / finish event detection.
- Optional: vMix HTTP API caller (if producer wants engine to drive
  vMix directly rather than HTML overlay reacting on its own).

---

**Last updated 2026-05-11.** Add notes as the producer conversation
progresses.
