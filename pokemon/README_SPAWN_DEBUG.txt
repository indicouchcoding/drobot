DroMon spawn-debug + percent-catch update

What’s in this drop:
- Hardened Dex loader with clear reasons (missing/empty/parse/no_monsters)
- randomMonster() auto-reloads Dex + logs if a rarity pool is empty; falls back to any mon
- New chat debug: !dexpath, !spawncheck (mods only)
- Better !spawn skip message (shows monster count + reason)
- Hintless spawn/scan lines, TwitchLit copy
- Throw aliases + default (!setthrow), persistent saves, forced-spawn resets timer
- Percent-based catch rates supported via CATCH_RATE_MODE=percent

Render env you’ll probably want:
  DROMON_DEX_FILE=/opt/render/project/src/pokemon/data/mondex.json
  DROMON_DATA_DIR=/var/data/dromon
  CATCH_RATE_MODE=percent
  MIN_CATCH=0.08
  MAX_CATCH=0.90
  BONUS_GREATBALL=1.8
  BONUS_ULTRABALL=2.4
  SHINY_CATCH_PENALTY=0.6

After deploy, sanity check in chat:
  !dexpath       -> prints path
  !dexreload     -> reloads file
  !spawncheck    -> shows monster count + weights + sample names
  !spawn         -> should announce spawn or tell you why it skipped
