'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temp, accountRef } = require('./helpers');
const { FileDataStore } = require('../data-store');
const { readKeychainPassword, ManualOtpProvider, GmailOtpProvider } = require('../providers');

test('Keychain command is argv-only and returns password only to its caller', async () => {
  let args, options; const buffer = Buffer.from('synthetic password with spaces \n');
  const password = await readKeychainPassword('12345678', { exec(command, argv, opts, cb) {
    assert.equal(command, '/usr/bin/security'); args = argv; options = opts; cb(null, buffer);
  } });
  assert.deepEqual(args, ['find-generic-password', '-s', 'ba-club', '-a', '12345678', '-w']);
  assert.equal(options.encoding, 'buffer'); assert.equal(password, 'synthetic password with spaces ');
  assert.ok(buffer.every(n => n === 0));
});
test('Keychain errors discard stdout/stderr/exception credentials', async () => {
  const buffer = Buffer.from('synthetic-secret');
  await assert.rejects(readKeychainPassword('12345678', { exec(_c, _a, _o, cb) {
    const error = new Error('synthetic-secret'); error.stderr = 'synthetic-secret'; error.stdout = 'synthetic-secret'; cb(error, buffer);
  } }), { message: 'KEYCHAIN_UNAVAILABLE' });
  assert.ok(buffer.every(n => n === 0));
  assert.throws(() => readKeychainPassword('123;echo bad'), { message: 'BA_MEMBERSHIP_REQUIRED' });
});
test('manual OTP passes via datastore, is consumed once and cleared', async t => {
  let now = 100000; const store = new FileDataStore(path.join(await temp(t), 'db.json'), { now: () => now });
  let request;
  const provider = new ManualOtpProvider({ store, now: () => now, sleep: async ms => { now += ms; } });
  const code = await provider.getCode({ accountRef, onRequest: async id => { request = id; await store.submitOtp(accountRef, id, '123456'); } });
  assert.equal(code, '123456'); assert.equal(await store.consumeOtp(accountRef, request), null);
  const db = JSON.parse(await fs.readFile(store.file));
  assert.equal(db.robot_events[0].otp_code, null); assert.ok(db.robot_events[0].otp_consumed_at);
});
test('manual OTP times out on controlled clock and closes request', async t => {
  let now = 100000; const store = new FileDataStore(path.join(await temp(t), 'db.json'), { now: () => now });
  const provider = new ManualOtpProvider({ store, now: () => now, timeoutMs: 5000, pollMs: 2000, sleep: async ms => { now += ms; } });
  await assert.rejects(provider.getCode({ accountRef }), { message: 'OTP_TIMEOUT' });
  assert.equal(now, 105000);
  const db = JSON.parse(await fs.readFile(store.file)); assert.equal(db.robot_events[0].otp_code, null); assert.ok(db.robot_events[0].otp_consumed_at);
});
test('manual OTP aborts immediately on challenge without returning a submitted code', async t => {
  const store = new FileDataStore(path.join(await temp(t), 'db.json'));
  const controller = new AbortController(); let id;
  const provider = new ManualOtpProvider({ store });
  await assert.rejects(provider.getCode({ accountRef, signal: controller.signal, onRequest: async request => {
    id = request; await store.submitOtp(accountRef, id, '123456'); controller.abort();
  } }), { message: 'SAFETY_STOP' });
  assert.equal(await store.consumeOtp(accountRef, id), null);
});
test('OTP expires and cannot be delivered to another account', async t => {
  let now = 100000; const store = new FileDataStore(path.join(await temp(t), 'db.json'), { now: () => now });
  const id = await store.createOtpRequest(accountRef, now + 1000); await store.submitOtp(accountRef, id, '123456');
  assert.equal(await store.consumeOtp('b'.repeat(64), id), null);
  now += 1001; assert.equal(await store.consumeOtp(accountRef, id), null);
  await assert.rejects(store.submitOtp(accountRef, id, '123456'), { message: 'OTP_EXPIRED' });
});
test('Gmail provider is an inert stub with no credential/network access', async () => {
  await assert.rejects(new GmailOtpProvider().getCode(), { message: 'GMAIL_OTP_NOT_CONFIGURED' });
});
// IMessageNotifier is deliberately never invoked, even with a fake transport.
