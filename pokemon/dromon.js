import 'dotenv/config';
import tmi from 'tmi.js';
import fs from 'fs';
import path from 'path';
import express from 'express';

/** =========================
 *  Paths & JSON helpers
 *  ========================= */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const DROMON_DATA_DIR = process.env.DROMON_DATA_DIR || path.join(HERE, 'data');
if (!fs.existsSync(DROMON_DATA_DIR)) fs.mkdirSync(DROMON_DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DROMON_DATA_DIR, 'users.json');
const WORLD_FILE = path.join(DROMON_DATA_DIR, 'world.json');
const DEX_FILE = process.env.DROMON_DEX_FILE || path.join(HERE, 'data', 'mondex.json');

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

const CATCH_RATE_MODE = (process.env.CATCH_RATE_MODE || 'raw255').toLowerCase();
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
    base = rate / 100;
  } else if (CATCH_RATE_MODE === 'unit') {
    base = rate;
  } else {
    base = rate / CATCH_RATE_SCALE;
  }
  let p = base * (BALL_BONUS[ballName] || 1.0);
  if (isShiny) p *= SHINY_CATCH_PENALTY;
  if (!Number.isFinite(p)) p = 0;
  p = Math.max(MIN_CATCH, Math.min(MAX_CATCH, p));
  return p;
}

/** =========================
 *  Overlay HTTP (Express)
 *  ========================= */
const app = express();

const spritesDir = path.resolve(process.cwd(), "drobot", "pokemon", "data", "sprites");
const overlayDir = path.resolve(process.cwd(), "drobot", "pokemon", "data", "overlay");

function spriteFileName(id, shiny) {
  return `${String(id).padStart(3,'0')}${shiny ? '_shiny': ''}.png`;
}
function buildOverlayState() {
  const cur = world.current;
  if (!cur) return { active: false };
  const mon = (dex.monsters || []).find(x => x.id === cur.id);
  const imageUrl = `/sprites/${spriteFileName(cur.id, cur.shiny)}`;
  return {
    active: true,
    name: cur.name,
    rarity: cur.rarity,
    shiny: !!cur.shiny,
    dex: cur.id,
    types: Array.isArray(mon?.types) ? mon.types : [],
    imageUrl,
    startedAt: cur.startedAt,
    endsAt: cur.endsAt
  };
}

app.get("/overlay/state", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(buildOverlayState());
});
app.use("/overlay", express.static(overlayDir, { index: "index.html" }));
app.use("/sprites", express.static(spritesDir, {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
}));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[DroMon] Overlay server listening on port ${PORT}`);
});

/** =========================
 *  Type helpers
 *  ========================= */
const TYPE_EMOJI = {
  Normal: '⚪', Fire: '🔥', Water: '💧', Grass: '🌿', Electric: '⚡',
  Ice: '❄️', Fighting: '🥊', Poison: '☠️', Ground: '🪨',
  Flying: '🪽', Psychic: '🔮', Bug: '🐛', Rock: '🗿',
  Ghost: '👻', Dragon: '🐉', Dark: '🌑', Steel: '⚙️', Fairy: '✨'
};

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
 *  Spawn / End / Throw
 *  ========================= */
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
  const r = (() => {
    const entries = Object.entries(dex.rarityWeights || {});
    const total = entries.reduce((a, [,w]) => a + Number(w||0), 0);
    if (total <= 0) return 'Common';
    let roll = Math.random() * total;
    for (const [k, w] of entries) { roll -= Number(w||0); if (roll <= 0) return k; }
    return entries.length ? entries[0][0] : 'Common';
  })();
  const pool = mons.filter(m => m.rarity === r);
  if (!pool.length) return mons[Math.floor(Math.random() * mons.length)];
  return pool[Math.floor(Math.random() * pool.length)];
}

function saveWorld() {
  const toSave = { ...world };
  if (toSave.current) {
    toSave.current = { ...toSave.current, caughtBy: Array.from(toSave.current.caughtBy || []) };
  }
  fs.writeFileSync(WORLD_FILE, JSON.stringify(toSave, null, 2));
}

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
    RECENT_CHATTERS.set(String(username).toLowerCase(), Date.now());
  }
});

await client.connect();

/** =========================
 *  Heartbeat
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
      }
    }
  }
}, 1000);

/** =========================
 *  Commands (same as before, trimmed here for brevity)
 *  ========================= */
// (Omitted: same command handlers as your current file; keep them.)
