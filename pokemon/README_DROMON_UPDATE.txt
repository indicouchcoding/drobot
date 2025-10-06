DroMon update: spawn fix + percent catch-rate support
- Keeps previous improvements (persistent saves, migration, hintless spawns, !throw aliases/defaults, forced spawn resets timer)
- NEW: CATCH_RATE_MODE supports 'percent' for your Dex (e.g., 1.1923 = 1.1923% base)
Env suggestions (Render -> Environment):
  CATCH_RATE_MODE=percent
  MIN_CATCH=0.08
  MAX_CATCH=0.90
  BONUS_GREATBALL=1.8
  BONUS_ULTRABALL=2.4
  SHINY_CATCH_PENALTY=0.6
Tips:
- Fix any monsters with empty rarity strings ("") to a real bucket (Common/Uncommon/Rare/Epic/Legendary) so spawns pull them.
- Use !dexreload (mods) after editing the dex file to hot-reload without redeploying.
