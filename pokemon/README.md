
# DroMon pack (types + pretty !dex)

This pack includes:
- `dromon.js` — drop-in replacement that:
  - Shows a pretty `!dex` summary grouped by type with emojis.
  - Adds `!dex list <type>` to list your caught mons of a given type.
  - Adds `!fixtypes` (mods/broadcaster) to backfill canonical types into your dex (1–493) using PokéAPI.
- `enrich_types.mjs` — a one-off script to add `"types": ["Fire", "Flying"]` etc. into your existing `data/mondex.json` **in-place**.

## How to use
1) Replace your existing `dromon.js` with this one.
2) Keep using your current `data/mondex.json` (the one you pasted me with ids 1–493).
3) Either:
   - Run `node enrich_types.mjs` once to permanently add canonical `types` to `mondex.json`, **or**
   - Just run the bot and use `!fixtypes` (mods only). It will fill missing types and save them.

> Node 18+ is recommended (for global `fetch`).

### Commands added
- `!dex` → `Dex 123/493 • ✨7 • Types: 🔥F/💧W:12 | ...` (emoji shorthand per type; capped to avoid spam)
- `!dex list <type>` → prints your caught mons for that type (e.g., `!dex list fire`)
- `!fixtypes` → backfills types (1–493) from PokéAPI and saves to `mondex.json`

