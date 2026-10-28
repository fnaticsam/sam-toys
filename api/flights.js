const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const { createClient, UpstreamError } = require('./_lib/flights/mcp');
const { InputError, parseInput, toolInput, validDate } = require('./_lib/flights/input');
const { DEFAULT_ORIGINS, CARRIERS, SOURCES } = require('./_lib/flights/carriers');
const { FX, RULES_DATE, ELIGIBLE_SPEND_FRACTION, collectionYear, goldThreshold, BONUS_SOURCE, GOLD_SOURCE } = require('./_lib/flights/earn');
const { normalizeFlight, safeLink } = require('./_lib/flights/normalize');
const { rank } = require('./_lib/flights/rank');

// Open API. Origin is browser defence in depth, not authentication. Vercel
// supplies x-forwarded-proto; other proxies must overwrite it themselves.
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  const host = req.headers?.host;
  const protocol = req.headers?.['x-forwarded-proto'] ?? (req.socket?.encrypted ? 'https' : 'http');
  if (typeof origin !== 'string' || origin.length > 512 || typeof host !== 'string' || /[\s\\/@?#]/.test(host) ||
      !['http', 'https'].includes(protocol)) return false;
  try {
    const target = new URL(`${protocol}://${host}`);
    const source = new URL(origin);
    return source.origin === origin && source.origin === target.origin;
  } catch { return false; }
}
function createCache({ now, ttlMs = 600000, capacity = 64 }) {
  const entries = new Map();
  const prune = () => {
    const time = now();
    for (const [key, entry] of entries) if (entry.until <= time) entries.delete(key);
  };
  return {
    get(key) { prune(); return entries.get(key)?.body; },
    set(key, body) {
      prune();
      entries.delete(key);
      if (capacity <= 0) return;
      if (entries.size >= capacity) entries.delete(entries.keys().next().value);
      entries.set(key, { body, until: now() + ttlMs });
    },
  };
}
function cacheKey(query) {
  // Parameter order, case, explicit defaults and set order share one entry.
  return JSON.stringify({ ...query, origins: [...query.origins].sort(), airlines: [...query.airlines].sort() });
}
function createThrottle({ now, max = 5, windowMs = 60000, capacity = 512 }) {
  const entries = new Map();
  return (ip) => {
    const time = now();
    for (const [key, entry] of entries) if (entry.until <= time) entries.delete(key);
    // Hash addresses; retain only a small bounded in-memory map for a minute.
    const key = createHash('sha256').update(ip).digest('hex');
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= capacity) return { ok: false, retryAfter: 60 };
      entry = { count: 0, until: time + windowMs }; entries.set(key, entry);
    }
    return { ok: ++entry.count <= max, retryAfter: Math.max(1, Math.ceil((entry.until - time) / 1000)) };
  };
}
function clientIp(req) {
  // Vercel overwrites x-real-ip. Other runtimes must strip it at the proxy.
  // Do not trust arbitrary x-forwarded-for chains. Missing IPs share a bucket.
  const ip = req.headers?.['x-real-ip'];
  return typeof ip === 'string' && isIP(ip) ? ip : (isIP(req.socket?.remoteAddress || '') ? req.socket.remoteAddress : 'unknown');
}
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.end(JSON.stringify(body));
}
function discovery(data, query, origin) {
  if (query.action === 'anywhere') {
    if (!Array.isArray(data?.results) || data.results.length > 1000) throw new UpstreamError('invalid-upstream-response');
    return data.results.filter((r) => /^[A-Z]{3}$/.test(r.destination?.airport) &&
      Number.isFinite(r.price?.amount) && r.price.amount > 0 && r.price.currency === 'USD' && safeLink(r.deepLink))
      .map((r) => ({ origin, destination: r.destination.airport, price: r.price,
        priceGbp: Math.round(r.price.amount * FX.usdToGbp * 100) / 100, deepLink: safeLink(r.deepLink),
        eligibility: 'unverified', estimate: null, requiresSearch: true }));
  }
  if (!Array.isArray(data?.chart?.points) || data.chart.points.length > 1000) throw new UpstreamError('invalid-upstream-response');
  return data.chart.points.filter((p) => validDate(p.departure) && (!p.return || validDate(p.return)) && Number.isFinite(p.price) && p.price > 0)
    .map((p) => ({ origin, destination: query.destination, departureDate: p.departure,
      returnDate: p.return || null, price: { amount: p.price, currency: 'USD' },
      priceGbp: Math.round(p.price * FX.usdToGbp * 100) / 100,
      eligibility: 'unverified', estimate: null, requiresSearch: true }));
}
function createHandler({ callTool = createClient(), now = Date.now,
  requestTimeoutMs = 18000, cacheOptions = {},
  throttleOptions = {}, maxConcurrentRequests = 2 } = {}) {
  const throttle = createThrottle({ now, ...throttleOptions });
  const cache = createCache({ now, ...cacheOptions });
  let active = 0;
  return async function flights(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { error: 'Method not allowed.' }); }
    if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin requests are not allowed.' });
    const admission = throttle(clientIp(req));
    if (!admission.ok) { res.setHeader('Retry-After', String(admission.retryAfter)); return send(res, 429, { error: 'Too many requests.' }); }
    let query;
    try { query = parseInput(req.url, now()); }
    catch (error) { return send(res, 400, { error: error instanceof InputError ? error.message : 'Invalid parameters.' }); }
    const key = cacheKey(query), cached = cache.get(key);
    if (cached) return send(res, 200, cached);
    if (active >= maxConcurrentRequests) { res.setHeader('Retry-After', '5'); return send(res, 429, { error: 'Flights API is busy.' }); }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onAborted = () => controller.abort();
    req.once?.('aborted', onAborted);
    try {
      let cursor = 0;
      const results = [], failures = [], pages = [], excluded = {};
      // At most 7 origins, 3 calls in flight, 6 s per call and 18 s overall.
      // No retries and no discovery → search cascade against the public MCP.
      async function worker() {
        while (cursor < query.origins.length) {
          const origin = query.origins[cursor++];
          if (controller.signal.aborted) { failures.push({ origin, code: 'upstream-timeout' }); continue; }
          try {
            const { name, args } = toolInput(query, origin);
            const data = await callTool(name, args, controller.signal);
            if (query.action === 'search') {
              if (!Array.isArray(data?.flights) || data.flights.length > 100) throw new UpstreamError('invalid-upstream-response');
              // Process in isolation before publishing results, so a malformed
              // origin cannot leave half-normalized fares in a partial response.
              const normalized = data.flights.map((f) => normalizeFlight(f, { ...query, origin }));
              for (const item of normalized) {
                if (item.flight) results.push(item.flight);
                else excluded[item.excluded] = (excluded[item.excluded] || 0) + 1;
              }
              const p = data.pagination;
              pages.push({ origin, offset: query.offset, limit: query.limit,
                totalAvailable: Number.isInteger(p?.totalAvailable) ? p.totalAvailable : null,
                hasMoreResults: p?.hasMoreResults === true });
            } else {
              const items = discovery(data, query, origin);
              results.push(...items); pages.push({ origin });
            }
          } catch (error) {
            failures.push({ origin, code: error instanceof UpstreamError ? error.code : 'invalid-upstream-response' });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, query.origins.length) }, worker));
      if (!pages.length) {
        const timedOut = failures.some((f) => f.code === 'upstream-timeout');
        return send(res, timedOut ? 504 : 502, { error: timedOut ? 'Flight provider timed out.' : 'Flight provider unavailable.' });
      }
      const dateKey = query.mode === 'return' ? 'returnDate' : 'departureDate';
      const sorted = query.action === 'search' ? rank(results) : results.sort((a, b) =>
        query.action === 'flex' && query.sort === 'date' ? (a[dateKey] || a.departureDate).localeCompare(b[dateKey] || b.departureDate) || a.priceGbp - b.priceGbp : a.priceGbp - b.priceGbp);
      const body = { action: query.action, results: sorted, partial: failures.length > 0,
        failures, excluded, pages, meta: {
          defaultOrigins: DEFAULT_ORIGINS, carriers: Object.values(CARRIERS), rulesAsOf: RULES_DATE,
          fx: FX, eligibleSpendFraction: ELIGIBLE_SPEND_FRACTION, memberTier: 'Gold',
          collectionYear: collectionYear(query.departureDate), goldThreshold: goldThreshold(query.departureDate),
          sources: { ...SOURCES, gold: GOLD_SOURCE, extraTierPoints: BONUS_SOURCE },
          ranking: query.action === 'search' ? 'GBP-per-estimated-tier-point-then-price' : null,
          discoveryOnly: query.action !== 'search',
          notice: query.action === 'search' ? 'Estimates only; verify booking class, operator and earning with BA before buying. Search covers returned fares, not every fare available.' :
            'Unfiltered discovery prices may be on non-earning airlines. Run search for each destination/date before comparing tier-point value.',
        } };
      // Retry incomplete responses on the next request; never cache failures.
      if (!body.partial) cache.set(key, body);
      return send(res, 200, body);
    } finally {
      clearTimeout(timer); req.removeListener?.('aborted', onAborted); active--;
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.createThrottle = createThrottle;
