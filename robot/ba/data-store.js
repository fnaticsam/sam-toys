'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { privateDir, readJson, writeJson, lockDirectory } = require('./private-files');
const { fail } = require('./errors');

const TABLES = ['ba_account_snapshots', 'reward_searches', 'reward_results', 'booking_requests', 'robot_events'];
const EVENT_KINDS = new Set(['login_reserved', 'search_reserved', 'safety_stop', 'safety_acknowledged', 'otp_requested', 'run_failed', 'login_failed']);
function eventRow(accountRef, kind, details = {}, now = Date.now()) {
  if (!EVENT_KINDS.has(kind)) fail('EVENT_KIND');
  const clean = {};
  // Only known machine codes/UUIDs can enter audit details. No text, HTML or credentials.
  for (const key of ['reason', 'request_id', 'search_id']) {
    if (details[key] !== undefined) {
      if (!/^(?:[A-Z_]{1,64}|[a-f0-9-]{36})$/.test(details[key])) fail('EVENT_DETAILS');
      clean[key] = details[key];
    }
  }
  return { id: randomUUID(), account_ref: accountRef, kind, details: clean, created_at: new Date(now).toISOString(), otp_code: null, otp_expires_at: null, otp_consumed_at: null };
}
class DataStore {
  async saveSnapshot() { fail('NOT_IMPLEMENTED'); }
  async createSearch() { fail('NOT_IMPLEMENTED'); }
  async completeSearch() { fail('NOT_IMPLEMENTED'); }
  async failSearch() { fail('NOT_IMPLEMENTED'); }
  async recordEvent() { fail('NOT_IMPLEMENTED'); }
  async createOtpRequest() { fail('NOT_IMPLEMENTED'); }
  async submitOtp() { fail('NOT_IMPLEMENTED'); }
  async consumeOtp() { fail('NOT_IMPLEMENTED'); }
  async closeOtp() { fail('NOT_IMPLEMENTED'); }
  // No booking mutation API in this phase. booking_requests is reserved and untouched.
}
class FileDataStore extends DataStore {
  constructor(file, { now = Date.now } = {}) {
    super(); this.file = path.resolve(file); this.now = now; this.queue = Promise.resolve();
  }
  transact(fn) {
    const work = this.queue.then(async () => {
      await privateDir(path.dirname(this.file));
      const unlock = await lockDirectory(`${this.file}.lock`);
      try {
        const db = await readJson(this.file, Object.fromEntries(TABLES.map(t => [t, []])));
        if (!TABLES.every(t => Array.isArray(db[t]))) fail('STORE_CONTRACT');
        const result = fn(db);
        await writeJson(this.file, db);
        return result;
      } finally { await unlock(); }
    });
    this.queue = work.catch(() => {}); return work;
  }
  saveSnapshot(accountRef, snapshot) {
    return this.transact(db => {
      const row = { ...snapshot, id: randomUUID(), account_ref: accountRef, captured_at: new Date(this.now()).toISOString() };
      db.ba_account_snapshots.push(row); return row;
    });
  }
  createSearch(accountRef, query) {
    return this.transact(db => {
      const row = { id: randomUUID(), account_ref: accountRef, origin: query.from, destination: query.to, departure_date: query.date, cabin: query.cabin,
        adults: 1, trip_type: 'one_way', status: 'running', requested_at: new Date(this.now()).toISOString(), completed_at: null, failure_code: null };
      db.reward_searches.push(row); return row;
    });
  }
  completeSearch(id, results) {
    return this.transact(db => {
      const search = db.reward_searches.find(r => r.id === id && r.status === 'running');
      if (!search) fail('SEARCH_STATE');
      const rows = results.map(r => ({ ...r, id: randomUUID(), search_id: id }));
      db.reward_results.push(...rows); search.status = 'completed'; search.completed_at = new Date(this.now()).toISOString();
      return rows;
    });
  }
  failSearch(id, code) {
    return this.transact(db => {
      const row = db.reward_searches.find(r => r.id === id && r.status === 'running');
      if (row) { row.status = 'failed'; row.failure_code = /^[A-Z_]+$/.test(code) ? code : 'ROBOT_FAILED'; row.completed_at = new Date(this.now()).toISOString(); }
    });
  }
  recordEvent(accountRef, kind, details) {
    return this.transact(db => { const row = eventRow(accountRef, kind, details, this.now()); db.robot_events.push(row); return row; });
  }
  reserveAction(accountRef, action, limit, windowMs) {
    return this.transact(db => {
      const kind = `${action}_reserved`, now = this.now();
      const events = db.robot_events.filter(r => r.account_ref === accountRef && r.kind === kind && Date.parse(r.created_at) > now - windowMs);
      // Future events also count: a backwards system clock cannot reset a quota.
      if (events.length >= limit) fail(action === 'login' ? 'LOGIN_LIMIT' : 'SEARCH_LIMIT');
      const row = eventRow(accountRef, kind, {}, now); db.robot_events.push(row); return row;
    });
  }
  checkSafety(accountRef, acknowledgedId) {
    return this.transact(db => {
      const events = db.robot_events.filter(r => r.account_ref === accountRef);
      const stop = events.findLast(r => r.kind === 'safety_stop');
      if (!stop) return;
      const ack = events.findLast(r => r.kind === 'safety_acknowledged');
      if (ack?.details.request_id === stop.id) return;
      if (acknowledgedId !== stop.id) fail('SAFETY_LATCHED');
      db.robot_events.push(eventRow(accountRef, 'safety_acknowledged', { request_id: stop.id }, this.now()));
    });
  }
  createOtpRequest(accountRef, expiresAt) {
    return this.transact(db => {
      const row = eventRow(accountRef, 'otp_requested', {}, this.now());
      row.otp_expires_at = new Date(expiresAt).toISOString(); db.robot_events.push(row); return row.id;
    });
  }
  submitOtp(accountRef, id, code) {
    if (!/^\d{6,8}$/.test(code)) fail('OTP_FORMAT');
    return this.transact(db => {
      const row = db.robot_events.find(r => r.id === id && r.account_ref === accountRef && r.kind === 'otp_requested');
      if (!row || row.otp_consumed_at || Date.parse(row.otp_expires_at) <= this.now()) fail('OTP_EXPIRED');
      row.otp_code = code;
    });
  }
  consumeOtp(accountRef, id) {
    return this.transact(db => {
      const row = db.robot_events.find(r => r.id === id && r.account_ref === accountRef && r.kind === 'otp_requested');
      if (!row || row.otp_consumed_at) return null;
      if (Date.parse(row.otp_expires_at) <= this.now()) { row.otp_code = null; row.otp_consumed_at = new Date(this.now()).toISOString(); return null; }
      if (!row.otp_code) return null;
      const code = row.otp_code;
      row.otp_code = null; row.otp_consumed_at = new Date(this.now()).toISOString();
      if (!/^\d{6,8}$/.test(code)) fail('OTP_FORMAT');
      return code;
    });
  }
  closeOtp(accountRef, id) {
    return this.transact(db => {
      const row = db.robot_events.find(r => r.id === id && r.account_ref === accountRef && r.kind === 'otp_requested');
      if (row) { row.otp_code = null; row.otp_consumed_at = new Date(this.now()).toISOString(); }
    });
  }
}
class SupabaseDataStore extends DataStore {
  #key;
  constructor({ url, serviceRoleKey, fetchImpl = globalThis.fetch, now = Date.now }) {
    super();
    let endpoint; try { endpoint = new URL(url); } catch { fail('SUPABASE_CONFIG'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !serviceRoleKey) fail('SUPABASE_CONFIG');
    this.endpoint = endpoint.origin; this.#key = serviceRoleKey; this.fetchImpl = fetchImpl; this.now = now;
  }
  async request(resource, { method = 'POST', body, prefer = 'return=representation' } = {}) {
    try {
      const response = await this.fetchImpl(`${this.endpoint}/rest/v1/${resource}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { apikey: this.#key, Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json',
          'Accept-Profile': 'flights', 'Content-Profile': 'flights', Prefer: prefer },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!response.ok) fail('DATASTORE_REQUEST');
      if (response.status === 204) return null;
      return await response.json();
    } catch { fail('DATASTORE_REQUEST'); } // Never surface fetch errors, headers or response bodies.
  }
  async saveSnapshot(accountRef, snapshot) {
    const row = { ...snapshot, id: randomUUID(), account_ref: accountRef, captured_at: new Date(this.now()).toISOString() };
    await this.request('ba_account_snapshots', { body: row }); return row;
  }
  async createSearch(accountRef, query) {
    const row = { id: randomUUID(), account_ref: accountRef, origin: query.from, destination: query.to, departure_date: query.date,
      cabin: query.cabin, adults: 1, trip_type: 'one_way', status: 'running', requested_at: new Date(this.now()).toISOString() };
    await this.request('reward_searches', { body: row }); return row;
  }
  completeSearch(id, results) { return this.request('rpc/complete_robot_reward_search', { body: { p_search_id: id, p_results: results } }); }
  failSearch(id, code) {
    if (!/^[A-Z_]{1,64}$/.test(code)) fail('EVENT_DETAILS');
    return this.request(`reward_searches?id=eq.${encodeURIComponent(id)}&status=eq.running`, { method: 'PATCH', body: { status: 'failed', failure_code: code, completed_at: new Date(this.now()).toISOString() } });
  }
  async recordEvent(accountRef, kind, details) {
    const row = eventRow(accountRef, kind, details, this.now());
    await this.request('robot_events', { body: row }); return row;
  }
  async createOtpRequest(accountRef, expiresAt) {
    const row = eventRow(accountRef, 'otp_requested', {}, this.now()); row.otp_expires_at = new Date(expiresAt).toISOString();
    await this.request('robot_events', { body: row }); return row.id;
  }
  submitOtp(accountRef, id, code) {
    if (!/^\d{6,8}$/.test(code)) fail('OTP_FORMAT');
    return this.request('rpc/submit_robot_otp', { body: { p_account_ref: accountRef, p_request_id: id, p_code: code } });
  }
  async consumeOtp(accountRef, id) {
    const code = await this.request('rpc/consume_robot_otp', { body: { p_account_ref: accountRef, p_request_id: id } });
    if (code !== null && (typeof code !== 'string' || !/^\d{6,8}$/.test(code))) fail('OTP_FORMAT');
    return code;
  }
  closeOtp(accountRef, id) {
    return this.request(`robot_events?id=eq.${encodeURIComponent(id)}&account_ref=eq.${encodeURIComponent(accountRef)}&kind=eq.otp_requested`,
      { method: 'PATCH', body: { otp_code: null, otp_consumed_at: new Date(this.now()).toISOString() } });
  }
}
module.exports = { DataStore, FileDataStore, SupabaseDataStore, TABLES };
