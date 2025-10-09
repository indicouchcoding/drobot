/**
 * Inventory Adapter for DroMon Trading
 * -----------------------------------
 * Wire these functions into your existing inventory system.
 * If you don't have one ready, see trade_inventory_fallback.js (JSON file store)
 *
 * Required Mon shape per user:
 *   { iid: string, name: string, level?: number, rarity?: string, lockedBy?: string|null, ... }
 *
 * Required functions:
 *   - getUserMons(userId): Promise<Mon[]>
 *   - lockMon(userId, monIid, tradeId): Promise<void>
 *   - unlockAllForTrade(tradeId): Promise<void>
 *   - transferMons(fromUserId, toUserId, monIids[], tradeId): Promise<void>
 */

const tryPaths = [
  './pokemon/inventory.js',
  './dromon/inventory.js',
  './inventory.js',
];

let real = null;
for (const p of tryPaths) {
  try {
    real = await import(p);
    break;
  } catch {}
}

if (real) {
  export const getUserMons = real.getUserMons || (async (uid) => real.getUserInventory(uid)?.mons ?? []);
  export const lockMon = real.lockMon || (async (uid, iid, tradeId) => {
    if (real.lockMon) return real.lockMon(uid, iid, tradeId);
    if (real.setMonFlag) return real.setMonFlag(uid, iid, 'lockedBy', tradeId);
  });
  export const unlockAllForTrade = real.unlockAllForTrade || (async (tradeId) => {
    if (real.unlockAllForTrade) return real.unlockAllForTrade(tradeId);
    if (real.sweepUnlockTrade) return real.sweepUnlockTrade(tradeId);
  });
  export const transferMons = real.transferMons || (async (fromId, toId, monIids, tradeId) => {
    if (real.transferMons) return real.transferMons(fromId, toId, monIids, tradeId);
    throw new Error('transferMons not implemented in your inventory module.');
  });
} else {
  const fb = await import('./trade_inventory_fallback.js');
  export const getUserMons = fb.getUserMons;
  export const lockMon = fb.lockMon;
  export const unlockAllForTrade = fb.unlockAllForTrade;
  export const transferMons = fb.transferMons;
}
