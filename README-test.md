# Testskript för Claude API-integration

`test.js` skickar bilder i `test-images/` till Claude API med samma prompt och modell som appen använder, och validerar svaren.

## Förutsättningar

- Node.js 18 eller senare (ESM-stöd krävs)
- Ett Anthropic API-nyckel

## Kom igång

1. Lägg till testbilder (rutt-listor som JPEG eller PNG) i `test-images/`
2. Sätt din API-nyckel i miljön:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

3. Kör skriptet:

```bash
node test.js
```

## Vad skriptet kontrollerar

För varje bild valideras:

- **6-siffrigt KOF-nummer** — varje post måste ha ett exakt 6-siffrigt KOF
- **Ruttnamn** — varje post måste ha ett ruttnamn (`Rutt N` eller `SN`)
- **Inga dubbletter** — samma KOF-nummer får inte förekomma mer än en gång
- **Dokumentordning** — KOF-numren ska följa dokumentets ordning, inte vara numeriskt sorterade

## Exempelutdata

```
🔍 Testar 2 bild(er) mot Claude API (claude-sonnet-4-6)

─── rutt4.jpg ───
  📄 Svar: Rutt 4, förare: "161 Xhulijo", 12 poster
  ✅ OK: Alla 12 KOF-nummer är 6 siffror
  ✅ OK: Alla 12 poster har ruttnamn
  ✅ OK: Inga dubbletter (12 unika KOF-nummer)
  ✅ OK: Ordningen är inte numeriskt sorterad — följer dokumentets ordning

═══════════════════════════════════
📊 Sammanfattning
   Bilder testade:      2
   KOF-nummer hittade:  24
   Fel totalt:          0

✅ Alla kontroller godkända!
```
