import 'dotenv/config';
import tmi from 'tmi.js';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';

/** =========================
 *  Paths & JSON helpers
 *  ========================= */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const DROMON_DATA_DIR = process.env.DROMON_DATA_DIR || path.join(HERE, 'data');
if (!fs.existsSync(DROMON_DATA_DIR)) fs.mkdirSync(DROMON_DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DROMON_DATA_DIR, 'users.json');
const WORLD_FILE = path.join(DROMON_DATA_DIR, 'world.json');
const DEX_FILE = process.env.DROMON_DEX_FILE || path.join(HERE, 'data', 'mondex.json');

// Trading store path (persist trades between restarts)
const TRADES_FILE = process.env.DROMON_TRADES_PATH || path.join(DROMON_DATA_DIR, 'trades.json');
const TRADE_TTL_MIN = Number(process.env.DROMON_TRADE_TTL_MIN || 10);

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.warn('[DroMon] JSON not found at', filePath);
  } catch (e) {
    console.error('[DroMon] Load failed', filePath, e?.message || e);
  }
  return fallback;
}
function saveJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[DroMon] Save failed', filePath, e?.message || e);
  }
}
function shortId(n = 8) {
  // small, user-friendly token for per-mon instance IDs
  return Buffer.from(Math.random().toString(36).slice(2)).toString('base64url').slice(0, n);
}

/** =========================
 *  One-time migration (repo data -> persistent disk) 
 *  ========================= */
const OLD_DATA_DIR = path.join(HERE, 'data');
function maybeMigrateOldSaves() {
  try {
    if (!fs.existsSync(DROMON_DATA_DIR)) fs.mkdirSync(DROMON_DATA_DIR, { recursive: true });

    const oldUsers = path.join(OLD_DATA_DIR, 'users.json');
    const oldWorld = path.join(OLD_DATA_DIR, 'world.json');

    const newUsers = USERS_FILE;
    const newWorld = WORLD_FILE;

    let moved = false;
    if (!fs.existsSync(newUsers) && fs.existsSync(oldUsers)) {
      fs.copyFileSync(oldUsers, newUsers);
      moved = true;
    }
    if (!fs.existsSync(newWorld) && fs.existsSync(oldWorld)) {
      fs.copyFileSync(oldWorld, newWorld);
      moved = true;
    }
    if (moved) console.log('[DroMon] Migrated users/world from repo folder to persistent disk.');
  } catch (e) {
    console.error('[DroMon] Migration error:', e?.message || e);
  }
}
maybeMigrateOldSaves();

/** =========================
 *  Dex loader (hardened) 
 *  ========================= */
function loadDex() {
  try {
    if (!fs.existsSync(DEX_FILE)) {
      console.error('[DroMon] Dex file missing:', DEX_FILE);
      return { monsters: [], rarityWeights: {}, balls: {}, __reason: 'missing' };
    }
    const raw = fs.readFileSync(DEX_FILE, 'utf-8');

    if (!raw || raw.trim().length < 10) {
      console.error('[DroMon] Dex file looks empty/suspicious length:', DEX_FILE);
      return { monsters: [], rarityWeights: {}, balls: {}, __reason: 'empty' };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('[DroMon] Dex JSON parse error:', e?.message || e, 'at', DEX_FILE);
      return { monsters: [], rarityWeights: {}, balls: {}, __reason: 'parse' };
    }

    if (!Array.isArray(parsed.monsters)) {
      console.error('[DroMon] Dex has no "monsters" array at', DEX_FILE);
      return { monsters: [], rarityWeights: {}, balls: {}, __reason: 'no_monsters' };
    }

    console.log('[DroMon] Dex loaded:', parsed.monsters.length, 'monsters from', DEX_FILE);
    return parsed;
  } catch (e) {
    console.error('[DroMon] Dex load error:', e?.message || e, 'at', DEX_FILE);
    return { monsters: [], rarityWeights: {}, balls: {}, __reason: 'exception' };
  }
}

// --- One-time migration: /var/data/indicouch/dromon  ->  /data/dromon (via env)
const OLD_DROMON_DIR = '/var/data/indicouch/dromon';
const NEW_DROMON_DIR = DROMON_DATA_DIR; // should be "/data/dromon" via env

function migrateDromonData() {
  try {
    if (!fs.existsSync(OLD_DROMON_DIR)) {
      console.log('[DroMon] No old data dir to migrate:', OLD_DROMON_DIR);
      return;
    }
    if (!fs.existsSync(NEW_DROMON_DIR)) fs.mkdirSync(NEW_DROMON_DIR, { recursive: true });

    // Core files we care about
    const core = ['users.json', 'world.json'];
    let movedCore = 0;

    for (const name of core) {
      const src = path.join(OLD_DROMON_DIR, name);
      const dst = path.join(NEW_DROMON_DIR, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        movedCore++;
      }
    }

    // Grab any extra JSONs in case you add more later (won't overwrite)
    let movedExtra = 0;
    try {
      const extras = fs.readdirSync(OLD_DROMON_DIR)
        .filter(f => f.endsWith('.json') && !core.includes(f));
      for (const f of extras) {
        const src = path.join(OLD_DROMON_DIR, f);
        const dst = path.join(NEW_DROMON_DIR, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
          movedExtra++;
        }
      }
    } catch {}

    if (movedCore || movedExtra) {
      console.log(`[DroMon] Migrated ${movedCore} core + ${movedExtra} extra JSON file(s) from ${OLD_DROMON_DIR} -> ${NEW_DROMON_DIR}`);
    } else {
      console.log('[DroMon] Migration skipped: nothing new to move.');
    }
  } catch (e) {
    console.error('[DroMon] Migration error:', e?.message || e);
  }
}
migrateDromonData();

let users = loadJson(USERS_FILE, {});
let world  = loadJson(WORLD_FILE, { current: null, lastSpawnTs: 0 });
let dex    = loadDex();

// Ensure all existing catches have an iid (instance id) to enable trading
(function ensureCatchIidsAllUsers() {
  let added = 0;
  for (const [, u] of Object.entries(users || {})) {
    const arr = Array.isArray(u.catches) ? u.catches : (u.catches = []);
    for (const c of arr) {
      if (!c.iid) { c.iid = shortId(8); added++; }
    }
  }
  if (added) {
    saveJson(USERS_FILE, users);
    console.log(`[DroMon] Trading: added ${added} missing iid(s) to existing catches.`);
  }
})();

// revive Set in world.current.caughtBy after a reload
function reviveWorld(w) {
  if (!w) return { current: null, lastSpawnTs: 0 };
  const out = { ...w };
  if (out.current) {
    const cur = { ...out.current };
    if (Array.isArray(cur.caughtBy)) cur.caughtBy = new Set(cur.caughtBy);
    if (!cur.caughtBy) cur.caughtBy = new Set();
    if (!cur.attempts) cur.attempts = {};
    out.current = cur;
  }
  return out;
}
world = reviveWorld(world);

console.log('[DroMon] Data dir:', DROMON_DATA_DIR);
console.log('[DroMon] Dex file:', DEX_FILE);

/** =========================
 *  ENV & tuning
 *  ========================= */
const PREFIX = process.env.PREFIX || '!';
const CHANNELS = (process.env.TWITCH_CHANNELS || '')
  .split(',')
  .map(s => s.trim().replace(/^#/, ''))
  .filter(Boolean);

const SPAWN_INTERVAL_SEC = Number(process.env.SPAWN_INTERVAL_SEC || 300);
const SPAWN_DESPAWN_SEC = Number(process.env.SPAWN_DESPAWN_SEC || 180);
let SHINY_RATE_DENOM = Number(process.env.SHINY_RATE_DENOM || 1024);

// Catch odds tuning
const CATCH_RATE_MODE = (process.env.CATCH_RATE_MODE || 'raw255').toLowerCase(); // 'raw255' | 'percent' | 'unit'
const CATCH_RATE_SCALE = Number(process.env.CATCH_RATE_SCALE || 255);
const MIN_CATCH = Number(process.env.MIN_CATCH || 0.02);
const MAX_CATCH = Number(process.env.MAX_CATCH || 0.95);
const SHINY_CATCH_PENALTY = Number(process.env.SHINY_CATCH_PENALTY || 0.75);
const BALL_BONUS = {
  pokeball:  Number(process.env.BONUS_POKEBALL  || 1.0),
  greatball: Number(process.env.BONUS_GREATBALL || 1.5),
  ultraball: Number(process.env.BONUS_ULTRABALL || 2.0),
};

function computeCatchChance(mon, ballName, isShiny) {
  const rate = Number(mon?.catchRate ?? 0);
  let base;
  if (CATCH_RATE_MODE === 'percent') {
    base = rate / 100;          // e.g., 1.1923 => 1.1923%
  } else if (CATCH_RATE_MODE === 'unit') {
    base = rate;                // e.g., 0.30 => 30%
  } else {
    base = rate / CATCH_RATE_SCALE; // 0..255 scale
  }
  let p = base * (BALL_BONUS[ballName] || 1.0);
  if (isShiny) p *= SHINY_CATCH_PENALTY;
  if (!Number.isFinite(p)) p = 0;
  p = Math.max(MIN_CATCH, Math.min(MAX_CATCH, p));
  return p;
}

/** =========================
 *  Type helpers
 *  ========================= */
const TYPE_EMOJI = {
  Normal: '⚪', Fire: '🔥', Water: '💧', Grass: '🌿', Electric: '⚡',
  Ice: '❄️', Fighting: '🥊', Poison: '☠️', Ground: '🪨',
  Flying: '🪽', Psychic: '🔮', Bug: '🐛', Rock: '🗿',
  Ghost: '👻', Dragon: '🐉', Dark: '🌑', Steel: '⚙️', Fairy: '✨'
};

function typeBadge(types) {
  const arr = Array.isArray(types) ? types : [];
  return arr.map(t => `${TYPE_EMOJI[t] || '◻️'} ${t}`).join(' ');
}

// Fill missing "types" from PokéAPI (1–493). Safe to run multiple times.
async function ensureCanonicalTypes(maxId = 493, batchDelayMs = 150) {
  const mons = Array.isArray(dex.monsters) ? dex.monsters : [];
  const missing = mons.filter(m => !Array.isArray(m.types) || m.types.length === 0);
  if (!missing.length) return false;

  async function fetchTypes(id) {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`, { headers: { 'accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const types = (j.types || [])
      .sort((a,b) => (a.slot||0)-(b.slot||0))
      .map(t => {
        const s = String(t.type?.name || '');
        return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      });
    return types;
  }

  const byId = new Map(mons.map(m => [Number(m.id), m]));
  for (let id = 1; id <= maxId; id++) {
    const m = byId.get(id);
    if (!m) continue;
    if (Array.isArray(m.types) && m.types.length) continue;
    try {
      const types = await fetchTypes(id);
      if (types.length) {
        m.types = types;
        console.log(`[types] #${id} ${m.name} -> [${types.join(', ')}]`);
        saveJson(DEX_FILE, dex);
      }
    } catch (e) {
      console.warn(`[types] failed #${id} ${m?.name||''}:`, e?.message || e);
    }
    await new Promise(r => setTimeout(r, batchDelayMs));
  }
  return true;
}

/** =========================
 *  Utils
 *  ========================= */
function uc(s) { return String(s || '').toLowerCase(); }
function isBroadcaster(tags) {
  return String(tags?.['user-id'] || '') === String(tags?.['room-id'] || '');
}
function isModOrBroadcaster(tags) {
  return Boolean(tags?.mod) || isBroadcaster(tags) || tags?.badges?.broadcaster === '1';
}

function ballFromAlias(s, fallback = 'pokeball') {
  const t = uc(s);
  if (t === 'pb' || t === 'pokeball') return 'pokeball';
  if (t === 'gb' || t === 'greatball') return 'greatball';
  if (t === 'ub' || t === 'ultraball') return 'ultraball';
  return fallback;
}

function ensureUser(username) {
  const key = uc(username);
  if (!users[key]) {
    users[key] = {
      name: key,
      balls: { pokeball: 0, greatball: 0, ultraball: 0 },
      lastDaily: 0,
      catches: [],
      defaultBall: 'pokeball',
    };
  } else if (!users[key].defaultBall) {
    users[key].defaultBall = 'pokeball';
  }
  return users[key];
}
function pickWeighted(weightMap) {
  const entries = Object.entries(weightMap || {});
  const total = entries.reduce((a, [,w]) => a + Number(w||0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const [k, w] of entries) { r -= Number(w||0); if (r <= 0) return k; }
  return entries.length ? entries[0][0] : null;
}
function sayChunks(client, channel, header, lines) {
  const chunks = [];
  let buf = header || '';
  for (const ln of lines) {
    const add = (buf.length ? ' | ' : '') + ln;
    if ((buf + add).length > 380) { if (buf) chunks.push(buf); buf = ln; }
    else buf += add;
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) client.say(channel, c);
}

// resolve monsters by rarity weights (with auto-reload if empty)
function randomMonster() {
  let mons = Array.isArray(dex.monsters) ? dex.monsters : [];
  if (!mons.length) {
    console.warn('[DroMon] randomMonster: monsters empty; reloading Dex…');
    dex = loadDex();
    mons = Array.isArray(dex.monsters) ? dex.monsters : [];
    if (!mons.length) {
      console.error('[DroMon] randomMonster: still empty after reload. reason =', dex.__reason, 'path =', DEX_FILE);
      return null;
    }
  }
  const r = pickWeighted(dex.rarityWeights || { Common: 1 });
  const pool = mons.filter(m => m.rarity === r);
  if (!pool.length) {
    if (!randomMonster._lastNoPoolLog || Date.now() - randomMonster._lastNoPoolLog > 60000) {
      console.warn('[DroMon] randomMonster: empty pool for rarity', r, '— falling back to any of', mons.length);
      randomMonster._lastNoPoolLog = Date.now();
    }
    return mons[Math.floor(Math.random() * mons.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function saveWorld() {
  const toSave = { ...world };
  if (toSave.current) {
    toSave.current = { ...toSave.current, caughtBy: Array.from(toSave.current.caughtBy || []) };
  }
  saveJson(WORLD_FILE, toSave);
}

/** =========================
 *  Trading (self-contained; file-backed)
 *  ========================= */
function loadTrades() {
  if (!fs.existsSync(TRADES_FILE)) saveJson(TRADES_FILE, { active: {} });
  return loadJson(TRADES_FILE, { active: {} });
}
function saveTrades(db) {
  saveJson(TRADES_FILE, db || { active: {} });
}
function tradeUserKey(name) { return uc(name); }

function getUserMonsInventory(uid) {
  const u = users[uid];
  const arr = Array.isArray(u?.catches) ? u.catches : [];
  // Ensure any missing iids
  for (const c of arr) if (!c.iid) c.iid = shortId(8);
  return arr;
}

function renderOfferLine(mon) {
  const name = mon?.name || `#${mon?.id || '??'}`;
  const shiny = mon?.shiny ? ' ✨' : '';
  return `[#${mon?.iid || '????'}] ${name}${shiny}`;
}

function renderTradeSummary(t) {
  const invA = getUserMonsInventory(t.a.id);
  const invB = getUserMonsInventory(t.b.id);
  const aLines = (t.a.offered || []).map(iid => {
    const m = invA.find(x => x.iid === iid) || invB.find(x => x.iid === iid) || { iid, name: '??' };
    return `• ${renderOfferLine(m)}`;
  });
  const bLines = (t.b.offered || []).map(iid => {
    const m = invA.find(x => x.iid === iid) || invB.find(x => x.iid === iid) || { iid, name: '??' };
    return `• ${renderOfferLine(m)}`;
  });
  const status = (t.status || 'OPEN').toUpperCase();
  const ra = t.a.ready ? '✅' : '⌛';
  const rb = t.b.ready ? '✅' : '⌛';
  const aa = t.a.accepted ? '✅' : '—';
  const ab = t.b.accepted ? '✅' : '—';
  return [
    `Trade #${t.id} [${status}]`,
    `${t.a.displayName} offers:`,
    aLines.length ? aLines.join('\n') : '• (nothing yet)',
    `${t.b.displayName} offers:`,
    bLines.length ? bLines.join('\n') : '• (nothing yet)',
    `Ready: ${t.a.displayName} ${ra} / ${t.b.displayName} ${rb}`,
    `Confirm: ${t.a.displayName} ${aa} / ${t.b.displayName} ${ab}`
  ].join('\n');
}

function newTrade(a, b) {
  const id = shortId(10);
  const now = Date.now();
  return {
    id,
    status: 'OPEN',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (TRADE_TTL_MIN * 60 * 1000),
    a: { id: tradeUserKey(a), displayName: a, offered: [], ready: false, accepted: false },
    b: { id: tradeUserKey(b), displayName: b, offered: [], ready: false, accepted: false },
  };
}

function findActiveTradeFor(uid, db) {
  const k = tradeUserKey(uid);
  for (const t of Object.values(db.active || {})) {
    if ((t.a.id === k || t.b.id === k) && ['OPEN','READY','LOCKED'].includes(t.status)) return t;
  }
  return null;
}

function lockMonForTrade(uid, iid, tradeId) {
  const inv = getUserMonsInventory(uid);
  const m = inv.find(x => x.iid === iid);
  if (!m) throw new Error('You do not own that mon.');
  if (m.lockedBy && m.lockedBy !== tradeId) throw new Error('That mon is locked by another trade.');
  m.lockedBy = tradeId;
}
function unlockAllForTrade(tradeId) {
  for (const u of Object.values(users)) {
    for (const m of (u.catches || [])) {
      if (m.lockedBy === tradeId) delete m.lockedBy;
    }
  }
  saveJson(USERS_FILE, users);
}

function transferMons(fromUid, toUid, iids, tradeId) {
  const A = users[fromUid]; const B = users[toUid] || (users[toUid] = ensureUser(toUid));
  A.catches ||= []; B.catches ||= [];
  const moving = [];
  A.catches = A.catches.filter(m => {
    if (iids.includes(m.iid)) {
      if (m.lockedBy !== tradeId) throw new Error('Mon not locked for this trade.');
      delete m.lockedBy;
      moving.push(m);
      return false;
    }
    return true;
  });
  B.catches = B.catches.concat(moving);
  saveJson(USERS_FILE, users);
}

function expireTradesTick() {
  const db = loadTrades();
  const now = Date.now();
  let changed = false;
  for (const t of Object.values(db.active || {})) {
    if (t.expiresAt && now > t.expiresAt && ['OPEN','READY','LOCKED'].includes(t.status)) {
      t.status = 'EXPIRED';
      changed = true;
      unlockAllForTrade(t.id);
    }
  }
  if (changed) saveTrades(db);
}

// run expiry every 30s
setInterval(() => { try { expireTradesTick(); } catch {} }, 30000);

/** =========================
 *  Spawn / End / Throw
 *  ========================= */
function spawnOne(channel) {
  const m = randomMonster();
  if (!m) return null;
  const isShiny = Math.floor(Math.random() * SHINY_RATE_DENOM) === 0;
  world.current = {
    id: m.id,
    name: m.name,
    rarity: m.rarity,
    shiny: Boolean(isShiny),
    startedAt: Date.now(),
    endsAt: Date.now() + SPAWN_DESPAWN_SEC * 1000,
    caughtBy: new Set(),
    attempts: {},
    channel
  };
  saveWorld();
  return world.current;
}

function endSpawn(reason = 'despawn') {
  const cur = world.current;
  if (!cur) return;
  const channel = cur.channel || (CHANNELS.length ? `#${CHANNELS[0]}` : null);

  const caught = Array.from(cur.caughtBy || []);
  const monName = cur.shiny ? `✨ ${cur.name} ✨` : cur.name;

  world.current = null;
  saveWorld();

  if (!channel) return;

  if (!caught.length) {
    client.say(channel, `The wild ${monName} fled. No captures this time.`);
  } else {
    const list = caught.map(u => '@' + u).join(', ');
    client.say(channel, `The wild ${monName} attempted to flee, but was Captured by: ${list}`);
  }
}

/** =========================
 *  Intro content
 *  ========================= */
const DROMON_INTRO_LINES = (p = PREFIX) => [
  `What is DroMon? → A cozy, Pokémon-style community catch game with original creatures, shinies, and a personal Dex.`,
  `How it works → Wilds spawn in chat every few minutes. Use ${p}throw pokeball|greatball|ultraball to try a catch.`,
  `Starter & daily → ${p}mon start gives a save + starter balls • ${p}daily gives a small refill`,
  `Progress → ${p}dex shows your species/shinies • ${p}bag shows your balls • ${p}scan repeats the current spawn`,
  `Shinies → Rare sparkle variants; slightly harder to catch (announced with ✨)`,
  `Examples → ${p}mon start  |  ${p}scan  |  ${p}throw pokeball  |  ${p}daily`,
  `Mods → ${p}spawn (force a spawn) • ${p}endspawn (despawn) • ${p}giveballs @user 10 ultraball • ${p}setrate shiny 2048`,
  `Theme → All creatures are original (no Nintendo IP). Mechanics-only homage for stream fun.`,
];

/** =========================
 *  Active chatter tracking (for reliable rain)
 *  ========================= */
const RECENT_CHATTERS = new Map(); // name -> lastSeenTs
function markActive(name) {
  RECENT_CHATTERS.set(String(name).toLowerCase(), Date.now());
}
function getRecentChatters(maxAgeMs = 15 * 60 * 1000) {
  const now = Date.now();
  const out = [];
  for (const [name, ts] of RECENT_CHATTERS.entries()) {
    if (now - ts <= maxAgeMs) out.push(name);
  }
  return out;
}

async function fetchChattersFor(channel) {
  const chan = String(channel).replace(/^#/, '').toLowerCase();
  const url = `https://tmi.twitch.tv/group/user/${chan}/chatters`;

  let apiList = [];
  try {
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (resp.ok) {
      const data = await resp.json();
      const groups = data?.chatters || {};
      apiList = []
        .concat(groups.broadcaster || [])
        .concat(groups.vips || [])
        .concat(groups.moderators || [])
        .concat(groups.viewers || [])
        .concat(groups.staff || [])
        .concat(groups.admins || [])
        .concat(groups.global_mods || []);
    } else {
      console.warn('[DroMon] chatters api HTTP', resp.status);
    }
  } catch (e) {
    console.warn('[DroMon] chatters api failed:', e?.message || e);
  }

  // Union with local recent chatters
  const recent = getRecentChatters();
  const union = new Set(
    apiList.map(u => u.toLowerCase()).concat(recent.map(u => u.toLowerCase()))
  );

  // Optional: filter out common utility bots
  const BLACKLIST = new Set(['nightbot','streamelements','moobot']);
  for (const b of BLACKLIST) union.delete(b);

  return [...union];
}

async function giveAllBalls(channel, ball, amount) {
  const valid = ['pokeball', 'greatball', 'ultraball'];
  const b = String(ball).toLowerCase();
  if (!valid.includes(b)) throw new Error('invalid ball');

  const chatters = await fetchChattersFor(channel);
  let given = 0;

  for (const name of chatters) {
    const u = ensureUser(name);
    u.balls[b] = (u.balls[b] || 0) + amount;
    given++;
  }
  if (given > 0) saveJson(USERS_FILE, users);
  return { given, count: chatters.length };
}

/** =========================
 *  Twitch client
 *  ========================= */
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true, joinMembership: true },
  connection: { secure: true, reconnect: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: CHANNELS.map(c => '#' + c)
});

client.on('connected', (addr, port) => {
  console.log('[DroMon] Connected', addr, port);
});
client.on('join', (channel, username, self) => {
  if (self) {
    console.log('[DroMon] Joined', channel);
  } else {
    markActive(username);
  }
});

await client.connect();

/** =========================
 *  Auto-spawn heartbeat
 *  ========================= */
setInterval(() => {
  if (!CHANNELS.length) return;
  if (world.current && Date.now() >= (world.current.endsAt || 0)) {
    endSpawn('timeout');
    return;
  }
  if (!world.current) {
    const since = Date.now() - (world.lastSpawnTs || 0);
    if (since >= SPAWN_INTERVAL_SEC * 1000) {
      const chan = `#${CHANNELS[0]}`;
      const s = spawnOne(chan);
      if (s) {
        client.say(
          chan,
          `TwitchLit A wild ${s.shiny ? '✨ ' : ''}${s.name}${s.shiny ? ' ✨' : ''} appears TwitchLit Catch it using !throw (winners revealed in ${Math.round(SPAWN_DESPAWN_SEC)}s)`
        );
        world.lastSpawnTs = Date.now();
        saveWorld();
      } else {
        const n = Array.isArray(dex.monsters) ? dex.monsters.length : 0;
        console.warn('[DroMon] Auto-spawn skipped: no monster (dex size =', n, 'reason =', dex.__reason, ')');
      }
    }
  }
}, 1000);

/** =========================
 *  Command handling (+ Trading)
 *  ========================= */
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  // track active users for rain union
  const seenName = (tags['display-name'] || tags.username || 'user').toLowerCase();
  markActive(seenName);

  if (!message.startsWith(PREFIX)) return;

  const username = seenName;
  const parts = message.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  const args = parts;

  // Trading command router
  if (cmd === 'trade') {
    try {
      // subcommands: @user | add <iid> | remove <iid> | show | ready | unready | accept | cancel
      const sub = (args[0] || '').toLowerCase();
      const db = loadTrades();
      const me = uc(username);

      if (sub.startsWith('@')) {
        const other = uc(sub.slice(1));
        if (!other) { client.say(channel, `Usage: ${PREFIX}trade @user`); return; }
        let t = findActiveTradeFor(me, db);
        if (!t) {
          t = newTrade(me, other);
          db.active[t.id] = t;
          saveTrades(db);
        }
        client.say(channel, `Opened trade #${t.id} with @${other}. Use "${PREFIX}trade add <iid>", "${PREFIX}trade show", "${PREFIX}trade ready", "${PREFIX}trade accept".`);
        return;
      }

      if (sub === 'add') {
        const iid = args[1];
        if (!iid) { client.say(channel, `Usage: ${PREFIX}trade add <iid>`); return; }
        const t = findActiveTradeFor(me, db);
        if (!t) { client.say(channel, `No active trade. Start with ${PREFIX}trade @user`); return; }
        const side = (t.a.id === me) ? 'a' : (t.b.id === me) ? 'b' : null;
        if (!side) { client.say(channel, `You are not part of this trade.`); return; }
        const inv = getUserMonsInventory(me);
        const mon = inv.find(m => m.iid === iid);
        if (!mon) { client.say(channel, `You do not own a mon with id ${iid}.`); return; }
        if (mon.lockedBy && mon.lockedBy !== t.id) { client.say(channel, `That mon is locked by another trade.`); return; }

        if (!t[side].offered.includes(iid)) t[side].offered.push(iid);
        t.a.ready = t.b.ready = false;
        t.a.accepted = t.b.accepted = false;
        t.updatedAt = Date.now();
        saveTrades(db);
        client.say(channel, renderTradeSummary(t));
        return;
      }

      if (sub === 'remove') {
        const iid = args[1];
        if (!iid) { client.say(channel, `Usage: ${PREFIX}trade remove <iid>`); return; }
        const t = findActiveTradeFor(me, db);
        if (!t) { client.say(channel, `No active trade.`); return; }
        const side = (t.a.id === me) ? 'a' : (t.b.id === me) ? 'b' : null;
        if (!side) { client.say(channel, `You are not part of this trade.`); return; }
        t[side].offered = (t[side].offered || []).filter(i => i !== iid);
        t.a.ready = t.b.ready = false;
        t.a.accepted = t.b.accepted = false;
        t.updatedAt = Date.now();
        saveTrades(db);
        client.say(channel, renderTradeSummary(t));
        return;
      }

      if (sub === 'show') {
        const t = findActiveTradeFor(me, db);
        if (!t) { client.say(channel, `No active trade.`); return; }
        client.say(channel, renderTradeSummary(t));
        return;
      }

      if (sub === 'ready' || sub === 'unready') {
        const t = findActiveTradeFor(me, db);
        if (!t) { client.say(channel, `No active trade.`); return; }
        const side = (t.a.id === me) ? 'a' : (t.b.id === me) ? 'b' : null;
        if (!side) { client.say(channel, `You are not part of this trade.`); return; }
        const ready = (sub === 'ready');
        t[side].ready = ready;
        t.a.accepted = t.b.accepted = false;
        if (t.a.ready && t.b.ready) {
          t.status = 'READY';
          // lock items
          for (const iid of t.a.offered) lockMonForTrade(t.a.id, iid, t.id);
          for (const iid of t.b.offered) lockMonForTrade(t.b.id, iid, t.id);
          saveJson(USERS_FILE, users);
        } else {
          t.status = 'OPEN';
          unlockAllForTrade(t.id);
        }
        t.updatedAt = Date.now();
        saveTrades(db);
        client.say(channel, renderTradeSummary(t));
        return;
      }

      if (sub === 'accept' || sub === 'confirm') {
        const t = findActiveTradeFor(me, db);
        if (!t) { client.say(channel, `No active trade.`); return; }
        if (!['READY','LOCKED'].includes(t.status)) { client.say(channel, `Both sides must be READY first.`); return; }
        t.status = 'LOCKED';
        const side = (t.a.id === me) ? 'a' : (t.b.id === me) ? 'b' : null;
        t[side].accepted = true;
        t.updatedAt = Date.now();
        saveTrades(db);

        if (t.a.accepted && t.b.accepted) {
          // swap
          try {
            transferMons(t.a.id, t.b.id, t.a.offered || [], t.id);
            transferMons(t.b.id, t.a.id, t.b.offered || [], t.id);
            unlockAllForTrade(t.id);
            t.status = 'COMPLETE';
            t.updatedAt = Date.now();
            saveTrades(db);
          } catch (e) {
            t.status = 'OPEN';
            saveTrades(db);
            client.say(channel, `Trade failed: ${e?.message || e}`);
            return;
          }
        }
        client.say(channel, renderTradeSummary(t));
        return;
      }

      if (sub === 'cancel') {
        const t = findActiveTradeFor(me, db);
        if (!t) { client.say(channel, `No active trade.`); return; }
        t.status = 'CANCELLED';
        t.updatedAt = Date.now();
        unlockAllForTrade(t.id);
        saveTrades(db);
        client.say(channel, `Trade #${t.id} cancelled.`);
        return;
      }

      // help text
      client.say(channel, `Trade: ${PREFIX}trade @user | add <iid> | remove <iid> | show | ready | unready | accept | cancel`);
      return;
    } catch (e) {
      client.say(channel, `Trade error: ${e?.message || e}`);
      return;
    }
  }

  // ===== DEX LIST MUST COME BEFORE GENERIC DEX =====
  if (cmd === 'dex' && args[0] === 'list') {
    const u = ensureUser(username);
    const typeArg = String(args[1] || '').toLowerCase();
    if (!typeArg) { client.say(channel, `@${username} usage: ${PREFIX}dex list <type>`); return; }
    const mons = Array.isArray(dex.monsters) ? dex.monsters : [];
    const byId = new Map(mons.map(m => [m.id, m]));
    const caught = Array.isArray(u.catches) ? u.catches : [];
    const names = [];
    const cap = 40; // avoid spam
    for (const c of caught) {
      const mon = byId.get(c.id);
      const types = (Array.isArray(mon?.types) ? mon.types : []).map(t => t.toLowerCase());
      if (types.includes(typeArg)) {
        names.push(`${mon.name} (#${mon?.id ?? c.id ?? '??'})${c.shiny ? ' ✨' : ''}`);
      }
      if (names.length >= cap) break;
    }
    if (!names.length) {
      client.say(channel, `@${username} you have no ${typeArg}-type entries yet.`);
    } else {
      const prettyType = typeArg.charAt(0).toUpperCase()+typeArg.slice(1);
      sayChunks(client, channel, `${TYPE_EMOJI[prettyType]||'◻️'} ${prettyType}-types you’ve caught:`, names);
    }
    return;
  } else if (cmd === 'dex') {
    // Dex (pretty summary + per-type listing hint)
    const u = ensureUser(username);
    const mons = Array.isArray(dex.monsters) ? dex.monsters : [];
    const byId = new Map(mons.map(m => [m.id, m]));
    const caught = Array.isArray(u.catches) ? u.catches : [];
    const total = mons.length;
    const uniqueIds = new Set(caught.map(c => c.id));
    const shinyCount = caught.filter(c => c.shiny).length;

    // Build type counts
    const typeCounts = {};
    for (const id of uniqueIds) {
      const mon = byId.get(id);
      const types = Array.isArray(mon?.types) ? mon.types : [];
      const k = types.join('/');
      if (!k) continue;
      typeCounts[k] = (typeCounts[k] || 0) + 1;
    }
    const summary = Object.entries(typeCounts)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 10)
      .map(([k,v]) => {
        const badges = k.split('/').map(t => `${TYPE_EMOJI[t] || '◻️'}${t[0]}`).join('');
        return `${badges}:${v}`;
      });

    client.say(channel, `@${username} Dex ${uniqueIds.size}/${total} • ✨${shinyCount} • Types: ${summary.join(' | ') || 'n/a'} • Use ${PREFIX}dex list <type> to list.`);
    return;
  }

  // Intro
  if (cmd === 'dromon' || cmd === 'monabout' || cmd === 'intro') {
    sayChunks(client, channel, `DroMon intro:`, DROMON_INTRO_LINES(PREFIX));
    return;
  }

  // Help (renamed to pokehelp; keep !help alias)
  if (cmd === 'help' || cmd === 'pokehelp') {
    client.say(
      channel,
      `@${username} cmds: ${PREFIX}mon start • ${PREFIX}daily • ${PREFIX}bag • ${PREFIX}dex • ${PREFIX}scan • ` +
      `${PREFIX}throw [pb|gb|ub] • ${PREFIX}setthrow <pb|gb|ub> • ${PREFIX}dromon • ${PREFIX}trade`
    );
    return;
  }

  // Debug helpers
  if (cmd === 'dexreload') {
    if (!isModOrBroadcaster(tags)) { client.say(channel, `@${username} mods/broadcaster only.`); return; }
    dex = loadDex();
    client.say(channel, `Dex reloaded: ${Array.isArray(dex.monsters)?dex.monsters.length:0} monsters.`);
    return;
  }
  if (cmd === 'dexcount') {
    const total = Array.isArray(dex.monsters) ? dex.monsters.length : 0;
    const rs = Object.entries(dex.rarityWeights || {}).map(([k,v]) => `${k}:${v}`).join(' | ') || 'n/a';
    client.say(channel, `Dex: ${total} monsters • rarity weights: ${rs}`);
    return;
  }
  if (cmd === 'dexpath') {
    if (!isModOrBroadcaster(tags)) { client.say(channel, `mods only`); return; }
    client.say(channel, `Dex path: ${DEX_FILE}`);
    return;
  }
  if (cmd === 'spawncheck') {
    if (!isModOrBroadcaster(tags)) { client.say(channel, `mods only`); return; }
    const n = Array.isArray(dex.monsters) ? dex.monsters.length : 0;
    const rs = Object.entries(dex.rarityWeights || {}).map(([k,v]) => `${k}:${v}`).join(' | ') || 'n/a';
    const sample = (dex.monsters || []).slice(0, 3).map(m => m.name).join(', ') || 'none';
    client.say(channel, `Dex: ${n} monsters • weights: ${rs} • sample: ${sample}`);
    return;
  }

  // Start save
  if (cmd === 'mon' && args[0] === 'start') {
    const u = ensureUser(username);
    if (!u._started) {
      u._started = true;
      u.balls.pokeball += 10;
      u.balls.greatball += 5;
      u.balls.ultraball += 2;
      saveJson(USERS_FILE, users);
      client.say(channel, `@${username} save created! Starter pack: +10 pokeball, +5 greatball, +2 ultraball. Use ${PREFIX}scan then ${PREFIX}throw pokeball.`);
    } else {
      client.say(channel, `@${username} you already have a save. Check ${PREFIX}bag.`);
    }
    return;
  }

  // Daily
  if (cmd === 'daily') {
    const u = ensureUser(username);
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    if (now - (u.lastDaily || 0) < DAY) {
      const leftMs = (u.lastDaily || 0) + DAY - now;
      const leftH = Math.max(0, Math.ceil(leftMs / 3600000));
      client.say(channel, `@${username} daily already claimed. Try again in ~${leftH}h.`);
      return;
    }
    u.lastDaily = now;
    u.balls.pokeball += 5;
    u.balls.greatball += 2;
    u.balls.ultraball += 1;
    saveJson(USERS_FILE, users);
    client.say(channel, `@${username} daily claimed: +5 pokeball, +2 greatball, +1 ultraball.`);
    return;
  }

  // Bag
  if (cmd === 'bag') {
    const u = ensureUser(username);
    client.say(channel, `@${username} bag → pokeball:${u.balls.pokeball||0} | greatball:${u.balls.greatball||0} | ultraball:${u.balls.ultraball||0}`);
    return;
  }

  // Scan (no hint)
  if (cmd === 'scan') {
    if (!world.current) { client.say(channel, `No wild appears.`); return; }
    const secLeft = Math.max(0, Math.ceil((world.current.endsAt - Date.now()) / 1000));
    client.say(channel, `Wild ${world.current.shiny ? '✨ ' : ''}${world.current.name}${world.current.shiny ? ' ✨' : ''} (${world.current.rarity}) • ${secLeft}s left`);
    return;
  }

  // Throw (aliases + default; no immediate reveal)
  if (cmd === 'throw') {
    const u = ensureUser(username);

    const argBall = (args[0] || '').toLowerCase();
    const chosenBall = ballFromAlias(argBall || u.defaultBall || 'pokeball');

    if (!['pokeball', 'greatball', 'ultraball'].includes(chosenBall)) {
      client.say(channel, `@${username} usage: ${PREFIX}throw [pb|gb|ub] — set default with ${PREFIX}setthrow <pb|gb|ub>`);
      return;
    }

    if (!world.current) {
      client.say(channel, `@${username} there is no active encounter. Use ${PREFIX}scan and wait for a spawn.`);
      return;
    }
    if ((u.balls[chosenBall] || 0) <= 0) {
      client.say(channel, `@${username} you have no ${chosenBall}s. Try ${PREFIX}daily or check ${PREFIX}bag.`);
      return;
    }

    // Spend ball
    u.balls[chosenBall] = (u.balls[chosenBall] || 0) - 1;
    saveJson(USERS_FILE, users);

    // Compute success
    const mon = (dex.monsters || []).find(x => x.id === world.current.id) || { catchRate: 0 };
    const p = computeCatchChance(mon, chosenBall, world.current.shiny);
    const roll = Math.random();
    const success = roll < p;

    world.current.attempts[uc(username)] = { ball: chosenBall, p, roll, success, ts: Date.now() };
    if (success) {
      world.current.caughtBy.add(uc(username));
      // store catch silently (now with iid)
      u.catches = u.catches || [];
      u.catches.push({ iid: shortId(8), id: mon.id, name: mon.name, shiny: world.current.shiny, ts: Date.now() });
      saveJson(USERS_FILE, users);
    }
    saveWorld();

    client.say(channel, `@${username} threw a ${chosenBall}! Results will be revealed when the encounter ends.`);
    return;
  }

  // Set default throw ball
  if (cmd === 'setthrow') {
    const u = ensureUser(username);
    const choice = ballFromAlias(args[0], '');
    if (!['pokeball', 'greatball', 'ultraball'].includes(choice)) {
      client.say(channel, `@${username} usage: ${PREFIX}setthrow <pb|gb|ub>`);
      return;
    }
    u.defaultBall = choice;
    saveJson(USERS_FILE, users);
    client.say(channel, `@${username} default throw set to ${choice}. Use ${PREFIX}throw to auto-use it.`);
    return;
  }

  /** ====== MOD / BROADCASTER COMMANDS ====== */
  if (cmd === 'spawn') {
    if (!isModOrBroadcaster(tags)) { client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}spawn.`); return; }
    if (world.current) { client.say(channel, `@${username} a wild ${world.current.shiny ? '✨ ' : ''}${world.current.name}${world.current.shiny ? ' ✨' : ''} is already out. Use ${PREFIX}scan.`); return; }
    const s = spawnOne(channel);
    if (!s) {
      const n = Array.isArray(dex.monsters) ? dex.monsters.length : 0;
      client.say(channel, `spawn skipped — Dex has ${n} monsters (reason: ${dex.__reason || 'unknown'}). Try ${PREFIX}dexreload or ${PREFIX}dexpath to verify.`);
      return;
    }
    client.say(
      channel,
      `TwitchLit A wild ${s.shiny ? '✨ ' : ''}${s.name}${s.shiny ? ' ✨' : ''} appears TwitchLit Catch it using !throw (winners revealed in ${Math.round(SPAWN_DESPAWN_SEC)}s)`
    );
    world.lastSpawnTs = Date.now();
    saveWorld();
    return;
  }

  if (cmd === 'endspawn') {
    if (!isModOrBroadcaster(tags)) { client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}endspawn.`); return; }
    if (!world.current) { client.say(channel, `@${username} no active spawn.`); return; }
    client.say(channel, `@${username} ended the encounter with ${world.current.shiny ? '✨ ' : ''}${world.current.name}${world.current.shiny ? ' ✨' : ''}.`);
    endSpawn('manual');
    return;
  }

  if (cmd === 'giveballs') {
    if (!isModOrBroadcaster(tags)) { client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}giveballs.`); return; }
    const target = (args[0] || '').replace(/^@/, '');
    const amount = parseInt(args[1] || '0', 10);
    const ball = (args[2] || '').toLowerCase();
    if (!target || !Number.isFinite(amount) || amount <= 0 || !['pokeball','greatball','ultraball'].includes(ball)) {
      client.say(channel, `Usage: ${PREFIX}giveballs @user 10 ultraball`);
      return;
    }
    const tu = ensureUser(target);
    tu.balls[ball] = (tu.balls[ball] || 0) + amount;
    saveJson(USERS_FILE, users);
    client.say(channel, `Gave @${target} +${amount} ${ball}(s).`);
    return;
  }

  if (cmd === 'setrate') {
    if (!isModOrBroadcaster(tags)) { client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}setrate.`); return; }
    if ((args[0] || '').toLowerCase() === 'shiny') {
      const denom = parseInt(args[1] || '0', 10);
      if (denom >= 64 && denom <= 65536) {
        SHINY_RATE_DENOM = denom;
        client.say(channel, `Shiny rate set to 1/${denom}.`);
      } else {
        client.say(channel, `Pick a sensible shiny denom (64..65536).`);
      }
    } else {
      client.say(channel, `Usage: ${PREFIX}setrate shiny <denominator> (e.g., ${PREFIX}setrate shiny 2048)`);
    }
    return;
  }

  // === Ball rain commands ===
  if (cmd === 'rainpb' || cmd === 'raingb' || cmd === 'rainub') {
    if (!isModOrBroadcaster(tags)) {
      client.say(channel, `@${username} only mods or the broadcaster can use this.`);
      return;
    }
    const ball = cmd === 'rainpb' ? 'pokeball' : cmd === 'raingb' ? 'greatball' : 'ultraball';
    const amount = 10; // tweak if you want a different rain size
    try {
      const { given } = await giveAllBalls(channel, ball, amount);
      if (given === 0) {
        client.say(channel, `No chatters detected right now. Try again in a bit.`);
      } else {
        client.say(channel, `Ball rain! ☔️ Gave ${amount} ${ball}(s) to ${given} chatter(s). Enjoy!`);
      }
    } catch (e) {
      console.error('[DroMon] rain cmd error:', e?.message || e);
      client.say(channel, `Rain failed. Check logs.`);
    }
    return;
  }

  // === Types enrichment (mod) ===
  if (cmd === 'fixtypes') {
    if (!isModOrBroadcaster(tags)) {
      client.say(channel, `@${username} mods/broadcaster only.`);
      return;
    }
    client.say(channel, `@${username} filling missing types (1–493)…`);
    try {
      const changed = await ensureCanonicalTypes(493, 150);
      client.say(channel, changed ? `Types check complete. Missing entries updated.` : `All entries already had types.`);
    } catch (e) {
      client.say(channel, `Types update failed: ${e?.message || e}`);
    }
    return;
  }

}); // <-- end of message handler

// Background fill at startup (non-blocking)
ensureCanonicalTypes(493, 200).then(changed => {
  if (changed) console.log('[DroMon] Types were updated on startup.');
}).catch(e => console.warn('[DroMon] ensureCanonicalTypes error:', e?.message || e));

/** =========================
 *  Overlay HTTP server (safe port handling)
 *  ========================= */
const __HERE = path.dirname(new URL(import.meta.url).pathname);
const OVERLAY_ROOT = process.env.DROMON_OVERLAY_DIR || path.join(__HERE, 'data', 'overlay');
const OVERLAY_PORT = Number(process.env.DROMON_PORT || process.env.OVERLAY_PORT || 10001);

function sendFile(res, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.gif' ? 'image/gif' :
    ext === '.js' ? 'text/javascript; charset=utf-8' :
    ext === '.css' ? 'text/css; charset=utf-8' :
    'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(absPath).pipe(res);
}

const server = createServer((req, res) => {
  try {
    const urlPath = (req.url || '/').replace(/\?.*$/, '').replace(/\/+$/, '') || '/';
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const abs = path.join(OVERLAY_ROOT, rel);

    // basic path traversal guard
    if (!abs.startsWith(OVERLAY_ROOT)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    if (fs.existsSync(abs)) {
      return sendFile(res, abs);
    }

    // fallback to index.html
    const fallback = path.join(OVERLAY_ROOT, 'index.html');
    if (fs.existsSync(fallback)) {
      return sendFile(res, fallback);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    res.writeHead(500);
    res.end('server error');
  }
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.warn(
      `[DroMon] Port ${OVERLAY_PORT} in use — skipping overlay HTTP server. ` +
      `Set DROMON_PORT to a free port if you need the overlay.`
    );
  } else {
    console.error('[DroMon] HTTP server error:', err?.message || err);
  }
});

server.listen(OVERLAY_PORT, () => {
  console.log('[DroMon] Overlay HTTP on :' + OVERLAY_PORT);
});
