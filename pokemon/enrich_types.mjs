// Run with: node enrich_types.mjs
// Adds canonical types to each monster (1–493) by querying PokéAPI.
// Will update your existing mondex.json IN PLACE.
// Requires Node 18+ (global fetch).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEX_PATH = process.env.DROMON_DEX_FILE || path.join(__dirname, 'data', 'mondex.json');

function loadDex(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[enrich] failed to read dex:', e.message);
    process.exit(1);
  }
}

function saveDex(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

async function getTypes(id) {
  const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.types||[]).sort((a,b)=> (a.slot||0)-(b.slot||0)).map(t => cap(t.type.name));
}

async function run() {
  const dex = loadDex(DEX_PATH);
  if (!Array.isArray(dex.monsters)) {
    console.error('[enrich] mondex.json missing monsters[]');
    process.exit(1);
  }

  const byId = new Map(dex.monsters.map(m => [Number(m.id), m]));
  let changed = 0;

  for (let id = 1; id <= 493; id++) {
    const m = byId.get(id);
    if (!m) continue;
    if (Array.isArray(m.types) && m.types.length) continue;

    try {
      const types = await getTypes(id);
      if (types.length) {
        m.types = types;
        changed++;
        console.log(`[types] #${id} ${m.name} -> [${types.join(', ')}]`);
        if (changed % 10 === 0) saveDex(DEX_PATH, dex); // checkpoint every 10
      }
    } catch (e) {
      console.warn(`[types] failed #${id} ${m?.name||''}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 150)); // be nice to API
  }

  if (changed) saveDex(DEX_PATH, dex);
  console.log(`[enrich] done. entries changed: ${changed}`);
}

run().catch(e => {
  console.error('[enrich] fatal:', e);
  process.exit(1);
});
