# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step — open `index.html` directly in a browser, or serve it with any static file server:

```
python3 -m http.server 8080
```

The app requires a real Anthropic API key entered via the in-app UI on first use (stored in `localStorage`).

## Architecture

The entire application is a single file: `index.html`. It contains all HTML structure, CSS, and JavaScript with no dependencies, no bundler, and no framework.

### State model

A single `state` object is the source of truth:

```js
state.routeData      // { [kof: string]: { route, driver, store, pall, bur, hlv, units } }
state.images         // pending/processing image queue
state.apiKey         // Anthropic key loaded from localStorage
state.isProcessing
state.abortController  // AbortController for in-flight callClaudeApi fetch; null when idle
```

`routeData[kof].units` is an integer — the sum of pall+bur+hlv for that entry, extracted by the AI and persisted to Supabase. Requires a `units integer DEFAULT 0` column on `route_entries` (run `ALTER TABLE route_entries ADD COLUMN IF NOT EXISTS units integer DEFAULT 0;`).

`routeData` is persisted to `localStorage` under key `rutt_scanner_v1` with an 8-hour expiry. The API key is stored separately under `rutt_api_key`.

### Four-tab UI

- **Routes tab** — Grouped view of all loaded stops, sorted by route number (default tab)
- **Search tab** — Type-ahead search over KOF numbers; also supports live camera scanning via `scanFrame()` loop
- **Scan tab** — Upload/photograph printed route sheets → compress to JPEG → call Claude API → parse JSON → merge into `state.routeData`. Includes `cancelProcessing()` which aborts the active fetch via `state.abortController` and resets processing state.
- **Guide tab** — Static HTML with 4 instructional sections and inline SVG illustrations; all text nodes use `data-i18n` for full translation support.

### Claude API usage

Two distinct calls to `https://api.anthropic.com/v1/messages` using `claude-sonnet-4-6`:

1. **`callClaudeApi(dataUrl)`** — Sends a full route sheet image, returns structured JSON with `{ routeNumber, driver, entries[] }`. The prompt in `PROMPT` constant is critical: it defines how routes are split into "Rutt N" (main section) vs "SN" (S-routes, below a blank separator row) via the `isS` field.

2. **`callClaudeForKof(dataUrl)`** — Sends a cropped camera frame, returns only the 6-digit KOF number or `NONE`. Uses `max_tokens: 20`.

Both calls include the `anthropic-dangerous-direct-browser-access: true` header (required for direct browser→API access without a proxy).

### Route naming convention

Each route sheet has two sections separated by a blank row:
- Rows above the blank → `isS: false` → stored as `"Rutt N"` (e.g. `"Rutt 4"`)
- Rows below the blank → `isS: true` → stored as `"SN"` (e.g. `"S4"`)

The route number is extracted from the header: `"Rutt 4- 161 Xhulijo"` → routeNumber `"4"`, driver `"161 Xhulijo"`.

### Language support

`LANGS` object has three entries: `sv` (Swedish, default), `en` (English), `ru` (Russian). `loadLang()` auto-detects Russian via `navigator.language` if no saved preference in `localStorage` (`rutt_lang` key), otherwise defaults to Swedish. The easter egg section `#easterEggRu` in the Scan tab is only visible when `state.lang === 'ru'`.

### Camera scanner

`cam` object manages the live scan loop: every 2500 ms, `scanFrame()` captures the center 75%×35% of the video frame, compresses it, and calls `callClaudeForKof`. A 5-second cooldown prevents the same KOF from triggering multiple result updates.

### Session-only UI state

Three module-level `let` variables track transient UI state that resets on every page load (intentionally **not** in `state` and **not** persisted):

- `routesVerified` — set to `true` when user taps the "Jag har kontrollerat ✓" button in the Routes tab verification banner. The banner is shown whenever there are routes and this is `false`. Reset by `dismissRoutesVerify()`.
- `inlineEditKof` — the KOF number whose row is currently expanded for inline route-switching in the Routes tab table. Tapping a row sets it; tapping again or outside `#routesList` clears it. Saved by `changeInlineRoute(kof, newRoute)` which upserts to Supabase.
- `reviewViewMode` — `'routes'` or `'docs'`; controls which column is visible in the comparison view modal on narrow screens (<400 px). Updated by `setReviewView(mode)`.

### Comparison view (eye button)

`openRouteReview(routeName)` opens the `#routeReviewModal` bottom sheet with a **two-column layout**: route entries on the left, source document image on the right. On screens narrower than 400 px a toggle bar ("Rutter" / "Dokument") is shown instead; `setReviewView()` toggles `review-col-hidden` class on the columns (CSS-only show/hide so scroll positions are preserved).
