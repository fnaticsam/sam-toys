// POST /api/tracks-ocr — { images: [{ data(base64), mime }] } -> { rows: [{artist,title,remixer,bpm,key,label,genre}] }
// Reads a Rekordbox track-list screenshot with Gemini vision. Screenshot rows are a
// lower-confidence convenience path (dense/dark tables misread) — the prompt forces
// verbatim extraction and null-for-illegible so we never fabricate a track. Mirrors
// the guards in api/transcribe.js.

const { normalizeTrack } = require('./_lib/match');

const MODEL = 'gemini-3.5-flash';
const MAX_IMAGES = 8;
const MAX_TOTAL_B64 = 4_000_000; // stay under Vercel's 4.5 MB body limit (JSON + base64 overhead)
const GEMINI_TIMEOUT_MS = 55_000;

// Origin + durable per-client quota + global daily ceiling: see api/_lib/gemini-quota.js
const { originAllowed, reserveGeminiCall } = require('./_lib/gemini-quota');

function fail(res, status, error) { return res.status(status).json({ error }); }

// derive the real image type from magic bytes; declared mime only breaks ties
function sniffImage(head) {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (head.slice(4, 8).toString('latin1') === 'ftyp') return 'image/heic'; // heic/heif share the ftyp box
  return null;
}

const PROMPT = `You are given one or more screenshots of a Rekordbox DJ software track list (columns such as Track Title, Artist, BPM, Key, Genre, Label, Time).

Extract EVERY visible track row into JSON. Rules:
- Output EXACTLY what is visible. Copy text verbatim — do NOT infer, autocomplete, translate, normalize, or "fix" anything.
- Preserve exact mix/version labels ("Extended Mix", "Original Mix", "<name> Remix", "Radio Edit").
- For any cell you cannot read clearly, use null. Never guess a value.
- Put a remixer's name in "remixer" only if a distinct Remixer column shows it; otherwise leave the mix label inside "title" as printed.
- If several screenshots overlap (scrolling), de-duplicate — each real track appears once, in list order.
- If the image is not a track list or you can read no rows, return {"rows": []}.

Respond with JSON only: {"rows": [{"artist": string|null, "title": string|null, "remixer": string|null, "bpm": string|null, "key": string|null, "label": string|null, "genre": string|null}]}`;

const ROW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    artist: { type: 'STRING', nullable: true },
    title: { type: 'STRING', nullable: true },
    remixer: { type: 'STRING', nullable: true },
    bpm: { type: 'STRING', nullable: true },
    key: { type: 'STRING', nullable: true },
    label: { type: 'STRING', nullable: true },
    genre: { type: 'STRING', nullable: true },
  },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail(res, 405, 'Use POST { images }.'); }
  if (!originAllowed(req)) return fail(res, 403, 'This endpoint only serves sam.toys.');
  if (!String(req.headers['content-type'] || '').includes('application/json')) return fail(res, 415, 'Send JSON.');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return fail(res, 400, 'Body must be JSON.'); } }
  const images = body && body.images;
  if (!Array.isArray(images) || !images.length) return fail(res, 400, 'Missing "images" (array of { data, mime }).');
  if (images.length > MAX_IMAGES) return fail(res, 400, `Too many images — ${MAX_IMAGES} max per request.`);

  const parts = [];
  let totalB64 = 0;
  for (const img of images) {
    const data = img && img.data;
    if (typeof data !== 'string' || !data) return fail(res, 400, 'Each image needs a base64 "data" string.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail(res, 400, 'Image data must be plain base64 (no data: prefix).');
    totalB64 += data.length;
    if (totalB64 > MAX_TOTAL_B64) return fail(res, 413, 'Those screenshots are too big together — send fewer or crop them.');
    let head;
    try { head = Buffer.from(data.slice(0, 64), 'base64'); } catch { head = Buffer.alloc(0); }
    const mime = sniffImage(head) || (String(img.mime || '').startsWith('image/') ? img.mime : null);
    if (!mime) return fail(res, 415, "That doesn't look like an image. Send a PNG/JPEG screenshot.");
    parts.push({ inline_data: { mime_type: mime, data } });
  }
  parts.push({ text: PROMPT });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return fail(res, 500, 'Server is missing its vision key.');

  const quota = await reserveGeminiCall('tracks-ocr', req);
  if (!quota.ok) {
    res.setHeader('Retry-After', quota.scope === 'global' ? '3600' : '300');
    return fail(res, 429, quota.scope === 'global'
      ? 'Screenshot reading is switched off for the rest of today. Try again tomorrow.'
      : 'Easy — too many screenshots in a short window. Wait a few minutes.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let text = '';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { rows: { type: 'ARRAY', items: ROW_SCHEMA } }, required: ['rows'] },
        },
      }),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      console.error('gemini ocr error', r.status, detail);
      if (r.status === 429) return fail(res, 429, 'Vision is rate-limited right now. Wait a minute and retry.');
      return fail(res, 502, 'Could not read that screenshot. Retry, or send a sharper, closer crop.');
    }
    const data = await r.json().catch(() => null);
    text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) { console.error('gemini ocr empty', JSON.stringify(data)?.slice(0, 300)); return fail(res, 502, 'The reader returned nothing. Retry with a clearer image.'); }
  } catch (err) {
    return fail(res, err && err.name === 'AbortError' ? 504 : 502, err && err.name === 'AbortError'
      ? 'Reading the screenshot timed out. Try fewer/smaller images.'
      : 'Could not reach the vision service. Try again.');
  } finally { clearTimeout(timer); }

  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')); } catch { /* below */ }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const clean = rows.map((r) => ({
    artist: typeof r?.artist === 'string' ? r.artist : '',
    title: typeof r?.title === 'string' ? r.title : '',
    remixer: typeof r?.remixer === 'string' ? r.remixer : '',
    bpm: r?.bpm == null ? '' : String(r.bpm),
    key: typeof r?.key === 'string' ? r.key : '',
    label: typeof r?.label === 'string' ? r.label : '',
    genre: typeof r?.genre === 'string' ? r.genre : '',
  })).filter((r) => r.title || r.artist);

  // belt-and-suspenders EXACT-key de-dupe across overlapping/scrolled screenshots.
  // Key includes version + remixer so distinct mixes of the same title are NOT merged.
  const seen = new Set();
  const deduped = [];
  for (const r of clean) {
    const n = normalizeTrack({ artist: r.artist, title: r.title });
    const key = `${n.artistSet.slice().sort().join('|')}::${n.baseTitle}::${n.version}::${r.remixer.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return res.status(200).json({ rows: deduped });
};

module.exports.sniffImage = sniffImage;
