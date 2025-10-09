// dromon.js — Dro_bot_ web service with Trading wired in
// ESM module. Requires Node 20+ and "type":"module" in package.json

import http from 'node:http';
import url from 'node:url';
import tmi from 'tmi.js';

// ---- Config from env ----
const BOT_NAME = process.env.TWITCH_USERNAME || 'dro_bot';
const BOT_OAUTH = process.env.TWITCH_OAUTH || ''; // must include 'oauth:' prefix
const BOT_CHANNEL = (process.env.TWITCH_CHANNEL || 'indicouchgaming').replace(/^@/, '');
const PREFIX = process.env.BOT_PREFIX || '!';
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 10000);

// ---- Optional: make file paths explicit for Render disk ----
process.env.DROMON_TRADES_PATH ||= './data/trades.json';
process.env.DROMON_TRADE_TTL_MIN ||= '10';

// ---- Try to load the trading module from several common locations ----
let Trading = null;
const tradingCandidates = [
  './src/dromon/trading/trades.js',
  './dromon/trading/trades.js',
  './dromon-trading/trades.js',
  './trades.js',
];

for (const p of tradingCandidates) {
  try {
    Trading = await import(p);
    console.log('[DroMon] Trading module loaded from', p);
    break;
  } catch (e) {
    // console.debug('Trading not at', p);
  }
}
if (!Trading) {
  console.warn('[DroMon] Trading module NOT found — !trade will be disabled. Place trades.js in one of:', tradingCandidates);
}

// ---- HTTP server (Render health check + simple status) ----
const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Optional debug endpoint to check bot + trading status
    if (parsed.pathname === '/dromon/status') {
      const status = {
        bot: 'ok',
        channel: BOT_CHANNEL,
        trading: !!Trading,
        prefix: PREFIX,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // Default: minimal overlay text (kept from earlier behavior)
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Dro_bot_ OK');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[HTTP] Listening on http://${HOST}:${PORT}  (health: /healthz)`);
});

// ---- TMI client ----
const client = new tmi.Client({
  options: { debug: false },
  connection: { secure: true, reconnect: true },
  identity: BOT_OAUTH ? { username: BOT_NAME, password: BOT_OAUTH } : undefined,
  channels: [ BOT_CHANNEL ],
});

client.on('connected', (addr, port) => {
  console.log(`[TMI] Connected to ${addr}:${port} as @${BOT_NAME} → #${BOT_CHANNEL}`);
});

client.on('disconnected', (reason) => {
  console.warn('[TMI] Disconnected:', reason);
});

await client.connect().catch(err => {
  console.error('[TMI] Connection error:', err?.message || err);
});

// ---- Helpers ----
function parseCommand(msg) {
  if (!msg || !msg.startsWith(PREFIX)) return null;
  const sliced = msg.slice(PREFIX.length).trim();
  if (!sliced) return null;
  const parts = sliced.split(/\s+/);
  const cmd = parts.shift().toLowerCase();
  return { cmd, args: parts };
}

// Minimal user lookup; replace with your own if you have a database
async function lookupUser(handle) {
  return { id: handle.toLowerCase(), username: handle, displayName: handle };
}

// Expire old trades every 30s (if trading is present)
if (Trading?.expireTick) {
  setInterval(() => Trading.expireTick().catch(() => {}), 30_000);
}

// ---- Message handler ----
client.on('message', async (channel, userstate, message, self) => {
  if (self) return;

  const parsed = parseCommand(message);
  if (!parsed) return;
  const { cmd, args } = parsed;

  // Handle trading
  if (Trading && cmd === 'trade') {
    try {
      const out = await Trading.handleTradeCommand({
        actor: {
          id: userstate['user-id'],
          username: userstate['display-name'] || userstate.username,
          displayName: userstate['display-name'] || userstate.username,
        },
        args,
        lookupUser,
      });
      if (out) client.say(channel, out);
    } catch (e) {
      client.say(channel, `Trade error: ${e?.message || e}`);
    }
    return;
  }

  // --- Add/keep your other commands below ---
  if (cmd === 'ping') {
    client.say(channel, 'pong');
    return;
  }
});

// Graceful shutdown
for (const sig of ['SIGINT','SIGTERM']) {
  process.on(sig, () => {
    console.log(`[SYS] ${sig} received. Closing…`);
    try { server.close(); } catch {}
    try { client.disconnect(); } catch {}
    setTimeout(() => process.exit(0), 300).unref();
  });
}
