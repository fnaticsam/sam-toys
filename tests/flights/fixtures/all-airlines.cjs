// Synthetic LHR–JFK top-N regression: the cheapest unfiltered page contains
// no earning carriers, while the preferred-airline page contains 25 of them.
// These are test fares, not recorded provider quotes.
function flight(code, number, price) {
  const trip = `${code}${number}`;
  return {
    type: 'FlightCard', id: `LHR-JFK-2026-11-18-trip=${trip}`,
    airlines: code,
    departure: { airport: 'LHR', dateTime: '2026-11-18T10:00:00Z' },
    arrival: { airport: 'JFK', dateTime: '2026-11-18T18:00:00Z' },
    duration: '8h', layovers: 0, attributes: ['standard', 'nonstop'],
    price: { amount: price, currency: 'USD' },
    deepLink: `https://skiplagged.com/flights/LHR/JFK/2026-11-18#trip=${trip}`,
  };
}
module.exports = {
  eligible: { flights: Array.from({ length: 25 }, (_, i) => flight(['BA', 'AA', 'IB'][i % 3], 100 + i, 500 + i)) },
  all: { flights: Array.from({ length: 17 }, (_, i) => flight('TP', 200 + i, 100 + i)) },
};
