import 'dotenv/config';
import tmi from 'tmi.js';
import fs from 'fs';
import path from 'path';

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
// --- One-time migration: /var/data/indicouch/dromon  ->  /data/dromon
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
 *  Twitch client
 *  ========================= */
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true },
  connection: { secure: true, reconnect: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: CHANNELS.map(c => '#' + c)
});

client.on('connected', (addr, port) => {
  console.log('[DroMon] Connected', addr, port);
});
client.on('join', (channel, username, self) => {
  if (self) console.log('[DroMon] Joined', channel);
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
 *  Command handling
 *  ========================= */
client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if (!message.startsWith(PREFIX)) return;

  const username = (tags['display-name'] || tags.username || 'user').toLowerCase();
  const parts = message.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  const args = parts;

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
      `${PREFIX}throw [pb|gb|ub] • ${PREFIX}setthrow <pb|gb|ub> • ${PREFIX}dromon`
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

  // Dex
  if (cmd === 'dex') {
    const u = ensureUser(username);
    const total = (dex.monsters || []).length;
    const caughtIds = new Set((u.catches || []).map(c => c.id));
    const shinyCount = (u.catches || []).filter(c => c.shiny).length;
    client.say(channel, `@${username} Dex → ${caughtIds.size}/${total} species • ${shinyCount} shinies.`);
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

    // ball selection: arg alias, or user's default, fallback to pokeball
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
      // store catch silently
      u.catches = u.catches || [];
      u.catches.push({ id: mon.id, name: mon.name, shiny: world.current.shiny, ts: Date.now() });
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
    // reset auto-spawn timer after a forced spawn
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
});
