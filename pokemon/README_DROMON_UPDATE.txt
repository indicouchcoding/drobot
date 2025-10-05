DroMon update (batch reveal + odds + robust paths)

Files included:
- pokemon/dromon.js  (drop-in replacement)

What's new:
- Paths resolved relative to file; or override with DROMON_DATA_DIR / DROMON_DEX_FILE
- Catch odds tunable via env (CATCH_RATE_SCALE, MIN_CATCH, MAX_CATCH, SHINY_CATCH_PENALTY, BONUS_*)
- Batch reveal: throws are recorded silently; who caught is announced at despawn
- Strong mod/broadcaster check; clearer messages
- Intro command: !dromon (with !monhelp shorthand)
- Auto-despawn heartbeat + scan countdown

Typical env (Render):
PREFIX=! 
TWITCH_CHANNELS=#yourchannel
SPAWN_INTERVAL_SEC=300
SPAWN_DESPAWN_SEC=180
SHINY_RATE_DENOM=1024
# Optional odds tuning
CATCH_RATE_SCALE=255
MIN_CATCH=0.02
MAX_CATCH=0.95
SHINY_CATCH_PENALTY=0.75
BONUS_POKEBALL=1
BONUS_GREATBALL=1.5
BONUS_ULTRABALL=2
# Optional paths
# DROMON_DATA_DIR=/opt/render/project/src/pokemon/data
# DROMON_DEX_FILE=/opt/render/project/src/pokemon/data/mondex.json
