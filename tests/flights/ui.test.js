const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHandler } = require('../../api/flights');
const { searchFixture, NOW } = require('./fixture-server.cjs');
const recorded = require('./fixtures/search.json');
const script = fs.readFileSync(path.join(__dirname, '../../flights/index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

// Exercise the shipping inline script without a browser or external packages.
// DOM layout, actual events and viewport appearance belong to browser-check.cjs.
function page({ saved, storageFailure = false, fetch } = {}) {
  const storage = new Map(saved === undefined ? [] : [['flights.gold.v2', saved]]);
  const elements = Object.fromEntries(['#app', '#ring', '#toast'].map(k => [k, {
    innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, setAttribute() {},
  }]));
  const location = { hash: '#/search' };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, Date: FixedDate, location,
    history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    document: { title: '', querySelector: s => elements[s] || null, querySelectorAll: () => [], addEventListener() {} },
    window: { scrollTo() {}, addEventListener() {} },
    localStorage: {
      getItem(k) { if (storageFailure) throw new Error('Storage unavailable'); return storage.get(k) ?? null; },
      setItem(k, v) { if (storageFailure) throw new Error('Storage unavailable'); storage.set(k, v); },
    },
    setTimeout: () => 1, clearTimeout() {},
    fetch: fetch || (() => { throw new Error('Live network forbidden in flights UI tests'); }),
  });
  vm.runInContext(script, context, { filename: 'flights/index.html' });
  return {
    run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    put(name, value) { context[name] = value; },
    elements, storage, location,
  };
}

async function backend(url, source = recorded) {
  const handler = createHandler({ now: () => NOW, callTool: async () => structuredClone(source) });
  const req = { method: 'GET', url, headers: { host: 'sam.toys', 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.1' } };
  const res = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  return res.body;
}
function query(p, overrides = {}) {
  p.put('testQuery', { from: 'LON', to: 'MAD', out: '2026-11-18', back: '', cabin: 'Economy', ...overrides });
  p.run('Object.assign(S,testQuery);resultQuery={...S}');
}
function deferredFetch() {
  const calls = [];
  return { calls, fetch(url, options) { return new Promise(resolve => calls.push({ url, signal: options.signal, resolve })); } };
}
const ok = results => ({ ok: true, json: async () => ({ action: 'search', results, meta: {} }) });

test('UI API parameters use explicit London airports, cabin filters and real return dates', () => {
  const p = page(); query(p);
  const params = action => new URLSearchParams(p.run(`params('${action}',S).toString()`));
  assert.equal(params('search').get('origin'), 'LHR,LGW,LCY,STN,LTN,SEN');
  assert.equal(params('search').has('returnDate'), false);
  p.run("S.to='LHR'");
  assert.equal(params('search').get('origin'), 'LGW,LCY,STN,LTN,SEN');
  for (const [label, value] of [['Economy','economy'],['Premium economy','premium'],['Business','business'],['First','first']]) {
    p.put('label', label); p.run('S.cabin=label');
    assert.equal(params('search').get('fareClass'), value);
  }
  p.run("S.from='IBZ';S.to='ANY';S.back='2026-11-21'");
  assert.equal(params('anywhere').get('origin'), 'IBZ');
  assert.equal(params('anywhere').has('destination'), false);
  assert.equal(params('anywhere').get('returnDate'), '2026-11-21');
  p.run("S.to='MAD'");
  assert.equal(params('search').get('returnDate'), '2026-11-21');
  assert.equal(params('flex').has('fareClass'), false);
});

test('calendar taps select one way, later return, earlier replacement, and clear dates', () => {
  const p = page();
  const dates = () => p.json('[S.out,S.back]');
  p.run("tapDay('2026-11-18')"); assert.deepEqual(dates(), ['2026-11-18','']);
  p.run("tapDay('2026-11-21')"); assert.deepEqual(dates(), ['2026-11-18','2026-11-21']);
  p.run("tapDay('2026-11-21')"); assert.deepEqual(dates(), ['2026-11-18','']);
  p.run("tapDay('2026-11-17')"); assert.deepEqual(dates(), ['2026-11-17','']);
  p.run("tapDay('2026-11-17')"); assert.deepEqual(dates(), ['','']);
  p.run("tapDay('2026-11-18');tapDay('2026-11-21');tapDay('2026-11-25')");
  assert.deepEqual(dates(), ['2026-11-25','']);
});

test('Gold defaults to zero, 20,000 and the next March 31, with old missing-target data migrated', () => {
  const p = page();
  assert.deepEqual(p.json('gold'), { tp: 0, target: 20000, ends: '2027-03-31' });
  const old = page({ saved: JSON.stringify({ tp: 1234, ends: '2027-03-31' }) });
  assert.deepEqual(old.json('gold'), { tp: 1234, target: 20000, ends: '2027-03-31' });
  p.run("gold=goldData({tp:321,target:21000,ends:'2028-03-31'})");
  assert.deepEqual(JSON.parse(p.storage.get('flights.gold.v2')), { tp: 321, target: 21000, ends: '2028-03-31' });
});

test('Gold rejects corrupt local data and handles unavailable storage without inventing a balance', () => {
  for (const saved of ['{', 'null', JSON.stringify({tp:-1,ends:'2027-03-31'}), JSON.stringify({tp:42,ends:'2027-02-30'})]) {
    assert.deepEqual(page({ saved }).json('gold'), { tp: 0, target: 20000, ends: '2027-03-31' });
  }
  const p = page({ storageFailure: true });
  assert.deepEqual(p.json('gold'), { tp: 0, target: 20000, ends: '2027-03-31' });
  assert.equal(p.run("goldData({tp:42,target:20000,ends:'2027-03-31'})"), null);
});

test('recorded return fares render backend GBP and tier points once, without doubling', async () => {
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21');
  const fare = data.results.find(f => f.flightNumbers[0] === 'IB714');
  assert.equal(fare.priceGbp, 93.17); assert.equal(fare.estimate.tierPoints, 66);
  const p = page(); query(p, { from: 'LHR', back: '2026-11-21' });
  p.put('data', data); p.put('fareId', fare.id); p.run('response=data');
  const detail = p.run('vFare(fareId)');
  assert.match(detail, /£93\.17/); assert.match(detail, /~66 TP/);
  assert.doesNotMatch(detail, /£186\.34|~132 TP/);
  assert.match(detail, /Out ·/); assert.match(detail, /Back ·/);
});

test('hidden-city detail preserves flown and ticketed endpoints and the actual safe booking link', async () => {
  const args = { origin: 'LHR', destination: 'MAD', departureDate: '2026-11-18' };
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18', searchFixture(args));
  const fare = data.results.find(f => f.hiddenCity);
  assert(fare); assert.equal(fare.leaveAt, 'MAD'); assert.equal(fare.ticketedTo, 'BCN');
  const p = page(); query(p, { from: 'LHR' }); p.put('data', data); p.put('fareId', fare.id); p.run('response=data');
  const detail = p.run('vFare(fareId)');
  assert.match(detail, /You leave at Madrid/); assert.match(detail, /Ticketed to BCN/);
  assert(detail.includes(`href="${fare.deepLink.replaceAll('&','&amp;')}"`));
  assert.match(detail, /Book on Skiplagged/);
  for (const unsafe of ['javascript:alert(1)', 'https://skiplagged.com.evil.test/', 'http://skiplagged.com/', 'https://user@skiplagged.com/', 'https://skiplagged.com:444/']) {
    p.put('unsafe', unsafe); assert.equal(p.run('safeBooking(unsafe)'), null);
  }
  p.run('response.results.find(f=>f.id===fareId).deepLink="javascript:alert(1)"');
  assert.doesNotMatch(p.run('vFare(fareId)'), /id="book"/);
});

test('hostile fare IDs remain encoded in result links and display text is escaped', async () => {
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21');
  data.results = [data.results[0]];
  const id = 'bad"><img src=x onerror=alert(1)>';
  data.results[0].id = id; data.results[0].flightNumbers = ['<svg onload=alert(1)>'];
  const p = page(); query(p); p.put('data', data); p.run('response=data');
  const html = p.run('vResults()');
  assert(html.includes('#/fare/' + encodeURIComponent(id)));
  assert.doesNotMatch(html, /<img|<svg onload/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
});

test('Anywhere and flex discovery never fabricate tier-point ratios', () => {
  const p = page(); query(p, { to: 'ANY' });
  p.run("response={action:'anywhere',results:[{origin:'IBZ',destination:'MAD',priceGbp:40,estimate:null}]}");
  const html = p.run('vResults()');
  assert.match(html, /£40/); assert.match(html, /Check £\/TP/);
  assert.doesNotMatch(html, /per tier point|£\d+\.\d{2}<small>\/TP/);
  query(p); p.run("flexRows=[{departureDate:'2026-11-18',priceGbp:40}]");
  assert.deepEqual(p.json("calendarQuote('2026-11-18')"), { value: '£40', verified: false });
  assert.equal(p.run("calendarQuote('2026-11-19')"), null);
});

test('calendar verified ratios are isolated by route, dates, return duration and cabin', () => {
  const p = page(); query(p);
  p.run('verified.set(cacheKey(S),{priceGbp:100,estimate:{tierPoints:50}})');
  assert.deepEqual(p.json("calendarQuote('2026-11-18')"), { value: '2.00', verified: true });
  assert.equal(p.run("calendarQuote('2026-11-19')"), null);
  for (const change of ["S.cabin='Business'", "S.to='JFK'", "S.from='IBZ'", "S.back='2026-11-21'"]) {
    query(p); p.run(change); assert.equal(p.run("calendarQuote('2026-11-18')"), null);
  }
  query(p, { back: '2026-11-21' });
  p.run('verified.set(cacheKey(S),{priceGbp:100,estimate:{tierPoints:100}})');
  assert.equal(p.run("calendarQuote('2026-11-18').value"), '1.00');
  p.run("S.back='2026-11-22'"); assert.equal(p.run("calendarQuote('2026-11-18')"), null);
});

test('navigation aborts an in-flight search and ignores a provider that resolves after cancellation', async () => {
  const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p);
  const completion = p.run('search()');
  assert.equal(p.location.hash, '#/loading'); assert.equal(pending.calls.length, 1);
  p.run("go('#/gold')"); assert.equal(pending.calls[0].signal.aborted, true);
  pending.calls[0].resolve(ok([])); await completion;
  assert.equal(p.location.hash, '#/gold'); assert.equal(p.run('response'), null);
});

test('a newer search aborts and supersedes an older result regardless of response order', async () => {
  const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p);
  const first = p.run('search()');
  p.run("S.to='JFK'"); const second = p.run('search()');
  assert.equal(pending.calls[0].signal.aborted, true);
  pending.calls[1].resolve(ok([])); await second;
  assert.equal(p.run('resultQuery.to'), 'JFK'); assert.equal(p.location.hash, '#/results');
  pending.calls[0].resolve(ok([{id:'stale'}])); await first;
  assert.equal(p.run('response.results.length'), 0); assert.equal(p.run('resultQuery.to'), 'JFK');
});

test('error and throttled responses render explicit states with Retry-After timing', async () => {
  for (const status of [502,429]) {
    const p = page({ fetch: async () => ({ ok: false, status, headers: { get: () => '12' } }) }); query(p);
    await p.run('search()');
    assert.equal(p.location.hash, '#/error');
    const html = p.elements['#app'].innerHTML;
    if(status===429) { assert.match(html,/A moment, please/); assert.match(html,/12 seconds/); assert.match(html,/disabled/); }
    else assert.match(html,/Skiplagged didn't answer/);
  }
});

test('Gold progress credits only dated sectors before the typed deadline in its collection year', () => {
  const p = page();
  p.run("gold={tp:0,target:20000,ends:'2027-03-30'}");
  p.put('fare', { estimate: { tierPoints: 160, tierPointsByCollectionYear: { '2026-2027': 160 }, breakdown: [
    { date: '2026-03-31', tierPoints: 10 }, { date: '2026-04-01', tierPoints: 20 },
    { date: '2027-03-30', tierPoints: 30 }, { date: '2027-03-31', tierPoints: 100 },
  ] } });
  assert.equal(p.run('goldForFare(fare)'), 50);
  p.run("gold.ends='2027-03-31'"); assert.equal(p.run('goldForFare(fare)'), 150);
  p.run("gold.ends='2026-12-31'"); assert.equal(p.run('goldForFare(fare)'), 20);
});

test('changing destination refreshes an enabled calendar with current route discovery', async () => {
  const calls = [];
  const p = page({ fetch: async url => { calls.push(url); return { ok: true, json: async () => ({ results: [] }) }; } });
  query(p); p.run('calOpen=true;S.prices=true');
  p.run("chooseDestination('JFK')");
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0], 'https://sam.toys').searchParams.get('destination'), 'JFK');
  assert.equal(new URL(calls[0], 'https://sam.toys').searchParams.get('action'), 'flex');
  p.run("go('#/gold')"); // cleanly cancel the pending discovery render
});
