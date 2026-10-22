const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module');
const sdkRequire = createRequire(require.resolve('@vercel/blob'));
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = sdkRequire('undici');
const { createControls } = require('../../api/_lib/abuse-controls');
const { fakeBlob } = require('./fake-blob');
const ENV = { ABUSE_CONTROL_READ_WRITE_TOKEN: 'vercel_blob_rw_synthetic_fixture' };
const REQ = { headers: { 'x-real-ip': '192.0.2.1' } };
const blank = () => ({ v: 1, period: Math.floor(Date.now() / 86400000), count: 0, ips: {}, leases: {} });
const read = () => ({ blob: { etag: '"synthetic"' }, stream: new Response(JSON.stringify(blank())).body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function inDeadline(start) {
  const elapsed = performance.now() - start;
  assert(elapsed >= 1400 && elapsed < 2400, `operation took ${Math.round(elapsed)}ms; should reject near its 1500ms deadline`);
}
async function mockSdk(run) {
  const previous = getGlobalDispatcher(), random = Math.random;
  const oldUrl = process.env.VERCEL_BLOB_API_URL, oldRetries = process.env.VERCEL_BLOB_RETRIES;
  const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
  process.env.VERCEL_BLOB_API_URL = 'https://blob.invalid'; process.env.VERCEL_BLOB_RETRIES = '2'; Math.random = () => 0;
  const pending = [];
  try {
    const sdk = require('@vercel/blob');
    // Retain/observe SDK promises so the mock dispatcher stays installed until
    // background retries settle; an expired caller must never leave live traffic.
    const tracked = Object.fromEntries(['get', 'put'].map(method => [method, (...args) => {
      const operation = sdk[method](...args); pending.push(operation); operation.catch(() => {}); return operation;
    }]));
    await run(mock, { ...sdk, ...tracked });
  } finally {
    await Promise.allSettled(pending);
    await mock.close(); setGlobalDispatcher(previous); Math.random = random;
    for (const [name, value] of [['VERCEL_BLOB_API_URL', oldUrl], ['VERCEL_BLOB_RETRIES', oldRetries]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('real Blob PUT retry backoff cannot extend admission deadline', { timeout: 10000 }, async () => {
  await mockSdk(async (mock, sdk) => {
    let puts = 0;
    mock.get('https://blob.invalid').intercept({ path: () => true, method: 'PUT' }).reply(() => {
      puts++; return { statusCode: 503, data: JSON.stringify({ error: { code: 'service_unavailable' } }), responseOptions: { headers: { 'content-type': 'application/json' } } };
    }).persist();
    const controls = createControls({ client: { ...sdk, get: async () => read() }, env: ENV });
    const start = performance.now();
    await assert.rejects(controls.reservePaid(REQ), { status: 503 });
    inDeadline(start); assert(puts >= 1);
    // mockSdk awaits late SDK rejection from its actual retry/backoff loop.
  });
});

test('real Blob GET timeout fails closed before a write', { timeout: 10000 }, async () => {
  await mockSdk(async (mock, sdk) => {
    let puts = 0;
    mock.get(/^https:\/\/[^/]+\.blob\.vercel-storage\.com$/).intercept({ path: () => true, method: 'GET' })
      .reply(200, JSON.stringify(blank()), { headers: { 'content-type': 'application/json', etag: '"synthetic"' } }).delay(2600);
    const controls = createControls({ client: { ...sdk, put: async () => { puts++; throw new Error('must not write'); } }, env: ENV });
    const start = performance.now(); await assert.rejects(controls.reservePaid(REQ), { status: 503 });
    inDeadline(start); assert.equal(puts, 0);
  });
});

test('late reads, stream bodies and successful or rejected writes never admit work', { timeout: 10000 }, async () => {
  const unhandled = []; const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await Promise.all(['read', 'stream', 'write-success', 'write-reject'].map(async kind => {
      const gate = deferred(); const blob = fakeBlob(); let puts = 0, admitted = 0, signal;
      const client = {
        ...blob,
        get: async (pathname, options) => {
          signal = options.abortSignal;
          if (kind === 'read') return gate.promise;
          if (kind === 'stream') return { blob: { etag: '"synthetic"' }, stream: new ReadableStream({ start(controller) {
            gate.promise.then(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(blank()))); controller.close(); });
          } }) };
          return blob.get(pathname, options);
        },
        put: async (...args) => {
          puts++; await gate.promise;
          return blob.put(...args);
        },
      };
      const controls = createControls({ client, env: ENV });
      const start = performance.now(); const operation = controls.reservePaid(REQ).then(() => { admitted++; });
      await assert.rejects(operation, { status: 503 }); inDeadline(start); assert(signal.aborted);
      if (kind === 'write-reject') gate.reject(new Error('synthetic late failure'));
      else gate.resolve(kind === 'read' ? read() : undefined);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(admitted, 0);
      assert.equal(puts, kind.startsWith('write') ? 1 : 0);
      if (kind === 'write-success') {
        const saved = JSON.parse(blob.data.get('controls/paid-v1.json').body);
        assert.equal(saved.count, 1); assert.equal(Object.keys(saved.leases).length, 1);
      }
    }));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(unhandled.length, 0);
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});
