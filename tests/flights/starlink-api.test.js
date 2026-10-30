const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInput, toolInput } = require('../../api/_lib/flights/input');
const { createHandler } = require('../../api/flights');
const { starlinkProbability } = require('../../api/_lib/flights/starlink');
const fixtures = require('./fixtures/all-airlines.cjs');

global.fetch = () => { throw new Error('Live network forbidden in flights tests'); };
const NOW = Date.parse('2026-10-28T12:00:00Z');
const URL = '/api/flights?origin=LHR&destination=DOH&departureDate=2026-11-18&maxStops=none&earningOnly=false';

// Synthetic carrier variants of an existing fare fixture, never live quotes.
function fare(code) {
  const row = structuredClone(fixtures.eligible.flights[0]);
  row.id = `starlink-${code}`;
  row.airlines = code;
  row.arrival.airport = 'DOH';
  row.deepLink = row.deepLink.replace('/JFK/', '/DOH/').replace(/#trip=.*/, `#trip=${code}100`);
  return row;
}
function setup(codes = ['ZG', 'AA', 'ZZ']) {
  const calls = [];
  const handler = createHandler({ now: () => NOW, throttleOptions: { max: 100 },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { flights: args.preferredAirlines ? [fare('AA')] : codes.map(fare) };
    } });
  async function call(url = URL) {
    const req = { method: 'GET', url, headers: { host: 'sam.toys', 'x-real-ip': '203.0.113.1' } };
    const res = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    await handler(req, res);
    return res;
  }
  return { calls, call };
}

test('starlinkMin parses strict decimal probabilities without passing them upstream', () => {
  assert.equal(parseInput(URL, NOW).starlinkMin, undefined);
  for (const [text, expected] of [['0', 0], ['1', 1], ['0.8', 0.8], ['.8', 0.8], ['1.00', 1]]) {
    const query = parseInput(`${URL}&starlinkMin=${text}`, NOW);
    assert.equal(query.starlinkMin, expected);
    assert.equal(Object.hasOwn(toolInput(query, 'LHR').args, 'starlinkMin'), false);
  }
  for (const text of ['', '-0.1', '1.01', 'NaN', 'Infinity', '0x1', '1e-1', '+0.8', ' 0.8', '0.8foo']) {
    assert.throws(() => parseInput(`${URL}&starlinkMin=${encodeURIComponent(text)}`, NOW), text);
  }
  assert.throws(() => parseInput(`${URL}&starlinkMin=0.8&starlinkMin=0.9`, NOW));
});

test('discovery rejects starlinkMin before making provider calls', async () => {
  const s = setup();
  for (const action of ['anywhere', 'flex']) {
    const result = await s.call(`${URL}&action=${action}&starlinkMin=0.8`);
    assert.equal(result.statusCode, 400);
  }
  assert.equal(s.calls.length, 0);
});

test('every search row includes the estimator result without source payloads', async () => {
  const s = setup(), result = await s.call();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.results.length, 3);
  for (const row of result.body.results) {
    const { p, basis, note } = starlinkProbability(row);
    assert.deepEqual(row.starlink, { p, basis, note });
    assert.deepEqual(Object.keys(row.starlink).sort(), ['basis', 'note', 'p']);
  }
  assert.equal(result.body.results.find(row => row.id === 'starlink-ZZ').starlink.p, null);
  assert.equal(result.body.results.find(row => row.id === 'starlink-ZZ').earns, false);
  assert.equal(s.calls.length, 2);
});

test('starlinkMin keeps exact numeric boundaries and zero while excluding unknowns', async () => {
  const s = setup(), original = (await s.call()).body.results;
  const positive = original.find(row => row.id === 'starlink-ZG').starlink.p;
  assert.equal(positive, 1, 'ZIPAIR fixture must exercise a fully equipped fleet');
  assert.equal(original.find(row => row.id === 'starlink-AA').starlink.p, 0);
  for (const min of [0, positive, 1]) {
    const result = await s.call(`${URL}&starlinkMin=${min}`);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.results.map(row => row.id), original.filter(row =>
      row.starlink.p !== null && row.starlink.p >= min).map(row => row.id));
  }
  assert((await s.call(`${URL}&starlinkMin=0`)).body.results.some(row => row.id === 'starlink-AA'));
});

test('starlinkMin separates cache entries and equivalent numeric forms share one entry', async () => {
  const s = setup();
  await s.call(); assert.equal(s.calls.length, 2);
  await s.call(`${URL}&starlinkMin=0`); assert.equal(s.calls.length, 4);
  await s.call(`${URL}&starlinkMin=0.0`); assert.equal(s.calls.length, 4);
  await s.call(`${URL}&starlinkMin=0.8`); assert.equal(s.calls.length, 6);
  await s.call(`${URL}&starlinkMin=.80`); assert.equal(s.calls.length, 6);
  await s.call(); assert.equal(s.calls.length, 6);
});

test('starlinkMin compares the lower bound inclusively and never drops unknown-share aircraft from its denominator', async () => {
  const s = setup(['QR', 'ZG', 'AA', 'ZZ']);
  const unfiltered = (await s.call()).body.results;
  const qr = unfiltered.find(row => row.id === 'starlink-QR');
  assert.equal(qr.starlink.basis, 'lower-bound');
  assert.equal(qr.starlink.p, 158 / 194);
  const included = async min => (await s.call(`${URL}&starlinkMin=${min}`)).body.results.some(row => row.id === qr.id);
  assert(await included(0.8));
  assert(await included(qr.starlink.p));
  assert.equal(await included(qr.starlink.p + 0.000001), false);
  assert.equal(await included(1), false);
});

test('invalid starlinkMin returns 400 before provider work', async () => {
  const s = setup();
  for (const suffix of ['starlinkMin=2', 'starlinkMin=unknown', 'starlinkMin=0.8&starlinkMin=0.9']) {
    assert.equal((await s.call(`${URL}&${suffix}`)).statusCode, 400);
  }
  assert.equal(s.calls.length, 0);
});
