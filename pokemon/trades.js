/**
 * DroMon Trading System (ESM)
 * Lightweight, file-backed user-to-user trading with escrow & 2-step confirmation.
 * No external deps. Designed for Twitch chat bots (tmi.js) but UI-agnostic.
 *
 * Files:
 *   - trades.js (this file)
 *   - trade_inventory_adapter.js (plug your existing inventory here)
 *   - trade_inventory_fallback.js (optional JSON fallback if you don't wire your own)
 *
 * Env (optional):
 *   DROMON_TRADES_PATH=./data/trades.json
 *   DROMON_TRADE_TTL_MIN=10
 *
 * Commands this module expects your bot to route:
 *   !trade @user
 *   !trade add <monShortId>
 *   !trade remove <monShortId>
 *   !trade show
 *   !trade ready
 *   !trade unready
 *   !trade accept     (final confirm; both users must accept)
 *   !trade cancel
 *
 * Each Pokémon instance must have a stable instance id "iid" (e.g. 8 chars) shown in your !inv.
 * Use the provided migration script if you need to assign missing iids.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Adapter: wire to your inventory here.
import * as Inventory from './trade_inventory_adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRADES_PATH = process.env.DROMON_TRADES_PATH
  ? path.resolve(process.cwd(), process.env.DROMON_TRADES_PATH)
  : path.join(__dirname, 'data', 'trades.json');

const TTL_MIN = Number(process.env.DROMON_TRADE_TTL_MIN || 10);

function now() { return Date.now(); }
function minutes(ms) { return ms * 60 * 1000; }

function shortId(n = 8) {
  return crypto.randomBytes(8).toString('base64url').slice(0, n);
}

async function ensureFile(filepath, fallback = {}) {
  try {
    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.access(filepath);
  } catch {
    await fs.writeFile(filepath, JSON.stringify(fallback, null, 2));
  }
}

async function readJSON(filepath) {
  await ensureFile(filepath, { active: {} });
  const raw = await fs.readFile(filepath, 'utf8');
  try { return JSON.parse(raw || '{}'); } catch { return { active: {} }; }
}

async function writeJSON(filepath, obj) {
  await fs.writeFile(filepath, JSON.stringify(obj, null, 2));
}

function userKey(userId) {
  return String(userId);
}

function niceUser(u) {
  return u?.displayName || u?.username || u?.id || 'unknown';
}

/** Trade shape:
 * id, status, createdAt, updatedAt, expiresAt
 * a: { id, displayName, offered: string[], ready: boolean, accepted: boolean }
 * b: { id, displayName, offered: string[], ready: boolean, accepted: boolean }
 */
function newTrade(a, b) {
  const id = shortId(10);
  const t = {
    id,
    status: 'OPEN',
    createdAt: now(),
    updatedAt: now(),
    expiresAt: now() + minutes(TTL_MIN),
    a: { id: userKey(a.id), displayName: a.displayName, offered: [], ready: false, accepted: false },
    b: { id: userKey(b.id), displayName: b.displayName, offered: [], ready: false, accepted: false }
  };
  return t;
}

function isParticipant(t, uid) {
  const k = userKey(uid);
  return t.a.id === k || t.b.id === k;
}

function sideOf(t, uid) {
  const k = userKey(uid);
  if (t.a.id === k) return 'a';
  if (t.b.id === k) return 'b';
  return null;
}

function otherSide(s) { return s === 'a' ? 'b' : 'a'; }

async function loadTrades() {
  const db = await readJSON(TRADES_PATH);
  return db;
}

async function saveTrades(db) {
  await writeJSON(TRADES_PATH, db);
}

async function findActiveTradeForUser(uid) {
  const db = await loadTrades();
  const list = Object.values(db.active || {});
  const k = userKey(uid);
  for (const t of list) {
    if ((t.a.id === k || t.b.id === k) && (t.status === 'OPEN' || t.status === 'READY' || t.status === 'LOCKED')) {
      return t;
    }
  }
  return null;
}

async function setTrade(t) {
  const db = await loadTrades();
  db.active ||= {};
  db.active[t.id] = t;
  await saveTrades(db);
  return t;
}

async function removeTrade(tradeId) {
  const db = await loadTrades();
  if (db.active && db.active[tradeId]) {
    delete db.active[tradeId];
  }
  await saveTrades(db);
}

function renderOfferLine(mon) {
  const parts = [];
  parts.push(mon.iid ? `[#${mon.iid}]` : '[#????]');
  parts.push(mon.name || mon.species || mon.title || 'Unknown');
  if (typeof mon.level !== 'undefined') parts.push(`Lv.${mon.level}`);
  if (mon.rarity) parts.push(`(${mon.rarity})`);
  return parts.join(' ');
}

function renderTradeSummary(t, invA, invB) {
  const aLines = t.a.offered.map(iid => {
    const m = invA.find(x => x.iid === iid) || invB.find(x => x.iid === iid) || { iid, name: '??' };
    return `• ${renderOfferLine(m)}`;
  });
  const bLines = t.b.offered.map(iid => {
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

async function expireOldTrades() {
  const db = await loadTrades();
  const nowTs = Date.now();
  let changed = false;
  for (const t of Object.values(db.active || {})) {
    if (t.expiresAt && nowTs > t.expiresAt && (t.status === 'OPEN' || t.status === 'READY' || t.status === 'LOCKED')) {
      t.status = 'EXPIRED';
      changed = true;
    }
  }
  if (changed) await saveTrades(db);
}

/** Public: call periodically (e.g., setInterval(expireTick, 30000)) */
export async function expireTick() {
  await expireOldTrades();
}

/** Start a trade (or returns existing open one for the user) */
export async function startTrade({ fromUser, toUser }) {
  let existing = await findActiveTradeForUser(fromUser.id);
  if (existing) return existing;

  const t = newTrade(
    { id: fromUser.id, displayName: fromUser.displayName || fromUser.username },
    { id: toUser.id, displayName: toUser.displayName || toUser.username }
  );
  await setTrade(t);
  return t;
}

/** Add/rem a mon instance to current user's offer */
export async function addOffer({ user, monIid }) {
  const t = await findActiveTradeForUser(user.id);
  if (!t) throw new Error('No active trade. Start one with !trade @user');

  const side = sideOf(t, user.id);
  if (!side) throw new Error('You are not part of this trade.');

  // Reset readiness/accept on modification
  t.a.ready = t.b.ready = false;
  t.a.accepted = t.b.accepted = false;

  // Validate ownership and lock availability
  const inv = await Inventory.getUserMons(user.id);
  const mon = inv.find(m => m.iid === monIid);
  if (!mon) throw new Error(`You do not own a mon with id ${monIid}.`);
  if (mon.lockedBy && mon.lockedBy !== t.id) {
    throw new Error(`That mon is locked by another trade/action.`);
  }

  if (!t[side].offered.includes(monIid)) t[side].offered.push(monIid);
  t.updatedAt = Date.now();
  await setTrade(t);
  return t;
}

export async function removeOffer({ user, monIid }) {
  const t = await findActiveTradeForUser(user.id);
  if (!t) throw new Error('No active trade.');
  const side = sideOf(t, user.id);
  if (!side) throw new Error('You are not part of this trade.');

  t[side].offered = t[side].offered.filter(i => i !== monIid);
  t.a.ready = t.b.ready = false;
  t.a.accepted = t.b.accepted = false;
  t.updatedAt = Date.now();
  await setTrade(t);
  return t;
}

export async function showTrade({ user }) {
  const t = await findActiveTradeForUser(user.id);
  if (!t) throw new Error('No active trade.');
  const invA = await Inventory.getUserMons(t.a.id);
  const invB = await Inventory.getUserMons(t.b.id);
  return renderTradeSummary(t, invA, invB);
}

export async function setReady({ user, ready }) {
  const t = await findActiveTradeForUser(user.id);
  if (!t) throw new Error('No active trade.');
  const side = sideOf(t, user.id);
  t[side].ready = !!ready;
  // un-confirm if anything changes
  t.a.accepted = t.b.accepted = false;

  if (t.a.ready && t.b.ready) {
    t.status = 'READY';
    // Lock offered mons
    for (const iid of t.a.offered) await Inventory.lockMon(t.a.id, iid, t.id);
    for (const iid of t.b.offered) await Inventory.lockMon(t.b.id, iid, t.id);
  } else {
    t.status = 'OPEN';
    // Unlock any previously locked
    await Inventory.unlockAllForTrade(t.id);
  }
  t.updatedAt = Date.now();
  await setTrade(t);
  const invA = await Inventory.getUserMons(t.a.id);
  const invB = await Inventory.getUserMons(t.b.id);
  return renderTradeSummary(t, invA, invB);
}

export async function accept({ user }) {
  const t = await findActiveTradeForUser(user.id);
  if (!t) throw new Error('No active trade.');
  if (t.status !== 'READY' && t.status !== 'LOCKED') throw new Error('Both sides must be READY first.');

  t.status = 'LOCKED';
  const side = sideOf(t, user.id);
  t[side].accepted = true;
  t.updatedAt = Date.now();
  await setTrade(t);

  if (t.a.accepted && t.b.accepted) {
    // Execute swap atomically
    await Inventory.transferMons(t.a.id, t.b.id, t.a.offered, t.id);
    await Inventory.transferMons(t.b.id, t.a.id, t.b.offered, t.id);
    await Inventory.unlockAllForTrade(t.id);
    t.status = 'COMPLETE';
    t.updatedAt = Date.now();
    await setTrade(t);
  }
  const invA = await Inventory.getUserMons(t.a.id);
  const invB = await Inventory.getUserMons(t.b.id);
  return renderTradeSummary(t, invA, invB);
}

export async function cancel({ user, reason = 'cancelled' }) {
  const t = await findActiveTradeForUser(user.id);
  if (!t) throw new Error('No active trade.');
  t.status = 'CANCELLED';
  t.updatedAt = Date.now();
  await Inventory.unlockAllForTrade(t.id);
  await setTrade(t);
  return `Trade #${t.id} ${reason}.`;
}

/**
 * Minimal command router glue. Call from your chat handler.
 *
 * Example:
 *   const out = await handleTradeCommand({ actor: { id, username, displayName }, args, lookupUser });
 *   if (out) client.say(channel, out);
 */
export async function handleTradeCommand({ actor, args, lookupUser }) {
  try {
    const sub = (args[0] || '').toLowerCase();

    if (sub.startsWith('@') || sub === 'start') {
      const targetHandle = sub.startsWith('@') ? sub : args[1];
      if (!targetHandle) return 'Usage: !trade @user';
      const toUser = await lookupUser(targetHandle.replace(/^@/, ''));
      if (!toUser) return `Could not find ${targetHandle}.`;
      const t = await startTrade({ fromUser: actor, toUser });
      return `Opened trade #${t.id} with ${toUser.displayName || toUser.username}. Use "!trade add <monId>", "!trade show", "!trade ready", "!trade accept".`;
    }

    if (sub === 'add') {
      const iid = args[1];
      if (!iid) return 'Usage: !trade add <monId>';
      await addOffer({ user: actor, monIid: iid });
      const text = await showTrade({ user: actor });
      return text;
    }

    if (sub === 'remove') {
      const iid = args[1];
      if (!iid) return 'Usage: !trade remove <monId>';
      await removeOffer({ user: actor, monIid: iid });
      const text = await showTrade({ user: actor });
      return text;
    }

    if (sub === 'show') {
      return await showTrade({ user: actor });
    }

    if (sub === 'ready') {
      return await setReady({ user: actor, ready: true });
    }

    if (sub === 'unready') {
      return await setReady({ user: actor, ready: false });
    }

    if (sub === 'accept' || sub === 'confirm') {
      return await accept({ user: actor });
    }

    if (sub === 'cancel') {
      return await cancel({ user: actor, reason: 'cancelled by user' });
    }

    return 'Trade commands: !trade @user | add <monId> | remove <monId> | show | ready | unready | accept | cancel';
  } catch (err) {
    return `Trade error: ${err.message}`;
  }
}
