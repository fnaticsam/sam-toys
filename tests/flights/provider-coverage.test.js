const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../../api/flights');
const { parseInput } = require('../../api/_lib/flights/input');
const { UpstreamError } = require('../../api/_lib/flights/mcp');
const records = Object.fromEntries(['nyc-100','jfk-25','jfk-100','jfk-nonstop-100'].map(name =>
  [name, require(`./fixtures/live-2026-10-29/${name}.json`)]));
global.fetch = () => { throw new Error('Live network forbidden in flights tests'); };
const NOW = Date.parse('2026-10-29T12:00:00Z');
const URL = '/api/flights?origin=JFK&destination=LHR&departureDate=2026-11-05';
const connecting = records['jfk-100'].response.flights.filter(f => f.layovers > 0);
const direct = records['jfk-100'].response.flights.filter(f => f.layovers === 0);
function setup(callTool) {
  const calls = [];
  const handler = createHandler({ now: () => NOW, throttleOptions: { max: 20 },
    callTool: async (name,args,signal) => { calls.push({name,args}); return callTool(args,signal); } });
  return { calls, async call(url = URL) {
    const req = { method: 'GET', url, headers: { host: 'sam.toys' } };
    const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await handler(req,res); return res;
  } };
}

test('recorded city query covers JFK/EWR/LGA in one 100-row call and preserves real airport mileage', async () => {
  const record = records['nyc-100'];
  const s = setup(args => { assert.equal(args.origin,'NYC'); assert.equal(args.limit,100); return record.response; });
  const r = await s.call(URL.replace('JFK','NYC'));
  assert.equal(r.statusCode,200);
  assert.equal(s.calls.length,1);
  assert.equal(r.body.results.length,99); // Condor-marketed connection correctly excluded.
  assert.equal(r.body.excluded['route-does-not-match-search'],undefined);
  assert.deepEqual([...new Set(r.body.results.map(f => f.departure.airport))].sort(),['EWR','JFK','LGA']);
  assert.equal(r.body.meta.airports.NYC,'New York');
  assert(r.body.results.every(f => !f.estimate.assumptions.includes('airport-distance-unavailable')));
  assert(r.body.results.every(f => (f.estimate.breakdown || []).every(u => u.from !== 'NYC')));
});

test('recorded JFK price page grows from 25 to 42 rows, with BA112/178 and AA100 among 12 directs', async () => {
  const before=records['jfk-25'].response.flights, after=records['jfk-100'].response.flights;
  assert.equal(before.length,25); assert.equal(after.length,42);
  assert.equal(before.filter(f => f.layovers === 0).length,7);
  assert.equal(after.filter(f => f.layovers === 0).length,12);
  assert.equal(parseInput(URL,NOW).limit,100);
  const s=setup(args => args.limit === 25 ? records['jfk-25'].response : records['jfk-100'].response);
  const a=await s.call(URL+'&limit=25'),b=await s.call();
  assert.equal(a.body.results.length,25);assert.equal(b.body.results.length,41);
  for (const number of ['BA112','BA178','AA100']) assert(b.body.results.some(f => f.flightNumbers.includes(number)));
  assert.equal(s.calls.length,2,'no supplemental call when directs already returned');
});

test('a connections-only price page gets exactly one supplemental nonstop query and a deduplicated union', async () => {
  // Synthetic selection from the recorded page models the reported connections-only slice.
  const s=setup(args => ({flights:args.maxStops === 'none' ? [direct[0],direct[0],direct[1]] : connecting}));
  const r=await s.call();
  assert.equal(r.statusCode,200); assert.equal(r.body.partial,false);
  assert.equal(s.calls.length,2); assert.equal(r.body.meta.providerCalls,2);
  assert.equal(s.calls[1].args.maxStops,'none'); assert.equal(s.calls[1].args.limit,100);
  assert.equal(s.calls[1].args.offset,0);
  assert.deepEqual(s.calls[1].args.preferredAirlines,s.calls[0].args.preferredAirlines);
  assert.equal(r.body.results.filter(f => f.flightNumbers.length === 1).length,2);
  assert.equal(new Set(r.body.results.map(f=>f.id)).size,r.body.results.length);
  assert.equal(r.body.pages[1].maxStops,'none');
});

test('nonstop supplement starts at first page, never repeats explicit nonstop searches and never loops on empty results', async () => {
  const s=setup(args => ({flights:args.maxStops === 'none' ? [] : connecting}));
  await s.call(URL+'&limit=10&offset=3');
  assert.equal(s.calls.length,2); assert.equal(s.calls[1].args.offset,0); assert.equal(s.calls[1].args.limit,100);
  await s.call(URL+'&maxStops=none'); assert.equal(s.calls.length,3);
  const empty=setup(()=>({flights:[]})); await empty.call(); assert.equal(empty.calls.length,1);
});

test('recorded nonstop timeout retains the price page as partial and is not cached', async () => {
  const error=records['jfk-nonstop-100'].error;
  assert.equal(error,'upstream-timeout');
  const s=setup(args => { if(args.maxStops === 'none') throw new UpstreamError(error); return {flights:connecting}; });
  const r=await s.call();
  assert.equal(r.statusCode,200);assert.equal(r.body.partial,true);assert(r.body.results.length>0);
  assert.deepEqual(r.body.failures,[{origin:'JFK',maxStops:'none',code:'upstream-timeout'}]);
  await s.call();assert.equal(s.calls.length,4);
});

test('supplement obeys seven-call cap and original maximum of three concurrent calls', async () => {
  let active=0,peak=0;
  const origins=['JFK','EWR','LGA','BOS','PHL','IAD','DCA'];
  const s=setup(async args => {
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;
    const flight=structuredClone(connecting[0]);
    flight.departure.airport=args.origin;flight.id=args.origin+'-connection';
    return {flights:[flight]};
  });
  const r=await s.call(URL.replace('origin=JFK','origin='+origins.join(',')));
  assert.equal(s.calls.length,7);assert.equal(r.body.meta.providerCalls,7);assert.equal(peak,3);
  assert.equal(r.body.partial,true);
  assert.deepEqual(r.body.failures,[{origin:'JFK',maxStops:'none',code:'provider-call-cap'}]);
});

test('round-trip supplement requires nonstops on both legs and preserves return safeguards', async () => {
  const returnDate='2026-11-12';
  const base=structuredClone(connecting[0]);
  base.returnFlight={airlines:'British Airways',departure:{airport:'LHR',dateTime:returnDate+'T12:00:00Z'},
    arrival:{airport:'JFK',dateTime:returnDate+'T15:00:00Z'},layovers:1,attributes:['standard']};
  base.deepLink+=',BA173-BA117';
  const supplemental=structuredClone(direct[0]);
  supplemental.returnFlight={...base.returnFlight,layovers:0};
  supplemental.deepLink+=',BA117';
  const s=setup(args=>{assert.equal(args.includeHiddenCity,false);return {flights:[args.maxStops==='none'? supplemental:base]};});
  const r=await s.call(URL+'&returnDate='+returnDate);
  assert.equal(s.calls.length,2);assert.equal(r.body.partial,false);assert.equal(r.body.results.length,2);
  assert(r.body.results.some(f=>f.legs.every(l=>l.units[0].flightNumbers.length===1)));
});
