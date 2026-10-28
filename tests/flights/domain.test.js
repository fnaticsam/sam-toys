const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ELIGIBLE_CODES, checkSegment, DEFAULT_ORIGINS } = require('../../api/_lib/flights/carriers');
const { rates, distanceMiles, FX, collectionYear, goldThreshold, extraTierPoints } = require('../../api/_lib/flights/earn');
const { normalizeFlight } = require('../../api/_lib/flights/normalize');
const { rank } = require('../../api/_lib/flights/rank');
const { parseInput, toolInput } = require('../../api/_lib/flights/input');
const search = require('./fixtures/search.json');
const connecting = require('./fixtures/connecting.json');
const schemas = require('./fixtures/schemas.json');
global.fetch = () => { throw new Error('Live network forbidden in flights tests'); };
const NOW = Date.parse('2026-10-28T12:00:00Z');
const query = { origin: 'LHR', destination: 'MAD', departureDate: '2026-11-18', returnDate: '2026-11-21', fareClass: 'economy' };
const clone = (x) => structuredClone(x);

test('eligible carrier prefixes cover current members and earning affiliates, excluding Avios-only codes', () => {
  assert.deepEqual(DEFAULT_ORIGINS, ['LHR','LGW','LCY','STN','LTN','SEN','IBZ']);
  for (const code of ['BA','AA','AS','IB','AY','CX','FJ','JL','MH','WY','QF','QR','AT','RJ','UL','EI','EA','I2','NU']) assert(ELIGIBLE_CODES.includes(code));
  for (const code of ['VY','LM','LL','HA','S7','CZ','LA','FR','U2','YW']) assert(!checkSegment({ flightNumber: `${code}123` }).ok, code);
  for (const number of ['AY8100','AY8700','MH3000','MH4999','MH5999','MH6000','MH8000']) assert(!checkSegment({ flightNumber: number }).ok, number);
  assert(checkSegment({ flightNumber: 'AY8099' }).ok);
  assert(checkSegment({ flightNumber: 'BA123', operatingCarrier: 'VY' }).ok);
  assert(!checkSegment({ flightNumber: 'IB123', operatingCarrier: 'LL' }).ok);
  assert(!checkSegment({ flightNumber: 'QF123', operatingCarrier: 'EK' }).ok);
});

test('published partner fare classes use post-2025 percentage rules, with cabin-specific conservative defaults', () => {
  assert.equal(rates('QR','business','J','LHR','DOH').tp, 0.5);
  assert.equal(rates('QR','business',null,'LHR','DOH').tp, 0.25);
  assert.equal(rates('QR','business',null,'LHR','DOH').avios, 0.75);
  assert.equal(rates('EI','economy',null,'LHR','DUB').tp, 0.04);
  assert.equal(rates('CX','premium','W','LHR','HKG').tp, 0.125);
  assert.equal(rates('WY','economy',null,'LHR','MCT').avios, 0.1);
  assert.equal(rates('JL','economy',null,'HND','ITM').tp, 0.07);
  assert.equal(rates('FJ','economy','Y','NAN','SUV').tp, 0.02);
  assert.equal(rates('AS','first',null,'SEA','JFK').tp, 0.125);
  assert.equal(rates('QR','economy','A','LHR','DOH').tp, 0);
  assert.equal(rates('EI','premium',null,'LHR','DUB'), null);
  assert(distanceMiles('LHR','MAD') > 770 && distanceMiles('LHR','MAD') < 800);
  assert.equal(distanceMiles('ZZZ','LHR'), null);
});

test('recorded Iberia return fare earns once on total spend, with Gold Avios per EUR', () => {
  const result = normalizeFlight(search.flights[0], query).flight;
  assert.equal(result.priceGbp, 93.17);
  assert.equal(result.hiddenCity,false);assert.equal(result.ticketedTo,'MAD');assert.equal(result.leaveAt,'MAD');
  assert.deepEqual(result.flightNumbers, ['IB714','IB725']);
  assert.equal(result.eligibility, 'conditional');
  assert.equal(result.estimate.tierPoints, 66); // round(£93.17 * .7 / 2) per leg
  assert.equal(result.estimate.avios, 610); // floor(£32.6095 * 1.17 * 8) per leg
  assert.equal(result.estimate.tierPointsByCollectionYear['2026-2027'], 66);
  assert.equal(result.gbpPerTierPoint, undefined);
  assert.equal(rank([result])[0].gbpPerTierPoint, 93.17 / 66);
});

test('BA and AA use revenue, not old flat 40/140 TP or distance earning', () => {
  const f = clone(search.flights[0]);
  f.deepLink = f.deepLink.replace('IB714,IB725','BA714,AA725');
  const result = normalizeFlight(f, query).flight;
  assert.equal(result.estimate.tierPoints, 66);
  assert.equal(result.estimate.avios, 586); // Gold 9 per eligible GBP
  assert.equal(extraTierPoints('economy','2026-11-18'), 0);
  assert.equal(extraTierPoints('business','2026-11-18'), 175);
  assert.equal(extraTierPoints('premium','2026-11-18'), 75);
  assert.equal(extraTierPoints('premium','2027-04-01'), 75);
  assert.equal(extraTierPoints('first','2026-11-18','AA'), 175);
  assert.equal(extraTierPoints('premium','2026-11-18','AA'), 75);
});

test('recorded opaque connection counts all prefixes but awards direct mileage only once', () => {
  const q = { ...query, destination: 'BKK', returnDate: undefined };
  const result = normalizeFlight(connecting.flights[0], q).flight;
  assert.deepEqual(result.flightNumbers, ['QR110','QR832']);
  assert.equal(result.estimate.tierPoints, Math.floor(distanceMiles('LHR','BKK') * 0.04));
  assert.equal(result.estimate.avios, Math.floor(distanceMiles('LHR','BKK') * 0.25));
  assert(result.estimate.assumptions.includes('connection-mileage-is-direct-leg-lower-bound'));
  const mixed = clone(connecting.flights[0]);
  mixed.deepLink = mixed.deepLink.replace('QR832','EK832');
  assert.equal(normalizeFlight(mixed,q).excluded,'non-earning-or-unknown-flight-number');
  mixed.deepLink = mixed.deepLink.replace('EK832','BA832');
  assert.equal(normalizeFlight(mixed,q).flight.estimate.status,'unavailable');
});

test('marketing codes and every return/connection segment govern eligibility, never display names', () => {
  for (const [old, value] of [['IB725','FR725'],['IB714','ZZ714']]) {
    const f = clone(search.flights[0]); f.deepLink = f.deepLink.replace(old,value);
    assert.equal(normalizeFlight(f,query).excluded,'non-earning-or-unknown-flight-number');
  }
  const f = clone(search.flights[0]); f.deepLink = f.deepLink.replace('#trip=IB714,IB725','');
  assert.equal(normalizeFlight(f,query).excluded,'missing-flight-numbers');
  f.deepLink = 'javascript:alert(1)'; assert.equal(normalizeFlight(f,query).excluded,'invalid-price-or-link');
  const c = clone(connecting.flights[0]); c.deepLink = c.deepLink.replace('-QR832','');
  assert.equal(normalizeFlight(c,{...query,destination:'BKK',returnDate:undefined}).excluded,'incomplete-flight-numbers');
});

// These cases are deliberately synthetic modifications of recorded cards.
// The current MCP schema has no per-sector airport detail for hidden-city cards.
test('hidden city refuses opaque routes and credits only explicitly flown sectors', () => {
  const f = clone(connecting.flights[0]);
  f.attributes.push('hidden-city');
  const q = {...query,destination:'DOH',returnDate:undefined,includeHiddenCity:true};
  assert.equal(normalizeFlight(f,q).excluded,'hidden-city-flown-route-unavailable');
  f.segments = [
    { flightNumber:'QR110', origin:'LHR', destination:'DOH', bookingClass:'T', operatingCarrier:'QR' },
    { flightNumber:'QR832', origin:'DOH', destination:'BKK', bookingClass:'T', operatingCarrier:'QR' },
  ];
  const r = normalizeFlight(f,q).flight;
  assert.equal(r.estimate.tierPoints,Math.floor(distanceMiles('LHR','DOH') * 0.04));
  assert.equal(r.estimate.breakdown.length,1);
  assert.equal(r.estimate.breakdown[0].to,'DOH');
  assert.deepEqual(r.arrival,{airport:'DOH',dateTime:null});
  assert.equal(r.bookedArrival.airport,'BKK');
  assert.equal(r.hiddenCity,true);assert.equal(r.ticketedTo,'BKK');assert.equal(r.leaveAt,'DOH');
  assert.equal(normalizeFlight(f,{...q,includeHiddenCity:false}).excluded,'hidden-city-not-requested');
  // Airport facts also identify hidden-city fares when a provider omits its label.
  f.attributes=[];assert.equal(normalizeFlight(f,q).flight.hiddenCity,true);
  f.segments[1].destination='SIN';
  assert.equal(normalizeFlight(f,q).excluded,'route-does-not-match-search');
  f.segments[1].destination='BKK';
  assert.equal(r.priceGbp,560 * FX.usdToGbp);
  // Revenue estimates allocate spend over the whole ticket, then credit only
  // the flown sector; neither unflown spend nor its cabin extra is earned.
  const revenue=clone(f);
  revenue.deepLink=revenue.deepLink.replace('QR110-QR832','IB110-IB832');
  revenue.segments.forEach((s)=>{s.flightNumber=s.flightNumber.replace('QR','IB');s.operatingCarrier='IB';});
  const earned=normalizeFlight(revenue,{...q,fareClass:'business'}).flight;
  const share=distanceMiles('LHR','DOH')/(distanceMiles('LHR','DOH')+distanceMiles('DOH','BKK'));
  assert.equal(earned.estimate.tierPoints,Math.round(earned.priceGbp*0.7*share)+175);
  assert.equal(earned.estimate.breakdown.length,1);
  assert.equal(rank([earned])[0].gbpPerTierPoint,earned.priceGbp/earned.estimate.tierPoints);
  const roundTrip=clone(search.flights[0]);roundTrip.attributes.push('hidden-city');
  assert.equal(normalizeFlight(roundTrip,{...query,includeHiddenCity:true}).excluded,'hidden-city-return-cannot-be-assumed-flown');
  f.segments[1].flightNumber='EK832'; f.deepLink=f.deepLink.replace('QR832','EK832');
  assert.equal(normalizeFlight(f,q).excluded,'non-earning-or-unknown-flight-number');
});

test('collection years split on 1 April and dated Gold thresholds do not combine years', () => {
  assert.equal(collectionYear('2027-03-31'),'2026-2027');
  assert.equal(collectionYear('2027-04-01'),'2027-2028');
  assert.equal(goldThreshold('2027-03-31'),20000);
  assert.equal(goldThreshold('2027-04-01'),21000);
  const f=clone(search.flights[0]), q={...query,departureDate:'2027-03-31',returnDate:'2027-04-01'};
  f.departure.dateTime='2027-03-31T10:45:00Z'; f.returnFlight.departure.dateTime='2027-04-01T17:20:00+01:00';
  assert.deepEqual(normalizeFlight(f,q).flight.estimate.tierPointsByCollectionYear,{'2026-2027':33,'2027-2028':33});
});

test('ranking uses exact GBP/TP, price ties and null for zero/unavailable earning', () => {
  const r=rank([{id:'expensive',priceGbp:100,estimate:{tierPoints:100}}, {id:'cheap',priceGbp:50,estimate:{tierPoints:50}},
    {id:'zero',priceGbp:1,estimate:{tierPoints:0}}, {id:'unknown',priceGbp:2,estimate:{tierPoints:null}},
    {id:'best',priceGbp:90,estimate:{tierPoints:100}}]);
  assert.deepEqual(r.map(x=>x.id),['best','cheap','expensive','zero','unknown']);
  assert.equal(r[3].gbpPerTierPoint,null);
});

test('input validates real dates, IATA, bounded query options and default origins', () => {
  const base='/api/flights?destination=MAD&departureDate=2026-11-18';
  assert.deepEqual(parseInput(base,NOW).origins,DEFAULT_ORIGINS);
  assert.equal(parseInput(base,NOW).includeHiddenCity,true);
  assert.equal(toolInput(parseInput(base,NOW),'LHR').args.includeHiddenCity,true);
  assert.equal(parseInput(base+'&includeHiddenCity=false',NOW).includeHiddenCity,false);
  assert.deepEqual(parseInput(base.replace('MAD','IBZ'),NOW).origins,DEFAULT_ORIGINS.filter(o=>o!=='IBZ'));
  assert.throws(()=>parseInput(base.replace('MAD','IBZ')+'&origin=IBZ',NOW));
  assert.deepEqual(parseInput(base+'&origin=jfk,ibz',NOW).origins,['JFK','IBZ']);
  for(const suffix of ['&origin=LHR;curl','&limit=101','&limit=0','&offset=100','&includeHiddenCity=1','&airlines=FR','&limit=1&limit=2','&password=x','&returnDate=2026-11-17','&maxStops=0','&fareClass=invalid','&origin=','&action=invalid']) assert.throws(()=>parseInput(base+suffix,NOW),suffix);
  for(const date of ['2026-02-30','2026-11-31','2025-11-18','2028-11-18']) assert.throws(()=>parseInput(base.replace('2026-11-18',date),NOW));
  assert.throws(()=>parseInput('/api/flights?action=flex&origin=LHR&destination=MAD&departureDate=2026-11-18&mode=return',NOW));
});

test('returnDate disables hidden-city inclusion independently in parsing, tool arguments and normalization', () => {
  const base='/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21';
  for(const suffix of ['', '&includeHiddenCity=true', '&includeHiddenCity=false']) {
    const q=parseInput(base+suffix,NOW);
    assert.equal(q.includeHiddenCity,false);
    assert.equal(toolInput(q,'LHR').args.includeHiddenCity,false);
  }
  // Defend a hand-built query as well as parsed HTTP input.
  assert.equal(toolInput({...parseInput(base,NOW),includeHiddenCity:true},'LHR').args.includeHiddenCity,false);
  for(const includeHiddenCity of [true,false]) {
    const q={...query,includeHiddenCity};
    const labeled=clone(search.flights[0]);
    labeled.attributes.push('hidden-city');
    assert.equal(normalizeFlight(labeled,q).excluded,'hidden-city-return-cannot-be-assumed-flown');
    delete labeled.returnFlight;
    assert.equal(normalizeFlight(labeled,q).excluded,'hidden-city-return-cannot-be-assumed-flown');
    const unlabelled=clone(connecting.flights[0]);
    unlabelled.attributes=[];
    assert.equal(normalizeFlight(unlabelled,q).excluded,'hidden-city-return-cannot-be-assumed-flown');
  }
});

test('tool arguments conform to recorded tools/list schema, including preferredAirlines array', () => {
  for(const tail of ['','&action=anywhere','&action=flex','&action=flex&mode=return&returnDate=2026-11-21']) {
    const url=tail.includes('anywhere') ? '/api/flights?departureDate=2026-11-18'+tail : '/api/flights?destination=MAD&departureDate=2026-11-18'+tail;
    const q=parseInput(url,NOW), tool=toolInput(q,'LHR');
    const schema=schemas.find(s=>s.name===tool.name).inputSchema;
    assert(Object.keys(tool.args).every(k=>Object.hasOwn(schema.properties,k)));
    assert(schema.required.every(k=>Object.hasOwn(tool.args,k)));
    for(const [key,val] of Object.entries(tool.args)) {
      const spec=schema.properties[key];
      if(spec.type==='array') assert(Array.isArray(val) && val.every(x=>typeof x==='string'));
      if(spec.enum) assert(spec.enum.includes(val));
    }
  }
});
