// Google Places API (New) enrichment — official, structured venue data:
// opening hours + Google rating + business status, ~$0.03/place/month.
//
// Trust model: Places is authoritative for DROP-IN venue hours and Google
// ratings. It knows nothing about curtain times or critic stars, so shows
// (entry:'show') keep their agent-verified showTimes and critic ratings are
// never overwritten. A strict match guard (distance + name similarity) makes
// sure we never attach another venue's hours to ours.

import { deadline } from './deadline.mjs';

const API = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.regularOpeningHours,places.businessStatus,places.googleMapsUri';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function getPlacesKey() {
  return process.env.GOOGLE_PLACES_API_KEY || null;
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/** Token-overlap name similarity in [0,1]; containment counts as a match. */
export function nameSimilarity(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na.includes(nb) || nb.includes(na)) return 1;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

function haversineM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Places `periods` -> our weekly hours map. Returns null if unusable. */
export function periodsToHours(regular) {
  const periods = regular?.periods;
  if (!Array.isArray(periods) || !periods.length) return null;
  // 24/7: a single period with open day 0 at 00:00 and no close
  if (periods.length === 1 && periods[0].open && !periods[0].close) {
    const all = {}; for (const d of DAY_KEYS) all[d] = [['00:00', '23:59']];
    return all;
  }
  const out = {}; for (const d of DAY_KEYS) out[d] = [];
  for (const p of periods) {
    const o = p.open, c = p.close;
    if (!o || !c || o.day == null) continue;
    const day = DAY_KEYS[o.day];
    const hh = n => String(n || 0).padStart(2, '0');
    // overnight close lands on the next day; our format keeps it on the open
    // day as close<open (dayWindows() adds 24h)
    out[day].push([`${hh(o.hour)}:${hh(o.minute)}`, `${hh(c.hour)}:${hh(c.minute)}`]);
  }
  return Object.values(out).some(w => w.length) ? out : null;
}

/**
 * Look one place up. Returns null when no confident match:
 *  - top result must sit within `maxDistM` of our verified coords
 *  - and its name must resemble ours (venue name for shows)
 */
export async function placesLookup(place, { key, maxDistM = 250, signal, requestTimeoutMs = 10000 } = {}) {
  signal?.throwIfAborted();
  if (!key || place.lat == null || place.lng == null) return null;
  const query = `${place.venue && place.venue !== place.name ? place.venue : place.name}, ${place.area || ''} London`;
  const request = deadline(requestTimeoutMs, signal);
  let data;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify({
        textQuery: query,
        locationBias: { circle: { center: { latitude: place.lat, longitude: place.lng }, radius: 400 } },
        maxResultCount: 1
      }),
      signal: request.signal
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error('places-provider-failed');
    }
    data = await res.json();
  } finally { request.dispose(); }
  const hit = data.places?.[0];
  if (!hit?.location) return null;
  const distM = Math.round(haversineM(place, { lat: hit.location.latitude, lng: hit.location.longitude }));
  const sim = Math.max(nameSimilarity(place.name, hit.displayName?.text), nameSimilarity(place.venue, hit.displayName?.text));
  if (distM > maxDistM || sim < 0.5) return null; // not confidently the same venue
  return {
    matchedName: hit.displayName?.text,
    distM, sim,
    rating: typeof hit.rating === 'number' ? Math.round(hit.rating * 10) / 10 : null,
    ratingCount: hit.userRatingCount || null,
    hours: periodsToHours(hit.regularOpeningHours),
    businessStatus: hit.businessStatus || null,
    mapsUri: hit.googleMapsUri || null
  };
}

const isGoogleSource = s => /^google/i.test(String(s || ''));

/**
 * Enrich a dataset in place. Policy:
 *  - drop-in venues: Places hours replace/fill hours (fresher than any snapshot)
 *  - shows keep showTimes; Places may still fill the venue's building hours
 *  - rating: fill when missing, refresh only Google-sourced ratings; critic
 *    ratings are never touched
 *  - CLOSED_* business status is recorded, never silently dropped
 */
export async function enrichWithPlaces(dataset, { key, concurrency = 4, onProgress, signal } = {}) {
  signal?.throwIfAborted();
  if (!key) return { enriched: 0, hoursSet: 0, hoursKeptOfficial: 0, ratingsSet: 0, closedFlags: [], misses: [] };
  const queue = [...dataset.places];
  const stats = { enriched: 0, hoursSet: 0, hoursKeptOfficial: 0, ratingsSet: 0, closedFlags: [], misses: [] };
  async function worker() {
    while (queue.length) {
      signal?.throwIfAborted();
      const p = queue.shift();
      let r = null;
      try { r = await placesLookup(p, { key, signal }); }
      catch { signal?.throwIfAborted(); stats.misses.push(`${p.id}: lookup-failed`); continue; }
      if (!r) { stats.misses.push(`${p.id}: no confident match`); continue; }
      stats.enriched++;
      if (r.businessStatus && r.businessStatus !== 'OPERATIONAL') {
        stats.closedFlags.push(`${p.id} (${p.name}): ${r.businessStatus}`);
      }
      // Hours: official-site-verified hours outrank Google's aggregate, so
      // Places only fills gaps or refreshes hours it set itself earlier.
      // Timed/show-like categories never become drop-ins off the back of a
      // Google listing.
      const showLike = p.entry === 'show' || (!p.entry && (p.category === 'theatre' || p.category === 'immersive'));
      const placesOwned = /google\.com\/maps|maps\.app\.goo/i.test(String(p.hoursUrl || ''));
      if (r.hours && !showLike && (!p.hours || placesOwned)) {
        p.hours = r.hours;
        p.hoursCheckedAt = new Date().toISOString();
        p.entry = p.entry || 'dropin';
        if (r.mapsUri) p.hoursUrl = r.mapsUri;
        stats.hoursSet++;
      } else if (r.hours && p.hours && !placesOwned) {
        stats.hoursKeptOfficial++;
      }
      // Ratings: productions keep critic stars only — a venue's Google score
      // is not a rating of the show. Venues fill/refresh Google ratings.
      if (r.rating != null && p.entry !== 'show' && (!p.rating || isGoogleSource(p.rating.source))) {
        p.rating = { value: r.rating, scale: 5, source: 'Google', url: r.mapsUri || (p.rating && p.rating.url) || '' };
        p.ratingCheckedAt = new Date().toISOString();
        if (r.ratingCount >= 50) p.rating.ratingCount = r.ratingCount;
        stats.ratingsSet++;
      }
      onProgress?.(p.id);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}
