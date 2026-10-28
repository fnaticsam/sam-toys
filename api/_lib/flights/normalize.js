const { checkSegment, parseFlightNumber } = require('./carriers');
const { estimate, FX } = require('./earn');
const IATA = /^[A-Z]{3}$/;
function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'skiplagged.com' && !url.username && !url.password && url.port === '' && value.length <= 4096 ? url.href : null;
  } catch { return null; }
}
function endpoint(value) {
  return value && IATA.test(value.airport) && typeof value.dateTime === 'string' && value.dateTime.length <= 40
    ? { airport: value.airport, dateTime: value.dateTime } : null;
}
function normalizeFlight(flight, query) {
  const fail = (reason) => ({ excluded: reason });
  const deepLink = safeLink(flight?.deepLink);
  if (!deepLink || !Number.isFinite(flight.price?.amount) || flight.price.amount <= 0 ||
      flight.price.amount > 1000000 || flight.price.currency !== 'USD') return fail('invalid-price-or-link');
  const trip = new URLSearchParams(new URL(deepLink).hash.slice(1));
  if (trip.getAll('trip').length !== 1) return fail('missing-flight-numbers');
  const groups = trip.get('trip').toUpperCase().split(',').map((g) => g.split('-'));
  const summaries = [flight, ...(flight.returnFlight ? [flight.returnFlight] : [])];
  const hiddenCity = summaries.some((s) => Array.isArray(s.attributes) && s.attributes.some((a) => typeof a === 'string' && /hidden.?city/i.test(a))) ||
    !!(endpoint(flight.arrival) && flight.arrival.airport !== query.destination);
  // A requested return forbids hidden-city fares even if the provider omits
  // its return leg or ignores includeHiddenCity:false.
  if (hiddenCity && query.returnDate) return fail('hidden-city-return-cannot-be-assumed-flown');
  if (groups.length !== summaries.length || summaries.length !== (query.returnDate ? 2 : 1)) return fail('incomplete-itinerary');
  if (hiddenCity && query.includeHiddenCity === false) return fail('hidden-city-not-requested');
  if (summaries.some((s) => Array.isArray(s.attributes) && s.attributes.some((a) => typeof a === 'string' && /virtual.?interlin/i.test(a)))) return fail('virtual-interlining-excluded');
  const legs = [];
  let flownArrival = endpoint(flight.arrival);
  let operatorVerified = true, bookingClassKnown = true;
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i], numbers = groups[i], departure = endpoint(s.departure), arrival = endpoint(s.arrival);
    if (!departure || !arrival || numbers.length < 1 || numbers.length > 6 || !numbers.every(parseFlightNumber)) return fail('invalid-segment-detail');
    // Never accept a missing flight prefix simply because airline names match.
    // Names can only tighten eligibility, e.g. LEVEL operated IB fares.
    if (typeof s.airlines === 'string' && /\blevel\b/i.test(s.airlines) && numbers.some((n) => /^(IB|I2)/.test(n))) return fail('excluded-operator');
    const from = i === 0 ? query.origin : query.destination;
    const to = i === 0 ? query.destination : query.origin;
    const date = i === 0 ? query.departureDate : query.returnDate;
    if (departure.airport !== from || departure.dateTime.slice(0, 10) !== date || (!hiddenCity && arrival.airport !== to)) return fail('route-does-not-match-search');
    const detailed = Array.isArray(s.segments) && s.segments.length > 0;
    if (hiddenCity && !detailed) return fail('hidden-city-flown-route-unavailable');
    if (detailed && s.segments.length !== numbers.length) return fail('incomplete-flight-numbers');
    if (!detailed && (!Number.isInteger(s.layovers) || s.layovers < 0 || s.layovers + 1 !== numbers.length)) return fail('incomplete-flight-numbers');
    const units = [];
    for (let j = 0; j < numbers.length; j++) {
      const segment = detailed ? s.segments[j] : {};
      if (segment.flightNumber && parseFlightNumber(segment.flightNumber)?.flightNumber !== parseFlightNumber(numbers[j]).flightNumber) return fail('conflicting-flight-numbers');
      const checked = checkSegment({ ...segment, flightNumber: numbers[j] });
      if (!checked.ok) return fail(checked.reason);
      operatorVerified &&= checked.operatorVerified;
      bookingClassKnown &&= typeof segment.bookingClass === 'string' && /^[A-Z]$/.test(segment.bookingClass);
      if (detailed) {
        const a = segment.origin || segment.departure?.airport, b = segment.destination || segment.arrival?.airport;
        if (!IATA.test(a) || !IATA.test(b) || (j === 0 ? a !== from : a !== units[j - 1].to)) return fail('disconnected-segments');
        const segmentDate = segment.departure?.dateTime?.slice(0, 10) || date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(segmentDate) || segmentDate < date) return fail('invalid-segment-date');
        units.push({ from: a, to: b, date: segmentDate, flightNumbers: [checked.flightNumber],
          bookingClass: /^[A-Z]$/.test(segment.bookingClass || '') ? segment.bookingClass : undefined,
          cabin: ['basic-economy','economy','premium','business','first'].includes(segment.cabin) ? segment.cabin : undefined,
          flown: true, opaque: false });
      }
    }
    if (detailed) {
      if (units[units.length - 1].to !== arrival.airport) return fail('route-does-not-match-search');
      const destinationIndex = units.findIndex((u) => u.to === to);
      if (destinationIndex < 0 || (!hiddenCity && destinationIndex !== units.length - 1)) return fail('destination-not-reached');
      // All booked prefixes were checked above; credit only the prefix of the
      // itinerary actually flown to the searched hidden-city destination.
      units.forEach((u, j) => { u.flown = j <= destinationIndex; });
      if (hiddenCity) flownArrival = endpoint(s.segments[destinationIndex].arrival) || { airport: to, dateTime: null };
    } else {
      units.push({ from, to, date, flightNumbers: numbers.map((n) => parseFlightNumber(n).flightNumber),
        flown: true, opaque: numbers.length > 1 });
    }
    legs.push({ from, to, date, units });
  }
  const itinerary = { legs, hiddenCity };
  const priceGbp = Math.round(flight.price.amount * FX.usdToGbp * 100) / 100;
  return { flight: {
    id: typeof flight.id === 'string' ? flight.id.slice(0, 250) : deepLink,
    origin: query.origin, destination: query.destination,
    departure: endpoint(flight.departure), arrival: flownArrival,
    bookedArrival: hiddenCity ? endpoint(flight.arrival) : null,
    ticketedTo: flight.arrival.airport, leaveAt: query.destination,
    returnFlight: flight.returnFlight ? { departure: endpoint(flight.returnFlight.departure), arrival: endpoint(flight.returnFlight.arrival) } : null,
    flightNumbers: groups.flat(), price: { amount: flight.price.amount, currency: 'USD' }, priceGbp, deepLink,
    hiddenCity, eligibility: operatorVerified && bookingClassKnown ? 'eligible-subject-to-ticket' : 'conditional',
    warnings: [...(!operatorVerified ? ['operating-carrier-unavailable-verify-before-booking'] : []),
      ...(!bookingClassKnown ? ['booking-class-unavailable-some-fares-earn-zero'] : []),
      ...(hiddenCity ? ['skipping-a-sector-can-invalidate-ticket-and-credit'] : [])],
    estimate: estimate(itinerary, priceGbp, query.fareClass),
  } };
}
module.exports = { safeLink, normalizeFlight };
