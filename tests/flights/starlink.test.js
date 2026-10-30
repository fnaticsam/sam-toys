const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AS_OF, SOURCES, CARRIER_FLEETS, starlinkProbability } = require('../../api/_lib/flights/starlink');
const { CARRIERS } = require('../../api/_lib/flights/carriers');
const { normalizeFlight } = require('../../api/_lib/flights/normalize');
const search = require('./fixtures/search.json');
const connecting = require('./fixtures/connecting.json');
global.fetch = () => { throw new Error('Live network forbidden in flights tests'); };

// Synthetic normalized segment fixtures; no aircraft assignments are claimed.
const sector = (code, from = 'LHR', to = 'JFK', extra = {}) => ({
  from, to, date: '2026-11-18', flightNumbers: [`${code}100`], flown: true, opaque: false, ...extra,
});
const row = (...units) => ({ legs: [{ units }] });
const probability = (...units) => starlinkProbability(row(...units));
const approx = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('every earning carrier and requested all-airline carrier has dated evidence, including unknowns', () => {
  for (const code of [...Object.keys(CARRIERS), 'HA', 'UA', 'AF', 'NZ', 'WS', 'BT', 'EK', 'VS', 'TP', 'DL', 'SK', 'AC', 'ZG']) {
    assert(CARRIER_FLEETS[code]?.length, code);
    for (const fleet of CARRIER_FLEETS[code]) {
      assert(fleet.type && fleet.status && fleet.asOf && fleet.sources.length, code);
      assert(fleet.share === null || (Number.isFinite(fleet.share) && fleet.share >= 0 && fleet.share <= 1));
      for (const source of fleet.sources) {
        assert.equal(new URL(source.url).protocol, 'https:');
        assert.match(source.accessed, /^\d{4}-\d{2}-\d{2}$/);
        assert(source.accessed <= AS_OF);
      }
    }
  }
  assert(Object.values(SOURCES).every(source => Object.hasOwn(source, 'published')));
});

test('missing candidate aircraft counts remain unknown rather than zero or a completed target', () => {
  for (const code of ['IB', 'I2', 'AY', 'CX', 'FJ', 'JL', 'NU', 'MH', 'WY', 'QF', 'RJ', 'UL', 'NZ', 'WS', 'BT', 'EK', 'VS', 'TP', 'SK', 'AC', 'EA']) {
    const result = probability(sector(code));
    assert.equal(result.p, null, code);
    assert.equal(result.basis, 'unknown', code);
    assert(result.sources.length, code);
  }
});

test('whole-fleet completion and explicit no-Starlink policies have numeric priors', () => {
  assert.equal(probability(sector('ZG')).p, 1);
  assert.equal(probability(sector('ZG')).basis, 'fleet-share');
  assert.equal(probability(sector('AA')).p, 0);
  assert.equal(probability(sector('AT')).p, 0);
  assert.equal(probability(sector('DL')).p, 0);
});

test('HA long-haul count prior includes unequipped 787s and excludes interisland 717s', () => {
  const result = probability(sector('HA', 'SEA', 'HNL'));
  approx(result.p, 42 / 47);
  assert.equal(result.basis, 'route');
  assert.equal(probability(sector('HA', 'HNL', 'OGG')).p, 0);
  assert.equal(probability(sector('AS', 'SEA', 'HNL')).p, null);
});

test('EI active-fleet scope conflicts remain unknown without leaking mainline coverage to regional routes', () => {
  assert.equal(probability(sector('EI', 'DUB', 'JFK')).p, null);
  assert.equal(probability(sector('EI', 'DUB', 'LHR')).p, null);
  assert.equal(probability(sector('EA', 'DUB', 'JFK')).p, null);
});

test('range bands exclude narrowbodies from very long UA routes and count all compatible widebodies', () => {
  const result = probability(sector('UA', 'SFO', 'SIN'));
  approx(result.p, 6 / (96 + 100 + 53)); // 777 + 787 + 767; snapshot uniform-aircraft prior
  assert.equal(result.basis, 'route');
  assert.match(result.note, /Aircraft swaps/);
  assert.equal(probability(sector('UA', 'SFO', 'LAX')).p, null); // unenumerated regional fleet
});

test('itinerary probability multiplies every flown sector across outbound and return', () => {
  const a = sector('HA', 'SEA', 'HNL'), b = sector('HA', 'HNL', 'SEA');
  const result = starlinkProbability({ legs: [{ units: [a] }, { units: [b] }] });
  approx(result.p, (42 / 47) ** 2);
  assert.equal(probability(sector('ZG'), sector('DL')).p, 0);
});

test('an unknown flown segment dominates even an explicitly unequipped segment', () => {
  assert.equal(probability(sector('DL'), sector('ZZ')).p, null);
  assert.equal(probability(sector('ZZ'), sector('DL')).p, null);
});

test('hidden-city estimates ignore every unflown sector and its unknown operator', () => {
  const result = probability(sector('HA', 'SEA', 'HNL'), sector('ZZ', 'HNL', 'NRT', { flown: false }));
  approx(result.p, 42 / 47);
  assert(!result.note.includes('ZZ'));
  assert.equal(probability(sector('ZZ', 'SEA', 'HNL'), sector('ZG', 'HNL', 'NRT', { flown: false })).p, null);
});

test('operator evidence overrides marketing, while missing operator assumptions are explicit', () => {
  assert.equal(probability(sector('BA', 'LHR', 'JFK', { operatingCarrier: 'ZG' })).p, 1);
  const operated = probability(sector('ZG', 'LHR', 'JFK', { operatingCarrier: 'BA' }));
  assert.equal(operated.p, 0);
  assert.equal(operated.basis, 'lower-bound');
  assert.match(probability(sector('ZG')).note, /Operator unavailable/);
  for (const operatingCarrier of ['ZZ', '__proto__', 'constructor', 'Hawaiian Airlines']) {
    assert.equal(probability(sector('ZG', 'LHR', 'JFK', { operatingCarrier })).p, null);
  }
});

test('normalization retains operating carrier evidence for direct and detailed flights', () => {
  const fixture = structuredClone(search.flights[0]);
  fixture.operatingCarrier = 'DL';
  fixture.returnFlight.operatingCarrier = 'ZG';
  const query = { origin: 'LHR', destination: 'MAD', departureDate: '2026-11-18', returnDate: '2026-11-21', fareClass: 'economy' };
  const normalized = normalizeFlight(fixture, query).flight;
  assert.equal(normalized.legs[0].units[0].operatingCarrier, 'DL');
  assert.equal(normalized.legs[1].units[0].operatingCarrier, 'ZG');
  assert.equal(starlinkProbability(normalized).p, 0);
  const detailed = structuredClone(fixture);
  detailed.segments = [{ flightNumber: 'IB714', origin: 'LHR', destination: 'MAD', operatingCarrier: 'DL' }];
  detailed.returnFlight.segments = [{ flightNumber: 'IB725', origin: 'MAD', destination: 'LHR', operatingCarrier: 'ZG' }];
  const allAirline = normalizeFlight(detailed, { ...query, earningOnly: false }).flight;
  assert.equal(allAirline.legs[0].units[0].operatingCarrier, 'DL');
  assert.equal(starlinkProbability(allAirline).p, 0);
  delete detailed.segments[0].operatingCarrier;
  detailed.operatingCarrier = 'ZZ';
  const summaryOperator = normalizeFlight(detailed, { ...query, earningOnly: false }).flight;
  assert.equal(summaryOperator.legs[0].units[0].operatingCarrier, 'ZZ');
  assert.equal(starlinkProbability(summaryOperator).p, null);
});

test('missing geometry, opaque connections, empty input and malformed operator codes are unknown', () => {
  for (const input of [null, {}, row(), row(sector('ZG', 'ZZZ', 'JFK')), row(sector('ZG', '__proto__', 'JFK')),
    row(sector('ZG', 'LHR', 'JFK', { opaque: true, flightNumbers: ['ZG1', 'ZG2'] }))]) {
    assert.equal(starlinkProbability(input).p, null);
  }
  const q = { origin: 'LHR', destination: 'BKK', departureDate: '2026-11-18', fareClass: 'economy' };
  assert.equal(starlinkProbability(normalizeFlight(connecting.flights[0], q).flight).p, null);
});

test('pre-rollout zero is not extrapolated into 2027 installation periods', () => {
  for (const code of ['AA', 'AT']) {
    assert.equal(probability(sector(code, 'LHR', 'JFK', { date: '2026-12-31' })).p, 0);
    assert.equal(probability(sector(code, 'LHR', 'JFK', { date: '2027-01-01' })).p, null);
    assert.equal(probability(sector(code, 'LHR', 'JFK', { date: undefined })).p, null);
  }
});

test('known counts yield lower bounds naming unknown sub-fleets without changing their evidence shares', () => {
  const qr = probability(sector('QR', 'LHR', 'DOH'));
  approx(qr.p, 158 / 194);
  assert.equal(qr.basis, 'lower-bound');
  assert.match(qr.note, /unknown equipped share for 787-9, A380; counted as not equipped/);
  assert(!qr.note.includes('A330'));
  assert.equal(CARRIER_FLEETS.QR.find(fleet => fleet.type === '787-9').share, null);
  const ba = probability(sector('BA', 'LHR', 'JFK'));
  assert.equal(ba.p, 0);
  assert.equal(ba.basis, 'lower-bound');
  assert.match(ba.note, /unknown equipped share for 777-200, 777-300ER, 787-9, 787-10/);
  for (const excluded of ['A350', '787-8', 'A380']) assert(!ba.note.includes(excluded), excluded);
  // Other routes keep the broader compatible fleet, not the JFK candidate set.
  approx(probability(sector('BA', 'LHR', 'BOS')).p, 28 / 131);
  approx(probability(sector('QR', 'DOH', 'JFK')).p, 158 / 211);
  assert.equal(probability(sector('QR', 'DOH', 'DXB')).p, null);
  approx(probability(sector('QR', 'DOH', 'LHR')).p, qr.p);
  assert.equal(probability(sector('BA', 'JFK', 'LHR')).p, 0);
});

test('lower-bound basis survives multiplication across flown sectors and an unknown denominator still dominates', () => {
  const qr = sector('QR', 'LHR', 'DOH'), ha = sector('HA', 'SEA', 'HNL');
  approx(probability(qr, ha).p, (158 / 194) * (42 / 47));
  assert.equal(probability(qr, ha).basis, 'lower-bound');
  approx(starlinkProbability({ legs: [{ units: [qr] }, { units: [sector('QR', 'DOH', 'LHR')] }] }).p, (158 / 194) ** 2);
  assert.equal(probability(qr, sector('AS', 'SEA', 'HNL')).p, null);
  assert.equal(probability(qr, sector('AS', 'SEA', 'HNL')).basis, 'unknown');
  assert.equal(probability(qr, { ...sector('BA'), flown: false }).basis, 'lower-bound');
});

test('requested example routes retain route, fleet and lower-bound distinctions', () => {
  approx(probability(sector('QR', 'LHR', 'DOH')).p, 158 / 194);
  assert.equal(probability(sector('BA', 'LHR', 'JFK')).p, 0);
  assert.equal(probability(sector('AA', 'LHR', 'JFK')).p, 0);
  assert.equal(probability(sector('AS', 'SEA', 'HNL')).p, null);
  approx(probability(sector('HA', 'SEA', 'HNL')).p, 42 / 47);
  assert.equal(probability(sector('IB', 'LHR', 'MAD')).p, null);
  approx(probability(sector('UA', 'LHR', 'ORD')).p, 313 / 1015);
});
