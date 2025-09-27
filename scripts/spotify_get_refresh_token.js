import http from "http";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI = "http://localhost:5173/callback",
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error("Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in env.");
  process.exit(1);
}

const PORT = new URL(SPOTIFY_REDIRECT_URI).port || 5173;
const SCOPES = ["user-read-currently-playing", "user-read-playback-state"];

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SCOPES.join(" "),
    state: Math.random().toString(36).slice(2),
    show_dialog: "true",
  }).toString();

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (pathname !== new URL(SPOTIFY_REDIRECT_URI).pathname) {
    res.writeHead(404).end("Not found");
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) { res.writeHead(400).end(`Error: ${error}`); console.error("Auth error:", error); return; }
  if (!code) { res.writeHead(400).end("Missing code"); return; }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: SPOTIFY_CLIENT_ID,
      client_secret: SPOTIFY_CLIENT_SECRET,
    });
    const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(JSON.stringify(data, null, 2));
    console.log("\nCopy this into your .env as SPOTIFY_REFRESH_TOKEN:\n");
    console.log(data.refresh_token, "\n");
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Refresh token received. Check terminal.");
  } catch (e) {
    console.error(e);
    res.writeHead(500).end("Token exchange failed. See console.");
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(PORT, () => {
  console.log("Open this URL to authorize Spotify:\n", authUrl, "\n");
  console.log("Waiting for callback on", SPOTIFY_REDIRECT_URI);
});
