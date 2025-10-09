# DroMon Trading (User ↔ User Pokémon Trades)

A lightweight, file-backed trading system with escrow + 2-step confirmation.
Works with Twitch bots (tmi.js) but is UI-agnostic. No external deps.

## What it does

- `!trade @user` opens an escrow between two users.
- Each side `!trade add <monId>` to add specific Pokémon **instances** (by short `iid`).
- `!trade show` to see the current offers.
- `!trade ready` when you’re happy; both sides must be READY to lock items.
- `!trade accept` final confirm from **both** sides. Trade executes atomically.
- `!trade cancel` cancels & unlocks anytime before both accepts.
- Trades auto-expire after `DROMON_TRADE_TTL_MIN` minutes (default 10).

## Files

- `trades.js` — core trading logic & a simple command handler.
- `trade_inventory_adapter.js` — plug your real inventory here (tries a few common paths).
- `trade_inventory_fallback.js` — JSON fallback for quick testing: set `DROMON_INVENTORY_PATH` to your players file.
- `migrate_add_mon_iids.js` — assigns missing `iid` instance ids to your mons if needed.
- `data/` — default folder for `trades.json` and (optionally) `players.json`.

## Quick Start

1) **Copy files** into your bot repo (e.g., `src/dromon/`).  
2) If your mons don’t have per-instance ids visible in `!inv`, run:

```bash
node src/dromon/migrate_add_mon_iids.js
```

   (or set `DROMON_INVENTORY_PATH` to your `players.json` before running).

3) **Wire commands** in your chat handler:

```js
// in your onMessage handler
import { handleTradeCommand, expireTick } from './trades.js';

// call this once on startup to auto-expire old trades
setInterval(() => expireTick().catch(()=>{}), 30_000);

async function lookupUser(handle) {
  // return { id, username, displayName } for @handle; wire to your user system
  return { id: handle.toLowerCase(), username: handle, displayName: handle };
}

if (cmd === 'trade') {
  const out = await handleTradeCommand({
    actor: { id: userstate['user-id'], username: userstate['display-name'] || userstate.username, displayName: userstate['display-name'] || userstate.username },
    args, // e.g., ['@other', ...]
    lookupUser
  });
  if (out) client.say(channel, out);
}
```

4) **Inventory Integration**
- If you already have inventory functions, export any of:
  - `getUserMons(userId)` → `Mon[]`
  - `lockMon(userId, monIid, tradeId)`
  - `unlockAllForTrade(tradeId)`
  - `transferMons(fromId, toId, monIids[], tradeId)`
- Place them in one of:
  - `./pokemon/inventory.js` or `./dromon/inventory.js` or `./inventory.js`
- Otherwise, set `DROMON_INVENTORY_PATH=./data/players.json` to use the JSON fallback.

## Mon Requirements

Each mon object should include:

```js
{
  iid: "A1B2C3D4",      // unique per instance (shown in !inv)
  name: "Charizard",
  level: 34,
  rarity: "rare",
  lockedBy: null        // set by the trading system during escrow
}
```

## Anti-Scam / Safety

- Changing offers resets both players’ READY/ACCEPT states.
- When both sides READY, offered mons are **locked** (cannot be traded/used).
- Final **accept** required from both sides before the swap executes.
- Trades auto-expire; all locks are released.
- `unlockAllForTrade(tradeId)` is always called on cancel/expire/complete.

## Env Vars

```
DROMON_TRADES_PATH=./data/trades.json
DROMON_TRADE_TTL_MIN=10
DROMON_INVENTORY_PATH=./data/players.json   # (only if using JSON fallback)
```

## Roadmap Options

- Multi-item adds (`!trade add <id1,id2,id3>`)
- Trade tax / fee
- Minimum account age checks
- Activity logs & mod overrides
- Trade request DMs / whispers instead of chat spam
