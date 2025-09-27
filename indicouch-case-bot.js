/*
Dro_bot_ — CS2 Case-Opening Chatbot (tmi.js)
Author: Indicouchgaming/Indicouchcoding

STREAM-READY • Anti-dup • Pricing • Multi-channel inventories with migration
- CS2-style odds & wear, price checks (Skinport + optional CSFloat)
- Fuzzy !price + !price last
- Cases: CS:GO Weapon Case, Operation Breakout Weapon Case, Fever Case, Glove Case,
         Prisma 2, Dreams & Nightmares, Fracture, Gamma 2 Case, eSports 2013 Winter Case,
         Shattered Web Case, Gamma Case, Operation Bravo Case
- Inventories are now namespaced per channel:  "<channel>:<username>"
  • Legacy-friendly: reads old keys and migrates them automatically on first touch
  • Mod command `!migrateinv` bulk-migrates all legacy keys for the current channel
- Minimal HTTP server for Render health/backup

Quick start
1) npm i tmi.js dotenv
2) .env → TWITCH_USERNAME, TWITCH_OAUTH, TWITCH_CHANNEL, BOT_PREFIX=!,
            PRICE_PROVIDER=best_of, PRICE_CURRENCY=USD, CSFLOAT_API_KEY=(optional),
            DATA_DIR=/var/data/indicouch (if using disk)
3) node indicouch-case-bot.js
*/

import fs from 'fs';
import path from 'path';
import tmi from 'tmi.js';
import dotenv from 'dotenv';
import http from 'http';
import { getCurrentSong, fmtTime } from './lib/spotify.js';
dotenv.config();

// ----------------- Instance + Anti-dup -----------------
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

// Prefer Twitch message id; fallback to fingerprint(user+room+message)
const SEEN_IDS = new Set();
const SEEN_FPS = new Map(); // key -> ts
function fp(tags, message) {
  const u = (tags['user-id'] || tags.username || '').toString();
  const r = (tags['room-id'] || '').toString();
  const m = (message || '').trim().toLowerCase();
  return `${u}|${r}|${m}`;
}
function alreadyHandled(tags, message) {
  const id = tags && (tags['id'] || tags.id);
  if (id) {
    if (SEEN_IDS.has(id)) return true;
    SEEN_IDS.add(id);
    setTimeout(() => SEEN_IDS.delete(id), 5 * 60 * 1000);
    return false;
  }
  const key = fp(tags, message);
  const now = Date.now();
  const last = SEEN_FPS.get(key) || 0;
  if (now - last < 6000) return true;
  SEEN_FPS.set(key, now);
  setTimeout(() => SEEN_FPS.delete(key), 10 * 60 * 1000);
  return false;
}

// Optional admin controls for backup endpoint
const ADMIN_KEY = process.env.ADMIN_KEY || null; // set to any secret string
const PUBLIC_URL = process.env.PUBLIC_URL || null; // e.g., https://your-service.onrender.com

// ----------------- Config -----------------
const CONFIG = {
  prefix: process.env.BOT_PREFIX || '!',
  defaultCaseKey: 'Prisma 2 Case',
  maxOpensPerCommand: 5,         // your current setting
  stattrakChance: 0.10,           // 10%
  souvenirChance: 0.00,           // regular cases: 0
  wearTiers: [
    { key: 'Factory New',  short: 'FN', p: 0.03,  float: [0.00, 0.07] },
    { key: 'Minimal Wear', short: 'MW', p: 0.07,  float: [0.07, 0.15] },
    { key: 'Field-Tested', short: 'FT', p: 0.38,  float: [0.15, 0.38] },
    { key: 'Well-Worn',    short: 'WW', p: 0.38,  float: [0.38, 0.45] },
    { key: 'Battle-Scarred', short: 'BS', p: 0.14, float: [0.45, 1.00] },
  ],
  rarities: [
    { key: 'Gold',   color: '★',          p: 0.0026 }, // 0.26%
    { key: 'Red',    color: 'Covert',     p: 0.0064 }, // 0.64%
    { key: 'Pink',   color: 'Classified', p: 0.032  },
    { key: 'Purple', color: 'Restricted', p: 0.1598 },
    { key: 'Blue',   color: 'Mil-Spec',   p: 0.7992 },
  ],
};

// ----------------- Cases -----------------
const CASES = {
  // New: CS:GO Weapon Case (classic knives on Gold)
  'CS:GO Weapon Case': {
    Blue: [
      { weapon: 'MP7', name: 'Skulls' },
      { weapon: 'Nova', name: 'Sand Dune' },
      { weapon: 'Glock-18', name: 'Brass' },
      { weapon: 'SG 553', name: 'Ultraviolet' },
      { weapon: 'AUG', name: 'Wings' },
    ],
    Purple: [
      { weapon: 'Desert Eagle', name: 'Hypnotic' },
      { weapon: 'P90', name: 'Blind Spot' },
      { weapon: 'M4A1-S', name: 'Dark Water' },
    ],
    Pink: [
      { weapon: 'AK-47', name: 'Case Hardened' },
      { weapon: 'AWP', name: 'Lightning Strike' },
    ],
    Red: [
      { weapon: 'M4A4', name: 'Asiimov' },
      { weapon: 'AK-47', name: 'Redline' },
    ],
    Gold: [
      // Bayonet
      { weapon: '★ Bayonet', name: 'Fade' },
      { weapon: '★ Bayonet', name: 'Case Hardened' },
      { weapon: '★ Bayonet', name: 'Crimson Web' },
      { weapon: '★ Bayonet', name: 'Slaughter' },
      { weapon: '★ Bayonet', name: 'Night' },
      { weapon: '★ Bayonet', name: 'Blue Steel' },
      { weapon: '★ Bayonet', name: 'Boreal Forest' },
      { weapon: '★ Bayonet', name: 'Stained' },
      { weapon: '★ Bayonet', name: 'Safari Mesh' },
      { weapon: '★ Bayonet', name: 'Scorched' },
      { weapon: '★ Bayonet', name: 'Urban Masked' },
      // Flip
      { weapon: '★ Flip Knife', name: 'Fade' },
      { weapon: '★ Flip Knife', name: 'Case Hardened' },
      { weapon: '★ Flip Knife', name: 'Crimson Web' },
      { weapon: '★ Flip Knife', name: 'Slaughter' },
      { weapon: '★ Flip Knife', name: 'Night' },
      { weapon: '★ Flip Knife', name: 'Blue Steel' },
      { weapon: '★ Flip Knife', name: 'Boreal Forest' },
      { weapon: '★ Flip Knife', name: 'Stained' },
      { weapon: '★ Flip Knife', name: 'Safari Mesh' },
      { weapon: '★ Flip Knife', name: 'Scorched' },
      { weapon: '★ Flip Knife', name: 'Urban Masked' },
      // Gut
      { weapon: '★ Gut Knife', name: 'Fade' },
      { weapon: '★ Gut Knife', name: 'Case Hardened' },
      { weapon: '★ Gut Knife', name: 'Crimson Web' },
      { weapon: '★ Gut Knife', name: 'Slaughter' },
      { weapon: '★ Gut Knife', name: 'Night' },
      { weapon: '★ Gut Knife', name: 'Blue Steel' },
      { weapon: '★ Gut Knife', name: 'Boreal Forest' },
      { weapon: '★ Gut Knife', name: 'Stained' },
      { weapon: '★ Gut Knife', name: 'Safari Mesh' },
      { weapon: '★ Gut Knife', name: 'Scorched' },
      { weapon: '★ Gut Knife', name: 'Urban Masked' },
      // Karambit
      { weapon: '★ Karambit', name: 'Fade' },
      { weapon: '★ Karambit', name: 'Case Hardened' },
      { weapon: '★ Karambit', name: 'Crimson Web' },
      { weapon: '★ Karambit', name: 'Slaughter' },
      { weapon: '★ Karambit', name: 'Night' },
      { weapon: '★ Karambit', name: 'Blue Steel' },
      { weapon: '★ Karambit', name: 'Boreal Forest' },
      { weapon: '★ Karambit', name: 'Stained' },
      { weapon: '★ Karambit', name: 'Safari Mesh' },
      { weapon: '★ Karambit', name: 'Scorched' },
      { weapon: '★ Karambit', name: 'Urban Masked' },
      // M9
      { weapon: '★ M9 Bayonet', name: 'Fade' },
      { weapon: '★ M9 Bayonet', name: 'Case Hardened' },
      { weapon: '★ M9 Bayonet', name: 'Crimson Web' },
      { weapon: '★ M9 Bayonet', name: 'Slaughter' },
      { weapon: '★ M9 Bayonet', name: 'Night' },
      { weapon: '★ M9 Bayonet', name: 'Blue Steel' },
      { weapon: '★ M9 Bayonet', name: 'Boreal Forest' },
      { weapon: '★ M9 Bayonet', name: 'Stained' },
      { weapon: '★ M9 Bayonet', name: 'Safari Mesh' },
      { weapon: '★ M9 Bayonet', name: 'Scorched' },
      { weapon: '★ M9 Bayonet', name: 'Urban Masked' },
    ],
  },

  // New: Operation Breakout Weapon Case (Butterfly knives on Gold)
  'Operation Breakout Weapon Case': {
    Blue: [
      { weapon: 'PP-Bizon', name: 'Osiris' },
      { weapon: 'UMP-45', name: 'Labyrinth' },
      { weapon: 'P2000', name: 'Ivory' },
      { weapon: 'Nova', name: 'Koi' },
      { weapon: 'Negev', name: 'Desert-Strike' },
    ],
    Purple: [
      { weapon: 'P90', name: 'Asiimov' },
      { weapon: 'CZ75-Auto', name: 'Tigris' },
      { weapon: 'Five-SeveN', name: 'Fowl Play' },
    ],
    Pink: [
      { weapon: 'M4A1-S', name: 'Cyrex' },
      { weapon: 'Glock-18', name: 'Water Elemental' },
    ],
    Red: [
      { weapon: 'Desert Eagle', name: 'Conspiracy' },
      { weapon: 'P90', name: 'Trigon' },
    ],
    Gold: [
      { weapon: '★ Butterfly Knife', name: 'Fade' },
      { weapon: '★ Butterfly Knife', name: 'Case Hardened' },
      { weapon: '★ Butterfly Knife', name: 'Crimson Web' },
      { weapon: '★ Butterfly Knife', name: 'Slaughter' },
      { weapon: '★ Butterfly Knife', name: 'Night' },
      { weapon: '★ Butterfly Knife', name: 'Blue Steel' },
      { weapon: '★ Butterfly Knife', name: 'Boreal Forest' },
      { weapon: '★ Butterfly Knife', name: 'Stained' },
      { weapon: '★ Butterfly Knife', name: 'Safari Mesh' },
      { weapon: '★ Butterfly Knife', name: 'Scorched' },
      { weapon: '★ Butterfly Knife', name: 'Urban Masked' },
    ],
  },

  // New: Fever Case (classic knives on Gold)
  'Fever Case': {
    Blue: [
      { weapon: 'MP9', name: 'Goo' },
      { weapon: 'MAC-10', name: 'Last Dive' },
      { weapon: 'FAMAS', name: 'Pulse' },
      { weapon: 'CZ75-Auto', name: 'Tacticat' },
      { weapon: 'XM1014', name: 'Bone Machine' },
    ],
    Purple: [
      { weapon: 'SSG 08', name: 'Fever Dream' },
      { weapon: 'UMP-45', name: 'Primal Saber' },
      { weapon: 'P250', name: 'Asiimov' },
    ],
    Pink: [
      { weapon: 'AK-47', name: 'Fever Dream' },
      { weapon: 'M4A1-S', name: 'Decimator' },
    ],
    Red: [
      { weapon: 'AWP', name: 'Hyper Beast' },
      { weapon: 'Desert Eagle', name: 'Blaze' },
    ],
    Gold: [
      // reuse classic knives
      { weapon: '★ Bayonet', name: 'Fade' },
      { weapon: '★ Bayonet', name: 'Case Hardened' },
      { weapon: '★ Bayonet', name: 'Crimson Web' },
      { weapon: '★ Bayonet', name: 'Slaughter' },
      { weapon: '★ Bayonet', name: 'Night' },
      { weapon: '★ Bayonet', name: 'Blue Steel' },
      { weapon: '★ Bayonet', name: 'Boreal Forest' },
      { weapon: '★ Bayonet', name: 'Stained' },
      { weapon: '★ Bayonet', name: 'Safari Mesh' },
      { weapon: '★ Bayonet', name: 'Scorched' },
      { weapon: '★ Bayonet', name: 'Urban Masked' },
      { weapon: '★ Flip Knife', name: 'Fade' },
      { weapon: '★ Flip Knife', name: 'Case Hardened' },
      { weapon: '★ Flip Knife', name: 'Crimson Web' },
      { weapon: '★ Flip Knife', name: 'Slaughter' },
      { weapon: '★ Flip Knife', name: 'Night' },
      { weapon: '★ Flip Knife', name: 'Blue Steel' },
      { weapon: '★ Flip Knife', name: 'Boreal Forest' },
      { weapon: '★ Flip Knife', name: 'Stained' },
      { weapon: '★ Flip Knife', name: 'Safari Mesh' },
      { weapon: '★ Flip Knife', name: 'Scorched' },
      { weapon: '★ Flip Knife', name: 'Urban Masked' },
      { weapon: '★ Gut Knife', name: 'Fade' },
      { weapon: '★ Gut Knife', name: 'Case Hardened' },
      { weapon: '★ Gut Knife', name: 'Crimson Web' },
      { weapon: '★ Gut Knife', name: 'Slaughter' },
      { weapon: '★ Gut Knife', name: 'Night' },
      { weapon: '★ Gut Knife', name: 'Blue Steel' },
      { weapon: '★ Gut Knife', name: 'Boreal Forest' },
      { weapon: '★ Gut Knife', name: 'Stained' },
      { weapon: '★ Gut Knife', name: 'Safari Mesh' },
      { weapon: '★ Gut Knife', name: 'Scorched' },
      { weapon: '★ Gut Knife', name: 'Urban Masked' },
      { weapon: '★ Karambit', name: 'Fade' },
      { weapon: '★ Karambit', name: 'Case Hardened' },
      { weapon: '★ Karambit', name: 'Crimson Web' },
      { weapon: '★ Karambit', name: 'Slaughter' },
      { weapon: '★ Karambit', name: 'Night' },
      { weapon: '★ Karambit', name: 'Blue Steel' },
      { weapon: '★ Karambit', name: 'Boreal Forest' },
      { weapon: '★ Karambit', name: 'Stained' },
      { weapon: '★ Karambit', name: 'Safari Mesh' },
      { weapon: '★ Karambit', name: 'Scorched' },
      { weapon: '★ Karambit', name: 'Urban Masked' },
      { weapon: '★ M9 Bayonet', name: 'Fade' },
      { weapon: '★ M9 Bayonet', name: 'Case Hardened' },
      { weapon: '★ M9 Bayonet', name: 'Crimson Web' },
      { weapon: '★ M9 Bayonet', name: 'Slaughter' },
      { weapon: '★ M9 Bayonet', name: 'Night' },
      { weapon: '★ M9 Bayonet', name: 'Blue Steel' },
      { weapon: '★ M9 Bayonet', name: 'Boreal Forest' },
      { weapon: '★ M9 Bayonet', name: 'Stained' },
      { weapon: '★ M9 Bayonet', name: 'Safari Mesh' },
      { weapon: '★ M9 Bayonet', name: 'Scorched' },
      { weapon: '★ M9 Bayonet', name: 'Urban Masked' },
    ],
  },

  // New: Glove Case (GOLD = Gloves)
  'Glove Case': {
    Blue: [
      { weapon: 'CZ75-Auto', name: 'Polymer' },
      { weapon: 'G3SG1', name: 'Stinger' },
      { weapon: 'MP7', name: 'Cirrus' },
      { weapon: 'Nova', name: 'Gila' },
      { weapon: 'P2000', name: 'Turf' },
    ],
    Purple: [
      { weapon: 'Galil AR', name: 'Black Sand' },
      { weapon: 'M4A4', name: 'Buzz Kill' },
      { weapon: 'Sawed-Off', name: 'Wasteland Princess' },
    ],
    Pink: [
      { weapon: 'FAMAS', name: 'Mecha Industries' },
      { weapon: 'P90', name: 'Shallow Grave' },
    ],
    Red: [
      { weapon: 'SSG 08', name: 'Dragonfire' },
      { weapon: 'PP-Bizon', name: 'Judgement of Anubis' },
    ],
    Gold: [
      { weapon: '★ Sport Gloves',       name: 'Pandora’s Box' },
      { weapon: '★ Sport Gloves',       name: 'Vice' },
      { weapon: '★ Sport Gloves',       name: 'Hedge Maze' },
      { weapon: '★ Sport Gloves',       name: 'Amphibious' },
      { weapon: '★ Specialist Gloves',  name: 'Crimson Kimono' },
      { weapon: '★ Specialist Gloves',  name: 'Emerald Web' },
      { weapon: '★ Specialist Gloves',  name: 'Fade' },
      { weapon: '★ Specialist Gloves',  name: 'Forest DDPAT' },
      { weapon: '★ Hand Wraps',         name: 'Cobalt Skulls' },
      { weapon: '★ Hand Wraps',         name: 'Leather' },
      { weapon: '★ Hand Wraps',         name: 'Overprint' },
      { weapon: '★ Hand Wraps',         name: 'Slaughter' },
      { weapon: '★ Moto Gloves',        name: 'Spearmint' },
      { weapon: '★ Moto Gloves',        name: 'Cool Mint' },
      { weapon: '★ Moto Gloves',        name: 'Boom!' },
      { weapon: '★ Moto Gloves',        name: 'Polygon' },
      { weapon: '★ Driver Gloves',      name: 'King Snake' },
      { weapon: '★ Driver Gloves',      name: 'Lunar Weave' },
      { weapon: '★ Driver Gloves',      name: 'Diamondback' },
      { weapon: '★ Driver Gloves',      name: 'Convoy' },
    ],
  },

  // Existing: Prisma 2
  'Prisma 2 Case': {
    Blue: [
      { weapon: 'CZ75-Auto', name: 'Distressed' },
      { weapon: 'P2000', name: 'Acid Etched' },
      { weapon: 'SCAR-20', name: 'Enforcer' },
      { weapon: 'SG 553', name: 'Darkwing' },
      { weapon: 'MAC-10', name: 'Disco Tech' },
    ],
    Purple: [
      { weapon: 'R8 Revolver', name: 'Bone Forged' },
      { weapon: 'Desert Eagle', name: 'Blue Ply' },
      { weapon: 'AK-47', name: 'Phantom Disruptor' },
      { weapon: 'Sawed-Off', name: 'Apocalypto' },
    ],
    Pink: [
      { weapon: 'M4A1-S', name: 'Player Two' },
      { weapon: 'Glock-18', name: 'Bullet Queen' },
    ],
    Red: [
      { weapon: 'AUG', name: 'Tom Cat' },
      { weapon: 'SSG 08', name: 'Fever Dream' },
    ],
    Gold: [
      { weapon: '★ Stiletto Knife', name: 'Doppler' },
      { weapon: '★ Nomad Knife', name: 'Marble Fade' },
    ],
  },

  // Existing: Dreams & Nightmares
  'Dreams & Nightmares Case': {
    Blue: [
      { weapon: 'P2000', name: 'Lifted Spirits' },
      { weapon: 'XM1014', name: 'Zombie Offensive' },
      { weapon: 'G3SG1', name: 'Dream Glade' },
      { weapon: 'SCAR-20', name: 'Ensnared' },
      { weapon: 'MP7', name: 'Guerrilla' },
    ],
    Purple: [
      { weapon: 'USP-S', name: 'Ticket to Hell' },
      { weapon: 'MAC-10', name: 'Ensnared' },
      { weapon: 'MAG-7', name: 'Foresight' },
    ],
    Pink: [
      { weapon: 'AK-47', name: 'Nightwish' },
      { weapon: 'MP9', name: 'Starlight Protector' },
    ],
    Red: [
      { weapon: 'MP9', name: 'Food Chain' },
      { weapon: 'M4A1-S', name: 'Night Terror' },
    ],
    Gold: [
      { weapon: '★ Talon Knife', name: 'Gamma Doppler' },
      { weapon: '★ Skeleton Knife', name: 'Case Hardened' },
    ],
  },

  // Existing: Fracture
  'Fracture Case': {
    Blue: [
      { weapon: 'P250', name: 'Cassette' },
      { weapon: 'XM1014', name: 'Entombed' },
      { weapon: 'MP5-SD', name: 'Kitbash' },
      { weapon: 'Negev', name: 'Ultralight' },
    ],
    Purple: [
      { weapon: 'Tec-9', name: 'Brother' },
      { weapon: 'Galil AR', name: 'Connexion' },
      { weapon: 'MAG-7', name: 'Monster Call' },
    ],
    Pink: [
      { weapon: 'M4A4', name: 'Tooth Fairy' },
      { weapon: 'Glock-18', name: 'Vogue' },
    ],
    Red: [
      { weapon: 'Desert Eagle', name: 'Printstream' },
      { weapon: 'AK-47', name: 'Legion of Anubis' },
    ],
    Gold: [
      { weapon: '★ Karambit', name: 'Damascus Steel' },
      { weapon: '★ Bayonet', name: 'Tiger Tooth' },
    ],
  },

  // Gamma 2
  'Gamma 2 Case': {
    Blue: [
      { weapon: 'CZ75-Auto', name: 'Imprint' },
      { weapon: 'Five-SeveN', name: 'Scumbria' },
      { weapon: 'G3SG1', name: 'Ventilator' },
      { weapon: 'Negev', name: 'Dazzle' },
      { weapon: 'P90', name: 'Grim' },
      { weapon: 'UMP-45', name: 'Briefing' },
      { weapon: 'XM1014', name: 'Slipstream' },
    ],
    Purple: [
      { weapon: 'Desert Eagle', name: 'Directive' },
      { weapon: 'Glock-18', name: 'Weasel' },
      { weapon: 'MAG-7', name: 'Petroglyph' },
      { weapon: 'SCAR-20', name: 'Powercore' },
      { weapon: 'SG 553', name: 'Triarch' },
    ],
    Pink: [
      { weapon: 'AUG', name: 'Syd Mead' },
      { weapon: 'MP9', name: 'Airlock' },
      { weapon: 'Tec-9', name: 'Fuel Injector' },
    ],
    Red: [
      { weapon: 'AK-47', name: 'Neon Revolution' },
      { weapon: 'FAMAS', name: 'Roll Cage' },
    ],
    Gold: [
      { weapon: '★ Bayonet', name: 'Lore' },
      { weapon: '★ Bayonet', name: 'Gamma Doppler' },
      { weapon: '★ Bayonet', name: 'Autotronic' },
      { weapon: '★ M9 Bayonet', name: 'Gamma Doppler' },
      { weapon: '★ M9 Bayonet', name: 'Lore' },
      { weapon: '★ Karambit', name: 'Autotronic' },
      { weapon: '★ Karambit', name: 'Freehand' },
      { weapon: '★ Flip Knife', name: 'Bright Water' },
      { weapon: '★ Flip Knife', name: 'Gamma Doppler' },
      { weapon: '★ Gut Knife', name: 'Black Laminate' },
      { weapon: '★ Gut Knife', name: 'Freehand' },
    ],
  },

  // eSports 2013 Winter Case
  'eSports 2013 Winter Case': {
    Blue: [
      { weapon: 'P250', name: 'Steel Disruption' },
      { weapon: 'G3SG1', name: 'Azure Zebra' },
      { weapon: 'Nova', name: 'Ghost Camo' },
      { weapon: 'PP-Bizon', name: 'Water Sigil' },
      { weapon: 'Five-SeveN', name: 'Nightshade' },
      { weapon: 'Galil AR', name: 'Blue Titanium' },
    ],
    Purple: [
      { weapon: 'P90', name: 'Blind Spot' },
      { weapon: 'AK-47', name: 'Blue Laminate' },
    ],
    Pink: [
      { weapon: 'Desert Eagle', name: 'Cobalt Disruption' },
      { weapon: 'AWP', name: 'Electric Hive' },
      { weapon: 'FAMAS', name: 'Afterimage' },
    ],
    Red: [
      { weapon: 'M4A4', name: 'X-Ray' },
    ],
    Gold: [
      { weapon: '★ Bayonet', name: 'Fade' },
      { weapon: '★ Bayonet', name: 'Case Hardened' },
      { weapon: '★ Bayonet', name: 'Crimson Web' },
      { weapon: '★ Flip Knife', name: 'Fade' },
      { weapon: '★ Flip Knife', name: 'Night' },
      { weapon: '★ Gut Knife', name: 'Blue Steel' },
      { weapon: '★ Gut Knife', name: 'Safari Mesh' },
      { weapon: '★ Karambit', name: 'Case Hardened' },
      { weapon: '★ Karambit', name: 'Slaughter' },
      { weapon: '★ M9 Bayonet', name: 'Crimson Web' },
      { weapon: '★ M9 Bayonet', name: 'Urban Masked' },
    ],
  },

  // Shattered Web
  'Shattered Web Case': {
    Blue: [
      { weapon: 'P2000', name: 'Obsidian' },
      { weapon: 'P90', name: 'Verdant Growth' },
      { weapon: 'M249', name: 'Warbird' },
      { weapon: 'SCAR-20', name: 'Torn' },
      { weapon: 'R8 Revolver', name: 'Memento' },
      { weapon: 'SSG 08', name: 'Threat Detected' },
      { weapon: 'Sawed-Off', name: 'Apocalypto' },
    ],
    Purple: [
      { weapon: 'AK-47', name: 'Rat Rod' },
      { weapon: 'AUG', name: 'Arctic Wolf' },
      { weapon: 'PP-Bizon', name: 'Embargo' },
      { weapon: 'MP5-SD', name: 'Acid Wash' },
      { weapon: 'G3SG1', name: 'Black Sand' },
      { weapon: 'Dual Berettas', name: 'Balance' },
      { weapon: 'Nova', name: 'Plume' },
    ],
    Pink: [
      { weapon: 'SSG 08', name: 'Bloodshot' },
      { weapon: 'SG 553', name: 'Colony IV' },
      { weapon: 'Tec-9', name: 'Decimator' },
    ],
    Red: [
      { weapon: 'AWP', name: 'Containment Breach' },
      { weapon: 'MAC-10', name: 'Stalker' },
    ],
    Gold: [
      { weapon: '★ Nomad Knife', name: 'Fade' },
      { weapon: '★ Nomad Knife', name: 'Case Hardened' },
      { weapon: '★ Nomad Knife', name: 'Night Stripe' },
      { weapon: '★ Skeleton Knife', name: 'Crimson Web' },
      { weapon: '★ Skeleton Knife', name: 'Blue Steel' },
      { weapon: '★ Skeleton Knife', name: 'Urban Masked' },
      { weapon: '★ Survival Knife', name: 'Forest DDPAT' },
      { weapon: '★ Survival Knife', name: 'Safari Mesh' },
      { weapon: '★ Survival Knife', name: 'Scorched' },
      { weapon: '★ Paracord Knife', name: 'Stained' },
      { weapon: '★ Paracord Knife', name: 'Case Hardened' },
      { weapon: '★ Paracord Knife', name: 'Fade' },
    ],
  },

  // Gamma Case
  'Gamma Case': {
    Blue: [
      { weapon: 'Five-SeveN', name: 'Violent Daimyo' },
      { weapon: 'Tec-9', name: 'Ice Cap' },
      { weapon: 'P250', name: 'Iron Clad' },
      { weapon: 'MAC-10', name: 'Carnivore' },
      { weapon: 'Nova', name: 'Exo' },
      { weapon: 'SG 553', name: 'Aerial' },
      { weapon: 'PP-Bizon', name: 'Harvester' },
    ],
    Purple: [
      { weapon: 'AWP', name: 'Phobos' },
      { weapon: 'AUG', name: 'Aristocrat' },
      { weapon: 'P90', name: 'Chopper' },
      { weapon: 'R8 Revolver', name: 'Reboot' },
      { weapon: 'Sawed-Off', name: 'Limelight' },
    ],
    Pink: [
      { weapon: 'M4A4', name: 'Desolate Space' },
      { weapon: 'P2000', name: 'Imperial Dragon' },
      { weapon: 'SCAR-20', name: 'Bloodsport' },
    ],
    Red: [
      { weapon: 'M4A1-S', name: 'Mecha Industries' },
      { weapon: 'Glock-18', name: 'Wasteland Rebel' },
    ],
    Gold: [
      // Bayonet
      { weapon: '★ Bayonet', name: 'Gamma Doppler' },
      { weapon: '★ Bayonet', name: 'Lore' },
      { weapon: '★ Bayonet', name: 'Autotronic' },
      { weapon: '★ Bayonet', name: 'Black Laminate' },
      { weapon: '★ Bayonet', name: 'Bright Water' },
      { weapon: '★ Bayonet', name: 'Freehand' },
      // Flip Knife
      { weapon: '★ Flip Knife', name: 'Gamma Doppler' },
      { weapon: '★ Flip Knife', name: 'Lore' },
      { weapon: '★ Flip Knife', name: 'Autotronic' },
      { weapon: '★ Flip Knife', name: 'Black Laminate' },
      { weapon: '★ Flip Knife', name: 'Bright Water' },
      { weapon: '★ Flip Knife', name: 'Freehand' },
      // Gut Knife
      { weapon: '★ Gut Knife', name: 'Gamma Doppler' },
      { weapon: '★ Gut Knife', name: 'Lore' },
      { weapon: '★ Gut Knife', name: 'Autotronic' },
      { weapon: '★ Gut Knife', name: 'Black Laminate' },
      { weapon: '★ Gut Knife', name: 'Bright Water' },
      { weapon: '★ Gut Knife', name: 'Freehand' },
      // Karambit
      { weapon: '★ Karambit', name: 'Gamma Doppler' },
      { weapon: '★ Karambit', name: 'Lore' },
      { weapon: '★ Karambit', name: 'Autotronic' },
      { weapon: '★ Karambit', name: 'Black Laminate' },
      { weapon: '★ Karambit', name: 'Bright Water' },
      { weapon: '★ Karambit', name: 'Freehand' },
      // M9 Bayonet
      { weapon: '★ M9 Bayonet', name: 'Gamma Doppler' },
      { weapon: '★ M9 Bayonet', name: 'Lore' },
      { weapon: '★ M9 Bayonet', name: 'Autotronic' },
      { weapon: '★ M9 Bayonet', name: 'Black Laminate' },
      { weapon: '★ M9 Bayonet', name: 'Bright Water' },
      { weapon: '★ M9 Bayonet', name: 'Freehand' },
    ],
  },

  // Operation Bravo Case
  'Operation Bravo Case': {
    Blue: [
      { weapon: 'SG 553', name: 'Wave Spray' },
      { weapon: 'Nova', name: 'Tempest' },
      { weapon: 'Dual Berettas', name: 'Black Limba' },
      { weapon: 'Galil AR', name: 'Shattered' },
      { weapon: 'G3SG1', name: 'Demeter' },
      { weapon: 'UMP-45', name: 'Bone Pile' },
    ],
    Purple: [
      { weapon: 'M4A1-S', name: 'Bright Water' },
      { weapon: 'USP-S', name: 'Overgrowth' },
      { weapon: 'MAC-10', name: 'Graven' },
      { weapon: 'M4A4', name: 'Zirka' },
    ],
    Pink: [
      { weapon: 'AWP', name: 'Graphite' },
      { weapon: 'P2000', name: 'Ocean Foam' },
      { weapon: 'P90', name: 'Emerald Dragon' },
    ],
    Red: [
      { weapon: 'AK-47', name: 'Fire Serpent' },
      { weapon: 'Desert Eagle', name: 'Golden Koi' },
    ],
    Gold: [
      // classic knife pool
      // Bayonet
      { weapon: '★ Bayonet', name: 'Fade' },
      { weapon: '★ Bayonet', name: 'Case Hardened' },
      { weapon: '★ Bayonet', name: 'Crimson Web' },
      { weapon: '★ Bayonet', name: 'Slaughter' },
      { weapon: '★ Bayonet', name: 'Night' },
      { weapon: '★ Bayonet', name: 'Blue Steel' },
      { weapon: '★ Bayonet', name: 'Boreal Forest' },
      { weapon: '★ Bayonet', name: 'Stained' },
      { weapon: '★ Bayonet', name: 'Safari Mesh' },
      { weapon: '★ Bayonet', name: 'Scorched' },
      { weapon: '★ Bayonet', name: 'Urban Masked' },
      // Flip
      { weapon: '★ Flip Knife', name: 'Fade' },
      { weapon: '★ Flip Knife', name: 'Case Hardened' },
      { weapon: '★ Flip Knife', name: 'Crimson Web' },
      { weapon: '★ Flip Knife', name: 'Slaughter' },
      { weapon: '★ Flip Knife', name: 'Night' },
      { weapon: '★ Flip Knife', name: 'Blue Steel' },
      { weapon: '★ Flip Knife', name: 'Boreal Forest' },
      { weapon: '★ Flip Knife', name: 'Stained' },
      { weapon: '★ Flip Knife', name: 'Safari Mesh' },
      { weapon: '★ Flip Knife', name: 'Scorched' },
      { weapon: '★ Flip Knife', name: 'Urban Masked' },
      // Gut
      { weapon: '★ Gut Knife', name: 'Fade' },
      { weapon: '★ Gut Knife', name: 'Case Hardened' },
      { weapon: '★ Gut Knife', name: 'Crimson Web' },
      { weapon: '★ Gut Knife', name: 'Slaughter' },
      { weapon: '★ Gut Knife', name: 'Night' },
      { weapon: '★ Gut Knife', name: 'Blue Steel' },
      { weapon: '★ Gut Knife', name: 'Boreal Forest' },
      { weapon: '★ Gut Knife', name: 'Stained' },
      { weapon: '★ Gut Knife', name: 'Safari Mesh' },
      { weapon: '★ Gut Knife', name: 'Scorched' },
      { weapon: '★ Gut Knife', name: 'Urban Masked' },
      // Karambit
      { weapon: '★ Karambit', name: 'Fade' },
      { weapon: '★ Karambit', name: 'Case Hardened' },
      { weapon: '★ Karambit', name: 'Crimson Web' },
      { weapon: '★ Karambit', name: 'Slaughter' },
      { weapon: '★ Karambit', name: 'Night' },
      { weapon: '★ Karambit', name: 'Blue Steel' },
      { weapon: '★ Karambit', name: 'Boreal Forest' },
      { weapon: '★ Karambit', name: 'Stained' },
      { weapon: '★ Karambit', name: 'Safari Mesh' },
      { weapon: '★ Karambit', name: 'Scorched' },
      { weapon: '★ Karambit', name: 'Urban Masked' },
      // M9 Bayonet
      { weapon: '★ M9 Bayonet', name: 'Fade' },
      { weapon: '★ M9 Bayonet', name: 'Case Hardened' },
      { weapon: '★ M9 Bayonet', name: 'Crimson Web' },
      { weapon: '★ M9 Bayonet', name: 'Slaughter' },
      { weapon: '★ M9 Bayonet', name: 'Night' },
      { weapon: '★ M9 Bayonet', name: 'Blue Steel' },
      { weapon: '★ M9 Bayonet', name: 'Boreal Forest' },
      { weapon: '★ M9 Bayonet', name: 'Stained' },
      { weapon: '★ M9 Bayonet', name: 'Safari Mesh' },
      { weapon: '★ M9 Bayonet', name: 'Scorched' },
      { weapon: '★ M9 Bayonet', name: 'Urban Masked' },
    ],
  },

};

// ----------------- Persistence -----------------
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data/indicouch' : path.join(process.cwd(), 'data'));
const INV_PATH = path.join(DATA_DIR, 'inventories.json');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const DEFAULTS_PATH = path.join(DATA_DIR, 'defaults.json');

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(INV_PATH)) fs.writeFileSync(INV_PATH, JSON.stringify({}, null, 2));
  if (!fs.existsSync(STATS_PATH)) fs.writeFileSync(STATS_PATH, JSON.stringify({ opens: 0, drops: {} }, null, 2));
  if (!fs.existsSync(DEFAULTS_PATH)) fs.writeFileSync(DEFAULTS_PATH, JSON.stringify({}, null, 2));
}
function loadJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function saveJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// ----------------- RNG + Sim -----------------
function rng() { return Math.random(); }
function weightedPick(items, weightProp = 'p') {
  const r = rng(); let acc = 0; for (const it of items) { acc += it[weightProp]; if (r <= acc) return it; } return items[items.length - 1];
}
function pickWear() { const wear = weightedPick(CONFIG.wearTiers); const [min, max] = wear.float; const fl = +(min + rng() * (max - min)).toFixed(4); return { ...wear, float: fl }; }
function pickRarity() { const rarityPool = [...CONFIG.rarities].reverse(); return weightedPick(rarityPool); }
function pickSkin(caseKey, rarityKey) { const pool = CASES[caseKey]?.[rarityKey] || []; if (!pool.length) return null; return pool[Math.floor(rng() * pool.length)]; }
function rollModifiers() { const stattrak = rng() < CONFIG.stattrakChance; const souvenir = CONFIG.souvenirChance > 0 && rng() < CONFIG.souvenirChance; return { stattrak, souvenir }; }
function openOne(caseKey) {
  const rarity = pickRarity();
  const skin = pickSkin(caseKey, rarity.key);
  const wear = pickWear();
  const { stattrak, souvenir } = rollModifiers();
  return {
    case: caseKey,
    rarity: rarity.key,
    wear: wear.key,
    float: wear.float,
    stattrak,
    souvenir,
    weapon: skin?.weapon || (rarity.key === 'Gold' ? '★' : 'Unknown'),
    name: skin?.name || 'Mystery',
  };
}

// ----------------- Formatting -----------------
function rarityEmoji(rarity) { return rarity==='Gold'?'✨':rarity==='Red'?'🔴':rarity==='Pink'?'💗':rarity==='Purple'?'🟣':'🔵'; }
function formatDrop(drop) {
  const parts=[]; if(drop.souvenir) parts.push('Souvenir'); if(drop.stattrak) parts.push('StatTrak');
  const prefix=parts.length?parts.join(' ')+' ':'';
  const wearShort=(drop.wear||'').split(' ').map(s=>s[0]).join('');
  const price=(typeof drop.priceUSD==='number')?` • $${drop.priceUSD.toFixed(2)}`:'';
  return `${rarityEmoji(drop.rarity)} ${prefix}${drop.weapon} | ${drop.name} (${wearShort} • ${drop.float.toFixed(4)})${price}`;
}

// ----------------- Channel/User key helpers -----------------
function chanName(channel) { return String(channel).replace(/^#/, '').toLowerCase(); }
function nsKey(channel, username) { return `${chanName(channel)}:${String(username).toLowerCase()}`; }
function mergeArrays(a, b) { return [].concat(a || [], b || []); }

// ----------------- Inventories & Stats (with migration) -----------------
function getInventory(userKey) {
  const inv = loadJSON(INV_PATH);

  // New (namespaced) key
  if (inv[userKey]) return inv[userKey];

  // Legacy fallback: move <username> -> <channel:username>
  const legacyKey = userKey.includes(':') ? userKey.split(':')[1] : userKey;
  if (inv[legacyKey]) {
    const merged = mergeArrays(inv[userKey], inv[legacyKey]);
    inv[userKey] = merged;
    delete inv[legacyKey];
    saveJSON(INV_PATH, inv);
    return merged;
  }
  return [];
}

function addToInventory(userKey, drop) {
  const inv = loadJSON(INV_PATH);
  const legacyKey = userKey.includes(':') ? userKey.split(':')[1] : userKey;

  // Fold legacy once
  if (inv[legacyKey]) {
    inv[userKey] = mergeArrays(inv[userKey], inv[legacyKey]);
    delete inv[legacyKey];
  }

  (inv[userKey] ||= []).push(drop);
  saveJSON(INV_PATH, inv);
}

function getAllInventories() { return loadJSON(INV_PATH) || {}; }

function pushStats(drop) {
  const stats=loadJSON(STATS_PATH);
  stats.opens=(stats.opens||0)+1;
  stats.drops=stats.drops||{};
  stats.drops[drop.rarity]=(stats.drops[drop.rarity]||0)+1;
  saveJSON(STATS_PATH, stats);
}
function getStats() {
  const stats=loadJSON(STATS_PATH);
  const total=stats.opens||0;
  const by=stats.drops||{};
  const fmt=['Gold','Red','Pink','Purple','Blue'].map(r=>`${rarityEmoji(r)} ${r}: ${by[r]||0}`).join(' | ');
  return { total, fmt };
}

// ----------------- Pricing (Skinport + CSFloat) -----------------
const PRICE_CFG = {
  provider: (process.env.PRICE_PROVIDER || 'best_of').toLowerCase(),
  currency: process.env.PRICE_CURRENCY || 'USD',
  ttlMs: (parseInt(process.env.PRICE_TTL_MINUTES || '10', 10) * 60000),
  csfloatKey: process.env.CSFLOAT_API_KEY || null,
};

const PRICE_CACHE_DIR = path.join(DATA_DIR, 'pricing');
const SKINPORT_CACHE = path.join(PRICE_CACHE_DIR, 'skinport-items.json');
const PRICE_CACHE = path.join(PRICE_CACHE_DIR, 'price-cache.json');

function ensurePriceData() {
  if (!fs.existsSync(PRICE_CACHE_DIR)) fs.mkdirSync(PRICE_CACHE_DIR, { recursive: true });
  if (!fs.existsSync(SKINPORT_CACHE)) fs.writeFileSync(SKINPORT_CACHE, JSON.stringify({ fetchedAt: 0, items: [] }, null, 2));
  if (!fs.existsSync(PRICE_CACHE)) fs.writeFileSync(PRICE_CACHE, JSON.stringify({}, null, 2));
}
function readPriceJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

function marketNameFromDrop(drop) {
  const wear = drop.wear;
  const isKnifeOrGlove = (drop.weapon || '').startsWith('★');
  const souv = drop.souvenir ? 'Souvenir ' : '';
  if (isKnifeOrGlove) {
    const name = drop.weapon.replace('★', '').trim();
    const starPart = '★ ' + (drop.stattrak ? 'StatTrak™ ' : '');
    return (souv + starPart + name + ' | ' + drop.name + ' (' + wear + ')').trim();
  }
  const st = drop.stattrak ? 'StatTrak™ ' : '';
  return (souv + st + drop.weapon + ' | ' + drop.name + ' (' + wear + ')').trim();
}

const PriceService = {
  _skinport: { fetchedAt: 0, map: new Map() },
  _cache: readPriceJSON(PRICE_CACHE, {}),

  async _fetchSkinportItems() {
    const now = Date.now();
    const cached = readPriceJSON(SKINPORT_CACHE, { fetchedAt: 0, items: [] });
    if (now - (cached.fetchedAt || 0) < PRICE_CFG.ttlMs && cached.items && cached.items.length) {
      this._skinport.fetchedAt = cached.fetchedAt;
      this._skinport.map = new Map(cached.items.map(it => [it.market_hash_name, it]));
      return;
    }
    const params = new URLSearchParams({ app_id: '730', currency: PRICE_CFG.currency, tradable: '0' });
    const resp = await fetch('https://api.skinport.com/v1/items?' + params.toString(), { headers: { 'Accept-Encoding': 'br' } });
    const items = await resp.json();
    this._skinport.fetchedAt = now;
    this._skinport.map = new Map(items.map(it => [it.market_hash_name, it]));
    fs.writeFileSync(SKINPORT_CACHE, JSON.stringify({ fetchedAt: now, items }, null, 2));
  },

  _fromCache(marketHash) {
    const c = this._cache[marketHash];
    if (!c) return null;
    if (Date.now() - (c.fetchedAt || 0) > PRICE_CFG.ttlMs) return null;
    return c;
  },

  _saveCache(marketHash, obj) {
    this._cache[marketHash] = obj;
    fs.writeFileSync(PRICE_CACHE, JSON.stringify(this._cache, null, 2));
  },

  async _getFromSkinport(marketHash) {
    await this._fetchSkinportItems();
    const row = this._skinport.map.get(marketHash);
    if (!row) return null;
    return {
      provider: 'skinport',
      currency: row.currency || PRICE_CFG.currency,
      min: row.min_price ?? null,
      median: row.median_price ?? null,
      mean: row.mean_price ?? null,
      suggested: row.suggested_price ?? null,
      url: row.item_page || row.market_page || null,
      fetchedAt: Date.now(),
    };
  },

  async _getFromCSFloat(marketHash) {
    if (!PRICE_CFG.csfloatKey) return null;
    const u = new URL('https://csfloat.com/api/v1/listings');
    u.searchParams.set('sort_by', 'lowest_price');
    u.searchParams.set('limit', '1');
    u.searchParams.set('market_hash_name', marketHash);
    const resp = await fetch(u, { headers: { Authorization: PRICE_CFG.csfloatKey } });
    if (!resp.ok) return null;
    const arr = await resp.json();
    const first = Array.isArray(arr) ? arr[0] : null;
    if (!first || !first.price) return null;
    return { provider: 'csfloat', currency: 'USD', floor: first.price / 100, url: 'https://csfloat.com', fetchedAt: Date.now() };
  },

  async priceForDrop(drop) {
    const marketHash = marketNameFromDrop(drop);
    const cached = this._fromCache(marketHash);
    if (cached) return cached;

    let sp=null, cf=null;
    if (PRICE_CFG.provider === 'skinport' || PRICE_CFG.provider === 'best_of') sp = await this._getFromSkinport(marketHash);
    if (PRICE_CFG.provider === 'csfloat'  || PRICE_CFG.provider === 'best_of') cf = await this._getFromCSFloat(marketHash);

    let usd=null, source=null, url=null;
    if (cf && typeof cf.floor === 'number') { usd = cf.floor; source = 'CSFloat floor'; url = cf.url; }
    if (sp && (sp.median != null || sp.min != null || sp.mean != null || sp.suggested != null)) {
      const val = sp.median ?? sp.min ?? sp.mean ?? sp.suggested;
      if (usd == null || (typeof val === 'number' && val < usd)) { usd = val; source = 'Skinport median'; url = sp.url; }
    }
    const out = { marketHash, usd: (typeof usd === 'number' ? Math.round(usd * 100) / 100 : null), source, url, fetchedAt: Date.now() };
    this._saveCache(marketHash, out);
    return out;
  }
};

async function priceForMarketHash(marketHash) {
  const cached = PriceService._fromCache(marketHash); if (cached) return cached;
  const provider = (process.env.PRICE_PROVIDER || 'best_of').toLowerCase();
  let sp=null, cf=null;
  if (provider === 'skinport' || provider === 'best_of') sp = await PriceService._getFromSkinport(marketHash);
  if (provider === 'csfloat'  || provider === 'best_of') cf = await PriceService._getFromCSFloat(marketHash);
  let usd=null, source=null, url=null;
  if (cf && typeof cf.floor === 'number') { usd = cf.floor; source = 'CSFloat floor'; url = cf.url; }
  if (sp && (sp.median != null || sp.min != null || sp.mean != null || sp.suggested != null)) {
    const val = sp.median ?? sp.min ?? sp.mean ?? sp.suggested;
    if (usd == null || (typeof val === 'number' && val < usd)) { usd = val; source = 'Skinport median'; url = sp.url; }
  }
  const out = { marketHash, usd: (typeof usd === 'number' ? Math.round(usd * 100) / 100 : null), source, url, fetchedAt: Date.now() };
  PriceService._saveCache(marketHash, out);
  return out;
}

ensurePriceData();

// ---- Fuzzy helpers for !price ----
function _tokens(s) { return (s||'').toLowerCase().replace(/™/g,'').split(/[^a-z0-9]+/).filter(Boolean); }
function _expandWearAbbr(tokens) { const out=[...tokens]; for (const t of tokens) { if (t==='fn') out.push('factory','new'); if (t==='mw') out.push('minimal','wear'); if (t==='ft') out.push('field','tested'); if (t==='ww') out.push('well','worn'); if (t==='bs') out.push('battle','scarred'); if (t==='st') out.push('stattrak'); } return out; }
function _bestSkinportKeyForQuery(query) { const map = PriceService._skinport && PriceService._skinport.map; if (!map || map.size===0) return null; const qTokens=_expandWearAbbr(_tokens(query)); let bestKey=null, bestScore=0; for (const key of map.keys()) { const k=key.toLowerCase().replace(/™/g,''); let score=0; for (const t of qTokens) if (k.includes(t)) score++; if (score>bestScore) { bestScore=score; bestKey=key; } } return bestScore>=2?bestKey:null; }
async function priceLookupFlexible(input) { let out=await priceForMarketHash(input); if (out && out.usd!=null) return { ...out, resolved: input }; const candidate=_bestSkinportKeyForQuery(input); if (candidate) { out=await priceForMarketHash(candidate); if (out && out.usd!=null) return { ...out, resolved: candidate }; } return { usd: null, resolved: input }; }

// ----------------- Values & Leaderboard -----------------
async function ensurePriceOnDrop(drop) { if (typeof drop.priceUSD === 'number') return drop.priceUSD; try { const p=await PriceService.priceForDrop(drop); if (p && typeof p.usd==='number') { drop.priceUSD=p.usd; return drop.priceUSD; } } catch {} return null; }
async function inventoryValue(userKey) {
  const items = getInventory(userKey);
  let sum = 0;
  for (const d of items) {
    // Ignore Blues in worth total
    if (d?.rarity === 'Blue') continue;
    const v = await ensurePriceOnDrop(d);
    if (typeof v === 'number') sum += v;
  }
  return { totalUSD: +sum.toFixed(2), count: items.length };
}
async function leaderboardTop(n = 5, channelName) {
  const inv = getAllInventories();
  const rows = [];
  const prefix = `${channelName}:`;

  for (const [key, items] of Object.entries(inv)) {
    if (key.includes(':')) {
      if (!key.startsWith(prefix)) continue; // only this channel
      let sum = 0; for (const d of items) { const v = await ensurePriceOnDrop(d); if (typeof v === 'number') sum += v; }
      rows.push({ user: key.slice(prefix.length), total: +sum.toFixed(2), count: items.length });
    } else {
      // Legacy (no channel): show in this channel until migrated
      let sum = 0; for (const d of items) { const v = await ensurePriceOnDrop(d); if (typeof v === 'number') sum += v; }
      rows.push({ user: key, total: +sum.toFixed(2), count: items.length });
    }
  }

  rows.sort((a, b) => b.total - a.total);
  return rows.slice(0, Math.max(1, Math.min(25, n)));
}

// ----------------- Defaults helpers -----------------
function setDefaultCase(user, caseKey) { const d=loadJSON(DEFAULTS_PATH); d[user]=caseKey; saveJSON(DEFAULTS_PATH, d); }
function getDefaultCase(user) { const d=loadJSON(DEFAULTS_PATH); return d[user] || CONFIG.defaultCaseKey; }

// ----------------- Rarity parsing + chunked chat -----------------
function normalizeRarity(input) {
  if (!input) return null;
  const t = String(input).toLowerCase();
  if (t === 'gold' || t === '✨' || t === 'yellow' || t === 'knife' || t === 'glove') return 'Gold';
  if (t === 'red' || t === 'covert' || t === '🔴') return 'Red';
  if (t === 'pink' || t === 'classified' || t === '💗') return 'Pink';
  if (t === 'purple' || t === 'restricted' || t === '🟣') return 'Purple';
  if (t === 'blue' || t === 'mil-spec' || t === '🔵') return 'Blue';
  return null;
}
async function sayChunkedList(channel, header, lines) {
  const chunks = [];
  let buf = header;
  for (const ln of lines) {
    const add = (buf.length ? ' | ' : '') + ln;
    if ((buf + add).length > 400) { chunks.push(buf); buf = ln; } else { buf += add; }
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) {
    try { await client.say(channel, c); } catch (e) { console.log('[chat chunk error]', e?.message || e); }
  }
}

// ----------------- Command Router -----------------
function isModOrBroadcaster(tags) { const badges = tags.badges || {}; return !!tags.mod || badges.broadcaster === '1'; }

const HELP_TEXT = [
  `Commands:`,
  `!cases — list cases`,
  `!open <case> [xN|N] — open 1-10 cases`,
  `!inv [@user] — show inventory (rarity counts)`,
  `!invlist <rarity> [@user] — list items of that rarity (mods can target)`,
  `!worth [@user] — inventory value (USD)`,
  `!price <market name>|last — e.g., StatTrak\u2122 AK-47 | Redline (Field-Tested) or "last"`,
  `!top [N] — leaderboard by inventory value`,
  `!stats — global drop stats`,
  `!setcase <case> — set default case`,
  `!mycase — show your default case`,
  `!dro | !drobot — about message`,
  `!migrateinv — (mods) migrate legacy inventories for this channel`,
  `!song — checks current song playing`,
].join(' | ');

// --- Channels parsing (multi-channel support) ---
const CHANNELS = (process.env.TWITCH_CHANNELS || process.env.TWITCH_CHANNEL || '')
  .split(/[,\s]+/)
  .map(s => s.trim().replace(/^[@#]/, '').toLowerCase())
  .filter(Boolean);

const UNIQUE_CHANNELS = [...new Set(CHANNELS)];

if (UNIQUE_CHANNELS.length === 0) {
  console.error('[drobot] No channels configured. Set TWITCH_CHANNELS or TWITCH_CHANNEL.');
  process.exit(1);
}

console.log('[drobot] Will join channels:', UNIQUE_CHANNELS.map(c => `#${c}`).join(', '));

// ----------------- Twitch Client -----------------
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true },
  connection: { secure: true, reconnect: true },
  identity: { username: process.env.TWITCH_USERNAME, password: process.env.TWITCH_OAUTH },
  channels: UNIQUE_CHANNELS,
});

// Helpful connection logs
client.on('connected', (addr, port) => {
  console.log(`[drobot] Connected to ${addr}:${port}`);
});
client.on('join', (channel, username, self) => {
  if (self) console.log(`[drobot] Joined ${channel}`);
});
client.on('part', (channel, username, self) => {
  if (self) console.log(`[drobot] Parted ${channel}`);
});

// Safety net: drop identical chat lines emitted back-to-back within 1.5s per channel
const LAST_OUT = new Map(); // channel -> { text, ts }
const _say = (...args) => tmi.Client.prototype.say.apply(client, args);
client.say = (channel, text) => {
  const prev = LAST_OUT.get(channel);
  const now = Date.now();
  if (prev && prev.text === String(text) && (now - prev.ts) < 1500) return;
  LAST_OUT.set(channel, { text: String(text), ts: now });
  return _say(channel, text);
};

client.connect().then(() => {
  ensureData(); ensurePriceData();
  console.log(`[dro:${INSTANCE_ID}] data dir = ${DATA_DIR}`);
  console.log(`[dro:${INSTANCE_ID}] connected to`, UNIQUE_CHANNELS.map(c => `#${c}`).join(', '));
}).catch(console.error);

// --- Minimal HTTP health / backup ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (u.pathname === '/backup') {
      if (!ADMIN_KEY || u.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('unauthorized'); }
      const payload = { version: 1, ts: Date.now(), inventories: loadJSON(INV_PATH), stats: loadJSON(STATS_PATH), defaults: loadJSON(DEFAULTS_PATH) };
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="dro_backup.json"' });
      return res.end(body);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Dro_bot_ OK');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('server error');
  }
}).listen(PORT, () => console.log(`[dro:${INSTANCE_ID}] health on :${PORT}`));

// Smarter resolver: respects numbers (e.g., "Gamma" vs "Gamma 2") and a couple aliases.
function resolveCaseKey(input) {
  if (!input) return null;

  const keys = Object.keys(CASES);
  const norm = (s) => String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(input);

  const aliases = {
    'gamma': 'Gamma Case',
    'gamma case': 'Gamma Case',
    'gamma 2': 'Gamma 2 Case',
    'gamma2': 'Gamma 2 Case',
  };
  if (aliases[q] && CASES[aliases[q]]) return aliases[q];

  // 1) Exact match
  const exact = keys.find((k) => norm(k) === q);
  if (exact) return exact;

  // 2) Token-aware + digit-aware fuzzy match
  const qHasDigit = /\d/.test(q);
  const stop = new Set(['case', 'weapon', 'operation', 'csgo', 'cs:go']);
  const qTokens = q.split(' ').filter((t) => t && !stop.has(t));

  let candidates = keys.filter((k) => {
    const nk = norm(k);
    const kHasDigit = /\d/.test(nk);
    if (qHasDigit !== kHasDigit) return false;
    return qTokens.every((t) => nk.includes(t));
  });

  if (candidates.length === 0) {
    candidates = keys.filter((k) => {
      const nk = norm(k);
      if (!nk.startsWith(q)) return false;
      if (!qHasDigit && /\d/.test(nk)) return false;
      return true;
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates[0];
}


// Cooldowns (simple per-user)
const cdMap = new Map();
const COOLDOWN_MS = 3000;
function onCooldown(user) { const now=Date.now(); const last=cdMap.get(user) || 0; if (now - last < COOLDOWN_MS) return true; cdMap.set(user, now); return false; }

// ----------------- Chat Handler -----------------
client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if (alreadyHandled(tags, message)) return; // robust local de-dupe
  if (!message.startsWith(CONFIG.prefix)) return;

  const display = (tags['display-name'] || tags.username || 'user').toLowerCase();
  if (onCooldown(display)) return;

  const args = message.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  // Only respond to bot commands; ignore others like !so
  const ALLOWED_CMDS = new Set(['help','cases','mycase','setcase','open','inv','invlist','stats','worth','price','top','backupurl','dro','drobot','migrateinv']);
  if (!ALLOWED_CMDS.has(cmd)) return;

  const ch = chanName(channel);
  const selfKey = nsKey(channel, display);

  switch (cmd) {
    case 'dro':
    case 'drobot': {
      const intro = `Yo, I’m Dro_bot_ v0.0.8.2 — your CS2 case-opening companion. Open cases with 1:1 CS2-style odds & wear, save your drops, check live prices (Skinport + CSFloat), and climb the value leaderboard. Try: !open <case>, !price last, !inv, !worth, !top, !cases . Pure sim, no real items and most importantly, completely free! GLHF ✨`;
      client.say(channel, intro);
      break;
    }

    case 'help':
      client.say(channel, HELP_TEXT);
      break;

    case 'cases':
      client.say(channel, `Available cases: ${Object.keys(CASES).join(' | ')}`);
      break;
    case 'song': {
      try {
        const now = await getCurrentSong();
        if (now.status === "missing_refresh") {
          client.say(channel, "Spotify not linked yet. (Owner: add SPOTIFY_REFRESH_TOKEN)");
          break;
        }
        if (now.status === "nothing") {
          client.say(channel, "No track playing right now.");
          break;
        }
        if (now.type === "episode") {
          client.say(channel, `${now.isPlaying ? "▶️" : "⏸️"} Podcast: ${now.title} — ${now.show} ${now.url ? `(${now.url})` : ""}`);
          break;
        }
        const progress = fmtTime(now.progressMs);
        const total = fmtTime(now.durationMs);
        client.say(
          channel,
          `${now.isPlaying ? "▶️" : "⏸️"} ${now.artists} — ${now.title} ${now.url ? `(${now.url})` : ""} [${progress}/${total}]`
        );
      } catch (e) {
        console.error(e);
        client.say(channel, "Couldn’t reach Spotify right now.");
      }
      break;
    }

    case 'mycase':
      client.say(channel, `@${display} your default case is: ${getDefaultCase(display)}`);
      break;

    case 'setcase': {
      const input = args.join(' ');
      const key = resolveCaseKey(input);
      if (!key) { client.say(channel, `@${display} I don't recognize that case.`); break; }
      setDefaultCase(display, key);
      client.say(channel, `@${display} default case set to: ${key}`);
      break;
    }

    case 'open': {
      // !open <case words...> [xN or N]
      let count = 1;
      // accept quantity as last token: either "xN" or just "N"
      let qtyIdx = -1; let qtyMatch = null;
      for (let i = args.length - 1; i >= 0; i--) {
        const m = /^x?([0-9]+)$/i.exec(args[i]);
        if (m) { qtyIdx = i; qtyMatch = m; break; }
      }
      if (qtyIdx >= 0) {
        count = Math.max(1, Math.min(CONFIG.maxOpensPerCommand, parseInt(qtyMatch[1], 10)));
        args.splice(qtyIdx, 1);
      }

      const caseInput = args.join(' ');
      const caseKey = caseInput ? resolveCaseKey(caseInput) : getDefaultCase(display);
      if (!caseKey) { client.say(channel, `@${display} pick a case with !cases or set one with !setcase <case>.`); break; }

      // Pull drops
      const results = [];
      for (let i = 0; i < count; i++) {
        const drop = openOne(caseKey);
        results.push(drop);
        addToInventory(selfKey, drop);  // namespaced inventory
        pushStats(drop);
      }

      // Ensure prices for display
      try {
        for (const d of results) { await ensurePriceOnDrop(d); }
      } catch {}

      // Sort for display: rarity (Gold > Red > Pink > Purple > Blue), then price desc, then float asc
      const rarityWeight = { Gold: 5, Red: 4, Pink: 3, Purple: 2, Blue: 1 };
      const sorted = results.slice().sort((a, b) => {
        const rw = (rarityWeight[b.rarity] || 0) - (rarityWeight[a.rarity] || 0);
        if (rw !== 0) return rw;
        const pa = (typeof a.priceUSD === 'number') ? a.priceUSD : -1;
        const pb = (typeof b.priceUSD === 'number') ? b.priceUSD : -1;
        if (pb !== pa) return pb - pa;
        return (a.float || 1) - (b.float || 1);
      });

      // Filter rule for chat noise: hide Blue items under $9.99 from the *chat output only*
      const NOTABLE_THRESHOLD = 9.99;
      const isVisibleInChat = (d) => !(d.rarity === 'Blue' && (d.priceUSD ?? 0) < NOTABLE_THRESHOLD);

      if (count <= 5) {
        const visibles = sorted.filter(isVisibleInChat);
        if (visibles.length === 0) {
          client.say(channel, `@${display} opened ${count}x ${caseKey}: no notable drops (>$${NOTABLE_THRESHOLD.toFixed(2)}) — check !inv or !invlist to see everything.`);
        } else {
          const lines = visibles.map(formatDrop).join('  |  ');
          client.say(channel, `@${display} opened ${count}x ${caseKey}: ${lines}`);
        }
        break;
      }

      // For >5, show top 5 *visible* items, then summarize the rest
      const headVis = sorted.filter(isVisibleInChat).slice(0, 5);
      const headText = headVis.length ? headVis.map(formatDrop).join('  |  ') : `no notable drops (>$${NOTABLE_THRESHOLD.toFixed(2)})`;

      // Tail = everything else (for the summary + highlights)
      const shownSet = new Set(headVis);
      const tail = sorted.filter(d => !shownSet.has(d));

      let tailValue = 0;
      for (const d of tail) if (typeof d.priceUSD === 'number') tailValue += d.priceUSD;

      // Highlights: Gold/Red count, and very low floats
      const reds = tail.filter(d => d.rarity === 'Red').length;
      const golds = tail.filter(d => d.rarity === 'Gold').length;
      const lowFloat = tail.filter(d => (d.float ?? 1) <= 0.05).length;

      const highlights = [
        golds ? `✨x${golds}` : null,
        reds ? `🔴x${reds}` : null,
        lowFloat ? `⬇️x${lowFloat}` : null,
      ].filter(Boolean).join(' ');

      const more = `… +${tail.length} more (~$${tailValue.toFixed(2)})`;
      const hl = highlights ? ` Highlights: ${highlights}` : '';

      client.say(channel, `@${display} opened ${count}x ${caseKey}: ${headText}  |  ${more}.${hl}`);
      break;
    }

    case 'inv': {
      const target = (args[0]?.replace('@','') || display).toLowerCase();
      const targetKey = nsKey(channel, target);
      const items = getInventory(targetKey);
      if (!items.length) { client.say(channel, `@${display} ${target} has an empty inventory. Use !open to pull some heat.`); break; }
      const counts = { Gold:0, Red:0, Pink:0, Purple:0, Blue:0 };
      for (const it of items) if (counts[it.rarity] != null) counts[it.rarity]++;
      const order = ['Gold','Red','Pink','Purple','Blue'];
      const parts = order.map(r => `${rarityEmoji(r)} ${r}: ${counts[r] || 0}`).join(' | ');
      client.say(channel, `@${display} ${target}'s inventory (${items.length} items) — ${parts}`);
      break;
    }

case 'invlist': {
  // !invlist <rarity> [@user]
  const rarityArg = (args[0] || '').toLowerCase();
  const rarityKey = normalizeRarity(rarityArg);
  if (!rarityKey) { 
    client.say(channel, `@${display} usage: !invlist <gold|red> [@user]`); 
    break; 
  }

  // block Blue, Purple, Pink lists to prevent spam
  if (rarityKey === 'Blue' || rarityKey === 'Purple' || rarityKey === 'Pink') {
    client.say(channel, `@${display} ${rarityKey} invlist is disabled to reduce chat spam. Use !inv for a summary or pick Red/Gold.`);
    break;
  }

      let targetUser = display;
      if (args[1]) {
        const maybe = args[1].replace('@','').toLowerCase();
        if (isModOrBroadcaster(tags)) targetUser = maybe; else { client.say(channel, `@${display} mods/broadcaster only to target another user.`); break; }
      }
      const items = getInventory(nsKey(channel, targetUser)).filter(it => it.rarity === rarityKey);
      if (!items.length) { client.say(channel, `@${display} ${targetUser} has no ${rarityKey} items yet.`); break; }
      const basic = (d) => {
        const parts = []; if (d.souvenir) parts.push('Souvenir'); if (d.stattrak) parts.push('StatTrak');
        const prefix = parts.length ? parts.join(' ') + ' ' : '';
        const wearShort = (d.wear || '').split(' ').map(s => s[0]).join('');
        return `${prefix}${d.weapon} | ${d.name} (${wearShort})`;
      };
      const lines = items.map(basic);
      const head = `@${display} [${rarityEmoji(rarityKey)} ${rarityKey}] ${items.length} item(s)` + (targetUser!==display?` for @${targetUser}`:'') + ':';
      await sayChunkedList(channel, head, lines);
      break;
    }

    case 'stats': {
      const s = getStats();
      client.say(channel, `Drops so far — Total opens: ${s.total} | ${s.fmt}`);
      break;
    }

    case 'worth': {
      const rawTarget = (args[0]?.replace('@','') || display).toLowerCase();
      const isSelf = rawTarget === display;
      const targetKey = nsKey(channel, rawTarget);
      const { totalUSD, count } = await inventoryValue(targetKey);
      if (count === 0) {
        if (isSelf) client.say(channel, `@${display} you have an empty inventory.`);
        else client.say(channel, `@${display} @${rawTarget} has an empty inventory.`);
        break;
      }
      const msg = isSelf
        ? `@${display} inventory: ${count} items • ~$${totalUSD.toFixed(2)} USD`
        : `@${display} @${rawTarget}'s inventory: ${count} items • ~$${totalUSD.toFixed(2)} USD`;
      client.say(channel, msg);
      break;
    }

    case 'price': {
      const q = args.join(' ').trim();
      if (!q) { client.say(channel, `@${display} usage: !price <market name> — e.g., StatTrak\u2122 AK-47 | Redline (Field-Tested) or !price last`); break; }
      if (q.toLowerCase() === 'last') {
        const items = getInventory(selfKey);
        if (!items.length) { client.say(channel, `@${display} you have no drops yet. Use !open first.`); break; }
        const last = items[items.length - 1];
        const mh = marketNameFromDrop(last);
        const p = await priceForMarketHash(mh);
        if (!p || p.usd == null) { client.say(channel, `@${display} couldn't find price for your last drop.`); break; }
        client.say(channel, `@${display} ${mh} ≈ $${p.usd.toFixed(2)} (${p.source || 'market'})`);
        break;
      }
      try {
        const p = await priceLookupFlexible(q);
        if (!p || p.usd == null) { client.say(channel, `@${display} couldn't find price for: ${q}`); break; }
        client.say(channel, `@${display} ${p.resolved} ≈ $${p.usd.toFixed(2)} (${p.source || 'market'})`);
      } catch {
        client.say(channel, `@${display} price lookup failed.`);
      }
      break;
    }

    case 'top': {
      let n = parseInt(args[0], 10); if (!Number.isFinite(n) || n <= 0) n = 5; n = Math.min(25, n);
      const rows = await leaderboardTop(n, ch);
      if (!rows.length) { client.say(channel, `@${display} leaderboard is empty.`); break; }
      const line = rows.map((r, i) => `#${i+1} ${r.user}: $${r.total.toFixed(2)} (${r.count})`).join(' | ');
      client.say(channel, `Top ${rows.length} (by inventory value): ${line}`);
      break;
    }

    case 'migrateinv': {
      if (!isModOrBroadcaster(tags)) { client.say(channel, `@${display} mods/broadcaster only.`); break; }
      const prefix = `${ch}:`;
      const inv = loadJSON(INV_PATH);
      let moved = 0;
      for (const [key, items] of Object.entries(inv)) {
        if (key.includes(':')) continue; // already new format
        const targetKey = prefix + key.toLowerCase();
        inv[targetKey] = (inv[targetKey] || []).concat(items);
        delete inv[key];
        moved++;
      }
      saveJSON(INV_PATH, inv);
      client.say(channel, `@${display} migrated ${moved} legacy inventories into this channel.`);
      break;
    }

    case 'backupurl': {
      if (!isModOrBroadcaster(tags)) { client.say(channel, `@${display} mods/broadcaster only.`); break; }
      if (!ADMIN_KEY || !PUBLIC_URL) { client.say(channel, `@${display} set ADMIN_KEY and PUBLIC_URL env vars to use this.`); break; }
      const base = PUBLIC_URL.endsWith('/') ? PUBLIC_URL.slice(0, -1) : PUBLIC_URL;
      const link = `${base}/backup?key=${ADMIN_KEY}`;
      console.log('[dro] Backup URL:', link);
      client.say(channel, `@${display} backup URL printed to server logs.`);
      break;
    }

    default:
      break;
  }
});

// ----------------- Background price prefetch + shutdown -----------------
(async () => { try { await PriceService._fetchSkinportItems(); } catch {} })();
setInterval(() => { PriceService._fetchSkinportItems().catch(() => {}); }, Math.max(PRICE_CFG.ttlMs, 300000));

client.on('disconnected', (reason) => console.log(`[dro:${INSTANCE_ID}] disconnected:`, reason));
function gracefulExit() { console.log(`[dro:${INSTANCE_ID}] shutting down`); try { client.disconnect(); } catch {} process.exit(0); }
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);
