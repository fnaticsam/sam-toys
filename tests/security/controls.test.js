const test = require('node:test');
const assert = require('node:assert/strict');
const { createControls } = require('../../api/_lib/abuse-controls');
const { fakeBlob } = require('./fake-blob');
const req = (ip = '192.0.2.1') => ({ headers: { 'x-real-ip': ip } });
const env = (overrides = {}) => ({ ABUSE_CONTROL_READ_WRITE_TOKEN: 'synthetic-control-token', ...overrides });
const make = (client, options = {}) => createControls({ client, env: env(), sleep: async () => {}, ...options });
const state = client => JSON.parse(client.data.get('controls/paid-v1.json').body);

test('independent instances cannot overrun global daily count under concurrent create/update races', async () => {
  const client = fakeBlob(); const settings = env({ ABUSE_PAID_DAILY_LIMIT: '2', ABUSE_PAID_CONCURRENCY: '10' });
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, n) => make(client, { env: settings }).reservePaid(req(`192.0.2.${n + 1}`))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert(results.filter(r => r.status === 'rejected').every(r => [429, 503].includes(r.reason.status)));
  assert.equal(state(client).count, 2);
});
test('per-IP daily budget is durable, no-Origin clients and forwarded IP changes do not reset it', async () => {
  const client = fakeBlob(), settings = env({ ABUSE_PAID_IP_DAILY_LIMIT: '1' });
  await (await make(client, { env: settings }).reservePaid(req())).release();
  await assert.rejects(make(client, { env: settings }).reservePaid({ headers: { ...req().headers, 'x-forwarded-for': '198.51.100.99' } }), { status: 429 });
  assert.equal(state(client).count, 1);
  assert(!JSON.stringify(state(client)).includes('192.0.2.1'));
  await make(client, { env: settings }).reservePaid(req('192.0.2.2'));
});
test('atomic concurrency leases survive instance changes and release does not refund daily usage', async () => {
  const client = fakeBlob(), settings = env({ ABUSE_PAID_CONCURRENCY: '1' });
  const first = make(client, { env: settings }), second = make(client, { env: settings });
  const lease = await first.reservePaid(req());
  await assert.rejects(second.reservePaid(req('192.0.2.2')), { status: 429 });
  await lease.release(); await lease.release();
  await second.reservePaid(req('192.0.2.2'));
  assert.equal(state(client).count, 2);
});
test('abandoned leases expire; live leases remain across UTC daily rollover', async () => {
  const client = fakeBlob(); let time = Date.UTC(2026, 0, 1, 23, 59, 50);
  const controls = make(client, { env: env({ ABUSE_PAID_CONCURRENCY: '1' }), now: () => time });
  await controls.reservePaid(req()); time += 20000;
  await assert.rejects(controls.reservePaid(req('192.0.2.2')), { status: 429 });
  time += 90000; await controls.reservePaid(req('192.0.2.2'));
  assert.equal(state(client).count, 1);
});
test('daily rollover resets counts but a backwards clock fails closed', async () => {
  const client = fakeBlob(); let time = Date.UTC(2026, 0, 1);
  const controls = make(client, { env: env({ ABUSE_PAID_IP_DAILY_LIMIT: '1' }), now: () => time });
  await (await controls.reservePaid(req())).release();
  await assert.rejects(controls.reservePaid(req()), { status: 429 });
  time += 86400000; await (await controls.reservePaid(req())).release();
  assert.equal(state(client).count, 1);
  time -= 86400000; await assert.rejects(controls.reservePaid(req()), { status: 503 });
});
test('missing configuration, corrupt state and unavailable storage never grant admission', async () => {
  await assert.rejects(make(fakeBlob(), { env: {} }).reservePaid(req()), { status: 503 });
  await assert.rejects(make(fakeBlob(), { env: env({ ABUSE_PAID_DAILY_LIMIT: 'no' }) }).reservePaid(req()), { status: 503 });
  await assert.rejects(make({ get: async () => { throw new Error('storage offline'); } }).reservePaid(req()), { status: 503 });
  const client = fakeBlob(); client.data.set('controls/paid-v1.json', { etag: '"x"', body: '{"v":1}' });
  await assert.rejects(make(client).reservePaid(req()), { status: 503 });
});
test('ambiguous writes cannot admit paid work and failed release retains usage until expiry', async () => {
  const client = fakeBlob(), put = client.put;
  client.put = async (...args) => { await put(...args); throw new Error('response lost'); };
  await assert.rejects(make(client).reservePaid(req()), { status: 503 });
  assert(state(client).count > 0);
  client.put = put; const lease = await make(client).reservePaid(req());
  client.put = async () => { throw new Error('offline'); };
  const oldWarn = console.warn; console.warn = () => {};
  try { await lease.release(); } finally { console.warn = oldWarn; }
  assert(state(client).count >= 2); assert(Object.keys(state(client).leases).length >= 1);
});
test('password attempts use separate per-surface fixed windows and global/IP budgets', async () => {
  const client = fakeBlob(); let time = 1000000;
  const settings = env({ ABUSE_LOGIN_IP_LIMIT: '1', ABUSE_LOGIN_GLOBAL_LIMIT: '2', ABUSE_LOGIN_WINDOW_SECONDS: '60' });
  const first = make(client, { env: settings, now: () => time }), second = make(client, { env: settings, now: () => time });
  await first.checkLogin(req(), 'dev');
  await assert.rejects(second.checkLogin(req(), 'dev'), { status: 429 });
  await second.checkLogin(req('192.0.2.2'), 'dev');
  await assert.rejects(first.checkLogin(req('192.0.2.3'), 'dev'), { status: 429 });
  await second.checkLogin(req(), 'playa');
  time += 60000; await second.checkLogin(req(), 'dev');
  await assert.rejects(second.checkLogin(req(), '../unknown'), { status: 503 });
});
test('control-storage requests carry a deadline and abort without granting work', async () => {
  const client={get:async(_path,options)=>new Promise((resolve,reject)=>options.abortSignal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))};
  await assert.rejects(make(client).reservePaid(req()), { status: 503 });
});
