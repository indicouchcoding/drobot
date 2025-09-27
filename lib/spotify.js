// lib/spotify.js
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const NOW_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";

async function getAccessToken() {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.SPOTIFY_REFRESH_TOKEN,
    client_id: process.env.SPOTIFY_CLIENT_ID,
    client_secret: process.env.SPOTIFY_CLIENT_SECRET,
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || JSON.stringify(data));
  return data.access_token;
}

export async function getCurrentSong() {
  if (!process.env.SPOTIFY_REFRESH_TOKEN) return { status: "missing_refresh" };

  const accessToken = await getAccessToken();
  const resp = await fetch(NOW_PLAYING_URL + "?additional_types=track,episode", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (resp.status === 204) return { status: "nothing" };
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Spotify error: ${resp.status} ${err}`);
  }

  const json = await resp.json();
  if (!json || !json.item) return { status: "nothing" };

  const isPlaying = json.is_playing;
  const type = json.currently_playing_type;
  const item = json.item;

  if (type === "episode") {
    return {
      status: "ok",
      type,
      title: item.name,
      show: item.show?.name,
      url: item.external_urls?.spotify,
      isPlaying,
      durationMs: item.duration_ms,
      progressMs: json.progress_ms || 0,
    };
  }

  const artists = item.artists?.map(a => a.name).join(", ") || "Unknown Artist";
  return {
    status: "ok",
    type: "track",
    title: item.name,
    artists,
    url: item.external_urls?.spotify,
    isPlaying,
    durationMs: item.duration_ms,
    progressMs: json.progress_ms || 0,
  };
}

export function fmtTime(ms = 0) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

