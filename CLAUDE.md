# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Rutt-scanner** is a mobile web app for terminal staff at Kyl & Frys Expressen, a refrigerated logistics company.

**Problem it solves:** Staff handle physical route sheets containing KOF numbers (6-digit identifiers tied to delivery stops), typically scanned in from around midday onward. Looking up a KOF manually used to take up to an hour — the app reduces that to seconds.

**How it works:** Staff photograph the route sheets (typically from around midday onward, not first thing in the morning) → Claude API extracts KOF data → stored in Supabase → anyone on shift can instantly look up any KOF.

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

**Everything stays in `index.html`** — never split into separate JS or CSS files. The project is intentionally single-file for simple GitHub Pages deployment. The exceptions are the server-side Edge Functions (`supabase/functions/claude-proxy/index.ts`, `supabase/functions/admin-stats/index.ts`), which cannot live in the public client because they hold secrets, and `admin.html` (see [Admin panel](#admin-panel) below), which is a deliberately separate owner-only tool.

**i18n for all UI text** — new visible strings in `index.html` (the staff app) must be added to the `LANGS` object (sv/en/ru) and accessed via `t()` or `tf()`. Never hardcode Swedish strings directly in HTML. `admin.html` is exempt — it is Swedish-only and owner-facing, so strings are hardcoded there.

**Mobile-first, cold-warehouse UX** — no hover-only primary interactions. Touch targets minimum 44×44 px. Assume the user has gloves on and is using one hand in a cold environment.

**The S-route move button must always be visible** — every row in the comparison view (`routeReviewModal`) has a `.review-move-btn` (↓ SN / ↑ Rutt N) that lets staff move a KOF between the main route and its S-route. Never hide or remove this button, including on mobile. Ensure narrow-column layouts always have enough room for it (reduce padding before reducing content). Each row also has a `.review-split-btn` ("Dela här") that sets the whole boundary in one tap (that row and everything below → SN); keep both buttons.

---

## Architecture

The client application is a single file: `index.html`. It contains all HTML structure, CSS, and JavaScript. Two CDN scripts are loaded at runtime:
- `@supabase/supabase-js@2` — multi-device sync and analytics
- `pdf.js 3.11.174` — splits PDF files into per-page images before processing

The one piece of code outside `index.html` is the Supabase Edge Function `supabase/functions/claude-proxy/index.ts`, a thin server-side proxy that adds the Anthropic key to every Claude call (see [Server-side proxy](#server-side-proxy-claude-proxy)).

### State model

A single `state` object is the source of truth:

```js
state.routeData      // { [kof: string]: { route, store, pall, bur, hlv, units } }
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
state.scanImages       // { [imgId]: dataUrl } in-memory scan image cache
state.pendingReview, state.reviewQueue // per-sheet split review shown one at a time (see Scan pipeline)
```

There is **no** `state.apiKey` — the Anthropic key lives server-side in the Edge Function, not in the client.

`routeData[kof].units` is an integer — the sum of pall+bur+hlv for that entry. Note: `pall`, `bur`, `hlv`, and `confidence` are kept in memory only and are **not** synced to Supabase. Driver/chauffeur names were removed entirely for GDPR reasons — they are no longer extracted, stored, displayed, or persisted anywhere (and the `driver` column was dropped from `route_entries`).

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
  → Promise.all([ callClaudeApi, callClaudeJudge ])   (run in parallel — judge is independent)
      [callClaudeApi]  (Opus, PROMPT, max_tokens 3000)
        returns: { routeNumber, rotation, splitIndex, entries[{ kof, store, …, units, route, confidence }] }
      [callClaudeJudge] (Haiku, JUDGE_PROMPT, max_tokens 1500) — INDEPENDENT second read of the image
        returns: { kofs[], splitIndex } (or { failed:true } — fail-open)
  → [applyRotation] (if rotation ∈ {90,180,270}, bake it into the stored image so it displays upright everywhere)
  → [reconcileReadings] — normalizes route from splitIndex and picks a DEFAULT boundary:
        Opus splitIndex if present, else the judge's splitIndex as a fallback guess.
        We trust the digits — there is NO digit cross-check. Returns { entries, splitIndex, opusSplit, judgeSplit }.
  → queue { type:'review', decision } → [showObligReview] — shown for EVERY sheet so a
        human always confirms the Rutt/S boundary (the AI sometimes misses the blank-row gap).
        Per-KOF moves via the toggle button are tracked in state.pendingReview.moves.
  → [commitScan] (on review save / "Gå vidare"):
      [storeEntries] → state.routeData
      [uploadScanImage] → scan_images.insert (gets UUID, back-fills scanImageId on KOFs)
      [logScan] → scan_logs ; [logJudge] → judge_logs ; [saveToStorage] ; [saveToSupabase] → route_entries.upsert
      [logScanHistory] → scan_history (90-day archive) ; [logSplitDecision] → split_decisions
      (AI vs human Rutt/S boundary) ; [logAudit] → audit_log for any review_move entries
```

For **PDF uploads**: `handleFileSelect` → `splitPdfToImages` (pdf.js, 2× scale, each page → JPEG) → each page enters the pipeline above. PDF pages are already upright, so the `rotation` field is ignored for them.

**Split stability (human-in-the-loop):** the only signal separating "Rutt N" from "SN" is a completely empty row, which a single-row gap can lose in the downscaled image — and the AI sometimes misses it entirely (puts everything in one route) or misplaces it. So the split is **always** confirmed by a human: `showObligReview` is shown for every sheet with the AI's guess pre-selected. `PROMPT` asks Opus for an explicit `splitIndex` (entry index where the S-block starts, or `null`); `callClaudeJudge` re-reads the sheet **independently** and reports its own `splitIndex`, used only as a **fallback default** when Opus found none. In the review the user can: tap **"Dela här" (split-here)** to set the boundary at a row (everything from it down → SN), use the per-KOF move buttons for fine adjustment, or tap **"Ingen S-rutt"** (`clearSplitObligReview`) to make the whole sheet "Rutt N". Split-here also lives in the comparison view (`splitHerePersisted`, batched upsert).

**Image orientation:** auto-rotation comes from the `rotation` field returned by `callClaudeApi`. The rotation is baked into the stored image via `applyRotation`, so it persists into `showObligReview`, `scan_images`, and the comparison view. The manual rotate buttons in `showObligReview` (baked on confirm) and `openRouteReview` (baked + re-uploads the `scan_images` row immediately) are **permanent**, not display-only.

**One calm review modal per sheet:** `showObligReview` is shown for **every** scanned sheet — its only job is to let the human set the Rutt/S boundary. We **trust the digits**, so there are no digit warnings and no "approve/reject" alarms; the language is deliberately calm because non-technical staff also scan. The save button reads **"Gå vidare"**. The old `showScanReview` warning modal and the digit-conflict UI have been removed.

**Review queuing:** when several images in a batch are scanned, each is queued in `state.reviewQueue` (type `'review'`, carrying the `decision`) and surfaced one at a time via `state.pendingReview`, so the user steps through all sheets one by one.

**Logs:** the in-app live log box has been removed from the Scan tab (staff don't see logs). `addLog()` is now a safe no-op (calls left in place). Analytics are still written to Supabase (`scan_logs`, `judge_logs`, `search_logs`, `session_segments`) for the owner to inspect there.

**Scan tab buttons:** the "Synka till molnet" button was removed — sync happens automatically on save. The "Rensa all inläst data" button (`#clearDataBtn` → `clearAllData()`, confirms via `t('confirmClear')`) remains and is shown only when there is loaded data; `updateStorageUI()` toggles its `hidden` class alongside `#savedBadge`.

### Claude API usage

Two active calls, both POSTed to the Edge Function proxy at `CLAUDE_PROXY_URL` (`SUPABASE_URL + '/functions/v1/claude-proxy'`) — **not** directly to `api.anthropic.com`. They run **in parallel** (`Promise.all`) because the judge reads the image independently and does not need the extraction result:

| Function | Purpose | Model | max_tokens | timeout |
|---|---|---|---|---|
| `callClaudeApi(dataUrl)` | Route sheet extraction (incl. `rotation`, `splitIndex`) | `claude-opus-4-8` | 3000 | 90 s |
| `callClaudeJudge(dataUrl)` | Independent second read — used only for a fallback split guess | `claude-haiku-4-5-20251001` | 1500 | 40 s |

Both calls authenticate to the proxy with `apikey` and `Authorization: Bearer <SUPABASE_ANON_KEY>` headers. The Anthropic key and `anthropic-version` are added **server-side**. `callClaudeApi` wires `state.abortController` into the fetch signal so `cancelProcessing()` can abort an in-flight extraction.

**`callClaudeApi`** uses the `PROMPT` constant — it defines how the blank-row separator splits entries into "Rutt N" vs "SN", returns an explicit `splitIndex` (the boundary decision), a per-entry `route` field (kept consistent with `splitIndex`), and a `rotation` field (0/90/180/270).

**`callClaudeJudge`** uses the `JUDGE_PROMPT` constant and re-reads the sheet **from scratch, without seeing the extraction**. It returns `{ kofs[], splitIndex }`, but only `splitIndex` is used: `reconcileReadings` falls back to it as the **default boundary** when Opus returned no split (`kofs[]` is currently ignored — we trust the digits and do no cross-check). Failsafe: any failure returns `{ failed: true }`, which `reconcileReadings` simply ignores — the human sets the split regardless, so the judge never blocks the user.

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

The route number is extracted from the header: `"Rutt 4- 161 Xhulijo"` → routeNumber `"4"` (the text after the dash is ignored — driver names are no longer extracted).

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

`daily_unit_totals` — permanent daily aggregate, upserted on conflict of `entry_date` by `logDailyTotal()`:
- `entry_date`, `total_units`, `route_count`, `kof_count`, `device_id`, `updated_at`

`scan_history` — append-only 90-day archive of every scanned KOF, written by `logScanHistory()` (called from `commitScan`). No driver names, no images. Lets staff/owner answer "what route was KOF X on, on date D?" even after `route_entries` is purged:
- `kof`, `route`, `store_name`, `pall`, `bur`, `hlv`, `units`, `confidence`, `sort_order`, `device_id`, `scanned_at`

`audit_log` — 90-day log of every manual mutation, written by `logAudit()` from `changeInlineRoute`, `splitHerePersisted`, `saveEdit`, `deleteKof`, `deleteRoute`, and `clearAllData` (which logs counts even though it wipes everything else):
- `action` (`route_change` | `split_here` | `review_move` | `edit_kof` | `delete_kof` | `delete_route` | `clear_all`), `kof`, `route`, `old_value`, `new_value`, `device_id`, `occurred_at`

`split_decisions` — 90-day per-sheet record of the AI-vs-human Rutt/S boundary, written by `logSplitDecision()` from `commitScan`, used to measure prompt quality:
- `route`, `entry_count`, `opus_split_index`, `judge_split_index`, `proposed_split_index`, `final_split_index`, `human_changed`, `moved_kofs`, `device_id`, `scanned_at`

**Sync flow:** On startup, `loadFromSupabase()` fetches all current `route_entries` (created within the last 10h) and their associated `scan_images`, sets `state.supabaseLoadedAt`, and clears the `localStorage` cache. `initRealtimeSync()` subscribes the `route-realtime` channel to three things: `postgres_changes` on `route_entries` (→ `onRemoteChange()`, which debounces a full reload), and two `broadcast` events — `routes_verified` (another device tapped the verify banner) and `data_cleared` (another device wiped the data). A polling fallback kicks in if realtime is unavailable.

Each device gets a stable UUID stored under `rutt_device_id` in `localStorage`.

**Data retention:** all scheduled deletion runs server-side via `pg_cron` (see `supabase/sql/03_pg_cron_retention.sql`, run manually in the Supabase SQL editor — there is no migration tooling in this project). `route_entries` and `scan_images` are purged after 10 hours (GDPR — sheet headers may show driver names); `scan_logs`, `judge_logs`, `search_logs`, `session_segments` after 30 days; `scan_history`, `audit_log`, `split_decisions` after 90 days; `daily_unit_totals` is permanent. The client no longer runs any cleanup (the old `cleanupOldSupabaseData()` was removed) — `clearAllData()`, `deleteKof()`, and `deleteRoute()` remain as the only client-initiated deletes, and only target `route_entries`/`scan_images`. `scan_history`, `audit_log`, and `split_decisions` are insert+select only for the anon client (RLS, see `supabase/sql/02_rls.sql`) — the client cannot update or delete them.

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

## Admin panel

`admin.html` is a separate, owner-only operations dashboard (not part of the staff-facing app, not linked from it). It is password-protected and lets Lucas check system health, usage, AI quality, and raw table data, plus run light maintenance (delete a KOF, delete a route, clear all data).

- **Auth:** a single shared password, checked server-side. The page stores it in `sessionStorage` (cleared when the tab closes) and sends it with every request — there is no Supabase Auth/session.
- **Backend:** `supabase/functions/admin-stats/index.ts`, a second Edge Function alongside `claude-proxy`. It reads the secret `ADMIN_PASSWORD` and uses `SUPABASE_SERVICE_ROLE_KEY` (auto-injected) to bypass RLS, so it can read all 10 tables and the views below regardless of the `anon` policies used by `index.html`. Deploy with `supabase functions deploy admin-stats --no-verify-jwt` (same as `claude-proxy`).
- **Actions** (dispatched via `{ password, action, params }`): `overview`, `ai_quality`, `table` (paginated, table name vitlisted, `scan_images.image_data` excluded), `audit`, and the maintenance writes `delete_kof`, `delete_route`, `clear_all`. Every maintenance write also inserts an `audit_log` row (`device_id: 'admin-panel'`), same shape as `logAudit()` in `index.html`.
- **Views** the Edge Function reads from (created manually in the Supabase SQL editor, defined in `supabase/views/`): `daily_unit_totals_stats`, `session_segments_daily`, `search_performance_stats` / `search_performance_daily`, `judge_quality_stats`, `split_decision_stats`.
- **Does not touch:** `index.html`, `claude-proxy`, or any existing RLS policy — the staff app's `anon`-key flow is unchanged.
