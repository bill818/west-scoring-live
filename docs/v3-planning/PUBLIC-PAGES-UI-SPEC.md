# Public Pages UI Spec — v3
### Detailed structural inventory of index.html, show.html, classes.html

**Purpose:** preserve v2 layout + look-and-feel for v3. This doc catalogs every section, control, typography choice, animation, data flow, and responsive behavior so v3 can rebuild these pages identically under modernized internals. Sibling doc: `LIVE-PAGES-UI-SPEC.md` (live/display/results/stats).

Source: exhaustive exploration of the three v2 pages + worker endpoints they call. Use v2 source files as secondary reference for exact CSS declarations.

---

## PAGE 1: index.html (Show Listing)

### Page purpose
Landing page displaying all active and recent horse shows. Entry point for the live scoring system — users navigate here to find a show, then drill into details via the show card.

### Layout / page structure

**Header (sticky, top-anchored):**
- Black background (#111111) with 3px red bottom border
- Left: WEST logo (30px, inverted) + "WEST" (Playfair 24px, 900wt) + pipe separator + "Scoring.Live" (DM Mono 14px, red)
- Right: "Live" pill (hidden by default, shown only when active shows > 0)
- Mobile: logo text hidden at 480px breakpoint

**Toolbar (white, directly below header):**
- Left: "Active Shows" stat block (Playfair 34px bold red number + DM Mono 9px muted label "ACTIVE / SHOWS") + shows count label
- Right: Refresh button (white, 1px border, DM Mono 11px uppercase)
- Padding: 10px 16px, min-height 40px

**Search bar (white, below toolbar):**
- Search input (off-white background, 1px border, 8px 12px padding, left icon 34px from edge)
- Year dropdown (DM Mono, 12px, 90px minimum width)
- Displays either shows matching search OR "No shows match your search"

**Main content (max-width 680px center, 12px padding bottom to 80px):**
- Show cards (white, 10px radius, 1px border, margins 10px bottom)
- Cards fade in (fadeUp animation 0.3s ease) and scale slightly on active

**Show card anatomy:**
1. Card top section (14px 16px padding):
   - Row 1: Title (Playfair 18px, flex-1) + Chevron (20px, #ccc)
   - Dates (DM Mono 11px, muted, optional)
   - Meta badges: Status (Active/Pending/Completed in color-coded pills) + Live pill (if ring has active watcher + selected class)
2. Divider (1px #e2e2e2 horizontal line)
3. Card classes preview (9px 16px padding):
   - Live classes shown first (if any actively judging)
   - Up to 3 most-recent scheduled classes shown after
   - Each row: Class number (DM Mono 11px red, min 34px) + Class name (13px, muted, ellipsis) + live-dot-inline (7px red animated pulse) if active
   - "+" count shown if >3 total scheduled
   - Watcher chip (optional): 10px DM Mono, gray text, shows watcher status dot (6px, gray or green if alive)

### Every control & section

| Element | Type | Label | Visual Treatment | States |
|---|---|---|---|---|
| Active Shows stat | Stat block | "Active Shows" | Playfair 34px red number + DM Mono label; baseline alignment | Default only |
| Refresh button | Button | "↻ REFRESH" | DM Mono 11px, white bg with 1px border, 8px 14px padding, 6px radius | Default, active (black bg + white text) |
| Search input | Text field | "Search shows…" | DM Mono icon left, off-white fill, 1px border, 8px padding, 8px radius | Default, focus (black border) |
| Year dropdown | Select | "Recent" / Year / "All Shows" | DM Mono 12px, 1px border, 6px radius, auto appearance | Default, focus |
| Show card | Link/Card | [Show Name] | White bg, 10px radius, 1px border, block display, cursor pointer | Default, active (scale 0.98), hover (none explicit) |
| Status badge | Badge | "✓ Completed" or "◯ Active" or "◯ Upcoming" | DM Mono 10px uppercase, inline-flex, 3px 8px padding, 3px radius | Three variants: completed (gray bg #f5f5f5, gray text), active (green bg #e8f5e9, green text #2e7d32), pending (blue bg #e3f2fd, blue text #1565c0) |
| Ring Live badge | Badge | "⏺ Ring Live" | DM Mono 10px uppercase, red bg, white text, 4px gap with live dot | Visible only when watcher alive AND active classes > 0 |
| Class row link | Link | [Class Num] [Class Name] | DM Mono class num (11px red) + class name (13px, muted); hover area 4px -8px margins | Default, hover (off-white bg, class num turns red) |
| Live dot inline | Indicator | (animated) | 7px red circle, blink animation 1.6s (0-100%: opacity 1, 50%: opacity 0.3) | Animated pulsing |
| More classes | Text | "+ N more classes" | DM Mono 10px, #bbb, margin-top 3px | Text only |
| Watcher chip | Status | (dot indicator) | DM Mono 10px, 5px gap, 6px dot (gray or green); "alive" adds green + blink animation | Two states: dead (gray #555), alive (green #2e7d32 + animation) |
| No results message | Info box | "No shows match your search" | 40px 20px centered, 1px border, 10px radius, DM Mono 12px | Hidden by default, shown on zero results |

### Visual design patterns

**Typography:**
- Headlines: Playfair Display serif (700 or 900 weight)
- Labels: DM Mono monospace (10-11px, letter-spacing 0.1em uppercase)
- Body: Source Sans 3 sans-serif (13-15px, normal weight 400)

**Color palette:**
- Black (#111111) — header, card borders, text
- Red (#b82025) — highlights, badges, icons, separator pipe
- Off-white (#f5f5f5) — page background, hover states
- White (#ffffff) — cards, input fields
- Border gray (#e2e2e2) — card dividers, input borders
- Muted text (#777) — secondary labels
- Body text (#333) — main copy
- Status-specific: green (#2e7d32), blue (#1565c0)

**Spacing:**
- Card margin: 10px bottom (mobile), 0 (desktop)
- Padding: 14px 16px (cards), 10px 16px (toolbar), 12px 12px (content area)
- Desktop uses clamp(16px, 4vw, 48px) for responsive horizontal padding

**Borders & radius:**
- Card radius: 10px
- Input radius: 8px or 6px (dropdowns)
- Status badges: 3px radius
- Tap target: 52px minimum (CSS variable --tap)

**Shadows:** None explicit (cards use 1px borders instead)

### Data flow

**Endpoints polled:**
- `/getShows` — fetches array of all shows with name, slug, dates, venue, location, status (pending/active/complete), start/end dates, ring count
- `/getLiveClass?slug=X&ring=1` — fetches activeClasses (array with classNum, className) and watcherAlive boolean
- `/getClasses?slug=X&ring=1` — fetches scheduled classes for preview (class_num, class_name, scheduled_date, entry_count)
- `/getShow?slug=X` — fetches show status from D1 (source of truth for active/complete state)

**Polling cadence:**
- Initial load via `loadData()` on page load and every 2 minutes (setInterval 120000ms)
- Year dropdown built once after /getShows response
- Auto-fallback logic: Recent → current year → previous year → all (if zero results match)

**KV/D1 keys:**
- D1 show table: name, dates, venue, location, status, start_date, end_date
- Worker KV: indexed by slug, per-ring live class data

### Responsive behavior

**Mobile (480px and below):**
- Logo text hidden (display: none)
- Header height: 56px
- Cards full width with 12px padding bottom
- Max-width: 680px (keeps cards narrow)

**Desktop (768px and up):**
- Header height: 70px
- Logo font sizes increase (Playfair 30px, DM Mono 17px)
- Cards max-width: 860px
- Padding: clamp(16px, 4vw, 48px) horizontal
- Card margins: 0 (no bottom margin, stacked tightly)

### Animations / transitions

**Fade-in (cards):**
- fadeUp keyframe: 0% opacity 0, translateY(8px) → 100% opacity 1, translateY(0)
- Duration: 0.3s ease
- Each card appears staggered as rendered

**Live dot blink:**
- blink keyframe: 0,100% opacity 1 → 50% opacity 0.3
- Duration: 1.6s ease-in-out infinite
- Applied to live-dot, live-dot-inline, watcher-dot.alive

**Card active:**
- transform: scale(0.98) on :active
- Transition: none (instant feedback)

**Button active:**
- Refresh button: instant background + text color change on :active

### Notable UX choices

- Ring Live badge only shows when watcher is alive AND there's an active class — avoids misleading "watcher running but nothing happening"
- Shows use D1 status (admin-set), not inferred from live data — source of truth for active/complete state
- Live classes appear first in preview, followed by most-recent 3 scheduled
- Active shows count displayed prominently in stat block; "Live" pill hidden until count > 0
- Search filters by show name, venue, location (case-insensitive, multi-word support)
- Year filter auto-falls back: if search + year yields 0 results, tries next year down to "all"
- Class preview shows "+" count for remaining classes rather than full list — avoids card bloat

### Empty / loading / error states

**Loading:**
- Spinner (30px, 3px border, red top, 0.7s rotate animation)
- "Loading Shows…" label (DM Mono 11px uppercase)
- Centered in 60px 20px padding box

**No data:**
- Error box (white bg, #fff8f8 tint, #ffd0d0 border, 10px radius, 36px 20px padding)
- "No Shows Found" heading (Playfair 20px)
- "WEST show results will appear here as they become available." copy

**No search results:**
- "No shows match your search" message (hidden by default, shown via JS)

### Keyboard / accessibility

- Search input: autocomplete="off", autocorrect="off", spellcheck="false"
- Year dropdown: native select with appearance:auto (uses OS picker)
- No explicit ARIA labels (semantic HTML mostly sufficient)
- Focus visible on search input: border-color changes to black
- Tap highlight disabled globally (-webkit-tap-highlight-color:transparent)
- No keyboard shortcuts documented

---

## PAGE 2: show.html (Show Overview)

### Page purpose
Displays detailed show metadata, live status per ring, overall statistics, leaderboards (champions, top riders, top horses, prize money leaders), and searchable entries. Serves as hub to navigate to class results or live.html.

### Layout / page structure

**Header (sticky, black 56px desktop 70px):**
- Back button (left): SVG back arrow + "Shows" text (DM Mono 12px), white, min-width 44px, hover red
- Logo (right-aligned): img (26px) + "WEST" (Playfair 20px) + pipe + "Scoring.Live" (DM Mono 12px red)
- Mobile: logo text hidden at 480px

**Breadcrumb bar (white, 40px min-height, overflow-x auto):**
- Home icon + "All Shows" (red link)
- Separator (›)
- Current show name (muted, not clickable)

**Hero section (white, below breadcrumbs):**
- Show name (Playfair 28px bold)
- Dates (DM Mono 12px muted, optional)
- Venue (Source Sans 15px, optional)
- Location (DM Mono 11px muted, optional)
- Weather icon + temp (Playfair 32px + DM Mono 10px description, inline flex, optional, loads async)
- Status badge (Active/Complete/Upcoming)

**Weather card (optional, white, 1px border, 10px radius):**
- Only loads if within 3 days of show start
- Shows emoji icon (36px), temperature (Playfair 32px), description (DM Mono 10px), location (DM Mono 10px muted)
- Cached in sessionStorage for 30 min TTL

**Section headers (recurring throughout):**
- DM Mono 10px uppercase, letter-spacing 0.14em, muted text
- Padding: 20px 16px 8px

**Ring cards (grid, 1 column mobile, responsive desktop):**
- White, 1px border, 10px radius, cursor pointer, fadeUp animation
- Card content: Ring name (Playfair 18px) + chevron (20px muted)
- Meta: class count + complete count (DM Mono 11px muted)
- Live indicator (if active): "Ring Live" text (DM Mono 11px red, bold) + 7px red animated dot
- Progress bar (6px height, #eee background, green (#2e7d32) fill)
- Live button (if ring has active classes): red bg, white text, DM Mono 11px uppercase, "Watch Live — Ring N"
- Desktop: grid changes to auto-fill, minmax(280px, 1fr), multi-column layout

**Statistics grid (3 columns mobile, responsive desktop):**
- Stat cards (white, 1px border, 10px radius, 16px 12px padding, center text)
- Each: large number (Playfair 28px bold) + small label (DM Mono 9px uppercase muted)
- Three always shown: "Total Show Entries", "Total Classes", "Classes Complete"
- "Total Show Entries" initially placeholder (—), updated via /getShowStats

**Entries-per-day section (added dynamically if data exists):**
- Small cards in flex row: entry count (Playfair 20px) + label (DM Mono 10px) for each day
- White bg, 1px border, 6px radius, centered

**Leaderboards section (collapsed/expandable):**
- Leader cards (white, 1px border, 10px radius, stacked)
- Header: clickable, toggle-chevron (rotate 180° when open)
- Four possible boards: Champions & Reserve, Top Riders, Top Horses, Prize Money Leaders
- Each shows preview text (first entry name + stat) collapsed, full list expanded

**Search / Lookup section (below stats):**
- "Lookup" section header (DM Mono 10px uppercase)
- Search input (max-width 480px, 12px 16px padding, 1px border, 10px radius, focus red)
- Search icon (absolute left 14px, #bbb)
- Clear button (absolute right 10px, hidden until text entered, #bbb)
- Results list: match cards (white, 1px border, 10px radius) with rider/horse info and class appearances

**Footer (black, DM Mono 11px):**
- "WEST Timing and Scoring · west-solutions.com · Admin"
- Links to west-solutions.com and admin.html

### Every control & section

| Element | Type | Label | Visual Treatment | States |
|---|---|---|---|---|
| Back button | Link button | ← Shows | DM Mono 12px white, min 44x44px, no bg | Default, hover (red text) |
| Breadcrumb home | Link | 🏠 All Shows | DM Mono 11px red, inline-flex | Default, hover (black text) |
| Show name hero | Heading | [Show name] | Playfair 28px 900wt, line-height 1.15 | Static |
| Hero weather | Weather display | [emoji] [temp]° [desc] | Playfair 32px + DM Mono inline | Loaded async via sessionStorage cache (30 min TTL) |
| Status badge | Badge | "✓ Active" / "✓ Complete" / "⬜ Upcoming" | DM Mono 10px uppercase, 3px 8px padding, 3px radius | Three colors: green bg (active), gray bg (complete), blue bg (upcoming) |
| Ring card | Link card | [Ring name] | Playfair 18px + chevron 20px | Default, active (scale 0.98) |
| Ring meta | Meta text | "N classes · M complete" | DM Mono 11px muted, flex wrap | Static |
| Ring live indicator | Badge | "⏺ Ring Live · N class(es) in ring" | DM Mono 11px red bold + 7px red animated dot | Visible only if watcher alive + active classes > 0 |
| Ring progress bar | Progress | [green fill] | 6px height, #eee bg, green (#2e7d32) fill | width: percentage (0-100), animated transition 0.4s ease |
| Watch Live button | Button link | "⏺ Watch Live — Ring N" | Red bg, white text, DM Mono 11px uppercase, 10px 16px padding, 6px radius | Default, hover (darker red #8b1519) |
| Stat card | Stat box | [number] [label] | Playfair 28px bold + DM Mono 9px label, center aligned | Placeholder (—) initially, updates via /getShowStats |
| Entries-per-day card | Mini stat | [count] Entries [date] | Playfair 20px + DM Mono 10px, small card style | Static, white bg, 6px radius |
| Leader header | Collapsible | [Count] championship[s] | DM Mono 10px label + preview text, clickable, chevron rotates | Default, open (chevron rotates 180°, body visible) |
| Leader row | Row | [Rank] [Name] [Stat] | DM Mono 11px rank + primary/secondary names + right-aligned stat | Static |
| Ribbon (champion) | SVG | CH (colored ribbon) | 32px width, custom SVG per WEST.ribbon module | Static |
| Search input | Text field | "Search rider or horse..." | Source Sans 15px, 12px 16px padding, 1px border, 10px radius | Default, focus (red border) |
| Search clear button | Button | × | Font 18px, 4px padding, hidden until input filled | Default (visible), click clears input + focus |
| Search result card | Card link | [Horse/Rider] [secondary] | Playfair 16px bold + Source Sans 12px muted, white bg, 1px border, 10px radius | Default |
| Search class row | Link | [Place] [Class name] | DM Mono 12px place (right-aligned) + class name flex-1, inline in result | Default |

### Visual design patterns

**Typography:**
- Hero: Playfair 28px 900wt
- Section headers: DM Mono 10px uppercase, 0.14em letter-spacing
- Stats: Playfair 28px bold numbers, DM Mono 9px uppercase labels
- Body: Source Sans 15px
- Leaderboard rows: DM Mono 11-12px for rank/stat, Source Sans 14-16px for names

**Color palette:**
- Black (#111111), red (#b82025), white (#ffffff), off-white (#f5f5f5)
- Border (#e2e2e2), muted (#777), body (#333)
- Status: green (#2e7d32), blue (#1565c0)
- Weather: emoji, #64b5f6 for rain amount, #bbb for wind

**Spacing:**
- Hero padding: 24px 16px 20px (mobile), 28px clamp(...) 24px (desktop)
- Section header: 20px 16px 8px
- Ring grid gap: 10px
- Card padding: 14-16px
- Responsive padding: clamp(16px, 4vw, 48px) desktop

**Borders & radius:**
- Card radius: 10px everywhere
- Search input radius: 10px
- Badge radius: 3px
- Smaller UI elements: 6px (buttons)

**Shadows:** None explicit (borders + off-white hover states instead)

### Data flow

**Endpoints:**
- `/getShow?slug=X` — show metadata (name, dates, venue, location, status, start_date, rings array with ring_num, ring_name, class_count, complete_count)
- `/getLiveClass?slug=X&ring=N` — per-ring live data (activeClasses, watcherAlive) — polled every 10 seconds
- `/getShowStats?slug=X` — aggregated stats (totalEntries, entriesPerDay, champions, topRiders, topHorses, moneyLeaders)
- `/getShowWeather?slug=X` — multi-day weather forecast (days array with date, weather_code, temp_high, temp_low, precip_mm, wind_max)
- `/searchShow?slug=X&q=...` — search results (horse/rider match with sire, dam, city, state, owner, classes with per-judge round details)
- Weather API (open-meteo): geocoding + forecast (cached 30 min in sessionStorage)

**Polling cadence:**
- Live data: 10000ms (10 sec) per ring
- Stats: once on load
- Show weather: once on load (if within 3 days of start)
- Search: debounced 300ms after keystroke (2+ chars)

### Responsive behavior

**Mobile (all widths):**
- Header: 56px
- Breadcrumb: scrollable overflow-x auto
- Hero: 24px 16px padding
- Ring grid: 1 column, max-width none
- Search section: max-width 480px
- Full-width sections: padding 16px horizontal

**Desktop (768px+):**
- Header: 70px
- Hero: 28px clamp(16px, 4vw, 48px) padding
- Ring grid: auto-fill, minmax(280px, 1fr), multi-column
- Search section: still max-width 480px
- Responsive padding: clamp(...) everywhere
- Leaderboard grid: 1 column still (no multi-col leaderboards)

### Animations / transitions

**fadeUp:**
- Cards (ring, leaderboard, search results): 0.3s ease, opacity 0→1, translateY 8px→0

**Scale:**
- Ring card on :active: scale(0.98), instant (no transition)

**Chevron rotation:**
- Leader chevron: transform rotate(180deg) on .open, transition 0.2s

**Progress bar fill:**
- Ring progress bar: width change animated 0.4s ease

**Blink animation:**
- Ring live dot: 1.6s ease-in-out infinite, opacity 1→0.25→1

### Notable UX choices

- Weather loads async from open-meteo (free), cached in sessionStorage 30 min to avoid repeated API calls
- Live data polled per-ring (not global) — allows multi-ring shows to update independently
- Search matches and displays rider-first layout for equitation classes (rider bold, horse below)
- Per-judge round breakdown shown inline in search result (best round displayed by place)
- Leaderboards collapsed by default but preview first entry in header — encourages discovery without page bloat
- Entries-per-day shown as small cards in flex row, not a table — fits mobile without horizontal scroll

### Empty / loading / error states

**Loading:**
- Spinner (28px, 3px border, red top, 0.7s rotate) + "Loading Show…" (DM Mono 11px uppercase)
- Centered in state-box (60px 20px padding)

**No show:** "No show specified." with inline link to index.html

**Error loading show:** "Could not load show data." with inline link to index.html

**No leaderboards:** Leaderboard section omitted entirely if no stats data

**No entries per day:** EPD section omitted if not in stats

**No search results:** "No results for "query"" (DM Mono 11px)

### Keyboard / accessibility

- Search input: autocomplete="off"
- Search clear button: type="button", click handler clears + refocuses
- Leaderboard headers: onclick handler, not true button (JS-driven toggle)
- No explicit keyboard shortcuts
- No ARIA labels beyond semantic HTML

---

## PAGE 3: classes.html (Class Listing by Ring)

### Page purpose
Shows all scheduled classes for a specific ring, filterable by search and sortable by day/name/number. Displays live status per class, completion badges, and championship flags. Gateway to results.html for class scoring details.

### Layout / page structure

**Header (sticky, black 56px desktop 70px):**
- Back button (left): SVG back arrow + show name text (white, DM Mono 12px)
- Logo (right-aligned): same as show.html

**Breadcrumb bar (white, 40px, scrollable):**
- Home + "All Shows" link
- Separator (›)
- Show name link (red, clickable)
- Separator (›)
- Ring name (muted, current)

**Title bar (white):**
- Ring/Show name (Playfair 22px 700wt)
- Class count (DM Mono, "N classes")

**Class search bar (white):**
- Search input (14px, 8px 12px padding, 1px border, 6px radius)
- Search icon (left 26px, #bbb, pointer-events none)
- Clear button (right 26px, hidden until input filled, #bbb)

**Sort bar (white, 8px 16px padding):**
- "Sort" label (DM Mono 9px uppercase muted)
- Three buttons: "By Day" (active by default), "By Name", "By Number"
- Buttons: DM Mono 10px, 1px border, 4px radius, 5px 10px padding, muted text
- Active button: black bg, white text

**Live banner (conditional):**
- Appears only when ring has active classes + watcher alive
- White bg, 3px red bottom border
- 6px red animated dot + "Live Now —" label + class number/name + arrow (›)
- Full-width banner above class list
- Clickable link to live.html

**Class rows (repeating):**
- Minimum height: 56px (mobile) / 60px (desktop)
- DM Mono class number (red, 12px, min 54px width)
- Class name (15px 16pt desktop, ellipsis overflow, flex-1)
- Class meta (DM Mono 10px muted): class type (Jumper/Hunter/Equitation) + entry count
- Right chevron (20px muted, flex-shrink 0)
- Background: white, 1px bottom border, cursor pointer
- Hover/active: background off-white

**Class badges (inline within row, to the right of class name):**
- Live dot inline (7px red animated, margin-left 7px)
- Complete badge ("✓ COMPLETE", gray bg #f5f5f5, gray text, 9px DM Mono)
- Championship badge ("CHAMP", yellow bg #fef3c7, brown text #92400e)
- JO badge ("ORDER OF GO POSTED", blue bg #e3f2fd, blue text #1565c0)
- Only one badge per class (priority: complete > champ > jo)

**Day section dividers (when sorting by day):**
- DM Mono 10px uppercase muted, 12px 16px padding
- Off-white bg with 1px border top and bottom
- Text: formatted date (e.g., "Monday, April 21, 2025")
- Most recent day listed first (reverse chronological)

**Content wrapper:** Bottom padding 60px (safe area for footer)

**Footer (black, DM Mono 11px):** Same as previous pages

### Every control & section

| Element | Type | Label | Visual Treatment | States |
|---|---|---|---|---|
| Back button | Link | ← [Show name] | DM Mono 12px white, 44x44 min | Default, hover (red) |
| Breadcrumb show | Link | [Show name] | DM Mono 11px red | Default, hover (underline), click to show.html |
| Title main | Heading | [Show name] | Playfair 22px 700wt | Static |
| Class count | Text | "N classes" | DM Mono, muted | Dynamic update |
| Class search | Text input | "Search classes..." | Source Sans 14px, 8px 12px padding | Default, focus (red border) |
| Search clear | Button | × | 18px font, hidden until input filled | Hidden, visible (display block when input.value.length > 0) |
| Sort buttons | Button group | "By Day" / "By Name" / "By Number" | DM Mono 10px, 1px border, 5px 10px padding, 4px radius | Default (muted text), active (black bg + white text) |
| Class row | Link | [Class #] [Class name] [badges] | DM Mono 12px number (red) + 15px class name, 56px min-height | Default, active/hover (off-white bg) |
| Class meta | Meta text | "Hunter · 15 entries" | DM Mono 10px muted | Static |
| Live dot inline | Indicator | (animated pulse) | 7px red circle, blink animation | Animated, only visible if class is live |
| Complete badge | Badge | "✓ COMPLETE" | DM Mono 9px, gray bg #f5f5f5, gray text #757575 | Static inline badge |
| Championship badge | Badge | "CHAMP" | DM Mono 9px, yellow bg #fef3c7, brown text #92400e | Static inline badge |
| JO badge | Badge | "ORDER OF GO POSTED" | DM Mono 9px, blue bg #e3f2fd, blue text #1565c0 | Static inline badge |
| Day label | Section divider | "[Day] [Date]" | DM Mono 10px uppercase muted, off-white bg, 1px border top/bottom | Static, full-width divider |
| Live banner | Alert/CTA | "Live Now — Class N [name]" | White bg, 3px red border-bottom, flex layout, 6px red animated dot | Visible only when active classes + watcher alive, clickable link |

### Visual design patterns

**Typography:**
- Title: Playfair 22px 700wt (not 900)
- Class number: DM Mono 12px red
- Class name: 15px Source Sans (14px mobile, 16px desktop)
- Labels: DM Mono 9-10px uppercase
- Badge text: DM Mono 9px

**Color palette:** Same as previous pages, with badge colors: gray (#f5f5f5, #757575), yellow (#fef3c7, #92400e), blue (#e3f2fd, #1565c0)

**Spacing:**
- Class row: 0 16px padding (horizontal), min-height 56px mobile / 60px desktop
- Search wrap: 8px 16px padding
- Sort bar: 8px 16px padding, 6px gap between buttons
- Day label: 12px 16px 6px padding
- Content wrap: padding-bottom 60px

**Borders & radius:**
- Class row: 1px bottom border only (stacked effect)
- Search input: 6px radius
- Button radius: 4px

### Data flow

**Endpoints:**
- `/getShow?slug=X` — ring names (ring_num, ring_name)
- `/getClasses?slug=X&ring=N` — class list (class_num, class_name, scheduled_date, class_type, entry_count, status, hidden, schedule_flag, competed_count, first_ride_at)
- `/getLiveClass?slug=X&ring=N` — live status (activeClasses array, watcherAlive boolean)

**Polling cadence:**
- Classes: every 30000ms (30 sec) via loadClasses()
- Live data: every 3000ms (3 sec) via pollLive()
- Both happen async, render updates independent

**KV key pattern:** Live class data indexed by slug + ring

### Responsive behavior

**Mobile (all widths):**
- Header: 56px
- Title bar: 14px 16px padding, Playfair 22px
- Search wrap: 8px 16px padding
- Sort bar: 8px 16px padding
- Class row: 0 16px padding, 56px min-height

**Desktop (768px+):**
- Header: 70px
- Title bar: 18px clamp(...) padding
- Title text: Playfair 26px
- Sort bar: 8px clamp(...) padding
- Class row: 0 clamp(...) padding, 60px min-height
- Responsive padding: clamp(16px, 4vw, 48px)

### Animations / transitions

**Blink (live dot):** 1.6s ease-in-out infinite, opacity 1→0.25→1

**Class row background:** hover/active — background color change to off-white, transition 0.1s (implicit)

### Notable UX choices

- Classes filtered to show only scheduled_date (unscheduled classes hidden)
- Classes with hidden=true removed from view (admin control to hide without deleting)
- Search works on both class_name and class_num (case-insensitive, includes matching)
- By-day sort groups by date, then reverses to show most-recent day first
- Badge priority: complete > champ > jo (only one shown per class, prevents visual clutter)
- Live banner full-width, sticky-like appearance (renders above class list, not sticky)
- Watcher alive check required for live indicator (avoids misleading "watcher running, nothing happening")
- Class rows remain minimal (no inline detail expansion) — click to results.html for full breakdown

### Empty / loading / error states

**Loading:** Spinner (28px, 3px border, red top) + "Loading Classes…" (DM Mono 11px uppercase). Centered in state-box (60px 20px padding)

**No scheduled classes:** "No scheduled classes with entries yet." (when filtered list is empty but API returned data)

**No classes at all:** "No classes found for this show." (when API returns zero classes)

**Search no results:** No specific message, just empty state (filters applied, result shown as no matches within scheduled set)

### Keyboard / accessibility

- Search input: autocomplete="off", focus border red
- Search clear button: type="button", click clears + refocuses input
- Sort buttons: onclick handlers, not true form submission
- No explicit ARIA labels
- No keyboard shortcuts

---

## SHARED PATTERNS ACROSS ALL THREE PAGES

### Visual vocabulary (repeating design language)

**Headers:**
- All three use identical header (black bg, 3px red bottom border, sticky, white text)
- Logo pattern identical: inverted img (26-30px) + Playfair serif + DM Mono red accent
- Mobile breakpoint: 480px (hide logo text)
- Desktop height: 70px (vs 56px mobile)

**Buttons & interactions:**
- All link-style buttons use no explicit box-shadow (borders only)
- Active state: scale(0.98) instant feedback on tap
- Hover state: mostly color change or background change, no shadow
- Refresh/sort buttons: white border, muted text, change to black bg + white on active
- CTA buttons (Watch Live): red bg, white text, darker red on hover

**Status badges (consistent across):**
- 3px radius, DM Mono 10px uppercase, letter-spacing 0.1em
- Color-coded: green (active), gray (completed), blue (pending/info)
- Inline-flex with gap for icons/dots

**Typography hierarchy:**
- Playfair Display (serif, 900wt 700wt): page titles, big numbers, show names
- DM Mono (monospace): labels, metadata, small UI text, counts
- Source Sans 3 (sans-serif): body copy, class names, main content

**Color constants:**
- `--black: #111111`
- `--red: #b82025`
- `--white: #ffffff`
- `--off-white: #f5f5f5`
- `--border: #e2e2e2`
- `--text-muted: #777`
- `--text-body: #333`
- `--green: #2e7d32` (status active, progress bar)

**Animations (consistent):**
- fadeUp: 0.3s ease, opacity 0→1, translateY 8px→0 (cards, results)
- blink: 1.6s ease-in-out infinite, opacity 1→0.25 (live dots)
- spin: 0.7s linear infinite (spinner)
- All use @keyframes (no transitions on fixed states)

**Spacing system:**
- Horizontal: 16px base mobile, clamp(16px, 4vw, 48px) desktop
- Vertical padding sections: 12-20px
- Card padding: 12-16px
- Gap between elements: 6-14px (flex gap)
- Min-height for tap targets: 44px

**Border & radius:**
- Primary card radius: 10px (--card-radius)
- Secondary: 6-8px (inputs, small buttons)
- Smallest: 2-3px (status badges)
- Line weight: 1px (all borders)

**States (live indicators):**
- Live dot: 7px red circle, animated blink
- Live pill/badge: "LIVE" or "Ring Live" label + animated dot
- Watcher status: 6px circle, gray default or green if alive
- All use consistent blink animation

**Navigation patterns:**
- Back button: header-left, white arrow + label text
- Breadcrumbs: "/" separator, red links for clickable, muted for current
- Responsive: horizontal overflow-x auto on mobile (breadcrumbs)

**Search patterns:**
- Left icon (absolute positioned at left 14px / 10px / 26px)
- Clear button (absolute right, hidden until input filled)
- Input: 1px border, off-white or white bg, red focus border
- Results: card-based, white bg, 1px border, 10px radius, stacked

**Loading/error states (consistent):**
- Spinner: 28-30px, 3px border, red top, 0.7s rotate
- Label: DM Mono 11px uppercase
- State box: centered, 60px 20px padding
- Error box: light tint bg, colored border, centered heading + body text

**Responsive approach:**
- Mobile-first: base styles for mobile, @media (min-width:768px) overrides
- clamp() for scalable padding: clamp(16px, 4vw, 48px)
- Flex-based layouts (no float), grid for card layouts
- overflow-x auto for breadcrumbs/weather (touch-friendly scrolling)

### Navigation graph

**index.html:**
- Click show card → show.html?slug=X
- Click class preview link → results.html (if not live) or live.html (if live)
- Breadcrumb "Admin" → admin.html

**show.html:**
- Back button → index.html
- Logo → index.html
- Breadcrumb "All Shows" → index.html
- Ring card → classes.html?slug=X&ring=N
- "Watch Live" button → live.html?slug=X&ring=N
- Search result row → results.html?slug=X&classNum=N&ring=R

**classes.html:**
- Back button → show.html?slug=X (uses back btn with show name)
- Breadcrumb "All Shows" → index.html
- Breadcrumb show name → show.html?slug=X
- Logo → index.html
- Class row → results.html?slug=X&classNum=N&ring=R
- Live banner → live.html?slug=X&ring=R

### Cross-page state

**URL parameters (GET):**
- `slug`: show identifier (required on show.html, classes.html, results.html, live.html)
- `ring`: ring number (required on classes.html, live.html, results.html)
- `name`: show name encoded (optional, for display in back button / breadcrumb)
- `classNum`: class number (required on results.html)

**Session storage:**
- `weather_[slug]`: geocoding + forecast JSON, 30-min TTL (show.html only)

**No persistent storage across pages:**
- No localStorage (session-scoped only)
- No global state shared (each page re-fetches)

**Data state per page:**
- index.html: SHOWS array (fetched once per loadData, refreshed every 2 min)
- show.html: showData object (fetched once, live polling every 10 sec per ring)
- classes.html: allClasses array (fetched every 30 sec), liveData (polled every 3 sec)

### Shared utility functions (display-config.js)

- `WEST.esc()` — HTML entity escaping (& < > ") — used everywhere to prevent injection
- `WEST.ribbon` module — `placeRibbon(place, className, isBig)` for SVG ribbon graphics (1-12th places), `champSvg()`, `rcSvg()` for champion/reserve ribbons
- `WEST.statusDisplayLabel()` — viewer-friendly status code labels (EL, RO, RF, etc.)
- `WEST.weatherIcon()`, `WEST.weatherDesc()` — WMO weather code → emoji + text label
- `WEST.elimStatuses`, `WEST.partialStatuses`, `WEST.hideStatuses` — status code arrays for filtering/display logic

### Mobile-specific UX

- Tap highlight: disabled globally (-webkit-tap-highlight-color:transparent)
- Min touch target: 44x44px (back buttons, refresh, search clear)
- Overflow scrolling: -webkit-overflow-scrolling:touch (breadcrumbs)
- Scrollbar: hidden (scrollbar-width:none, ::-webkit-scrollbar display:none)
- Viewport: maximum-scale=1.0 (prevent zoom, no user-zoom)

### Accessibility notes

- No true ARIA labels in v2 (relying on semantic HTML)
- Semantic landmarks: header, nav (breadcrumbs), footer
- Links and buttons appropriately marked
- Color not sole identifier (badges use text + color, dots use shape + animation)
- Form inputs have placeholders and labels via context
- Search inputs use autocomplete="off" consistently

---

## V3 Implementation Checklist

| Component | index.html | show.html | classes.html | Notes |
|-----------|-----------|-----------|--------------|-------|
| Header | Yes (56px mobile, 70px desktop) | Yes (identical) | Yes (identical) | Sticky, black + red border, logo pattern |
| Breadcrumbs | No | Yes | Yes | Scrollable, red links, muted current |
| Search bar | Yes (show + year filter) | Yes (rider/horse) | Yes (class search) | Pattern: icon left, clear button right |
| Sort controls | No (year dropdown) | No | Yes (3 buttons) | DM Mono 10px, 1px border, active black |
| Cards/Rows | Yes (show cards) | Yes (ring cards, leaderboards) | Yes (class rows) | 10px radius, 1px border, fadeUp animation |
| Status badges | Yes (3 types) | Yes (same) | Yes (4 types) | 3px radius, DM Mono 10px uppercase |
| Stat blocks | Yes (active count) | Yes (show stats + EPD) | Yes (class count) | Playfair numbers + DM Mono labels |
| Progress bar | No | Yes (per ring) | No | 6px height, green fill, 0.4s ease transition |
| Live indicators | Yes (dot + pill) | Yes (ring + dot) | Yes (dot + banner) | 7px red circle, blink animation |
| Footer | Yes | Yes | Yes | Black, DM Mono, identical link pattern |
| Responsive grid | Flex-based | Grid (rings), flex (leaderboards) | Flex rows (class list) | clamp() padding, mobile-first |
| Animations | fadeUp (0.3s), blink (1.6s), spin (0.7s) | Same | Same | Consistent @keyframes across |
| Loading state | Spinner + label | Spinner + label | Spinner + label | 28-30px, 3px border, red top |
| Error state | Error box light tint | Error box light tint | No data message | Centered, heading + body |
| Colors | Black, red, green, blue, gray, border | Same palette | Same palette | CSS custom properties (--black, etc.) |
| Typography | Playfair (serif), DM Mono (mono), Source Sans 3 (body) | Same | Same | Font weights: Playfair 700/900, DM Mono 400/500 |

### Final notes for v3 implementers

1. **Font loading**: All three pages import from Google Fonts (Playfair Display, Source Sans 3, DM Mono) — must be preserved.
2. **Script dependencies**: display-config.js provides esc(), WEST.ribbon, WEST.statusDisplayLabel — v3 must include equivalent or compatible module.
3. **Worker endpoints**: All data flows from worker.dev endpoints (/getShows, /getLiveClass, /getClasses, /getShow, /getShowStats, /getShowWeather, /searchShow) — v3 architecture must support identical routes.
4. **Responsive breakpoint**: 768px is the primary desktop threshold (clamp() scaling from 16px mobile to 48px desktop). 480px is secondary (logo text hide).
5. **Polling cadence**: index.html (2 min), show.html (10 sec per ring), classes.html (30 sec classes + 3 sec live) — preserve to maintain UX feel.
6. **Live state checks**: "Ring Live" / "Watch Live" badges only appear when watcher alive AND active classes > 0 — avoid misleading users with running-but-idle states.
7. **Search debounce**: show.html search (300ms), classes.html search (200ms) — preserve to feel responsive without hammering worker.
8. **Session storage cache**: show.html weather uses sessionStorage with 30-min TTL — preserve to reduce API calls.
9. **Leaderboard collapsible state**: Collapsed by default (header shows preview), expand on click — preserves page height on load.
10. **Day sorting reverse**: When sorting classes by day, API returns date ASC, but UI reverses to show most-recent day first.
