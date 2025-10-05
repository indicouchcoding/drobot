
# DroMon (Community Creature Game)

Lightweight Twitch chat game inspired by community monster-catching games — **original creatures only** (no Nintendo/IP content). Ready to extend with your own data and overlay hooks.

## What it does
- Spawns a random **wild creature** in chat every X minutes (rarity-weighted).
- Viewers use `!throw pokeball|greatball|ultraball` (names are placeholders; rename if you want) to attempt a catch.
- Shiny chance (default 1/1024). Per-species catch rates + ball bonuses.
- `!dex` shows your personal Dex summary; `!bag` shows ball counts.
- `!daily` grants a small pack of balls.
- Mod tools: `!spawn` to force a spawn, `!giveballs @user 10 ultraball`, `!endspawn` to despawn.

## Commands
- `!mon start` — create your save + receive a starter pack
- `!bag` — see your balls
- `!daily` — claim once per day
- `!dex` — personal summary
- `!throw pokeball` or `!throw greatball` or `!throw ultraball`
- `!scan` — repeats current spawn info
- `!help` — command list

**Mods only**
- `!spawn` — force a spawn now
- `!endspawn` — despawn the current wild
- `!giveballs @user 10 ultraball`
- `!setrate shiny 2048` — set shiny rate denominator

## Setup
1. `npm i`
2. Copy `.env.example` → `.env` and set values.
3. `npm run dev`

## Env
- `TWITCH_USERNAME`, `TWITCH_OAUTH` (from https://twitchapps.com/tmi/), `TWITCH_CHANNELS`
- `PREFIX` (default `!`)
- `SPAWN_INTERVAL_SEC` (default 300)
- `SPAWN_DESPAWN_SEC` (default 180)
- `SHINY_RATE_DENOM` (default 1024)

## Notes
- All data is stored in `data/` as JSON. Safe to delete during testing.
- The included `mondex.json` has original example creatures. Replace with your own or expand it.
- Overlay: add a tiny WebSocket server later so spawns pop visually on stream.
