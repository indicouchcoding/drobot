/*
Indicouch Case-Opening Chatbot — Twitch (tmi.js)
Author: you + GPT-5 Thinking
License: MIT

STREAM BUILD — NO PERSISTENCE (resets every restart)
- CS2-style odds (Gold/Red/Pink/Purple/Blue)
- Cases: CS:GO Weapon Case, Operation Breakout Weapon Case, Glove Case, Gallery Case (separate), Fever Case
- Gold pools:
  • CS:GO Weapon Case → classic knives (Bayonet/Flip/Gut/Karambit/M9) with many finishes
  • Operation Breakout → Butterfly knives (many finishes)
  • Glove Case → Gloves
  • Gallery Case → Gloves (different skin pool), separate from Glove Case
  • Fever Case → classic knives
- In-memory inventories + leaderboard points (no $ pricing)

Quick start
1) npm init -y && npm i tmi.js dotenv
2) .env → TWITCH_USERNAME, TWITCH_OAUTH, TWITCH_CHANNEL, BOT_PREFIX=!
3) node indicouch-case-bot.js
--------------------------------------------------------------------------------
*/

import tmi from 'tmi.js';
import dotenv from 'dotenv';
import http from 'http';
dotenv.config();

// Unique instance tag (helps you spot double instances in logs)
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

// ----------------- Config -----------------
const CONFIG = {
  prefix: process.env.BOT_PREFIX || '!',
  defaultCaseKey: 'CS:GO Weapon Case',
  maxOpensPerCommand: 10,
  stattrakChance: 0.10,   // ~10% StatTrak
  souvenirChance: 0.00,   // 0% (normal cases)
  // Wear distribution (approx): FN 3%, MW 7%, FT 38%, WW 38%, BS 14%
  wearTiers: [
    { key: 'Factory New',  short: 'FN', p: 0.03, float: [0.00, 0.07] },
    { key: 'Minimal Wear', short: 'MW', p: 0.07, float: [0.07, 0.15] },
    { key: 'Field-Tested', short: 'FT', p: 0.38, float: [0.15, 0.38] },
    { key: 'Well-Worn',    short: 'WW', p: 0.38, float: [0.38, 0.45] },
    { key: 'Battle-Scarred', short: 'BS', p: 0.14, float: [0.45, 1.00] },
  ],
  // CS2 case rarity odds (approx community-known)
  rarities: [
    { key: 'Gold',   p: 0.0026 }, // 0.26% rare special (knife/glove)
    { key: 'Red',    p: 0.0064 }, // 0.64% Covert
    { key: 'Pink',   p: 0.032  }, // 3.20% Classified
    { key: 'Purple', p: 0.1598 }, // 15.98% Restricted
    { key: 'Blue',   p: 0.7992 }, // 79.92% Mil-Spec
  ],
};

// ----------------- In-memory state (no disk) -----------------
const STATE = {
  inv: {},        // { user: Drop[] }
  stats: { opens: 0, drops: {} },
  defaults: {},   // { user: caseKey }
};

// ----------------- RNG + helpers -----------------
function rng() { return Math.random(); }
function weightedPick(items, weightProp = 'p') {
  const r = rng(); let acc = 0; for (const it of items) { acc += it[weightProp]; if (r <= acc) return it; } return items[items.length - 1];
}
function pickWear() { const wear = weightedPick(CONFIG.wearTiers); const [min,max]=wear.float; const fl = +(min + rng()*(max-min)).toFixed(4); return { ...wear, float: fl }; }
function pickRarityKey() { return weightedPick([...CONFIG.rarities].reverse()).key; }
function randomFrom(arr) { return arr[Math.floor(rng() * arr.length)]; }

// Deduplicate replies by message id (helps if the event fires twice within one proc)
const SEEN_MSG = new Set();
function alreadyHandled(tags) {
  const id = tags['id'] || tags.id; if (!id) return false; // some clients lack id
  if (SEEN_MSG.has(id)) return true; SEEN_MSG.add(id); setTimeout(()=>SEEN_MSG.delete(id), 5*60*1000); return false;
}

// ----------------- Gold pools -----------------
const KNIFE_FINISHES = [
  'Fade','Case Hardened','Crimson Web','Slaughter','Night','Blue Steel',
  'Boreal Forest','Stained','Safari Mesh','Scorched','Urban Masked'
];
const KNIVES_OG = [ 'Bayonet','Flip Knife','Gut Knife','Karambit','M9 Bayonet' ]
  .flatMap(model => KNIFE_FINISHES.map(name => ({ weapon: `★ ${model}`, name })));
const KNIVES_BUTTERFLY = KNIFE_FINISHES.map(name => ({ weapon: '★ Butterfly Knife', name }));

const GLOVES_A = [
  "Sport Gloves | Vice", "Sport Gloves | Pandora's Box", 'Sport Gloves | Superconductor', 'Sport Gloves | Hedge Maze',
  'Specialist Gloves | Crimson Kimono', 'Specialist Gloves | Emerald Web', 'Specialist Gloves | Foundation', 'Specialist Gloves | Forest DDPAT',
  'Moto Gloves | Spearmint', 'Moto Gloves | Cool Mint', 'Moto Gloves | Turtle', 'Moto Gloves | Boom!',
  'Hand Wraps | Cobalt Skulls', 'Hand Wraps | Slaughter', 'Hand Wraps | Leather', 'Hand Wraps | Spruce DDPAT',
  'Driver Gloves | King Snake', 'Driver Gloves | Overtake', 'Driver Gloves | Imperial Plaid', 'Driver Gloves | Crimson Weave',
  'Hydra Gloves | Emerald', 'Hydra Gloves | Rattler', 'Hydra Gloves | Case Hardened', 'Hydra Gloves | Mangrove'
].map(full => ({ weapon: '★ Gloves', name: full }));

const GLOVES_B = [
  'Sport Gloves | Amphibious','Sport Gloves | Arid','Sport Gloves | Bronze Morph','Sport Gloves | Nocts',
  'Specialist Gloves | Mogul','Specialist Gloves | Marble Fade','Specialist Gloves | Tiger Strike','Specialist Gloves | Fade',
  'Moto Gloves | POW!','Moto Gloves | Polygon','Moto Gloves | Transport','Moto Gloves | Blood Pressure',
  'Hand Wraps | Duct Tape','Hand Wraps | Overprint','Hand Wraps | Arboreal','Hand Wraps | Desert Shamagh',
  'Driver Gloves | Diamondback','Driver Gloves | Snow Leopard','Driver Gloves | Racing Green','Driver Gloves | Lunar Weave',
  'Broken Fang Gloves | Jade','Broken Fang Gloves | Needle Point','Broken Fang Gloves | Yellow-banded','Broken Fang Gloves | Unhinged'
].map(full => ({ weapon: '★ Gloves', name: full }));

// ----------------- Cases -----------------
const CASES = {
  'CS:GO Weapon Case': {
    type: 'knife',
    Blue: [ { weapon: 'MP7', name: 'Skulls' }, { weapon: 'Nova', name: 'Sand Dune' }, { weapon: 'Glock-18', name: 'Brass' }, { weapon: 'SG 553', name: 'Ultraviolet' }, { weapon: 'AUG', name: 'Wings' } ],
    Purple: [ { weapon: 'Desert Eagle', name: 'Hypnotic' }, { weapon: 'P90', name: 'Blind Spot' }, { weapon: 'M4A1-S', name: 'Dark Water' } ],
    Pink: [ { weapon: 'AK-47', name: 'Case Hardened' }, { weapon: 'AWP', name: 'Lightning Strike' } ],
    Red:  [ { weapon: 'M4A4', name: 'Asiimov' }, { weapon: 'AK-47', name: 'Redline' } ],
    Gold: KNIVES_OG,
  },
  'Operation Breakout Weapon Case': {
    type: 'knife',
    Blue:   [ { weapon: 'PP-Bizon', name: 'Osiris' }, { weapon: 'UMP-45', name: 'Labyrinth' }, { weapon: 'P2000', name: 'Ivory' }, { weapon: 'Nova', name: 'Koi' }, { weapon: 'Negev', name: 'Desert-Strike' } ],
    Purple: [ { weapon: 'P90', name: 'Asiimov' }, { weapon: 'CZ75-Auto', name: 'Tigris' }, { weapon: 'Five-SeveN', name: 'Fowl Play' } ],
    Pink:   [ { weapon: 'M4A1-S', name: 'Cyrex' }, { weapon: 'Glock-18', name: 'Water Elemental' } ],
    Red:    [ { weapon: 'Desert Eagle', name: 'Conspiracy' }, { weapon: 'P90', name: 'Trigon' } ],
    Gold: KNIVES_BUTTERFLY,
  },
  'Glove Case': {
    type: 'glove',
    Blue:   [ { weapon: 'MP7', name: 'Cirrus' }, { weapon: 'G3SG1', name: 'Stinger' }, { weapon: 'CZ75-Auto', name: 'Polymer' }, { weapon: 'P2000', name: 'Turf' }, { weapon: 'Nova', name: 'Gila' } ],
    Purple: [ { weapon: 'Galil AR', name: 'Black Sand' }, { weapon: 'M4A4', name: 'Buzz Kill' }, { weapon: 'USP-S', name: 'Cyrex' } ],
    Pink:   [ { weapon: 'FAMAS', name: 'Mecha Industries' }, { weapon: 'SSG 08', name: 'Dragonfire' } ],
    Red:    [ { weapon: 'AK-47', name: 'Wasteland Rebel' }, { weapon: 'P90', name: 'Shallow Grave' } ],
    Gold: GLOVES_A,
  },
  'Gallery Case': {
    // separate from Glove Case; different content but still a gloves case (for stream fun)
    type: 'glove',
    Blue:   [ { weapon: 'MP9', name: 'Goo' }, { weapon: 'XM1014', name: 'Teclu Burner' }, { weapon: 'UMP-45', name: 'Exposure' }, { weapon: 'P250', name: 'Iron Clad' }, { weapon: 'FAMAS', name: 'Pulse' } ],
    Purple: [ { weapon: 'USP-S', name: 'Blueprint' }, { weapon: 'Five-SeveN', name: 'Triumvirate' }, { weapon: 'AUG', name: 'Aristocrat' } ],
    Pink:   [ { weapon: 'AK-47', name: 'Fuel Injector' }, { weapon: 'M4A1-S', name: 'Decimator' } ],
    Red:    [ { weapon: 'AWP', name: 'Mortis' }, { weapon: 'Desert Eagle', name: 'Kumicho Dragon' } ],
    Gold: GLOVES_B,
  },
  'Fever Case': {
    type: 'knife',
    Blue:   [ { weapon: 'MP9', name: 'Goo' }, { weapon: 'MAC-10', name: 'Last Dive' }, { weapon: 'FAMAS', name: 'Pulse' }, { weapon: 'CZ75-Auto', name: 'Tacticat' }, { weapon: 'XM1014', name: 'Bone Machine' } ],
    Purple: [ { weapon: 'SSG 08', name: 'Fever Dream' }, { weapon: 'UMP-45', name: 'Primal Saber' }, { weapon: 'P250', name: 'Asiimov' } ],
    Pink:   [ { weapon: 'AK-47', name: 'Fever Dream' }, { weapon: 'M4A1-S', name: 'Decimator' } ],
    Red:    [ { weapon: 'AWP', name: 'Hyper Beast' }, { weapon: 'Desert Eagle', name: 'Blaze' } ],
    Gold: KNIVES_OG,
  },
};

// ----------------- Draw + format -----------------
function makeGoldDrop(caseKey) { return randomFrom(CASES[caseKey].Gold); }
function openOne(caseKey) {
  const rarity = pickRarityKey();
  const wear = pickWear();
  let item;
  if (rarity === 'Gold') item = makeGoldDrop(caseKey);
  else item = randomFrom(CASES[caseKey]?.[rarity] || []) || { weapon: 'Unknown', name: 'Mystery' };
  const stattrak = rng() < CONFIG.stattrakChance;
  const souvenir = CONFIG.souvenirChance > 0 && rng() < CONFIG.souvenirChance;
  return { case: caseKey, rarity, wear: wear.key, float: wear.float, stattrak, souvenir, weapon: item.weapon, name: item.name };
}
function rarityEmoji(r) { return r==='Gold'?'✨':r==='Red'?'🔴':r==='Pink'?'🟣':r==='Purple'?'🟪':'🔵'; }
function formatDrop(d) { const mods=[]; if(d.souvenir) mods.push('Souvenir'); if(d.stattrak) mods.push('StatTrak'); const pre=mods.length?mods.join(' ')+' ':''; const w=(d.wear||'').split(' ').map(s=>s[0]).join(''); return `${rarityEmoji(d.rarity)} ${pre}${d.weapon} | ${d.name} (${w} • ${d.float.toFixed(4)})`; }

// ----------------- Inventory/Stats (memory) -----------------
function addToInventory(user, drop) { (STATE.inv[user] ||= []).push(drop); }
function getInventory(user) { return STATE.inv[user] || []; }
function pushStats(drop) { STATE.stats.opens++; STATE.stats.drops[drop.rarity]=(STATE.stats.drops[drop.rarity]||0)+1; }
function getStats() { const s=STATE.stats; const by=s.drops; const fmt=['Gold','Red','Pink','Purple','Blue'].map(r=>`${rarityEmoji(r)} ${r}: ${by[r]||0}`).join(' | '); return { total:s.opens, fmt }; }

// points (not $) for leaderboard/worth while pricing is off
const RARITY_POINTS = { Gold:100, Red:25, Pink:10, Purple:3, Blue:1 };
async function inventoryValue(user){ const items=getInventory(user); let sum=0; for(const d of items) sum += RARITY_POINTS[d.rarity]||0; return { totalPts: sum, count: items.length }; }
async function leaderboardTop(n=5){ const rows=[]; for(const [u,items] of Object.entries(STATE.inv)){ let s=0; for(const d of items) s+=RARITY_POINTS[d.rarity]||0; rows.push({ user:u, total:s, count:items.length }); } rows.sort((a,b)=>b.total-a.total); return rows.slice(0, Math.max(1, Math.min(25, n))); }

// ----------------- Defaults & resolution -----------------
function setDefaultCase(user, caseKey){ STATE.defaults[user]=caseKey; }
function getDefaultCase(user){ return STATE.defaults[user] || CONFIG.defaultCaseKey; }
function resolveCaseKey(input){ if(!input) return null; const s=input.toLowerCase(); const keys=Object.keys(CASES); return keys.find(k=>k.toLowerCase()===s) || keys.find(k=>k.toLowerCase().startsWith(s)) || null; }

// ----------------- Cooldowns -----------------
const cdMap = new Map();
const COOLDOWN_MS = 3000;
function onCooldown(user){ const now=Date.now(); const last=cdMap.get(user)||0; if(now-last<COOLDOWN_MS) return true; cdMap.set(user, now); return false; }

// ----------------- Twitch Client -----------------
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: [process.env.TWITCH_CHANNEL],
});
client.connect().then(()=>{ console.log(`[indicouch:${INSTANCE_ID}] connected to`, process.env.TWITCH_CHANNEL); }).catch(console.error);

// Health endpoint (Render)
const PORT = process.env.PORT || 3000;
http.createServer((req,res)=>{ if(req.url==='/healthz'){ res.writeHead(200,{ 'Content-Type':'text/plain'}); return res.end('ok'); } res.writeHead(200,{ 'Content-Type':'text/plain'}); res.end('Indicouch Case Bot OK (no persistence)'); }).listen(PORT, ()=> console.log(`[indicouch:${INSTANCE_ID}] health on :${PORT}`));

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
  if (alreadyHandled(tags)) return; // local de-dupe within this instance

  const user = (tags['display-name'] || tags.username || 'user').toLowerCase();
  if (!message.startsWith(CONFIG.prefix)) return;
  if (onCooldown(user)) return;

  const args = message.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();
  console.log(`[${INSTANCE_ID}] ${user} → ${cmd} ${args.join(' ')}`);

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
      for (let i=0;i<count;i++){ const drop = openOne(caseKey); results.push(drop); addToInventory(user, drop); pushStats(drop); }
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
