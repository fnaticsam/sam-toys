// Minimal Gemini client with Google Search grounding.
// Uses the Generative Language REST API (v1beta) so it runs with a plain
// GEMINI_API_KEY and no SDK / build step — matching the TBB.ceo house style.
//
// Grounding note: the google_search tool cannot be combined with a JSON
// responseSchema, so we ask for JSON in the prompt and extract it robustly.

import { deadline, pause } from './deadline.mjs';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.5-flash';

export function getApiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  return key;
}

/**
 * Grounded generation. Returns { text, sources, queries, raw }.
 * sources: [{ title, uri }] deduped from groundingChunks.
 */
export async function groundedGenerate({
  prompt,
  model = DEFAULT_MODEL,
  temperature = 0.4,
  systemInstruction,
  grounded = true,
  maxRetries = 2,
  signal,
  requestTimeoutMs = 45000
} = {}) {
  if (!prompt) throw new Error('groundedGenerate: prompt required');
  const key = getApiKey();
  const url = `${API_BASE}/models/${model}:generateContent`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: 32768 }
  };
  if (grounded) body.tools = [{ google_search: {} }];
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };

  const retries = Math.max(0, Math.min(2, Number.isInteger(maxRetries) ? maxRetries : 2));
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    const request = deadline(requestTimeoutMs, signal);
    let retryDelay = backoff(attempt);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: request.signal
      });
      if (!res.ok) {
        // Never retain raw provider error content or retry permanent HTTP errors.
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        retryDelay = retryAfter(res.headers?.get('retry-after')) ?? retryDelay;
        await res.body?.cancel();
        throw Object.assign(new Error('research-provider-failed'), { status: res.status, retryable });
      }
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || [])
        .map(p => p.text || '')
        .join('')
        .trim();
      const gm = cand?.groundingMetadata || {};
      const sources = dedupeSources(
        (gm.groundingChunks || [])
          .map(c => c.web && { title: c.web.title || c.web.uri, uri: c.web.uri })
          .filter(Boolean)
      );
      return { text, sources, queries: gm.webSearchQueries || [], raw: data };
    } catch (err) {
      signal?.throwIfAborted();
      const retryable = err.retryable === true || request.signal.aborted || err instanceof TypeError;
      if (!retryable || attempt === retries) throw err;
    } finally {
      request.dispose();
    }
    await pause(retryDelay, signal);
  }
}

/** Pull the first well-formed JSON object/array out of a model response. */
export function extractJson(text) {
  if (!text) throw new Error('extractJson: empty text');
  // Strip code fences if present.
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Fast path.
  try { return JSON.parse(t); } catch { /* fall through */ }
  // Find the outermost { } or [ ] span.
  const start = t.search(/[[{]/);
  if (start === -1) throw new Error('extractJson: no JSON found');
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = t.slice(start, i + 1);
        return JSON.parse(slice);
      }
    }
  }
  throw new Error('extractJson: unbalanced JSON');
}

function dedupeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    const k = s.uri;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, 8);
}

const backoff = (attempt) => Math.min(500 * 2 ** attempt, 8000);
function retryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 30000)) : null;
}
