# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step — open `index.html` directly in a browser, or serve it with any static file server:

```
python3 -m http.server 8080
```

The app requires a real Anthropic API key entered via the in-app UI on first use (stored in `localStorage`).

## Testing the Claude API integration

Drop route sheet images (`.jpg`, `.png`) into `test-images/`, then run:

```
ANTHROPIC_API_KEY=sk-ant-... node test.js
```

The script calls the real Claude API for each image, validates the response (6-digit KOFs, route names present, no duplicates, document order preserved), and exits non-zero on failure.

## Architecture

The entire application is a single file: `index.html`. It contains all HTML structure, CSS, and JavaScript. Two CDN scripts are loaded at runtime:
- `@supabase/supabase-js@2` — multi-device sync and analytics
- `pdf.js 3.11.174` — splits PDF files into per-page images before processing

### State model

A single `state` object is the source of truth:

```js
state.routeData      // { [kof: string]: { route, driver, store, pall, bur, hlv, units } }
state.images         // pending/processing image queue
state.apiKey         // Anthropic key loaded from localStorage
state.isProcessing
state.abortController  // AbortController for in-flight callClaudeApi fetch; null when idle
state.supabaseLoadedAt // timestamp when Supabase data was last fetched, or null
```

`routeData[kof].units` is an integer — the sum of pall+bur+hlv for that entry, extracted by the AI and persisted to Supabase. Requires a `units integer DEFAULT 0` column on `route_entries` (run `ALTER TABLE route_entries ADD COLUMN IF NOT EXISTS units integer DEFAULT 0;`).

`routeData` is persisted to `localStorage` under key `rutt_scanner_v1` with an 8-hour expiry. The API key is stored separately under `rutt_api_key`.

### Four-tab UI

- **Routes tab** — Grouped view of all loaded stops, sorted by route number (default tab)
- **Search tab** — Type-ahead search over KOF numbers; also supports live camera scanning via `scanFrame()` loop
- **Scan tab** — Upload/photograph printed route sheets → compress to JPEG → call Claude API → parse JSON → merge into `state.routeData`. Includes `cancelProcessing()` which aborts the active fetch via `state.abortController` and resets processing state.
- **Guide tab** — Static HTML with 4 instructional sections and inline SVG illustrations; all text nodes use `data-i18n` for full translation support.

### Claude API usage

Four distinct calls to `https://api.anthropic.com/v1/messages` using `claude-sonnet-4-6`:

1. **`callClaudeApi(dataUrl)`** — Sends a full route sheet image, returns structured JSON with `{ routeNumber, driver, entries[] }`. The prompt in `PROMPT` constant is critical: it defines how routes are split into "Rutt N" (main section) vs "SN" (S-routes, below a blank separator row) via the `isS` field.

2. **`callClaudeJudge(dataUrl, result)`** — Runs **in parallel** with result display after `callClaudeApi`. Sends the same image plus the extracted JSON, and asks Claude to verify that the data matches the document. Returns `{ approved, confidence, issues[] }`. If `approved: false` or `confidence < 70`, the image gets a `'warning'` status with "save anyway" / "retry" / "review" buttons. Judge results are logged to the `judge_logs` Supabase table.

3. **`detectRotation(dataUrl)`** — Called before `callClaudeApi` when the image is a photo (not PDF). Detects orientation so the image can be pre-rotated before OCR.

4. **`callClaudeForKof(dataUrl)`** — Sends a cropped camera frame, returns only the 6-digit KOF number or `NONE`. Uses `max_tokens: 20`.

All calls include the `anthropic-dangerous-direct-browser-access: true` header (required for direct browser→API access without a proxy).

### Route naming convention

Each route sheet has two sections separated by a blank row:
- Rows above the blank → `isS: false` → stored as `"Rutt N"` (e.g. `"Rutt 4"`)
- Rows below the blank → `isS: true` → stored as `"SN"` (e.g. `"S4"`)

The route number is extracted from the header: `"Rutt 4- 161 Xhulijo"` → routeNumber `"4"`, driver `"161 Xhulijo"`.

### Supabase integration

`sb` is a module-level Supabase client initialized in `initSupabase()`. All Supabase calls are fire-and-forget unless data is being loaded.

**Tables:**
- `route_entries` — primary data store, keyed on `kof`. Upserted by `saveToSupabase()` and `changeInlineRoute()`. Cleaned up after a time cutoff by `cleanupOldSupabaseData()`.
- `scan_images` — base64 image data. Images are uploaded by `uploadScanImage()` and associated with entries via `scanImageId`. Only non-PDF images are uploaded.
- `search_logs` — one row per search event, logged by `logSearch()`.
- `scan_logs` — one row per completed scan batch, logged by `logScan()`.
- `judge_logs` — one row per judge result, logged by `logJudge()`.
- `session_segments` — analytics segments (10-minute inactivity cutoff), logged by `logSegment()`.

**Sync flow:** On startup, `loadFromSupabase()` fetches all current `route_entries` and their associated `scan_images`, sets `state.supabaseLoadedAt`, and clears the `localStorage` cache. Realtime changes are subscribed via `initRealtimeSync()` (postgres_changes on `route_entries`); a polling fallback kicks in if realtime is unavailable. Remote changes trigger `onRemoteChange()` which debounces a full reload.

Each device gets a stable UUID stored under `rutt_device_id` in `localStorage`.

### Language support

`LANGS` object has three entries: `sv` (Swedish, default), `en` (English), `ru` (Russian). `loadLang()` auto-detects Russian via `navigator.language` if no saved preference in `localStorage` (`rutt_lang` key), otherwise defaults to Swedish. The easter egg section `#easterEggRu` in the Scan tab is only visible when `state.lang === 'ru'`.

### Camera scanner

`cam` object manages the live scan loop: every 2500 ms, `scanFrame()` captures the center 75%×35% of the video frame, compresses it, and calls `callClaudeForKof`. A 5-second cooldown prevents the same KOF from triggering multiple result updates.

### Session-only UI state

Four module-level `let` variables track transient UI state that resets on every page load (intentionally **not** in `state` and **not** persisted):

- `routesVerified` — set to `true` when user taps the "Jag har kontrollerat ✓" button in the Routes tab verification banner. The banner is shown whenever there are routes and this is `false`. Reset by `dismissRoutesVerify()`.
- `inlineEditKof` — the KOF number whose row is currently expanded for inline route-switching in the Routes tab table. Tapping a row sets it; tapping again or outside `#routesList` clears it. Saved by `changeInlineRoute(kof, newRoute)` which upserts to Supabase.
- `reviewViewMode` — `'routes'` or `'docs'`; controls which column is visible in the comparison view modal on narrow screens (<400 px). Updated by `setReviewView(mode)`.
- `editModalAfterClose` — optional `() => void` callback invoked when `editModal` closes (both save and cancel). Used to return to the route modal or comparison view when a KOF row is tapped from those contexts. Cleared immediately after being called.

### Comparison view (eye button)

`openRouteReview(routeName)` opens the `#routeReviewModal` bottom sheet with a **two-column layout**: route entries on the left, source document image on the right. On screens narrower than 400 px a toggle bar ("Rutter" / "Dokument") is shown instead; `setReviewView()` toggles `review-col-hidden` class on the columns (CSS-only show/hide so scroll positions are preserved).

Each KOF row in `#reviewBody` has a `data-kof` attribute and is tappable: clicking opens `editModal` for that KOF, and after saving/cancelling the comparison view reopens automatically (via `editModalAfterClose`).

### Route modal KOF list (pen button)

`openRouteModal(routeName)` renders a scrollable KOF list (KOF | BUTIK | EST columns) inside `#routeModalKofList` showing all entries for that route. Tapping a row closes the route modal and opens `editModal` for that KOF; after saving/cancelling the route modal reopens (via `editModalAfterClose`).
