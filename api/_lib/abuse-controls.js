// Private, shared CAS state. A successful reservation is required before paid work
// or password comparison. No IP address, prompt, password or model output is stored.
const crypto = require('crypto');
const { isIP } = require('net');
const DAY_MS = 86400000;
const LEASE_MS = 90000; // longer than every guarded function's 60s maximum lifetime
const DEADLINE_MS = 1500;
const MAX_ATTEMPTS = 6;
const failure = (status) => Object.assign(new Error(status === 429 ? 'rate-limited' : 'controls-unavailable'), { status });
const integer = (value, fallback, max) => {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw failure(503);
  return n;
};
function clientAddress(req) {
  // Vercel replaces x-real-ip at the ingress. Never trust client forwarded chains.
  const value = req.headers && req.headers['x-real-ip'];
  return typeof value === 'string' && isIP(value.trim()) ? value.trim() : 'unknown';
}
function policy(env) {
  return {
    paidDaily: integer(env.ABUSE_PAID_DAILY_LIMIT, 100, 10000),
    paidIpDaily: integer(env.ABUSE_PAID_IP_DAILY_LIMIT, 20, 10000),
    paidConcurrent: integer(env.ABUSE_PAID_CONCURRENCY, 3, 100),
    loginWindowMs: integer(env.ABUSE_LOGIN_WINDOW_SECONDS, 900, 86400) * 1000,
    loginGlobal: integer(env.ABUSE_LOGIN_GLOBAL_LIMIT, 200, 10000),
    loginIp: integer(env.ABUSE_LOGIN_IP_LIMIT, 10, 10000),
  };
}
function validCounts(value) {
  return value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length <= 10000 &&
    Object.entries(value).every(([key, count]) => /^[0-9a-f]{64}$/.test(key) && Number.isSafeInteger(count) && count > 0);
}
function validState(state) {
  return state && state.v === 1 && Number.isSafeInteger(state.period) && state.period >= 0 &&
    Number.isSafeInteger(state.count) && state.count >= 0 && validCounts(state.ips) &&
    state.count === Object.values(state.ips).reduce((sum, count) => sum + count, 0) &&
    state.leases && !Array.isArray(state.leases) && typeof state.leases === 'object' &&
    Object.keys(state.leases).length <= 100 && Object.entries(state.leases).every(([id, expiry]) =>
      /^[0-9a-f]{32}$/.test(id) && Number.isSafeInteger(expiry) && expiry > 0);
}
function createControls({ client, env = process.env, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const sdk = () => client || require('@vercel/blob');
  const token = () => {
    const value = env.ABUSE_CONTROL_READ_WRITE_TOKEN;
    if (typeof value !== 'string' || !value) throw failure(503);
    return value;
  };
  async function change(pathname, update) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
      const options = { access: 'private', token: token(), abortSignal: controller.signal };
      const store = sdk();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (controller.signal.aborted) throw failure(503);
        let read;
        try { read = await store.get(pathname, { ...options, useCache: false }); }
        catch (error) {
          if (!(store.BlobNotFoundError && error instanceof store.BlobNotFoundError)) throw error;
          read = null;
        }
        let state = null;
        if (read) {
          if (!read.blob || typeof read.blob.etag !== 'string' || !read.blob.etag) throw failure(503);
          const raw = await new Response(read.stream).text();
          if (raw.length > 2000000) throw failure(503);
          state = JSON.parse(raw);
          if (!validState(state)) throw failure(503);
        }
        const next = update(state);
        if (next === null) return; // idempotent release; no write needed
        try {
          await store.put(pathname, JSON.stringify(next), {
            ...options, addRandomSuffix: false, contentType: 'application/json',
            allowOverwrite: !!read, ...(read ? { ifMatch: read.blob.etag } : {}),
          });
          return;
        } catch (error) {
          // First-create collisions can be generic BlobError. Re-read on the
          // bounded retry; never assume a failed/ambiguous write granted admission.
          const conflict = store.BlobPreconditionFailedError && error instanceof store.BlobPreconditionFailedError;
          if (read && !conflict) throw error;
          if (attempt + 1 === MAX_ATTEMPTS) throw failure(503);
          await sleep(10 + Math.floor(Math.random() * 30));
        }
      }
      throw failure(503);
    } catch (error) {
      throw failure(error.status === 429 ? 429 : 503);
    } finally { clearTimeout(timer); }
  }
  function identity(req, period, surface) {
    return crypto.createHmac('sha256', token()).update(`${surface}|${period}|${clientAddress(req)}`).digest('hex');
  }
  function advance(state, period, time) {
    if (state && period < state.period) throw failure(503); // clock/config rollback must not reset limits
    const leases = Object.fromEntries(Object.entries(state?.leases || {}).filter(([, expiry]) => expiry > time));
    return state && period === state.period ? { ...state, leases } : { v: 1, period, count: 0, ips: {}, leases };
  }
  return {
    async reservePaid(req) {
      const limits = policy(env);
      const id = crypto.randomBytes(16).toString('hex');
      await change('controls/paid-v1.json', old => {
        const time = now(), period = Math.floor(time / DAY_MS);
        const state = advance(old, period, time), ip = identity(req, period, 'paid');
        if (state.count >= limits.paidDaily || (state.ips[ip] || 0) >= limits.paidIpDaily ||
            Object.keys(state.leases).length >= limits.paidConcurrent) throw failure(429);
        state.count++; state.ips[ip] = (state.ips[ip] || 0) + 1; state.leases[id] = time + LEASE_MS;
        return state;
      });
      return {
        async release() {
          try {
            await change('controls/paid-v1.json', state => {
              if (!state || !Object.hasOwn(state.leases, id)) return null;
              delete state.leases[id]; return state;
            });
          } catch {
            // Keep the reservation until its lease expires. Never refund spend
            // after a provider failure or uncertain write, and never log payloads.
            console.warn('abuse-controls: lease release unavailable');
          }
        },
      };
    },
    async checkLogin(req, surface) {
      if (!['dev', 'playa', 'londonplan'].includes(surface)) throw failure(503);
      const limits = policy(env);
      await change(`controls/login-${surface}-v1.json`, old => {
        const time = now(), period = Math.floor(time / limits.loginWindowMs) * limits.loginWindowMs;
        const state = advance(old, period, time), ip = identity(req, period, surface);
        if (state.count >= limits.loginGlobal || (state.ips[ip] || 0) >= limits.loginIp) throw failure(429);
        state.count++; state.ips[ip] = (state.ips[ip] || 0) + 1;
        return state;
      });
    },
  };
}
const controls = createControls();
module.exports = { createControls, clientAddress, reservePaid: req => controls.reservePaid(req), checkLogin: (req, surface) => controls.checkLogin(req, surface) };
