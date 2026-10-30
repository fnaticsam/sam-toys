/* Local browser QA only. All provider responses derive from committed recorded
 * fixtures. Routes/dates and the detailed hidden-city case are synthetic test
 * mutations, never live Skiplagged results or claims of available fares. */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHandler } = require('../../api/flights');
const { CITY_GROUPS } = require('../../api/_lib/flights/cities');
const { UpstreamError } = require('../../api/_lib/flights/mcp');
const recorded = { search: require('./fixtures/search.json'), anywhere: require('./fixtures/anywhere.json'), flex: require('./fixtures/flex.json') };
const NOW = Date.parse('2026-10-28T12:00:00Z');
const ROOT = path.resolve(__dirname, '../..');

function searchFixture(args) {
  args = { ...args, origin: CITY_GROUPS[args.origin]?.airports[0] || args.origin,
    destination: CITY_GROUPS[args.destination]?.airports[0] || args.destination };
  // Preserve the actual recorded return price and earning calculation for MAD.
  const out = structuredClone(recorded.search);
  out.flights = out.flights.slice(0, 3).map((f, i) => {
    f.departure.airport = args.origin;
    f.departure.dateTime = args.departureDate + f.departure.dateTime.slice(10);
    f.arrival.airport = args.destination;
    f.arrival.dateTime = args.departureDate + f.arrival.dateTime.slice(10);
    let trip = ['IB714', 'IB726', 'IB718'][i];
    if (args.returnDate) {
      f.returnFlight.departure.airport = args.destination;
      f.returnFlight.departure.dateTime = args.returnDate + f.returnFlight.departure.dateTime.slice(10);
      f.returnFlight.arrival.airport = args.origin;
      f.returnFlight.arrival.dateTime = args.returnDate + f.returnFlight.arrival.dateTime.slice(10);
      trip += ',IB725';
    } else delete f.returnFlight;
    f.id = `fixture-${args.origin}-${args.destination}-${args.departureDate}-${trip}`;
    f.deepLink = `https://skiplagged.com/flights/${args.origin}/${args.destination}/${args.departureDate}${args.returnDate ? '/' + args.returnDate : ''}?utm_source=mcp#trip=${trip}`;
    return f;
  });
  if (!args.returnDate) {
    // Synthetic complete flown-prefix fixture: LHR -> MAD -> BCN. The backend
    // should include this only for one-way and credit only the flown prefix.
    const f = structuredClone(out.flights[0]);
    f.id += '-hidden';
    f.price.amount = 90;
    f.arrival = { airport: 'BCN', dateTime: args.departureDate + 'T16:00:00+01:00' };
    f.layovers = 1;
    f.attributes = ['hidden-city'];
    f.deepLink = `https://skiplagged.com/flights/${args.origin}/${args.destination}/${args.departureDate}?utm_source=mcp#trip=IB714-IB411`;
    f.segments = [
      { flightNumber: 'IB714', origin: args.origin, destination: args.destination, departure: f.departure,
        arrival: { airport: args.destination, dateTime: args.departureDate + 'T14:15:00+01:00' }, cabin: 'economy', bookingClass: 'Y', operatingCarrier: 'IB' },
      { flightNumber: 'IB411', origin: args.destination, destination: 'BCN',
        departure: { airport: args.destination, dateTime: args.departureDate + 'T15:00:00+01:00' }, arrival: f.arrival,
        cabin: 'economy', bookingClass: 'Y', operatingCarrier: 'IB' },
    ];
    out.flights.push(f);
  }
  // Synthetic ordinary Ryanair fare exercises the opt-in all-airline path.
  // Its distinct times ensure the UI does not collapse it with an earning fare.
  const nonEarning = structuredClone(out.flights[0]);
  nonEarning.id = `fixture-${args.origin}-${args.destination}-${args.departureDate}-trip=FR9755${args.returnDate ? ',FR9756' : ''}`;
  nonEarning.airlines = 'Ryanair';
  nonEarning.departure.dateTime = args.departureDate + 'T07:00:00+00:00';
  nonEarning.arrival.dateTime = args.departureDate + 'T10:00:00+01:00';
  nonEarning.duration = '2h 0m';
  nonEarning.price.amount = 45;
  nonEarning.deepLink = `https://skiplagged.com/flights/${args.origin}/${args.destination}/${args.departureDate}${args.returnDate ? '/' + args.returnDate : ''}?utm_source=mcp#trip=FR9755${args.returnDate ? ',FR9756' : ''}`;
  if (nonEarning.returnFlight) nonEarning.returnFlight.airlines = 'Ryanair';
  out.flights.push(nonEarning);
  out.pagination = { totalAvailable: out.flights.length, hasMoreResults: false };
  return out;
}

async function createFixtureServer({ port = 0, approvedPath = path.join(ROOT, 'prototypes/flights/proto-v4.html'), baselinePath = process.env.FLIGHTS_BASELINE_PAGE || null } = {}) {
  let mode = 'normal', handler, holding = false;
  const requests = [], toolCalls = [], waiting = new Set();
  const allowed = new Set(['normal', 'empty', 'error', 'throttled', 'partial', 'loading']);
  function release() { holding = false; for (const resolve of waiting) resolve(); waiting.clear(); }
  function setMode(next) {
    if (!allowed.has(next)) throw new Error('Unknown fixture scenario');
    release(); mode = next; holding = next === 'loading';
    handler = createHandler({ now: () => NOW, cacheOptions: { capacity: 0 },
      throttleOptions: { max: next === 'throttled' ? 0 : 10000 }, maxConcurrentRequests: 100,
      callTool: async (name, args, signal) => {
        const thisMode = mode;
        toolCalls.push({ name, args: structuredClone(args), mode: thisMode });
        if (thisMode === 'loading' && holding) await new Promise((resolve) => {
          waiting.add(resolve);
          signal.addEventListener('abort', () => { waiting.delete(resolve); resolve(); }, { once: true });
        });
        if (thisMode === 'error' || (thisMode === 'partial' && args.maxStops === 'none')) throw new UpstreamError('invalid-upstream-response');
        if (thisMode === 'partial' && name === 'sk_flights_search') {
          // Single city-code searches can still be partial when the nonstop
          // supplement fails. Make the base page synthetic connecting fares.
          const data = searchFixture(args);
          data.flights = data.flights.filter(f => !f.attributes.includes('hidden-city')).map(f => {
            f.layovers = 1;
            f.deepLink = f.deepLink.replace(/#trip=([^,]+)(.*)$/, '#trip=$1-IB411$2');
            return f;
          });
          return data;
        }
        if (name === 'sk_flights_search') return thisMode === 'empty' ? { flights: [], pagination: { totalAvailable: 0, hasMoreResults: false } } : searchFixture(args);
        if (name === 'sk_destinations_anywhere') return structuredClone(recorded.anywhere);
        return structuredClone(recorded.flex);
      },
    });
  }
  setMode(mode);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/__scenario') {
        if (url.searchParams.has('mode')) setMode(url.searchParams.get('mode'));
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ mode }));
      }
      if (url.pathname === '/api/flights') {
        requests.push({ url: req.url, mode });
        return await handler(req, res);
      }
      // Explicit allowlist: never expose .env, private API pages or repo files.
      const file = ['/flights', '/flights/', '/flights/index.html'].includes(url.pathname) ? path.join(ROOT, 'flights/index.html') : url.pathname === '/approved' ? approvedPath : url.pathname === '/baseline' ? baselinePath : null;
      if (/^\/flights\/fonts\/[a-zA-Z0-9._-]+\.woff2$/.test(url.pathname)) {
        res.setHeader('content-type', 'font/woff2');
        return res.end(await fs.readFile(path.join(ROOT, url.pathname)));
      }
      if (url.pathname === '/flights/cities.js') {
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        return res.end(await fs.readFile(path.join(ROOT, 'flights/cities.js')));
      }
      if (!file) { res.statusCode = 404; return res.end('Not found'); }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('x-robots-tag', 'noindex, nofollow');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 500; res.end('Fixture server error'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, setMode, release, requests, toolCalls,
    close: async () => { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createFixtureServer, searchFixture, NOW };
if (require.main === module) createFixtureServer({ port: Number(process.env.PORT || 4173) }).then(({ url }) => process.stdout.write(url + '\n'));
