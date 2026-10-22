// Abuse and spend controls shared by the paid Gemini endpoints
// (api/transcribe.js, api/tracks-ocr.js). Security backlog: issue #2, P0.
//
// 1. Origin: every request must carry an allowed Origin. Browsers always send
//    one on POST, so a missing Origin means a script, not the sam.toys pages.
//    Origin is forgeable by scripts, so it is friction, not the budget.
// 2. Durable budget: per-client counters (5-minute window + UTC day) and one
//    global daily ceiling shared by both endpoints, held in a Redis REST store
//    (Vercel KV / Upstash: KV_REST_API_URL + KV_REST_API_TOKEN, or the
//    UPSTASH_REDIS_REST_* names). Counters survive cold starts and instances.
// 3. Fail closed: with no store configured, or when the store errors, a low
//    per-instance in-memory budget applies instead of the durable one.
//
// GEMINI_DAILY_CALL_CEILING sets the global daily ceiling (Gemini calls per
// UTC day across both endpoints; default 200). Never log env values.

const crypto = require('crypto');

const ALLOWED_ORIGINS = /^(https:\/\/(sam\.toys|www\.sam\.toys|sam-toys-[\w-]+\.vercel\.app)|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

const DEFAULT_DAILY_CEILING = 200;
const MAX_DAILY_CEILING = 100_000;
const STORE_TIMEOUT_MS = 3_000;
const DAY_TTL_S = 2 * 86_400;

const POLICIES = {
  transcribe: { windowMs: 5 * 60_000, perWindow: 10, perDay: 30 },
  'tracks-ocr': { windowMs: 5 * 60_000, perWindow: 20, perDay: 60 },
};

// Low per-instance limits used only when the durable store is missing or down.
const FALLBACK = { perWindow: 5, perDay: 15, globalPerDay: 25, maxClients: 5_000 };

function originAllowed(req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  return typeof origin === 'string' && ALLOWED_ORIGINS.test(origin);
}

function clientIp(req) {
  const h = (req && req.headers) || {};
  const real = typeof h['x-real-ip'] === 'string' ? h['x-real-ip'].trim() : '';
  if (real) return real;
  return String(h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Store keys carry a hash, never the raw IP.
function clientId(req) {
  return crypto.createHash('sha256').update(`sam.toys:${clientIp(req)}`).digest('hex').slice(0, 32);
}

function dailyCeiling() {
  const raw = process.env.GEMINI_DAILY_CALL_CEILING;
  if (raw == null || raw === '') return DEFAULT_DAILY_CEILING;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_DAILY_CEILING;
  return Math.min(n, MAX_DAILY_CEILING);
}

function storeConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!token || !/^https:\/\/[^\s/]+/.test(url)) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

// Increments each key (creating it with its TTL first) and returns the new counts.
async function incrAll(cfg, items) {
  const cmds = [];
  for (const { key, ttl } of items) cmds.push(['SET', key, '0', 'EX', String(ttl), 'NX'], ['INCR', key]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS);
  try {
    const r = await fetch(`${cfg.url}/pipeline`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!r.ok) throw new Error(`store status ${r.status}`);
    const out = await r.json();
    if (!Array.isArray(out) || out.length !== cmds.length) throw new Error('store reply shape');
    return items.map((_, i) => {
      const set = out[i * 2];
      const incr = out[i * 2 + 1];
      if (!set || set.error != null || !incr || incr.error != null || !Number.isInteger(incr.result)) {
        throw new Error('store command error');
      }
      return incr.result;
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---- in-memory fallback (per instance; deliberately low) ----
const mem = { day: '', global: 0, clients: new Map() };
let warnedNoStore = false;

function memoryReserve(policy, id, now, day, ceiling) {
  if (mem.day !== day) { mem.day = day; mem.global = 0; mem.clients.clear(); }
  const win = Math.floor(now / policy.windowMs);
  let rec = mem.clients.get(id);
  if (!rec) {
    if (mem.clients.size >= FALLBACK.maxClients) return { ok: false, scope: 'global' };
    rec = { win, wn: 0, dn: 0 };
    mem.clients.set(id, rec);
  }
  if (rec.win !== win) { rec.win = win; rec.wn = 0; }
  rec.wn += 1;
  rec.dn += 1;
  if (rec.wn > Math.min(policy.perWindow, FALLBACK.perWindow) || rec.dn > Math.min(policy.perDay, FALLBACK.perDay)) {
    return { ok: false, scope: 'client' };
  }
  if (mem.global >= Math.min(ceiling, FALLBACK.globalPerDay)) return { ok: false, scope: 'global' };
  mem.global += 1;
  return { ok: true, durable: false };
}

// Reserves one Gemini call for this client. Call it after validation, right
// before the paid request. Returns { ok, scope?: 'client'|'global', durable }.
async function reserveGeminiCall(endpoint, req) {
  const policy = POLICIES[endpoint];
  if (!policy) throw new Error(`unknown gemini endpoint ${endpoint}`);
  const id = clientId(req);
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const ceiling = dailyCeiling();
  const cfg = storeConfig();

  if (cfg) {
    try {
      const win = Math.floor(now / policy.windowMs);
      const winTtl = Math.ceil(policy.windowMs / 1000) + 60;
      const [w, d] = await incrAll(cfg, [
        { key: `gq:${endpoint}:w:${win}:${id}`, ttl: winTtl },
        { key: `gq:${endpoint}:d:${day}:${id}`, ttl: DAY_TTL_S },
      ]);
      if (w > policy.perWindow || d > policy.perDay) return { ok: false, scope: 'client', durable: true };
      // Only requests within the client's own budget count toward the global ceiling.
      const [g] = await incrAll(cfg, [{ key: `gq:all:d:${day}`, ttl: DAY_TTL_S }]);
      if (g > ceiling) return { ok: false, scope: 'global', durable: true };
      return { ok: true, durable: true };
    } catch (err) {
      console.error('gemini quota store unavailable; using in-memory fallback:', err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'error');
    }
  } else if (!warnedNoStore) {
    warnedNoStore = true;
    console.warn('gemini quota: no KV store configured; using low in-memory fallback limits');
  }
  return memoryReserve(policy, id, now, day, ceiling);
}

function _resetForTests() {
  mem.day = '';
  mem.global = 0;
  mem.clients.clear();
  warnedNoStore = false;
}

module.exports = {
  ALLOWED_ORIGINS,
  DEFAULT_DAILY_CEILING,
  FALLBACK,
  POLICIES,
  originAllowed,
  clientIp,
  reserveGeminiCall,
  _resetForTests,
};
