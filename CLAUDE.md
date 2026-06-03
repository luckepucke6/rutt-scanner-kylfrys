# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Rutt-scanner** is a mobile web app for terminal staff at Kyl & Frys Expressen, a refrigerated logistics company.

**Problem it solves:** Every morning staff handle physical route sheets containing KOF numbers (6-digit identifiers tied to delivery stops). Looking up a KOF manually used to take up to an hour — the app reduces that to seconds.

**How it works:** Staff photograph the route sheets at the start of shift → Claude API extracts KOF data → stored in Supabase → anyone on shift can instantly look up any KOF.

**UX constraints:** Cold warehouse environment — large touch targets, one-handed use, glove-compatible interface. Live camera KOF scanning was tested and removed; manual text input proved faster in practice.

**Status:** Internal tool under active commercialization (Lucas is productizing it for sale to the employer).

---

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

## Do's and Don'ts

**Never use mock data** — no stubs, fakes, or hardcoded test data. All tests run against the real Claude API and real Supabase. Use `test.js` with a real key.

**Everything stays in `index.html`** — never split into separate JS or CSS files. The project is intentionally single-file for simple GitHub Pages deployment.

**i18n for all UI text** — new visible strings must be added to the `LANGS` object (sv/en/ru) and accessed via `t()` or `tf()`. Never hardcode Swedish strings directly in HTML.

**Mobile-first, cold-warehouse UX** — no hover-only primary interactions. Touch targets minimum 44×44 px. Assume the user has gloves on and is using one hand in a cold environment.

---

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

`routeData[kof].units` is an integer — the sum of pall+bur+hlv for that entry. Note: `driver`, `pall`, `bur`, `hlv`, and `confidence` are kept in memory only and are **not** synced to Supabase.

`routeData` is persisted to `localStorage` under key `rutt_scanner_v1` with an 8-hour expiry. The API key is stored separately under `rutt_api_key`.

### Four-tab UI

- **Routes tab** — Grouped view of all loaded stops, sorted by route number (default tab)
- **Search tab** — Type-ahead search over KOF numbers (manual input only — no live camera)
- **Scan tab** — Upload/photograph printed route sheets → full scan pipeline → merge into `state.routeData`. Includes `cancelProcessing()` which aborts the active fetch via `state.abortController` and resets processing state.
- **Guide tab** — Static HTML with 4 instructional sections and inline SVG illustrations; all text nodes use `data-i18n` for full translation support.

### Scan pipeline (step by step)

For **photo uploads** (non-PDF):

```
File selected
  → [toJpeg] (resize to max 1600px, q=0.88, corrects all 8 EXIF orientations)
  → [detectRotation] (Haiku, 400px preview image, returns 0/90/180/270)
  → [applyRotation] (canvas rotation if needed)
  → [callClaudeApi] (Opus, PROMPT constant, max_tokens 3000)
      returns: { routeNumber, driver, entries[{ kof, store, pall, bur, hlv, units, route, confidence }] }
  → [validateEntry] (filters out invalid entries)
  → [showObligReview] (always shown — user must confirm data before it is saved)
  → [runJudge] (runs in parallel via callClaudeJudge, Haiku, JUDGE_PROMPT, max_tokens 200)
      returns: { approved, confidence, issues[] }
      → If approved=false OR confidence<70:
          [revertEntries] → [showScanReview] (user must approve / edit / reject / retry)
  → On user approval (either flow):
      [storeEntries] → state.routeData
      [saveToStorage] → localStorage
      [saveToSupabase] → route_entries.upsert
      [uploadScanImage] → scan_images.insert (gets UUID, back-fills scanImageId on KOFs)
      [logJudge] → judge_logs.insert
```

For **PDF uploads**: `handleFileSelect` → `splitPdfToImages` (pdf.js, 2× scale, each page → JPEG) → each page enters the pipeline above, skipping the rotation detection step.

**Two review modals — do not confuse them:**
- `showObligReview` — shown for every scan regardless of judge result; user confirms the extracted data before it is committed
- `showScanReview` — shown only when the judge flags a problem (`approved=false` or `confidence<70`); lets user approve, edit entries manually, reject, or re-run extraction

### Claude API usage

Three active calls to `https://api.anthropic.com/v1/messages`:

| Function | Purpose | Model | max_tokens |
|---|---|---|---|
| `callClaudeApi(dataUrl)` | Route sheet extraction | `claude-opus-4-8` | 3000 |
| `callClaudeJudge(dataUrl, result)` | Quality verification | `claude-haiku-4-5-20251001` | 200 |
| `detectRotation(dataUrl)` | Photo orientation | `claude-haiku-4-5-20251001` | 10 |

All calls include the `anthropic-dangerous-direct-browser-access: true` header (required for direct browser→API access without a proxy).

**`callClaudeApi`** uses the `PROMPT` constant which is critical — it defines exactly how the blank-row separator splits entries into "Rutt N" vs "SN" sections via the `isS` / `route` field.

**`callClaudeJudge`** uses the `JUDGE_PROMPT` constant. It verifies KOF digits match the image and that route assignments are correct. Failsafe: if the API call itself fails, it returns `{ approved: true, confidence: 100, issues: [] }` to avoid blocking the user.

### Route naming convention

Each route sheet has two sections separated by a blank row:
- Rows above the blank → stored as `"Rutt N"` (e.g. `"Rutt 4"`)
- Rows below the blank → stored as `"SN"` (e.g. `"S4"`)

The route number is extracted from the header: `"Rutt 4- 161 Xhulijo"` → routeNumber `"4"`, driver `"161 Xhulijo"`.

### Supabase integration

`sb` is a module-level Supabase client initialized in `initSupabase()`. All Supabase calls are fire-and-forget unless data is being loaded.

**Tables and columns written by the app:**

`route_entries` — primary data store, upserted on conflict of `kof`:
- `kof` — 6-digit string (primary key)
- `route` — "Rutt N" or "SN"
- `store_name` — store address/name
- `units` — integer (pall+bur+hlv sum)
- `sort_order` — integer, position in scanned document
- `scan_image_id` — UUID reference to `scan_images.id`

`scan_images` — uploaded scan photos (non-PDF only):
- `image_data` — JPEG dataUrl (900px, q=72%)
- `id` — UUID (auto-generated, returned and stored in state)

`judge_logs` — one row per judge evaluation:
- `scanned_at`, `route`, `approved`, `confidence`, `issues`, `kof_count`, `user_action`, `manual_changes`

`scan_logs` — one row per completed scan batch:
- `scanned_at`, `route_count`, `unit_count`

`search_logs` — one row per search event:
- `kof`, `route_found`, `success`, `device_id`, `searched_at`, `response_time_ms`, `session_id`, `manual_baseline_ms`

`session_segments` — analytics (10-minute inactivity cutoff):
- `segment_start`, `segment_end`, `duration_minutes`, `search_count`, `session_date`, `device_id`

**Sync flow:** On startup, `loadFromSupabase()` fetches all current `route_entries` and their associated `scan_images`, sets `state.supabaseLoadedAt`, and clears the `localStorage` cache. Realtime changes are subscribed via `initRealtimeSync()` (postgres_changes on `route_entries`); a polling fallback kicks in if realtime is unavailable. Remote changes trigger `onRemoteChange()` which debounces a full reload.

Each device gets a stable UUID stored under `rutt_device_id` in `localStorage`.

### Language support

`LANGS` object has three entries: `sv` (Swedish, default), `en` (English), `ru` (Russian). `loadLang()` auto-detects Russian via `navigator.language` if no saved preference in `localStorage` (`rutt_lang` key), otherwise defaults to Swedish. The easter egg section `#easterEggRu` in the Scan tab is only visible when `state.lang === 'ru'`.

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
