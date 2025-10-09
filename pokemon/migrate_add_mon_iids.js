// Assigns missing "iid" instance ids to all mons in your inventory JSON.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INV_PATH = process.env.DROMON_INVENTORY_PATH
  ? path.resolve(process.cwd(), process.env.DROMON_INVENTORY_PATH)
  : path.join(__dirname, 'data', 'players.json');

function shortId(n = 8) {
  return crypto.randomBytes(8).toString('base64url').slice(0, n);
}

async function run() {
  try {
    const raw = await fs.readFile(INV_PATH, 'utf8').catch(() => '{}');
    const db = JSON.parse(raw || '{}');
    let added = 0;
    for (const user of Object.values(db)) {
      for (const m of (user.mons || [])) {
        if (!m.iid) { m.iid = shortId(8); added++; }
      }
    }
    await fs.mkdir(path.dirname(INV_PATH), { recursive: true });
    await fs.writeFile(INV_PATH, JSON.stringify(db, null, 2));
    console.log(`Migration complete. Added ${added} instance ids.`);
  } catch (e) {
    console.error('Migration failed:', e);
    process.exitCode = 1;
  }
}
run();
