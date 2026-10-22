// Research pipeline: for each category, ask Gemini (grounded on Google Search)
// for a structured top-5, then normalise into the dataset shape the map reads.

import { groundedGenerate, extractJson } from './gemini.mjs';
import { CATEGORIES, CATEGORY_BY_ID, inLondon, TOP_N } from './categories.mjs';
import { isoDate, londonDate, hasDateWindow, isTimeLimited, isRecent } from '../../../ldn/validity.mjs';

const VOICE = [
  'Voice: dry, precise, lightly witty. Brevity is the brand.',
  'No hype words ("iconic", "must-visit", "hidden gem", "vibrant"), no exclamation marks, no emoji.',
  'Each "why" is ONE sentence, under 22 words, telling a discerning Londoner what this place IS and its character.',
  'The "hook" is a DIFFERENT one-liner (under 16 words) completing the sentence "You\'ll like this because…" — the single most distinctive reason to pick THIS one over the alternatives (the thing you cannot get elsewhere). Do not repeat the "why".'
].join(' ');

function prompt(cat, month) {
  return `You are compiling the definitive top ${TOP_N} for a monthly London culture map. Category: "${cat.label}".
${cat.guidance}

Current month: ${month}. Use Google Search to ground every fact in real, current sources.

Return the ${TOP_N} best in London right now, ranked 1 (best) to ${TOP_N}. For each, decide a "tier":
- "evergreen" = a standing institution/venue worth knowing any month.
- "this-month" = something specifically happening in or around ${month} (a production, exhibition, run, or limited experience). Only use "this-month" if you can ground an actual current/upcoming date window.

Prefer a mix that reflects reality for this category. For theatre and immersive, favour "this-month" productions with real date windows. All ${TOP_N} must be genuinely worth recommending — do not pad with weak entries.

${VOICE}

Respond with ONLY a JSON array of exactly ${TOP_N} objects, no prose, in this exact shape:
[
  {
    "name": "string — the venue or production name",
    "venue": "string — for a production, the theatre/venue hosting it; else same as name",
    "area": "string — London neighbourhood, e.g. Soho, Southbank, Dalston",
    "address": "string — full street address including postcode",
    "lat": number,   // precise decimal latitude of the venue in London
    "lng": number,   // precise decimal longitude
    "why": "string — one dry sentence describing what it is (see voice rules)",
    "hook": "string — the 'You'll like this because…' one-liner, under 16 words (see voice rules)",
    "priceBand": "one of: Free, £, ££, £££, ££££",
    "url": "string — official website URL",
    "tier": "evergreen" | "this-month",
    "validFrom": "YYYY-MM-DD — first date of the run, or null if not confirmed",
    "validTo": "YYYY-MM-DD — last date of the run, or null if not confirmed",
    "thisMonth": { "headline": "string", "dates": "string e.g. 'until 30 Aug 2026'", "detail": "string, optional" },
    "rating": { "value": number, "scale": 5, "source": "string e.g. Time Out / Google / The Guardian", "sourceUrl": "string — page where the rating appears" }
  }
]
Rules: coordinates must be the venue's real location in Greater London. "thisMonth" is required when tier is "this-month" and omitted otherwise.
"validFrom" and "validTo": for time-limited entries, ground both calendar dates in the official event listing. Do not infer dates from the current month or parse a vague phrase into a date. Use null when uncertain; omit both for evergreen venues.
"rating": include ONLY a rating you can attribute to a real named source you grounded (critic stars out of 5 for shows/exhibitions; Time Out or Google out of 5 for venues). Set "rating" to null if you cannot ground a real one — NEVER invent a rating or a source. Output valid JSON only.`;
}

export function clampWhy(s, words = 26) {
  if (!s) return '';
  const w = String(s).trim().replace(/\s+/g, ' ').split(' ');
  let out = w.slice(0, words).join(' ');
  out = out.replace(/[!]+/g, '.'); // enforce no exclamation marks
  return out;
}

export function normalizePlace(cat, raw, rank) {
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const coordsOk = inLondon(lat, lng);
  const tier = raw.tier === 'this-month' ? 'this-month' : 'evergreen';
  const place = {
    id: `${cat.id}-${rank}`,
    category: cat.id,
    rank,
    name: String(raw.name || '').trim(),
    venue: String(raw.venue || raw.name || '').trim(),
    area: String(raw.area || '').trim(),
    address: String(raw.address || '').trim(),
    lat: coordsOk ? lat : null,
    lng: coordsOk ? lng : null,
    coordsVerified: coordsOk,
    why: clampWhy(raw.why),
    hook: clampWhy(raw.hook, 18),
    priceBand: normBand(raw.priceBand),
    url: cleanUrl(raw.url),
    tier
  };
  if (tier === 'this-month') {
    // Preserve uncertainty explicitly; prose dates are never guessed into a run.
    place.validFrom = isoDate(raw.validFrom);
    place.validTo = isoDate(raw.validTo);
    if (!hasDateWindow(place)) place.validFrom = place.validTo = null;
  }
  if (tier === 'this-month' && raw.thisMonth) {
    place.thisMonth = {
      headline: String(raw.thisMonth.headline || '').trim(),
      dates: String(raw.thisMonth.dates || '').trim(),
      detail: String(raw.thisMonth.detail || '').trim() || undefined
    };
  }
  const rating = normalizeRating(raw.rating);
  if (rating) place.rating = rating;
  return place;
}

export function normalizeRating(r) {
  if (!r || r.value == null) return null;
  const value = Number(r.value);
  if (!isFinite(value) || value <= 0) return null;
  const scale = Number(r.scale) === 10 ? 10 : 5;
  if (value > scale) return null; // guard against garbage
  const source = String(r.source || '').trim();
  const url = cleanUrl(r.sourceUrl || r.url);
  if (!source || !url) return null; // must be attributable to a real source page
  const out = { value: Math.round(value * 10) / 10, scale, source, url };
  const count = Number(r.ratingCount);
  if (isFinite(count) && count > 0) out.ratingCount = Math.round(count);
  return out;
}

function normBand(b) {
  const s = String(b || '').trim();
  if (/free/i.test(s)) return 'Free';
  const m = s.match(/£+/);
  if (m) return m[0].slice(0, 4);
  return '££';
}

function cleanUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(s)) return 'https://' + s;
  return '';
}

/** Research one category. Returns { category, places, sources, queries }. */
export async function researchCategory(cat, { month, signal } = {}) {
  const { text, sources, queries } = await groundedGenerate({
    prompt: prompt(cat, month),
    temperature: 0.35,
    signal
  });
  let arr;
  try {
    arr = extractJson(text);
  } catch (e) {
    throw new Error(`[${cat.id}] JSON parse failed: ${e.message}`);
  }
  if (!Array.isArray(arr)) throw new Error(`[${cat.id}] expected array`);
  const places = arr
    .slice(0, TOP_N)
    .map((raw, i) => normalizePlace(cat, raw, i + 1))
    .filter(p => p.name);
  return { category: cat.id, places, sources, queries };
}

/** Research all categories with bounded concurrency. */
export async function researchAll({ month, concurrency = 3, onProgress, signal } = {}) {
  const results = [];
  const queue = [...CATEGORIES];
  async function worker() {
    while (queue.length) {
      const cat = queue.shift();
      let r = null, lastErr = null;
      // one retry: a single parse/API flake shouldn't cost the whole monthly run
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try {
          const got = await researchCategory(cat, { month, signal });
          if (got.places.length) r = got; else lastErr = new Error('0 places');
        } catch (err) { lastErr = err; }
      }
      if (r) {
        results.push(r);
        onProgress?.({ category: cat.id, ok: true, count: r.places.length });
      } else {
        results.push({ category: cat.id, places: [], error: lastErr?.message });
        onProgress?.({ category: cat.id, ok: false, error: lastErr?.message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Carry only recent enrichment for the same venue and, for events, same run. */
export function carryOverEnrichment(prev, next) {
  if (!prev?.places?.length || !next?.places?.length) return { carried: 0 };
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const key = p => `${p.category}|${norm(p.name)}`;
  const prevBy = new Map();
  for (const p of prev.places) {
    // An ambiguous previous match is not evidence that these are the same place.
    prevBy.set(key(p), prevBy.has(key(p)) ? null : p);
  }
  const sameVenue = (a, b) => {
    if (!norm(a.venue) || norm(a.venue) !== norm(b.venue)) return false;
    const aa = norm(a.address), ba = norm(b.address);
    if (aa && ba && aa !== ba) return false;
    const coords = [a.lat, a.lng, b.lat, b.lng];
    if (coords.every(n => typeof n === 'number' && Number.isFinite(n))) {
      // A conservative ~100m radius allows rounding, not a move across town.
      const metres = Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 69000);
      return metres <= 100;
    }
    return !!aa && aa === ba;
  };
  const now = next.generatedAt || new Date().toISOString();
  const refreshDate = Number.isFinite(Date.parse(now)) ? londonDate(new Date(now)) : null;
  const checkedAt = (p, field) => p[field] || (prev.verified === true ? prev.generatedAt : null);
  let carried = 0;
  for (const p of next.places) {
    const old = prevBy.get(key(p));
    if (!old || !sameVenue(old, p)) continue;
    const timed = isTimeLimited(old) || isTimeLimited(p);
    const sameRun = !timed || (hasDateWindow(old) && hasDateWindow(p) &&
      old.validFrom === p.validFrom && old.validTo === p.validTo && refreshDate && p.validTo >= refreshDate);
    let touched = false;
    const carry = (field, stamp, extra = []) => {
      const checked = checkedAt(old, stamp);
      if (p[field] || !old[field] || !isRecent(checked, now)) return;
      p[field] = structuredClone(old[field]);
      p[stamp] = checked; // Preserve age through subsequent monthly refreshes.
      for (const k of extra) if (p[k] == null && old[k] != null) p[k] = structuredClone(old[k]);
      touched = true;
    };
    if (sameRun) {
      carry('hours', 'hoursCheckedAt', ['entry', 'hoursUrl']);
      carry('showTimes', 'showTimesCheckedAt', ['entry', 'runtimeMins', 'hoursUrl']);
      carry('rating', 'ratingCheckedAt');
    }
    if (touched) carried++;
  }
  return { carried };
}

/** Assemble the final dataset object the map consumes. */
export function buildDataset(results, { month, generatedAt }) {
  const byId = Object.fromEntries(results.map(r => [r.category, r]));
  const places = [];
  for (const cat of CATEGORIES) {
    const r = byId[cat.id];
    if (r?.places?.length) places.push(...r.places);
  }
  return {
    month,
    generatedAt,
    city: 'London',
    categories: CATEGORIES.map(({ id, label, short, color, blurb }) => ({ id, label, short, color, blurb })),
    places,
    sources: Object.fromEntries(results.map(r => [r.category, (r.sources || []).slice(0, 5)]))
  };
}
