'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temp, fakeBrowser, accountRef, query, noSleep } = require('./helpers');
const { run } = require('../robot');
const { FileDataStore } = require('../data-store');
const { Safety } = require('../safety');
const browser = require('../browser');
const site = require('../selectors');

const env = { BA_LIVE_ENABLED: '1', BA_MEMBERSHIP: '12345678', BA_DATA_STORE: 'file' };
async function setup(t, options = {}) {
  const home = await temp(t), fake = await fakeBrowser(options); let keychainCalls = 0;
  return { home, fake, get keychainCalls() { return keychainCalls; }, deps: {
    launchBrowser: async () => fake.context, sleep: noSleep, jitter: () => 0,
    keychain: async () => { keychainCalls++; return 'synthetic-secret'; }
  } };
}
const dbFile = (home, name) => path.join(home, 'Library/Application Support/sam-flights', name);

test('live switch and missing credentials fail before any browser/profile creation', async t => {
  const home = await temp(t); let launches = 0; const deps = { launchBrowser: () => { launches++; } };
  await assert.rejects(run('balance', {}, { env: {}, home, deps }), { message: 'LIVE_DISABLED' });
  await assert.rejects(run('balance', {}, { env: { BA_LIVE_ENABLED: '1' }, home, deps }), { message: 'BA_MEMBERSHIP_REQUIRED' });
  assert.equal(launches, 0); assert.deepEqual(await fs.readdir(home), []);
});
test('dry-run is credential-free, datastore-free and synthetic', async t => {
  const home = await temp(t);
  const balance = await run('balance', {}, { env: new Proxy({}, { get() { throw new Error('env accessed'); } }), home, dryRun: true });
  const rewards = await run('reward-search', query, { dryRun: true, home });
  assert.equal(balance.synthetic, true); assert.equal(rewards.results.length, 2); assert.deepEqual(await fs.readdir(home), []);
  await assert.rejects(run('reward-search', { ...query, to: 'MAD' }, { dryRun: true }), { message: 'DRY_RUN_FIXTURE_ONLY' });
});
test('balance reuses an existing session without Keychain access or a login reservation', async t => {
  const setupResult = await setup(t, { session: true }); const { home, deps, fake } = setupResult;
  const result = await run('balance', {}, { env, home, deps });
  assert.equal(result.account.tier, 'Gold'); assert.equal(setupResult.keychainCalls, 0); assert.ok(fake.context.closed);
  const db = JSON.parse(await fs.readFile(dbFile(home, 'ba-safety.json')));
  assert.equal(db.robot_events.filter(e => e.kind === 'login_reserved').length, 0);
  assert.equal((await fs.stat(dbFile(home, 'ba-profile'))).mode & 0o777, 0o700);
});
test('login occurs once and balance is persisted without password or membership', async t => {
  const setupResult = await setup(t); const { home, deps, fake } = setupResult;
  const result = await run('balance', {}, { env, home, deps });
  assert.equal(setupResult.keychainCalls, 1); assert.equal(result.account.avios, 182345);
  assert.equal(fake.log.filter(e => e[0] === 'click' && e[1] === site.controls.login).length, 1);
  for (const name of ['ba-data.json', 'ba-safety.json']) {
    const raw = await fs.readFile(dbFile(home, name), 'utf8'); assert.ok(!raw.includes('synthetic-secret')); assert.ok(!raw.includes('12345678'));
  }
});
test('login rejection has no retry and records a bounded failure event', async t => {
  const setupResult = await setup(t, { loginFailure: true }); const { home, deps, fake } = setupResult;
  await assert.rejects(run('balance', {}, { env, home, deps }), { message: 'LOGIN_NOT_CONFIRMED' });
  assert.equal(setupResult.keychainCalls, 1); assert.equal(fake.log.filter(e => e[0] === 'click' && e[1] === site.controls.login).length, 1);
  const db = JSON.parse(await fs.readFile(dbFile(home, 'ba-safety.json')));
  assert.equal(db.robot_events.find(e => e.kind === 'run_failed').details.reason, 'LOGIN_NOT_CONFIRMED');
});
test('Playwright password errors are sanitized before events and exceptions', async t => {
  const { home, deps } = await setup(t, { throwPassword: true });
  await assert.rejects(run('balance', {}, { env, home, deps }), { message: 'SITE_ACTION_FAILED' });
  assert.ok(!(await fs.readFile(dbFile(home, 'ba-safety.json'), 'utf8')).includes('synthetic-secret'));
});
test('challenge closes browser immediately and prevents a subsequent scheduled run', async t => {
  const { home, deps, fake } = await setup(t, { challenge: true });
  await assert.rejects(run('balance', {}, { env, home, deps }), { message: 'ACCOUNT_LOCKED' });
  assert.ok(fake.context.closed > 0);
  const db = JSON.parse(await fs.readFile(dbFile(home, 'ba-safety.json')));
  assert.equal(db.robot_events.find(e => e.kind === 'safety_stop').details.reason, 'ACCOUNT_LOCKED');
  let launched = false;
  await assert.rejects(run('balance', {}, { env, home, deps: { ...deps, launchBrowser() { launched = true; } } }), { message: 'SAFETY_LATCHED' });
  assert.equal(launched, false);
});
test('OTP login passes only a code and clears its pending datastore request', async t => {
  const { home, deps } = await setup(t, { otp: true });
  await run('balance', {}, { env, home, deps, onOtpRequest: async id => {
    const store = new FileDataStore(dbFile(home, 'ba-data.json'));
    const db = JSON.parse(await fs.readFile(store.file));
    await store.submitOtp(db.robot_events.find(e => e.id === id).account_ref, id, '123456');
  } });
  const db = JSON.parse(await fs.readFile(dbFile(home, 'ba-data.json')));
  assert.equal(db.robot_events.find(e => e.kind === 'otp_requested').otp_code, null);
});
test('reward flow searches one adult one way and returns all expanded mixes, without booking', async t => {
  const { home, deps, fake } = await setup(t, { session: true, collapsedMixes: true });
  const result = await run('reward-search', query, { env, home, deps });
  assert.equal(result.results.length, 2); assert.equal(result.results[0].mixes.length, 3);
  assert.ok(fake.log.some(e => e[0] === 'click' && e[1] === site.controls.mixes));
  assert.ok(fake.log.some(e => e[0] === 'select' && e[1] === site.controls.adults && e[2] === '1'));
  const db = JSON.parse(await fs.readFile(dbFile(home, 'ba-data.json')));
  assert.equal(db.reward_searches[0].status, 'completed'); assert.equal(db.reward_results.length, 2); assert.deepEqual(db.booking_requests, []);
  const safety = JSON.parse(await fs.readFile(dbFile(home, 'ba-safety.json')));
  assert.equal(safety.robot_events.filter(e => e.kind === 'search_reserved').length, 1);
});
test('daily login cap survives separate robot invocations', async t => {
  const { home, deps } = await setup(t);
  const limitedEnv = { ...env, BA_MAX_LOGINS_PER_DAY: '1' };
  await run('balance', {}, { env: limitedEnv, home, deps });
  const second = await fakeBrowser(); let keychain = false;
  await assert.rejects(run('balance', {}, { env: limitedEnv, home, deps: { ...deps, launchBrowser: async () => second.context, keychain: async () => { keychain = true; } } }), { message: 'LOGIN_LIMIT' });
  assert.equal(keychain, false);
});
test('exclusive process lock rejects overlapping runs before browser launch', async t => {
  const { home, deps, fake } = await setup(t, { session: true });
  let release, started; const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const first = run('balance', {}, { env, home, deps: { ...deps, launchBrowser: async () => { started(); await gate; return fake.context; } } });
  await ready;
  await assert.rejects(run('balance', {}, { env, home, deps }), { message: 'ROBOT_BUSY' });
  release(); await first;
});
test('observer stop latches locally even if Supabase event persistence fails', async t => {
  const dir = await temp(t), ledger = new FileDataStore(path.join(dir, 'ledger.json'));
  const { context } = await fakeBrowser();
  const safety = new Safety({ ledger, accountRef, store: { async recordEvent() { throw new Error('synthetic transport failure'); } } });
  await safety.attach(context); await context.bindings.__samBaSafetyStop({}, 'CAPTCHA');
  assert.throws(() => safety.assert(), { message: 'CAPTCHA' }); assert.ok(context.closed > 0);
  await assert.rejects(safety.drain()); await assert.rejects(ledger.checkSafety(accountRef), { message: 'SAFETY_LATCHED' });
});
test('browser route guard blocks off-site navigation and never continues payment', async t => {
  const dir = await temp(t), ledger = new FileDataStore(path.join(dir, 'ledger.json'));
  const { context } = await fakeBrowser(); const safety = new Safety({ ledger, store: ledger, accountRef });
  await browser.prepareBrowser(context, safety);
  let aborted = 0, continued = 0;
  await context.routeHandler({ request: () => ({ url: () => 'https://www.britishairways.com/payment', isNavigationRequest: () => true }),
    abort: async () => { aborted++; }, continue: async () => { continued++; } });
  await safety.drain(); assert.equal(aborted, 1); assert.equal(continued, 0); assert.equal(safety.reason, 'UNEXPECTED_NAVIGATION');
});
test('pacing checks a challenge appearing during jitter before performing an action', async t => {
  const ledger = new FileDataStore(path.join(await temp(t), 'db.json')); let html = '<p>Normal</p>', acted = false, slept;
  const safety = new Safety({ ledger, store: ledger, accountRef, jitter: () => 1234, sleep: async ms => { slept = ms; html = '<p>Unusual activity</p>'; } });
  await assert.rejects(safety.step({ content: async () => html }, async () => { acted = true; }), { message: 'UNUSUAL_ACTIVITY' });
  assert.equal(acted, false); assert.equal(slept, 1234);
});
test('persistent profile disables password saving while retaining unrelated preferences', async t => {
  const profile = await temp(t); await fs.mkdir(path.join(profile, 'Default'));
  await fs.writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ locale: 'en-GB', profile: { other: true } }));
  await browser.prepareProfile(profile);
  const prefs = JSON.parse(await fs.readFile(path.join(profile, 'Default/Preferences')));
  assert.equal(prefs.locale, 'en-GB'); assert.equal(prefs.profile.other, true);
  assert.equal(prefs.credentials_enable_service, false); assert.equal(prefs.profile.password_manager_enabled, false);
});
test('failed browser close retains the run lock for manual inspection', async t => {
  const { home, deps, fake } = await setup(t, { session: true });
  fake.context.close = async () => { throw new Error('synthetic close failure'); };
  await assert.rejects(run('balance', {}, { env, home, deps }), { message: 'BROWSER_CLOSE_FAILED' });
  assert.ok((await fs.stat(dbFile(home, 'ba-run.lock'))).isDirectory());
  await assert.rejects(run('balance', {}, { env, home, deps }), { message: 'ROBOT_BUSY' });
});
