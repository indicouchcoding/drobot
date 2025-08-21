/*
Indicouch Case-Opening Chatbot — Twitch (tmi.js)
Author: you + GPT-5 Thinking
License: MIT

Stream-ready build (NO persistence, resets each run)
- Uses in-memory inventories/stats only (cleared on restart/redeploy)
- CS2-style odds (approximate community-known rates)
- Updated cases: Fever Case, Operation Breakout Weapon Case, Glove Case, Gallery Case (alias of Glove Case), CS:GO Weapon Case
- Gold pool logic: Knives for most cases, Gloves for Glove/Gallery

Quick start
1) Node.js 18+
2) npm init -y && npm i tmi.js dotenv
3) .env → TWITCH_USERNAME, TWITCH_OAUTH, TWITCH_CHANNEL, BOT_PREFIX=!
4) node indicouch-case-bot.js

--------------------------------------------------------------------------------
*/

import tmi from 'tmi.js';
import dotenv from 'dotenv';
import http from 'http';
dotenv.config();

// ----------------- Config -----------------
const CONFIG = {
  prefix: process.env.BOT_PREFIX || '!',
  defaultCaseKey: 'CS:GO Weapon Case',
  maxOpensPerCommand: 10,
  // StatTrak ~10%, Souvenir 0 for normal cases
  stattrakChance: 0.10,
  souvenirChance: 0.00,
  // Wear distribution approximation
  wearTiers: [
    { key: 'Factory New', short: 'FN', p: 0.03, float: [0.00, 0.07] },
    { key: 'Minimal Wear', short: 'MW', p: 0.07, float: [0.07, 0.15] },
    { key: 'Field-Tested', short: 'FT', p: 0.38, float: [0.15, 0.38] },
    { key: 'Well-Worn', short: 'WW', p: 0.38, float: [0.38, 0.45] },
    { key: 'Battle-Scarred', short: 'BS', p: 0.14, float: [0.45, 1.00] },
  ],
  // CS2 case rarity odds (approx):
  rarities: [
    { key: 'Gold',   p: 0.0026 },  // 0.26% Rare Special (knife/glove)
    { key: 'Red',    p: 0.0064 },  // 0.64% Covert
    { key: 'Pink',   p: 0.032  },  // 3.20% Classified
    { key: 'Purple', p: 0.1598 },  // 15.98% Restricted
    { key: 'Blue',   p: 0.7992 },  // 79.92% Mil-Spec
  ],
};

// ----------------- In-memory state (no disk) -----------------
const STATE = {
  inv: {},        // { user: Drop[] }
  stats: { opens: 0, drops: {} }, // rarity counters
  defaults: {},   // { user: caseKey }
};

// ----------------- Helpers -----------------
function rng() { return Math.random(); }
function weightedPick(items, weightProp = 'p') {
  const r = rng();
  let acc = 0;
  for (const it of items) { acc += it[weightProp]; if (r <= acc) return it; }
  return items[items.length - 1];
}
function pickWear() {
  const wear = weightedPick(CONFIG.wearTiers);
  const [min, max] = wear.float;
  const fl = +(min + rng() * (max - min)).toFixed(4);
  return { ...wear, float: fl };
}
function pickRarityKey() { return weightedPick([...CONFIG.rarities].reverse()).key; }

// ----------------- Case + Pools -----------------
// Knife finishes (common classic set)
const KNIFE_FINISHES = [
  'Fade', 'Case Hardened', 'Crimson Web', 'Slaughter', 'Night', 'Blue Steel',
  'Boreal Forest', 'Stained', 'Safari Mesh', 'Scorched', 'Urban Masked'
];
const KNIVES_OG = [
  'Bayonet', 'Flip Knife', 'Gut Knife', 'Karambit', 'M9 Bayonet'
].flatMap(model => KNIFE_FINISHES.map(name => ({ weapon: `★ ${model}`, name })));
const KNIVES_BUTTERFLY = KNIFE_FINISHES.map(name => ({ weapon: '★ Butterfly Knife', name }));

// Gloves (subset good for stream; we can expand later)
const GLOVES = [
  "Sport Gloves | Vice", "Sport Gloves | Pandora's Box", 'Sport Gloves | Superconductor', 'Sport Gloves | Hedge Maze',
  'Specialist Gloves | Crimson Kimono', 'Specialist Gloves | Emerald Web', 'Specialist Gloves | Foundation', 'Specialist Gloves | Forest DDPAT',
  'Moto Gloves | Spearmint', 'Moto Gloves | Cool Mint', 'Moto Gloves | Turtle', 'Moto Gloves | Boom!',
  'Hand Wraps | Cobalt Skulls', 'Hand Wraps | Slaughter', 'Hand Wraps | Leather', 'Hand Wraps | Spruce DDPAT',
  'Driver Gloves | King Snake', 'Driver Gloves | Overtake', 'Driver Gloves | Imperial Plaid', 'Driver Gloves | Crimson Weave',
  'Hydra Gloves | Emerald', 'Hydra Gloves | Rattler', 'Hydra Gloves | Case Hardened', 'Hydra Gloves | Mangrove'
].map(full => ({ weapon: '★ Gloves', name: full }));

// Base skin pools (trimmed lists for stream usability)
const CASES = {
  'CS:GO Weapon Case': {
    type: 'knife',
    Blue: [
      { weapon: 'MP7', name: 'Skulls' },
      { weapon: 'Nova', name: 'Sand Dune' },
      { weapon: 'Glock-18', name: 'Brass' },
      { weapon: 'SG 553', name: 'Ultraviolet' },
      { weapon: 'AUG', name: 'Wings' },
    ],
    Purple: [
      { weapon: 'Desert Eagle', name: 'Hypnotic' },
      { weapon: 'P90', name: 'Blind Spot' },
      { weapon: 'M4A1-S', name: 'Dark Water' },
    ],
    Pink: [
      { weapon: 'AK-47', name: 'Case Hardened' },
      { weapon: 'AWP', name: 'Lightning Strike' },
    ],
    Red: [
      { weapon: 'M4A4', name: 'Asiimov' },
      { weapon: 'AK-47', name: 'Redline' },
    ],
    Gold: KNIVES_OG,
  },
  'Operation Breakout Weapon Case': {
    type: 'knife',
    Blue: [
      { weapon: 'PP-Bizon', name: 'Osiris' },
      { weapon: 'UMP-45', name: 'Labyrinth' },
      { weapon: 'P2000', name: 'Ivory' },
      { weapon: 'Nova', name: 'Koi' },
      { weapon: 'Negev', name: 'Desert-Strike' },
    ],
    Purple: [
      { weapon: 'P90', name: 'Asiimov' },
      { weapon: 'CZ75-Auto', name: 'Tigris' },
      { weapon: 'Five-SeveN', name: 'Fowl Play' },
    ],
    Pink: [
      { weapon: 'M4A1-S', name: 'Cyrex' },
      { weapon: 'Glock-18', name: 'Water Elemental' },
    ],
    Red: [
      { weapon: 'Desert Eagle', name: 'Conspiracy' },
      { weapon: 'P90', name: 'Trigon' },
    ],
    Gold: KNIVES_BUTTERFLY,
  },
  'Glove Case': {
    type: 'glove',
    Blue: [
      { weapon: 'MP7', name: 'Cirrus' }, { weapon: 'G3SG1', name: 'Stinger' }, { weapon: 'CZ75-Auto', name: 'Polymer' },
      { weapon: 'P2000', name: 'Turf' }, { weapon: 'Nova', name: 'Gila' }
    ],
    Purple: [
      { weapon: 'Galil AR', name: 'Black Sand' }, { weapon: 'M4A4', name: 'Buzz Kill' }, { weapon: 'USP-S', name: 'Cyrex' }
    ],
    Pink: [
      { weapon: 'FAMAS', name: 'Mecha Industries' }, { weapon: 'SSG 08', name: 'Dragonfire' }
    ],
    Red: [
      { weapon: 'AK-47', name: 'Wasteland Rebel' }, { weapon: 'P90', name: 'Shallow Grave' }
    ],
    Gold: GLOVES,
  },
  'Gallery Case': null, // alias → Glove Case
  'Fever Case': {
    // fun custom case themed around Fever Dream skins, for stream use
    type: 'knife',
    Blue: [
      { weapon: 'MP9', name: 'Goo' }, { weapon: 'MAC-10', name: 'Last Dive' }, { weapon: 'FAMAS', name: 'Pulse' },
      { weapon: 'XM1014', name: 'Teclu Burner' }, { weapon: 'CZ75-Auto', name: 'Tacticat' }
    ],
    Purple: [
      { weapon: 'SSG 08', name: 'Fever Dream' }, { weapon: 'P250', name: 'Mandalore' }, { weapon: 'UMP-45', name: 'Primal Saber' }
    ],
    Pink: [
      { weapon: 'AK-47', name: 'Fever Dream' }, { weapon: 'M4A1-S', name: 'Decimator' }
    ],
    Red: [
      { weapon: 'AWP', name: 'Mortis' }, { weapon: 'Desert Eagle', name: 'Kumicho Dragon' }
    ],
    Gold: KNIVES_OG,
  },
};
// alias wiring
CASES['Gallery Case'] = { ...CASES['Glove Case'] };

// ----------------- Draw logic -----------------
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function makeGoldDrop(caseKey) {
  const pool = CASES[caseKey].Gold;
  return randomFrom(pool);
}
function openOne(caseKey) {
  const rarity = pickRarityKey();
  const wear = pickWear();
  let item;
  if (rarity === 'Gold') {
    item = makeGoldDrop(caseKey);
  } else {
    const bucket = CASES[caseKey]?.[rarity] || [];
    item = bucket.length ? randomFrom(bucket) : { weapon: 'Unknown', name: 'Mystery' };
  }
  const stattrak = rng() < CONFIG.stattrakChance;
  const souvenir = CONFIG.souvenirChance > 0 && rng() < CONFIG.souvenirChance;
  return {
    case: caseKey,
    rarity,
    wear: wear.key,
    float: wear.float,
    stattrak,
    souvenir,
    weapon: item.weapon,
    name: item.name,
  };
}

// ----------------- Formatting -----------------
function rarityEmoji(rarity) {
  switch (rarity) {
    case 'Gold': return '✨';
    case 'Red': return '🔴';
    case 'Pink': return '🟣';
    case 'Purple': return '🟪';
    case 'Blue': return '🔵';
    default: return '⬜';
  }
}
function formatDrop(drop) {
  const parts = [];
  if (drop.souvenir) parts.push('Souvenir');
  if (drop.stattrak) parts.push('StatTrak');
  const prefix = parts.length ? parts.join(' ') + ' ' : '';
  const wearShort = (drop.wear || '').split(' ').map(s => s[0]).join('');
  return `${rarityEmoji(drop.rarity)} ${prefix}${drop.weapon} | ${drop.name} (${wearShort} • ${drop.float.toFixed(4)})`;
}

// ----------------- Inventory & Stats (memory-only) -----------------
function addToInventory(user, drop) { (STATE.inv[user] ||= []).push(drop); }
function getInventory(user) { return STATE.inv[user] || []; }
function pushStats(drop) { STATE.stats.opens++; STATE.stats.drops[drop.rarity] = (STATE.stats.drops[drop.rarity]||0)+1; }
function getStats() { const s=STATE.stats; const by=s.drops; const fmt=['Gold','Red','Pink','Purple','Blue'].map(r=>`${rarityEmoji(r)} ${r}: ${by[r]||0}`).join(' | '); return { total: s.opens, fmt }; }

// Value model (points, not $) for leaderboards while pricing is off
const RARITY_POINTS = { Gold: 100, Red: 25, Pink: 10, Purple: 3, Blue: 1 };
function dropPoints(drop) { return RARITY_POINTS[drop.rarity] || 0; }
async function inventoryValue(user) { const items=getInventory(user); let sum=0; for (const d of items) sum += dropPoints(d); return { totalPts: sum, count: items.length }; }
async function leaderboardTop(n=5) { const rows=[]; for (const [user, items] of Object.entries(STATE.inv)) { let sum=0; for (const d of items) sum+=dropPoints(d); rows.push({ user, total:sum, count:items.length }); } rows.sort((a,b)=>b.total-a.total); return rows.slice(0, Math.max(1, Math.min(25, n))); }

// ----------------- Defaults & Case resolution -----------------
function setDefaultCase(user, caseKey) { STATE.defaults[user]=caseKey; }
function getDefaultCase(user) { return STATE.defaults[user] || CONFIG.defaultCaseKey; }
function resolveCaseKey(input) {
  if (!input) return null;
  const normalized = input.toLowerCase();
  const keys = Object.keys(CASES);
  const exact = keys.find(k => k.toLowerCase() === normalized);
  if (exact) return exact;
  const starts = keys.find(k => k.toLowerCase().startsWith(normalized));
  return starts || null;
}

// ----------------- Cooldowns -----------------
const cdMap = new Map();
const COOLDOWN_MS = 3000;
function onCooldown(user) { const now=Date.now(); const last=cdMap.get(user)||0; if (now-last<COOLDOWN_MS) return true; cdMap.set(user, now); return false; }

// ----------------- Twitch Client -----------------
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: [process.env.TWITCH_CHANNEL],
});
client.connect().then(() => { console.log('Case bot connected to', process.env.TWITCH_CHANNEL); }).catch(console.error);

// Minimal HTTP health server (Render friendly)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); } res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Indicouch Case Bot OK (no persistence)'); }).listen(PORT, () => console.log(`Health server listening on :${PORT}`));

// ----------------- Commands -----------------
const HELP_TEXT = [
  'Commands:',
  '!cases — list cases',
  '!open <case> [xN] — open 1-10 cases',
  '!inv [@user] — show inventory',
  '!worth [@user] — inventory value (points)',
  '!top [N] — leaderboard by points',
  '!stats — global drop stats',
  '!setcase <case> — set default case',
  '!mycase — show your default case',
  '!help — this menu',
].join(' | ');

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const user = (tags['display-name'] || tags.username || 'user').toLowerCase();
  if (!message.startsWith(CONFIG.prefix)) return;
  if (onCooldown(user)) return; // chill

  const args = message.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  switch (cmd) {
    case 'help':
      client.say(channel, HELP_TEXT);
      break;
    case 'cases': {
      const list = Object.keys(CASES).join(' | ');
      client.say(channel, `Available cases: ${list}`);
      break;
    }
    case 'mycase': {
      client.say(channel, `@${user} your default case is: ${getDefaultCase(user)}`);
      break;
    }
    case 'setcase': {
      const input = args.join(' ');
      const key = resolveCaseKey(input);
      if (!key) { client.say(channel, `@${user} I don't recognize that case.`); break; }
      setDefaultCase(user, key);
      client.say(channel, `@${user} default case set to: ${key}`);
      break;
    }
    case 'open': {
      let count = 1;
      const xIdx = args.findIndex(a => /^x\d+$/i.test(a));
      if (xIdx >= 0) { count = Math.max(1, Math.min(CONFIG.maxOpensPerCommand, parseInt(args[xIdx].slice(1), 10))); args.splice(xIdx, 1); }
      const caseInput = args.join(' ');
      const caseKey = caseInput ? resolveCaseKey(caseInput) : getDefaultCase(user);
      if (!caseKey || !CASES[caseKey]) { client.say(channel, `@${user} pick a case with !cases or set one with !setcase <case>.`); break; }
      const results = [];
      for (let i = 0; i < count; i++) { const drop = openOne(caseKey); results.push(drop); addToInventory(user, drop); pushStats(drop); }
      const line = results.map(formatDrop).join('  |  ');
      client.say(channel, `@${user} opened ${count}x ${caseKey}: ${line}`);
      break;
    }
    case 'inv': {
      const target = (args[0]?.replace('@','') || user).toLowerCase();
      const items = getInventory(target);
      if (!items.length) { client.say(channel, `@${user} ${target} has an empty inventory. Use !open to pull some heat.`); break; }
      const preview = items.slice(-5).map(formatDrop).join('  |  ');
      client.say(channel, `@${user} ${target}'s last ${Math.min(5, items.length)} drops: ${preview}  (Total: ${items.length})`);
      break;
    }
    case 'stats': {
      const s = getStats();
      client.say(channel, `Drops so far — Total opens: ${s.total} | ${s.fmt}`);
      break;
    }
    case 'worth': {
      const target = (args[0]?.replace('@','') || user).toLowerCase();
      const { totalPts, count } = await inventoryValue(target);
      if (count === 0) { client.say(channel, `@${user} ${target} has an empty inventory.`); break; }
      client.say(channel, `@${user} ${target}'s inventory: ${count} items • ~${totalPts} pts`);
      break;
    }
    case 'top': {
      let n = 5; if (args[0] && /^\d+$/.test(args[0])) n = parseInt(args[0],10);
      const rows = await leaderboardTop(n);
      if (!rows.length) { client.say(channel, `@${user} leaderboard is empty.`); break; }
      const line = rows.map((r,i)=>`#${i+1} ${r.user}: ${r.total} pts (${r.count})`).join(' | ');
      client.say(channel, `Top ${rows.length} (by points): ${line}`);
      break;
    }
    default:
      if (cmd) client.say(channel, `@${user} unknown command. ${HELP_TEXT}`);
      break;
  }
});
