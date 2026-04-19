# Live-Action Pages UI Spec — v3
### Detailed structural inventory of live.html, display.html, results.html, stats.html

**Purpose:** preserve v2 layout + look-and-feel for v3. These four pages are the user-facing soul of the product — spectators, operators, scoreboard displays, analysts. v3 must preserve their feel exactly while modernizing internals (push architecture, shared modules). Sibling doc: `PUBLIC-PAGES-UI-SPEC.md` (index/show/classes). Related: `PAGE-INTENT.md` for design philosophy, `ADMIN-UI-SPEC.md` for admin page.

---

## 1. LIVE.HTML — Spectator View (Mobile-First)

### Page purpose
Live spectator view for watching a class in progress on mobile/tablet. Shows on-course entry with real-time clock, live standings below, and recently-completed classes at bottom. Optimized for mobile (56px sticky header, no max-width constraint), with adaptive landscape/portrait support.

### Layout / page structure

- **Sticky Header (56px)** — Black background with 3px red bottom border. Left: back button + "Classes" text. Right: WEST logo + product name (hidden <480px).
- **Class Info Bar (white)** — Class number (red, DM Mono 11px), class name (Playfair Display 22px, bold), sponsor/type below (muted DM Mono). Margin-collapsed.
- **On-Course Block (white, 3px red bottom)** — Full-width, 2-column grid. Left card: entry #, horse name, rider. Right card: clock (42px DM Mono, gold when running, red if overtime), round label, phase label.
- **Progress Bar (white)** — "N of M competed" + percentage, thin green fill.
- **Standings Section (white, scrollable)** — Header row (place / entry / faults / time), multiple rows, alternating light gray.
- **Recent Results (white, 3px red top)** — Class completion cards with top 3 entry previews, timestamps (e.g. "2m ago").
- **Footer (black)** — WEST branding + links.

### Every control & section

1. **Back Button** — Left-aligned, SVG arrow + "Classes" text. DM Mono 12px. White, hover red. Min 44x44 touch target.
2. **Live Pill (header)** — Red background, white blinking dot + "Live" text. DM Mono 10px, uppercase. Only visible if watcher alive + class active.
3. **Class Bar** — Playfair Display class name (22px, 700wt) is the visual anchor. Subheader shows sponsor/trophy in muted DM Mono 10px.
4. **On-Course Card (left)** — Light gray background (--off-white), rounded 6px. Shows entry # (red DM Mono 13px), horse (16px bold), rider (14px muted). Padding 12-14px.
5. **Clock Card (right)** — 42px DM Mono mono-weight font, bold. Color logic:
   - Black when stopped (INTRO)
   - Gold when running or countdown
   - Red when overtime
   - Muted when paused/error
   - Ticks every 100ms, auto-updates time faults.
6. **Round Label** — Small red DM Mono 11px, uppercase, bold. Appears above clock if applicable (e.g. "R1", "JO").
7. **Phase Label** — Muted DM Mono 10px, uppercase. Shows "On Course", "Finished", "Countdown", "Intro", etc.
8. **Fault Display Table** — Under clock when on course. 3-column grid (Jump / Time / Total) with numeric values (16px). Total cell is red. Hidden during non-jumper phases.
9. **Standing Row** — Flex layout: place (32px), bib (40px, monospace red), horse/rider (flex 1), faults/time cols. Alternating white/off-white. Hover darkens.
   - **Place Column** — Playfair Display 14px, bold. Ellipsis dash if eliminated.
   - **Entry Bib** — Monospace 10px, inline-flex, light border, small radius.
   - **Horse/Rider** — 14px/12px on separate lines. Truncate if long. Breeding/owner below (11px italic muted) for hunters.
   - **Faults** — DM Mono 13px right-aligned. Green if clear (0), else muted. For hunters, shows score instead.
   - **Time** — DM Mono 12px muted right-aligned.
10. **Progress Bar** — Thin horizontal bar, gray bg, green fill, smooth 0.5s transition.
11. **Recent Results Card** — Link-style row with:
    - **Class number** — Bold red DM Mono 13px.
    - **Class name** — 16px black, flex 1.
    - **Timestamp** — Muted DM Mono 11px ("2m ago", "just now", "15m ago").
    - **Arrow** — 20px muted, right-aligned.
    - **Preview rows below** (3 results) — Ribbon + name + score, smaller font (13-15px).
12. **No Live State** — Centered message: gray icon, Playfair Display h2, muted text, link to schedule.

### Visual design patterns

- **Typography Chain** — Playfair Display for class names (serif, strong presence), DM Mono for all labels/numbers (machine precision), Source Sans 3 for body text.
- **Color Semantics**:
  - Red (#b82025) = active, fault, on-course, urgent
  - Green (#2e7d32) = clear, healthy metric
  - Gold = (not used on live.html, reserved for display.html)
  - Muted gray = secondary info, disabled
- **Spacing** — 12-16px padding blocks, 6px gutters in cards. 8px gaps in flex rows.
- **Cards** — 6px border-radius, no shadow (flat design). Light gray background = secondary info.
- **Monospace** — All numbers and timestamps monospace for scannability.

### Data flow

- **Poll Source** — `/getLiveClass` endpoint (Worker).
- **Cadence** — 1s active (class live), 10s idle. Adaptive for mobile (Save-Data, slow networks).
- **KV Keys Polled** — `ring:{ring}:onCourse` (on-course entry + phase), `ring:{ring}:selected` (selected class), `ring:{ring}:activeClasses` (list of live classes), `ring:{ring}:classData:{classNum}` (entry standings).
- **D1 Data** — Computed entries with place, score, r1Total, r2Total, statusCode.
- **Watcher Offline** — Display stale standings with amber banner ("WATCHER OFFLINE — clock frozen until connection restores").
- **Heartbeat Clock** — Poll loop calls `WEST.applyHeartbeatClock(liveData.heartbeatClock)` to sync server time before ticking locally.

### Responsive behavior

- **Mobile (<480px)** — Hide logo brand in header. Max width none. Full viewport bleed. Touch targets 44x44.
- **Tablet (768px+)** — Padding increases via `clamp(16px, 4vw, 48px)`. Class bar font bumps to 26px.
- **Portrait** — Natural layout.
- **Landscape** — On-course grid may stack if space tight, but usually side-by-side.

### Animations & real-time feel

- **Clock Ticking** — 100ms granularity. Updates DOM directly, no re-render.
- **Time Fault Calc** — Live on-course: faults = ceil((elapsed - TA) / TI) * FPI, updates in real-time.
- **Fault Fire** — When entry receives first fault, row text flickers (red pulse).
- **Progress Bar Fill** — Smooth 0.5s ease transition as percentage updates.
- **Blink Animation** — Live pill blinks (opacity 1 → 0.25, 1.6s cycle) when watcher alive.
- **No animation** — Standings rows fade-in on entry (no CSS class needed, pre-rendered HTML).

### Notable UX choices

1. **On-Course Dominance** — Two large cards above standings, visual hierarchy makes current entry unmissable.
2. **Clock Size** — 42px mono font (match display.html 56px in full scale, match stats.html 28px). Ticks every 100ms (smooth not jerky).
3. **Phase Labels** — Spelled out ("On Course", "Countdown") not abbreviations, readable at a glance.
4. **Recent Results Separate** — Completed classes (winners) shown below live standings, not mixed in. Shows recent completions with top 3 preview + link to full results.
5. **Fault Table Optional** — Only renders when on-course and jumper. Hunters don't show table.
6. **Watcher Alive Indicator** — Live pill hidden if offline. Page goes gray, clock frozen, no misleading live badge.

### Empty / loading / error states

- **No Active Class** — Centered message with icon + "No Class in the Ring" + schedule link.
- **Loading** — Spinner (28px border-top red) + "Connecting..." label.
- **Watcher Offline** — Amber banner (--red left border) top of page, standings hold last known state, clock frozen.
- **Class Complete** — Card moves to "Recent Results" after watcher marks CLASS_COMPLETE.
- **Network Lost** — Re-connects on next poll cycle (adaptive backoff 1s → 10s).

### Keyboard / accessibility

- **Tab Order** — Back button → logo → standings rows.
- **ARIA** — No live regions (content renders static). Aria-label on back button.
- **Color Contrast** — All text >=4.5:1 (black on white, white on red, muted gray on white).
- **Touch** — Min 44px targets. No hover-only info.

---

## 2. DISPLAY.HTML — Scoreboard / Show Operator Display (Big Screen)

### Page purpose
Operator-focused scoreboard display for the ring (typically 1920x1080+ TV/monitor). Shows live standings, on-course entry detail in sidebar with live clock, order of go (OOG) on left, and auto-scrolling standings in center. Designed for fixed-height, no-scroll viewing. High contrast dark theme for visibility across gymnasium lighting.

### Layout / page structure

- **Top Bar (90px)** — Two rows. Row 1: WEST logo + class number + class name (left-aligned). Row 2: Type/TA/trophy specs (left), progress counter (right). 3px red bottom border.
- **3-Column Main Grid** (calc(100vh - 90px), fixed height, no scroll):
  - **Left Panel (200px)** — Order of go list (scrollable), dark background. "Up Next" or "Competed".
  - **Center** — Standings grid (scrollable), auto-scrolls: hold-top 80 ticks → scroll down 2px/50ms → hold-bottom 100 ticks → jump-top, loop.
  - **Right Sidebar (380px)** — On-course card (current entry, clock, faults grid), finished card (if phase=FINISH), previous entry, judge cards (if multi-judge hunter).
- **Sticky Headers** — OOG "Up Next", Standings headers stay top on scroll. Sidebar sections stack scrollable.

### Every control & section

1. **Top Brand Bar** — White on dark: WEST logo (inverted) + "WEST | Scoring.Live" in gold (Playfair 18px, DM Mono 11px).

2. **Class Number & Name** — Playfair Display 32px bold, white. Name in 18px muted below (single-line, ellipsis if long).

3. **Type Badge** — Jumper / Hunter / Equitation label. If two-phase, shows "Method X". Color white.

4. **TA / Trophy / Sponsor** — DM Mono 14px muted. Sponsor/trophy in gold if present.

5. **Competed Counter** — Top right. White number (13px 600wt) + "COMPETED" label (9px muted) + slim progress bar (120px wide, green fill).

6. **OOG List (left panel)**
   - **Header** — "Up Next (N)" or "Competed (N)", DM Mono 9px muted bold.
   - **Row** — Flex: order number (18px center) | horse (flex 1, 12px bold white) | rider (10px muted). Padding 7px 10px. Faint separator.
   - **On-Course Row** — Gold left border, gold highlight background. Indicates who is currently running.
   - **Done Row** — Opacity 0.35, indicate finished.
   - **Scrollable** — Flex: 0 0 auto or flex: 1 depending on remaining/competed split.

7. **Standings Header Row** — Flex-based columns: Place (42px) | Entry # (48px) | Horse/Rider (1fr) | Results (depends on class type). Sticky top, dark bg. Font: DM Mono 10px muted uppercase.

8. **Standing Row** — Same flex columns. Dark alternate rows (--highlight = rgba(251,191,36,0.12)). On-course row: gold left border + gold highlight.
   - **Place** — Playfair Display 24px bold, white. 1st/2nd/3rd get gold/silver/bronze color.
   - **Entry #** — DM Mono 13px bold red.
   - **Horse/Rider** — 16px white bold. Rider secondary in 16px muted. For equitation: rider primary, horse secondary.
   - **Breeding** — DM Mono 11px dark gray (low contrast, intentional).
   - **Owner** — 12px muted italic.
   - **Results Column** — Varies by class:
     - **Jumper Single-Round** — Display `WEST.jumper.renderRoundsBlock`: R1 label + faults + time, stacked vertical.
     - **Jumper Multi-Round** — R1/R2/JO rows (if method 2/3/9/11). Optimum time difference in green if close.
     - **Hunter Multi-Judge** — Judge grid (compact: show combined score row only on display, full grid in sidebar). Derby entries show judge cards.
     - **Hunter Single-Judge** — Score (DM Mono 15px bold) for each round, combined on bottom.

9. **Sidebar Cards**
   - **Current (On Course / Intro / Countdown)** — Background: gold highlight, subtle border. Padding 16px.
     - Entry # (22px bold red)
     - Horse (24px 700wt white)
     - Rider (16px muted)
     - **Clock** — 42px DM Mono bold, gold color.
     - **Phase Label** — Small DM Mono 10px muted. "IN GATE", "COUNTDOWN", "ON COURSE", "PAUSED" (red).
     - **Faults Grid** — 3 columns (Jump / Time / Total). Font 24px 600wt white. Total column green if clear.
     - **Rank Display** — If available, "RANK 1" in 28px gold bold below faults.
   - **Finished Card** — Same size/padding, but no clock. Shows final score, judge grid if multi-judge (compact), "Finished" label.
   - **Previous Entry** — Scaled 0.75 (22px entry, 24px*0.75=18px name, etc.). Opacity 0.9. Gray border. Read-only (for operator reference).
   - **Judge Cards Section** — If multi-judge hunter, shows stacked judge leaderboards (top 10 per judge). Grid: # | Entry | R1/R2/R3 scores | Total. Scrollable flex section.

10. **No Class State** — Centered logo + "Waiting for class..." in 14px muted DM Mono.

11. **Status Indicators** — Elimination rows opacity 0.5. WD/RT/EL in red in place column. Color semantics match live.html.

### Visual design patterns

- **Dark Theme** — Background #0a0e1a, card #111827, gold #fbbf24 for accents. High contrast for gymnasium glare.
- **Playfair Display** — Class name (serif), place numbers (serif large bold).
- **DM Mono** — All labels, times, numbers. Font-weight 400/500/600 for hierarchy.
- **Gold Accents** — Active entries, current on-course row, rank, 1st place, sponsor.
- **Color Ladder**:
  - Gold = currently on-course / active / 1st place
  - Green = clear round / optimum time close
  - Red = fault / time fault / status code
  - Muted = secondary info / finished competitor
- **Cards** — 6-8px border-radius, 1px border in gold (--border or gold semi-transparent).
- **Spacing** — 16-24px section padding, 8-12px gaps.

### Data flow

- **Poll Source** — `/getLiveClass` endpoint.
- **Cadence** — 1s when active (watcher alive), 10s baseline. Displays cache last render if no new data (sessionStorage).
- **Computed Data** — Worker pre-computes entries with place, combined score, judge grid data, multi-round breakdown.
- **KV Keys** — Same as live.html. Additionally caches `display_last` in sessionStorage for offline fallback.
- **Adaptive Cadence** — `WEST.getPollInterval(active, 1000, 10000)` dials based on network/Save-Data flags.

### Responsive behavior

- **Fixed Layout** — height: 100vh, overflow: hidden. No responsive breakpoints; design assumes 1920x1080 minimum.
- **Tall Screens** — Sidebar may overflow; judge cards section scrollable.
- **Wide Screens** — OOG left panel gets more room. Standings center is flexible 1fr.
- **Landscape Only** — Designed for landscape. Portrait would stack awkwardly.

### Animations & real-time feel

- **Auto-Scroll Standings** — Hold top 80 ticks (4s) → scroll 2px per 50ms tick → hold bottom 100 ticks (5s) → jump to top, repeat. Creates gentle "news ticker" effect, keeps all finishers visible without manual scroll.
- **Clock Ticking** — 100ms tick granularity. Color shifts gold → red when overtime. Smooth no jitter.
- **Live Fault Calc** — Sidebar on-course card: time-faults update live on-course, jump faults static.
- **Judge Cards Auto-Scroll** — Slower cadence than standings (120 vs 80 ticks hold-top), separate scroll state.
- **Highlight Pulse** — On-course row in standings: gold left border + gold bg, no pulse but high visual pop.
- **Ring Auto-Cycling** — Class can be overridden by operator; display follows selected class (not just first active).

### Notable UX choices

1. **Three-Column Layout** — OOG on left (tell operator who's next), standings center (main focus), sidebar (deep detail). Allows spectator-facing TV to show center column only via cropping.
2. **Auto-Scroll Standings** — No operator interaction needed. Operator can watch judge cards or sidebar, standings "scroll past" like scoreboard tape. Solves "too many entries to fit on screen" problem.
3. **Gold for Active** — Gold (not red) is the "hot" color on display.html (vs red on live.html). Feels less aggressive for TV broadcast.
4. **Sidebar Scaling** — Current entry large (42px clock), previous entry small (0.75×), judge cards tiny text. Visual hierarchy emphasizes what matters now.
5. **Judge Cards Grid** — Uses CSS Grid, not table. Compact layout (20px # | 1fr entry | 56px per round | 44px total). Fits more judges horizontally.
6. **Preserve Scroll Position** — Standings + judge cards remember scroll on re-render (sessionStorage). Operator doesn't jump to top.
7. **Ring Selector Implicit** — Selected class drives the display. Operator switches in Ryegate; display auto-updates via KV "selected" field.

### Empty / loading / error states

- **No Active Class** — Centered logo, "Waiting for class..." DM Mono 14px muted.
- **Class Loaded Cached** — If network fails, displays last render (sessionStorage 'display_last').
- **Watcher Offline** — No visual indicator (assumes display is for operator who sees Ryegate status).
- **Slow Network** — Poll backs off to 10s. Display stales gracefully.

### Keyboard / accessibility

- **No Keyboard Input** — Designed for ring operator with mouse/touchscreen, not keyboard.
- **High Contrast** — Dark bg + white/gold text, >=7:1 contrast for gymnasium lighting.
- **Tab Order** — Not applicable (display-only).
- **Color Blindness** — Gold + white (not red) for active. Symbols (place number size) reinforce rank 1/2/3.

---

## 3. RESULTS.HTML — Final Results Archive (Laptop/Tablet)

### Page purpose
Post-class archive view showing full final standings, ribbons, individual entries, and multi-judge judge grids. Accessible from live.html recent-results cards and standalone via class picker. Mobile-responsive but optimized for ≥768px (tablet). Shows all placement data, breedings, prizes, per-judge scores.

### Layout / page structure

- **Sticky Header (56px)** — Black + 3px red border. Left: back button. Right: WEST logo.
- **Breadcrumbs (40px)** — White background, 1px border. Grid icon / "All Shows" > Show > Class. Horizontally scrollable on mobile.
- **Title Bar** — White. Class number (red DM Mono 11px) | Class name (Playfair 22-26px) | Type/sponsor badges below. "View Judges Cards" toggle if multi-judge hunter. "Stats & Analysis" button if jumper.
- **Live Banner (if active)** — White, 3px red bottom. Red blink dot + "Watch Live — On Course & Standings" + arrow. Links to live.html.
- **Content Sections** — Each entry is a result-entry card:
  - **Ribbon** — SVG or place number (Playfair 14px).
  - **Horse/Rider** — Bib number (DM Mono 10px monospace, light border), horse (15px 600wt), rider (13px muted), breeding/owner (11px italic muted), flags.
  - **Scores** — Stacked rows: "R1: 32 (4), R2: 28 (2)" for jumpers. "Score: 85" for hunters.
  - **Status Codes** — "RT", "WD", "EL" in red if applicable.
  - **Multi-Judge Expando (hunters)** — Closed by default. Click to expand judge grid showing per-judge per-round breakdown. Open state: red "▾" chevron, light pink bg, grid of scores.
- **Remaining OOG** — "Remaining (N)" section below results if class still live. Show "On Deck" + "-1, -2" pending riders. Low-priority visual.
- **Footer (black)** — WEST branding + links.

### Every control & section

1. **Back Button** — SVG arrow + "Classes" / "Results" (context-aware). White, hover red. DM Mono 12px. Min 44x44.
2. **Breadcrumb Nav** — Home icon / "All Shows" > show name > "Class N". Horizontal scroll on mobile. Red hover states. DM Mono 11px.
3. **Result Entry Card** — Block element. White bg, bottom border 1px gray. Alternating light gray. Padding 12-16px. Flex or grid depending on entry type.
4. **Ribbon / Place** — Left column, 32px wide. Playfair Display 14px bold black. SVG ribbon if 1st/2nd/3rd + not-live. Otherwise just number. Prize money below ribbon (green DM Mono 10px, "$1,200") when not live.
5. **Entry Info Section** — Flex 1. Bib number (inline-flex, 40px, border, light bg). Horse primary (15px 600wt). Rider secondary (13px muted, separate line). Breeding (11px italic muted, indented 38px). Owner (12px italic aa, indented 38px). Country flag inline if applicable.
6. **Scores Column** — Right-aligned. Minimal width 70px.
   - **Jumper Rounds** — Display via `WEST.jumper.renderRoundsBlock()` (universal across live/display/results). Stacked rows: "R1 8 faults 45.2s", "R2 0 faults 42.1s". Labels (9px gray), values (13px body), green if clear. Status code if applicable.
   - **Hunter Scores** — Primary score (14px red 600wt), secondary label (9px gray). Per-round shown stacked.
7. **Judge Expand Button (hunters)** — Inline-flex pill: "▸ View Judges Scores" (9px gray DM Mono, light border, light bg). On open: "▾", red text, pink bg.
8. **Derby Expand Panel** — Below result-entry. Hidden by default. Shows:
   - Per-judge per-round breakdown (math like "J1: 85 + 2 = 87 [2nd]").
   - Summary: "SPLIT DECISION" pill if judges disagreed.
   - Per-judge card totals (for derby).
9. **Order of Go Section** — Below results if class still live. Heading: "Order of Go" | "Remaining (N)" (DM Mono 10px, border-bottom black 2px). Entry rows: order # | bib | horse | rider. Muted colors (class in progress, not final).
10. **Live Banner** — Sticky, appears when class is selected + active in live poll. White bg, red 3px bottom. Icon (red blink dot) + "Watch Live — On Course & Standings" + arrow (red 18px). Full-width. Links to live.html?slug=…&classNum=….
11. **Stats Button** — Appears if jumper + (OOG or results). Link to stats.html. DM Mono 10px, border, muted. Hover: black border + black text.
12. **Judges Button (hunter)** — Toggle between combined view + per-judge grid view. DM Mono 10px, border. Active state: black bg + white text.
13. **Split Decision Pill** — Red bg, white text, DM Mono 10px 600wt, uppercase. Inline after judges button. Appears only if multi-judge + judges disagreed on final placement.

### Visual design patterns

- **Typography** — Playfair Display for place/ribbon (serif, formal), DM Mono for all labels/numbers, Source Sans 3 for entry text.
- **Color Semantics**:
  - Red = fault, status code, active badge, link hover
  - Green = clear round (0 faults)
  - Muted = secondary (rider, scores), disabled
  - Light gray = alt row, border
- **Cards** — 1px border bottom, flat (no shadow). Padding 12-16px. Alternating white / #fafafa.
- **Monospace Numbers** — All scores, times, fault counts. DM Mono 400/500 for readability.
- **Indentation** — Breeding, owner, locale indented 38px (aligns under entry # + horse name). Visual grouping.

### Data flow

- **Source** — `/getResults` endpoint. Pre-computed entries (worker) or legacy D1 join.
- **Cadence** — Single load on page enter. No polling (static archive).
- **Computed Shape** — Each entry has place, r1Ranks (per-judge per-round scores if multi-judge), statusCode, round breakdowns.
- **D1 Fallback** — If no computed entries, parse cls_raw + build entries locally using `WEST.hunter.derby.buildEntries()` or `WEST.jumper.renderRoundsBlock()`.

### Responsive behavior

- **Mobile (<480px)** — Hide logo in header. Breadcrumb scrolls. Result cards stack: ribbon top, info below, scores right-aligned.
- **Tablet (768px)** — Logo visible. Breadcrumb wraps. Result cards normal layout.
- **Desktop (1024px+)** — Max-width 1280px center. Generous padding via clamp.

### Animations & real-time feel

- **Judge Grid Expand** — Click entry → classList.add('open') on card. Derby-expand panel fades in (no explicit CSS, relies on display:none/flex toggle).
- **Recent-Completed Fade** — No explicit animation; entries rendered static HTML. But in live view, new results fade in as they come off course (handled by live.html, not results).
- **No Scroll Animation** — Page loads to top. No anchor navigation.

### Notable UX choices

1. **Place Ribbons** — SVG ribbons (if 1st/2nd/3rd and not live). Playfair Display number fallback. Visual candy reinforces place.
2. **Judge Expand Optional** — Multi-judge entries expandable inline. Don't clutter initial view with all per-judge data. Click to reveal.
3. **Indented Breeding/Owner** — Create visual "tree" hierarchy. Eye traces down from horse → rider → breeding → owner naturally.
4. **Split Decision Badge** — Red pill appears on multi-judge cards where judges disagreed on final rank. Operator / spectator awareness.
5. **Live Banner Persistent** — If class still live, banner sticks to results page. Spectator can switch between live + results without navigation.
6. **Order of Go Below** — Pending entries shown at bottom (not at top). Spectators care most about results; OOG is supplementary.
7. **Status Codes Centralized** — RT/WD/EL logic in `WEST.jumper.getStatusDisplay` / `WEST.hunter.getStatusDisplay`. Same rules live/display/results.

### Empty / loading / error states

- **Loading** — Spinner (28px) + "Loading Results..." label (DM Mono 11px muted).
- **No Entries Yet** — "No entries found for this class." (centered, muted).
- **Class Not Found** — Spinner → error message or redirect to classes.html.
- **Order of Go Only** — No results yet, show "Order of Go" section. Hide "Remaining" if class complete.

### Keyboard / accessibility

- **Tab Order** — Back button → title → judge buttons → result entries (clickable) → footer links.
- **ARIA** — Aria-label on expand buttons. Result entries role="button" or <a> for click.
- **Color Contrast** — >=4.5:1 (black on white, white on red, muted gray on white).
- **Touch** — Result entries clickable (toggleable on mobile), min 44px height.

---

## 4. STATS.HTML — Analysis & Preview (Laptop/Tablet, Jumper Only)

### Page purpose
Analytics dashboard for jumper classes. Pre-show mode (OOG + entry preview + country breakdown). Live mode (live-strip + order of go). Post-show mode (full fault analysis, per-round metrics, course difficulty gauge, R1/JO standings with gap-to-leader). Only for jumper classes (J / T). Compact single-column layout optimized for ≥600px.

### Layout / page structure

- **Sticky Header (48px)** — Smaller than live/results. Back button ("Results") + WEST logo. Black + 3px red border.
- **Live Strip (active class only)** — White, 3px red bottom. Entry info (phase pill + entry # + horse/rider) | clock (28px) | faults grid. Hidden if no on-course data.
- **Class Info Bar** — Class number | name (16px Playfair) | badge (Type / TA) | watcher status dot (green/gray).
- **Content Sections** — Vertical stack:
  1. **Order of Go** — Collapsible table. Entry / Horse / Rider / Go # / Flag. On-course row highlighted red, next-up green.
  2. **Class Preview** (pre-show) — Entry count | unique riders | countries | country breakdown cards.
  3. **Entry Summary** (post-show) — Total entries | unique riders | countries | multi-ride riders list.
  4. **Fault Distribution R1** — Card grid (0, 1, 2, 3, 4, 5, 6, 7, 9-11, 12+, Elim). Count + label + % + bar chart.
  5. **Course Difficulty Gauge** (if >=4 starters) — Semicircle SVG gauge (easy → hard), score 0-10, label.
  6. **Course Metrics** — Grid: Finishers/Starters | Clear Rate % | Avg Faults | Fastest 4-Fault | Avg vs TA (all) | Avg vs TA (clears) | Time Fault Rate.
  7. **R2/JO Standings** (if applicable) — Table: # | Entry | Faults | Time | Gap (to leader or vs TA). Sorted by place or fault+time.
  8. **R1 Standings** — Table: # | Entry | Faults | Time | Gap. Gap column shows "Leader", "+1 flt", "+0.5s", or vs TA. JO Qualifier tags shown.
- **Footer (black)** — WEST branding + links.

### Every control & section

1. **Back Button** — SVG arrow + "Results" text. DM Mono 11px, white, min 40x40.

2. **Live Strip** (when class live)
   - **Phase Pill** — Background color-coded: green (Intro), amber (Countdown), red (On Course), gray (Finished). DM Mono 9px uppercase. Padding 2px 6px, 2px radius.
   - **Entry #** — DM Mono 10px muted. "#123".
   - **Horse Name** — 13px 600wt black. Max-width 180px, truncate if long.
   - **Rider Name** — 11px muted, max-width 160px.
   - **Clock** — DM Mono 28px 500wt bold. Gold color. Ticks live on-course.
   - **Round Label** — Small DM Mono 8px muted above clock.
   - **Faults Grid** — 3 columns (Jump / Time / Total). DM Mono 8px label, 14px value. Black text.
   - **Progress Bar** — Thin (3px) gray bg, red fill, below strip.

3. **Class Info Bar**
   - **Class Num** — Red DM Mono 10px 600wt uppercase. "CLASS 47".
   - **Class Name** — Playfair 16px 700wt black.
   - **Type Badge** — DM Mono 9px uppercase, light border, light gray bg. "Jumper" or "Method 2" etc.
   - **TA Display** — DM Mono 10px muted. "R1: 75s · R2: 80s".
   - **Entry Count** — DM Mono 10px muted right-aligned. "42 drawn".
   - **Watcher Dot** — 7px circle. Green if alive, muted if dead. Title attribute.

4. **OOG Table**
   - **Header** — DM Mono 8px muted bold uppercase, border-bottom black 2px. Go | Entry | Horse | Rider | Flag.
   - **Row** — Flex layout. Go # (32px) | Entry (40px, monospace red) | Horse (flex 1.5) | Rider (flex 1) | Flag (28px).
   - **On-Course Row** — Red left border (3px), pink/light-red bg.
   - **Next-Up Row** — Green left border, light-green bg. "Next" label in go # column.
   - **Data** — Horse name 13px 600wt, rider 11px muted, go order 11px monospace muted.
   - **Toggle** — Collapsible via "Show / Hide" button (DM Mono 9px red, no border). Defaults hidden on load.

5. **Summary Cards** — Grid: auto-fill minmax(140px, 1fr). Card: white bg, 1px border, 4px radius.
   - **Val** — DM Mono 18px 500wt black. "42".
   - **Label** — DM Mono 8px muted 600wt uppercase. "ENTRIES".
   - **Detail** — Optional line (10px muted).

6. **Fault Distribution Cards** (R1 / R2)
   - **Card Grid** — auto-fill minmax(90px, 1fr).
   - **Card** — White bg, 1px border, 4px radius. Text center-aligned.
   - **Number** — Playfair 24px 700wt. Green if "0", tan/amber if "9-11", red if "12+".
   - **Label** — DM Mono 8px muted. "CLEAR" or "4 FAULTS".
   - **Pct** — DM Mono 9px muted. "36%".
   - **Bar Chart Below** — Flex rows: label (60px) | bar (flex 1, gray bg with fill) | count | pct. Fill color matches fault severity.

7. **Course Difficulty Gauge**
   - **SVG Semicircle** — Needle from 0 (Easy) to 10 (Hard). Arc is gray bg, colored fill (green ≤3, amber 4-6, red >6). Needle angle = score/10*π.
   - **Info Section** — "Course Difficulty" label (DM Mono 8px muted) | Score (Playfair 36px 700wt, color-coded) | Label ("Easy", "Moderate", "Technical", "Challenging", "Severe"). Details below: "Target clears: 8 · Actual: 5", "Clear rate: 62% of 8 starters".

8. **Metrics Grid** — auto-fill minmax(130px, 1fr).
   - **Card** — White, 1px border, 4px radius.
   - **Val** — DM Mono 16px 500wt black. "32 / 40".
   - **Label** — DM Mono 8px muted uppercase. "FINISHERS / STARTERS".
   - **Sub** — Optional (9px muted). Extra detail.

9. **Standings Tables** (R1 / JO)
   - **Header** — Flex cols: 32px (place) | flex 1 (entry) | 48px (faults) | 64px (time) | 68px (gap). DM Mono 8px muted uppercase, border-bottom black 2px.
   - **Row** — Flex same cols. Padding 6px 10px. Border-bottom 1px gray.
   - **Place** — DM Mono 12px 500wt muted. Or status code (red) if WD/RT/EL. Or "JO" tag (green bg, white text, DM Mono 7px).
   - **Entry** — Name (12px 600wt black) | Rider (10px muted, 2nd line).
   - **Faults** — DM Mono 12px. Green if "0" (clear), muted if 1-8, red if 9+, red if status.
   - **Time** — DM Mono 11px muted. Formatted with clock_precision.
   - **Gap** — DM Mono 10px muted. "Leader", "+1 flt", "+0.5s", or "vs TA +3.2s". Green if ≤-3s (fast), amber if >0s (slow), red if status.

10. **Empty States**
    - **Not Jumper** — "Not a Jumper Class" h2 (20px Playfair) | paragraph (13px muted) | link to results.
    - **No Results Yet** — Spinner + "No results yet. Waiting for entries…"
    - **Class Complete** — Full stats render (all sections).

### Visual design patterns

- **Typography** — Playfair Display 36px for gauge score (large, important). DM Mono for all labels/numbers (machine data). Source Sans 3 for body text.
- **Color Semantics**:
  - Red (#b82025) = fault, status code, link, on-course phase pill
  - Green (#2e7d32) = clear, clears %, ≤-3s fast, alive watcher
  - Amber (#b45309) = 9-11 faults, slow (>0s), moderate difficulty
  - Muted gray (#777) = secondary labels, disabled
  - Gold = (not used in stats.html; reserved for display.html broadcast view)
- **Cards** — 1px border, 4px radius, white bg, no shadow (flat). Padding 8-12px.
- **Spacing** — 12px between sections, 8px gutters in grids, 6px row gaps in tables.
- **Monospace** — All numbers, times, entry #s. Font-weight 500/600 for hierarchy.

### Data flow

- **Load Phase** — `loadResults()` fetches `/getResults?slug=…&classNum=…`, parses entries, builds stats via `computeStats()`.
- **Live Phase** — Polls `/getLiveClass` every 1s (active) / 5s (idle), updates live-strip via `renderLiveStrip()`.
- **Live Cadence Adaptive** — If class is in live ring (liveData.selected.classNum === CLASS_NUM && watcherAlive), poll 2s. Else if class is active, poll 15s. Else 2min.
- **Result Cadence** — 2s when class live, 15s active, 120s idle.
- **Computed Data** — Worker pre-computes r1WithGap, joWithGap, fault buckets, stats (clears, avgFaults, etc.), course difficulty.
- **D1 Fallback** — If no computed data, parse cls_raw (CSV) to extract TA and OOG. Process rawEntries locally.

### Responsive behavior

- **Mobile (<600px)** — Fault grid 3 columns. Metrics grid 2 columns. Summary grid 2 columns. OOG table hidden by default (collapsible).
- **Tablet (600-1024px)** — Fault grid auto-fill. Metrics grid auto-fill minmax(130px, 1fr) = 2-3 cols. Summary wider.
- **Desktop (1024px+)** — Max-width 960px center. Full grid layouts. All sections visible.

### Animations & real-time feel

- **Live Clock Ticking** — 100ms granularity. Updates on-course #/horse/rider in real-time.
- **Time Faults Calc** — Live strip: faults = ceil((elapsed - TA) / TI) * FPI, recalc every 100ms.
- **Progress Bar Smooth** — Thin red bar at bottom of live-strip, smooth fill transition.
- **No other animations** — Stats tables, fault cards, gauge are static on load. No polling-induced flicker.

### Notable UX choices

1. **Collapsible OOG** — Table hidden on load (most users care about stats, not OOG). Click "Show" to expand.
2. **Course Difficulty Gauge** — Semicircular SVG, not bar. Gauges feel more "at a glance" than bars. Color + needle angle + label redundancy for accessibility.
3. **Gap Column Logic** — Clever display: "Leader" for 1st, "+1 flt" if more faults, "+0.5s" if fewer faults (time tiebreaker), "vs TA +3.2s" if round has TA. Operator quickly grasps course difficulty.
4. **JO Qualifier Tag** — Green pill on R1 standings rows where faults = min (qualifiers to JO). Operator sees at a glance.
5. **Status Code Rows Dimmed** — Opacity 0.72, don't sort them to bottom. Operator sees "rider didn't finish" inline with others.
6. **Fastest 4-Fault Card** — Metric card with horse + rider sub-text. Stand out even if there's only one 4-fault.
7. **Multi-Ride Summary** — "Multi-Ride Riders" list with horse names. Operator can spot riders with multiple entries.
8. **Live Strip Phase Pill** — Background color (not text color) indicates phase. Glanceable even from distance.

### Empty / loading / error states

- **Loading** — Spinner (24px) + "Loading Statistics..." (10px muted DM Mono).
- **Not Jumper** — Large h2 "Not a Jumper Class" + paragraph explaining. Link back to results.
- **No Results Yet** — "No results yet. Waiting for entries..." (centered state-box).
- **Network Error** — "Error loading data. Try refreshing." (centered state-box).
- **Class Complete** — Full stats render including course difficulty gauge (only shown ≥4 starters).

### Keyboard / accessibility

- **Tab Order** — Back button → class info → OOG toggle button → live strip (if active) → content sections → footer links.
- **ARIA** — Toggle button has aria-expanded. Watcher dot has title="Watcher connected/offline".
- **Color Contrast** — >=4.5:1. Gauge uses green/amber/red + numeric score (not color-only).
- **Touch** — OOG collapsible via large button (40px min), live strip read-only (no interaction).

---

## SHARED LIVE-DISPLAY VOCABULARY

These components/patterns appear across live.html, display.html, results.html, stats.html and must maintain consistent visual/functional identity in v3:

### 1. Phase Pill / Phase Label
- **Location** — Live strip (top of stats.html), on-course card (display.html sidebar), phase label (live.html).
- **Display** — DM Mono 9-10px uppercase, bold.
- **Background** — Color-coded: green (INTRO), amber (CD/Countdown), red (ONCOURSE), gray (FINISH).
- **v3 Preservation** — Font, size, colors, all 4 phases, background not text color.

### 2. Clock Display
- **Live** — 42px DM Mono 500wt bold, gold when running, red overtime.
- **Display** — 42px (same size, scales to 56px on tablet via clamp).
- **Stats** — 28px DM Mono 500wt (smaller for live-strip, space-constrained).
- **Ticking** — 100ms granularity. Real-time faults calculated live on-course.
- **v3 Preservation** — Font family, color logic (gold/red), tick rate, time-faults formula.

### 3. On-Course Card
- **Components**:
  - Entry # (red DM Mono 13-22px depending on context)
  - Horse/Rider name (16-24px depending on context)
  - Clock (42px)
  - Round label (red uppercase 11px)
  - Phase label (muted uppercase 10px)
  - Faults grid (3-column: Jump / Time / Total, green if clear)
- **Layout** — Flex column, centered. Card background light gray (light theme) or gold highlight (dark theme / display.html).
- **Styling** — 6px radius, padding 12-16px.
- **v3 Preservation** — All sub-components, colors, layout flex-column-center, card shape.

### 4. Standing Row
- **Components**:
  - Place (Playfair 14-24px, color-coded 1st/2nd/3rd on display.html)
  - Entry bib (DM Mono 10px, inline-flex, border, light bg)
  - Horse/Rider (15-16px bold / 12-13px muted on separate lines)
  - Faults (DM Mono 11-13px, green if clear)
  - Time (DM Mono 11-12px muted)
  - Status codes (red, uppercase) if applicable
- **Layout** — Flex horizontal, gap 8px. Entry info flex 1. Scores right-aligned.
- **Styling** — 1px bottom border, alternating white / light-gray bg. Hover darkens on results.html.
- **Multi-Judge** — Judge grid renders inline via `WEST.hunter.renderJudgeGrid()` (stacked rows per judge per round).
- **v3 Preservation** — All sub-components, fonts, colors, flex layout, alternating rows.

### 5. Fault Display Logic
- **Color Semantics**:
  - 0 faults = green (#2e7d32) "CLEAR"
  - 1-8 faults = muted gray
  - 9+ faults = muted (amber in stats.html context, optional)
  - Status code (WD/RT/EL) = red
- **Decimal Precision** — Times formatted via `WEST.formatTime(val, clockPrecision)`. Clock precision 0 (no decimals) to 2 (hundredths).
- **v3 Preservation** — Color logic, label strings, precision function, status code rules.

### 6. Badge / Pill Components
- **Live Pill** — Red bg, white text, DM Mono 9-10px, uppercase. Blink animation (opacity 1 → 0.25, 1.6s).
- **Phase Pill** — DM Mono 9px, background-color (not text color), 2px radius, padding 2px 6px.
- **Status Pill** — Red text, monospace uppercase, 10-11px. "RT", "WD", "EL".
- **Rank Badge** — "RANK 1" or "JO" tag, DM Mono. Gold or green text.
- **v3 Preservation** — All 4+ badge types, colors, fonts, animations, padding.

### 7. Standings Table / Entry List
- **Header Row** — Sticky (results.html, display.html). Gray or dark bg, border-bottom. DM Mono 8-9px muted uppercase, letter-spacing .1em.
- **Data Rows** — Sorted by place (1-N) or by fault+time if no place. Status codes mixed in (not bottom).
- **Columns** — Place | Entry/Bib | Horse/Rider | Faults | Time | (Round breakdowns for multi-round).
- **Rendering Logic** — `WEST.jumper.renderRoundsBlock()` for jumper rounds (universal across all 3 pages). Per-round rows, optimum time indicator.
- **v3 Preservation** — Column order, header style, sorting logic, universal jumper renderer, multi-round layout.

### 8. Staleness / Watcher Offline Indicator
- **Live** — Amber banner if watcher offline (--red left border). Clock frozen. Standing data grayed. Text: "WATCHER OFFLINE — showing last known standings. Clock frozen until connection restores."
- **Display** — No banner (operator sees Ryegate). Falls back to sessionStorage last-render.
- **Stats** — Watcher dot (7px circle, green if alive, muted if offline). Title attribute.
- **v3 Preservation** — Banner style, offline messaging, dot indicator, fallback caching.

### 9. Time-Ago Formatting
- **Used in** — Recent results cards (live.html), entry history.
- **Format** — "just now" (<60s), "Xm ago" (1m-59m), "Xh ago" (60m+).
- **Font** — DM Mono 11px muted.
- **v3 Preservation** — Function `timeAgo(isoStr)`, format strings, thresholds (60s, 3600s).

### 10. Judge Grid / Judge Cards
- **Multi-Judge Hunter** — Centralized renderer `WEST.hunter.renderJudgeGrid(entry, judgeCount, statusDisplay, opts)`.
- **Display** — Compact mode (display.html sidebar, stats.html): header row (J1/J2/J3 cols) + data row (per-judge scores, combined).
- **Results** — Expanded by default if multi-judge. Grid: per-round score cols (11px monospace) | total col (14px bold).
- **Derby Shape** — Scores may be base + hiopt + bonus (phased scores).
- **Status Rules** — If R1 eliminated, row dimmed and status code shown. Per-round statuses in their cells.
- **v3 Preservation** — Renderer function signature, compact layout, expanded layout, status rules, derby vs non-derby shapes.

### 11. Color Palette (Universal)
- `--black: #111111`
- `--red: #b82025` (faults, active, urgent)
- `--white: #ffffff`
- `--off-white: #f5f5f5` (light theme bg)
- `--green: #2e7d32` (clear, healthy)
- `--text-muted: #777` (secondary text)
- `--text-body: #333` (primary text)
- **Dark Theme (display.html)** — `--bg: #0a0e1a`, `--card: #111827`, `--border: #1e2940`, `--gold: #fbbf24`.
- **v3 Preservation** — All 8 core colors, dark theme overrides, semantic usage (red=fault, green=clear, muted=secondary).

### 12. Font Stack (Universal)
- **Playfair Display 700/900** — Class names, place numbers, titles (serif, formal).
- **DM Mono 400/500/600** — All labels, numbers, times, entries (monospace, machine-like).
- **Source Sans 3 300/400/500/600** — Body text, rider names, horse names (sans-serif, readable).
- **v3 Preservation** — Font families, weights, hierarchy (Playfair > DM Mono > Source Sans 3).

### 13. Responsive Spacing Strategy
- **Desktop Base** — 16px padding, 12px gaps.
- **Mobile** — 12px padding, 8px gaps.
- **clamp() Usage** — `clamp(16px, 4vw, 48px)` for scalable padding. Scales smoothly 480px → 1280px+.
- **Breakpoints** — 480px (mobile), 600px (small tablet), 768px (tablet), 1024px+ (desktop).
- **v3 Preservation** — clamp() strategy, breakpoint values, base spacing scale.

### 14. Polling Cadence Logic
- **Active Class (watcher alive + selected)** — 1-2s (aggressive, show live action).
- **Active but Not Selected** — 5-15s (moderate, operator may switch).
- **Idle** — 10-120s (lazy, class complete or no activity).
- **Network Adaptive** — `WEST.getPollInterval(active, minMs, maxMs)` checks Save-Data + connection type, backs off on 2G/3G.
- **v3 Preservation** — Cadence thresholds, adaptive algorithm, function signature.

---

## MULTI-ROUND & HUNTER VS JUMPER HANDLING

### Multi-Round Methods (R1/R2/JO)
Methods 2, 3, 9, 11, 13, 14 have two-phase jumping (R1 → R2/JO). Handled consistently across all pages:

- **Live** — Clock ticks per-round. On-course shows round label (e.g. "R2"). Clock color gold if <TA, red if >TA.
- **Display** — Standings show R1/R2 rows stacked. JO qualifier entries labeled "JO-1", "JO-2", etc. (via `WEST.jumper.computeJoPlaces`).
- **Results** — Same stacked rows. Per-round status codes (e.g. "PH2 RT" with PH1 visible if passed). "Remaining" entries show pending JO participants.
- **Stats** — Separate R1/JO sections. R1 standings show gap-vs-TA. JO standings show gap-to-leader. Two fault distribution charts.

### Hunter Scoring (Single Round)
Hunters (method H) and some Specials have single-round or multi-round point scoring:

- **Live** — No clock. On-course card shows "In The Ring" label. Finish phase shows judge grid (multi-judge) or score only (single-judge).
- **Display** — Sidebar shows current entry + score + rank once FINISH phase. Judge cards for multi-judge. Standings show combined score per entry.
- **Results** — Derby entries expandable to show per-judge math. Non-derby show score rows stacked. Multi-judge hunter (non-derby) routes through `WEST.hunter.derby.renderPrecomputed` (same renderer as derby for consistency).
- **Stats** — Not applicable (jumper-only page).

### Equitation (Method 7 Jumper + Hunter)
Rider-primary classes (method 7 for jumper, hunter equitation):

- **Live** — Rider name in large font (primary), horse secondary/italicized.
- **Display** — OOG + standings show rider first. Entry grid: rider (1st col) | horse (secondary in same line or 2nd line).
- **Results** — "Rider / Horse" column header instead of "Horse / Rider". Rider #, horse muted below.
- **Stats** — "Rider / Horse" column header in all tables.

---

## KEY CONCLUSIONS FOR V3 PRESERVATION

### Layout Patterns
- Live: Mobile-first, sticky header, scrollable content, footer.
- Display: Fixed 100vh grid, 3 columns, auto-scrolling standings + sidebar.
- Results: Single-column, scrollable, breadcrumbs, title bar, card-based entries.
- Stats: Single-column, collapsible sections, live-strip (when active).

### Visual Language
- Serif (Playfair Display) + Mono (DM Mono) + Sans (Source Sans 3).
- Dark text on light bg (mobile/results), light on dark bg (display scoreboard).
- Red for active/fault/urgent. Green for clear/healthy. Muted for secondary.
- Cards with 1px borders, 4-6px radius. Flat design (no shadows).

### Real-Time Feel
- Clock ticks 100ms (smooth, not jerky).
- Blink animations (live pill, steady pulse).
- Auto-scroll standings (news-ticker effect on display).
- Time-ago formatting ("just now", "2m ago").
- Live fault calculation on-course (ceil((elapsed - TA) / TI) * FPI).

### Functional Consistency
- Universal jumper round renderer (`WEST.jumper.renderRoundsBlock`).
- Universal hunter judge grid renderer (`WEST.hunter.renderJudgeGrid`).
- Centralized status display rules (RT/WD/EL suppression).
- Phase labels via `WEST.phaseLabel(phase)`.
- Time formatting via `WEST.formatTime(val, precision)`.

### Data Refresh Cadence
- Live: 1s (active), 10s (idle).
- Display: 1s (active), 10s (idle). SessionStorage fallback.
- Results: Single load (archive, no polling).
- Stats: 2s (live class), 15s (active), 120s (idle).

All four pages share the same color palette, typography, spacing strategy, and control vocabulary. v3 must preserve this soul exactly while swapping the underlying architecture (from polling to push, from monolithic pages to shared modules).
