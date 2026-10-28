'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temp, fixture, accountRef, query } = require('./helpers');
const { FileDataStore, SupabaseDataStore, TABLES } = require('../data-store');
const { parseAccount, parseRewards } = require('../parsers');

test('file adapter writes schema-shaped results atomically and never creates a booking', async t => {
  const dir = await temp(t), file = path.join(dir, 'data.json'), store = new FileDataStore(file);
  await store.saveSnapshot(accountRef, parseAccount(await fixture('account.html')));
  const search = await store.createSearch(accountRef, query);
  const results = parseRewards(await fixture('rewards.html'), query);
  await store.completeSearch(search.id, results);
  const db = JSON.parse(await fs.readFile(file));
  assert.deepEqual(Object.keys(db), TABLES); assert.equal(db.ba_account_snapshots.length, 1);
  assert.equal(db.reward_searches[0].status, 'completed'); assert.equal(db.reward_results.length, 2);
  assert.equal(db.booking_requests.length, 0); assert.equal(db.reward_results[0].search_id, search.id);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  await assert.rejects(store.completeSearch(search.id, results), { message: 'SEARCH_STATE' });
});
test('search failures are terminal and zero availability completes successfully', async t => {
  const store = new FileDataStore(path.join(await temp(t), 'db.json'));
  const failed = await store.createSearch(accountRef, query); await store.failSearch(failed.id, 'PAGE_CONTRACT');
  await assert.rejects(store.completeSearch(failed.id, []), { message: 'SEARCH_STATE' });
  const empty = await store.createSearch(accountRef, query); await store.completeSearch(empty.id, []);
  await store.failSearch(empty.id, 'ROBOT_FAILED');
  const db = JSON.parse(await fs.readFile(store.file));
  assert.equal(db.reward_searches[0].failure_code, 'PAGE_CONTRACT'); assert.equal(db.reward_searches[1].status, 'completed');
});
test('corrupt data and symlink directories fail closed without overwriting another file', async t => {
  const dir = await temp(t), file = path.join(dir, 'db.json');
  await fs.writeFile(file, '{bad');
  await assert.rejects(new FileDataStore(file).recordEvent(accountRef, 'run_failed', { reason: 'ROBOT_FAILED' }));
  assert.equal(await fs.readFile(file, 'utf8'), '{bad');
  const target = path.join(dir, 'real'); await fs.mkdir(target); await fs.symlink(target, path.join(dir, 'link'));
  await assert.rejects(new FileDataStore(path.join(dir, 'link/db.json')).recordEvent(accountRef, 'run_failed'), { message: 'PRIVATE_DIRECTORY' });
});
test('durable rolling quotas include failed attempts, future events and concurrent reservations', async t => {
  let now = Date.parse('2026-10-28T23:59:59Z'); const file = path.join(await temp(t), 'safety.json');
  const store = new FileDataStore(file, { now: () => now });
  await store.reserveAction(accountRef, 'login', 1, 86400000);
  now += 2000; // Midnight does not reset the quota.
  await assert.rejects(new FileDataStore(file, { now: () => now }).reserveAction(accountRef, 'login', 1, 86400000), { message: 'LOGIN_LIMIT' });
  now -= 60000; await assert.rejects(store.reserveAction(accountRef, 'login', 1, 86400000), { message: 'LOGIN_LIMIT' });
  const outcomes = await Promise.allSettled([store.reserveAction(accountRef, 'search', 1, 3600000), store.reserveAction(accountRef, 'search', 1, 3600000)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  now += 86400000 + 60000; await store.reserveAction(accountRef, 'login', 1, 86400000);
});
test('persistent challenge latch requires acknowledgement of exact newest stop', async t => {
  const file = path.join(await temp(t), 'safety.json'), store = new FileDataStore(file);
  const stop = await store.recordEvent(accountRef, 'safety_stop', { reason: 'CAPTCHA' });
  const next = new FileDataStore(file);
  await assert.rejects(next.checkSafety(accountRef), { message: 'SAFETY_LATCHED' });
  await assert.rejects(next.checkSafety(accountRef, 'wrong'), { message: 'SAFETY_LATCHED' });
  await next.checkSafety(accountRef, stop.id); await next.checkSafety(accountRef);
  await store.recordEvent(accountRef, 'safety_stop', { reason: 'ACCOUNT_LOCKED' });
  await assert.rejects(next.checkSafety(accountRef, stop.id), { message: 'SAFETY_LATCHED' });
});
test('audit details reject arbitrary content', async t => {
  const store = new FileDataStore(path.join(await temp(t), 'db.json'));
  await assert.rejects(store.recordEvent(accountRef, 'run_failed', { reason: 'secret password' }), { message: 'EVENT_DETAILS' });
});
test('Supabase adapter targets flights only; transaction RPC completes all result rows', async () => {
  const calls = []; const secret = 'synthetic-service-role';
  const store = new SupabaseDataStore({ url: 'https://example.supabase.co', serviceRoleKey: secret, fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return { ok: true, status: 200, json: async () => null };
  } });
  await store.saveSnapshot(accountRef, { tier: 'Gold', tier_points: 1, avios: 2, collection_year_end: '2027-03-31' });
  const search = await store.createSearch(accountRef, query); await store.completeSearch(search.id, []);
  await store.recordEvent(accountRef, 'run_failed', { reason: 'ROBOT_FAILED' });
  assert.equal(calls.length, 4); assert.ok(calls[2].url.endsWith('/rpc/complete_robot_reward_search'));
  for (const call of calls) {
    assert.equal(call.headers['Accept-Profile'], 'flights'); assert.equal(call.headers['Content-Profile'], 'flights');
    assert.equal(call.headers.apikey, secret); assert.equal(call.redirect, 'error');
    assert.ok(!call.url.includes(secret)); assert.ok(!call.url.includes('booking_requests'));
  }
  assert.ok(!require('node:util').inspect(store).includes(secret));
});
test('Supabase transport errors and response bodies never escape', async () => {
  for (const fetchImpl of [async () => { throw new Error('secret echoed by fetch'); }, async () => ({ ok: false, status: 401, json() { throw new Error('body must not be read'); } })]) {
    const store = new SupabaseDataStore({ url: 'https://example.supabase.co', serviceRoleKey: 'synthetic-key', fetchImpl });
    await assert.rejects(store.recordEvent(accountRef, 'run_failed'), { message: 'DATASTORE_REQUEST' });
  }
  for (const url of ['http://example.supabase.co', 'https://secret@example.supabase.co', 'https://example.supabase.co/?key=secret']) assert.throws(() => new SupabaseDataStore({ url, serviceRoleKey: 'synthetic' }), { message: 'SUPABASE_CONFIG' });
});
test('Supabase OTP uses atomic consume RPC and validates returned code', async () => {
  const calls = [], replies = ['123456', null, 'invalid-secret'];
  const store = new SupabaseDataStore({ url: 'https://example.supabase.co', serviceRoleKey: 'synthetic', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, status: 200, json: async () => replies.shift() };
  } });
  assert.equal(await store.consumeOtp(accountRef, '123'), '123456'); assert.equal(await store.consumeOtp(accountRef, '123'), null);
  await assert.rejects(store.consumeOtp(accountRef, '123'), { message: 'OTP_FORMAT' });
  assert.ok(calls.every(c => c.url.endsWith('/rpc/consume_robot_otp')));
});
