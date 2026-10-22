// POST /api/transcribe — voice note (base64 audio) → { tldr, bullets[], transcript, language }
// Used by /voicenotes. Gemini handles ogg-opus (WhatsApp voice notes) natively.

const MODEL = 'gemini-3.5-flash';
const MAX_B64_CHARS = 5_000_000; // backstop; Vercel rejects bodies >4.5 MB before we run
const GEMINI_TIMEOUT_MS = 55_000;

// Origin + durable per-client quota + global daily ceiling: see api/_lib/gemini-quota.js
const { originAllowed, reserveGeminiCall } = require('./_lib/gemini-quota');

const PROMPT = `You are given one voice note (often a WhatsApp voice message). Do two things:

1. Transcribe it faithfully. Preserve names, numbers, dates, amounts and places exactly. Use punctuation and paragraph breaks so it reads naturally. If a word is unintelligible, write [unclear].
2. Summarize it so someone can absorb it in seconds:
   - "tldr": one plain sentence saying what the note is about and what (if anything) is being asked.
   - "bullets": short, clear bullet points covering every distinct point, in the note's order. Put any actions, questions or deadlines as their own bullets prefixed with "Action:", "Question:" or "Deadline:". Merge filler; never invent content.

If the note is not in English: keep "transcript" in the original language, but write "tldr" and "bullets" in English, and set "language" to the language name. Otherwise set "language" to "English".

If the audio contains no intelligible speech (silence, noise, music only, or you cannot decode it), set "transcript" to "", "bullets" to [], and "tldr" to "No speech detected in this audio." Never invent or guess content that is not clearly audible.

Respond with JSON only: {"tldr": string, "bullets": string[], "transcript": string, "language": string}`;

function fail(res, status, error) {
  return res.status(status).json({ error });
}

// derive the real container from magic bytes — the declared mime and filename are
// only consulted to disambiguate raw MPEG frames (mp3 vs aac ADTS share a syncword)
function sniffMime(head, declaredMime, filename) {
  const sig4 = head.slice(0, 4).toString('latin1');
  if (sig4 === 'OggS') return 'audio/ogg';   // opus/vorbis — WhatsApp .opus lands here
  if (sig4 === 'RIFF') return 'audio/wav';
  if (sig4 === 'fLaC') return 'audio/flac';
  if (sig4 === 'FORM') return 'audio/aiff';
  if (sig4 === '\x1aE\xdf\xa3') return 'audio/webm';
  if (head.slice(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (head.slice(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4'; // m4a/mp4/3gp
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    const aac = declaredMime === 'audio/aac' || declaredMime === 'audio/vnd.dlna.adts' || /\.aac$/.test(filename);
    return aac ? 'audio/aac' : 'audio/mpeg';
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Use POST with JSON { audio, mime }.');
  }

  if (!originAllowed(req)) {
    return fail(res, 403, 'This endpoint only serves sam.toys.');
  }
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return fail(res, 415, 'Send JSON (Content-Type: application/json).');
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return fail(res, 400, 'Body must be JSON.'); }
  }
  if (!body || typeof body !== 'object') return fail(res, 400, 'Body must be JSON { audio, mime }.');

  const { audio, mime, filename } = body;
  if (typeof audio !== 'string' || audio.length === 0) {
    return fail(res, 400, 'Missing "audio" (base64 string).');
  }
  if (audio.length > MAX_B64_CHARS) {
    return fail(res, 413, 'Voice note too big — the limit is ~3 MB (about 25 minutes of WhatsApp audio). Trim or split it.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
    return fail(res, 400, '"audio" must be plain base64 (no data: prefix, no whitespace).');
  }

  let head;
  try { head = Buffer.from(audio.slice(0, 64), 'base64'); } catch { head = Buffer.alloc(0); }
  const declaredMime = String(mime || '').toLowerCase().split(';')[0].trim();
  const effectiveMime = sniffMime(head, declaredMime, String(filename || '').toLowerCase());
  if (!effectiveMime) {
    return fail(res, 415, "That file doesn't look like audio. Send the voice note file itself (.opus from WhatsApp).");
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return fail(res, 500, 'Server is missing its transcription key.');

  const quota = await reserveGeminiCall('transcribe', req);
  if (!quota.ok) {
    res.setHeader('Retry-After', quota.scope === 'global' ? '3600' : '300');
    return fail(res, 429, quota.scope === 'global'
      ? 'Voice notes are switched off for the rest of today. Try again tomorrow.'
      : 'Easy tiger — that\'s a lot of voice notes. Wait a few minutes and try again.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let text = '';
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: effectiveMime, data: audio } },
              { text: PROMPT },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                tldr: { type: 'STRING' },
                bullets: { type: 'ARRAY', items: { type: 'STRING' } },
                transcript: { type: 'STRING' },
                language: { type: 'STRING' },
              },
              required: ['tldr', 'bullets', 'transcript'],
            },
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const detail = (await geminiRes.text().catch(() => '')).slice(0, 300);
      console.error('gemini error', geminiRes.status, detail);
      if (geminiRes.status === 429) return fail(res, 429, 'Transcription is rate-limited right now. Wait a minute and retry.');
      return fail(res, 502, 'Transcription failed. If this is a fresh WhatsApp download, retry; otherwise the file may be corrupt.');
    }

    const data = await geminiRes.json().catch(() => null);
    text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) {
      console.error('gemini empty response', JSON.stringify(data)?.slice(0, 300));
      return fail(res, 502, 'The transcriber returned nothing. Retry, or check the file plays.');
    }
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return fail(res, 504, timedOut
      ? 'Transcription timed out — that note may be too long. Try a shorter one.'
      : 'Could not reach the transcription service. Try again.');
  } finally {
    clearTimeout(timer);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, ''));
  } catch { /* fall through to raw-text fallback */ }

  if (!parsed || typeof parsed.transcript !== 'string') {
    return res.status(200).json({ tldr: '', bullets: [], transcript: text.trim(), language: '' });
  }
  return res.status(200).json({
    tldr: typeof parsed.tldr === 'string' ? parsed.tldr : '',
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets.filter((b) => typeof b === 'string') : [],
    transcript: parsed.transcript,
    language: typeof parsed.language === 'string' && parsed.language.length <= 30 ? parsed.language : '',
  });
};
