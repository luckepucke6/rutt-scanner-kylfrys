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

No API key is entered in the app. The Anthropic key is held **server-side** by a Supabase Edge Function (`claude-proxy`), so the app works out of the box against the deployed proxy with no client configuration. The proxy reads its key from the Supabase secret `ANTHROPIC_API_KEY` (set under Project Settings → Edge Functions → Secrets). See [Server-side proxy](#server-side-proxy-claude-proxy) below.

## Testing the Claude API integration

Drop route sheet images (`.jpg`, `.png`) into `test-images/`, then run:

```
ANTHROPIC_API_KEY=sk-ant-... node test.js
```

The script calls the real Claude API for each image, validates the response (6-digit KOFs, route names present, no duplicates, document order preserved), and exits non-zero on failure.

## Do's and Don'ts

**Never use mock data** — no stubs, fakes, or hardcoded test data. All tests run against the real Claude API and real Supabase. Use `test.js` with a real key.

**Everything stays in `index.html`** — never split into separate JS or CSS files. The project is intentionally single-file for simple GitHub Pages deployment. The **only** exception is the server-side Edge Function (`supabase/functions/claude-proxy/index.ts`), which cannot live in the public client because it holds the Anthropic key.

**i18n for all UI text** — new visible strings must be added to the `LANGS` object (sv/en/ru) and accessed via `t()` or `tf()`. Never hardcode Swedish strings directly in HTML.

**Mobile-first, cold-warehouse UX** — no hover-only primary interactions. Touch targets minimum 44×44 px. Assume the user has gloves on and is using one hand in a cold environment.

**The S-route move button must always be visible** — every row in the comparison view (`routeReviewModal`) has a `.review-move-btn` (↓ SN / ↑ Rutt N) that lets staff move a KOF between the main route and its S-route. Never hide or remove this button, including on mobile. Ensure narrow-column layouts always have enough room for it (reduce padding before reducing content).

---

## Architecture

The client application is a single file: `index.html`. It contains all HTML structure, CSS, and JavaScript. Two CDN scripts are loaded at runtime:
- `@supabase/supabase-js@2` — multi-device sync and analytics
- `pdf.js 3.11.174` — splits PDF files into per-page images before processing

The one piece of code outside `index.html` is the Supabase Edge Function `supabase/functions/claude-proxy/index.ts`, a thin server-side proxy that adds the Anthropic key to every Claude call (see [Server-side proxy](#server-side-proxy-claude-proxy)).

### State model

A single `state` object is the source of truth:

```js
state.routeData      // { [kof: string]: { route, driver, store, pall, bur, hlv, units } }
state.routeOrder     // [kof] — document order, drives sort_order
state.routes         // { [routeName]: meta } derived route grouping
state.routeReview    // { [routeName]: bool } ⚠ review flags (persisted separately)
state.images         // pending/processing image queue
state.isProcessing
state.processingInterrupted, state.resumeImageIds // resume scans interrupted by tab backgrounding
state.abortController  // AbortController for in-flight callClaudeApi fetch; null when idle
state.savedAt          // timestamp of last localStorage write
state.supabaseLoadedAt // timestamp when Supabase data was last fetched, or null
state.isLoadingSupabase, state.isSyncing // load/sync guards
state.scanReview       // showScanReview modal state (active, img, result, judgeResult, editMode, editEntries)
state.scanImages       // { [imgId]: dataUrl } in-memory scan image cache
state.pendingReview, state.reviewQueue // review modals are shown one at a time (see Scan pipeline)
```

There is **no** `state.apiKey` — the Anthropic key lives server-side in the Edge Function, not in the client.

`routeData[kof].units` is an integer — the sum of pall+bur+hlv for that entry. Note: `driver`, `pall`, `bur`, `hlv`, and `confidence` are kept in memory only and are **not** synced to Supabase.

`routeData` is persisted to `localStorage` under key `rutt_scanner_v1` (`STORAGE_KEY`) with an 8-hour expiry; this snapshot also includes `routes` and `routeReview`. `routeReview` is **additionally** persisted under `rutt_route_review` (`ROUTE_REVIEW_KEY`) on its own, because `loadFromSupabase()` clears `STORAGE_KEY` on startup and the ⚠ review flags must survive that. Other `localStorage` keys: `rutt_device_id`, `rutt_lang`, and `rutt_verified_date` (see [Session UI state](#session-only-ui-state)).

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
  → [callClaudeApi] (Opus, PROMPT constant, max_tokens 3000)
      returns: { routeNumber, driver, rotation, entries[{ kof, store, pall, bur, hlv, units, route, confidence }] }
  → [applyRotation] (if rotation ∈ {90,180,270}, bake it into the stored image so it displays upright everywhere)
  → [validateEntry] (filters out invalid entries)
  → [showObligReview] (always shown — user must confirm data before it is saved)
  → [runJudge] (runs in parallel via callClaudeJudge, Haiku, JUDGE_PROMPT, max_tokens 200)
      returns: { approved, confidence, issues[] }
      → If (approved=false OR confidence<70) AND issues are not orientation-only:
          [revertEntries] → [showScanReview] (user must approve / edit / reject / retry)
      (orientation-only issues — rotated/tilted/upside-down — are ignored here,
       since the rotation field already handles orientation)
  → On user approval (either flow):
      [storeEntries] → state.routeData
      [saveToStorage] → localStorage
      [saveToSupabase] → route_entries.upsert
      [uploadScanImage] → scan_images.insert (gets UUID, back-fills scanImageId on KOFs)
      [logJudge] → judge_logs.insert
```

For **PDF uploads**: `handleFileSelect` → `splitPdfToImages` (pdf.js, 2× scale, each page → JPEG) → each page enters the pipeline above. PDF pages are already upright, so the `rotation` field is ignored for them.

**Image orientation:** auto-rotation comes from the `rotation` field returned by `callClaudeApi` (Opus reads the sheet at any angle and reports how many degrees clockwise it must rotate to be upright). There is no separate rotation-detection API call. The rotation is baked into the stored image via `applyRotation`, so it persists into `showObligReview`, `scan_images`, and the comparison view. The manual rotate buttons in `showObligReview` (baked on confirm) and `openRouteReview` (baked + re-uploads the `scan_images` row immediately, so other devices see it upright after reload) are **permanent**, not display-only.

**Two review modals — do not confuse them:**
- `showObligReview` — shown for every scan regardless of judge result; user confirms the extracted data before it is committed
- `showScanReview` — shown only when the judge flags a problem (`approved=false` or `confidence<70`, excluding orientation-only issues); lets user approve, edit entries manually, reject, or re-run extraction

**Review queuing:** when several images are scanned in one batch their reviews are not shown all at once — they are queued in `state.reviewQueue` and surfaced one at a time via `state.pendingReview`, so the user clears one review before the next appears.

### Claude API usage

Two active calls, both POSTed to the Edge Function proxy at `CLAUDE_PROXY_URL` (`SUPABASE_URL + '/functions/v1/claude-proxy'`) — **not** directly to `api.anthropic.com`:

| Function | Purpose | Model | max_tokens | timeout |
|---|---|---|---|---|
| `callClaudeApi(dataUrl)` | Route sheet extraction (incl. `rotation`) | `claude-opus-4-8` | 3000 | 90 s |
| `callClaudeJudge(dataUrl, result)` | Quality verification | `claude-haiku-4-5-20251001` | 200 | 30 s |

Both calls authenticate to the proxy with `apikey` and `Authorization: Bearer <SUPABASE_ANON_KEY>` headers. The Anthropic key (`x-api-key`) and the `anthropic-version` header are added **server-side** by the Edge Function — the client never sees them. `callClaudeApi` also wires `state.abortController` into the fetch signal (alongside the 90 s timeout) so `cancelProcessing()` can abort an in-flight extraction.

**`callClaudeApi`** uses the `PROMPT` constant which is critical — it defines exactly how the blank-row separator splits entries into "Rutt N" vs "SN" sections via the `isS` / `route` field, and returns a `rotation` field (0/90/180/270) used to auto-orient the stored image.

**`callClaudeJudge`** uses the `JUDGE_PROMPT` constant. It verifies KOF digits match the image and that route assignments are correct. Failsafe: if the API call itself fails, it returns `{ approved: true, confidence: 100, issues: [] }` to avoid blocking the user.

#### Server-side proxy (claude-proxy)

`supabase/functions/claude-proxy/index.ts` is a thin Deno Edge Function that exists because the app is hosted on a **public** GitHub Pages repo — an Anthropic key in `index.html` would be visible to everyone, auto-revoked by secret scanning, and abusable. The proxy:

- reads the key from the Supabase secret `ANTHROPIC_API_KEY`,
- forwards the app's request body **unchanged** to `https://api.anthropic.com/v1/messages`, adding `x-api-key` and `anthropic-version: 2023-06-01` server-side,
- returns Anthropic's response **verbatim** (same JSON shape and status codes), so the app's existing parsing and error handling are unaffected,
- handles CORS preflight (`OPTIONS`).

Limit the key with a spend/rate cap in the Anthropic Console.

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

**Sync flow:** On startup, `loadFromSupabase()` fetches all current `route_entries` and their associated `scan_images`, sets `state.supabaseLoadedAt`, and clears the `localStorage` cache. `initRealtimeSync()` subscribes the `route-realtime` channel to three things: `postgres_changes` on `route_entries` (→ `onRemoteChange()`, which debounces a full reload), and two `broadcast` events — `routes_verified` (another device tapped the verify banner) and `data_cleared` (another device wiped the data). A polling fallback kicks in if realtime is unavailable.

Each device gets a stable UUID stored under `rutt_device_id` in `localStorage`.

### Language support

`LANGS` object has three entries: `sv` (Swedish, default), `en` (English), `ru` (Russian). `loadLang()` auto-detects Russian via `navigator.language` if no saved preference in `localStorage` (`rutt_lang` key), otherwise defaults to Swedish. The easter egg section `#easterEggRu` in the Scan tab is only visible when `state.lang === 'ru'`.

### Session-only UI state

Module-level `let` variables track transient UI state that is intentionally **not** in `state` and (mostly) **not** persisted:

- `routesVerified` — set to `true` when the user taps the "Jag har kontrollerat ✓" button in the Routes tab verification banner. The banner is shown whenever there are routes and this is `false`. `dismissRoutesVerify()` sets it, persists today's date under `rutt_verified_date` (so it stays verified for the rest of the day even across reloads), and broadcasts `routes_verified` to other devices. On startup it is set back to `true` if `rutt_verified_date` matches today. So unlike the others, it is **not** purely session-only.
- `inlineEditKof` — the KOF number whose row is currently expanded for inline route-switching in the Routes tab table. Tapping a row sets it; tapping again or outside `#routesList` clears it. Saved by `changeInlineRoute(kof, newRoute)` which upserts to Supabase.
- `reviewViewMode` — `'routes'` or `'docs'`; controls which column is visible in the comparison view modal on narrow screens (<400 px). Updated by `setReviewView(mode)`.
- `reviewRouteNums`, `reviewRouteIdx` — the ordered list of route numbers and the current index, used by the comparison view to step between routes (prev/next navigation).
- `editModalAfterClose` — optional `() => void` callback invoked when `editModal` closes (both save and cancel). Used to return to the route modal or comparison view when a KOF row is tapped from those contexts. Cleared immediately after being called.

### Comparison view (eye button)

`openRouteReview(routeName)` opens the `#routeReviewModal` bottom sheet with a **two-column layout**: route entries on the left, source document image on the right. On screens narrower than 400 px a toggle bar ("Rutter" / "Dokument") is shown instead; `setReviewView()` toggles `review-col-hidden` class on the columns (CSS-only show/hide so scroll positions are preserved).

Each KOF row in `#reviewBody` has a `data-kof` attribute and is tappable: clicking opens `editModal` for that KOF, and after saving/cancelling the comparison view reopens automatically (via `editModalAfterClose`).

### Route modal KOF list (pen button)

`openRouteModal(routeName)` renders a scrollable KOF list (KOF | BUTIK | EST columns) inside `#routeModalKofList` showing all entries for that route. Tapping a row closes the route modal and opens `editModal` for that KOF; after saving/cancelling the route modal reopens (via `editModalAfterClose`).
