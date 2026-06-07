#!/usr/bin/env node
// Testskript för Claude API-integration
// Kräver: ANTHROPIC_API_KEY i miljön
// Användning: node test.js

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'test-images');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

const PROMPT = `Extract route info from this Swedish logistics route sheet. The image may be rotated sideways — read it regardless of orientation. Return ONLY valid JSON, nothing else:
{"routeNumber":"4","splitIndex":1,"entries":[{"kof":"369321","store":"PB LUGNETS ALLE 29 STHLM","pall":"1","bur":"","hlv":"","units":1,"route":"Rutt 4"},{"kof":"123456","store":"COOP CITY STHLM","pall":"2","bur":"1","hlv":"","units":3,"route":"S4"}]}

Rules:
- routeNumber: ONLY the single number after "Rutt " in the header, before the dash. Example: "Rutt 4- 161 Xhulijo" → "4". Always 1–15.
- kof: the 6-digit number in the leftmost data column (skip header rows).
- store: store name and address from the Startplats column.
- pall/bur/hlv: value in that column, empty string if blank.
- units: integer. Sum of pall + bur + hlv for this row (treat blank as 0). Example: pall=1, bur=2, hlv=0 → units: 3.
- splitIndex: CRITICAL — the 0-based index into "entries" of the FIRST entry below the completely blank separator row (the first S-block row). If there is no blank separator row / no S-block, return null. Every entry with index < splitIndex is "Rutt N", every entry with index >= splitIndex is "SN".
- route: each entry gets "Rutt N" or "SN" (where N = routeNumber), CONSISTENT with splitIndex — index < splitIndex → "Rutt N", index >= splitIndex → "SN". If splitIndex is null, all are "Rutt N".
  Double-check that every entry's route matches splitIndex before returning. This is the most important field.
- Include ALL rows with a 6-digit KOF number from both sections.
Return only the JSON object, no markdown fences, no explanation.`;

// Oberoende andra-avläsning (spegel av appens JUDGE_PROMPT) — läser KOF-kolumnen
// och gränsen från grunden, utan att se extraktionen. Används för korskontroll.
const JUDGE_PROMPT = `You are reading a Swedish logistics route sheet INDEPENDENTLY, from scratch. Read the leftmost data column (the 6-digit KOF numbers) top-to-bottom, and report where the Rutt/S-split is. Read regardless of rotation.
A page may have one or two sections, separated by one or more COMPLETELY empty rows (no KOF, no address). The first empty-row gap is the split: rows above = main route, rows below = S-route.
Return ONLY raw JSON in this exact shape, no markdown fences:
{"kofs":["369321","123456","457001"],"splitIndex":1}
- kofs: every clearly visible 6-digit KOF, in document order, top-to-bottom, including the S-block. Do NOT invent digits.
- splitIndex: 0-based index into "kofs" of the FIRST KOF below the first empty-row gap. null if there is no gap / single section.`;

function ok(msg)  { console.log(`  ✅ OK: ${msg}`); }
function fail(msg) { console.log(`  ❌ FEL: ${msg}`); return msg; }

function callApi(base64Data, mediaType, model = MODEL, prompt = PROMPT, maxTokens = 2048) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try { const b = JSON.parse(data); reject(new Error(b?.error?.message ?? `HTTP ${res.statusCode}`)); }
          catch (_) { reject(new Error(`HTTP ${res.statusCode}`)); }
          return;
        }
        try {
          const parsed = JSON.parse(data);
          let raw = parsed.content?.[0]?.text?.trim() ?? '';
          const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenceMatch) raw = fenceMatch[1].trim();
          resolve(JSON.parse(raw));
        } catch (e) { reject(new Error(`JSON-parse fel: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function mediaTypeForExt(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function validateResult(parsed, filename) {
  const errors = [];
  const entries = parsed.entries ?? [];

  if (entries.length === 0) {
    errors.push(fail('Inga entries hittades'));
    return errors;
  }

  // Kontroll 1: Alla KOF-nummer är 6 siffror
  const badKofs = entries.filter(e => !/^\d{6}$/.test(String(e.kof ?? '')));
  if (badKofs.length === 0) {
    ok(`Alla ${entries.length} KOF-nummer är 6 siffror`);
  } else {
    badKofs.forEach(e => errors.push(fail(`KOF "${e.kof}" är inte 6 siffror`)));
  }

  // Kontroll 2: Alla poster har ett ruttnamn
  const missingRoute = entries.filter(e => !e.route || String(e.route).trim() === '');
  if (missingRoute.length === 0) {
    ok(`Alla ${entries.length} poster har ruttnamn`);
  } else {
    missingRoute.forEach(e => errors.push(fail(`KOF "${e.kof}" saknar ruttnamn`)));
  }

  // Kontroll 3: Inga dubbletter
  const kofs = entries.map(e => String(e.kof));
  const unique = new Set(kofs);
  if (unique.size === kofs.length) {
    ok(`Inga dubbletter (${kofs.length} unika KOF-nummer)`);
  } else {
    const seen = new Set();
    const dupes = kofs.filter(k => { if (seen.has(k)) return true; seen.add(k); return false; });
    [...new Set(dupes)].forEach(k => errors.push(fail(`Dubblett KOF: ${k}`)));
  }

  // Kontroll 4: Ordning matchar dokumentet (inte numerisk sortering)
  const kofNums = kofs.map(Number);
  const sorted = [...kofNums].sort((a, b) => a - b);
  const isNumericalOrder = kofNums.every((v, i) => v === sorted[i]);
  if (kofs.length <= 1 || !isNumericalOrder) {
    ok(`Ordningen är inte numeriskt sorterad — följer dokumentets ordning`);
  } else {
    errors.push(fail('KOF-numren verkar vara i numerisk ordning (kan vara fel — kontrollera manuellt)'));
  }

  // Kontroll 5: route stämmer med splitIndex
  const si = parsed.splitIndex;
  if (si === undefined) {
    errors.push(fail('splitIndex saknas i svaret'));
  } else if (si !== null && (!Number.isInteger(si) || si < 0 || si > entries.length)) {
    errors.push(fail(`splitIndex ${si} är utanför giltigt intervall (0–${entries.length})`));
  } else {
    const bad = entries.filter((e, i) => {
      const wantS = si !== null && i >= si;
      const isS = String(e.route ?? '').startsWith('S');
      return wantS !== isS;
    });
    if (bad.length === 0) {
      ok(`route stämmer med splitIndex (${si === null ? 'ingen S-del' : 'S börjar vid index ' + si})`);
    } else {
      bad.forEach(e => errors.push(fail(`KOF "${e.kof}" route "${e.route}" stämmer inte med splitIndex ${si}`)));
    }
  }

  return errors;
}

// Korskontroll: jämför extraktionen mot den oberoende andra-avläsningen (judge).
// Skriver ut oenigheter om gräns och KOF-siffror — samma logik som appens reconcile.
function crossCheck(parsed, judge) {
  const entries = (parsed.entries ?? []).filter(e => /^\d{6}$/.test(String(e.kof ?? '')));
  let opusSplit = Number.isInteger(parsed.splitIndex) ? parsed.splitIndex : null;
  if (opusSplit === null) {
    const i = entries.findIndex(e => String(e.route ?? '').startsWith('S'));
    opusSplit = i === -1 ? null : i;
  }
  const jkofs = Array.isArray(judge.kofs) ? judge.kofs.map(k => String(k).replace(/\D/g, '')) : [];
  const jSplit = Number.isInteger(judge.splitIndex) ? judge.splitIndex : null;

  if (jSplit === opusSplit) ok(`Gräns: avläsningarna eniga (splitIndex ${jSplit})`);
  else fail(`Gräns: OENSE — extraktion splitIndex ${opusSplit}, andra-avläsning ${jSplit} → appen skulle be om "Dela här"`);

  if (jkofs.length !== entries.length) {
    fail(`KOF: olika antal rader (extraktion ${entries.length}, andra-avläsning ${jkofs.length}) → appen skulle granska`);
    return;
  }
  const diffs = [];
  entries.forEach((e, i) => { if (jkofs[i] && jkofs[i] !== e.kof) diffs.push(`#${i}: ${e.kof} vs ${jkofs[i]}`); });
  if (diffs.length === 0) ok(`KOF: alla ${entries.length} siffror eniga`);
  else diffs.forEach(d => fail(`KOF OENSE ${d} → appen skulle be om kontroll`));
}

async function main() {
  if (!API_KEY) {
    console.error('❌ Sätt ANTHROPIC_API_KEY i miljön innan du kör skriptet.');
    process.exit(1);
  }

  let imageFiles;
  try {
    imageFiles = fs.readdirSync(TEST_DIR)
      .filter(f => mediaTypeForExt(path.extname(f).toLowerCase()))
      .sort();
  } catch (_) {
    console.error(`❌ Mappen test-images/ hittades inte eller kunde inte läsas.`);
    process.exit(1);
  }

  if (imageFiles.length === 0) {
    console.log('⚠️  Inga bildfiler hittades i test-images/. Lägg till .jpg/.png-filer och kör igen.');
    process.exit(0);
  }

  console.log(`\n🔍 Testar ${imageFiles.length} bild(er) mot Claude API (${MODEL})\n`);

  let totalKofs = 0;
  let totalErrors = 0;

  for (const filename of imageFiles) {
    const filepath = path.join(TEST_DIR, filename);
    const ext = path.extname(filename).toLowerCase();
    const mediaType = mediaTypeForExt(ext);

    console.log(`─── ${filename} ───`);

    let parsed, judge = null;
    try {
      const base64 = fs.readFileSync(filepath).toString('base64');
      // Extraktion + oberoende andra-avläsning parallellt (som i appen)
      [parsed, judge] = await Promise.all([
        callApi(base64, mediaType),
        callApi(base64, mediaType, JUDGE_MODEL, JUDGE_PROMPT, 1500).catch(err => {
          console.log(`  ⚠️  Andra-avläsning misslyckades — ${err.message}`);
          return null;
        }),
      ]);
      console.log(`  📄 Svar: Rutt ${parsed.routeNumber}, ${(parsed.entries ?? []).length} poster, splitIndex ${parsed.splitIndex}`);
    } catch (err) {
      console.log(`  ❌ FEL: API-anrop misslyckades — ${err.message}`);
      totalErrors++;
      continue;
    }

    const errors = validateResult(parsed, filename);
    if (judge) crossCheck(parsed, judge);
    totalErrors += errors.length;
    totalKofs += (parsed.entries ?? []).filter(e => /^\d{6}$/.test(String(e.kof ?? ''))).length;
    console.log('');
  }

  console.log('═══════════════════════════════════');
  console.log(`📊 Sammanfattning`);
  console.log(`   Bilder testade:      ${imageFiles.length}`);
  console.log(`   KOF-nummer hittade:  ${totalKofs}`);
  console.log(`   Fel totalt:          ${totalErrors}`);
  if (totalErrors === 0) {
    console.log('\n✅ Alla kontroller godkända!');
  } else {
    console.log(`\n❌ ${totalErrors} fel hittades — se detaljer ovan.`);
    process.exit(1);
  }
}

main();
