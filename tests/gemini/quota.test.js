// Tests for the Gemini abuse controls (api/_lib/gemini-quota.js) as wired into
// api/transcribe.js and api/tracks-ocr.js. Plain node, no network: global.fetch
// is stubbed with a fake Redis REST store and a fake Gemini.
// Usage: node tests/gemini/quota.test.js      (REPO_DIR overrides the repo location)
const assert = require('node:assert');
const path = require('path');

const REPO = process.env.REPO_DIR || path.resolve(__dirname, '..', '..');
const QUOTA = path.join(REPO, 'api', '_lib', 'gemini-quota.js');
const TRANSCRIBE = path.join(REPO, 'api', 'transcribe.js');
const OCR = path.join(REPO, 'api', 'tracks-ocr.js');
const STORE_URL = 'https://fake-kv.example.test';
const STORE_TOKEN = 'fake-kv-token-not-real';

process.env.GEMINI_API_KEY = 'test-gemini-key-not-real';
for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'GEMINI_DAILY_CALL_CEILING']) delete process.env[k];

// ---- fake Redis REST store (shared across "instances") + fake Gemini ----
const store = new Map();
let storeDown = false;
let geminiCalls = 0;
let storeCalls = 0;
global.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith(STORE_URL)) {
    storeCalls += 1;
    assert.strictEqual(url, `${STORE_URL}/pipeline`);
    assert.strictEqual(init.headers.Authorization, `Bearer ${STORE_TOKEN}`);
    if (storeDown) return new Response('down', { status: 500 });
    const out = JSON.parse(init.body).map(([cmd, key, val, ...rest]) => {
      if (cmd === 'SET') {
        assert.deepStrictEqual(rest.slice(0, 1), ['EX']);
        assert.strictEqual(rest[2], 'NX');
        if (store.has(key)) return { result: null };
        store.set(key, Number(val));
        return { result: 'OK' };
      }
      if (cmd === 'INCR') { store.set(key, (store.get(key) || 0) + 1); return { result: store.get(key) }; }
      return { error: `unexpected ${cmd}` };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    geminiCalls += 1;
    const text = url.includes('generateContent') && JSON.parse(init.body).contents[0].parts.some((p) => p.inline_data && p.inline_data.mime_type.startsWith('image/'))
      ? JSON.stringify({ rows: [] })
      : JSON.stringify({ tldr: 't', bullets: [], transcript: 'hello', language: 'English' });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// Fresh module instances model a cold start on a new serverless instance.
function coldStart() {
  for (const p of [QUOTA, TRANSCRIBE, OCR]) delete require.cache[require.resolve(p)];
  return { transcribe: require(TRANSCRIBE), ocr: require(OCR), quota: require(QUOTA) };
}

function mockRes() {
  return {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const AUDIO = Buffer.from('OggS\0\0\0\0hello-voice-note').toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
function req(kind, { ip = '203.0.113.1', origin = 'https://sam.toys', headers = {} } = {}) {
  const h = { 'content-type': 'application/json', 'x-real-ip': ip, ...headers };
  if (origin !== null) h.origin = origin;
  return { method: 'POST', headers: h, body: kind === 'ocr' ? { images: [{ data: PNG, mime: 'image/png' }] } : { audio: AUDIO, mime: 'audio/ogg' } };
}
async function call(mod, kind, opts) {
  const res = mockRes();
  await (kind === 'ocr' ? mod.ocr : mod.transcribe)(req(kind, opts), res);
  return res;
}
function useStore() { process.env.KV_REST_API_URL = STORE_URL; process.env.KV_REST_API_TOKEN = STORE_TOKEN; }
function noStore() { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; }
function reset() { store.clear(); storeDown = false; geminiCalls = 0; storeCalls = 0; delete process.env.GEMINI_DAILY_CALL_CEILING; }

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('missing Origin is rejected before any store or Gemini call (non-browser client)', async () => {
  reset(); useStore();
  const m = coldStart();
  for (const kind of ['transcribe', 'ocr']) {
    const res = await call(m, kind, { origin: null });
    assert.strictEqual(res.statusCode, 403, kind);
  }
  assert.strictEqual(geminiCalls, 0);
  assert.strictEqual(storeCalls, 0);
});

test('hostile, null and look-alike Origins are rejected', async () => {
  reset(); useStore();
  const m = coldStart();
  for (const origin of ['https://evil.example', 'null', '', 'http://sam.toys', 'https://sam.toys.evil.example', 'https://evilsam.toys']) {
    for (const kind of ['transcribe', 'ocr']) {
      const res = await call(m, kind, { origin });
      assert.strictEqual(res.statusCode, 403, `${kind} ${origin}`);
    }
  }
  assert.strictEqual(geminiCalls, 0);
});

test('allowed Origins pass', async () => {
  reset(); useStore();
  const m = coldStart();
  for (const origin of ['https://sam.toys', 'https://www.sam.toys', 'http://localhost:3000', 'https://sam-toys-abc123-team.vercel.app']) {
    const res = await call(m, 'transcribe', { origin, ip: `198.51.100.${origin.length}` });
    assert.strictEqual(res.statusCode, 200, origin);
  }
});

test('per-client window quota is durable across cold starts and instances', async () => {
  reset(); useStore();
  const limit = coldStart().quota.POLICIES.transcribe.perWindow;
  for (let i = 0; i < limit; i++) {
    const m = coldStart(); // every request lands on a fresh instance
    assert.strictEqual((await call(m, 'transcribe')).statusCode, 200, `request ${i + 1}`);
  }
  const res = await call(coldStart(), 'transcribe');
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.headers['retry-after'], '300');
  assert.strictEqual(geminiCalls, limit, 'rejected request never reaches Gemini');
  // a different client is unaffected
  assert.strictEqual((await call(coldStart(), 'transcribe', { ip: '203.0.113.99' })).statusCode, 200);
});

test('replayed requests count every time', async () => {
  reset(); useStore();
  const m = coldStart();
  const limit = m.quota.POLICIES['tracks-ocr'].perWindow;
  const statuses = [];
  for (let i = 0; i < limit + 3; i++) statuses.push((await call(m, 'ocr')).statusCode);
  assert.deepStrictEqual(statuses.filter((s) => s === 200).length, limit);
  assert.deepStrictEqual(statuses.slice(limit), [429, 429, 429]);
});

test('global daily ceiling is shared by both endpoints and many clients', async () => {
  reset(); useStore();
  process.env.GEMINI_DAILY_CALL_CEILING = '3';
  const m = coldStart();
  assert.strictEqual((await call(m, 'transcribe', { ip: '192.0.2.1' })).statusCode, 200);
  assert.strictEqual((await call(m, 'ocr', { ip: '192.0.2.2' })).statusCode, 200);
  assert.strictEqual((await call(coldStart(), 'transcribe', { ip: '192.0.2.3' })).statusCode, 200);
  const res = await call(coldStart(), 'ocr', { ip: '192.0.2.4' });
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.headers['retry-after'], '3600');
  assert.strictEqual(geminiCalls, 3);
});

test('a client over its own quota does not burn the global ceiling', async () => {
  reset(); useStore();
  const m = coldStart();
  const limit = m.quota.POLICIES.transcribe.perWindow;
  for (let i = 0; i < limit + 20; i++) await call(m, 'transcribe', { ip: '192.0.2.50' });
  const globalKey = [...store.keys()].find((k) => k.startsWith('gq:all:d:'));
  assert.strictEqual(store.get(globalKey), limit);
});

test('store keys never contain the raw client IP', async () => {
  reset(); useStore();
  await call(coldStart(), 'transcribe', { ip: '203.0.113.77' });
  assert.ok(store.size > 0);
  for (const k of store.keys()) assert.ok(!k.includes('203.0.113.77'), k);
});

test('invalid ceiling env falls back to the conservative default', async () => {
  reset();
  const q = coldStart().quota;
  assert.strictEqual(q.DEFAULT_DAILY_CEILING, 200);
  for (const v of ['abc', '-1', '1.5']) {
    process.env.GEMINI_DAILY_CALL_CEILING = v;
    useStore();
    store.set(`gq:all:d:${new Date().toISOString().slice(0, 10)}`, 199);
    const r1 = await q.reserveGeminiCall('transcribe', req('transcribe', { ip: `10.0.0.${v.length}` }));
    assert.strictEqual(r1.ok, true, v);
    const r2 = await q.reserveGeminiCall('transcribe', req('transcribe', { ip: `10.0.1.${v.length}` }));
    assert.deepStrictEqual([r2.ok, r2.scope], [false, 'global'], v);
    store.clear();
  }
});

test('no store configured: fails closed to a low in-memory limit', async () => {
  reset(); noStore();
  const m = coldStart();
  const { FALLBACK } = m.quota;
  const statuses = [];
  for (let i = 0; i < FALLBACK.perWindow + 2; i++) statuses.push((await call(m, 'ocr')).statusCode);
  assert.strictEqual(statuses.filter((s) => s === 200).length, FALLBACK.perWindow);
  assert.strictEqual(statuses[statuses.length - 1], 429);
  // instance-wide ceiling across many clients
  let ok = FALLBACK.perWindow;
  for (let i = 0; i < FALLBACK.globalPerDay + 10; i++) {
    if ((await call(m, 'transcribe', { ip: `198.18.0.${i}` })).statusCode === 200) ok += 1;
  }
  assert.strictEqual(ok, FALLBACK.globalPerDay);
  assert.strictEqual(geminiCalls, FALLBACK.globalPerDay);
  assert.strictEqual(storeCalls, 0);
});

test('store errors fail closed to the in-memory limit without logging secrets', async () => {
  reset(); useStore(); storeDown = true;
  const m = coldStart();
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const statuses = [];
    for (let i = 0; i < m.quota.FALLBACK.perWindow + 1; i++) statuses.push((await call(m, 'transcribe')).statusCode);
    assert.strictEqual(statuses.filter((s) => s === 200).length, m.quota.FALLBACK.perWindow);
    assert.strictEqual(statuses[statuses.length - 1], 429);
  } finally { console.error = orig; }
  assert.ok(logged.length > 0);
  for (const line of logged) {
    assert.ok(!line.includes(STORE_TOKEN), 'token never logged');
    assert.ok(!line.includes(process.env.GEMINI_API_KEY), 'api key never logged');
  }
});

test('missing Gemini key does not consume quota', async () => {
  reset(); useStore();
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const res = await call(coldStart(), 'transcribe');
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(storeCalls, 0);
  } finally { process.env.GEMINI_API_KEY = saved; }
});

(async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok - ${name}`); } catch (err) { failed += 1; console.log(`not ok - ${name}\n  ${err && err.stack}`); }
  }
  console.warn = origWarn;
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
