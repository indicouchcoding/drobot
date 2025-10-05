
import 'dotenv/config';
import tmi from 'tmi.js';
import fs from 'fs';
import path from 'path';

// -------- File paths (robust) --------
// Resolve relative to this file (pokemon/dromon.js), not process CWD
const HERE = path.dirname(new URL(import.meta.url).pathname);

// Writable data dir (can override via env)
const DROMON_DATA_DIR =
  process.env.DROMON_DATA_DIR ||          // e.g., /opt/render/project/src/pokemon/data  or  /data/dromon
  path.join(HERE, 'data');                // default: pokemon/data next to this file

if (!fs.existsSync(DROMON_DATA_DIR)) fs.mkdirSync(DROMON_DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DROMON_DATA_DIR, 'users.json');
const WORLD_FILE = path.join(DROMON_DATA_DIR, 'world.json');

// Dex file: allow explicit override, else use repo copy next to the script
const DEX_FILE =
  process.env.DROMON_DEX_FILE ||          // e.g., /opt/render/project/src/pokemon/data/mondex.json
  path.join(HERE, 'data', 'mondex.json');

// -------- Env --------
const PREFIX = process.env.PREFIX || '!';
const CHANNELS = (process.env.TWITCH_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const SPAWN_INTERVAL_SEC = Number(process.env.SPAWN_INTERVAL_SEC || 300);
const SPAWN_DESPAWN_SEC = Number(process.env.SPAWN_DESPAWN_SEC || 180);
let SHINY_RATE_DENOM = Number(process.env.SHINY_RATE_DENOM || 1024);

// -------- Load/save helpers --------
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

// -------- Load data --------
let users = loadJson(USERS_FILE, {});
let world = loadJson(WORLD_FILE, { current: null, lastSpawnTs: 0 });
const dex = loadJson(DEX_FILE, { monsters: [], rarityWeights: {}, balls: {} });

// Helpful log so you can confirm on Render
console.log('[DroMon] Data dir:', DROMON_DATA_DIR);
console.log('[DroMon] Dex file:', DEX_FILE, 'monsters:', dex.monsters?.length || 0);

// -------- Helpers --------
function now() { return Date.now(); }
function pickWeighted(list, weightFn) {
  const total = list.reduce((s, e) => s + weightFn(e), 0);
  let r = Math.random() * total;
  for (const e of list) {
    r -= weightFn(e);
    if (r <= 0) return e;
  }
  return list[list.length-1];
}

function ensureUser(name) {
  const k = String(name || '').toLowerCase();
  if (!users[k]) users[k] = { created: now(), balls: { pokeball: 10, greatball: 5, ultraball: 2 }, lastDaily: 0, dex: {}, catches: [] };
  return users[k];
}
function userDisplay(name) { return name?.trim() || 'someone'; }

function rarityWeightOf(mon) {
  return dex.rarityWeights[mon.rarity] || 1;
}

function spawnOne() {
  if (!dex.monsters?.length) return null;
  const mon = pickWeighted(dex.monsters, (m)=>rarityWeightOf(m));
  const shiny = (Math.floor(Math.random() * SHINY_RATE_DENOM) === 0);
  const expiresAt = now() + SPAWN_DESPAWN_SEC*1000;
  world.current = { id: mon.id, name: mon.name, rarity: mon.rarity, hint: mon.hint, shiny, spawnedAt: now(), expiresAt };
  world.lastSpawnTs = now();
  saveJson(WORLD_FILE, world);
  return world.current;
}

function endSpawn() {
  world.current = null;
  saveJson(WORLD_FILE, world);
}

function ballBonus(ball) {
  return dex.balls[ball]?.bonus || 1.0;
}

// Basic catch formula adapted from classic-style: higher catchRate + ball bonus = easier
function tryCatch(mon, ball) {
  const base = mon.catchRate || 100;      // 0-255-ish range
  const bonus = ballBonus(ball);
  const shinyMod = 0.9; // slightly harder to catch shiny
  const target = Math.min(255, base * bonus * (world.current?.shiny ? shinyMod : 1));
  const roll = Math.random() * 255;
  return roll <= target;
}

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms/1000));
  return `${s}s`;
}

// -------- Twitch --------
const client = new tmi.Client({
  options: { debug: false },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: CHANNELS
});

client.connect().then(()=>{
  console.log('[DroMon] Connected.', CHANNELS);
}).catch(err => console.error('Twitch connect error', err));

function sayAll(msg) {
  for (const ch of CHANNELS) client.say(ch, msg);
}

function isMod(tags) {
  return Boolean(tags.mod) || tags.badges?.broadcaster === '1';
}

// Auto-spawn loop
setInterval(()=>{
  if (!world.current && (now() - world.lastSpawnTs) >= SPAWN_INTERVAL_SEC*1000) {
    const s = spawnOne();
    if (s) sayAll(`A wild ${s.shiny ? '✨ ' : ''}${s.name}${s.shiny ? ' ✨' : ''} appeared! Rarity: ${s.rarity}. Use ${PREFIX}throw pokeball|greatball|ultraball — hint: ${s.hint}`);
  } else if (world.current && now() >= world.current.expiresAt) {
    sayAll(`${world.current.shiny ? '✨ ' : ''}${world.current.name}${world.current.shiny ? ' ✨' : ''} fled into the smoke... (despawn)`);
    endSpawn();
  }
}, 1500);

// -------- Commands --------
client.on('message', (channel, tags, message, self) => {
  if (self || !message.startsWith(PREFIX)) return;
  const username = tags['display-name'] || tags.username;
  const [raw, ...rest] = message.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (raw||'').toLowerCase();
  const args = rest;

  if (cmd === 'help' || cmd === 'monhelp') {
    client.say(channel, `@${username} commands: ${PREFIX}mon start • ${PREFIX}bag • ${PREFIX}daily • ${PREFIX}dex • ${PREFIX}throw pokeball|greatball|ultraball • ${PREFIX}scan`);
    return;
  }

  if (cmd === 'mon' && args[0]?.toLowerCase() === 'start') {
    const u = ensureUser(username);
    saveJson(USERS_FILE, users);
    client.say(channel, `@${username} save created! Starter pack: 10 pokeball, 5 greatball, 2 ultraball. Use ${PREFIX}bag`);
    return;
  }

  if (cmd === 'bag') {
    const u = ensureUser(username);
    client.say(channel, `@${username} bag → pokeball:${u.balls.pokeball||0}, greatball:${u.balls.greatball||0}, ultraball:${u.balls.ultraball||0}`);
    return;
  }

  if (cmd === 'daily') {
    const u = ensureUser(username);
    const day = 24*60*60*1000;
    if (now() - (u.lastDaily||0) < day) {
      const left = day - (now() - (u.lastDaily||0));
      client.say(channel, `@${username} you already claimed daily. Come back in ${formatTime(left)}.`);
      return;
    }
    u.lastDaily = now();
    u.balls.pokeball = (u.balls.pokeball||0) + 5;
    u.balls.greatball = (u.balls.greatball||0) + 2;
    saveJson(USERS_FILE, users);
    client.say(channel, `@${username} daily claimed: +5 pokeball, +2 greatball.`);
    return;
  }

  if (cmd === 'scan') {
    if (!world.current) {
      client.say(channel, `@${username} nothing in the grass right now.`);
    } else {
      const left = world.current.expiresAt - now();
      client.say(channel, `@${username} wild ${world.current.shiny ? '✨ ':''}${world.current.name}${world.current.shiny ? ' ✨':''} (Rarity: ${world.current.rarity}) — hint: ${world.current.hint} — ${formatTime(left)} left.`);
    }
    return;
  }

  if (cmd === 'throw') {
    const ball = (args[0]||'').toLowerCase();
    if (!['pokeball','greatball','ultraball'].includes(ball)) {
      client.say(channel, `@${username} usage: ${PREFIX}throw pokeball|greatball|ultraball`);
      return;
    }
    const u = ensureUser(username);
    if ((u.balls[ball]||0) <= 0) {
      client.say(channel, `@${username} you have no ${ball}s left. Use ${PREFIX}bag or ${PREFIX}daily.`);
      return;
    }
    if (!world.current) {
      client.say(channel, `@${username} nothing to catch right now.`);
      return;
    }
    u.balls[ball]--;
    const mon = dex.monsters.find(m=>m.id===world.current.id);
    const ok = tryCatch(mon, ball);
    if (ok) {
      const shiny = world.current.shiny;
      const entry = { id: mon.id, name: mon.name, shiny, caughtAt: now() };
      u.catches.push(entry);
      u.dex[mon.id] = (u.dex[mon.id]||0) + 1;
      saveJson(USERS_FILE, users);
      client.say(channel, `@${username} caught ${shiny ? '✨ ':''}${mon.name}${shiny ? ' ✨':''}! Dex+1. (Used 1 ${ball})`);
      // end spawn once caught
      endSpawn();
    } else {
      saveJson(USERS_FILE, users);
      client.say(channel, `@${username} the ${world.current.name} broke free! (Used 1 ${ball})`);
    }
    return;
  }

  if (cmd === 'dex') {
    const u = ensureUser(username);
    const totalSpecies = dex.monsters.length;
    const seen = Object.keys(u.dex).length;
    const shinyCount = u.catches.filter(c=>c.shiny).length;
    client.say(channel, `@${username} Dex: ${seen}/${totalSpecies} species • Shinies: ${shinyCount} • Total caught: ${u.catches.length}`);
    return;
  }

  // ---- Mods ----
// --- robust mod/broadcaster gate (inline helper for this block)
const _isModOrBroadcaster = (t) =>
  Boolean(t?.mod) ||
  t?.badges?.broadcaster === '1' ||
  String(t?.['user-id'] || '') === String(t?.['room-id'] || '');

if (cmd === 'spawn') {
  if (!_isModOrBroadcaster(tags)) {
    client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}spawn.`);
    return;
  }
  if (world.current) {
    client.say(channel, `@${username} a wild ${world.current.shiny ? '✨ ' : ''}${world.current.name}${world.current.shiny ? ' ✨' : ''} is already out. Use ${PREFIX}scan.`);
    return;
  }
  const s = spawnOne();
  if (s) {
    client.say(channel, `Forced spawn → wild ${s.shiny ? '✨ ' : ''}${s.name}${s.shiny ? ' ✨' : ''} (Rarity: ${s.rarity}) appeared! Hint: ${s.hint}`);
  } else {
    client.say(channel, `@${username} spawn failed (no creatures in the Dex?). Check data/mondex.json.`);
  }
  return;
}

if (cmd === 'endspawn') {
  if (!_isModOrBroadcaster(tags)) {
    client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}endspawn.`);
    return;
  }
  if (!world.current) {
    client.say(channel, `@${username} no active spawn.`);
    return;
  }
  client.say(channel, `@${username} ended the encounter with ${world.current.name}.`);
  endSpawn();
  return;
}

if (cmd === 'giveballs') {
  if (!_isModOrBroadcaster(tags)) {
    client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}giveballs.`);
    return;
  }
  const target = args[0]?.replace(/^@/, '') || '';
  const amount = parseInt(args[1] || '0', 10);
  const ball = (args[2] || '').toLowerCase();
  if (!target || isNaN(amount) || amount <= 0 || !['pokeball', 'greatball', 'ultraball'].includes(ball)) {
    client.say(channel, `Usage: ${PREFIX}giveballs @user 10 ultraball`);
    return;
  }
  const u = ensureUser(target);
  u.balls[ball] = (u.balls[ball] || 0) + amount;
  saveJson(USERS_FILE, users);
  client.say(channel, `Gave @${target} +${amount} ${ball}(s).`);
  return;
}

if (cmd === 'setrate') {
  if (!_isModOrBroadcaster(tags)) {
    client.say(channel, `@${username} only mods or the broadcaster can use ${PREFIX}setrate.`);
    return;
  }
  if (args[0]?.toLowerCase() === 'shiny') {
    const denom = parseInt(args[1] || '0', 10);
    if (denom >= 64 && denom <= 65536) {
      SHINY_RATE_DENOM = denom;
      client.say(channel, `Shiny rate set to 1/${denom}.`);
    } else {
      client.say(channel, `Pick a sensible shiny denom (64..65536).`);
    }
  } else {
    client.say(channel, `Usage: ${PREFIX}setrate shiny <denominator>  (e.g., ${PREFIX}setrate shiny 2048)`);
  }
  return;
}
});
