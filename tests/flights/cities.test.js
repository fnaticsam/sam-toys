const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { CITY_GROUPS, matchesAirport, cityName } = require('../../api/_lib/flights/cities');
const airports = require('../../api/_lib/flights/airports.json');
const { normalizeFlight } = require('../../api/_lib/flights/normalize');
const { distanceMiles } = require('../../api/_lib/flights/earn');
const recorded = require('./fixtures/search.json').flights[0];
const clone = x => structuredClone(x);
const query = { origin: 'NYC', destination: 'LON', departureDate: '2026-11-05', fareClass: 'economy' };
function flight(origin = 'JFK', destination = 'LHR', returning = false) {
  const f = clone(recorded);
  f.departure = { airport: origin, dateTime: '2026-11-05T18:00:00Z' };
  f.arrival = { airport: destination, dateTime: '2026-11-06T06:00:00Z' };
  f.deepLink = 'https://skiplagged.com/#trip=QR110' + (returning ? ',QR111' : '');
  f.layovers = 0;
  f.attributes = [];
  delete f.returnFlight;
  if (returning) f.returnFlight = { departure: { airport: destination, dateTime: '2026-11-12T10:00:00Z' },
    arrival: { airport: origin, dateTime: '2026-11-12T18:00:00Z' }, layovers: 0, attributes: [] };
  return f;
}
function segment(origin, destination, number = 'QR110') {
  return { origin, destination, flightNumber: number, operatingCarrier: 'QR', bookingClass: 'T' };
}

test('city groups cover requested metropolitan areas and only known airport coordinates', () => {
  const required = { NYC: ['JFK','EWR','LGA'], LON: ['LHR','LGW','LCY','STN','LTN','SEN'], PAR: ['CDG','ORY'],
    MIL: ['MXP','LIN','BGY'], ROM: ['FCO','CIA'], TYO: ['HND','NRT'], CHI: ['ORD','MDW'], WAS: ['IAD','DCA','BWI'], DTT: ['DTW','DET'], SPK: ['CTS','OKD'], TCI: ['TFS','TFN'] };
  for (const [code, members] of Object.entries(required)) assert.deepEqual(CITY_GROUPS[code].airports, members);
  assert(Object.keys(CITY_GROUPS).length > Object.keys(required).length);
  for (const [code, group] of Object.entries(CITY_GROUPS)) {
    assert(group.name && group.airports.length > 1, code);
    assert.equal(cityName(code), group.name);
    for (const airport of group.airports) {
      assert(airports[airport], airport);
      assert(matchesAirport(code, airport), `${code}/${airport}`);
      assert(matchesAirport(airport, airport));
      assert(!matchesAirport(airport, code), `${airport} must remain exact`);
    }
  }
  assert(!matchesAirport('NYC', 'LHR'));
  assert(!matchesAirport('LHR', 'LGW'));
  assert(!matchesAirport('NYC', 'NYC'));
  assert(!matchesAirport('NYC', undefined));
  assert.equal(cityName('LHR'), 'LHR');
});

test('browser and backend use the identical city catalogue', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../flights/cities'), 'utf8'), context);
  assert.equal(JSON.stringify(context.FlightCities.CITY_GROUPS), JSON.stringify(CITY_GROUPS));
  assert(context.FlightCities.matchesAirport('NYC','EWR'));
  assert.equal(context.FlightCities.cityName('LON'), 'London');
});

test('city groups match both ends without making member arrivals hidden cities', () => {
  for (const from of CITY_GROUPS.NYC.airports) for (const to of CITY_GROUPS.LON.airports) {
    const row = normalizeFlight(flight(from, to), { ...query, includeHiddenCity: false }).flight;
    assert(row, `${from}/${to}`);
    assert.equal(row.hiddenCity, false);
    assert.equal(row.origin, 'NYC'); assert.equal(row.destination, 'LON');
    assert.equal(row.departure.airport, from); assert.equal(row.arrival.airport, to);
    assert.equal(row.leaveAt, to);
    assert.equal(row.estimate.status, 'estimated');
    assert.equal(row.estimate.tierPoints, Math.floor(distanceMiles(from,to) * 0.04));
    assert.equal(row.legs[0].from, from); assert.equal(row.legs[0].to, to);
    assert.equal(row.legs[0].units[0].from, from); assert.equal(row.legs[0].units[0].to, to);
  }
  assert.equal(normalizeFlight(flight('EWR'), { ...query, origin: 'JFK' }).excluded, 'route-does-not-match-search');
  assert.equal(normalizeFlight(flight('JFK','LGW'), { ...query, destination: 'LHR', includeHiddenCity: false }).excluded, 'hidden-city-not-requested');
  assert.equal(normalizeFlight(flight('CDG'), query).excluded, 'route-does-not-match-search');
});

test('round trips allow different group airports while validating each return endpoint', () => {
  const q = { ...query, returnDate: '2026-11-12', includeHiddenCity: false };
  const f = flight('JFK','LHR',true);
  f.returnFlight.departure.airport = 'LGW'; f.returnFlight.arrival.airport = 'EWR';
  const row = normalizeFlight(f, q).flight;
  assert(row); assert.equal(row.hiddenCity, false);
  assert.deepEqual(row.legs.map(l=>[l.from,l.to]), [['JFK','LHR'],['LGW','EWR']]);
  assert.equal(row.estimate.tierPoints, Math.floor(distanceMiles('JFK','LHR')*.04)+Math.floor(distanceMiles('LGW','EWR')*.04));
  for (const endpoint of ['departure','arrival']) {
    const wrong = clone(f); wrong.returnFlight[endpoint].airport = 'CDG';
    assert.equal(normalizeFlight(wrong,q).excluded, 'route-does-not-match-search');
  }
  f.attributes.push('hidden-city');
  assert.equal(normalizeFlight(f,q).excluded, 'hidden-city-return-cannot-be-assumed-flown');
});

test('detailed routes preserve airport identity and destination boundary on both legs', () => {
  const q = { ...query, returnDate: '2026-11-12' };
  const f = flight('EWR','LGW',true);
  f.segments = [segment('EWR','LGW')];
  f.returnFlight.departure.airport = 'LHR'; f.returnFlight.arrival.airport = 'JFK';
  f.returnFlight.segments = [segment('LHR','JFK','QR111')];
  assert(normalizeFlight(f,q).flight);
  const mismatched = clone(f); mismatched.segments[0].origin = 'JFK';
  assert.equal(normalizeFlight(mismatched,q).excluded, 'disconnected-segments');
  const returnMismatch = clone(f); returnMismatch.returnFlight.segments[0].origin = 'LGW';
  assert.equal(normalizeFlight(returnMismatch,q).excluded, 'disconnected-segments');
  const destinationMismatch = clone(f); destinationMismatch.segments[0].destination = 'LHR';
  assert.equal(normalizeFlight(destinationMismatch,q).excluded, 'route-does-not-match-search');
  const throughCity = flight('JFK','LGW');
  throughCity.deepLink = 'https://skiplagged.com/#trip=QR110-QR111';
  throughCity.segments = [segment('JFK','LHR'), segment('LHR','LGW','QR111')];
  assert.equal(normalizeFlight(throughCity,query).excluded, 'destination-not-reached');
});

test('hidden city credits only the actual member airport reached and still forbids returns', () => {
  const f = flight('JFK','DOH');
  f.deepLink = 'https://skiplagged.com/#trip=QR110-QR111';
  f.segments = [segment('JFK','LHR'),segment('LHR','DOH','QR111')];
  const row = normalizeFlight(f, { ...query, includeHiddenCity: true }).flight;
  assert(row); assert.equal(row.hiddenCity,true); assert.equal(row.arrival.airport,'LHR');
  assert.equal(row.bookedArrival.airport,'DOH'); assert.equal(row.leaveAt,'LHR');
  assert.equal(row.estimate.tierPoints,Math.floor(distanceMiles('JFK','LHR')*.04));
  assert.deepEqual(row.legs[0].units.map(u=>u.flown),[true,false]);
  assert.equal(normalizeFlight(f,{ ...query, includeHiddenCity: false }).excluded,'hidden-city-not-requested');
  assert.equal(normalizeFlight(f,{ ...query, returnDate:'2026-11-12' }).excluded,'hidden-city-return-cannot-be-assumed-flown');
  const opaque = clone(f); delete opaque.segments;
  assert.equal(normalizeFlight(opaque,query).excluded,'hidden-city-flown-route-unavailable');
  f.segments[0].destination='CDG';f.segments[1].origin='CDG';
  assert.equal(normalizeFlight(f,query).excluded,'destination-not-reached');
});
