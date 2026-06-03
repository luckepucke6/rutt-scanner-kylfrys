# To-Do — Rutt-scanner

## Bugfixar

- [ ] **Verifieringsbanner försvinner inte** — Bannern "Kontrollera att alla rutter stämmer…" döljs inte korrekt efter att användaren klickat i att det är kontrollerat.
- [ ] **Lägg till ögon-knapp i verifieringsbannern** — Texten "⚠️ Kontrollera att alla rutter stämmer med papprena…" bör ha ett klickbart öga-ikon som öppnar jämförelsevyn direkt.
- [x] **Tidsspårning verkar fel** — 23,56 sekunder per bur känns för långsamt. Undersök om `manual_baseline_ms` eller session-spårningen räknar fel. ✅ Grundorsak: `session_segments.duration_minutes` blåstes upp av upp till 10 min spök-idle per segment (sluttid sattes när inaktivitetstimern löste ut). Fixat: `segment_end` = sista aktiviteten, övergivna sökningar (>60 s) loggas som null, baslinjen dokumenterad som `MANUAL_BASELINE_MS`. Riktig tid per uppslag ≈ 7 s (median), inte 23,56. (TODO: mät verklig manuell baslinje med papper imorgon.)

## UI-finslip

- [ ] **Generell genomgång av flödet** — Gör appen enklare för icke-tekniska användare. Minska friktion i scannings- och granskningsflödet.
- [ ] **Minska antal varningar/notiser** — För många popups och banners stör flödet. Gå igenom vilka som faktiskt behövs och ta bort/slå ihop resten.
- [ ] **Lägg till Kyl & Frys Expressen-loggan** — Branding inför försäljningen.

## Nya funktioner

- [ ] **Adminvy (separat länk)** — Separat sida/länk för kontoret att ladda upp Excel-filen direkt, utan att se terminalvyn.
- [ ] **Excel-import (.xlsx)** — Kontoret laddar upp Excel-filen istället för att skriva ut och fotografera. Noll API-kostnad, 100% korrekt, omedelbart. Kräver att kolumnstrukturen kartläggs mot ett riktigt .xlsx-exempel. (Löser troligtvis även S-rutt-problemet.)
- [ ] **QR-kod på försättsblad** — Kontoret laddar upp Excel → appen genererar en QR-kod → kontoret skriver ut QR → terminalpersonal skannar QR och får all rutt-data direkt på telefonen.
- [ ] **PWA (Progressive Web App)** — Lägg till manifest + service worker så appen kan installeras på hemskärmen som en riktig app.
- [ ] **Push-notiser** — Notis när ny rutt-data finns tillgänglig (t.ex. när kontoret laddat upp morgonens Excel).
- [ ] **Claude Code kan läsa databasen** — Konfigurera MCP/verktyg så att Claude Code-agenten kan läsa Supabase-databasen direkt för felsökning och analys.

## Tekniska förbättringar

- [ ] **S-rutt-uppdelning vid dåliga bilder** — Claude missar ibland den tomma radseparatorn (Rutt N → SN) när bilden är suddig eller tagen i vinkel. Undersök om prompten kan förstärkas, eller om Excel-import löser problemet helt.

## Affär & avtal

- [ ] **Möte måndag 2026-06-08** — Presentera tids- och kostnadsbesparingar (130 000–180 000 kr/år), prissättning, och avtalsmodell.
- [ ] **Prissättning** — Förslag: engångslicens 20 000–30 000 kr + årsabonnemang 18 000–24 000 kr/år (täcker API, databas, underhåll). Argument: appen betalar sig på under 3 månader med ~130 000 kr/år i tidsbesparing.
- [ ] **Avtal** — Skriv ett enkelt avtal som täcker: vad som ingår i årsabonnemanget, vad som händer om de avslutar, om nya funktioner kostar extra, och att Lucas äger koden.

## Inför försäljning

- [ ] **Sätt upp domän** — Flytta från GitHub Pages till ett eget domännamn (t.ex. Cloudflare Pages med kylfrys.app eller liknande).
- [ ] **Kundspecifik infrastruktur** — Vid leverans: skapa ett separat Supabase-projekt och en dedikerad Anthropic API-nyckel per kund (inte Lucas personliga konton), hårdkoda dem i kundens version av appen.
- [ ] **API-nyckelhantering** — Anthropic API-nyckeln matas in manuellt per enhet. Hårdkoda den i appen vid försäljning.
- [ ] **Autentisering & dataisolering** — Supabase URL och anon-nyckel är hårdkodade i `index.html`. Tillräckligt för en kund med RLS, men måste lösas inför eventuellt fler kunder.
