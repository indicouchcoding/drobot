// Optional helper. If you import these into dromon.js and call the functions,
// your overlay images/state will update without editing many lines.
//
// Usage in dromon.js (top):
//   import { updateOverlay, clearOverlay, OVERLAY_DIR, ensureOverlayDirs } from './overlay-helpers.js';
//   ensureOverlayDirs();
// Then in spawnOne(): updateOverlay(mon, isShiny, SPRITES_DIR);
// And in endSpawn(): clearOverlay();
//
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const OVERLAY_DIR = new URL('./data/overlay/', import.meta.url).pathname;
export const OVERLAY_IMG = join(OVERLAY_DIR, 'current.png');
export const OVERLAY_STATE = join(OVERLAY_DIR, 'current.json');

export function ensureOverlayDirs() {
  if (!existsSync(OVERLAY_DIR)) mkdirSync(OVERLAY_DIR, { recursive: true });
}

export function updateOverlay(mon, shiny, SPRITES_DIR) {
  try {
    ensureOverlayDirs();
    const name = String(mon.id).padStart(3,'0') + '.png';
    const src = join(SPRITES_DIR, name); // adjust if shinies are in subfolder
    if (existsSync(src)) copyFileSync(src, OVERLAY_IMG);
    writeFileSync(OVERLAY_STATE, JSON.stringify({
      active: true, id: mon.id, name: mon.name, shiny: !!shiny, rarity: mon.rarity, ts: Date.now()
    }));
  } catch (e) {
    console.warn('[overlay] update failed:', e?.message || e);
  }
}

export function clearOverlay() {
  try {
    ensureOverlayDirs();
    writeFileSync(OVERLAY_STATE, JSON.stringify({ active:false, ts: Date.now() }));
  } catch {}
}
