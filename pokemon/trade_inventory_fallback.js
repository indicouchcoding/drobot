/**
 * JSON Fallback Inventory for DroMon Trading (ESM)
 * ------------------------------------------------
 * Minimal file-backed inventory so trading works without wiring.
 * Intended as a bridge until you connect your real inventory.
 *
 * Env:
 *   DROMON_INVENTORY_PATH=./data/players.json
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INV_PATH = process.env.DROMON_INVENTORY_PATH
  ? path.resolve(process.cwd(), process.env.DROMON_INVENTORY_PATH)
  : path.join(__dirname, 'data', 'players.json');

async function ensureFile(filepath, fallback = {}) {
  try {
    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.access(filepath);
  } catch {
    await fs.writeFile(filepath, JSON.stringify(fallback, null, 2));
  }
}

async function readJSON(filepath) {
  await ensureFile(filepath, {});
  const raw = await fs.readFile(filepath, 'utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

async function writeJSON(filepath, obj) {
  await fs.writeFile(filepath, JSON.stringify(obj, null, 2));
}

function shortId(n = 8) {
  return crypto.randomBytes(8).toString('base64url').slice(0, n);
}

function userKey(uid) { return String(uid); }

/** Get mons array for a user, inserting empty if missing */
export async function getUserMons(uid) {
  const db = await readJSON(INV_PATH);
  const k = userKey(uid);
  const user = db[k] ||= { mons: [] };
  for (const m of user.mons) {
    if (!m.iid) m.iid = shortId(8);
  }
  await writeJSON(INV_PATH, db);
  return user.mons;
}

export async function lockMon(uid, iid, tradeId) {
  const db = await readJSON(INV_PATH);
  const k = userKey(uid);
  const user = db[k];
  if (!user) throw new Error('User not found.');
  const mon = (user.mons || []).find(m => m.iid === iid);
  if (!mon) throw new Error('Mon not found.');
  if (mon.lockedBy && mon.lockedBy !== tradeId) throw new Error('Already locked by another trade.');
  mon.lockedBy = tradeId;
  await writeJSON(INV_PATH, db);
}

export async function unlockAllForTrade(tradeId) {
  const db = await readJSON(INV_PATH);
  for (const user of Object.values(db)) {
    for (const m of (user.mons || [])) {
      if (m.lockedBy === tradeId) delete m.lockedBy;
    }
  }
  await writeJSON(INV_PATH, db);
}

/** Transfer mon instances from -> to; assumes they were locked by tradeId */
export async function transferMons(fromId, toId, monIids, tradeId) {
  const db = await readJSON(INV_PATH);
  const A = db[userKey(fromId)];
  const B = db[userKey(toId)] ||= { mons: [] };
  if (!A) throw new Error('From-user not found.');

  const moving = [];
  A.mons = (A.mons || []).filter(m => {
    if (monIids.includes(m.iid)) {
      if (m.lockedBy !== tradeId) throw new Error('Mon is not locked by this trade.');
      delete m.lockedBy;
      moving.push(m);
      return false;
    }
    return true;
  });
  B.mons = (B.mons || []).concat(moving);
  await writeJSON(INV_PATH, db);
}
