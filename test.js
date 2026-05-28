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

const PROMPT = `Extract route info from this Swedish logistics route sheet. The image may be rotated sideways — read it regardless of orientation. Return ONLY valid JSON, nothing else:
{"routeNumber":"4","driver":"161 Xhulijo","entries":[{"kof":"369321","store":"PB LUGNETS ALLE 29 STHLM","pall":"1","bur":"","hlv":"","units":1,"route":"Rutt 4"},{"kof":"123456","store":"COOP CITY STHLM","pall":"2","bur":"1","hlv":"","units":3,"route":"S4"}]}

Rules:
- routeNumber: ONLY the single number after "Rutt " in the header, before the dash. Example: "Rutt 4- 161 Xhulijo" → "4". Always 1–15.
- driver: REQUIRED. Text after the dash in the header. Example: "Rutt 4- 161 Xhulijo :)" → "161 Xhulijo". Strip trailing ":)" or emoji. Use "" if not found.
- kof: the 6-digit number in the leftmost data column (skip header rows).
- store: store name and address from the Startplats column.
- pall/bur/hlv: value in that column, empty string if blank.
- units: integer. Sum of pall + bur + hlv for this row (treat blank as 0). Example: pall=1, bur=2, hlv=0 → units: 3.
- route: CRITICAL — each entry must get either "Rutt N" or "SN" (where N = routeNumber).
  Step 1: Scan the table top-to-bottom and find the ONE completely blank row — a row with no KOF number and no store name. This blank row is the separator between the two sections.
  Step 2: Every KOF row ABOVE the blank separator row → route: "Rutt N" (example: "Rutt 4").
  Step 3: Every KOF row BELOW the blank separator row → route: "SN" (example: "S4").
  Step 4: If there is NO blank separator row anywhere in the table → all entries get route: "Rutt N".
  Double-check every entry's route value before returning. This is the most important field.
- Include ALL rows with a 6-digit KOF number from both sections.
Return only the JSON object, no markdown fences, no explanation.`;

function ok(msg)  { console.log(`  ✅ OK: ${msg}`); }
function fail(msg) { console.log(`  ❌ FEL: ${msg}`); return msg; }

function callApi(base64Data, mediaType) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: PROMPT },
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

  return errors;
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

    let parsed;
    try {
      const base64 = fs.readFileSync(filepath).toString('base64');
      parsed = await callApi(base64, mediaType);
      console.log(`  📄 Svar: Rutt ${parsed.routeNumber}, förare: "${parsed.driver}", ${(parsed.entries ?? []).length} poster`);
    } catch (err) {
      console.log(`  ❌ FEL: API-anrop misslyckades — ${err.message}`);
      totalErrors++;
      continue;
    }

    const errors = validateResult(parsed, filename);
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
