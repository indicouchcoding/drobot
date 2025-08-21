/*
Indicouch Case-Opening Chatbot — Twitch (tmi.js)
Author: you + GPT-5 Thinking
License: MIT

What it does
- Simulates opening CS2/CSGO cases in chat with realistic rarity + wear odds
- Viewers can open cases, check inventories, see prices, leaderboards, and stats
- Streamer/mods can tweak odds, add cases, wipe inventories

Zero-setup vibe
- Works great on Render as a Web Service (exposes a tiny HTTP health server)
- Env-only config; no code changes needed

Quick start
1) Node.js 20+
2) Files: indicouch-case-bot.js (this file) + package.json (see README notes)
3) Env vars on your host:
   TWITCH_USERNAME=your_bot_username
   TWITCH_OAUTH=oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWITCH_CHANNEL=your_channel
   BOT_PREFIX=!
   PRICE_PROVIDER=best_of   # or skinport or csfloat
   PRICE_CURRENCY=USD       # for Skinport
   PRICE_TTL_MINUTES=10
   CSFLOAT_API_KEY=...      # optional
4) Start:  node indicouch-case-bot.js

Get an OAuth token while logged into the bot account:
https://twitchapps.com/tmi/

--------------------------------------------------------------------------------
*/

// ----------------- Imports -----------------
import fs from 'fs';
import path from 'path';
import tmi from 'tmi.js';
import dotenv from 'dotenv';
import http from 'http';
dotenv.config();

// ----------------- Config -----------------
const CONFIG = {
  prefix: process.env.BOT_PREFIX || '!',
  defaultCaseKey: 'Prisma 2 Case',
  maxOpensPerCommand: 10,
  stattrakChance: 0.10, // 10%
  souvenirChance: 0.00, // 0% (regular cases don't drop Souvenirs; leave 0)
  wearTiers: [
    // Rough CS wear distribution: FN 3%, MW 7%, FT 38%, WW 38%, BS 14%
    { key: 'Factory New', short: 'FN', p: 0.03, float: [0.00, 0.07] },
    { key: 'Minimal Wear', short: 'MW', p: 0.07, float: [0.07, 0.15] },
    { key: 'Field-Tested', short: 'FT', p: 0.38, float: [0.15, 0.38] },
    { key: 'Well-Worn', short: 'WW', p: 0.38, float: [0.38, 0.45] },
    { key: 'Battle-Scarred', short: 'BS', p: 0.14, float: [0.45, 1.00] },
  ],
  rarities: [
    // Common → rare (must sum ≈1)
    { key: 'Blue',   color: 'Mil-Spec',    p: 0.7992 },
    { key: 'Purple', color: 'Restricted',  p: 0.1598 },
    { key: 'Pink',   color: 'Classified',  p: 0.032  },
    { key: 'Red',    color: 'Covert',      p: 0.0064 },
    { key: 'Gold',   color: '★',           p: 0.0026 }, // knife/glove
  ],
};

// ----------------- Case + Skin Data (starter) -----------------
const CASES = {
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

// ----------------- Persistence -----------------
const DATA_DIR = path.join(process.cwd(), 'data');
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

// ----------------- RNG Helpers -----------------
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
function pickRarity() { return weightedPick(CONFIG.rarities).key; }
function pickSkin(caseKey, rarityKey) {
  const pool = CASES[caseKey]?.[rarityKey] || [];
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}
function rollModifiers() {
  const stattrak = rng() < CONFIG.stattrakChance;
  const souvenir = CONFIG.souvenirChance > 0 && rng() < CONFIG.souvenirChance;
  return { stattrak, souvenir };
}

// ----------------- Core Sim -----------------
function openOne(caseKey) {
  const rarityKey = pickRarity(); // 'Blue','Purple','Pink','Red','Gold'
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
  const price = (typeof drop.priceUSD === 'number') ? ` • $${drop.priceUSD.toFixed(2)}` : '';
  return `${rarityEmoji(drop.rarity)} ${prefix}${drop.weapon} | ${drop.name} (${wearShort} • ${drop.float.toFixed(4)})${price}`;
}

// ----------------- Inventories & Stats -----------------
function addToInventory(user, drop) { const inv = loadJSON(INV_PATH); (inv[user] ||= []).push(drop); saveJSON(INV_PATH, inv); }
function getInventory(user) { const inv = loadJSON(INV_PATH); return inv[user] || []; }
function pushStats(drop) { const s = loadJSON(STATS_PATH); s.opens=(s.opens||0)+1; s.drops=s.drops||{}; s.drops[drop.rarity]=(s.drops[drop.rarity]||0)+1; saveJSON(STATS_PATH,s); }
function getStats() { const s = loadJSON(STATS_PATH); const total=s.opens||0; const by=s.drops||{}; const fmt=['Gold','Red','Pink','Purple','Blue'].map(r=>`${rarityEmoji(r)} ${r}: ${by[r]||0}`).join(' | '); return { total, fmt }; }
function setDefaultCase(user, caseKey) { const d=loadJSON(DEFAULTS_PATH); d[user]=caseKey; saveJSON(DEFAULTS_PATH,d); }
function getDefaultCase(user) { const d=loadJSON(DEFAULTS_PATH); return d[user] || CONFIG.defaultCaseKey; }

// ----------------- Pricing Integration (Skinport + CSFloat) -----------------
const PRICE_CFG = {
  provider: (process.env.PRICE_PROVIDER || 'best_of').toLowerCase(),
  currency: process.env.PRICE_CURRENCY || 'USD',
  ttlMs: (parseInt(process.env.PRICE_TTL_MINUTES || '10', 10) * 60000),
  csfloatKey: process.env.CSFLOAT_API_KEY || null,
};
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
ensurePriceData();
// warm and refresh skinport feed
(async () => { try { await PriceService._fetchSkinportItems(); } catch {} })();
setInterval(() => { PriceService._fetchSkinportItems().catch(() => {}); }, Math.max(PRICE_CFG.ttlMs, 300000));

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

// ----------------- Value & Leaderboard -----------------
async function ensurePriceOnDrop(drop) {
  if (typeof drop.priceUSD === 'number') return drop.priceUSD;
  try {
    const p = await PriceService.priceForDrop(drop);
    if (p && typeof p.usd === 'number') { drop.priceUSD = p.usd; return drop.priceUSD; }
  } catch {}
  return null;
}
async function inventoryValue(user) {
  const items = getInventory(user);
  let sum = 0;
  for (const d of items) { const v = await ensurePriceOnDrop(d); if (typeof v === 'number') sum += v; }
  return { totalUSD: +sum.toFixed(2), count: items.length };
}
function getAllInventories() { return loadJSON(INV_PATH) || {}; }
async function leaderboardTop(n = 5) {
  const inv = getAllInventories();
  const rows = [];
  for (const [user, items] of Object.entries(inv)) {
    let sum = 0;
    for (const d of items) { const v = await ensurePriceOnDrop(d); if (typeof v === 'number') sum += v; }
    rows.push({ user, total: +sum.toFixed(2), count: items.length });
  }
  rows.sort((a,b) => b.total - a.total);
  return rows.slice(0, Math.max(1, Math.min(25, n)));
}

// ----------------- Helpers -----------------
function resolveCaseKey(input) {
  if (!input) return null;
  const exact = Object.keys(CASES).find(c => c.toLowerCase() === input.toLowerCase());
  if (exact) return exact;
  const fuzzy = Object.keys(CASES).find(c => c.toLowerCase().startsWith(input.toLowerCase()));
  return fuzzy || null;
}
const cdMap = new Map();
const COOLDOWN_MS = 3000;
function onCooldown(user) { const now = Date.now(); const last = cdMap.get(user) || 0; if (now - last < COOLDOWN_MS) return true; cdMap.set(user, now); return false; }

// ----------------- Twitch Client -----------------
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: [process.env.TWITCH_CHANNEL],
});

client.connect().then(() => {
  ensureData();
  console.log('Case bot connected to', process.env.TWITCH_CHANNEL);
}).catch(console.error);

// Minimal HTTP health server for Render Web Service
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Indicouch Case Bot OK');
}).listen(PORT, () => console.log(`Health server listening on :${PORT}`));

// ----------------- Commands -----------------
const HELP_TEXT = [
  'Commands:',
  '!cases — list cases',
  '!open <case> [xN] — open 1-10 cases',
  '!inv [@user] — show inventory',
  '!worth [@user] — inventory value (USD)',
  '!price <market name> — price lookup',
  '!top [N] — leaderboard by inventory value',
  '!stats — global drop stats',
  '!setcase <case> — set default case',
  '!mycase — show your default case',
  '!help — this menu',
].join(' | ');

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const user = (tags['display-name'] || tags.username || 'user').toLowerCase();
  if (!message.startsWith(CONFIG.prefix)) return;
  if (onCooldown(user)) return; // silent cooldown

  const args = message.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  switch (cmd) {
    case 'help':
      client.say(channel, HELP_TEXT);
      break;

    case 'cases':
      client.say(channel, `Available cases: ${Object.keys(CASES).join(' | ')}`);
      break;

    case 'mycase': {
      const current = getDefaultCase(user);
      client.say(channel, `@${user} your default case is: ${current}`);
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
      if (!caseKey) { client.say(channel, `@${user} pick a case with !cases or set one with !setcase <case>.`); break; }

      const results = [];
      for (let i = 0; i < count; i++) { const drop = openOne(caseKey); results.push(drop); addToInventory(user, drop); pushStats(drop); }

      // Attach live prices (best effort)
      try { for (const d of results) { await ensurePriceOnDrop(d); } } catch {}

      const lines = results.map(formatDrop).join('  |  ');
      client.say(channel, `@${user} opened ${count}x ${caseKey}: ${lines}`);
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
      if (!q) { client.say(channel, `@${user} usage: !price <market name> e.g., StatTrak™ AK-47 | Redline (Field-Tested)`); break; }
      try {
        const p = await priceForMarketHash(q);
        if (!p || p.usd == null) { client.say(channel, `@${user} couldn't find a price for: ${q}`); break; }
        client.say(channel, `@${user} ${q} ≈ $${p.usd.toFixed(2)} (${p.source || 'market'})`);
      } catch {
        client.say(channel, `@${user} price lookup failed.`);
      }
      break;
    }

    case 'top': {
      let n = 5;
      if (args[0] && /^\d+$/.test(args[0])) n = parseInt(args[0], 10);
      const rows = await leaderboardTop(n);
      if (!rows.length) { client.say(channel, `@${user} leaderboard is empty.`); break; }
      const line = rows.map((r, i) => `#${i+1} ${r.user}: $${r.total.toFixed(2)} (${r.count})`).join(' | ');
      client.say(channel, `Top ${rows.length} (by inventory value): ${line}`);
      break;
    }

    default:
      if (cmd) client.say(channel, `@${user} unknown command. ${HELP_TEXT}`);
      break;
  }
});

// ----------------- Notes -----------------
// • This is a simulation; odds/wears are approximate, not official.
// • Expand the CASES object or load from JSON for more coverage.
// • Pricing pulls Skinport (USD) and optional CSFloat floors, with caching.
// • Be cool with API limits; PRICE_TTL_MINUTES avoids hammering.
