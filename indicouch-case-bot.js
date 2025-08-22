/*
Dro_bot_ — CS2 Case-Opening Chatbot for Twitch (tmi.js)
Author: you + GPT-5 Thinking
License: MIT

STREAM-READY • One-instance (no repeat replies) • Pricing • Disk persistence • New Cases
- Anti-duplicate replies (message-id + fingerprint) and outbound dedupe
- CS2-style odds & wear, StatTrak toggles, summary for big opens
- Live pricing: Skinport + optional CSFloat (with fuzzy !price + !price last)
- Commands: !open, !cases, !inv, !invlist, !price, !worth, !top, !stats, !setcase, !mycase, !dro, !drobot
- Cases included: CS:GO Weapon Case, Operation Breakout Weapon Case, Fever Case, Prisma 2, Dreams & Nightmares, Fracture
- Minimal HTTP server with /healthz and optional /backup (ADMIN_KEY+PUBLIC_URL)

Quick start
1) npm init -y && npm i tmi.js dotenv
2) Create .env with:
   TWITCH_USERNAME=your_bot_username
   TWITCH_OAUTH=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWITCH_CHANNEL=your_channel_name
   BOT_PREFIX=!
   PRICE_PROVIDER=best_of
   PRICE_CURRENCY=USD
   PRICE_TTL_MINUTES=10
   CSFLOAT_API_KEY=
   # Disk path (Render persistent disk):
   DATA_DIR=/var/data/indicouch
   # Optional for /backup endpoint + !backupurl
   ADMIN_KEY=choose-a-secret
   PUBLIC_URL=https://your-service.onrender.com
   # Chat filtering for !invlist (hide cheap items):
   PRICE_CHAT_FLOOR=5
3) node indicouch-case-bot.js
--------------------------------------------------------------------------------
*/

import fs from 'fs';
import path from 'path';
import tmi from 'tmi.js';
import dotenv from 'dotenv';
import http from 'http';
dotenv.config();

// ================== Instance + De-dupe ==================
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
// Prefer Twitch message id; fallback to fingerprint(user+room+message)
const SEEN_IDS = new Set();
const SEEN_FPS = new Map(); // key -> ts
function _fp(tags, message) {
  const u = (tags['user-id'] || tags.username || '').toString();
  const r = (tags['room-id'] || '').toString();
  const m = (message || '').trim().toLowerCase();
  return `${u}|${r}|${m}`;
}
function alreadyHandled(tags, message) {
  const id = tags && (tags['id'] || tags.id);
  if (id) {
    if (SEEN_IDS.has(id)) return true;
    SEEN_IDS.add(id);
    setTimeout(() => SEEN_IDS.delete(id), 5 * 60 * 1000);
    return false;
  }
  // No id? Use fingerprint for a short window
  const key = _fp(tags, message);
  const now = Date.now();
  const last = SEEN_FPS.get(key) || 0;
  if (now - last < 6000) return true; // seen same msg within 6s
  SEEN_FPS.set(key, now);
  setTimeout(() => SEEN_FPS.delete(key), 10 * 60 * 1000);
  return false;
}

// Optional admin controls for /backup
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const PUBLIC_URL = process.env.PUBLIC_URL || null; // e.g., https://your-service.onrender.com

// ================== Config ==================
const CONFIG = {
  prefix: process.env.BOT_PREFIX || '!',
  defaultCaseKey: 'Prisma 2 Case',
  maxOpensPerCommand: 100,
  stattrakChance: 0.10, // 10%
  souvenirChance: 0.00, // set >0 for souvenir-capable cases
  wearTiers: [
    // FN 3%, MW 7%, FT 38%, WW 38%, BS 14%
    { key: 'Factory New', short: 'FN', p: 0.03, float: [0.00, 0.07] },
    { key: 'Minimal Wear', short: 'MW', p: 0.07, float: [0.07, 0.15] },
    { key: 'Field-Tested', short: 'FT', p: 0.38, float: [0.15, 0.38] },
    { key: 'Well-Worn', short: 'WW', p: 0.38, float: [0.38, 0.45] },
    { key: 'Battle-Scarred', short: 'BS', p: 0.14, float: [0.45, 1.00] },
  ],
  rarities: [
    // CS2-ish case odds (approximate)
    { key: 'Gold',   color: '★',          p: 0.0026 },
    { key: 'Red',    color: 'Covert',     p: 0.0064 },
    { key: 'Pink',   color: 'Classified', p: 0.032  },
    { key: 'Purple', color: 'Restricted', p: 0.1598 },
    { key: 'Blue',   color: 'Mil-Spec',   p: 0.7992 },
  ],
};

// ================== Case + Skin Data ==================
const CASES = {
  // New: CS:GO Weapon Case (classic knives on Gold)
  'CS:GO Weapon Case': {
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
    Gold: [
      // Bayonet
      { weapon: '★ Bayonet', name: 'Fade' },
      { weapon: '★ Bayonet', name: 'Case Hardened' },
      { weapon: '★ Bayonet', name: 'Crimson Web' },
      { weapon: '★ Bayonet', name: 'Slaughter' },
      { weapon: '★ Bayonet', name: 'Night' },
      { weapon: '★ Bayonet', name: 'Blue Steel' },
      { weapon: '★ Bayonet', name: 'Boreal Forest' },
      { weapon: '★ Bayonet', name: 'Stained' },
      { weapon: '★ Bayonet', name: 'Safari Mesh' },
      { weapon: '★ Bayonet', name: 'Scorched' },
      { weapon: '★ Bayonet', name: 'Urban Masked' },
      // Flip
      { weapon: '★ Flip Knife', name: 'Fade' },
      { weapon: '★ Flip Knife', name: 'Case Hardened' },
      { weapon: '★ Flip Knife', name: 'Crimson Web' },
      { weapon: '★ Flip Knife', name: 'Slaughter' },
      { weapon: '★ Flip Knife', name: 'Night' },
      { weapon: '★ Flip Knife', name: 'Blue Steel' },
      { weapon: '★ Flip Knife', name: 'Boreal Forest' },
      { weapon: '★ Flip Knife', name: 'Stained' },
      { weapon: '★ Flip Knife', name: 'Safari Mesh' },
      { weapon: '★ Flip Knife', name: 'Scorched' },
      { weapon: '★ Flip Knife', name: 'Urban Masked' },
      // Gut
      { weapon: '★ Gut Knife', name: 'Fade' },
      { weapon: '★ Gut Knife', name: 'Case Hardened' },
      { weapon: '★ Gut Knife', name: 'Crimson Web' },
      { weapon: '★ Gut Knife', name: 'Slaughter' },
      { weapon: '★ Gut Knife', name: 'Night' },
      { weapon: '★ Gut Knife', name: 'Blue Steel' },
      { weapon: '★ Gut Knife', name: 'Boreal Forest' },
      { weapon: '★ Gut Knife', name: 'Stained' },
      { weapon: '★ Gut Knife', name: 'Safari Mesh' },
      { weapon: '★ Gut Knife', name: 'Scorched' },
      { weapon: '★ Gut Knife', name: 'Urban Masked' },
      // Karambit
      { weapon: '★ Karambit', name: 'Fade' },
      { weapon: '★ Karambit', name: 'Case Hardened' },
      { weapon: '★ Karambit', name: 'Crimson Web' },
      { weapon: '★ Karambit', name: 'Slaughter' },
      { weapon: '★ Karambit', name: 'Night' },
      { weapon: '★ Karambit', name: 'Blue Steel' },
      { weapon: '★ Karambit', name: 'Boreal Forest' },
      { weapon: '★ Karambit', name: 'Stained' },
      { weapon: '★ Karambit', name: 'Safari Mesh' },
      { weapon: '★ Karambit', name: 'Scorched' },
      { weapon: '★ Karambit', name: 'Urban Masked' },
      // M9 Bayonet
      { weapon: '★ M9 Bayonet', name: 'Fade' },
      { weapon: '★ M9 Bayonet', name: 'Case Hardened' },
      { weapon: '★ M9 Bayonet', name: 'Crimson Web' },
      { weapon: '★ M9 Bayonet', name: 'Slaughter' },
      { weapon: '★ M9 Bayonet', name: 'Night' },
      { weapon: '★ M9 Bayonet', name: 'Blue Steel' },
      { weapon: '★ M9 Bayonet', name: 'Boreal Forest' },
      { weapon: '★ M9 Bayonet', name: 'Stained' },
      { weapon: '★ M9 Bayonet', name: 'Safari Mesh' },
      { weapon: '★ M9 Bayonet', name: 'Scorched' },
      { weapon: '★ M9 Bayonet', name: 'Urban Masked' },
    ],
  },

  // New: Operation Breakout Weapon Case (Butterfly knives on Gold)
  'Operation Breakout Weapon Case': {
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
    Gold: [
      { weapon: '★ Butterfly Knife', name: 'Fade' },
      { weapon: '★ Butterfly Knife', name: 'Case Hardened' },
      { weapon: '★ Butterfly Knife', name: 'Crimson Web' },
      { weapon: '★ Butterfly Knife', name: 'Slaughter' },
      { weapon: '★ Butterfly Knife', name: 'Night' },
      { weapon: '★ Butterfly Knife', name: 'Blue Steel' },
      { weapon: '★ Butterfly Knife', name: 'Boreal Forest' },
      { weapon: '★ Butterfly Knife', name: 'Stained' },
      { weapon: '★ Butterfly Knife', name: 'Safari Mesh' },
      { weapon: '★ Butterfly Knife', name: 'Scorched' },
      { weapon: '★ Butterfly Knife', name: 'Urban Masked' },
    ],
  },

  // New: Fever Case (classic knives on Gold)
  'Fever Case': {
    Blue: [
      { weapon: 'MP9', name: 'Goo' },
      { weapon: 'MAC-10', name: 'Last Dive' },
      { weapon: 'FAMAS', name: 'Pulse' },
      { weapon: 'CZ75-Auto', name: 'Tacticat' },
      { weapon: 'XM1014', name: 'Bone Machine' },
    ],
    Purple: [
      { weapon: 'SSG 08', name: 'Fever Dream' },
      { weapon: 'UMP-45', name: 'Primal Saber' },
      { weapon: 'P250', name: 'Asiimov' },
    ],
    Pink: [
      { weapon: 'AK-47', name: 'Fever Dream' },
      { weapon: 'M4A1-S', name: 'Decimator' },
    ],
    Red: [
      { weapon: 'AWP', name: 'Hyper Beast' },
      { weapon: 'Desert Eagle', name: 'Blaze' },
    ],
    Gold: [
      // classic knives (same pool as CS:GO Weapon Case)
      { weapon: '★ Bayonet', name: 'Fade' },
      { weapon: '★ Bayonet', name: 'Case Hardened' },
      { weapon: '★ Bayonet', name: 'Crimson Web' },
      { weapon: '★ Bayonet', name: 'Slaughter' },
      { weapon: '★ Bayonet', name: 'Night' },
      { weapon: '★ Bayonet', name: 'Blue Steel' },
      { weapon: '★ Bayonet', name: 'Boreal Forest' },
      { weapon: '★ Bayonet', name: 'Stained' },
      { weapon: '★ Bayonet', name: 'Safari Mesh' },
      { weapon: '★ Bayonet', name: 'Scorched' },
      { weapon: '★ Bayonet', name: 'Urban Masked' },
      { weapon: '★ Flip Knife', name: 'Fade' },
      { weapon: '★ Flip Knife', name: 'Case Hardened' },
      { weapon: '★ Flip Knife', name: 'Crimson Web' },
      { weapon: '★ Flip Knife', name: 'Slaughter' },
      { weapon: '★ Flip Knife', name: 'Night' },
      { weapon: '★ Flip Knife', name: 'Blue Steel' },
      { weapon: '★ Flip Knife', name: 'Boreal Forest' },
      { weapon: '★ Flip Knife', name: 'Stained' },
      { weapon: '★ Flip Knife', name: 'Safari Mesh' },
      { weapon: '★ Flip Knife', name: 'Scorched' },
      { weapon: '★ Flip Knife', name: 'Urban Masked' },
      { weapon: '★ Gut Knife', name: 'Fade' },
      { weapon: '★ Gut Knife', name: 'Case Hardened' },
      { weapon: '★ Gut Knife', name: 'Crimson Web' },
      { weapon: '★ Gut Knife', name: 'Slaughter' },
      { weapon: '★ Gut Knife', name: 'Night' },
      { weapon: '★ Gut Knife', name: 'Blue Steel' },
      { weapon: '★ Gut Knife', name: 'Boreal Forest' },
      { weapon: '★ Gut Knife', name: 'Stained' },
      { weapon: '★ Gut Knife', name: 'Safari Mesh' },
      { weapon: '★ Gut Knife', name: 'Scorched' },
      { weapon: '★ Gut Knife', name: 'Urban Masked' },
      { weapon: '★ Karambit', name: 'Fade' },
      { weapon: '★ Karambit', name: 'Case Hardened' },
      { weapon: '★ Karambit', name: 'Crimson Web' },
      { weapon: '★ Karambit', name: 'Slaughter' },
      { weapon: '★ Karambit', name: 'Night' },
      { weapon: '★ Karambit', name: 'Blue Steel' },
      { weapon: '★ Karambit', name: 'Boreal Forest' },
      { weapon: '★ Karambit', name: 'Stained' },
      { weapon: '★ Karambit', name: 'Safari Mesh' },
      { weapon: '★ Karambit', name: 'Scorched' },
      { weapon: '★ Karambit', name: 'Urban Masked' },
      { weapon: '★ M9 Bayonet', name: 'Fade' },
      { weapon: '★ M9 Bayonet', name: 'Case Hardened' },
      { weapon: '★ M9 Bayonet', name: 'Crimson Web' },
      { weapon: '★ M9 Bayonet', name: 'Slaughter' },
      { weapon: '★ M9 Bayonet', name: 'Night' },
      { weapon: '★ M9 Bayonet', name: 'Blue Steel' },
      { weapon: '★ M9 Bayonet', name: 'Boreal Forest' },
      { weapon: '★ M9 Bayonet', name: 'Stained' },
      { weapon: '★ M9 Bayonet', name: 'Safari Mesh' },
      { weapon: '★ M9 Bayonet', name: 'Scorched' },
      { weapon: '★ M9 Bayonet', name: 'Urban Masked' },
    ],
  },

  // Existing: Prisma 2
  'Prisma 2 Case': {
    Blue: [
      { weapon: 'CZ75-Auto', name: 'Distressed' },
      { weapon: 'P2000', name: 'Acid Etched' },
      { weapon: 'SCAR-20', name: 'Enforcer' },
      { weapon: 'SG 553', name: 'Darkwing' },
      { weapon: 'MAC-10', name: 'Disco Tech' },
    ],
    Purple: [
      { weapon: 'R8 Revolver', name: 'Bone Forged' },
      { weapon: 'Desert Eagle', name: 'Blue Ply' },
      { weapon: 'AK-47', name: 'Phantom Disruptor' },
      { weapon: 'Sawed-Off', name: 'Apocalypto' },
    ],
    Pink: [
      { weapon: 'M4A1-S', name: 'Player Two' },
      { weapon: 'Glock-18', name: 'Bullet Queen' },
    ],
    Red: [
      { weapon: 'AUG', name: 'Tom Cat' },
      { weapon: 'SSG 08', name: 'Fever Dream' },
    ],
    Gold: [
      { weapon: '★ Stiletto Knife', name: 'Doppler' },
      { weapon: '★ Nomad Knife', name: 'Marble Fade' },
    ],
  },

  // Existing: Dreams & Nightmares
  'Dreams & Nightmares Case': {
    Blue: [
      { weapon: 'P2000', name: 'Lifted Spirits' },
      { weapon: 'XM1014', name: 'Zombie Offensive' },
      { weapon: 'G3SG1', name: 'Dream Glade' },
      { weapon: 'SCAR-20', name: 'Ensnared' },
      { weapon: 'MP7', name: 'Guerrilla' },
    ],
    Purple: [
      { weapon: 'USP-S', name: 'Ticket to Hell' },
      { weapon: 'MAC-10', name: 'Ensnared' },
      { weapon: 'MAG-7', name: 'Foresight' },
    ],
    Pink: [
      { weapon: 'AK-47', name: 'Nightwish' },
      { weapon: 'MP9', name: 'Starlight Protector' },
    ],
    Red: [
      { weapon: 'MP9', name: 'Food Chain' },
      { weapon: 'M4A1-S', name: 'Night Terror' },
    ],
    Gold: [
      { weapon: '★ Talon Knife', name: 'Gamma Doppler' },
      { weapon: '★ Skeleton Knife', name: 'Case Hardened' },
    ],
  },

  // Existing: Fracture
  'Fracture Case': {
    Blue: [
      { weapon: 'P250', name: 'Cassette' },
      { weapon: 'XM1014', name: 'Entombed' },
      { weapon: 'MP5-SD', name: 'Kitbash' },
      { weapon: 'Negev', name: 'Ultralight' },
    ],
    Purple: [
      { weapon: 'Tec-9', name: 'Brother' },
      { weapon: 'Galil AR', name: 'Connexion' },
      { weapon: 'MAG-7', name: 'Monster Call' },
    ],
    Pink: [
      { weapon: 'M4A4', name: 'Tooth Fairy' },
      { weapon: 'Glock-18', name: 'Vogue' },
    ],
    Red: [
      { weapon: 'Desert Eagle', name: 'Printstream' },
      { weapon: 'AK-47', name: 'Legion of Anubis' },
    ],
    Gold: [
      { weapon: '★ Karambit', name: 'Damascus Steel' },
      { weapon: '★ Bayonet', name: 'Tiger Tooth' },
    ],
  },
};

// ================== Persistence ==================
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data/indicouch' : path.join(process.cwd(), 'data'));
const INV_PATH = path.join(DATA_DIR, 'inventories.json');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const DEFAULTS_PATH = path.join(DATA_DIR, 'defaults.json');

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(INV_PATH)) fs.writeFileSync(INV_PATH, JSON.stringify({}, null, 2));
  if (!fs.existsSync(STATS_PATH)) fs.writeFileSync(STATS_PATH, JSON.stringify({ opens: 0, drops: {} }, null, 2));
  if (!fs.existsSync(DEFAULTS_PATH)) fs.writeFileSync(DEFAULTS_PATH, JSON.stringify({}, null, 2));
}

function loadJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function saveJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// ================== RNG & Core Sim ==================
function rng() { return Math.random(); }
function weightedPick(items, weightProp = 'p') {
  const r = rng(); let acc = 0; for (const it of items) { acc += it[weightProp]; if (r <= acc) return it; } return items[items.length - 1];
}
function pickWear() { const wear = weightedPick(CONFIG.wearTiers); const [min, max] = wear.float; const fl = +(min + rng() * (max - min)).toFixed(4); return { ...wear, float: fl }; }
function pickRarity() { const rarityPool = [...CONFIG.rarities].reverse(); return weightedPick(rarityPool); }
function pickSkin(caseKey, rarityKey) { const pool = CASES[caseKey]?.[rarityKey] || []; if (!pool.length) return null; return pool[Math.floor(rng() * pool.length)]; }
function rollModifiers() { const stattrak = rng() < CONFIG.stattrakChance; const souvenir = CONFIG.souvenirChance > 0 && rng() < CONFIG.souvenirChance; return { stattrak, souvenir }; }

function openOne(caseKey) {
  const rarity = pickRarity();
  const rarityKey = rarity.key; // 'Blue','Purple','Pink','Red','Gold'
  const skin = pickSkin(caseKey, rarityKey);
  const wear = pickWear();
  const { stattrak, souvenir } = rollModifiers();
  return {
    case: caseKey,
    rarity: rarityKey,
    wear: wear.key,
    float: wear.float,
    stattrak,
    souvenir,
    weapon: skin?.weapon || (rarityKey === 'Gold' ? '★ Knife' : 'Unknown'),
    name: skin?.name || 'Mystery',
  };
}

// ================== Formatting & Helpers ==================
function rarityEmoji(rarity) { return rarity==='Gold'?'✨':rarity==='Red'?'🔴':rarity==='Pink'?'🩷':rarity==='Purple'?'🟣':'🔵'; }
function formatDrop(drop) {
  const parts = [];
  if (drop.souvenir) parts.push('Souvenir');
  if (drop.stattrak) parts.push('StatTrak');
  const prefix = parts.length ? parts.join(' ') + ' ' : '';
  const wearShort = (drop.wear || '').split(' ').map(s => s[0]).join('');
  const price = (typeof drop.priceUSD === 'number') ? ` • $${drop.priceUSD.toFixed(2)}` : '';
  return `${rarityEmoji(drop.rarity)} ${prefix}${drop.weapon} | ${drop.name} (${wearShort} • ${drop.float.toFixed(4)})${price}`;
}

function normalizeRarity(input) {
  if (!input) return null;
  const t = String(input).toLowerCase();
  if (t === 'gold' || t === '✨' || t === 'yellow' || t === 'knife' || t === 'glove') return 'Gold';
  if (t === 'red' || t === 'covert' || t === '🔴') return 'Red';
  if (t === 'pink' || t === 'classified' || t === '🩷' || t === 'magenta') return 'Pink';
  if (t === 'purple' || t === 'restricted' || t === '🟣') return 'Purple';
  if (t === 'blue' || t === 'mil-spec' || t === '🔵') return 'Blue';
  return null;
}

async function sayChunkedList(channel, header, lines) {
  const chunks = [];
  let buf = header;
  for (const ln of lines) {
    const add = (buf.length ? ' | ' : '') + ln;
    if ((buf + add).length > 400) { chunks.push(buf); buf = ln; } else { buf += add; }
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) {
    try { await client.say(channel, c); } catch (e) { console.log('[chat chunk error]', e?.message || e); }
  }
}

// ================== Inventories & Stats ==================
function addToInventory(user, drop) { const inv=loadJSON(INV_PATH); (inv[user] ||= []).push(drop); saveJSON(INV_PATH, inv); }
function getInventory(user) { const inv=loadJSON(INV_PATH); return inv[user] || []; }
function pushStats(drop) { const stats=loadJSON(STATS_PATH); stats.opens=(stats.opens||0)+1; stats.drops=stats.drops||{}; stats.drops[drop.rarity]=(stats.drops[drop.rarity]||0)+1; saveJSON(STATS_PATH, stats); }
function getStats() { const stats=loadJSON(STATS_PATH); const total=stats.opens||0; const by=stats.drops||{}; const fmt=['Gold','Red','Pink','Purple','Blue'].map(r=>`${rarityEmoji(r)} ${r}: ${by[r]||0}`).join(' | '); return { total, fmt }; }

// ================== Pricing (Skinport + CSFloat) ==================
const PRICE_CFG = {
  provider: (process.env.PRICE_PROVIDER || 'best_of').toLowerCase(),
  currency: process.env.PRICE_CURRENCY || 'USD',
  ttlMs: (parseInt(process.env.PRICE_TTL_MINUTES || '10', 10) * 60000),
  csfloatKey: process.env.CSFLOAT_API_KEY || null,
};
// Minimum price to include items in chat for !invlist (to reduce spam)
const PRICE_CHAT_FLOOR = parseFloat(process.env.PRICE_CHAT_FLOOR || '5');

const PRICE_CACHE_DIR = path.join(DATA_DIR, 'pricing');
const SKINPORT_CACHE = path.join(PRICE_CACHE_DIR, 'skinport-items.json');
const PRICE_CACHE = path.join(PRICE_CACHE_DIR, 'price-cache.json');

function ensurePriceData() {
  if (!fs.existsSync(PRICE_CACHE_DIR)) fs.mkdirSync(PRICE_CACHE_DIR, { recursive: true });
  if (!fs.existsSync(SKINPORT_CACHE)) fs.writeFileSync(SKINPORT_CACHE, JSON.stringify({ fetchedAt: 0, items: [] }, null, 2));
  if (!fs.existsSync(PRICE_CACHE)) fs.writeFileSync(PRICE_CACHE, JSON.stringify({}, null, 2));
}

function readPriceJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

function marketNameFromDrop(drop) {
  const wear = drop.wear;
  const isKnife = (drop.weapon || '').startsWith('★');
  const souv = drop.souvenir ? 'Souvenir ' : '';
  if (isKnife) {
    const knifeName = drop.weapon.replace('★', '').trim();
    const starPart = '★ ' + (drop.stattrak ? 'StatTrak™ ' : '');
    return (souv + starPart + knifeName + ' | ' + drop.name + ' (' + wear + ')').trim();
  }
  const st = drop.stattrak ? 'StatTrak™ ' : '';
  return (souv + st + drop.weapon + ' | ' + drop.name + ' (' + wear + ')').trim();
}

const PriceService = {
  _skinport: { fetchedAt: 0, map: new Map() },
  _cache: readPriceJSON(PRICE_CACHE, {}),
  async _fetchSkinportItems() {
    const now = Date.now();
    const cached = readPriceJSON(SKINPORT_CACHE, { fetchedAt: 0, items: [] });
    if (now - (cached.fetchedAt || 0) < PRICE_CFG.ttlMs && cached.items && cached.items.length) {
      this._skinport.fetchedAt = cached.fetchedAt;
      this._skinport.map = new Map(cached.items.map(it => [it.market_hash_name, it]));
      return;
    }
    const params = new URLSearchParams({ app_id: '730', currency: PRICE_CFG.currency, tradable: '0' });
    const resp = await fetch('https://api.skinport.com/v1/items?' + params.toString(), { headers: { 'Accept-Encoding': 'br' } });
    const items = await resp.json();
    this._skinport.fetchedAt = now;
    this._skinport.map = new Map(items.map(it => [it.market_hash_name, it]));
    fs.writeFileSync(SKINPORT_CACHE, JSON.stringify({ fetchedAt: now, items }, null, 2));
  },
  _fromCache(marketHash) {
    const c = this._cache[marketHash];
    if (!c) return null;
    if (Date.now() - (c.fetchedAt || 0) > PRICE_CFG.ttlMs) return null;
    return c;
  },
  _saveCache(marketHash, obj) {
    this._cache[marketHash] = obj;
    fs.writeFileSync(PRICE_CACHE, JSON.stringify(this._cache, null, 2));
  },
  async _getFromSkinport(marketHash) {
    await this._fetchSkinportItems();
    const row = this._skinport.map.get(marketHash);
    if (!row) return null;
    return {
      provider: 'skinport',
      currency: row.currency || PRICE_CFG.currency,
      min: (row.min_price == null ? null : row.min_price),
      median: (row.median_price == null ? null : row.median_price),
      mean: (row.mean_price == null ? null : row.mean_price),
      suggested: (row.suggested_price == null ? null : row.suggested_price),
      url: row.item_page || row.market_page || null,
      fetchedAt: Date.now(),
    };
  },
  async _getFromCSFloat(marketHash) {
    if (!PRICE_CFG.csfloatKey) return null;
    const u = new URL('https://csfloat.com/api/v1/listings');
    u.searchParams.set('sort_by', 'lowest_price');
    u.searchParams.set('limit', '1');
    u.searchParams.set('market_hash_name', marketHash);
    const resp = await fetch(u, { headers: { Authorization: PRICE_CFG.csfloatKey } });
    if (!resp.ok) return null;
    const arr = await resp.json();
    const first = Array.isArray(arr) ? arr[0] : null;
    if (!first || !first.price) return null;
    return { provider: 'csfloat', currency: 'USD', floor: first.price / 100, url: 'https://csfloat.com', fetchedAt: Date.now() };
  },
  async priceForDrop(drop) {
    const marketHash = marketNameFromDrop(drop);
    const cached = this._fromCache(marketHash);
    if (cached) return cached;
    let sp = null, cf = null;
    if (PRICE_CFG.provider === 'skinport' || PRICE_CFG.provider === 'best_of') sp = await this._getFromSkinport(marketHash);
    if (PRICE_CFG.provider === 'csfloat'  || PRICE_CFG.provider === 'best_of') cf = await this._getFromCSFloat(marketHash);
    let usd = null, source = null, url = null;
    if (cf && typeof cf.floor === 'number') { usd = cf.floor; source = 'CSFloat floor'; url = cf.url; }
    if (sp && (sp.median != null || sp.min != null || sp.mean != null || sp.suggested != null)) {
      const val = sp.median ?? sp.min ?? sp.mean ?? sp.suggested;
      if (usd == null || (typeof val === 'number' && val < usd)) { usd = val; source = 'Skinport median'; url = sp.url; }
    }
    const out = { marketHash, usd: (typeof usd === 'number' ? Math.round(usd * 100) / 100 : null), source, url, fetchedAt: Date.now() };
    this._saveCache(marketHash, out);
    return out;
  }
};

async function priceForMarketHash(marketHash) {
  const cached = PriceService._fromCache(marketHash);
  if (cached) return cached;
  const provider = (process.env.PRICE_PROVIDER || 'best_of').toLowerCase();
  let sp = null, cf = null;
  if (provider === 'skinport' || provider === 'best_of') sp = await PriceService._getFromSkinport(marketHash);
  if (provider === 'csfloat'  || provider === 'best_of') cf = await PriceService._getFromCSFloat(marketHash);
  let usd = null, source = null, url = null;
  if (cf && typeof cf.floor === 'number') { usd = cf.floor; source = 'CSFloat floor'; url = cf.url; }
  if (sp && (sp.median != null || sp.min != null || sp.mean != null || sp.suggested != null)) {
    const val = sp.median ?? sp.min ?? sp.mean ?? sp.suggested;
    if (usd == null || (typeof val === 'number' && val < usd)) { usd = val; source = 'Skinport median'; url = sp.url; }
  }
  const out = { marketHash, usd: (typeof usd === 'number' ? Math.round(usd * 100) / 100 : null), source, url, fetchedAt: Date.now() };
  PriceService._saveCache(marketHash, out);
  return out;
}

ensurePriceData();

// Fuzzy helpers for !price
function _tokens(s) { return (s||'').toLowerCase().replace(/™/g,'').split(/[^a-z0-9]+/).filter(Boolean); }
function _expandWearAbbr(tokens) { const out=[...tokens]; for (const t of tokens) { if (t==='fn') out.push('factory','new'); if (t==='mw') out.push('minimal','wear'); if (t==='ft') out.push('field','tested'); if (t==='ww') out.push('well','worn'); if (t==='bs') out.push('battle','scarred'); if (t==='st') out.push('stattrak'); } return out; }
function _bestSkinportKeyForQuery(query) { const map = PriceService._skinport && PriceService._skinport.map; if (!map || map.size===0) return null; const qTokens=_expandWearAbbr(_tokens(query)); let bestKey=null, bestScore=0; for (const key of map.keys()) { const k=key.toLowerCase().replace(/™/g,''); let score=0; for (const t of qTokens) if (k.includes(t)) score++; if (score>bestScore) { bestScore=score; bestKey=key; } } return bestScore>=2?bestKey:null; }
async function priceLookupFlexible(input) { let out=await priceForMarketHash(input); if (out && out.usd!=null) return { ...out, resolved: input }; const candidate=_bestSkinportKeyForQuery(input); if (candidate) { out=await priceForMarketHash(candidate); if (out && out.usd!=null) return { ...out, resolved: candidate }; } return { usd: null, resolved: input }; }

// ================== Command Router & Client ==================
function isModOrBroadcaster(tags) { const badges = tags.badges || {}; return !!tags.mod || badges.broadcaster === '1'; }
const HELP_TEXT = [
  'Commands:',
  '!cases — list cases',
  '!open <case> [xN|N] — open 1-100 cases',
  '!inv [@user] — show inventory',
  '!invlist <rarity> [@user] — list items of that rarity (mods can target @user)',
  '!worth [@user] — inventory value (USD)',
  '!price <market name>|last — e.g., StatTrak™ AK-47 | Redline (Field-Tested) or "last"',
  '!top [N] — leaderboard by inventory value',
  '!stats — global drop stats',
  '!setcase <case> — set default case',
  '!mycase — show your default case',
  '!help — this menu',
].join(' | ');

function setDefaultCase(user, caseKey) { const d=loadJSON(DEFAULTS_PATH); d[user]=caseKey; saveJSON(DEFAULTS_PATH, d); }
function getDefaultCase(user) { const d=loadJSON(DEFAULTS_PATH); return d[user] || CONFIG.defaultCaseKey; }
function resolveCaseKey(input) { if (!input) return null; const key=Object.keys(CASES).find(c=>c.toLowerCase()===input.toLowerCase()); if (key) return key; const hit=Object.keys(CASES).find(c=>c.toLowerCase().startsWith(input.toLowerCase())); return hit || null; }

// Per-user cooldown
const cdMap = new Map();
const COOLDOWN_MS = 3000;
function onCooldown(user) { const now=Date.now(); const last=cdMap.get(user) || 0; if (now - last < COOLDOWN_MS) return true; cdMap.set(user, now); return false; }

// Twitch client
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true },
  connection: { secure: true, reconnect: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: [process.env.TWITCH_CHANNEL],
});

// Outbound dedupe: drop identical chat lines emitted back-to-back within 1.5s
const LAST_OUT = new Map(); // channel -> { text, ts }
const _say = (...args) => tmi.Client.prototype.say.apply(client, args);
client.say = (channel, text) => {
  const prev = LAST_OUT.get(channel);
  const now = Date.now();
  if (prev && prev.text === String(text) && (now - prev.ts) < 1500) return;
  LAST_OUT.set(channel, { text: String(text), ts: now });
  return _say(channel, text);
};

client.connect().then(() => { ensureData(); console.log(`[dro-bot:${INSTANCE_ID}] data dir = ${DATA_DIR}`); console.log(`[dro-bot:${INSTANCE_ID}] connected to`, process.env.TWITCH_CHANNEL); }).catch(console.error);

// Minimal HTTP health/backup
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (u.pathname === '/backup') {
      if (!ADMIN_KEY || u.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('unauthorized'); }
      const payload = { version: 1, ts: Date.now(), inventories: loadJSON(INV_PATH), stats: loadJSON(STATS_PATH), defaults: loadJSON(DEFAULTS_PATH) };
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="dro-bot-backup.json"' });
      return res.end(body);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Dro_bot_ OK');
  } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('server error'); }
}).listen(PORT, () => console.log(`[dro-bot:${INSTANCE_ID}] health on :${PORT}`));

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if (alreadyHandled(tags, message)) return;
  const user = (tags['display-name'] || tags.username || 'user').toLowerCase();
  if (!message.startsWith(CONFIG.prefix)) return;
  if (onCooldown(user)) return;

  const args = message.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  // Only respond to our own commands to avoid clashing with other bots
  const ALLOWED_CMDS = new Set(['help','cases','mycase','setcase','open','inv','invlist','stats','worth','price','top','backupurl','dro','drobot']);
  if (!ALLOWED_CMDS.has(cmd)) return;

  switch (cmd) {
    case 'dro':
    case 'drobot': {
      const intro = 'Yo, I’m Dro_bot_ v0.0.4.28 — your CS2 case-opening companion. Open cases with 1:1 CS2-style odds & wear, save your drops, check live prices (Skinport + CSFloat), and climb the value leaderboard. Try: !open <case>, !price last, !inv, !worth, !top, !cases . Pure sim, no real items and most importantly, completely free! GLHF ✨';
      client.say(channel, intro);
      break;
    }

    case 'help':
      client.say(channel, HELP_TEXT);
      break;

    case 'cases':
      client.say(channel, 'Available cases: ' + Object.keys(CASES).join(' | '));
      break;

    case 'mycase': {
      client.say(channel, '@' + user + ' your default case is: ' + getDefaultCase(user));
      break;
    }

    case 'setcase': {
      const input = args.join(' ');
      const key = resolveCaseKey(input);
      if (!key) { client.say(channel, '@' + user + ' I don\'t recognize that case.'); break; }
      setDefaultCase(user, key);
      client.say(channel, '@' + user + ' default case set to: ' + key);
      break;
    }

    case 'open': {
      // !open <case words...> [xN|N]
      let count = 1;
      // accept quantity as last token: either "xN" or just "N"
      let qtyIdx = -1; let qtyMatch = null;
      for (let i = args.length - 1; i >= 0; i--) {
        const m = /^x?(\d+)$/i.exec(args[i]);
        if (m) { qtyIdx = i; qtyMatch = m; break; }
      }
      if (qtyIdx >= 0) {
        count = Math.max(1, Math.min(CONFIG.maxOpensPerCommand, parseInt(qtyMatch[1], 10)));
        args.splice(qtyIdx, 1);
      }
      const caseInput = args.join(' ');
      const caseKey = caseInput ? resolveCaseKey(caseInput) : getDefaultCase(user);
      if (!caseKey) { client.say(channel, '@' + user + ' pick a case with !cases or set one with !setcase <case>.'); break; }

      const results = [];
      for (let i = 0; i < count; i++) {
        const drop = openOne(caseKey);
        results.push(drop);
        addToInventory(user, drop);
        pushStats(drop);
      }
      try { for (const d of results) { await ensurePriceOnDrop(d); } } catch {}

      if (count <= 5) {
        const lines = results.map(formatDrop).join('  |  ');
        client.say(channel, '@' + user + ' opened ' + count + 'x ' + caseKey + ': ' + lines);
        break;
      }

      // Beyond 5: show first 5, then summarize the rest by value + highlights
      const head = results.slice(0, 5).map(formatDrop).join('  |  ');
      const tail = results.slice(5);

      let tailValue = 0;
      for (const d of tail) if (typeof d.priceUSD === 'number') tailValue += d.priceUSD;

      const reds = tail.filter(d => d.rarity === 'Red').length;
      const golds = tail.filter(d => d.rarity === 'Gold').length;
      const lowFloat = tail.filter(d => d.float <= 0.05).length; // super low floats

      const highlights = [];
      if (golds) highlights.push('✨x' + golds);
      if (reds) highlights.push('🔴x' + reds);
      if (lowFloat) highlights.push('⬇️x' + lowFloat);

      const more = '… +' + tail.length + ' more (~$' + tailValue.toFixed(2) + ')';
      const hl = highlights.length ? ' Highlights: ' + highlights.join(' ') : '';

      client.say(channel, '@' + user + ' opened ' + count + 'x ' + caseKey + ': ' + head + '  |  ' + more + '.' + hl);
      break;
    }

    case 'inv': {
      const target = (args[0]?.replace('@','') || user).toLowerCase();
      const items = getInventory(target);
      if (items.length === 0) { client.say(channel, '@' + user + ' ' + target + ' has an empty inventory. Use !open to pull some heat.'); break; }
      const counts = { Gold:0, Red:0, Pink:0, Purple:0, Blue:0 };
      for (const it of items) if (counts[it.rarity] != null) counts[it.rarity]++;
      const order = ['Gold','Red','Pink','Purple','Blue'];
      const parts = order.map(r => `${rarityEmoji(r)} ${r}: ${counts[r] || 0}`).join(' | ');
      client.say(channel, '@' + user + ' ' + target + "'s inventory (" + items.length + ' items) — ' + parts);
      break;
    }

    case 'invlist': {
      // Usage: !invlist <rarity> [@user]
      const rarityArg = (args[0] || '').toLowerCase();
      const rarityKey = normalizeRarity(rarityArg);
      if (!rarityKey) { client.say(channel, '@' + user + ' usage: !invlist <gold|red|pink|purple|blue> [@user]'); break; }

      let targetUser = user;
      if (args[1]) {
        const maybe = args[1].replace('@','').toLowerCase();
        if (isModOrBroadcaster(tags)) targetUser = maybe; else { client.say(channel, '@' + user + ' mods/broadcaster only to target another user.'); break; }
      }

      const all = getInventory(targetUser).filter(it => it.rarity === rarityKey);
      if (!all.length) { client.say(channel, '@' + user + ' ' + targetUser + ' has no ' + rarityKey + ' items yet.'); break; }

      // Ensure we have prices so we can filter/sort
      try { await Promise.all(all.map(d => ensurePriceOnDrop(d))); } catch {}

      const priced = all.filter(d => typeof d.priceUSD === 'number');
      const pricedAbove = priced.filter(d => d.priceUSD >= PRICE_CHAT_FLOOR);
      const pricedBelow = priced.filter(d => d.priceUSD < PRICE_CHAT_FLOOR);
      const unknown = all.filter(d => typeof d.priceUSD !== 'number');

      // Sort priced-above-threshold by price desc; unknowns after
      pricedAbove.sort((a,b)=> (b.priceUSD||0) - (a.priceUSD||0));
      const display = pricedAbove.concat(unknown);
      const hiddenCount = pricedBelow.length;

      const basic = (d) => {
        const parts = [];
        if (d.souvenir) parts.push('Souvenir');
        if (d.stattrak) parts.push('StatTrak');
        const prefix = parts.length ? parts.join(' ') + ' ' : '';
        const wearShort = (d.wear || '').split(' ').map(s => s[0]).join('');
        return prefix + d.weapon + ' | ' + d.name + ' (' + wearShort + ')';
      };

      if (display.length === 0) {
        client.say(channel, '@' + user + ' no ' + rarityKey + ' items ≥ $' + PRICE_CHAT_FLOOR + ' (hidden ' + hiddenCount + ' under $' + PRICE_CHAT_FLOOR + ').');
        break;
      }

      const header = '@' + user + ' [' + rarityEmoji(rarityKey) + ' ' + rarityKey + '] ' + display.length + ' item(s)'
        + (targetUser!==user ? (' for @' + targetUser) : '')
        + (hiddenCount ? (' (+' + hiddenCount + ' hidden < $' + PRICE_CHAT_FLOOR + ')') : '') + ':';

      // If many items, avoid spam: show a single line with Top 3 then counts
      if (display.length > 20) {
        const top3 = display.slice(0,3).map(basic).join(' | ');
        const more = display.length - 3;
        const suffixParts = [];
        if (more > 0) suffixParts.push('+' + more + ' more ≥ $' + PRICE_CHAT_FLOOR);
        if (hiddenCount > 0) suffixParts.push('+' + hiddenCount + ' hidden < $' + PRICE_CHAT_FLOOR);
        const suffix = suffixParts.length ? ('  |  ' + suffixParts.join(' ; ')) : '';
        client.say(channel, header + ' Top 3: ' + top3 + suffix);
        break;
      }

      // Otherwise, list and chunk if needed
      const lines = display.map(basic);
      await sayChunkedList(channel, header, lines);
      break;
    }

    case 'stats': {
      const s = getStats();
      client.say(channel, 'Drops so far — Total opens: ' + s.total + ' | ' + s.fmt);
      break;
    }

    case 'worth': {
      const rawTarget = (args[0]?.replace('@','') || user).toLowerCase();
      const isSelf = rawTarget === user;
      const target = rawTarget;
      const { totalUSD, count } = await inventoryValue(target);
      if (count === 0) {
        if (isSelf) { client.say(channel, '@' + user + ' you have an empty inventory.'); }
        else { client.say(channel, '@' + user + ' @' + target + ' has an empty inventory.'); }
        break;
      }
      const msg = isSelf
        ? ('@' + user + ' inventory: ' + count + ' items • ~$' + totalUSD.toFixed(2) + ' USD')
        : ('@' + user + ' @' + target + "'s inventory: " + count + ' items • ~$' + totalUSD.toFixed(2) + ' USD');
      client.say(channel, msg);
      break;
    }

    case 'price': {
      const q = args.join(' ').trim();
      if (!q) { client.say(channel, '@' + user + ' usage: !price <market name> — e.g., StatTrak™ AK-47 | Redline (Field-Tested) or !price last'); break; }
      if (q.toLowerCase() === 'last') {
        const items = getInventory(user);
        if (!items.length) { client.say(channel, '@' + user + ' you have no drops yet. Use !open first.'); break; }
        const last = items[items.length - 1];
        const mh = marketNameFromDrop(last);
        const p = await priceForMarketHash(mh);
        if (!p || p.usd == null) { client.say(channel, '@' + user + ' couldn\'t find price for your last drop.'); break; }
        client.say(channel, '@' + user + ' ' + mh + ' ≈ $' + p.usd.toFixed(2) + ' (' + (p.source || 'market') + ')');
        break;
      }
      try {
        const p = await priceLookupFlexible(q);
        if (!p || p.usd == null) { client.say(channel, '@' + user + ' couldn\'t find price for: ' + q); break; }
        client.say(channel, '@' + user + ' ' + p.resolved + ' ≈ $' + p.usd.toFixed(2) + ' (' + (p.source || 'market') + ')');
      } catch {
        client.say(channel, '@' + user + ' price lookup failed.');
      }
      break;
    }

    case 'top': {
      let n = parseInt(args[0], 10);
      if (!Number.isFinite(n) || n <= 0) n = 5;
      n = Math.min(25, n);
      const rows = await leaderboardTop(n);
      if (!rows.length) { client.say(channel, '@' + user + ' leaderboard is empty.'); break; }
      const line = rows.map((r, i) => '#' + (i+1) + ' ' + r.user + ': $' + r.total.toFixed(2) + ' (' + r.count + ')').join(' | ');
      client.say(channel, 'Top ' + rows.length + ' (by inventory value): ' + line);
      break;
    }

    case 'backupurl': {
      if (!isModOrBroadcaster(tags)) { client.say(channel, '@' + user + ' mods/broadcaster only.'); break; }
      if (!ADMIN_KEY || !PUBLIC_URL) { client.say(channel, '@' + user + ' set ADMIN_KEY and PUBLIC_URL env vars to use this.'); break; }
      const base = PUBLIC_URL.endsWith('/') ? PUBLIC_URL.slice(0, -1) : PUBLIC_URL;
      const link = base + '/backup?key=' + ADMIN_KEY;
      console.log('[dro_bot] Backup URL:', link);
      client.say(channel, '@' + user + ' backup URL printed to server logs.');
      break;
    }

    default:
      // ignore unknown commands silently (avoids clashing with !so, !uptime, etc.)
      break;
  }
});

// ----------------- Value & Leaderboard -----------------
async function ensurePriceOnDrop(drop) { if (typeof drop.priceUSD === 'number') return drop.priceUSD; try { const p=await PriceService.priceForDrop(drop); if (p && typeof p.usd==='number') { drop.priceUSD=p.usd; return drop.priceUSD; } } catch {} return null; }
async function inventoryValue(user) { const items=getInventory(user); let sum=0; for (const d of items) { const v=await ensurePriceOnDrop(d); if (typeof v==='number') sum+=v; } return { totalUSD:+sum.toFixed(2), count: items.length }; }
function getAllInventories() { return loadJSON(INV_PATH) || {}; }
async function leaderboardTop(n=5) { const inv=getAllInventories(); const rows=[]; for (const [user, items] of Object.entries(inv)) { let sum=0; for (const d of items) { const v=await ensurePriceOnDrop(d); if (typeof v==='number') sum+=v; } rows.push({ user, total:+sum.toFixed(2), count: items.length }); } rows.sort((a,b)=>b.total-a.total); return rows.slice(0, Math.max(1, Math.min(25, n))); }

// Prefetch prices in background (non-blocking)
(async () => { try { await PriceService._fetchSkinportItems(); } catch {} })();
setInterval(() => { PriceService._fetchSkinportItems().catch(() => {}); }, Math.max(PRICE_CFG.ttlMs, 300000));

client.on('disconnected', (reason) => console.log(`[dro-bot:${INSTANCE_ID}] disconnected:`, reason));
function gracefulExit() { console.log(`[dro-bot:${INSTANCE_ID}] shutting down`); try { client.disconnect(); } catch {} process.exit(0); }
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);
