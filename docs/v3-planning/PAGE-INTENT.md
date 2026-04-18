# Page Intent — Live, Display, Stats
### Design philosophy, audience, and how v3's push architecture changes delivery without changing soul

This doc complements `UI-CATALOG.md` (which catalogs every control) by capturing the WHY behind three pages that will differ most under v3. v2's implementation will change substantially (polling → WebSocket, monolithic pages → shared modules, stateless worker → Durable Objects), but the INTENT behind each page must survive verbatim.

When v3 implementation decisions come up, re-read the matching "Intent" section here before touching the code. If an implementation choice conflicts with the intent, the intent wins.

---

## LIVE.HTML — "Is my rider on course right now?"

### Who this page serves

A parent watching their kid's round. A coach standing at the gate. A spectator two rings over who just heard their trainer call. A rider's partner watching from home 500 miles away. An operator sanity-checking what's being sent to the scoreboard.

All of them share one thing: **they're staring at a phone, one-handed, with limited attention budget, wanting the answer RIGHT NOW.**

### Primary user questions the page must answer in under 3 seconds

1. **Is my rider currently on course?** (If yes, clock front-and-center. If no, where are they in the OOG?)
2. **What's the clock doing?** (Ticking smoothly. If not ticking, why — is the watcher down?)
3. **How many faults so far?** (Live calculation, updates as the ride happens.)
4. **Who just went and how did they do?** (Recent-completed section at the bottom answers this.)
5. **Where's my rider in the standings right now?** (Standings below the on-course card.)

If a viewer has to scroll, tap, or think to get any of these — the page has failed.

### How the page should feel

- **Alive.** The clock ticks. New faults appear. Rank updates when a rider crosses the finish. Zero staleness doubt.
- **Unambiguous.** The on-course card is the visual loudspeaker. Nothing else competes with it while someone is in the ring.
- **Forgiving.** Wifi flakes on cell. Phones lock. Tabs suspend. The page reconnects, shows "connecting...", resyncs, and resumes without the viewer losing their place.
- **Boring when nothing's happening.** Between rides, the page doesn't demand attention. Classes that are complete fade into the "recent" section with muted styling. It earns its liveness.

### Key visual decisions (preserved in v3)

- **On-course card is THE anchor.** 42px clock, horse name in serif display font, entry # in red. Dominates the viewport above the fold on every phone.
- **Standings below.** Secondary to the on-course card. Rows are dense but scannable — DM Mono for numbers, Source Sans for names.
- **Recently-completed section.** Separate from live standings. Shows the last few classes with top-3 previews. Answers "who just won the class before mine?"
- **Watcher-offline amber banner.** If the signal drops, the banner says so explicitly. The clock freezes. Standings gray out. No misleading "live" state.
- **Phase pill.** Color-coded: green intro, amber countdown, red on-course, gray finish. Non-readers can still orient by color.

### How v3 changes the delivery (NOT the experience)

Under v2 polling, the live page asks "anything new?" once a second. The clock between polls is guessed locally using the timestamp trick that caused Session 27's nightmare.

**Under v3 WebSocket push:**
- The watcher emits a clock update every second to the Durable Object.
- The DO broadcasts to all connected spectators in ~50ms.
- The browser displays whatever most recently arrived. No interpolation, no flicker.
- Between updates, a local 1Hz tick smooths the visual (just increments the number). When the next authoritative update arrives, it snaps silently.

**What the viewer notices:** the clock feels rock-solid. No mystery jumps. Clock shows the number the scoreboard shows.

**What the viewer doesn't notice:** the entire transport layer is different. The visual language, card layout, clock position, colors, phase pills — all identical to v2.

### What will change structurally in v3

- **Poll loop deleted.** No more `setTimeout(poll, 1000)`. Replaced with `WEST.data.subscribe('clock', ...)`, `WEST.data.subscribe('phase', ...)`, `WEST.data.subscribe('standings', ...)`.
- **Page file shrinks from ~1500 lines of JS to ~40.** Render logic moves to `WEST.display.*` primitives. Clock logic in `WEST.clock.*`. Transport in `WEST.data.*`.
- **No staleness indicator for the clock.** If the WebSocket is connected, data is ≤50ms old. If it disconnects, a visible reconnecting banner appears. The "15 seconds since last heartbeat" math is gone.
- **Reconnect logic explicit.** Exponential backoff (1s, 2s, 4s, 8s capped at 30s). On reconnect, the DO sends a full snapshot so the page catches up from wherever it was.
- **Mid-round joiners get a snapshot immediately.** No more 10-second wait for the first heartbeat. The DO sends current state on connect.

### Pitfalls to avoid in v3 implementation

- **Don't redesign the on-course card.** It's the soul of the page. Same size, same colors, same clock font.
- **Don't over-engineer the reconnect UI.** A small "Reconnecting..." pill in the header, not a full-page overlay.
- **Don't optimize for desktop.** This page is mobile-first. Desktop users get a centered column; that's all the "desktop treatment" it needs.
- **Don't add features just because WebSocket enables them.** No live chat, no reaction emojis, no "X people watching" counter. The live page is for information, not engagement.
- **Don't lose the recent-completed section.** Operators and parents use it constantly.

---

## DISPLAY.HTML — "The ring's broadcast feed"

### Who this page serves

A TV mounted at the in-gate showing the operator the ring state at a glance. A projector in the spectator area broadcasting live results. A tablet held by the announcer cross-referencing what to call next. Someone on a laptop helping run the show from a back office.

All of them are looking at the **same big, bright, always-on screen** from **variable distances** in **variable lighting**. None of them are interacting with the page — they're reading it.

### Primary user questions the page must answer

1. **Who is on course right now?** (Sidebar card — entry #, horse, rider, clock, phase.)
2. **Who just finished, where did they place?** (Standings grid in the center.)
3. **Who's up next?** (Left panel order of go.)
4. **Are we running ahead or behind schedule?** (Progress counter at top.)
5. **What's the class, what's the TA, what's the sponsor?** (Top bar.)

Notice the hierarchy: **present (sidebar), past (standings), future (OOG).** Left-to-right time flow, matching how humans scan.

### How the page should feel

- **Authoritative.** It looks like a scoreboard, not a webpage. Dark theme, gold accents, big legible numbers.
- **Stable.** The layout never shifts. Panels don't resize. Nothing pops or slides except the auto-scrolling standings list.
- **Legible from 30+ feet.** 42px clock. 24px place numbers. Dark background, high-contrast text. No body-text body prose.
- **Self-managing.** Standings auto-scroll. Sidebar auto-cycles between on-course / finished / previous. The operator doesn't touch it mid-class.
- **Broadcast-safe.** High contrast for TV compression. No color-only information (places use size + color, phases use size + label).

### Key visual decisions (preserved in v3)

- **Dark theme.** `#0a0e1a` background, gold (`#fbbf24`) for active elements, white for data. Opposite of the mobile pages — because it's displayed on a screen, not held in hand.
- **3-column grid (OOG / Standings / Sidebar).** Never collapses. Never stacks. If the screen can't fit all three, the display is on the wrong screen.
- **Auto-scrolling standings.** "News ticker" effect — hold top 4s → scroll down 2px per 50ms → hold bottom 5s → jump back to top. No operator intervention needed.
- **Gold (not red) for active.** Red feels aggressive on a broadcast. Gold communicates "this is the current focus" without alarm.
- **Place numbers in Playfair Display.** Serif for permanence and elegance. 1st/2nd/3rd get gold/silver/bronze coloring.
- **Top bar with class info.** Always present, always readable. Shows the spectator what class they're looking at without needing to ask.
- **Progress counter.** "32 COMPETED" with a thin bar. Answers "how much is left in this class" at a glance.

### How v3 changes the delivery (NOT the experience)

Under v2, the display polls exactly like live.html does — asks every second, gets an answer, renders. The clock uses the same timestamp trick that's fragile.

**Under v3 WebSocket push:**
- The display subscribes to the DO for its ring and receives every event in real-time.
- The clock ticks from authoritative watcher shouts, with local smoothing.
- Standings re-render on the `standings-changed` event, not on every poll.
- When a ring's class completes and a new one starts, the display receives a "class-switch" event and rotates cleanly.

**What the audience notices:** the scoreboard looks more responsive. Faults appear the instant they happen, not 0-1000ms later. The clock doesn't flicker.

**What the audience doesn't notice:** that the entire transport is different. Same dark theme. Same 3-column layout. Same 42px clock. Same gold-for-active. Same auto-scroll.

### What will change structurally in v3

- **Display gets its own WebSocket subscription.** Not just the same feed as live.html — the DO can send richer data to the display (e.g. pre-cycled next class preview, operator cues).
- **Multi-ring cycling becomes trivial.** Currently each display is hard-coded to one ring. In v3, a display can subscribe to multiple DOs and cycle between them on a schedule. Useful for shows with one big TV and multiple active rings.
- **"Announcer mode" becomes possible.** A button that, when a horse finishes, holds their score + rank visible for 8 seconds even as new on-course data arrives — gives the announcer time to call it. This is a v3 feature enabled by the DO model.
- **Sidebar can show deeper context.** With push, the DO can emit "interesting facts" like "this horse's fastest round of the day" alongside the standard data. Optional — but architecturally enabled.
- **Auto-reconnect without losing scroll position.** Currently display.html uses sessionStorage to remember where the standings scrolled to. v3 preserves this, but also re-requests a snapshot on reconnect so the displayed data is guaranteed fresh.

### Pitfalls to avoid in v3 implementation

- **Don't make it responsive for mobile.** This is a scoreboard for a fixed screen. Responsive breakpoints here are wasted effort and invite font shrinkage.
- **Don't add interactivity.** No buttons, no toggles, no hover states. The display is read-only. If something needs controlling, it goes on admin.
- **Don't light-theme it.** Dark theme is the identity. "Light mode for outdoor use" is not a need — outdoor TVs are fine with dark.
- **Don't lose auto-scroll.** The ring operator loves not touching the screen. The scroll cadence is tuned; changing it would require re-tuning.
- **Don't shrink the clock.** 42px is not arbitrary. It's the minimum size legible from the far side of a jumper ring.

---

## STATS.HTML — "Is this course fair? Who's actually fastest?"

### Who this page serves

A course designer checking mid-class whether the course is too hard. An operator verifying the clear rate is landing where expected. A coach analyzing how their riders stack up. A parent curious about the data. A serious spectator who wants to understand WHY a class played out a certain way.

All of them are **thinking, not reacting.** They want numbers, comparisons, distributions. They're willing to read.

### Primary user questions the page must answer

1. **What's the difficulty of this course?** (Gauge: easy / moderate / technical / challenging / severe.)
2. **What's the clear rate?** (Expected clears vs actual — did the designer hit their target?)
3. **How did R1 play out — what's the fault distribution?** (0 / 4 / 8 / 12+ counts.)
4. **Who's in the JO, and how far apart are they?** (Gap-to-leader column.)
5. **If I missed the class, how close were the fast rounds?** (Fastest clear, avg round time.)

Notice: none of these are "live" questions. They're analysis questions. The page's job is to make the math self-evident.

### How the page should feel

- **Patient.** The page doesn't refresh every second like live.html. It loads the computed stats, shows them, and waits. (Exception: live-strip at top updates in real-time if the class is currently running.)
- **Dense but scannable.** Lots of numbers, arranged in small cards so the eye can jump around.
- **Honest.** The course difficulty gauge can say "severe" or "easy" and that's meaningful feedback for a course designer. Don't soften.
- **Visual, not just numeric.** The difficulty gauge is a semicircle (glanceable). The fault distribution is bars (comparable). The standings gap is color-coded (green fast, amber slow, red DQ).
- **Collapsible depth.** OOG table is hidden by default — most users want stats, not OOG. Click to expand if needed.

### Key visual decisions (preserved in v3)

- **Live-strip at top.** If the class is currently running, the top of the page has a mini on-course card with clock. Gives operators the live context while they analyze the already-completed rounds below.
- **Course difficulty gauge.** Semicircle SVG, colored arc (green / amber / red), needle at score 0-10, label below ("Moderate", "Technical", "Severe"). Instantly communicates "is this course fair."
- **Fault distribution as cards + bars.** Cards show counts per fault bucket (0, 4, 8, 12+, eliminated). Bars show the proportions below. Both together because one is a count and one is a shape.
- **Gap column.** Most underrated design choice on the page. For each standings row: "Leader" for 1st, "+1 flt" if more faults, "+0.5s" if fewer faults but slower, or "vs TA +3.2s" if the round has TA. Tells you instantly whether a rider is close to or far from the leaders.
- **Per-round separation.** R1 standings and JO standings are shown as separate sections with their own fault distributions. Honors the "rounds are semantically distinct" principle from the jumper methods reference.
- **Multi-ride rider call-outs.** Summary section lists riders with multiple entries in this class. Useful for spotting who has a backup horse.

### How v3 changes the delivery (NOT the experience)

Under v2, the page polls `/getResults` which pulls from D1 and computes stats at query time. For large classes, this is expensive. The "difficulty gauge" and "fault distribution" are computed from raw entries on every load.

**Under v3:**
- **Rollup tables** (per DATABASE-SCHEMA-EXPANSION.md) pre-compute class summary stats (`class_summary_stats` table). Loading the page reads one row, not 40 entries.
- **Live-strip uses WebSocket push** for the active class. Same mini on-course card shape, same clock, but real-time.
- **Historical comparisons become possible.** With canonical rider/horse identity and season rollups, stats.html can show:
  - "This rider's season record in 1.30m jumpers: 14 wins, 8 top-3."
  - "This horse's fastest 1.30m clear this year: 45.2s."
  - "This class's difficulty score vs the 1.30m circuit average: +1.8 (harder)."
  - Those are NEW capabilities, not rework of existing features.

**What the analyst notices:** pages load faster. Historical context appears where previously only the current class was shown. Live-strip feels more responsive during an active class.

**What the analyst doesn't notice:** the stats computation moved from per-request to rollup-cron. The visual presentation is identical.

### What will change structurally in v3

- **Stats module split.** `WEST.stats.live.*` (sync, computed from current state) for the live-strip and class-summary cards. `WEST.stats.history.*` (async, fetched from rollup endpoints) for the new historical context features.
- **Pre-computed rollups.** `class_summary_stats`, `show_summary_stats`, `rider_season_stats`, `horse_season_stats`, `class_leaderboard` — all populated by cron. Page reads rollup rows, not raw entries.
- **Course difficulty gauge becomes a rollup field.** Currently computed on-page from raw results. In v3, the rollup stores the score, saves re-computation, allows trending ("this course was 6.2 last year, 5.8 this year").
- **Gap column gets smarter.** With historical data, v3 can show "+0.5s (typical 1.30m gap at this venue)" — contextualizing whether a gap is big or small.
- **No changes to the visual language.** Fault cards, difficulty gauge, standings tables, gap column all look identical. Just populated from faster sources.

### Pitfalls to avoid in v3 implementation

- **Don't make it a real-time dashboard.** Stats are meant to be stable. Only the live-strip is real-time. Re-rendering the difficulty gauge on every event would be distracting and pointless.
- **Don't hide the difficulty gauge.** Some users might feel it's "too opinionated." It's the single most-loved feature on the page. Keep it prominent.
- **Don't collapse the OOG by default on desktop.** On mobile yes, but desktop screens have room. Let the user see more without clicking.
- **Don't remove the gap column.** It's subtle but indispensable for understanding class shape.
- **Don't over-expand historical stats.** Adding "this rider's career win rate" in every row would drown the page. Historical data goes in a sidebar or expandable row, not inline.
- **Don't let the live-strip dominate.** It's at the top for context — if it grows to take half the page, the analytical intent is lost. Max ~10% of vertical space.

---

## HOW THESE THREE PAGES RELATE TO EACH OTHER

The three pages form a **temporal triad**:

- **Live = the present.** Mobile, immediate, what's happening right now.
- **Display = the broadcast.** Big screen, authoritative, showing the room what's happening.
- **Stats = the reflection.** Laptop/tablet, analytical, understanding what happened and what it means.

Together they cover every mode a human engages with a horse show:
- "Am I paying attention right now?" → live
- "Am I showing others what's happening?" → display
- "Am I understanding what just happened?" → stats

**v3 preserves this triad.** The push architecture changes how data reaches each page, but each page's role in the triad is unchanged. Don't merge them, don't generalize them, don't let one bleed into another.

Live gets the mobile-first spectator treatment. Display gets the big-screen broadcast treatment. Stats gets the analytical density treatment. Three pages, three intents, three delivery cadences — all subscribing to the same underlying WebSocket stream, each rendering it for its own audience.

---

## FOR v3 BUILDERS

Before writing any code for live.html, display.html, or stats.html in v3:

1. Re-read this doc's "Intent" section for the page you're building.
2. Open the v2 version in a browser (root-level file) and note what the page currently does.
3. Confirm the user questions your v3 implementation will answer in ≤3 seconds.
4. Confirm no visual decisions are being changed "because we can now that it's modular."
5. Only then start writing.

And when someone proposes a visual change that feels like a good idea:
- Does it help answer one of the primary user questions faster? → maybe.
- Does it feel modern/clean/minimal? → not sufficient reason.
- Does it change the color, size, or position of the clock? → stop. Ask Bill.
