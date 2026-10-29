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
function page({ saved, liveSaved, earningOnly, storageFailure = false, fetch } = {}) {
  const storage = new Map(saved === undefined ? [] : [['flights.gold.v2', saved]]);
  if (liveSaved !== undefined) storage.set('flights.gold.live.v1', liveSaved);
  if (earningOnly !== undefined) storage.set('flights.earningOnly.v1', earningOnly);
  function classList() {
    const values = new Set();
    return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value),
      toggle(value, force) { const on = force === undefined ? !values.has(value) : force; if (on) values.add(value); else values.delete(value); return on; } };
  }
  const elements = Object.fromEntries(['#app', '#ring', '#toast'].map(k => [k, {
    innerHTML: '', textContent: '', classList: classList(), setAttribute() {},
  }]));
  const events = {};
  const location = { hash: '#/search' };
  const lists = {};
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, Date: FixedDate, location,
    history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    document: { title: '', body: { classList: classList() }, querySelector: s => elements[s] || null, querySelectorAll: s => lists[s] || [], addEventListener(name, handler) { events[name] = handler; } },
    window: { scrollTo() {}, addEventListener() {} },
    localStorage: {
      getItem(k) { if (storageFailure) throw new Error('Storage unavailable'); return storage.get(k) ?? null; },
      setItem(k, v) { if (storageFailure) throw new Error('Storage unavailable'); storage.set(k, v); },
    },
    setTimeout: () => 1, clearTimeout() {},
    fetch: fetch || (() => { throw new Error('Live network forbidden in flights UI tests'); }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../flights/cities.js'),'utf8'), context, { filename:'flights/cities.js' });
  vm.runInContext(script, context, { filename: 'flights/index.html' });
  return {
    run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    put(name, value) { context[name] = value; },
    elements, lists, storage, location, events,
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

function searchControls(p, value) {
  for (const name of ['#sf', '#whenBtn', '#cabin', '#fromBtn']) p.elements[name] = {};
  const attributes = new Map();
  const input = p.elements['#to'] = {
    value, attributes, focus() { input.onfocus?.(); },
    setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
    parentNode: { querySelector: () => null, insertAdjacentHTML() {} },
  };
  p.run('bind()');
  return { input, submit: () => p.elements['#sf'].onsubmit({ preventDefault() {} }),
    enter: () => input.onkeydown({ key: 'Enter', preventDefault() {} }) };
}

test('UI API parameters use city codes once with the maximum provider limit, cabin filters and real return dates', () => {
  const p = page(); query(p);
  const params = action => new URLSearchParams(p.run(`params('${action}',S).toString()`));
  assert.equal(params('search').get('origin'), 'LON');
  assert.equal(params('search').get('limit'), '100');
  assert.equal(params('search').has('returnDate'), false);
  p.run("S.to='LHR'");
  assert.equal(params('search').get('origin'), 'LON');
  for (const [label, value] of [['Economy','economy'],['Premium economy','premium'],['Business','business'],['First','first']]) {
    p.put('label', label); p.run('S.cabin=label');
    assert.equal(params('search').get('fareClass'), value);
  }
  p.run("S.from='IBZ';S.to='ANY';S.back='2026-11-21'");
  assert.equal(params('anywhere').get('origin'), 'IBZ');
  assert.equal(params('anywhere').has('destination'), false);
  assert.equal(params('anywhere').get('returnDate'), '2026-11-21');
  assert.equal(params('anywhere').has('limit'), false);
  p.run("S.to='MAD'");
  assert.equal(params('search').get('returnDate'), '2026-11-21');
  assert.equal(params('flex').has('fareClass'), false);
  assert.equal(params('flex').has('limit'), false);
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
  assert.deepEqual(JSON.parse(p.storage.get('flights.gold.live.v1')), { tp: 321, target: 21000, ends: '2028-03-31' });
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
  data.meta.airports = { ...data.meta.airports, LHR: 'London' };
  const p = page(); query(p, { from: 'LHR', back: '2026-11-21' });
  p.put('data', data); p.put('fareId', fare.id); p.run('response=data');
  const detail = p.run('vFare(fareId)');
  assert.match(detail, /£93\.17/); assert.match(detail, /~66 TP/);
  assert.doesNotMatch(detail, /£186\.34|~132 TP/);
  assert.match(detail, /Out ·/); assert.match(detail, /Back ·/);
  assert.match(detail, /London Heathrow · LHR/);
});

test('hidden-city detail preserves flown and ticketed endpoints and the actual safe booking link', async () => {
  const args = { origin: 'LHR', destination: 'MAD', departureDate: '2026-11-18' };
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18', searchFixture(args));
  const fare = data.results.find(f => f.hiddenCity);
  assert(fare); assert.equal(fare.leaveAt, 'MAD'); assert.equal(fare.ticketedTo, 'BCN');
  const p = page(); query(p, { from: 'LHR' }); p.put('data', data); p.put('fareId', fare.id); p.run('response=data');
  const detail = p.run('vFare(fareId)');
  assert.match(detail, /You leave at Madrid/); assert.match(detail, /Barcelona · BCN/);
  assert.match(detail, /Iberia · Economy · cabin bag only/);
  assert.match(detail, /class="lg"><span class="fn">IB 714<\/span> · 2h30/);
  assert.match(detail, /class="lg ghost"><span class="fn">IB 411<\/span> · 1h/);
  assert.match(detail, /Skipping a sector can invalidate the ticket and credit\./);
  assert.doesNotMatch(detail, /Tier points and Avios are estimates|connecting/);
  const rows = p.run('vResults()');
  assert.match(rows, /ticketed to BCN, leave at MAD/);
  assert.doesNotMatch(rows, /IB411|hidden city ·/);
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
  data.results[0].legs[0].units[0].flightNumbers = ['<svg onload=alert(1)>'];
  const p = page(); query(p); p.put('data', data); p.run('response=data');
  const html = p.run('vResults()');
  assert(html.includes('#/fare/' + encodeURIComponent(id)));
  assert.doesNotMatch(html, /<img|<svg onload/);
  assert.match(p.run('vFare(data.results[0].id)'), /&lt;svg onload=alert\(1\)&gt;/);
});

test('Anywhere and flex discovery never fabricate tier-point ratios', () => {
  const p = page(); query(p, { to: 'ANY' });
  p.run("response={action:'anywhere',results:[{origin:'IBZ',destination:'MAD',priceGbp:40,estimate:null}]}");
  const html = p.run('vResults()');
  assert.match(html, /£40/); assert.doesNotMatch(html, /›/); assert.doesNotMatch(html, /Check £\/TP/);
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

test('a late search reply preserves navigation before the hashchange handler renders', async () => {
  const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p);
  const completion = p.run('search()');
  // Native link navigation changes the hash before its hashchange event runs.
  p.location.hash = '#/search';
  assert.equal(pending.calls[0].signal.aborted, false);
  pending.calls[0].resolve(ok([])); await completion;
  assert.equal(p.location.hash, '#/search'); assert.equal(p.run('response'), null);
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


test('London results collapse identical flight times to the best fare and keep its airport', async () => {
  const data = await backend('/api/flights?origin=LHR,LGW&destination=MAD&departureDate=2026-11-18', searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  const base = data.results.find(f => !f.hiddenCity);
  const best = structuredClone(base);
  best.id = 'best-LGW'; best.origin = 'LGW'; best.departure.airport = 'LGW'; best.priceGbp = base.priceGbp - 1;
  best.legs[0].units[0].departure.airport = 'LGW'; best.legs[0].units[0].from = 'LGW';
  data.results = [base, best, {...structuredClone(base), id:'later', departure:{...base.departure,dateTime:'2026-11-18T20:45:00+00:00'}}];
  const p = page(); query(p); p.put('data',data); p.run('response=data');
  assert.deepEqual(p.json('fares().map(f=>f.id)'), ['best-LGW','later']);
  assert.match(p.run('vResults()'), /<span>LGW<\/span>/);
});

test('list money rounds pounds while fare money always retains two decimal places', () => {
  const p = page();
  assert.equal(p.run('money(100.1)'), '£100');
  assert.equal(p.run('money(100.6)'), '£101');
  assert.equal(p.run('money(100.1,true)'), '£100.10');
  assert.equal(p.run('money(100,true)'), '£100.00');
});

test('Anywhere groups airports by catalogue city and selects its cheapest origin and airport', () => {
  const p = page(); query(p, {to:'ANY'});
  p.put('data', {action:'anywhere',meta:{airports:{BCN:'Barcelona',GRO:'Barcelona',BOD:'Bordeaux, Gironde'}},results:[
    {origin:'LHR',destination:'BCN',priceGbp:80}, {origin:'LGW',destination:'GRO',priceGbp:40},
    {origin:'LTN',destination:'BCN',priceGbp:60}, {origin:'LGW',destination:'BOD',priceGbp:50},
  ]});
  p.run('response=data');
  assert.deepEqual(p.json('discoveries().map(r=>[r.origin,r.destination])'), [['LGW','GRO'],['LGW','BOD']]);
  const html = p.run('vAnywhere()');
  assert.equal((html.match(/class="row"/g)||[]).length, 2);
  assert.match(html, /Barcelona/); assert.match(html, /Bordeaux<\/span>/);
  assert.doesNotMatch(html, /Gironde|›/);
  assert.match(html, /from LGW/); assert.match(html, /list discovery/);
  assert.doesNotMatch(html, /Check £\/TP/);
});

test('partial results name failed airports separately from the estimates caveat', () => {
  const p = page();
  p.run("response={partial:true,failures:[{origin:'LCY'},{origin:'SEN'},{origin:'LCY'}]}");
  assert.match(p.run('partialNote()'), /LCY and SEN didn't answer/);
  assert.doesNotMatch(p.run('resultNote()'), /LCY|SEN|origins|answer/);
});

test('calendar opens on selected month or rolls forward with fewer than seven selectable days', () => {
  const p = page();
  assert.equal(p.run("calendarMonth('2026-10-28','')"), '2026-11');
  assert.equal(p.run("calendarMonth('2026-10-25','')"), '2026-10');
  assert.equal(p.run("calendarMonth('2026-10-26','')"), '2026-11');
  assert.equal(p.run("calendarMonth('2026-12-28','')"), '2027-01');
  assert.equal(p.run("calendarMonth('2026-10-28','2027-02-18')"), '2027-02');
});

test('Gold at zero draws only its track and retains the editable Target row', () => {
  const p = page();
  assert.equal((p.run('ring(180,8,0)').match(/<circle/g)||[]).length, 1);
  assert.equal((p.run('ring(180,8,0.5)').match(/<circle/g)||[]).length, 2);
  assert.match(p.run('vGold()'), /<label>Target<input id="gtarget"/);
});

test('oneworld defaults on, persists off, survives unavailable storage, and scopes API and calendar caches', () => {
  const p = page(); query(p);
  assert.equal(p.run('S.earningOnly'), true);
  for (const action of ['search', 'anywhere', 'flex']) {
    assert.equal(new URLSearchParams(p.run(`params('${action}',S).toString()`)).get('earningOnly'), 'true');
  }
  const firstKey = p.run('cacheKey(S)');
  p.run('S.earningOnly=false');
  assert.notEqual(p.run('cacheKey(S)'), firstKey);
  for (const action of ['search', 'anywhere', 'flex']) {
    assert.equal(new URLSearchParams(p.run(`params('${action}',S).toString()`)).get('earningOnly'), 'false');
  }
  assert.equal(page({ earningOnly: 'false' }).run('S.earningOnly'), false);
  assert.equal(page({ earningOnly: 'invalid' }).run('S.earningOnly'), true);
  assert.equal(page({ storageFailure: true }).run('S.earningOnly'), true);
});

test('changing oneworld persists and repeats the route search with the new flag', async () => {
  const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p);
  p.location.hash = '#/results';
  const completion = p.run('setEarningOnly(false)');
  assert.equal(p.storage.get('flights.earningOnly.v1'), 'false');
  assert.equal(p.run('S.earningOnly'), false);
  assert.equal(pending.calls.length, 1);
  assert.equal(new URL(pending.calls[0].url, 'https://sam.toys').searchParams.get('earningOnly'), 'false');
  pending.calls[0].resolve(ok([])); await completion;
});

test('all-airline cards keep non-earning TP neutral and omit a tier-point ratio', async () => {
  const args = { origin: 'LHR', destination: 'MAD', departureDate: '2026-11-18' };
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&earningOnly=false', searchFixture(args));
  const fare = data.results.find(f => f.earns === false);
  assert(fare, 'fixture must exercise a real normalized non-earning result');
  assert.equal(fare.gbpPerTierPoint, null);
  const p = page(); query(p, { earningOnly: false }); p.put('data', data); p.put('fare', fare); p.run('response=data');
  const html = p.run('card(fare,1)');
  assert.match(html, /No TP/);
  assert.doesNotMatch(html, /class="tpv"|\+0 TP|\/TP/);
  const results = p.run('vResults()');
  assert.match(results, /All airlines/);
  assert.match(results, /id="earningOnly"/);
  assert.doesNotMatch(p.run('vFare(fare.id)'), /earns ~0|\+0 TP|£0\.00\/TP/);
});

test('four result sorts put earning fares first only for value and tier points', () => {
  const p = page();
  const rows = [
    { id: 'value', earns: true, priceGbp: 120, estimate: {tierPoints:120}, departure:{dateTime:'2026-11-18T08:00:00Z'}, arrival:{dateTime:'2026-11-18T12:00:00Z'} },
    { id: 'points', earns: true, priceGbp: 300, estimate: {tierPoints:200}, departure:{dateTime:'2026-11-18T08:00:00Z'}, arrival:{dateTime:'2026-11-18T13:00:00Z'} },
    { id: 'none-cheap', earns: false, priceGbp: 30, estimate: {tierPoints:0}, departure:{dateTime:'2026-11-18T08:00:00Z'}, arrival:{dateTime:'2026-11-18T10:00:00Z'} },
    { id: 'none-fast', earns: false, priceGbp: 60, estimate: {tierPoints:null}, departure:{dateTime:'2026-11-18T08:00:00Z'}, arrival:{dateTime:'2026-11-18T09:00:00Z'} },
  ];
  p.put('rows', rows);
  const expected = { value: ['value','points','none-cheap','none-fast'], tp: ['points','value','none-cheap','none-fast'],
    cheap: ['none-cheap','none-fast','value','points'], fast: ['none-fast','none-cheap','value','points'] };
  for (const [sort, ids] of Object.entries(expected)) {
    p.put('sort',sort); p.run('SORT=sort');
    assert.deepEqual(p.json('sortedFares(rows).map(f=>f.id)'), ids, sort);
  }
  assert.deepEqual(p.json('rows.map(f=>f.id)'), rows.map(f => f.id), 'sorting preserves source order');
});

test('v3 filters expose stops prices, hour histograms, two handles, and airline choices', async () => {
  const args = { origin:'LHR', destination:'MAD', departureDate:'2026-11-18' };
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&earningOnly=false', searchFixture(args));
  const p = page(); query(p, { earningOnly:false }); p.put('data',data); p.run('response=data');
  const html = p.run('filtersHTML()');
  assert.match(html, /oneworld only/);
  assert.equal((html.match(/name="stops"/g)||[]).length, 3);
  assert.match(html, /Direct/); assert.match(html, /from £/);
  assert.equal((html.match(/type="range"/g)||[]).length, 4);
  assert.match(html, /Take-off from/); assert.match(html, /Landing until/);
  assert.equal((html.match(/class="hist"/g)||[]).length, 2);
  assert.match(html, /type="checkbox" value="FR"/);
  assert.match(html, /id="fshow"/);
  const results = p.run('vResults()');
  assert.match(results, /id="fopen"/);
  assert.equal((results.match(/role="tab"/g)||[]).length, 4);
  const f = data.results.find(f=>f.earns);
  p.put('fare',f);
  p.run("F.dep=[0,1]"); assert.equal(p.run('passes(fare)'),false);
  p.run("resetFilters();F.arr=[0,1]"); assert.equal(p.run('passes(fare)'),false);
  p.run("resetFilters();F.air=new Set(['FR'])"); assert.equal(p.run('passes(fare)'),false);
  p.run('resetFilters()'); assert.equal(p.run('passes(fare)'),true);
});

test('go closes an open calendar and performs a real route search', async () => {
  const pending = deferredFetch(), p = page({fetch:pending.fetch}); query(p);
  p.run('calOpen=true'); const completion = p.run('submitSearch()');
  assert.equal(p.run('calOpen'),false); assert.equal(pending.calls.length,1);
  assert.equal(new URL(pending.calls[0].url,'https://sam.toys').searchParams.get('destination'),'MAD');
  pending.calls[0].resolve(ok([])); await completion;
});

test('go without a destination focuses the field and makes the missing choice explicit', () => {
  const p = page(); query(p, {to:''}); let focused = false;
  p.elements['#to'] = {focus() {focused=true;}};
  p.run('submitSearch()');
  assert.equal(focused,true); assert.match(p.run('hint'),/where|destination/i);
});

test('Enter in Where-to dispatches a search for a typed airport and closes the calendar', async () => {
  const pending = deferredFetch(), p = page({fetch:pending.fetch}); query(p, {to:''});
  for (const name of ['#sf','#whenBtn','#cabin','#fromBtn']) p.elements[name] = {};
  p.elements['#to'] = {value:'JFK'};
  p.run("calOpen=true;draft='JFK';bind()");
  let prevented = false;
  p.elements['#to'].onkeydown({key:'Enter',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(pending.calls.length,1);
  assert.equal(new URL(pending.calls[0].url,'https://sam.toys').searchParams.get('destination'),'JFK');
  assert.equal(p.run('calOpen'),false);
  p.run("go('#/gold')"); pending.calls[0].resolve(ok([])); await Promise.resolve();
});

test('deselecting every airline shows no fares, while reset restores all carriers', async () => {
  const args = {origin:'LHR',destination:'MAD',departureDate:'2026-11-18'};
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&earningOnly=false',searchFixture(args));
  const p = page(); query(p,{earningOnly:false});p.put('data',data);p.run('response=data;F.air=new Set()');
  assert.equal(p.run('fares().filter(f=>passes(f)).length'),0);
  assert.match(p.run('cardsHTML()'),/No flights match these filters/);
  p.run('resetFilters()');
  assert.equal(p.run('fares().filter(f=>passes(f)).length'),p.run('fares().length'));
});

test('non-earning airline display names survive normalization and are escaped in every view', async () => {
  const args = {origin:'LHR',destination:'MAD',departureDate:'2026-11-18'};
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&earningOnly=false',searchFixture(args));
  const fare = data.results.find(f => f.earns === false);
  assert.equal(fare.airlines,'Ryanair');
  const p = page(); query(p,{earningOnly:false}); p.put('data',data); p.put('fare',fare); p.run('response=data');
  assert.match(p.run('card(fare,1)'),/class="air">Ryanair/);
  assert.match(p.run('filtersHTML()'),/<b>Ryanair<\/b>/);
  assert.match(p.run('vFare(fare.id)'),/class="who">Ryanair · Economy/);
  p.run('fare.airlines=\'Hostile <img src=x onerror=alert(1)>\'');
  for (const view of ['card(fare,1)','filtersHTML()','vFare(fare.id)']) {
    const html=p.run(view);
    assert.match(html,/Hostile &lt;img src=x onerror=alert\(1\)&gt;/,view);
    assert.doesNotMatch(html,/<img|onerror="/,view);
  }
});

test('hidden-city card tolerates an unknown flown arrival time without inventing a duration', async () => {
  const args = {origin:'LHR',destination:'MAD',departureDate:'2026-11-18'};
  const source=searchFixture(args);
  const hidden=source.flights.find(f=>f.attributes.includes('hidden-city'));
  delete hidden.segments[0].arrival;
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',source);
  const fare=data.results.find(f=>f.hiddenCity); assert(fare);
  assert.deepEqual(fare.arrival,{airport:'MAD',dateTime:null});
  const p=page();query(p);p.put('data',data);p.put('fare',fare);p.run('response=data');
  const leg=p.run('legRow(fare,0)');
  assert.match(leg,/Time unavailable/);assert.match(leg,/<span>MAD<\/span>/);
  const card=p.run('card(fare,0)');
  assert.match(card,/Duration unavailable/);
  assert.doesNotMatch(card,/NaN|undefined|\+null/);
});

test('opaque connected itinerary counts stops and labels the connection without fabricating airports', async () => {
  const args = {origin:'LHR',destination:'MAD',departureDate:'2026-11-18'};
  const source=searchFixture(args), connection=source.flights[0];
  source.flights=[connection];
  connection.layovers=1;
  connection.deepLink='https://skiplagged.com/flights/LHR/MAD/2026-11-18#trip=IB714-IB411';
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',source);
  assert.equal(data.results.length,1);
  const fare=data.results[0]; assert.equal(fare.legs[0].units[0].opaque,true);
  const p=page();query(p);p.put('data',data);p.put('fare',fare);p.run('response=data');
  assert.equal(p.run('stopsOf(fare)'),1);
  assert.match(p.run('legRow(fare,0)'),/class="via">Connection<\/div>/);
  const card=p.run('card(fare,0)');
  assert.match(card,/<b>1 stop<\/b>/);
  assert.doesNotMatch(card,/NaN|undefined|<b>Direct<\/b>|BCN/);
  p.run("F.stops='0'");assert.equal(p.run('passes(fare)'),false);
  p.run("F.stops='1'");assert.equal(p.run('passes(fare)'),true);
});

test('go and Enter resolve typed city names and IATA codes without choosing a suggestion', async () => {
  for (const method of ['submit', 'enter']) {
    for (const [value, from, expected] of [['London Heathrow', 'IBZ', 'LHR'], [' madrid ', 'LON', 'MAD'], ['jfk', 'LON', 'JFK'], ['New York', 'LON', 'NYC'], ['NYC', 'LON', 'NYC'], ['London', 'IBZ', 'LON'], ['Anywhere', 'LON', 'ANY']]) {
      const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { from });
      const controls = searchControls(p, value);
      // The real input event must discard the previously selected destination.
      controls.input.oninput();
      p.run('calOpen=true;fromOpen=true');
      const completion = controls[method]();
      assert.equal(pending.calls.length, 1, `${method}: ${value}`);
      const params = new URL(pending.calls[0].url, 'https://sam.toys').searchParams;
      assert.equal(params.get('action'), expected === 'ANY' ? 'anywhere' : 'search');
      assert.equal(params.get('destination'), expected === 'ANY' ? null : expected);
      assert.deepEqual(p.json('[calOpen,sugOpen,fromOpen]'), [false, false, false]);
      assert.equal(p.location.hash, '#/loading');
      // Stop rendering into the deliberately minimal DOM when the response arrives.
      p.run("go('#/gold')"); pending.calls[0].resolve(ok([])); await completion;
    }
  }
});

test('Enter uses the keyboard-highlighted suggestion; go resolves the typed text', async () => {
  for (const method of ['enter', 'submit']) {
    const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { to: '' });
    const controls = searchControls(p, 'Tokyo');
    controls.input.oninput();
    p.lists['[data-to]'] = ['HND', 'NRT'].map(code => ({ dataset: { to: code }, id: `suggest-${code}`, classList: { toggle() {} }, setAttribute() {} }));
    for (let n = 0; n < 2; n++) controls.input.onkeydown({ key: 'ArrowDown', preventDefault() {} });
    assert.equal(controls.input.attributes.get('aria-activedescendant'), 'suggest-NRT');
    const completion = controls[method]();
    assert.equal(new URL(pending.calls[0].url, 'https://sam.toys').searchParams.get('destination'), method === 'enter' ? 'NRT' : 'TYO');
    p.run("go('#/gold')"); pending.calls[0].resolve(ok([])); await completion;
  }
});

test('unmatched text is explained next to the destination and never sends an API request', () => {
  for (const method of ['enter', 'submit']) {
    const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { to: '' });
    const controls = searchControls(p, 'zzqq'); controls.input.oninput();
    p.run('calOpen=true'); controls[method]();
    assert.equal(pending.calls.length, 0);
    assert.equal(p.run('hint'), 'No airport matches “zzqq”.');
    assert.deepEqual(p.json('[calOpen,sugOpen]'), [false, false]);
    const html = p.run('vSearch()');
    assert.match(html, /id="to"[^>]*aria-invalid="true" aria-describedby="toError"/);
    assert.match(html, /id="toError" role="status">No airport matches “zzqq”\.<\/div>\s*<\/form>/);
    assert(html.indexOf('id="toError"') < html.indexOf('id="cabin"'));
    // Correcting the input removes the stale error without stealing focus.
    let removed = false;
    p.elements['#toError'] = { remove() { removed = true; } };
    controls.input.value = 'Madrid'; controls.input.oninput();
    assert.equal(removed, true); assert.equal(p.run('hint'), '');
    assert.equal(p.run('sugOpen'), true);
  }
  const p = page(); query(p, { to: '' });
  const controls = searchControls(p, '<img src=x>'); controls.input.oninput(); controls.submit();
  assert.match(p.run('vSearch()'), /No airport matches “&lt;img src=x&gt;”\./);
  assert.doesNotMatch(p.run('vSearch()'), /<img/);
});

test('missing dates open the calendar and explain the problem beside When for go and Enter', () => {
  for (const method of ['submit', 'enter']) {
    const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { to: '', out: '' });
    const controls = searchControls(p, 'Madrid'); controls.input.oninput(); controls[method]();
    assert.equal(pending.calls.length, 0); assert.equal(p.run('S.to'), 'MAD');
    assert.equal(p.location.hash, '#/search/when');
    assert.deepEqual(p.json('[calOpen,sugOpen]'), [true, false]);
    const html = p.run('vSearch()');
    assert.match(html, /id="whenBtn"[^>]*aria-describedby="dateError"/);
    assert.match(html, /id="dateError" role="status">Pick a date\.<\/div>\s*<div class="cal"/);
    assert(html.indexOf('id="dateError"') < html.indexOf('id="cabin"'));
  }
});

test('same-city groups reject London and New York destinations before requesting fares', () => {
  for (const [from, value] of [['LON', 'London Heathrow'], ['LON', 'LHR'], ['LHR', 'LGW'], ['NYC', 'JFK'], ['JFK', 'EWR'], ['HND', 'NRT']]) {
    for (const method of ['enter', 'submit']) {
      const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { from, to: '' });
      const controls = searchControls(p, value); controls.input.oninput(); controls[method]();
      assert.equal(pending.calls.length, 0, `${from} → ${value}`);
      assert.equal(p.run('hint'), 'Choose a different destination.');
      assert.match(p.run('vSearch()'), /id="toError" role="status">Choose a different destination\./);
      assert.deepEqual(p.json('[calOpen,sugOpen]'), [false, false]);
    }
  }
});

test('JL, CX and QF use airline names in cards, filters and detail with or without metadata', async () => {
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21');
  for (const [code, name] of [['JL', 'Japan Airlines'], ['CX', 'Cathay Pacific'], ['QF', 'Qantas']]) {
    for (const withMetadata of [true, false]) {
      const one = structuredClone(data), fare = one.results[0];
      one.results = [fare]; fare.flightNumbers = [code + '123']; fare.airlines = code;
      if (!withMetadata) delete one.meta.carriers;
      const p = page(); query(p); p.put('data', one); p.run('response=data');
      assert(p.run('card(data.results[0],0)').includes(`<div class="air">${name}`));
      assert(p.run('filtersHTML()').includes(`<b>${name}</b>`));
      assert(p.run('vFare(data.results[0].id)').includes(`<div class="who">${name} · Economy`));
    }
  }
});

test('the results title closes the span after at and contains no broken markup', async () => {
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21');
  const p = page(); query(p); p.put('data', data); p.run('response=data');
  const title = p.run('vResults()').match(/<h1>([\s\S]*?)<\/h1>/)[1];
  assert.match(title, /<span class="soft">earns ~[\d,]+&nbsp;TP at<\/span> £[\d.]+ <span class="soft">each<\/span>/);
  assert.equal((title.match(/<span\b/g) || []).length, (title.match(/<\/span>/g) || []).length);
  assert.doesNotMatch(title, /at\/span>|undefined|NaN/);
});


test('live Gold ignores the exact prototype sample and migrates other legacy balances only once', () => {
  const sample = {tp:12480,target:20000,ends:'2027-03-31'};
  const p = page({saved:JSON.stringify(sample)});
  assert.equal(p.run('gold.tp'),0);
  assert.equal(p.storage.has('flights.gold.live.v1'),false);
  for (const value of [{...sample,tp:12481},{...sample,target:21000},{...sample,ends:'2028-03-31'},{...sample,extra:true}]) {
    const migrated=page({saved:JSON.stringify(value)});
    assert.equal(migrated.run('gold.tp'),value.tp);
    assert.deepEqual(JSON.parse(migrated.storage.get('flights.gold.live.v1')),value);
  }
  assert.equal(page({saved:JSON.stringify(sample),liveSaved:JSON.stringify({...sample,tp:42})}).run('gold.tp'),42);
  assert.equal(page({liveSaved:JSON.stringify(sample)}).run('gold.tp'),12480,'an explicitly saved live balance is preserved');
  const prototype=fs.readFileSync(path.join(__dirname,'../../prototypes/flights/proto-v3.html'),'utf8');
  assert.equal(prototype,fs.readFileSync(path.join(__dirname,'../../prototypes/flights/index.html'),'utf8'));
  assert.doesNotMatch(prototype,/flights.gold.v2|flights.gold.live.v1/);
  assert.equal((prototype.match(/flights.proto.gold/g)||[]).length,4);
});

test('empty searches stand alone and All airlines retries the same route without oneworld', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);
  p.run("response={action:'search',results:[],meta:{}}");
  const html=p.run('vResults()');
  assert.match(html,/No earning fares/);assert.match(html,/Other dates/);assert.match(html,/Anywhere from London/);
  assert.match(html,/id="allAirlines"/);
  assert.doesNotMatch(html,/id="fcol"|class="tabs"|class="rbar"|id="fopen"|Reset filters/);
  p.elements['#allAirlines']={};p.run('bind()');
  const completion=p.elements['#allAirlines'].onclick();
  assert.equal(pending.calls.length,1);
  const params=new URL(pending.calls[0].url,'https://sam.toys').searchParams;
  assert.equal(params.get('earningOnly'),'false');assert.equal(params.get('destination'),'MAD');
  assert.equal(params.get('origin'),'LON');
  pending.calls[0].resolve(ok([]));await completion;
  assert.doesNotMatch(p.run('vResults()'),/id="allAirlines"|id="fcol"/);
});

test('results distinguish filters hiding all fares and keep filter labels concise on refresh', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  const p=page();query(p);p.put('data',data);p.run('response=data');
  assert.match(p.run('vResults()'),/id="fopen"[^>]*>Filters<\/button>/);
  for(const id of ['#cards','#rcount','#fopen','#fshow'])p.elements[id]={};
  p.run('refreshResults()');assert.equal(p.elements['#fopen'].textContent,'Filters');
  p.run('F.dep=[0,1];refreshResults()');assert.equal(p.elements['#fopen'].textContent,'Filters · 1');
  const html=p.run('vResults()');assert.match(html,/id="fcol"/);assert.match(html,/Reset filters/);
  assert.doesNotMatch(html,/No earning fares/);
  p.run('resetFilters();refreshResults()');assert.equal(p.elements['#fopen'].textContent,'Filters');
  const filters=p.run('filtersHTML()');
  assert.match(filters,/id="freset">Reset<\/button><button[^>]*id="fclose"[^>]*aria-label="Close filters"><span aria-hidden="true">×<\/span><\/button>/);
  assert.doesNotMatch(filters,/>Close<\//);
});

test('flight numbers have a carrier space on cards, headings and every fare leg; Select has no arrow', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21');
  const p=page();query(p,{back:'2026-11-21'});p.put('data',data);p.run('response=data');
  assert.equal(p.run("flightNumber('BA460')"),'BA 460');assert.equal(p.run("flightNumber('IB718')"),'IB 718');
  assert.equal(p.run("flightNumber('U2123')"),'U2 123');assert.equal(p.run("flightNumber('BA 460')"),'BA 460');
  const card=p.run('card(fares()[0],0)');assert.match(card,/IB \d+/);
  assert.match(card,/>Select<\/a>/);assert.doesNotMatch(card,/>Select <span/);
  assert.match(p.run('vResults()'),/<h1>IB \d+/);
  const detail=p.run('vFare(fares()[0].id)');
  assert.match(detail,/class="fn">IB \d+/);assert.doesNotMatch(detail,/class="fn">IB\d+/);
});


test('phone filter sheet closes through Show, icon, Escape and backdrop and restores focus', () => {
  const p=page();let focused=false;
  for(const id of ['#fcol','#fopen','#fshow','#fclose','#earningOnly','#freset'])p.elements[id]={
    click(){this.onclick?.();},setAttribute(){},removeAttribute(){},focus(){if(id==='#fopen')focused=true;}
  };
  p.run('bindResults(false)');
  const isOpen=()=>p.run("document.body.classList.contains('sheet')");
  for(const close of [()=>p.elements['#fshow'].onclick(),()=>p.elements['#fclose'].onclick(),
    ()=>p.events.keydown({key:'Escape'}),()=>p.events.click({target:{closest:()=>null}})]){
    focused=false;p.elements['#fopen'].onclick();assert.equal(isOpen(),true);
    p.events.click({target:{closest:()=>p.elements['#fcol']}});assert.equal(isOpen(),true);
    close();assert.equal(isOpen(),false);assert.equal(focused,true);
  }
});

test('every supported city group appears on both sides and resolves to its city code', () => {
  const { CITY_GROUPS } = require('../../flights/cities');
  const p=page();
  const from=p.run('fromPop()');
  for(const [code,group] of Object.entries(CITY_GROUPS)) {
    assert(from.includes(`data-from="${code}"`),`${code} in From menu`);
    assert(from.includes(`${group.name} <span class="s">(all airports)</span>`),`${code} label`);
    p.put('typed',group.name);
    const suggestions=p.run('sugPop(typed)');
    assert(suggestions.includes(`data-to="${code}"`),`${code} in destination suggestions`);
    for(const value of [group.name,code]) {
      p.put('typed',value);p.run("S.to='';draft=typed;resolveDestination()");
      assert.equal(p.run('S.to'),code,value);
    }
    assert.equal(p.run(`placeName('${code}')`),group.name);
  }
  query(p,{from:'NYC',to:'LON'});
  assert.match(p.run('backPill()'),/New York → London/);
});

test('new searches clear airline, stop and time filters while keeping the oneworld choice', async () => {
  for(const earningOnly of [true,false]) {
    const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p,{earningOnly});
    p.run("F.stops='0';F.dep=[8,11];F.arr=[13,16];F.air=new Set(['EI']);SORT='cheap'");
    const completion=p.run('search()');
    assert.deepEqual(p.json('F'),{stops:'any',dep:[0,24],arr:[0,24],air:null});
    assert.equal(p.run('S.earningOnly'),earningOnly);
    const request=new URL(pending.calls[0].url,'https://sam.toys').searchParams;
    assert.equal(request.get('earningOnly'),String(earningOnly));
    assert.equal(request.get('fareClass'),'economy');
    assert.equal(request.get('limit'),'100');
    p.run("go('#/gold')");pending.calls[0].resolve(ok([]));await completion;
  }
});

test('results heading follows the first visible sorted flight and explicitly names an empty filtered list', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  const other=structuredClone(data.results[0]);
  other.id='fixture-visible-AA';other.flightNumbers=['AA100'];other.priceGbp=300;other.estimate.tierPoints=200;
  for(const leg of other.legs)for(const unit of leg.units)unit.flightNumbers=['AA100'];
  data.results[0].priceGbp=100;data.results[0].estimate.tierPoints=100;
  data.results=[data.results[0],other];
  const p=page();query(p);p.put('data',data);p.run('response=data');
  const first=p.json('visibleFares()[0]');
  p.put('hiddenCarrier',first.flightNumbers[0].slice(0,2));
  p.run('F.air=new Set(fares().map(carrierOf).filter(c=>c!==hiddenCarrier))');
  assert(p.run('visibleFares().length')>0,'fixture has another carrier');
  const next=p.run('flightNumber(flightGroups(visibleFares()[0])[0][0])');
  assert(p.run('resultsTitle()').startsWith(next));
  assert(!p.run('resultsTitle()').startsWith(p.run('flightNumber(data.results.find(f=>carrierOf(f)===hiddenCarrier).flightNumbers[0])')));
  for(const id of ['#cards','#rcount','#fopen','#fshow','#app h1'])p.elements[id]={};
  p.run("F.air=new Set();refreshResults()");
  assert.equal(p.elements['#app h1'].innerHTML,'No flights match these filters');
  assert.match(p.run('vResults()'),/<h1>No flights match these filters<\/h1>/);
  assert.match(p.elements['#cards'].innerHTML,/Reset filters/);
  p.run("resetFilters();SORT='cheap';refreshResults()");
  assert.equal(p.elements['#app h1'].innerHTML,p.run('resultsTitle()'));
  assert(p.run('resultsTitle()').startsWith(p.run('flightNumber(flightGroups(visibleFares()[0])[0][0])')));
});
