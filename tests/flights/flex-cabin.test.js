const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../../api/flights');
const { parseInput, providerPlan } = require('../../api/_lib/flights/input');
const { UpstreamError } = require('../../api/_lib/flights/mcp');
const schemas = require('./fixtures/schemas.json');
const fixture = require('./fixtures/search.json').flights[0];
const NOW = Date.parse('2026-10-28T12:00:00Z');
const URL = '/api/flights?action=flex&origin=LHR&destination=MAD&departureDate=2026-11-18';
global.fetch = () => { throw new Error('Live network forbidden in flights tests'); };

// Synthetic date/cabin price variants, not live quotes.
function candidate(args, price = args.fareClass === 'business' ? 900 : 100) {
  const row = structuredClone(fixture);
  row.id = `${args.origin}-${args.departureDate}-${args.returnDate || ''}-${price}`;
  row.price.amount = price;
  for (const key of ['departure', 'arrival']) row[key].dateTime = row[key].dateTime.replace('2026-11-18', args.departureDate);
  row.deepLink = row.deepLink.replace('2026-11-18', args.departureDate);
  if (args.returnDate) {
    for (const key of ['departure', 'arrival']) row.returnFlight[key].dateTime = row.returnFlight[key].dateTime.replace('2026-11-21', args.returnDate);
    row.deepLink = row.deepLink.replace('2026-11-21', args.returnDate);
  } else {
    delete row.returnFlight;
    row.deepLink = row.deepLink.replace('/2026-11-21', '').replace(',IB725', '');
  }
  return row;
}
function setup(options = {}) {
  const calls = [];
  const handler = createHandler({ now: () => NOW, throttleOptions: { max: 100 },
    callTool: async (name, args) => { calls.push({ name, args }); return { flights: [candidate(args)] }; }, ...options });
  async function call(url = URL) {
    const req = { method: 'GET', url, headers: { host: 'sam.toys', 'x-real-ip': '203.0.113.1' } };
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(text) { this.body = JSON.parse(text); } };
    await handler(req, res);
    return res;
  }
  return { calls, call };
}

test('explicit flex cabin uses only schema-supported search arguments for seven nearby dates', async () => {
  const s = setup(), r = await s.call(URL + '&fareClass=business');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.partial, false);
  assert.equal(r.body.meta.flexSource, 'cabin-search');
  assert.equal(r.body.meta.fareClass, 'business');
  assert.equal(r.body.meta.providerCalls, 7);
  assert.match(r.body.meta.notice, /ticket cabin and earning remain unverified/);
  assert.deepEqual(r.body.results.map(row => row.departureDate), Array.from({ length: 7 }, (_, i) => `2026-11-${15 + i}`));
  assert(r.body.results.every(row => row.priceGbp === 693 && row.fareClass === 'business' && row.cabinFiltered && row.requiresSearch));
  const schema = schemas.find(row => row.name === 'sk_flights_search').inputSchema;
  for (const { name, args } of s.calls) {
    assert.equal(name, 'sk_flights_search');
    assert.equal(args.fareClass, 'business');
    assert.equal(args.limit, 100);
    assert.equal(args.includeVirtualInterlining, false);
    assert(Object.keys(args).every(key => Object.hasOwn(schema.properties, key)));
  }
});

test('cabin alias shares the fareClass cache; different cabins cannot reuse prices', async () => {
  const s = setup();
  const economy = await s.call(URL + '&cabin=economy');
  assert(economy.body.results.every(row => row.priceGbp === 77));
  await s.call(URL + '&fareClass=economy');
  assert.equal(s.calls.length, 7);
  const business = await s.call(URL + '&cabin=business');
  assert(business.body.results.every(row => row.priceGbp === 693));
  assert.equal(s.calls.length, 14);
  for (const suffix of ['&cabin=invalid', '&cabin=', '&cabin=economy&cabin=business', '&cabin=economy&fareClass=economy']) {
    assert.equal((await s.call(URL + suffix)).statusCode, 400);
  }
  assert.equal(s.calls.length, 14);
});

test('cabin departure flex preserves trip length and return flex keeps departure fixed', async () => {
  const s = setup();
  const depart = await s.call(URL + '&fareClass=premium&returnDate=2026-11-21');
  assert.equal(depart.body.results.length, 7);
  assert(s.calls.every(({ args }) => Date.parse(args.returnDate) - Date.parse(args.departureDate) === 3 * 86400000 && args.includeHiddenCity === false));
  const returns = await s.call(URL + '&fareClass=premium&returnDate=2026-11-21&mode=return');
  assert(returns.body.results.every(row => row.departureDate === '2026-11-18'));
  assert.deepEqual(returns.body.results.map(row => row.returnDate), Array.from({ length: 7 }, (_, i) => `2026-11-${18 + i}`));
});

test('cabin flex clamps invalid nearby dates at today, horizon and return-before-departure', () => {
  const plan = (url) => providerPlan(parseInput(url, NOW));
  assert.deepEqual(plan(URL.replace('2026-11-18', '2026-10-28') + '&cabin=first').calls.map(c => c.args.departureDate),
    ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
  assert.equal(plan(URL.replace('2026-11-18', '2027-10-29') + '&cabin=first').calls.length, 4);
  const sameDay = plan(URL + '&cabin=business&returnDate=2026-11-18&mode=return');
  assert.equal(sameDay.calls.length, 4);
  assert(sameDay.calls.every(c => c.args.returnDate >= c.args.departureDate));
});

test('cabin flex takes the lowest normalized candidate and never exposes malformed or non-earning fares', async () => {
  const s = setup({ callTool: async (_name, args) => {
    const invalid = candidate(args, 1); invalid.deepLink = 'https://evil.example';
    const non = candidate(args, 2); non.deepLink = non.deepLink.replace('IB714', 'FR714');
    return { flights: [candidate(args, 200), candidate(args, 100), invalid, non] };
  } });
  const r = await s.call(URL + '&cabin=business&sort=price');
  assert.equal(r.body.results.length, 7);
  assert(r.body.results.every(row => row.priceGbp === 77));
  assert.equal(r.body.excluded['invalid-price-or-link'], 7);
  assert.equal(r.body.excluded['non-earning-or-unknown-flight-number'], 7);
});

test('cabin flex keeps seven-call and three-concurrent caps; omitted origins are explicit and uncached', async () => {
  let calls = 0, active = 0, peak = 0;
  const s = setup({ callTool: async (_name, args) => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return { flights: [candidate(args)] };
  } });
  const url = URL.replace('origin=LHR', 'origin=LHR,LGW') + '&cabin=business';
  const r = await s.call(url);
  assert.equal(calls, 7); assert.equal(peak, 3);
  assert.equal(r.body.partial, true);
  assert.equal(r.body.failures.length, 7);
  assert(r.body.failures.every(row => row.origin === 'LGW' && row.code === 'provider-call-cap' && row.departureDate));
  assert.match(r.headers['cache-control'], /no-store/);
  await s.call(url); assert.equal(calls, 14);
});

test('cabin flex partial failures retain successful dates and retry; empty success stays empty', async () => {
  let calls = 0;
  const s = setup({ callTool: async (_name, args) => {
    calls++;
    if (args.departureDate === '2026-11-17') throw new UpstreamError('upstream-timeout');
    return { flights: args.departureDate === '2026-11-19' ? [] : [candidate(args)] };
  } });
  const r = await s.call(URL + '&cabin=business');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.partial, true);
  assert.equal(r.body.results.length, 5);
  assert.equal(r.body.failures[0].departureDate, '2026-11-17');
  await s.call(URL + '&cabin=business'); assert.equal(calls, 14);
});

test('response cache freshness never outlives the in-memory entry and errors stay no-store', async () => {
  let time = NOW;
  const s = setup({ now: () => time });
  const url = URL + '&cabin=business';
  assert.equal((await s.call(url)).headers['cache-control'], 'private, max-age=600, must-revalidate');
  time += 599000;
  const hit = await s.call(url);
  assert.equal(hit.headers['cache-control'], 'private, max-age=1, must-revalidate');
  assert.equal(hit.headers['vercel-cdn-cache-control'], 'no-store');
  assert.equal(s.calls.length, 7);
  time += 1000;
  assert.equal((await s.call(url)).headers['cache-control'], 'private, max-age=600, must-revalidate');
  assert.equal(s.calls.length, 14);
  assert.match((await s.call(url + '&unknown=x')).headers['cache-control'], /no-store/);
});
