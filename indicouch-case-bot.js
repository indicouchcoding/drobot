/*
Indicouch Case-Opening Chatbot — Twitch (tmi.js)
Author: you + GPT-5 Thinking
License: MIT

ULTIMATE BUILD — Pricing + New Cases + No-Dupe + Optional Persistence
- Real-time pricing via Skinport (catalog) + CSFloat (floor) with fuzzy search + "!price last"
- Commands: !open, !cases, !inv, !worth, !top, !stats, !setcase, !mycase, !price, !help
- New cases added: CS:GO Weapon Case, Operation Breakout Weapon Case, Glove Case, Gallery Case (separate glove pool), Fever Case
- Also keeps: Prisma 2 Case, Dreams & Nightmares Case, Fracture Case
- Gold pool logic: knives for most cases; Butterfly knives for Breakout; gloves for Glove & Gallery
- No double replies: de-dupe by Twitch message id + instance log tag
- Optional persistence: if DATA_DIR is set (or /var/data exists), inventories/stats/caches are saved; otherwise it’s memory-only (resets each restart)

Quick start
1) npm init -y && npm i tmi.js dotenv
2) .env →
   TWITCH_USERNAME=your_bot
   TWITCH_OAUTH=oauth:xxxxxxxxxxxxxxxxxxxx
   TWITCH_CHANNEL=your_channel
   BOT_PREFIX=!
   PRICE_PROVIDER=best_of
   PRICE_CURRENCY=USD
   CSFLOAT_API_KEY=your_csfloat_key   # optional but recommended
   # DATA_DIR=/var/data/indicouch      # optional; enables persistence if you later add a disk
3) node indicouch-case-bot.js
--------------------------------------------------------------------------------
*/

import fs from 'fs';
import path from 'path';
import tmi from 'tmi.js';
import dotenv from 'dotenv';
import http from 'http';
dotenv.config();

// Unique instance tag (helps diagnose double instances)
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

// ----------------- Config -----------------
const CONFIG = {
  prefix: process.env.BOT_PREFIX || '!',
  defaultCaseKey: 'CS:GO Weapon Case',
  maxOpensPerCommand: 10,
  stattrakChance: 0.10, // ~10%
  souvenirChance: 0.00, // 0 for normal cases
  wearTiers: [
    { key: 'Factory New', short: 'FN', p: 0.03, float: [0.00, 0.07] },
    { key: 'Minimal Wear', short: 'MW', p: 0.07, float: [0.07, 0.15] },
    { key: 'Field-Tested', short: 'FT', p: 0.38, float: [0.15, 0.38] },
    { key: 'Well-Worn', short: 'WW', p: 0.38, float: [0.38, 0.45] },
    { key: 'Battle-Scarred', short: 'BS', p: 0.14, float: [0.45, 1.00] },
  ],
  // CS2 rarity odds (community-known approx)
  rarities: [
    { key: 'Gold',   p: 0.0026 }, // 0.26%
    { key: 'Red',    p: 0.0064 }, // 0.64%
    { key: 'Pink',   p: 0.032  }, // 3.20%
    { key: 'Purple', p: 0.1598 }, // 15.98%
    { key: 'Blue',   p: 0.7992 }, // 79.92%
  ],
};

// ----------------- Optional Persistence -----------------
const CAN_PERSIST = !!(process.env.DATA_DIR || fs.existsSync('/var/data'));
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data/indicouch' : null);
const INV_PATH = DATA_DIR ? path.join(DATA_DIR, 'inventories.json') : null;
const STATS_PATH = DATA_DIR ? path.join(DATA_DIR, 'stats.json') : null;
const DEFAULTS_PATH = DATA_DIR ? path.join(DATA_DIR, 'defaults.json') : null;
const PRICE_CACHE_DIR = DATA_DIR ? path.join(DATA_DIR, 'pricing') : null;
const SKINPORT_CACHE = PRICE_CACHE_DIR ? path.join(PRICE_CACHE_DIR, 'skinport-items.json') : null;
const PRICE_CACHE = PRICE_CACHE_DIR ? path.join(PRICE_CACHE_DIR, 'price-cache.json') : null;

const STATE = { inv: {}, stats: { opens: 0, drops: {} }, defaults: {} };

function ensureDataDirs() {
  if (!CAN_PERSIST) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PRICE_CACHE_DIR)) fs.mkdirSync(PRICE_CACHE_DIR, { recursive: true });
}
function loadFile(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function saveFile(p, obj) { try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch {} }
function loadState() {
  if (!CAN_PERSIST) return;
  STATE.inv = INV_PATH ? loadFile(INV_PATH, {}) : {};
  STATE.stats = STATS_PATH ? loadFile(STATS_PATH, { opens: 0, drops: {} }) : { opens: 0, drops: {} };
  STATE.defaults = DEFAULTS_PATH ? loadFile(DEFAULTS_PATH, {}) : {};
}
function saveState() {
  if (!CAN_PERSIST) return;
  if (INV_PATH) saveFile(INV_PATH, STATE.inv);
  if (STATS_PATH) saveFile(STATS_PATH, STATE.stats);
  if (DEFAULTS_PATH) saveFile(DEFAULTS_PATH, STATE.defaults);
}

ensureDataDirs();
loadState();

// ----------------- RNG + helpers -----------------
function rng() { return Math.random(); }
function weightedPick(items, weightProp = 'p') { const r=rng(); let acc=0; for (const it of items) { acc+=it[weightProp]; if (r<=acc) return it; } return items[items.length-1]; }
function pickWear() { const wear = weightedPick(CONFIG.wearTiers); const [min,max]=wear.float; const fl=+(min + rng()*(max-min)).toFixed(4); return { ...wear, float: fl }; }
function pickRarityKey() { return weightedPick([...CONFIG.rarities].reverse()).key; }
function randomFrom(arr) { return arr[Math.floor(rng()*arr.length)]; }

// Deduplicate replies by message id within this instance
const SEEN_MSG = new Set();
function alreadyHandled(tags) { const id = tags['id'] || tags.id; if (!id) return false; if (SEEN_MSG.has(id)) return true; SEEN_MSG.add(id); setTimeout(()=>SEEN_MSG.delete(id), 5*60*1000); return false; }

// ----------------- Gold pools -----------------
const KNIFE_FINISHES = [ 'Fade','Case Hardened','Crimson Web','Slaughter','Night','Blue Steel','Boreal Forest','Stained','Safari Mesh','Scorched','Urban Masked' ];
const KNIVES_OG = [ 'Bayonet','Flip Knife','Gut Knife','Karambit','M9 Bayonet' ].flatMap(model => KNIFE_FINISHES.map(name => ({ weapon: `★ ${model}`, name })));
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
    Blue:   [ { weapon: 'MP7', name: 'Skulls' }, { weapon: 'Nova', name: 'Sand Dune' }, { weapon: 'Glock-18', name: 'Brass' }, { weapon: 'SG 553', name: 'Ultraviolet' }, { weapon: 'AUG', name: 'Wings' } ],
    Purple: [ { weapon: 'Desert Eagle', name: 'Hypnotic' }, { weapon: 'P90', name: 'Blind Spot' }, { weapon: 'M4A1-S', name: 'Dark Water' } ],
    Pink:   [ { weapon: 'AK-47', name: 'Case Hardened' }, { weapon: 'AWP', name: 'Lightning Strike' } ],
    Red:    [ { weapon: 'M4A4', name: 'Asiimov' }, { weapon: 'AK-47', name: 'Redline' } ],
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
    // separate glove pool so it feels distinct
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
  // Keep earlier cases
  'Prisma 2 Case': {
    Blue: [ { weapon: 'CZ75-Auto', name: 'Distressed' }, { weapon: 'P2000', name: 'Acid Etched' }, { weapon: 'SCAR-20', name: 'Enforcer' }, { weapon: 'SG 553', name: 'Darkwing' }, { weapon: 'MAC-10', name: 'Disco Tech' } ],
    Purple: [ { weapon: 'R8 Revolver', name: 'Bone Forged' }, { weapon: 'Desert Eagle', name: 'Blue Ply' }, { weapon: 'AK-47', name: 'Phantom Disruptor' }, { weapon: 'Sawed-Off', name: 'Apocalypto' } ],
    Pink: [ { weapon: 'M4A1-S', name: 'Player Two' }, { weapon: 'Glock-18', name: 'Bullet Queen' } ],
    Red:  [ { weapon: 'AUG', name: 'Tom Cat' }, { weapon: 'SSG 08', name: 'Fever Dream' } ],
    Gold: [ { weapon: '★ Stiletto Knife', name: 'Doppler' }, { weapon: '★ Nomad Knife', name: 'Marble Fade' } ],
  },
  'Dreams & Nightmares Case': {
    Blue: [ { weapon: 'P2000', name: 'Lifted Spirits' }, { weapon: 'XM1014', name: 'Zombie Offensive' }, { weapon: 'G3SG1', name: 'Dream Glade' }, { weapon: 'SCAR-20', name: 'Ensnared' }, { weapon: 'MP7', name: 'Guerrilla' } ],
    Purple:[ { weapon: 'USP-S', name: 'Ticket to Hell' }, { weapon: 'MAC-10', name: 'Ensnared' }, { weapon: 'MAG-7', name: 'Foresight' } ],
    Pink:  [ { weapon: 'AK-47', name: 'Nightwish' }, { weapon: 'MP9', name: 'Starlight Protector' } ],
    Red:   [ { weapon: 'MP9', name: 'Food Chain' }, { weapon: 'M4A1-S', name: 'Night Terror' } ],
    Gold:  [ { weapon: '★ Talon Knife', name: 'Gamma Doppler' }, { weapon: '★ Skeleton Knife', name: 'Case Hardened' } ],
  },
  'Fracture Case': {
    Blue: [ { weapon: 'P250', name: 'Cassette' }, { weapon: 'XM1014', name: 'Entombed' }, { weapon: 'MP5-SD', name: 'Kitbash' }, { weapon: 'Negev', name: 'Ultralight' } ],
    Purple:[ { weapon: 'Tec-9', name: 'Brother' }, { weapon: 'Galil AR', name: 'Connexion' }, { weapon: 'MAG-7', name: 'Monster Call' } ],
    Pink:  [ { weapon: 'M4A4', name: 'Tooth Fairy' }, { weapon: 'Glock-18', name: 'Vogue' } ],
    Red:   [ { weapon: 'Desert Eagle', name: 'Printstream' }, { weapon: 'AK-47', name: 'Legion of Anubis' } ],
    Gold:  [ { weapon: '★ Karambit', name: 'Damascus Steel' }, { weapon: '★ Bayonet', name: 'Tiger Tooth' } ],
  },
};

// ----------------- Core Sim -----------------
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

// ----------------- Formatting -----------------
function rarityEmoji(r) { return r==='Gold'?'✨':r==='Red'?'🔴':r==='Pink'?'🟣':r==='Purple'?'🟪':'🔵'; }
function formatDrop(d) { const mods=[]; if(d.souvenir) mods.push('Souvenir'); if(d.stattrak) mods.push('StatTrak'); const pre=mods.length?mods.join(' ')+' ':''; const w=(d.wear||'').split(' ').map(s=>s[0]).join(''); const price=(typeof d.priceUSD==='number')?` • $${d.priceUSD.toFixed(2)}`:''; return `${rarityEmoji(d.rarity)} ${pre}${d.weapon} | ${d.name} (${w} • ${d.float.toFixed(4)})${price}`; }

// ----------------- Inventories & Stats -----------------
function addToInventory(user, drop) { (STATE.inv[user] ||= []).push(drop); if (CAN_PERSIST) saveState(); }
function getInventory(user) { return STATE.inv[user] || []; }
function pushStats(drop) { STATE.stats.opens++; STATE.stats.drops[drop.rarity]=(STATE.stats.drops[drop.rarity]||0)+1; if (CAN_PERSIST) saveState(); }
function getStats() { const s=STATE.stats; const by=s.drops; const fmt=['Gold','Red','Pink','Purple','Blue'].map(r=>`${rarityEmoji(r)} ${r}: ${by[r]||0}`).join(' | '); return { total:s.opens, fmt }; }
function setDefaultCase(user, caseKey){ STATE.defaults[user]=caseKey; if (CAN_PERSIST) saveState(); }
function getDefaultCase(user){ return STATE.defaults[user] || CONFIG.defaultCaseKey; }

// ----------------- Pricing (Skinport + CSFloat) -----------------
const PRICE_CFG = {
  provider: (process.env.PRICE_PROVIDER || 'best_of').toLowerCase(),
  currency: process.env.PRICE_CURRENCY || 'USD',
  ttlMs: (parseInt(process.env.PRICE_TTL_MINUTES || '10', 10) * 60000),
  csfloatKey: process.env.CSFLOAT_API_KEY || null,
};

const PriceService = {
  _skinport: { fetchedAt: 0, map: new Map(), memOnly: { fetchedAt: 0, items: [] } },
  _cache: {},
  _readSkinportCache() {
    if (!CAN_PERSIST || !SKINPORT_CACHE) return this._skinport.memOnly;
    return loadFile(SKINPORT_CACHE, { fetchedAt: 0, items: [] });
  },
  _writeSkinportCache(obj) {
    this._skinport.memOnly = obj;
    if (CAN_PERSIST && SKINPORT_CACHE) saveFile(SKINPORT_CACHE, obj);
  },
  _readPriceCache() {
    if (!CAN_PERSIST || !PRICE_CACHE) return {};
    return loadFile(PRICE_CACHE, {});
  },
  _writePriceCache(obj) {
    if (CAN_PERSIST && PRICE_CACHE) saveFile(PRICE_CACHE, obj);
  },
  async _fetchSkinportItems() {
    const now = Date.now();
    const cached = this._readSkinportCache();
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
    this._writeSkinportCache({ fetchedAt: now, items });
  },
  _fromCache(marketHash) {
    if (!this._cache.__loaded) { this._cache = { ...this._readPriceCache(), __loaded: true }; }
    const c = this._cache[marketHash];
    if (!c) return null; if (Date.now() - (c.fetchedAt || 0) > PRICE_CFG.ttlMs) return null; return c;
  },
  _saveCache(marketHash, obj) {
    if (!this._cache.__loaded) this._cache = { __loaded: true };
    this._cache[marketHash] = obj; this._writePriceCache(this._cache);
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

function marketNameFromDrop(drop) {
  const wear = drop.wear;
  const souv = drop.souvenir ? 'Souvenir ' : '';
  const isKnife = (drop.weapon || '').startsWith('★');
  if (isKnife) {
    const knifeName = drop.weapon.replace('★', '').trim();
    const starPart = '★ ' + (drop.stattrak ? 'StatTrak™ ' : '');
    return (souv + starPart + knifeName + ' | ' + drop.name + ' (' + wear + ')').trim();
  }
  const st = drop.stattrak ? 'StatTrak™ ' : '';
  return (souv + st + drop.weapon + ' | ' + drop.name + ' (' + wear + ')').trim();
}

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

// ---- Fuzzy helpers for !price (so users don't need exact names) ----
function _tokens(s) { return (s||'').toLowerCase().replace(/™/g,'').split(/[^a-z0-9]+/).filter(Boolean); }
function _expandWearAbbr(tokens) {
  const out = [...tokens];
  for (const t of tokens) {
    if (t === 'fn') out.push('factory','new');
    if (t === 'mw') out.push('minimal','wear');
    if (t === 'ft') out.push('field','tested');
    if (t === 'ww') out.push('well','worn');
    if (t === 'bs') out.push('battle','scarred');
    if (t === 'st') out.push('stattrak');
  }
  return out;
}
function _bestSkinportKeyForQuery(query) {
  const map = PriceService._skinport && PriceService._skinport.map;
  if (!map || map.size === 0) return null;
  const qTokens = _expandWearAbbr(_tokens(query));
  let bestKey = null, bestScore = 0;
  for (const key of map.keys()) {
    const k = key.toLowerCase().replace(/™/g,'');
    let score = 0;
    for (const t of qTokens) if (k.includes(t)) score++;
    if (score > bestScore) { bestScore = score; bestKey = key; }
  }
  return bestScore >= 2 ? bestKey : null;
}
async function priceLookupFlexible(input) {
  let out = await priceForMarketHash(input);
  if (out && out.usd != null) return { ...out, resolved: input };
  const candidate = _bestSkinportKeyForQuery(input);
  if (candidate) {
    out = await priceForMarketHash(candidate);
    if (out && out.usd != null) return { ...out, resolved: candidate };
  }
  return { usd: null, resolved: input };
}

// Warm skinport on boot and keep it fresh
;(async () => { try { await PriceService._fetchSkinportItems(); } catch (e) { console.warn('skinport warm failed', e?.status || e); } })();
setInterval(() => { PriceService._fetchSkinportItems().catch(()=>{}); }, Math.max(PRICE_CFG.ttlMs, 300000));

// ----------------- Value & Leaderboard -----------------
async function ensurePriceOnDrop(drop) { if (typeof drop.priceUSD === 'number') return drop.priceUSD; try { const p = await PriceService.priceForDrop(drop); if (p && typeof p.usd === 'number') { drop.priceUSD = p.usd; if (CAN_PERSIST) saveState(); return drop.priceUSD; } } catch {} return null; }
async function inventoryValue(user) { const items=getInventory(user); let sum=0; for (const d of items) { const v=await ensurePriceOnDrop(d); if (typeof v==='number') sum+=v; } return { totalUSD:+sum.toFixed(2), count: items.length }; }
async function leaderboardTop(n=5) { const rows=[]; for (const [user,items] of Object.entries(STATE.inv)) { let sum=0; for (const d of items) { const v=await ensurePriceOnDrop(d); if (typeof v==='number') sum+=v; } rows.push({ user, total:+sum.toFixed(2), count:items.length }); } rows.sort((a,b)=>b.total-a.total); return rows.slice(0, Math.max(1, Math.min(25, n))); }

// ----------------- Resolution & Cooldowns -----------------
function resolveCaseKey(input){ if(!input) return null; const s=input.toLowerCase(); const keys=Object.keys(CASES); return keys.find(k=>k.toLowerCase()===s) || keys.find(k=>k.toLowerCase().startsWith(s)) || null; }
const cdMap = new Map();
const COOLDOWN_MS = 3000;
function onCooldown(user){ const now=Date.now(); const last=cdMap.get(user)||0; if(now-last<COOLDOWN_MS) return true; cdMap.set(user, now); return false; }

// ----------------- Twitch Client -----------------
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true },
  connection: { secure: true, reconnect: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: [process.env.TWITCH_CHANNEL],
});
client.connect().then(()=>{ console.log(`[indicouch:${INSTANCE_ID}] connected to`, process.env.TWITCH_CHANNEL); }).catch(console.error);

// Minimal HTTP health server
const PORT = process.env.PORT || 3000;
http.createServer((req,res)=>{ if(req.url==='/healthz'){ res.writeHead(200,{ 'Content-Type':'text/plain'}); return res.end('ok'); } res.writeHead(200,{ 'Content-Type':'text/plain'}); res.end('Indicouch Case Bot OK'); }).listen(PORT, ()=> console.log(`[indicouch:${INSTANCE_ID}] health on :${PORT}`));

// ----------------- Commands -----------------
const HELP_TEXT = [
  'Commands:',
  '!cases — list cases',
  '!open <case> [xN] — open 1-10 cases',
  '!inv [@user] — show inventory',
  '!worth [@user] — inventory value (USD)',
  "!price <market name>|last — e.g., StatTrak™ AK-47 | Redline (Field-Tested) or 'last'",
  '!top [N] — leaderboard by inventory value',
  '!stats — global drop stats',
  '!setcase <case> — set default case',
  '!mycase — show your default case',
  '!help — this menu',
].join(' | ');

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if (alreadyHandled(tags)) return; // local de-dupe

  const user = (tags['display-name'] || tags.username || 'user').toLowerCase();
  if (!message.startsWith(CONFIG.prefix)) return;
  if (onCooldown(user)) return; // chill

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
      try { for (const d of results) { await ensurePriceOnDrop(d); } } catch {}
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
      const { totalUSD, count } = await inventoryValue(target);
      if (count === 0) { client.say(channel, `@${user} ${target} has an empty inventory.`); break; }
      client.say(channel, `@${user} ${target}'s inventory: ${count} items • ~$${totalUSD.toFixed(2)} USD`);
      break;
    }
    case 'price': {
      const q = args.join(' ').trim();
      if (!q) { client.say(channel, `@${user} usage: !price <market name> — e.g., StatTrak™ AK-47 | Redline (Field-Tested) or !price last`); break; }
      if (q.toLowerCase() === 'last') {
        const items = getInventory(user);
        if (!items.length) { client.say(channel, `@${user} you have no drops yet. Use !open first.`); break; }
        const last = items[items.length - 1];
        const mh = marketNameFromDrop(last);
        const p = await priceForMarketHash(mh);
        if (!p || p.usd == null) { client.say(channel, `@${user} couldn't find price for your last drop.`); break; }
        client.say(channel, `@${user} ${mh} ≈ $${p.usd.toFixed(2)} (${p.source || 'market'})`);
        break;
      }
      try {
        const p = await priceLookupFlexible(q);
        if (!p || p.usd == null) { client.say(channel, `@${user} couldn't find price for: ${q}`); break; }
        client.say(channel, `@${user} ${p.resolved} ≈ $${p.usd.toFixed(2)} (${p.source || 'market'})`);
      } catch {
        client.say(channel, `@${user} price lookup failed.`);
      }
      break;
    }
    case 'top': {
      let n = 5; if (args[0] && /^\d+$/.test(args[0])) n = parseInt(args[0],10);
      const rows = await leaderboardTop(n);
      if (!rows.length) { client.say(channel, `@${user} leaderboard is empty.`); break; }
      const line = rows.map((r,i)=>`#${i+1} ${r.user}: $${r.total.toFixed(2)} (${r.count})`).join(' | ');
      client.say(channel, `Top ${rows.length} (by inventory value): ${line}`);
      break;
    }
    default:
      if (cmd) client.say(channel, `@${user} unknown command. ${HELP_TEXT}`);
      break;
  }
});
