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
function page({ saved, liveSaved, earningOnly, origin, sessionSaved, initialHash = '#/search', initialHistoryState = null, reducedMotion = false, finePointer = true, phone = false, storageFailure = false, fetch } = {}) {
  const storage = new Map(saved === undefined ? [] : [['flights.gold.v2', saved]]);
  if (liveSaved !== undefined) storage.set('flights.gold.live.v1', liveSaved);
  if (earningOnly !== undefined) storage.set('flights.earningOnly.v1', earningOnly);
  if (origin !== undefined) storage.set('flights.from.v1', origin);
  const session = new Map(sessionSaved === undefined ? [] : [['flights.results.v1', sessionSaved]]), windowEvents = {}, frames = [], timers = new Map();
  let timerId = 0, time = NOW;
  const historyCalls = [];
  function classList() {
    const values = new Set();
    return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value),
      toggle(value, force) { const on = force === undefined ? !values.has(value) : force; if (on) values.add(value); else values.delete(value); return on; } };
  }
  const elements = Object.fromEntries(['#app', '#ring', '#toast'].map(k => [k, {
    innerHTML: '', textContent: '', classList: classList(), setAttribute() {},
  }]));
  const events = {}, documentHandlers = {};
  const location = { hash: initialHash };
  const lists = {};
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const media = query => ({ matches: query.includes('reduced-motion') ? reducedMotion : query.includes('max-width') ? phone : finePointer, addEventListener() {} });
  const context = vm.createContext({
    matchMedia: media, requestAnimationFrame: callback => { frames.push(callback); return frames.length; }, cancelAnimationFrame() {},
    performance: { now: () => 0 }, ResizeObserver: class { observe() {} disconnect() {} },
    URL, URLSearchParams, AbortController, Date: FixedDate, location,
    history: { state: initialHistoryState, replaceState(state, _title, hash) { historyCalls.push({method:'replace',state,hash}); this.state = state; if (hash) location.hash = hash; }, pushState(state, _title, hash) { historyCalls.push({method:'push',state,hash}); this.state = state; if (hash) location.hash = hash; } },
    document: { title: '', body: { classList: classList() }, querySelector: s => elements[s] || null, querySelectorAll: s => lists[s] || [], addEventListener(name, handler) { (documentHandlers[name] ||= []).push(handler); events[name] = event => { for (const listener of documentHandlers[name]) listener(event); }; } },
    window: { scrollTo() {}, addEventListener(name, callback) { windowEvents[name] = callback; }, matchMedia: media },
    sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, value) => session.set(k, value), removeItem: k => session.delete(k) },
    localStorage: {
      getItem(k) { if (storageFailure) throw new Error('Storage unavailable'); return storage.get(k) ?? null; },
      setItem(k, v) { if (storageFailure) throw new Error('Storage unavailable'); storage.set(k, v); },
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: fetch || (() => { throw new Error('Live network forbidden in flights UI tests'); }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../flights/cities.js'),'utf8'), context, { filename:'flights/cities.js' });
  vm.runInContext(script, context, { filename: 'flights/index.html' });
  return {
    run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    put(name, value) { context[name] = value; },
    elements, lists, storage, session, location, events, windowEvents, historyCalls,
    advanceTime(ms) { time += ms; },
    flushFrames() { for (const callback of frames.splice(0)) callback(); },
    flushTimers(maxDelay = Infinity) { for (const [id, timer] of [...timers]) if (timer.delay <= maxDelay) { timers.delete(id); timer.callback(); } },
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
  return { calls, get searches() { return calls.filter(call => new URL(call.url, 'https://sam.toys').searchParams.get('action') !== 'flex'); }, get flexes() { return calls.filter(call => new URL(call.url, 'https://sam.toys').searchParams.get('action') === 'flex'); }, fetch(url, options) { return new Promise(resolve => calls.push({ url, signal: options?.signal, resolve })); } };
}
const ok = results => ({ ok: true, json: async () => ({ action: 'search', results, meta: {}, expiresAt: NOW + 600000 }) });

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
  assert.equal(params('flex').get('fareClass'), 'first');
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
  assert.match(rows, /Ticketed to BCN · get off at MAD/);
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
  assert.equal(p.location.hash, '#/loading'); assert.equal(pending.searches.length, 1);
  p.run("go('#/gold')"); assert.equal(pending.searches[0].signal.aborted, true);
  pending.searches[0].resolve(ok([])); await completion;
  assert.equal(p.location.hash, '#/gold'); assert.equal(p.run('response'), null);
});

test('a late search reply preserves navigation before the hashchange handler renders', async () => {
  const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p);
  const completion = p.run('search()');
  // Native link navigation changes the hash before its hashchange event runs.
  p.location.hash = '#/search';
  assert.equal(pending.searches[0].signal.aborted, false);
  pending.searches[0].resolve(ok([])); await completion;
  assert.equal(p.location.hash, '#/search'); assert.equal(p.run('response'), null);
});

test('a newer search aborts and supersedes an older result regardless of response order', async () => {
  const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p);
  const first = p.run('search()');
  p.run("S.to='JFK'"); const second = p.run('search()');
  assert.equal(pending.searches[0].signal.aborted, true);
  pending.searches[1].resolve(ok([])); await second;
  assert.equal(p.run('resultQuery.to'), 'JFK'); assert.equal(p.location.hash, '#/results');
  pending.searches[0].resolve(ok([{id:'stale'}])); await first;
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
  assert.equal(pending.searches.length, 1);
  assert.equal(new URL(pending.searches[0].url, 'https://sam.toys').searchParams.get('earningOnly'), 'false');
  pending.searches[0].resolve(ok([])); await completion;
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

test('v4 filters expose stops prices, hour histograms, two handles, and airline choices', async () => {
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
  assert.equal(p.run('calOpen'),false); assert.equal(pending.searches.length,1);
  assert.equal(new URL(pending.searches[0].url,'https://sam.toys').searchParams.get('destination'),'MAD');
  pending.searches[0].resolve(ok([])); await completion;
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
  assert.equal(pending.searches.length,1);
  assert.equal(new URL(pending.searches[0].url,'https://sam.toys').searchParams.get('destination'),'JFK');
  assert.equal(p.run('calOpen'),false);
  p.run("go('#/gold')"); pending.searches[0].resolve(ok([])); await Promise.resolve();
});

test('deselecting every airline shows no fares, while reset restores all carriers', async () => {
  const args = {origin:'LHR',destination:'MAD',departureDate:'2026-11-18'};
  const data = await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&earningOnly=false',searchFixture(args));
  const p = page(); query(p,{earningOnly:false});p.put('data',data);p.run('response=data;F.air=new Set()');
  assert.equal(p.run('fares().filter(f=>passes(f)).length'),0);
  assert.match(p.run('cardsHTML()'),/Reset filters/);assert.doesNotMatch(p.run('cardsHTML()'),/No flights match these filters/);
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
      assert.equal(pending.searches.length, 1, `${method}: ${value}`);
      const params = new URL(pending.searches[0].url, 'https://sam.toys').searchParams;
      assert.equal(params.get('action'), expected === 'ANY' ? 'anywhere' : 'search');
      assert.equal(params.get('destination'), expected === 'ANY' ? null : expected);
      assert.deepEqual(p.json('[calOpen,sugOpen,fromOpen]'), [false, false, false]);
      assert.equal(p.location.hash, '#/loading');
      // Stop rendering into the deliberately minimal DOM when the response arrives.
      p.run("go('#/gold')"); pending.searches[0].resolve(ok([])); await completion;
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
    assert.equal(new URL(pending.searches[0].url, 'https://sam.toys').searchParams.get('destination'), method === 'enter' ? 'NRT' : 'TYO');
    p.run("go('#/gold')"); pending.searches[0].resolve(ok([])); await completion;
  }
});

test('unmatched text is explained next to the destination and never sends an API request', () => {
  for (const method of ['enter', 'submit']) {
    const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { to: '' });
    const controls = searchControls(p, 'zzqq'); controls.input.oninput();
    p.run('calOpen=true'); controls[method]();
    assert.equal(pending.searches.length, 0);
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

test('missing dates keep the always-open calendar and explain the problem for go and Enter', () => {
  for (const method of ['submit', 'enter']) {
    const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { to: '', out: '' });
    const controls = searchControls(p, 'Madrid'); controls.input.oninput(); controls[method]();
    assert.equal(pending.searches.length, 0); assert.equal(p.run('S.to'), 'MAD');
    assert.equal(p.location.hash, '#/search/when');
    assert.deepEqual(p.json('[calOpen,sugOpen]'), [true, false]);
    const html = p.run('vSearch()');
    assert.match(html, /id="cal"/);
    assert.match(html, /id="dateError" role="status">Pick a date\.<\/div>\s*<div class="cal cal2"/);
    assert(html.indexOf('id="dateError"') < html.indexOf('id="cal"'));
  }
});

test('same-city groups reject London and New York destinations before requesting fares', () => {
  for (const [from, value] of [['LON', 'London Heathrow'], ['LON', 'LHR'], ['LHR', 'LGW'], ['NYC', 'JFK'], ['JFK', 'EWR'], ['HND', 'NRT']]) {
    for (const method of ['enter', 'submit']) {
      const pending = deferredFetch(), p = page({ fetch: pending.fetch }); query(p, { from, to: '' });
      const controls = searchControls(p, value); controls.input.oninput(); controls[method]();
      assert.equal(pending.searches.length, 0, `${from} → ${value}`);
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
  assert.doesNotMatch(prototype,/flights.gold.v2|flights.gold.live.v1/);
  assert.equal((prototype.match(/flights.proto.gold/g)||[]).length,4);
});

test('the prototype index equals the newest version listed last in versions.json', () => {
  const prototypeDir=path.join(__dirname,'../../prototypes/flights');
  const { versions }=JSON.parse(fs.readFileSync(path.join(prototypeDir,'versions.json'),'utf8'));
  const latest=versions.at(-1);
  assert.match(latest.file,/^proto-v\d+\.html$/);
  assert.equal(latest.file,`proto-v${latest.n}.html`);
  const prototype=fs.readFileSync(path.join(prototypeDir,latest.file),'utf8');
  assert.equal(prototype,fs.readFileSync(path.join(prototypeDir,'index.html'),'utf8'));
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
  assert.equal(pending.searches.length,1);
  const params=new URL(pending.searches[0].url,'https://sam.toys').searchParams;
  assert.equal(params.get('earningOnly'),'false');assert.equal(params.get('destination'),'MAD');
  assert.equal(params.get('origin'),'LON');
  pending.searches[0].resolve(ok([]));await completion;
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
  for(const code of ['LON','NYC']) assert(from.includes(`${CITY_GROUPS[code].name} <span class="s">all airports</span>`),`${code} in resting From menu`);
  assert(from.includes('data-from="IBZ"'),'Ibiza in resting From menu');
  assert(!from.includes('data-from="PAR"'),'other groups only appear when typed');
  for(const [code,group] of Object.entries(CITY_GROUPS)) {
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
    assert.deepEqual(p.json('F'),{stops:'any',dep:[0,24],arr:[0,24],air:null,skip:'show',star:false});
    assert.equal(p.run('S.earningOnly'),earningOnly);
    const request=new URL(pending.searches[0].url,'https://sam.toys').searchParams;
    assert.equal(request.get('earningOnly'),String(earningOnly));
    assert.equal(request.get('fareClass'),'economy');
    assert.equal(request.get('limit'),'100');
    p.run("go('#/gold')");pending.searches[0].resolve(ok([]));await completion;
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

test('v4 home keeps origin choices below search, Cabin and the compact two-month calendar', () => {
  const p=page();
  const home=p.run('vSearch()');
  assert.match(home,/class="orow" role="group" aria-label="From"/);
  assert.match(home,/id="anyPill"/);assert.match(home,/data-from="LON"/);assert.match(home,/data-from="IBZ"/);
  assert.match(home,/id="fromQ"/);assert.match(home,/class="cabinw"/);
  assert.match(home,/class="goC" id="go" type="submit"/);
  assert.match(home,/form="sf" class="go gobig">Search/);
  assert.equal((home.match(/class="mon"/g)||[]).length,2);
  assert.match(home,/<span class="dow">M<\/span><span class="dow">T<\/span><span class="dow">W<\/span>/);
  assert(home.indexOf('id="go"')<home.indexOf('class="orow"'));
  assert(home.indexOf('class="orow"')<home.indexOf('id="cabin"'));
  assert.match(home,/id="pm" aria-label="Previous month"/);assert.match(home,/id="nm" aria-label="Next month"/);
  p.run("S.to='MAD';S.out='2026-11-29';S.view='2026-11'");
  assert.match(p.run('calHTML2()'),/id="pt"/);assert.match(p.run('calHTML2()'),/id="clr"/);
});

test('calendar range spans months without converting a one-way tap to a return', () => {
  const p=page();p.run("S.view='2026-11';tapDay('2026-11-29')");
  assert.deepEqual(p.json('[S.out,S.back]'),['2026-11-29','']);
  assert.match(p.run('calHTML2()'),/one way/);
  p.run("tapDay('2026-12-03')");
  assert.deepEqual(p.json('[S.out,S.back]'),['2026-11-29','2026-12-03']);
  const calendar=p.run('calHTML2()');
  assert.match(calendar,/data-k="2026-11-29"[^>]*aria-label="[^"]*, outbound" aria-pressed="true"/);
  assert.match(calendar,/data-k="2026-12-03"[^>]*aria-label="[^"]*, return" aria-pressed="true"/);
  assert.match(calendar,/4 nights/);
});

test('origin defaults to London, persists the last selection and tolerates unavailable storage', () => {
  assert.equal(page().run('S.from'),'LON');
  for(const code of ['IBZ','NYC','MAD'])assert.equal(page({origin:code}).run('S.from'),code);
  for(const code of ['','not-city','<script>'])assert.equal(page({origin:code}).run('S.from'),'LON');
  assert.equal(page({origin:'IBZ',storageFailure:true}).run('S.from'),'LON');
  const p=page();p.lists['[data-from]']=[{dataset:{from:'IBZ'}}];
  searchControls(p,'Madrid');p.lists['[data-from]'][0].onclick();
  assert.equal(p.run('S.from'),'IBZ');assert.equal(p.storage.get('flights.from.v1'),'IBZ');
});

test('visible Go dispatches the search directly without requiring a second tap', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);
  p.elements['#go']={};searchControls(p,'Madrid');
  let prevented=false;const completion=p.elements['#go'].onclick({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(pending.searches.length,1);assert.equal(p.location.hash,'#/loading');
  p.run("go('#/gold')");pending.searches[0].resolve(ok([]));await completion;
});

test('Starlink card threshold is 50%, likely filter is 80%, and unknown predictions are excluded', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  const p=page();query(p);p.put('data',data);p.run('response=data');
  const base=data.results[0];
  for(const [probability,shown,likely] of [[null,false,false],[0.499,false,false],[0.5,true,false],[0.799,true,false],[0.8,true,true],[0.92,true,true]]){
    const fare=structuredClone(base);fare.starlink={p:probability,basis:'fleet <plan>',note:'Tail & aircraft can change'};
    p.put('fare',fare);p.run('F.star=true');
    assert.equal(p.run('passes(fare)'),likely,String(probability));
    const card=p.run('card(fare,0)');assert.equal(card.includes('Starlink '),shown,String(probability));
    if(shown)assert(card.includes('Starlink '+Math.round(probability*100)+'%'));
    p.run('response.results=[fare]');
    const detail=p.run('vFare(fare.id)');
    if(probability===null){assert.doesNotMatch(detail,/class="slf"|Starlink/);continue;}
    assert.match(detail,/class="slf"/);
    assert.match(detail,/based on fleet &lt;plan&gt;/);assert.match(detail,/Tail &amp; aircraft can change/);
  }
});

test('Show, Hide and Only skip-last-leg filters work locally alongside Starlink', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  const p=page();query(p);p.put('data',data);p.run('response=data');
  const all=p.run('visibleFares().length');assert(p.run('fares().some(f=>f.hiddenCity)'));
  p.run("F.skip='hide'");assert(p.run('visibleFares().every(f=>!f.hiddenCity)'));
  p.run("F.skip='only'");assert(p.run('visibleFares().every(f=>f.hiddenCity)'));assert(p.run('visibleFares().length')>0);
  const card=p.run('card(visibleFares()[0],0)');assert.match(card,/Skip last leg/);assert.match(card,/class="skipx" aria-label="Skipped leg to /);
  p.run("F.skip='show'");assert.equal(p.run('visibleFares().length'),all);
  const filters=p.run('filtersHTML()');assert.match(filters,/class="seg3" role="radiogroup"/);
  assert.equal((filters.match(/name="skip"/g)||[]).length,3);
  p.run('F.star=true');assert.equal(p.run('visibleFares().length'),0);
});

function glideElement({left=0,width=80,tagName='BUTTON',keyboard=false}={}){
  const listeners={}, classes=new Set(), children=[];
  return {listeners,children,style:{},dataset:{},isConnected:true,tagName,scrollLeft:0,scrollTop:0,offsetWidth:width,
    classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle(k,on){if(on)classes.add(k);else classes.delete(k);}},
    getBoundingClientRect:()=>({left,top:0,width,height:30}),
    addEventListener:(name,callback)=>{listeners[name]=callback;},
    getAttribute(){},setAttribute(){},matches:selector=>selector===':focus-visible'&&keyboard,contains:()=>false,
    querySelector:selector=>selector===':scope>.glide'?children[0]||null:null,
    prepend:child=>children.unshift(child),
  };
}

test('origin, sort and skip highlights move only transform and width, respecting pointer and reduced motion', () => {
  for(const reducedMotion of [false,true])for(const finePointer of [false,true])for(const group of ['origin','sort','seg0']){
    const p=page({reducedMotion,finePointer}),box=glideElement(),items=[glideElement(),glideElement({left:90,width:95})];
    const highlight=glideElement({tagName:'SPAN'});box.children.push(highlight);
    p.put('box',box);p.put('items',items);p.run(`let chosen=0;glide('${group}',box,items,el=>el===items[chosen])`);
    assert.equal(highlight.style.transform,'translate(0px,0px)');assert.equal(highlight.style.transition,'none');
    assert.equal(typeof items[1].listeners.pointerenter==='function',finePointer);
    p.run('chosen=1');items[1].listeners.click({detail:1});p.flushFrames();
    assert.equal(highlight.style.transform,'translate(90px,0px)');assert.equal(highlight.style.width,'95px');
    assert.equal(highlight.style.transition,reducedMotion?'none':'');
    assert.equal(highlight.style.left,undefined);assert.equal(highlight.style.top,undefined);
  }
});

test('keyboard focus and activation keep shared highlights instant', () => {
  const p=page(),box=glideElement(),highlight=glideElement({tagName:'SPAN'}),items=[glideElement(),glideElement({left:90,keyboard:true})];box.children.push(highlight);
  p.put('box',box);p.put('items',items);p.run("let chosen=0;glide('keyboard',box,items,el=>el===items[chosen])");
  p.events.keydown({key:'Tab'});items[1].listeners.focusin();assert.equal(highlight.style.transition,'none');
  p.run('chosen=1');items[1].listeners.click({detail:0});p.flushFrames();
  assert.equal(highlight.style.transition,'none');assert.equal(highlight.style.transform,'translate(90px,0px)');
});

test('nearby date strip requests the searched cabin and displays only its seven dates', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p,{cabin:'Business',back:'2026-11-21'});
  p.run("response={action:'search',results:[],meta:{}}");
  const completion=p.run('loadStrip()');
  assert.equal(pending.flexes.length,1);
  const params=new URL(pending.flexes[0].url,'https://sam.toys').searchParams;
  assert.equal(params.get('fareClass'),'business');assert.equal(params.get('departureDate'),'2026-11-18');
  assert.equal(params.get('returnDate'),'2026-11-21');
  pending.flexes[0].resolve({ok:true,json:async()=>({results:[{departureDate:'2026-11-15',priceGbp:210},{departureDate:'2026-11-21',priceGbp:180},{departureDate:'2026-11-22',priceGbp:1}]})});await completion;
  assert.deepEqual(p.json('stripDays()'),['2026-11-15','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-21']);
  const strip=p.run('dateStrip()');assert.match(strip,/£210/);assert.match(strip,/£180/);
  assert.doesNotMatch(strip,/data-day="2026-11-22"/);assert.match(strip,/aria-current="date"/);
});

test('skip and Starlink controls filter loaded rows without another provider request', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  data.results.forEach((fare,i)=>{fare.starlink={p:i%2?0.92:0.6};});
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);p.put('data',data);p.run('response=data');
  for(const id of ['#cards','#rcount','#fopen','#fshow','#fclose','#freset','#earningOnly','#fcol','#starlinkOnly'])p.elements[id]={textContent:'',innerHTML:'',setAttribute(){},removeAttribute(){}};
  const choices=p.lists['input[name=skip]']=['show','hide','only'].map(value=>({value}));
  p.run('bindResults(false)');
  assert.equal(typeof p.elements['#starlinkOnly'].onchange,'function');
  p.elements['#starlinkOnly'].onchange({target:{checked:true}});
  assert.equal(p.run('F.star'),true);assert(p.run('visibleFares().every(f=>f.starlink.p>=0.8)'));
  assert.equal(typeof choices[2].onchange,'function');choices[2].onchange();
  assert.equal(p.run('F.skip'),'only');assert(p.run('visibleFares().every(f=>f.hiddenCity)'));
  assert.equal(pending.calls.length,0);
});

test('calendar Clear resets both dates and the price toggle requests route discovery', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p,{back:'2026-11-21'});
  p.elements['#cal']={querySelectorAll:()=>[],querySelector:()=>({}),classList:{add(){}}};
  for(const id of ['#pm','#nm','#pt','#clr'])p.elements[id]={};
  p.run('bindCal()');p.elements['#clr'].onclick();assert.deepEqual(p.json('[S.out,S.back]'),['','']);
  p.run("S.out='2026-11-18';S.view='2026-11';bindCal()");
  p.elements['#pt'].onclick();assert.equal(p.run('S.prices'),true);assert.equal(pending.flexes.length,1);
  const params=new URL(pending.flexes[0].url,'https://sam.toys').searchParams;
  assert.equal(params.get('destination'),'MAD');assert.equal(params.get('fareClass'),'economy');
  p.run("go('#/gold')");pending.flexes[0].resolve({ok:true,json:async()=>({results:[]})});await Promise.resolve();
});

test('search paints its skeleton shell immediately and warms cabin-specific flex alongside fares', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p,{cabin:'First'});
  const completion=p.run('search()');
  assert.equal(p.location.hash,'#/loading');assert.equal(pending.searches.length,1);assert.equal(pending.flexes.length,1);
  const html=p.elements['#app'].innerHTML;assert.match(html,/aria-busy="true"/);assert.match(html,/class="fc glass skcard"/);assert.match(html,/<p[^>]*role="status"><span class="spin"><\/span>Searching Skiplagged<\/p>/);assert.doesNotMatch(html,/<h1|class="rbar"|class="tabs sktabs"|verify fare/);
  assert.equal(new URL(pending.flexes[0].url,'https://sam.toys').searchParams.get('fareClass'),'first');
  pending.searches[0].resolve(ok([]));await completion;assert.equal(p.location.hash,'#/results');
  pending.flexes[0].resolve({ok:true,json:async()=>({results:[]})});await Promise.resolve();
});

test('pointerdown prefetch and direct Go share one fare and flex request', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);p.elements['#go']={};searchControls(p,'Madrid');
  p.elements['#go'].onpointerdown({button:0});assert.equal(pending.searches.length,1);assert.equal(pending.flexes.length,1);
  const completion=p.elements['#go'].onclick({preventDefault(){}});
  assert.equal(pending.searches.length,1);assert.equal(pending.flexes.length,1);assert.equal(p.location.hash,'#/loading');
  pending.searches[0].resolve(ok([]));pending.flexes[0].resolve({ok:true,json:async()=>({results:[]})});await completion;
});

test('typed suggestions redraw synchronously for every input before date or origin actions', () => {
  const p=page();query(p);const controls=searchControls(p,'M');let updates=0,lastPop='';
  controls.input.parentNode.insertAdjacentHTML=(_position,html)=>{updates++;lastPop=html;};
  controls.input.oninput();controls.input.value='Madrid';controls.input.oninput();
  assert.equal(p.run('draft'),'Madrid');assert.equal(p.run('S.to'),'');assert.equal(updates,2);
  assert.match(lastPop,/data-to="MAD"/);assert.doesNotMatch(lastPop,/data-to="DOH"/);
  p.flushTimers();assert.equal(updates,2);
});

test('session results restore query history immediately without a fare request and expire after ten minutes', async () => {
  const p=page();query(p);p.run("saveResults(S,{action:'search',results:[],meta:{},expiresAt:Date.now()+600000})");
  const saved=p.session.get('flights.results.v1');assert(saved);
  const pending=deferredFetch(),restored=page({sessionSaved:saved,fetch:pending.fetch});query(restored);
  await restored.run('search()');assert.equal(restored.location.hash,'#/results');assert.equal(pending.searches.length,0);
  restored.run("response=null;resultQuery=null;history.state={flightsQuery:{...S}};location.hash='#/results';render()");
  assert.equal(restored.run('response.action'),'search');assert.equal(restored.run('resultQuery.to'),'MAD');assert.equal(pending.searches.length,0);
  restored.run('sessionResults.get(cacheKey(S)).until=Date.now()-1');assert.equal(restored.run('readResults(S)'),null);
  if(pending.flexes[0])pending.flexes[0].resolve({ok:true,json:async()=>({results:[]})});
});

test('query cache bounds tab storage, excludes partial replies and isolates dates, cabin and oneworld', () => {
  const p=page();query(p);p.run("saveResults(S,{action:'search',results:[],meta:{},expiresAt:Date.now()+600000})");
  for(const change of ["S.cabin='Business'","S.out='2026-11-19'","S.back='2026-11-21'","S.earningOnly=false"]){query(p);p.run(change);assert.equal(p.run('readResults(S)'),null);}
  p.run("sessionResults.clear();saveResults(S,{action:'search',results:[],partial:true})");assert.equal(p.run('sessionResults.size'),0);
  p.run("for(let i=0;i<8;i++)saveResults({...S,out:'2026-11-'+String(10+i)},{action:'search',results:[],meta:{},expiresAt:Date.now()+600000})");
  assert.equal(p.run('sessionResults.size'),6);assert.equal(JSON.parse(p.session.get('flights.results.v1')).length,6);
  assert.equal(page({sessionSaved:'{'}).run('readResults(S)'),null);
});

test('result entry staggers at most eight cards and reorder animation uses transform only', () => {
  const p=page(),animations=[];
  const cards=Array.from({length:10},(_,i)=>({dataset:{fareId:'fare'+i},getBoundingClientRect:()=>({left:0,top:i*100}),animate:(frames,options)=>animations.push({frames,options})}));
  p.lists['#cards .fc']=cards;p.run('animateCards()');
  assert.equal(animations.length,8);assert(animations.every(a=>a.options.duration<=220));
  assert(animations.every((a,i)=>i===0||a.options.delay-animations[i-1].options.delay<=30));
  animations.length=0;p.run("animateCards(new Map(Array.from({length:10},(_,i)=>['fare'+i,{left:0,top:1000-i*100}])))");
  assert(animations.length>0);assert(animations.every(a=>a.frames.every(frame=>Object.keys(frame).every(key=>key==='transform'))));
});

test('page, calendar and card animations are short and disabled for reduced motion or keyboard input', () => {
  for(const reducedMotion of [false,true])for(const keyboard of [false,true]){
    const p=page({reducedMotion}),animations=[],animated={getBoundingClientRect:()=>({top:0,left:0}),animate:(frames,options)=>animations.push({frames,options})};
    p.elements['#app>.fade']=animated;p.elements['#cal .months']=animated;p.lists['#cards .fc']=[{...animated,dataset:{fareId:'one'}}];
    p.elements['#cal']={querySelectorAll:()=>[]};for(const id of ['#pm','#nm'])p.elements[id]={};
    if(keyboard)p.events.keydown({key:'Enter'});else p.events.pointerdown({clientX:10,clientY:40});
    p.run("animatePage();animateCards();S.view='2026-11';bindCal()");p.elements['#nm'].onclick();
    if(reducedMotion||keyboard)assert.equal(animations.length,0);
    else{assert.equal(animations.length,3);assert(animations.every(a=>a.options.duration<=300));assert(animations[2].frames[0].transform.includes('translateX('));}
  }
});

test('same-hash Back and Forward restore distinct cached query rows through popstate without fetching', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  const pending=deferredFetch(),p=page({fetch:pending.fetch});
  const queries=[{from:'LON',to:'MAD',out:'2026-11-18'},{from:'IBZ',to:'JFK',out:'2026-11-20'}],states=[];
  for(const [i,q] of queries.entries()){
    query(p,q);const completion=p.run('search()');
    const fare={...structuredClone(data.results[0]),id:'history-query-'+i};
    pending.searches[i].resolve(ok([fare]));pending.flexes[i].resolve({ok:true,json:async()=>({results:[]})});await completion;
    assert.equal(p.location.hash,'#/results');states.push(p.json('history.state'));
  }
  assert.equal(typeof p.windowEvents.popstate,'function','same-hash navigation needs its own listener');
  const requests=pending.calls.length;
  for(const index of [0,1]){
    p.put('historyState',states[index]);p.run('history.state=historyState');
    // Browser traversal updates history.state but does not dispatch hashchange
    // when both history entries have the identical #/results URL.
    p.windowEvents.popstate({state:states[index]});
    assert.equal(p.location.hash,'#/results');
    assert.deepEqual(p.json('[resultQuery.from,resultQuery.to,resultQuery.out]'),[queries[index].from,queries[index].to,queries[index].out]);
    assert.deepEqual(p.json('[S.from,S.to,S.out]'),[queries[index].from,queries[index].to,queries[index].out]);
    assert.equal(p.run('response.results[0].id'),'history-query-'+index);
    assert(p.elements['#app'].innerHTML.includes('#/fare/history-query-'+index));
    assert.equal(pending.calls.length,requests,'history restoration must not start another fetch');
  }
  query(p,{from:'LON',to:'DOH',out:'2026-11-23'});const late=p.run('search()');
  const lateRequest=pending.searches.at(-1),countBeforeBack=pending.calls.length;
  p.put('historyState',states[0]);p.run("history.state=historyState;location.hash='#/results'");
  p.windowEvents.popstate({state:states[0]});
  assert.equal(lateRequest.signal.aborted,true,'restoring cached history cancels the active fare request');
  assert.equal(pending.calls.length,countBeforeBack);
  lateRequest.resolve(ok([{...structuredClone(data.results[0]),id:'late-query'}]));
  pending.flexes.at(-1).resolve({ok:true,json:async()=>({results:[]})});await late;
  assert.equal(p.run('response.results[0].id'),'history-query-0');assert.equal(p.run('resultQuery.to'),'MAD');
});

test('sort and skip handlers animate the shared highlight during refresh rather than snapping before click RAF', () => {
  for(const reducedMotion of [false,true])for(const keyboard of [false,true]){
    const p=page({reducedMotion});query(p);p.run("response={action:'search',results:[],meta:{}}");
    for(const id of ['#cards','#rcount','#fopen','#fshow','#fclose','#freset','#earningOnly','#fcol'])p.elements[id]={innerHTML:'',textContent:'',setAttribute(){},removeAttribute(){}};
    const tabs=glideElement(),sortHighlight=glideElement({tagName:'SPAN'}),buttons=['value','cheap'].map((value,index)=>{
      const button=glideElement({left:index*90});button.dataset.sort=value;
      const attrs={'aria-selected':String(index===0)};
      button.getAttribute=name=>attrs[name];button.setAttribute=(name,value)=>{attrs[name]=String(value);};return button;
    });
    tabs.children.push(sortHighlight);tabs.querySelectorAll=()=>buttons;p.elements['.tabs']=tabs;p.lists['[data-sort]']=buttons;
    const segment=glideElement(),skipHighlight=glideElement({tagName:'SPAN'}),radios=['show','hide','only'].map((value,index)=>({value,checked:index===0}));
    const labels=radios.map((radio,index)=>{const label=glideElement({left:index*60,width:55,tagName:'LABEL'});label.querySelector=selector=>selector==='input:checked'&&radio.checked?radio:null;return label;});
    segment.children.push(skipHighlight);segment.querySelectorAll=()=>labels;p.lists['.seg3']=[segment];p.lists['input[name=skip]']=radios;
    p.run('bindResults(false);applyGlides()');
    assert.equal(sortHighlight.style.transform,'translate(0px,0px)');assert.equal(skipHighlight.style.transform,'translate(0px,0px)');
    if(keyboard)p.events.keydown({key:'Enter'});else p.events.pointerdown({clientX:100,clientY:20});
    buttons[1].onclick();
    // No synthetic click listener or RAF has run: refreshResults itself must
    // preserve the transition while applyGlides observes the new selection.
    assert.equal(p.run('SORT'),'cheap');assert.equal(sortHighlight.style.transform,'translate(90px,0px)');
    assert.equal(sortHighlight.style.transition,reducedMotion||keyboard?'none':'');
    radios.forEach((radio,index)=>{radio.checked=index===2;});radios[2].onchange();
    assert.equal(p.run('F.skip'),'only');assert.equal(skipHighlight.style.transform,'translate(120px,0px)');
    assert.equal(skipHighlight.style.transition,reducedMotion||keyboard?'none':'');
  }
});

test('native fare navigation stamps query history so reloading restores the fare from session storage', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  data.results=[data.results[0]];data.results[0].id='native-fare-history';
  const p=page();query(p,{from:'IBZ',to:'MAD',out:'2026-11-18'});p.put('data',data);
  p.run("response=data;saveResults(S,data);history.state=null;location.hash='#/fare/native-fare-history'");
  p.windowEvents.hashchange();
  const historyState=p.json('history.state');
  assert.equal(historyState.flightsQuery.from,'IBZ');assert.equal(historyState.flightsQuery.out,'2026-11-18');
  const pending=deferredFetch(),reloaded=page({fetch:pending.fetch,sessionSaved:p.session.get('flights.results.v1'),initialHash:p.location.hash,initialHistoryState:historyState});
  assert.equal(reloaded.location.hash,'#/fare/native-fare-history');assert.equal(reloaded.run('response.results[0].id'),'native-fare-history');
  assert.deepEqual(reloaded.json('[resultQuery.from,resultQuery.to,resultQuery.out]'),['IBZ','MAD','2026-11-18']);
  assert.match(reloaded.elements['#app'].innerHTML,/id="book"/);assert.equal(pending.calls.length,0);
});

test('Back to an uncached partial or expired query refetches its own rows without pushing history or showing newer rows', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  for(const missing of ['partial','expired']){
    const pending=deferredFetch(),p=page({fetch:pending.fetch});
    query(p,{from:'IBZ',to:'MAD',out:'2026-11-18'});const oldSearch=p.run('search()');
    pending.searches[0].resolve({ok:true,json:async()=>({action:'search',results:[{...structuredClone(data.results[0]),id:'old-'+missing}],meta:{},expiresAt:NOW+600000,...(missing==='partial'?{partial:true}:{})})});
    pending.flexes[0].resolve({ok:true,json:async()=>({results:[]})});await oldSearch;
    const oldHistory=p.json('history.state');
    if(missing==='expired')p.run('sessionResults.get(cacheKey(S)).until=Date.now()-1');
    query(p,{from:'LON',to:'JFK',out:'2026-11-20'});const newerSearch=p.run('search()');
    pending.searches[1].resolve(ok([{...structuredClone(data.results[0]),id:'newer-'+missing}]));
    pending.flexes[1].resolve({ok:true,json:async()=>({results:[]})});await newerSearch;
    const pushes=p.historyCalls.filter(call=>call.method==='push').length;
    p.put('oldHistory',oldHistory);p.run('history.state=oldHistory');p.windowEvents.popstate({state:oldHistory});
    assert.equal(p.location.hash,'#/loading',missing);assert.equal(p.run('response'),null,missing);
    assert.deepEqual(p.json('[S.from,S.to,S.out,resultQuery.from,resultQuery.to,resultQuery.out]'),['IBZ','MAD','2026-11-18','IBZ','MAD','2026-11-18']);
    assert.match(p.elements['#app'].innerHTML,/Ibiza → Madrid/);assert.match(p.elements['#app'].innerHTML,/class="fc glass skcard"/);
    assert(!p.elements['#app'].innerHTML.includes('#/fare/newer-'+missing));
    assert.equal(pending.searches.length,3,missing);
    const request=new URL(pending.searches[2].url,'https://sam.toys').searchParams;
    assert.equal(request.get('origin'),'IBZ');assert.equal(request.get('destination'),'MAD');assert.equal(request.get('departureDate'),'2026-11-18');
    assert.equal(p.historyCalls.filter(call=>call.method==='push').length,pushes,'restoration replaces the traversed entry');
    const completion=p.run('prepared.promise');pending.searches[2].resolve(ok([{...structuredClone(data.results[0]),id:'refetched-'+missing}]));await completion;
    assert.equal(p.location.hash,'#/results');assert.equal(p.run('response.results[0].id'),'refetched-'+missing);
    assert.equal(p.run('resultQuery.from'),'IBZ');assert.equal(p.run('resultQuery.out'),'2026-11-18');
    assert.equal(p.historyCalls.filter(call=>call.method==='push').length,pushes);
  }
});

test('Starlink filter chrome requires qualifying fares and detail requires a numeric prediction including zero', async () => {
  const data=await backend('/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18',searchFixture({origin:'LHR',destination:'MAD',departureDate:'2026-11-18'}));
  const p=page();query(p);const fare=data.results[0];p.put('fare',fare);
  for(const prediction of [undefined,{}, {p:null}, {p:0}, {p:0.799}, {p:0.8}]){
    fare.starlink=prediction;p.put('data',{...data,results:[fare]});p.run('response=data');
    assert.equal(p.run('filtersHTML()').includes('id="starlinkOnly"'),prediction?.p>=0.8);
    assert.equal(p.run('vFare(fare.id)').includes('class="slf"'),typeof prediction?.p==='number');
  }
});

test('nearby prices mark only tied cheapest days when at least one price is higher', () => {
  const p=page();query(p);p.run('response={action:"search",results:[]};stripDays()');
  for(const [prices,cheapest] of [[[100,100,100],[]],[[100],[]],[[100,120,100],[15,17]],[[],[]]]){
    p.put('rows',prices.map((priceGbp,i)=>({departureDate:'2026-11-'+(15+i),priceGbp})));p.run('strip.rows=rows');
    const html=p.run('dateStrip()');const marked=[...html.matchAll(/class="dday[^\"]* low" data-day="2026-11-(\d+)"/g)].map(m=>Number(m[1]));
    assert.deepEqual(marked,cheapest);assert.equal((html.match(/cheapest nearby/g)||[]).length,cheapest.length);
  }
});

test('partial warnings use the failed airport even when the search and metadata name its city', () => {
  const p=page();query(p,{from:'LON'});
  p.run("response={partial:true,failures:[{origin:'LGW'},{origin:'LGW'}],meta:{airports:{LGW:'London'}}}");
  assert.match(p.run('partialNote()'),/LGW didn't answer/);assert.doesNotMatch(p.run('partialNote()'),/LON|London/);
  p.run("response.failures=[{origin:'LON'}]");assert.match(p.run('partialNote()'),/London didn't answer/);
});

test('calendar flex completion updates prices and accessible labels without replacing day nodes or handlers', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);
  p.run("S.prices=true;S.view='2026-11';location.hash='#/search/when'");p.elements['#sf']={};
  const price={textContent:'—'},attributes=new Map(),classes=new Set(),click=()=>{};
  const day={dataset:{k:'2026-11-18'},disabled:false,onclick:click,querySelector:()=>price,setAttribute:(k,v)=>attributes.set(k,v),classList:{toggle:(k,on)=>on?classes.add(k):classes.delete(k)}};
  p.lists['#cal [data-k]']=[day];const note=p.elements['#cal .calnote']={textContent:''};
  const before=p.elements['#app'].innerHTML,completion=p.run('loadFlex()');
  assert.equal(note.textContent,'Loading dates…');assert.equal(p.elements['#app'].innerHTML,before);
  pending.flexes[0].resolve({ok:true,json:async()=>({results:[{departureDate:'2026-11-18',priceGbp:99}]})});await completion;
  assert.equal(p.lists['#cal [data-k]'][0],day);assert.equal(day.onclick,click);assert.equal(price.textContent,'£99');
  assert.match(attributes.get('aria-label'),/outbound, £99 discovery price/);assert(classes.has('pr'));
  assert.match(note.textContent,/£ discovery prices/);assert.equal(p.elements['#app'].innerHTML,before);
});

test('partial day strips preserve rows across navigation and retries, with query-specific cooldowns', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);p.run('response={action:"search",results:[]}');
  const first=p.run('loadStrip()');pending.flexes[0].resolve({ok:true,headers:{get:()=> '90'},json:async()=>({partial:true,results:[{departureDate:'2026-11-17',priceGbp:88}]})});await first;
  assert.equal(p.run('strip.state'),'partial');assert.equal(p.run('stripRequests.size'),0);assert.equal(p.session.size,0);
  p.run("go('#/gold');go('#/results')");await p.run('loadStrip()');assert.equal(pending.flexes.length,1);assert.equal(p.run("stripPrice('2026-11-17')"),88);
  const other=p.run("warmStrip({...S,cabin:'Business'})");assert.equal(pending.flexes.length,2);
  pending.flexes[1].resolve({ok:true,json:async()=>({results:[],expiresAt:NOW+600000})});await other;
  p.advanceTime(89999);await p.run('loadStrip()');assert.equal(pending.flexes.length,2);
  p.advanceTime(1);const retry=p.run('loadStrip()');assert.equal(pending.flexes.length,3);assert.equal(p.run("stripPrice('2026-11-17')"),88);
  pending.flexes[2].resolve({ok:false,status:429,headers:{get:()=> '120'}});await retry;
  assert.equal(p.run("stripPrice('2026-11-17')"),88);await p.run('loadStrip()');assert.equal(pending.flexes.length,3);
  p.advanceTime(120000);const partialRetry=p.run('loadStrip()');
  pending.flexes[3].resolve({ok:true,json:async()=>({partial:true,results:[{departureDate:'2026-11-19',priceGbp:77}]})});await partialRetry;
  assert.equal(p.run("stripPrice('2026-11-17')"),88);assert.equal(p.run("stripPrice('2026-11-19')"),77);
  p.advanceTime(60000);const complete=p.run('loadStrip()');
  pending.flexes[4].resolve({ok:true,json:async()=>({results:[],expiresAt:NOW+600000})});await complete;
  assert.deepEqual(p.json('strip.rows'),[]);assert.equal(p.run('stripRetries.size'),0);
});

test('day strip errors honor numeric and HTTP-date Retry-After without capping the server delay', async () => {
  for(const delay of ['7200',new Date(NOW+120000).toUTCString()]){
    const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);
    const first=p.run('loadStrip()');pending.flexes[0].resolve({ok:false,status:429,headers:{get:()=>delay}});await first;
    const ms=delay==='7200'?7200000:120000;assert.equal(p.run('stripRetries.get(cacheKey(S)).retryAt'),NOW+ms);
    p.advanceTime(ms-1);await p.run('loadStrip()');assert.equal(pending.flexes.length,1);
    p.advanceTime(1);const retry=p.run('loadStrip()');assert.equal(pending.flexes.length,2);
    pending.flexes[1].resolve({ok:true,json:async()=>({results:[],expiresAt:NOW+ms+600000})});await retry;
  }
});

test('fare and session caches preserve server absolute expiry after late delivery and repeated saves', () => {
  const p=page();query(p);p.put('data',{action:'search',results:[],expiresAt:NOW+600000});
  p.advanceTime(599000);p.run('saveResults(S,data)');assert.equal(p.run('readResults(S).until'),NOW+600000);
  const sessionSaved=p.session.get('flights.results.v1'),restored=page({sessionSaved});query(restored);restored.advanceTime(599999);
  assert.equal(restored.run('readResults(S).until'),NOW+600000);p.advanceTime(1000);p.run('saveResults(S,data)');
  assert.equal(p.run('readResults(S)'),null);restored.advanceTime(1);assert.equal(restored.run('readResults(S)'),null);
  for(const expiresAt of [undefined,null,'600000',NOW,NOW-1]){const fresh=page();query(fresh);fresh.put('data',{action:'search',results:[],expiresAt});fresh.run('saveResults(S,data)');assert.equal(fresh.run('readResults(S)'),null);}
  const forged=JSON.parse(sessionSaved);forged[0].until+=600000;
  const invalid=page({sessionSaved:JSON.stringify(forged)});query(invalid);assert.equal(invalid.run('readResults(S)'),null);
});

test('day strip success cache expires at the server instant, including late hits', async () => {
  const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p);const first=p.run('warmStrip(S)');
  p.advanceTime(599000);pending.flexes[0].resolve({ok:true,json:async()=>({results:[],expiresAt:NOW+600000})});await first;
  p.advanceTime(999);await p.run('warmStrip(S)');assert.equal(pending.flexes.length,1);
  p.advanceTime(1);const next=p.run('warmStrip(S)');assert.equal(pending.flexes.length,2);
  pending.flexes[1].resolve({ok:true,json:async()=>({results:[],expiresAt:NOW+1200000})});await next;
});

test('nearby day selection preserves same-day and longer returns, and leaves one-way trips one way', async () => {
  for(const back of ['', '2026-11-18','2026-11-21']){
    const pending=deferredFetch(),p=page({fetch:pending.fetch});query(p,{back});p.run('stripDays()');
    const button={dataset:{day:'2026-11-19'}};p.lists['#dstrip [data-day]']=[button];p.run('bindStrip()');button.onclick();
    const expected=back?back==='2026-11-18'?'2026-11-19':'2026-11-22':'';
    assert.equal(p.run('S.back'),expected);assert.equal(new URL(pending.searches[0].url,'https://sam.toys').searchParams.get('returnDate'),expected||null);
    const completion=p.run('prepared.promise');pending.searches[0].resolve(ok([]));pending.flexes[0].resolve({ok:true,json:async()=>({results:[]})});await completion;
  }
});
