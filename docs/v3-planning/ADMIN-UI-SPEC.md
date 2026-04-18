# Admin Page UI Spec — v3
### Every button, control, workflow, and endpoint of the v2 admin page, documented for v3 preservation

This is the show-management control surface. v2's admin page is what Bill uses to create shows, configure rings, upload classes, set flags, reactivate completed shows, and watch ring health. Functionality must be preserved in full. v3 modernizes the internals (shared modules, auth on backend, observability hooks) but the admin workflow stays.

---

## Overview & Architecture

- **File:** `/admin.html` (v2) — 1,371 lines as of this catalog
- **Primary endpoints:** `/admin/*` routes in `west-worker.js`
- **Auth model (v2):** Client-side password gate (`'ADMIN'`) + hardcoded API key (`'west-scoring-2026'`) — **FLAGGED for v3 as BLOCKING before public launch**
- **Session persistence:** Browser localStorage for auth key
- **Watcher polling:** 10-second interval checks online/offline status per ring

---

## Page Layout & Navigation

### Header (sticky, persistent)
- Logo block: WEST / Scoring Live wordmark (clickable → links to `index.html`)
- Badge: "Admin" tag (monospace, uppercase)
- Style: Black background, red 3px bottom border, height 56px

### Main Page Structure
- **Auth Gate** (visible on first load): password entry → hides on successful auth
- **Admin UI** (hidden until auth): max-width 900px container, 20px left/right padding

### No tab navigation
Admin is **single-column, linear scroll** — all features vertically stacked. No tabs, sidebars, or navigation menus. User scrolls through:
1. Database Control Panel (stats + actions)
2. Show List (searchable)
3. New/Edit Show Form (inline, toggleable)
4. Class Modal (overlay, triggered from show details)

---

## Section 1 — Authentication Gate

**Location:** `#auth-gate` (div, full-height center flex)
**Visibility:** Display until password matches

### Auth Key Input
- Type: Password input (`type="password"`)
- ID: `#auth-input`
- Placeholder: "Auth key"
- Blur + focus border highlight (black on focus)
- Autocomplete: `off`

### Enter Button
- Type: Primary button (black bg, white text)
- Label: "Enter" (all-caps)
- Onclick: `doAuth()`
- Keyboard: Listens to Enter key on input field

### Error Message
- ID: `#auth-err`
- Hidden by default, shown on failed auth
- Text: "Invalid key — try again"
- Auto-hides after 3 seconds
- Color: Red (var(--red))

### Auth Flow
```
doAuth()
  → read input value
  → compare to hardcoded ADMIN_PW = 'ADMIN'
  → if match: set AUTH_KEY = WORKER_KEY, hide gate, show admin-ui, call loadShows() + loadDbStats() + loadAdminSettings()
  → if no match: showAuthErr() → display message 3s → hide
```

**v3 MUST fix:** Move auth to backend endpoint (OAuth, JWT, or short-lived tokens). Remove hardcoded secrets from client code.

---

## Section 2 — Database Control Panel

**Location:** Top of `#admin-ui`
**Style:** White card, flex row with wrap, 20px gaps
**Responsive:** Stacks to single column on mobile

### 2A — Database Stats

**Label:** "Database" (monospace, uppercase, muted gray)

**Stat cards** (4 columns, `#db-stats`, light gray bg, center text):
1. **Shows Counter** — ID `#db-shows`, initial "—", loaded via `/admin/dbStats` GET
2. **Classes Counter** — `#db-classes`, count of all classes across all shows
3. **Entries Counter** — `#db-entries`, count of all competitor entries
4. **Results Counter** — `#db-results`, count of result rows (per-entry per-round scoring data)

### 2B — Database Action Buttons

**Layout:** Flex row, wrap, margin-top 12px

**Reload Data**
- Label: "↻ Reload"
- Type: Ghost (white bg, light border), small
- Onclick: `loadShows()` — fetches `/admin/shows` again, refreshes show list

**Clear All Live KV**
- Label: "Clear All Live KV"
- Type: Ghost, small
- Onclick: `clearAllLive()`
- Confirmation: `confirm()` dialog: "Clear ALL live KV data across all shows/rings?"
- Action: Loops all shows/rings, DELETE `/admin/clearLive?slug=X&ring=Y` for each
- Feedback: Toast "Cleared live KV for N ring(s)"
- Safety: Does NOT delete D1 data, only KV (live entry snapshots)

**Run Migrations**
- Label: "Run Migrations"
- Type: Ghost, small
- Onclick: `runMigrations()`
- Action: POST `/admin/migrate` — executes database schema migrations, returns results array
- Feedback: Toast "Migrations: N applied, M skipped"

**Delete All Data** ⚠️
- Label: "☠ Delete All Data"
- Type: Danger (red bg, white text), small
- Onclick: `nukeAll()`
- Confirmation flow (2-stage):
  1. Prompt for admin password: "Type the admin password to confirm DELETE ALL DATA:"
  2. Verify password = current AUTH_KEY (not the original password)
  3. Final confirm: "FINAL WARNING: This deletes ALL shows, classes, entries, and results. Continue?"
- Action: DELETE `/admin/clearAll` — wipes entire D1 database (cascade)
- Affected data: shows, classes, entries, results tables (all)
- After: calls `closeDetail()`, refreshes shows list and stats
- Visual: Danger red, clearly marked destructive

**v3 note:** `closeDetail()` is referenced but NOT DEFINED anywhere in v2. Broken reference. v3 must implement or remove.

### 2C — Global Settings

**Label:** "Global Settings" (monospace, uppercase, muted)

**Toggle: Hide Upcoming Shows**
- Label: "Hide Upcoming Shows"
- Subtext: "Hide shows with no data from public"
- ID: `#s-hide-upcoming`
- Type: Custom toggle (checkbox + styled slider)
- Onchange: `saveSetting('hideUpcoming', this.checked)`
- Action: POST `/admin/settings` with `{hideUpcoming: true/false}` — stored in KV under `'settings'` key
- Affects: Public-facing show list (index.html) filters by this toggle
- Feedback: Toast "hideUpcoming: ON" or "hideUpcoming: OFF"

**Toggle: Course Difficulty Gauge**
- Label: "Course Difficulty Gauge"
- Subtext: "Show difficulty meter on stats page"
- ID: `#s-difficulty`
- Type: Custom toggle
- Onchange: `saveSetting('showDifficultyGauge', this.checked)`
- Action: POST `/admin/settings` with `{showDifficultyGauge: true/false}`
- Affects: Stats page display conditionally renders difficulty gauge
- Feedback: Toast "showDifficultyGauge: ON" or "showDifficultyGauge: OFF"

**Loading:** Both toggles populated on page load via `loadAdminSettings()` → GET `/admin/settings` (no auth required for read)

---

## Section 3 — Show List & Search

### Section Header
- Title: "Shows" (Playfair Display serif, 22px, bold)
- Subtitle: `#shows-count` — dynamically populated: "N show(s)" or "No shows yet"
- Button: "+ New Show" (primary, small)
  - Onclick: `openNewShow()` — clears form, shows form card, scrolls into view

### Search Input
- Type: Text input
- ID: `#show-search`
- Placeholder: "Search shows..."
- Oninput: `filterShows()` (real-time filtering)
- Width: 100%
- Behavior: Case-insensitive substring match on `name || slug || venue || dates`

### Show List Container
- ID: `#shows-list`
- Initial state: Loading spinner (`.loading` div)
- Empty state: Icon + "No shows yet — click + New Show"

### Show Item Row (repeated per show)
- Class: `.show-item` (white card, 1px border, rounded)
- Onclick: `toggleShow('${slug}')` — expands/collapses detail panel below
- Selected state: `.selected` class adds 2px black border (instead of 1px)
- Hover: Border color → black

**Show item layout** (flex, gap 12px):

1. **Show Info Block** (flex:1, min-width:0)
   - Name: `.show-name` — Playfair Display, 17px, bold, text `s.name || s.slug`, ellipsis on overflow
   - Metadata `.show-meta` (flex, wrap, gap 8px, margin-top 3px):
     - Slug: `.show-slug` — monospace, 11px, muted, text `s.slug`
     - Dates: `.show-dates` — monospace, 11px, muted, text "· MONTH DD – MONTH DD, YEAR" (if dates exist)
     - Venue: `.show-dates` — text "· VENUE" (if present)
     - Ring count: `.show-dates` — text "· N ring(s)"

2. **Badges Block** (flex, gap 4px, flex-shrink:0)
   - Status badge (one of):
     - `.badge-active` (green): "Active" (if `status === 'active'`)
     - `.badge-pending` (amber): "Pending" (if `status === 'pending'`)
     - `.badge-complete` (light gray): "Complete" (default)
   - Class summary badge (light gray): Text "N open · M done / T" (if `class_total > 0`), from `show.class_active`, `show.class_complete`, `show.class_total`
   - Stats ineligibility badge (pink): `.badge-ineligible` "No Stats" (if `stats_eligible === false`)

3. **Right Controls Block** (monospace, 10px, muted, flex, gap 6px)
   - Expand/collapse indicator: "▼ Close Properties" (expanded) OR "▶ Show Properties" (collapsed)

### Expanded Show Detail Panel

**Trigger:** Click show item
**Behavior:** Renders inline between show items using conditional template
**Style:** White card, 2px solid black border, rounded, 20px padding

---

## Section 4 — Expanded Show Controls (Detail Panel)

### 4A — Show Controls Toolbar

**Layout:** Flex row, wrap, gap 8px

**Edit Show Details**
- Label: "Edit Show Details"
- Type: Ghost, small
- Onclick: `editShow('${s.slug}')`
- Action: Fetches `/admin/showData?slug=${slug}`, populates form, shows form card, disables slug field (no rename)
- Form changes: Button text → "Save Changes", Title → "Edit Show"

**Set Pending**
- Label: "Set Pending"
- Type: Ghost, small
- Onclick: `setShowStatus('${s.slug}', 'pending')`
- Action: POST `/admin/updateShow` with `{slug, status: 'pending'}`
- Feedback: Toast "slug → pending"

**Set Active**
- Label: "Set Active"
- Type: Ghost with red text/border, small
- Onclick: Wrapped in `confirm()`: "Reopen this show? The watcher will be able to write data again."
- Action: POST `/admin/updateShow` with `{slug, status: 'active'}`
- Side effect: Worker auto-bumps `end_date` to today if it was stale
- Feedback: Toast "slug → active"

**Set Complete**
- Label: "Set Complete"
- Type: Ghost, small
- Onclick: `setShowStatus('${s.slug}', 'complete')`
- Action: POST `/admin/updateShow` with `{slug, status: 'complete'}`
- Feedback: Toast "slug → complete"

**Clear Live KV**
- Label: "Clear Live KV"
- Type: Ghost, small
- Onclick: Wrapped in `confirm()`: "Clear live KV data for ${slug}?"
- Action: DELETE `/admin/clearLive?slug=${slug}&ring=1`
- **v2 bug to fix in v3:** ring hardcoded to 1 — should loop all rings
- Feedback: Toast "Live KV cleared"

**Delete Show**
- Label: "Delete Show"
- Type: Danger, small
- Onclick: `deleteShow('${s.slug}')`
- Workflow (2-phase):
  1. POST `/admin/deleteShow` with `{slug}` (no confirm flag) — returns preview with counts
  2. Display confirm dialog: 'Delete "slug"?\n\n• N classes\n• M entries\n• P result rows\n\nThis cannot be undone.'
  3. If user confirms: POST `/admin/deleteShow` with `{slug, confirm: true}` — cascade-deletes all D1 data
  4. On success: Clear `currentSlug`, reload shows, reload stats, toast "slug deleted"
- Affected data: Shows (1), classes (all), entries (all), results (all)

### 4B — Show Statistics Eligible Toggle

**Layout:** `.toggle-row` (flex between)

- Label: "Statistics Eligible"
- Subtext: "Include this show in stats calculations"
- ID: `#stats-toggle-${slug}`
- Type: Custom toggle
- Initial state: Checked if `s.stats_eligible === 1`
- Onchange: `setStatsEligible('${slug}', this.checked)`
- Action: POST `/admin/updateShow` with `{slug, stats_eligible: 1|0}`
- Feedback: Toast "Stats eligible: ON" or "Stats eligible: OFF"
- Local update: Updates `allShows` cache immediately (no reload)

### 4C — Rings Management Card

**Card title:** "Rings" (with note: "Ring order will reflect the public site")

**Rings list** (`#ring-list-${slug}`):
- Initial state: "Loading rings..." spinner
- Rendered layout: Table-like structure
- Header row: "WATCHER #" | "RING NAME" | (spacers for buttons)
- Data rows: One per ring in show

**Per-ring row:**
1. Ring number (`.ring-num`): Text like "1", "2", etc.
2. Ring name input (`.ring-name-input`): Text field, editable
   - ID: `#rn-${slug}-${ring_num}`
   - Onchange: `saveRingName('${slug}', '${ring_num}', this.value)`
   - Placeholder: "Ring N name..."
3. Order up/down buttons (pair, `.ring-order-btns`):
   - Up arrow: `↑` onclick `moveRing('${slug}', ${index}, -1)`
   - Down arrow: `↓` onclick `moveRing('${slug}', ${index}, 1)`
   - Both no-op if at boundary
4. Delete ring button:
   - Red text, red border
   - Label: "Delete Ring"
   - Onclick: Wrapped in confirm: "Delete ring ${ring_num}? This does not delete classes assigned to it."
   - Action: DELETE `/admin/deleteRing?slug=${slug}&ring_num=${ring_num}`
   - Feedback: Toast "Ring N deleted"
   - Refreshes rings list + reloads shows (to update rings_count badge)

**Add Ring Button:**
- Label: "+ Add Ring"
- Type: Ghost, small
- Onclick: `addRing('${slug}')`
- Behavior:
  1. Calculates next ring number (max existing + 1, or 1 if empty)
  2. Prompts: "Ring name (optional):" with default "Ring N"
  3. Cancel = no action
  4. Confirm: POST `/admin/upsertRing` with `{slug, ring_num: nextNum, ring_name: name, sort_order: currentLength}`
  5. Toast "Ring N added", reload rings, reload shows

### 4D — Watcher Status Card

**Card title:** "Watcher Status"

**Layout:** One status block per ring (or error message if no rings)

**Per-ring watcher status row** (ID: `#watcher-status-${slug}-${ring}`, flex, gap 10px, align center):

1. **Status dot** (`.watcher-dot`, ID `#watcher-dot-${slug}-${ring}`):
   - 8x8px, circular
   - Default: Gray background
   - Alive: Green background + blinking animation (fade 1→0.3→1 over 1.6s)
   - Data source: Polled from `/getLiveClass?slug=${slug}&ring=${ring}` every 10 seconds

2. **Status text** (`.watcher-text`, ID `#watcher-text-${slug}-${ring}`):
   - Monospace, 11px
   - Alive template: "Ring N — Online [since Xh Ym] [· v0.0.0] [· M classes active] [· selected: CLASS_NUM]"
   - Offline template: "Ring N — Offline [· vX.X.X] [· Last seen MMM D, H:MM AP]"
   - Never connected: "Ring N — Never connected"

3. **Open Display button:**
   - Label: "Open Display"
   - Type: Ghost, small
   - Onclick: `window.open('display.html?slug=${slug}&ring=${ring}', '_blank')`
   - Action: Opens the public scoreboard display in a new tab

4. **Export Config button:**
   - Label: "Export Config"
   - Type: Ghost, small
   - Onclick: `exportWatcherConfig('${slug}', '${ring}')`
   - Action: Generates JSON config, triggers browser download as `config.json`, toast "Ring N config downloaded"
   - Use case: Operator downloads config.json, drops into `c:/west/` on scoring PC alongside `west-watcher.js`
   - Exported config fields:
     ```json
     {
       "workerUrl": "https://west-worker.bill-acb.workers.dev",
       "authKey": "west-scoring-2026",
       "slug": "show-slug",
       "ring": "1",
       "showName": "Show Name Here"
     }
     ```

**Error state** (no rings):
- Message: "No watchers available — create a ring first (Rings section above)."
- Style: Red border, light red bg, red text, monospace

**Helper text** (if rings exist):
- "Export Config → download config.json for that ring. Drop it into c:/west/ on that ring's scoring PC alongside west-watcher.js."

### 4E — Live Classes Card

**Card title:** "Live Classes" with "Edit All Classes" button (top right, ghost small, onclick `openClassModal('${slug}')`)

**Content ID:** `#live-classes-${slug}`

States:
- Initial: "Checking..."
- Empty: "No classes currently live"
- Populated: List of currently-scoring entries

**Per-live-class row:**
1. Ring indicator: "R1", "R2", etc. (monospace, 10px, muted)
2. Class number: Bold, red text
3. Class name (if any)
4. Time ago: "just now", "2m ago", etc. (monospace, 9px, muted)
5. **Remove Live button** (small, red text/border):
   - Onclick: `removeLiveClass('${slug}', ${ring}, '${classNum}')`
   - Action: POST `/admin/removeLiveClass` with `{slug, ring, classNum}` — removes from live KV active classes array
   - Feedback: Toast "Class ${classNum} removed from live"
   - Refreshes live classes list

### 4F — Class Summary Stats Card

**Card title:** "Class Summary"

**Layout:** 3-column stat boxes
1. Classes box (`#stat-classes`) — total count
2. Active box (`#stat-active`) — count where `status === 'active'`
3. Complete box (`#stat-complete`) — count where `status === 'complete'`

Initial state: "—" (em-dash)
Data source: Loaded via `loadDetail()` → `/getClasses?slug=${slug}` (with auth header to see all classes including hidden)

---

## Section 5 — New/Edit Show Form

**ID:** `#show-form`
**Initial display:** `display:none`
**Trigger:** Click "+ New Show" or "Edit Show Details"

### Form Header
- Title ID: `#form-title` — "New Show" OR "Edit Show"
- Close button: `×` onclick `closeForm()` — hides form, resets, clears cache

### Form Fields (`.form-grid`, 2-column layout)

**Show Name**
- Label: "Show Name"
- ID: `#f-name`
- Type: Text input
- Placeholder: "HITS Culpeper Spring I"
- Width: Full (`.form-full`)

**Slug**
- Label: "Slug *" (red asterisk = required)
- ID: `#f-slug`
- Type: Text input, monospace class
- Placeholder: "hits-culpeper-spring-1"
- Hint: "Must match config.json slug on scoring PC"
- Disabled in edit mode: `disabled = true`
- Processing: `submitShow()` lowercases + replaces spaces with hyphens

**Start Date**
- Label: "Start Date"
- ID: `#f-start-date`
- Type: `<input type="date">` (HTML5 date picker)
- Stored in DB as: `YYYY-MM-DD` ISO format

**End Date**
- Label: "End Date"
- ID: `#f-end-date`
- Type: `<input type="date">`
- Note: Worker auto-bumps to today if show reactivated and stale

**Venue**
- Label: "Venue"
- ID: `#f-venue`
- Type: Text input
- Placeholder: "Commonwealth Park"

**Location**
- Label: "Location"
- ID: `#f-location`
- Type: Text input
- Placeholder: "Culpeper, VA"

### Form Toggle: Statistics Eligible
- Label: "Statistics eligible"
- Subtext: "Include in stats calculations"
- ID: `#f-stats`
- Type: Custom toggle
- Default: Checked (true)

### Form Actions
- Cancel button (ghost): Onclick `closeForm()`
- Submit button (primary): ID `#submit-btn`
  - New mode: "Create Show"
  - Edit mode: "Save Changes"
  - Onclick: `submitShow()`

### Submit Flow
1. Validation: Slug required (error toast if empty)
2. Data assembly:
   - Slug: lowercase + space → hyphen
   - Dates: format as "MMM D – D, YYYY" range (via `formatDateRange()`)
   - Endpoint: `/admin/createShow` (new) or `/admin/updateShow` (edit)
3. Request body:
   ```json
   {
     "slug": "string (required)",
     "name": "string (optional)",
     "dates": "formatted string",
     "start_date": "YYYY-MM-DD",
     "end_date": "YYYY-MM-DD",
     "venue": "string",
     "location": "string",
     "stats_eligible": boolean
   }
   ```
4. On success: Toast 'Show "slug" created' or "Show updated", hide form, reload shows, reload DB stats, reset form
5. On error: Toast (red): error message

---

## Section 6 — Class Modal (Overlay)

**ID:** `#class-modal`
**Trigger:** Click "Edit All Classes" in Live Classes card
**Dismiss:** Click backdrop, press close button, or `closeClassModal()`

### Modal Structure
- Background: Dark overlay (`rgba(0,0,0,0.55)`)
- Container: Flex center, 90% width, max 700px, max 85vh
- Content: White card, scrollable body

### Modal Header
- Title ID: `#class-modal-title` — text "Classes — SHOW_NAME"
- Search input ID: `#class-modal-search`
  - Type: Text
  - Placeholder: "Search by name or number..."
  - Oninput: `filterModalClasses()` (real-time)
- Close button: `×` onclick `closeClassModal()`

### Modal Filter Bar (ID `#class-modal-filters`)

**Layout:** Flex, gap 6px, wrap

**Upload .cls File Button**
- Label: "Upload .cls File"
- Type: Ghost, small
- Onclick: `triggerClsUpload('${slug}', '1')`
- Behavior:
  1. Creates hidden file input, `accept=".cls"`
  2. On file select:
     - Reads file as text via `file.text()`
     - Parses CSV header + entry rows via `parseClsFile()`
     - Extracts classNum from filename (strip `.cls`)
     - If class doesn't exist: confirm "Class ${classNum} does not exist for this show. Upload as a new class?"
     - If name mismatch: confirm 'Class ${classNum} exists as "OLD_NAME" but file says "NEW_NAME". Continue?'
     - POST `/admin/uploadCls` with parsed class data + raw text + slug + ring
     - Toast "Class N uploaded (new)" or "uploaded (updated)"
     - Refreshes detail + re-renders modal
- **v2 bug to fix in v3:** ring hardcoded to 1 — should allow operator to select ring before upload

**Ring Filter Buttons**
- Dynamic: One button per ring + "All Rings"
- Type: Ghost, small, toggles `.active` on click
- Onclick: `setModalRing('all')` or `setModalRing('${ring}')`
- Filters modal classes by ring (overridden by search term)
- Visual: Active ring has black bg + white text

### Modal Body (ID `#class-modal-body`)

**Initial:** Empty (populated on open)
**Layout:** Scrollable list of class rows

**Per-class row** (`.modal-class-row`, flex, gap 8px, align center, padding 10px 20px, border-bottom):

1. Ring label (monospace, 9px, muted): "R${class.ring}"
2. Class number (`.mcr-num`, monospace, 12px, red): `class.class_num`
3. Class name (`.mcr-name`, 13px): `class.class_name || '—'`, ellipsis on overflow
4. Status badge (`.mcr-badges`): "Done" badge if `status === 'complete'` (light gray) OR "Active" badge otherwise (green)
5. Checkboxes block (`.mcr-checks`, flex, gap 12px):

   **Checkbox: Hidden**
   - Label: "Hidden"
   - Checked: if `class.hidden === 1`
   - Onchange: `toggleClassField('${slug}', '${classNum}', 'hidden', this.checked)`
   - Action: POST `/admin/updateClass` with `{slug, ring: '1', classNum, hidden: 1|0}`
   - Effect: Hides class from public results page
   - Feedback: Toast "Class N hidden: ON"
   - **v2 bug to fix in v3:** ring hardcoded to 1 — pass ring from modal context

   **Checkbox: No Stats**
   - Label: "No Stats"
   - Checked: if `class.stats_exclude === 1`
   - Onchange: `toggleClassField('${slug}', '${classNum}', 'stats_exclude', this.checked)`
   - Action: POST `/admin/updateClass` with `{slug, ring: '1', classNum, stats_exclude: 1|0}`
   - Effect: Excludes class from stats calculations
   - Feedback: Toast "Class N stats_exclude: ON"

6. Actions block (`.mcr-actions`):
   - If status != 'complete': "Done" button
     - Onclick: `markComplete('${classNum}')`
     - Action: POST `/admin/completeClass` with `{slug: currentSlug, ring: '1', classNum}`
     - Feedback: Toast "Class N marked complete"
     - Refreshes detail

**Modal search behavior:**
- Override: Search term overrides ring filter (shows all matches from any ring)
- Matching: Case-insensitive substring on `class_num` or `class_name`

---

## Section 7 — Toasts & Feedback

**Element:** `#toast` (fixed bottom-center)

**Styling:**
- Black background, white text, monospace
- 12px font
- Positioned bottom 24px, horizontal center
- Slides up from bottom on show (translateY animation)
- Auto-dismisses after 2.8 seconds

**Display methods:**
- `toast(msg)` → success (black bg)
- `toast(msg, true)` → error (red bg)

**Usage examples:**
- 'Show "slug" created'
- "Invalid key — try again"
- "Class 123 uploaded (new)"
- "Ring order updated"
- "Password does not match — cancelled"

---

## Worker Endpoints Reference (admin-specific)

**All /admin/* endpoints require `X-West-Key` header except where noted.**

| Endpoint | Method | Body / Params | Purpose |
|---|---|---|---|
| `/admin/shows` | GET | — | Returns all shows with status, counts, dates |
| `/admin/showData?slug=X` | GET | — | Returns full show object for edit form population |
| `/admin/createShow` | POST | `{slug, name, dates, start_date, end_date, venue, location, stats_eligible}` | Creates new show + auto-creates Ring 1 |
| `/admin/updateShow` | POST | `{slug, ...fieldUpdates}` | Partial update; auto-bumps end_date if activating |
| `/admin/deleteShow` | POST | `{slug}` or `{slug, confirm: true}` | Preview (counts) or cascade-delete |
| `/admin/rings?slug=X` | GET | — | Returns all rings for a show |
| `/admin/upsertRing` | POST | `{slug, ring_num, ring_name, sort_order}` | Creates or updates a ring |
| `/admin/deleteRing?slug=X&ring_num=Y` | DELETE | — | Removes ring (does not delete classes) |
| `/admin/uploadCls` | POST | parsed class object + raw text + slug + ring | Creates or updates class + all entries |
| `/admin/updateClass` | POST | `{slug, ring, classNum, hidden?, stats_exclude?, status?}` | Updates class flags |
| `/admin/completeClass` | POST | `{slug, ring, classNum}` | Marks class status → 'complete' |
| `/admin/removeLiveClass` | POST | `{slug, ring, classNum}` | Removes from active KV array |
| `/admin/clearLive?slug=X&ring=Y` | DELETE | — | Clears all KV live data for a ring |
| `/admin/clearAll` | DELETE | — | Wipes entire D1 database |
| `/admin/migrate` | POST | — | Executes schema migrations, returns results |
| `/admin/dbStats` | GET | — | Returns counts: shows, classes, entries, results |
| `/admin/settings` | GET (no auth) | — | Returns global settings object (showDifficultyGauge, hideUpcoming) |
| `/admin/settings` | POST | partial settings object | Saves to KV |

---

## Implicit Workflows

### Create a new show from scratch
1. Click "+ New Show"
2. Fill form: name, slug, dates, venue, location, toggle stats
3. Click "Create Show"
4. Worker creates show + auto-creates Ring 1
5. Admin UI reloads shows
6. New show appears with Pending status + 1 ring

### Upload classes via .cls file
1. Expand show details
2. Click "Edit All Classes"
3. Modal opens, click "Upload .cls File"
4. Select file from scoring PC
5. If new class: confirm creation
6. If existing class name mismatch: confirm overwrite
7. POST parses class header + entries, creates/updates D1 records
8. Modal re-renders, shows new class in list
9. Detail panel updates stats

### Reactivate a completed show
1. Find show in list, click to expand
2. Status is "Complete"
3. Click "Set Active"
4. Confirmation dialog: "Reopen this show? Watcher will be able to write again."
5. Worker updates status to 'active' + auto-bumps end_date to today
6. Watcher can immediately begin posting new data

### Mark a class as complete
1. Open class modal via "Edit All Classes"
2. Find class in list
3. If not already complete: "Done" button appears
4. Click "Done"
5. POST `/admin/completeClass` → status → 'complete'
6. Row updates instantly, "Done" button disappears

### Delete an entire show
1. Expand show details
2. Click "Delete Show" button
3. First POST shows preview: 'Delete "slug"? • N classes • M entries • P results. Cannot undo.'
4. User confirms
5. Second POST with confirm flag cascade-deletes
6. Show removed from list, detail panel closed, stats refreshed

---

## Responsive & Mobile Behavior

**Breakpoint:** 600px

**Changes:**
- `.form-grid.cols3` → single column
- `.form-grid` (2-col) → single column
- `.detail-stats` (3-col) → stays 3-col (flexible grid)
- Show items + buttons stack naturally
- Modal max-width 90vw

**Touch considerations:**
- All buttons have 8-20px padding
- Checkboxes use native browser rendering (good for touch)
- No hover-only states
- Toast auto-dismiss (no close button needed)

---

## Keyboard Shortcuts (v2)

- Enter on auth input → submit password
- Enter in search field → trigger filterShows() (real-time, no submit needed)
- Enter in modal search → trigger filterModalClasses()

**v3 should add:**
- Escape to close modals
- Escape to close detail panel
- Ctrl+S to save form
- Tab navigation with focus indicators

---

## Visual Patterns

### Button styles (3 classes)
1. `.btn-primary` — black bg, white text, uppercase monospace (14px), creates/saves
2. `.btn-ghost` — transparent bg, 1px border, uppercase monospace (11px), secondary actions
3. `.btn-danger` — red bg, white text, uppercase monospace (11px), destructive

### Badge styles (4 variants)
1. `.badge-active` — green bg, green text
2. `.badge-pending` — amber bg, amber text
3. `.badge-complete` — gray bg, gray text
4. `.badge-ineligible` — pink bg, dark red text

### Input styles
- White bg, 1px gray border, rounded 8px, padding 10-12px
- Focus: border turns black
- Monospace class available for code inputs

### Card containers
- White bg, rounded 10px, 1px border, padding 20px
- Selected state: 2px solid black border
- Hover state: border color → black

### Stat boxes
- Light gray bg, rounded 6px, center-aligned text
- Title: monospace, 9px, uppercase, muted
- Number: Playfair Display, 24px, bold, black

### Modal overlay
- Dark semi-transparent (`rgba(0,0,0,0.55)`)
- Flex center, animates in/out
- Click backdrop to dismiss

---

## Broken / Incomplete Features (v2 → v3 punchlist)

1. **`closeDetail()` missing** — `nukeAll()` calls it but function doesn't exist. Would throw error if nukeAll executed. v3: implement or remove call.

2. **Hardcoded admin password** — `ADMIN_PW = 'ADMIN'` and `WORKER_KEY = 'west-scoring-2026'` visible in client source. Trivially reversible. BLOCKING before public launch. v3: move auth to backend endpoint, use OAuth/JWT or environment secrets.

3. **Ring hardcoded to '1' in multiple places:**
   - `triggerClsUpload('${slug}', '1')` — .cls upload only goes to ring 1
   - `toggleClassField('${slug}', '${classNum}', 'hidden', ...)` — class flags only update ring 1
   - Clear Live KV button in show controls
   v3: pass ring from modal/form context, or update endpoint to apply across all rings

4. **Missing activity/audit log UI** — session notes reference `/admin/activity` and `/admin/anomalies` endpoints (session 25). Worker may have them; no UI exposes them. v3: add "Activity Log" admin section reading from `parse_warnings`, `unknown_quirks`, `udp_anomalies` tables (per DATABASE-SCHEMA-EXPANSION.md).

5. **No session expiry** — once authed, stays authed until page reload. v3: implement short-lived tokens.

6. **No rate limiting on auth** — failed password attempts aren't throttled. v3: add rate limiting on auth endpoint.

7. **No admin action audit trail** — what Bill changed and when isn't logged. v3: D1 table `admin_actions` logging timestamp, admin_id, action_type, affected_resource.

---

## v3 Architecture Changes for Admin

The admin page functionality stays identical. What changes:

- **Auth moves to backend.** Backend validates, issues short-lived token, client uses token. No hardcoded secrets.
- **Shared modules apply.** Admin uses `WEST.format.*`, `WEST.display.*`, `WEST.data.*` like other pages. Modal, toast, confirm dialog become `WEST.display.modal/toast/confirm`.
- **Ring-context-aware actions.** No more hardcoded ring=1. Pass ring from context everywhere.
- **Observability UI.** New admin section showing parse_warnings, unknown_quirks, stats_rebuild_log, udp_anomalies. Review workflow: click anomaly → see raw context → mark resolved/ignored/codified.
- **Identity review queue UI.** New admin section for manual review of rider/horse identity merges (per DATABASE-SCHEMA-EXPANSION.md `identity_review_queue`).
- **Class rules enforcement.** Admin uses the shared v3 rules module for class kind detection + scoring method interpretation. No divergent logic from public pages.

---

## Preservation Checklist for v3

- [ ] All 18 admin endpoints implemented (or consolidated with clear reason for any removed)
- [ ] Every button/toggle/form field listed above has a v3 equivalent
- [ ] All implicit workflows still work
- [ ] Toast pattern preserved (bottom-center, auto-dismiss, red on error)
- [ ] Modal pattern preserved (dark overlay, close on backdrop click)
- [ ] Custom toggle visual (slider) preserved
- [ ] Badge color semantics preserved
- [ ] Watcher status dot + blink preserved
- [ ] Export Config button generates identical config.json shape (watcher compat)
- [ ] Auth gate UX preserved (even though underlying auth is new)
- [ ] Real-time watcher status polling preserved (10s cadence)
- [ ] Responsive breakpoint preserved (600px)
- [ ] 2-phase delete confirmation preserved (preview → confirm)
- [ ] Every known v2 bug (listed above) fixed in v3
- [ ] New observability UI added
- [ ] Identity review UI added
- [ ] Auth hardened
