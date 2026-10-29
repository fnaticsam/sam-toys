const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rates, distanceMiles, estimate } = require('../../api/_lib/flights/earn');
const { normalizeFlight } = require('../../api/_lib/flights/normalize');
const { rank } = require('../../api/_lib/flights/rank');
const recorded = require('./fixtures/search.json');

// BA's published Aer Lingus/Emerald chart, reviewed 2026-10-29:
// https://www.britishairways.com/content/the-british-airways-club/about-tier-points/flights
// Test data is a synthetic transatlantic variation of the recorded FlightCard;
// it does not claim a live EI 110 schedule, booking class, price or availability.
function economyCard() {
  const card = structuredClone(recorded.flights[0]);
  delete card.returnFlight;
  card.id = 'synthetic-EI110-economy';
  card.airlines = 'Aer Lingus';
  card.departure = { airport: 'JFK', dateTime: '2026-11-05T18:00:00-05:00' };
  card.arrival = { airport: 'LHR', dateTime: '2026-11-06T06:00:00+00:00' };
  card.deepLink = 'https://skiplagged.com/flights/JFK/LHR/2026-11-05#trip=EI110-EI380';
  card.layovers = 1;
  card.attributes = ['standard'];
  return card;
}
const query = { origin: 'JFK', destination: 'LHR', departureDate: '2026-11-05', fareClass: 'economy' };

test('Aer Lingus and Emerald transatlantic economy use the sourced 4%, 7%, 15% chart', () => {
  for (const code of ['EI', 'EA']) {
    for (const [classes, expected] of [['AGOZ', 0.04], ['QNFSVLMK', 0.07], ['YBH', 0.15]]) {
      for (const bookingClass of classes) {
        assert.equal(rates(code, 'economy', bookingClass, 'JFK', 'SNN').tp, expected);
      }
    }
    assert.equal(rates(code, 'economy', undefined, 'JFK', 'SNN').tp, 0.04);
    assert.equal(rates(code, 'economy', 'J', 'JFK', 'SNN').tp, 0);
  }
});

test('opaque EI economy connection estimates 137 TP and price per TP from that estimate', () => {
  const flight = normalizeFlight(economyCard(), query).flight;
  assert.equal(flight.estimate.status, 'estimated');
  assert.equal(flight.estimate.tierPoints, 137);
  assert.equal(flight.estimate.tierPoints, Math.floor(distanceMiles('JFK', 'LHR') * 0.04));
  assert(flight.estimate.assumptions.includes('connection-mileage-is-direct-leg-lower-bound'));
  assert(flight.warnings.includes('booking-class-unavailable-some-fares-earn-zero'));
  assert.equal(rank([flight])[0].gbpPerTierPoint, flight.priceGbp / 137);
});

test('detailed EI economy via Shannon awards each flown sector once', () => {
  const card = economyCard();
  card.segments = [
    { flightNumber: 'EI110', origin: 'JFK', destination: 'SNN', cabin: 'economy' },
    { flightNumber: 'EI380', origin: 'SNN', destination: 'LHR', cabin: 'economy' },
  ];
  const flight = normalizeFlight(card, query).flight;
  assert.equal(flight.estimate.tierPoints, 136);
  assert.deepEqual(flight.estimate.breakdown.map((sector) => sector.tierPoints), [122, 14]);
});

test('860 TP on this route is the business assumption and cannot leak into economy', () => {
  const itinerary = { legs: [{ units: [{ from: 'JFK', to: 'LHR', date: query.departureDate,
    flightNumbers: ['EI110'], flown: true, opaque: false }] }], hiddenCity: false };
  assert.equal(estimate(itinerary, 3440, 'business').tierPoints, 860);
  assert.equal(estimate(itinerary, 3440, 'economy').tierPoints, 137);
  // The requested cabin remains an assumption when the provider has no cabin.
  assert(estimate(itinerary, 3440, 'economy').assumptions.includes('cabin-filter-is-not-a-confirmed-ticket-cabin'));
});
