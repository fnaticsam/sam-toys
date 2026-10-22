import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatasetStore, CURRENT_KEY, CONTROL_KEY, REFRESH_LEASE_MS, RefreshBusy, RefreshConflict, seed } from '../../api/_lib/ldn/store.mjs';
import { createRefreshHandler } from '../../api/ldn-refresh.mjs';
import { groundedGenerate } from '../../api/_lib/ldn/gemini.mjs';
import { researchAll } from '../../api/_lib/ldn/research.mjs';
import { placesLookup, enrichWithPlaces } from '../../api/_lib/ldn/places.mjs';
import { deadline } from '../../api/_lib/ldn/deadline.mjs';

// Everything in this suite uses synthetic records; unexpected network is fatal.
const realFetch = globalThis.fetch;
const oldKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = 'synthetic-test-key';
globalThis.fetch = async () => { throw new Error('Unexpected network access'); };
test.after(() => {
  globalThis.fetch = realFetch;
  if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
});
const dataset = label => ({ month: '2026-10', generatedAt: '2026-10-01T00:00:00.000Z',
  categories: [{ id: 'synthetic' }], places: [{ id: label, name: label }] });
const env = { BLOB_READ_WRITE_TOKEN: 'synthetic-public', LDN_REFRESH_CONTROL_TOKEN: 'synthetic-private',
  CRON_SECRET: 'synthetic-cron', REFRESH_SECRET: 'synthetic-manual' };
function fakeBlob() {
  const records = new Map(), calls = [];
  let revision = 0;
  class BlobPreconditionFailedError extends Error {}
  const client = {
    BlobPreconditionFailedError, records, calls, beforePut: null, afterPut: null,
    async get(key, options) {
      options.abortSignal?.throwIfAborted();
      calls.push({ kind: 'get', key, options });
      const record = records.get(key);
      return record ? { stream: new Response(record.body).body,
        blob: { etag: record.etag, url: `https://synthetic.invalid/${key}` } } : null;
    },
    async put(key, body, options) {
      options.abortSignal?.throwIfAborted();
      calls.push({ kind: 'put', key, options });
      await client.beforePut?.(key, body, options);
      options.abortSignal?.throwIfAborted();
      const old = records.get(key);
      if ((!options.allowOverwrite && old) || (options.ifMatch && options.ifMatch !== old?.etag))
        throw new BlobPreconditionFailedError();
      const etag = `"revision-${++revision}"`;
      records.set(key, { body, etag });
      await client.afterPut?.(key, body, options);
      return { etag, url: `https://synthetic.invalid/${key}` };
    },
  };
  return client;
}
function fixture() {
  const client = fakeBlob();
  let time = 1_800_000_000_000;
  const store = () => createDatasetStore({ client, env, now: () => time });
  return { client, store, advance: ms => { time += ms; } };
}
async function initialize(f) { await f.client.put(CURRENT_KEY, JSON.stringify(dataset('previous')), { allowOverwrite: false }); }
async function context(store) { const lease = await store.acquire(); return { lease, baseline: await store.current() }; }
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } }; }
function handlerFixture(overrides = {}) {
  const f = fixture();
  let paid = 0;
  const handler = createRefreshHandler({ env, storeFactory: f.store, log() {},
    research: async () => { paid++; return [{ category: 'synthetic', places: [{}] }]; },
    build: () => dataset('next'), carry: () => ({ carried: 0 }), enrich: async () => ({ enriched: 0 }),
    gate: () => ({ ok: true, issues: [] }), ...overrides });
  const call = async (method = 'POST', headers = { 'x-refresh-secret': env.REFRESH_SECRET }, url = '/api/ldn-refresh', extra = {}) => {
    const res = response(); await handler({ method, headers, url, ...extra }, res); return res;
  };
  return { ...f, call, paid: () => paid };
}

test('method and authentication matrix rejects before any storage or paid work', async () => {
  const f = handlerFixture();
  for (const method of ['HEAD', 'PUT', 'OPTIONS', 'DELETE']) assert.equal((await f.call(method)).statusCode, 405);
  assert.equal((await f.call('GET', { 'x-refresh-secret': env.REFRESH_SECRET })).statusCode, 401);
  assert.equal((await f.call('POST', { authorization: `Bearer ${env.CRON_SECRET}` })).statusCode, 401);
  assert.equal((await f.call('POST', {}, '/api/ldn-refresh?key=synthetic-manual')).statusCode, 401);
  assert.equal((await f.call('POST', undefined, '/api/ldn-refresh?key=removed')).statusCode, 400);
  assert.equal((await f.call('POST', undefined, '/api/ldn-refresh?month=2026-99')).statusCode, 400);
  assert.equal(f.client.calls.length, 0); assert.equal(f.paid(), 0);
});

test('cron GET and manual POST work, with cleanup completed before responding', async () => {
  const f = handlerFixture();
  for (const [method, headers] of [['GET', { authorization: `Bearer ${env.CRON_SECRET}` }], ['POST', { 'x-refresh-secret': env.REFRESH_SECRET }]]) {
    const res = await f.call(method, headers);
    assert.equal(res.statusCode, 200); assert.equal(res.body.persisted, true);
    assert.equal(JSON.parse(f.client.records.get(CONTROL_KEY).body).owner, null);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  assert.equal(f.paid(), 2);
});

test('missing private control token fails closed before paid work', async () => {
  const f = fixture();
  let paid = 0;
  const handler = createRefreshHandler({ env, storeFactory: () => createDatasetStore({ client: f.client, env: { BLOB_READ_WRITE_TOKEN: 'synthetic' } }),
    research: async () => { paid++; }, log() {} });
  const res = response();
  await handler({ method: 'POST', headers: { 'x-refresh-secret': env.REFRESH_SECRET }, url: '/api/ldn-refresh' }, res);
  assert.equal(res.statusCode, 503); assert.equal(paid, 0); assert.equal(f.client.calls.length, 0);
});

test('dry run still takes a lease but does not archive or promote data', async () => {
  const f = handlerFixture();
  const res = await f.call('POST', undefined, '/api/ldn-refresh?dryRun=1');
  assert.equal(res.body.dryRun, true); assert.equal(f.paid(), 1);
  assert.equal(f.client.calls.filter(c => c.kind === 'put' && c.key !== CONTROL_KEY).length, 0);
});

test('independent instances contend on one atomic private lease', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => f.store().acquire()));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(outcomes.filter(r => r.status === 'rejected').every(r => r.reason instanceof RefreshBusy));
  assert.ok(f.client.calls.filter(c => c.key === CONTROL_KEY).every(c => c.options.access === 'private' && c.options.token === env.LDN_REFRESH_CONTROL_TOKEN));
});

test('expired lease can be replaced; old owner cannot release or publish through it', async () => {
  const f = fixture(); await initialize(f);
  const old = f.store(), oldContext = await context(old);
  f.advance(REFRESH_LEASE_MS + 1);
  const next = f.store(), winner = await next.acquire();
  assert.equal(await old.release(oldContext.lease), false);
  await assert.rejects(old.publish(dataset('stale'), oldContext), RefreshConflict);
  assert.equal(JSON.parse(f.client.records.get(CONTROL_KEY).body).owner, winner.owner);
  assert.equal(JSON.parse(f.client.records.get(CURRENT_KEY).body).places[0].id, 'previous');
});

test('lost lease-creation response is reconciled without another write', async () => {
  const f = fixture();
  f.client.afterPut = async key => { if (key === CONTROL_KEY) throw new Error('synthetic lost response'); };
  const lease = await f.store().acquire();
  assert.equal(JSON.parse(f.client.records.get(CONTROL_KEY).body).owner, lease.owner);
  assert.equal(f.client.calls.filter(c => c.kind === 'put').length, 1);
});

test('archive failure leaves the existing current dataset untouched', async () => {
  for (const suffix of ['previous.json', 'next.json']) {
    const f = fixture(); await initialize(f); const store = f.store(), ctx = await context(store);
    const before = f.client.records.get(CURRENT_KEY);
    f.client.beforePut = async key => { if (key.endsWith(suffix)) throw new Error('synthetic archive failure'); };
    await assert.rejects(store.publish(dataset('next'), ctx), /synthetic archive failure/);
    assert.deepEqual(f.client.records.get(CURRENT_KEY), before);
  }
});

test('successful promotion archives exact old and new bodies before conditional current write', async () => {
  const f = fixture(); await initialize(f); const store = f.store(), ctx = await context(store);
  const result = await store.publish(dataset('next'), ctx);
  assert.equal(f.client.records.get(result.previousSnapshot).body, ctx.baseline.body);
  assert.equal(f.client.records.get(result.snapshot).body, JSON.stringify(dataset('next')));
  const writes = f.client.calls.filter(c => c.kind === 'put');
  assert.equal(writes.at(-1).key, CURRENT_KEY); assert.equal(writes.at(-1).options.ifMatch, ctx.baseline.etag);
  assert.ok(writes.filter(c => c.key.startsWith('ldn/archive/')).every(c => c.options.allowOverwrite === false && c.options.access === 'public'));
});

test('interrupted promotion retains both recovery archives and the old current body', async () => {
  const f = fixture(); await initialize(f); const store = f.store(), ctx = await context(store);
  f.client.beforePut = async key => { if (key === CURRENT_KEY) throw new Error('synthetic interrupted promotion'); };
  await assert.rejects(store.publish(dataset('next'), ctx), /synthetic interrupted promotion/);
  assert.equal(f.client.records.get(CURRENT_KEY).body, ctx.baseline.body);
  assert.equal([...f.client.records.keys()].filter(k => k.startsWith('ldn/archive/')).length, 2);
});

test('promotion response loss is reconciled from current without rewriting it', async () => {
  const f = fixture(); await initialize(f); const store = f.store(), ctx = await context(store);
  f.client.afterPut = async key => { if (key === CURRENT_KEY) throw new Error('synthetic lost response'); };
  const result = await store.publish(dataset('next'), ctx);
  assert.equal(result.reconciled, true);
  assert.equal(f.client.calls.filter(c => c.kind === 'put' && c.key === CURRENT_KEY).length, 2); // initial + promotion
});

test('intervening publisher is not overwritten, including an intervening first creation', async () => {
  for (const existing of [true, false]) {
    const f = fixture(); if (existing) await initialize(f);
    const store = f.store(), ctx = await context(store);
    f.client.beforePut = async key => {
      if (key === CURRENT_KEY) {
        f.client.beforePut = null;
        await f.client.put(CURRENT_KEY, JSON.stringify(dataset('winner')), { allowOverwrite: true });
      }
    };
    await assert.rejects(store.publish(dataset('stale'), ctx), RefreshConflict);
    assert.equal(JSON.parse(f.client.records.get(CURRENT_KEY).body).places[0].id, 'winner');
  }
});

test('reader keeps current.json compatibility and seed fallback, without leaking errors', async () => {
  const f = fixture(), store = f.store();
  assert.equal((await store.readDataset()).dataset, seed);
  await initialize(f); assert.equal((await store.readDataset()).dataset.places[0].id, 'previous');
  f.client.get = async () => { throw new Error('synthetic sensitive upstream detail'); };
  assert.deepEqual(await store.readDataset(), { dataset: seed, source: 'seed' });
});

test('overall cancellation stops research and releases the lease with generic errors', async () => {
  const logged = [];
  const f = handlerFixture({ deadlineMs: 10, log: value => logged.push(value), research: async ({ signal }) => {
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const res = await f.call();
  assert.equal(res.statusCode, 504); assert.deepEqual(res.body, { ok: false, error: 'refresh-timeout' });
  assert.equal(JSON.parse(f.client.records.get(CONTROL_KEY).body).owner, null);
  assert.equal(f.client.records.has(CURRENT_KEY), false);
  assert.deepEqual(logged, [{ event: 'ldn-refresh-failed', code: 'refresh-timeout' }]);
});

test('provider errors and category failures never expose raw messages', async () => {
  const f = handlerFixture({ research: async () => { throw new Error('synthetic secret provider message'); } });
  const res = await f.call(); assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /secret|provider message/);
  const g = handlerFixture({ research: async () => [{ category: 'synthetic', places: [], error: 'synthetic raw upstream error' }] });
  const dry = await g.call('POST', undefined, '/api/ldn-refresh?dryRun=1');
  assert.equal(dry.body.summary.perCategory[0].error, 'research-failed');
});

test('permanent HTTP 400/401 has one attempt and no API key in the request URL', async () => {
  for (const status of [400, 401]) {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++; assert.equal(new URL(url).search, '');
      assert.equal(options.headers['x-goog-api-key'], 'synthetic-test-key');
      assert.ok(options.signal); return new Response('synthetic sensitive error', { status });
    };
    await assert.rejects(groundedGenerate({ prompt: 'synthetic' }), error => error.status === status && !error.message.includes('sensitive'));
    assert.equal(calls, 1);
  }
});

test('nine failed categories use nine permanent-error attempts, not nested retries', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('synthetic', { status: 400 }); };
  const results = await researchAll({ month: '2026-10' });
  assert.equal(results.length, 9); assert.equal(calls, 9);
});

test('transient HTTP errors have one bounded transport budget and honor Retry-After', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('synthetic', { status: 429, headers: { 'retry-after': '0' } }); };
  await assert.rejects(groundedGenerate({ prompt: 'synthetic', maxRetries: 99 }));
  assert.equal(calls, 3);
});

test('parent cancellation interrupts Retry-After without another provider attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('synthetic', { status: 503, headers: { 'retry-after': '30' } }); };
  const operation = deadline(10);
  try { await assert.rejects(groundedGenerate({ prompt: 'synthetic', signal: operation.signal }), { name: 'TimeoutError' }); }
  finally { operation.dispose(); }
  assert.equal(calls, 1);
});

test('per-request Gemini timeout aborts the fetch; pre-aborted research does no work', async () => {
  let calls = 0;
  globalThis.fetch = async (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  await assert.rejects(groundedGenerate({ prompt: 'synthetic', maxRetries: 0, requestTimeoutMs: 10 }), { name: 'TimeoutError' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(researchAll({ month: '2026-10', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('Places per-request timeout and overall cancellation propagate', async () => {
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const place = { id: 'synthetic', name: 'Synthetic', lat: 51.5, lng: 0 };
  await assert.rejects(placesLookup(place, { key: 'synthetic', requestTimeoutMs: 10 }), { name: 'TimeoutError' });
  const operation = deadline(10);
  try { await assert.rejects(enrichWithPlaces({ places: [place] }, { key: 'synthetic', signal: operation.signal }), { name: 'TimeoutError' }); }
  finally { operation.dispose(); }
});

test('Places freshness timestamps change only when that provider replaces the field', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ places: [{
    displayName: { text: 'Synthetic venue' }, location: { latitude: 51.5, longitude: 0 },
    rating: 4.5, userRatingCount: 100, googleMapsUri: 'https://www.google.com/maps/place/synthetic',
    regularOpeningHours: { periods: [{ open: { day: 1, hour: 9 }, close: { day: 1, hour: 17 } }] },
  }] }));
  const original = '2020-01-01T00:00:00.000Z';
  const base = { id: 'synthetic', name: 'Synthetic venue', category: 'art-museums', lat: 51.5, lng: 0 };
  const kept = { ...base, hours: { mon: [['10:00', '18:00']] }, hoursUrl: 'https://official.invalid/hours',
    hoursCheckedAt: original, rating: { value: 4, source: 'Critic' }, ratingCheckedAt: original };
  const filled = { ...base };
  await enrichWithPlaces({ places: [kept, filled] }, { key: 'synthetic' });
  assert.equal(kept.hoursCheckedAt, original); assert.equal(kept.ratingCheckedAt, original);
  assert.ok(Date.parse(filled.hoursCheckedAt) > Date.parse(original));
  assert.ok(Date.parse(filled.ratingCheckedAt) > Date.parse(original));
});

test('cancellation between snapshot creation and promotion leaves live state intact', async () => {
  const f = fixture(); await initialize(f); const store = f.store(), ctx = await context(store);
  const controller = new AbortController();
  f.client.afterPut = async key => { if (key.endsWith('-next.json')) controller.abort(); };
  await assert.rejects(store.publish(dataset('next'), { ...ctx, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.client.records.get(CURRENT_KEY).body, ctx.baseline.body);
});

test('operator restore uses an exact archive and preserves the dataset being replaced', async () => {
  const f = fixture(); await initialize(f); const store = f.store(), first = await context(store);
  const changed = await store.publish(dataset('next'), first);
  await store.release(first.lease);
  const ctx = await context(store);
  await assert.rejects(store.restore('ldn/current.json', ctx));
  const restored = await store.restore(changed.previousSnapshot, ctx);
  assert.equal(JSON.parse(f.client.records.get(CURRENT_KEY).body).places[0].id, 'previous');
  assert.equal(JSON.parse(f.client.records.get(restored.previousSnapshot).body).places[0].id, 'next');
  await store.release(ctx.lease);
});
