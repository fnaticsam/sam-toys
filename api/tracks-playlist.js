const { jsonBody } = require('./_lib/json-body');
// POST /api/tracks-playlist — { url } -> { kind, name, tracks[], truncated }
// Reads Spotify's PUBLIC embed page and parses its __NEXT_DATA__ island. This is the
// only ToS-gray surface in the toy (personal use) — kept isolated so it can be swapped
// for official OAuth later without touching the resolver or UI. No login, no scraping of
// stores. Structure verified against a real playlist 2026-07-13.

const ALLOWED_ORIGINS = /^https?:\/\/(sam\.toys|www\.sam\.toys|localhost(:\d+)?|127\.0\.0\.1(:\d+)?|sam-toys-[\w-]+\.vercel\.app)$/;
const FETCH_TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// warm-instance rate limit (same shape as api/transcribe.js)
const RL_WINDOW_MS = 5 * 60_000;
const RL_MAX = 40;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 1000) for (const [k, v] of hits) if (now - v.t > RL_WINDOW_MS) hits.delete(k);
  const rec = hits.get(ip);
  if (!rec || now - rec.t > RL_WINDOW_MS) { hits.set(ip, { n: 1, t: now }); return false; }
  return ++rec.n > RL_MAX;
}

function fail(res, status, error) { return res.status(status).json({ error }); }

// Accept open.spotify.com/{kind}/{id}, spotify:{kind}:{id}, with optional ?si=…
function parseSpotifyRef(input) {
  const s = String(input || '').trim();
  let m = s.match(/spotify[:/](playlist|track|album)[:/]([A-Za-z0-9]+)/i);
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };
  m = s.match(/open\.spotify\.com\/(?:embed\/)?(playlist|track|album)\/([A-Za-z0-9]+)/i);
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };
  return null;
}

function mapEntry(e) {
  const uri = String(e?.uri || '');
  // only build a /track/ link for actual tracks — episodes/local files get no direct link,
  // so the client falls back to a search instead of a broken /track/{id}
  const id = uri.startsWith('spotify:track:') ? uri.split(':').pop() : '';
  return {
    artist: String(e?.subtitle || '').trim(),
    title: String(e?.title || '').trim(),
    spotifyId: id,
    spotifyUrl: id ? `https://open.spotify.com/track/${id}` : '',
    durationMs: typeof e?.duration === 'number' ? e.duration : null,
    previewUrl: e?.audioPreview?.url || null,
    isrc: null, // not exposed by the embed; Musicfetch resolves by spotifyUrl instead
  };
}

async function readSpotifyUrl(url) {
  const ref = parseSpotifyRef(url);
  if (!ref) { const err = new Error('not a Spotify playlist, album or track URL'); err.code = 400; throw err; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html;
  try {
    const r = await fetch(`https://open.spotify.com/embed/${ref.kind}/${ref.id}`, {
      headers: { 'user-agent': UA, 'accept-language': 'en' },
      signal: controller.signal,
    });
    if (r.status === 404) { const e = new Error('that Spotify link was not found or is private'); e.code = 404; throw e; }
    if (!r.ok) { const e = new Error(`Spotify returned HTTP ${r.status}`); e.code = 502; throw e; }
    html = await r.text();
  } finally { clearTimeout(timer); }

  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) { const e = new Error('could not read that Spotify page (its format may have changed)'); e.code = 502; throw e; }

  let entity;
  try { entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity; }
  catch { const e = new Error('could not parse that Spotify page'); e.code = 502; throw e; }
  if (!entity) { const e = new Error('that Spotify page had no track data'); e.code = 502; throw e; }

  const list = Array.isArray(entity.trackList) ? entity.trackList
    : (entity.uri ? [entity] : []);
  const tracks = list.map(mapEntry).filter((t) => t.title || t.artist);
  if (!tracks.length) { const e = new Error('no playable tracks found on that link'); e.code = 422; throw e; }

  return {
    kind: entity.type || ref.kind,
    name: String(entity.name || entity.title || '').trim(),
    tracks,
    // the public embed caps very long playlists; warn rather than silently drop
    truncated: ref.kind === 'playlist' && tracks.length >= 100,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail(res, 405, 'Use POST { url }.'); }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.test(origin)) return fail(res, 403, 'This endpoint only serves sam.toys.');
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return fail(res, 429, 'Slow down a sec — too many playlists in a short window.');

  const parsedBody = jsonBody(req);
  if (!parsedBody.ok) return fail(res, 400, 'Body must be JSON.');
  const body = parsedBody.value;
  const url = body && body.url;
  if (typeof url !== 'string' || !url.trim()) return fail(res, 400, 'Missing "url".');

  try {
    const out = await readSpotifyUrl(url);
    return res.status(200).json(out);
  } catch (err) {
    const code = err && err.code && Number.isInteger(err.code) ? err.code : 502;
    if (err && err.name === 'AbortError') return fail(res, 504, 'Spotify took too long to respond. Try again.');
    return fail(res, code, (err && err.message) || 'Could not read that Spotify link.');
  }
};

module.exports.readSpotifyUrl = readSpotifyUrl;
module.exports.parseSpotifyRef = parseSpotifyRef;
