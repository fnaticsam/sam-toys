const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../../api/flights');
const { UpstreamError } = require('../../api/_lib/flights/mcp');
const fixtures = {search:require('./fixtures/search.json'),anywhere:require('./fixtures/anywhere.json'),flex:require('./fixtures/flex.json')};
global.fetch = () => { throw new Error('Live network forbidden in flights tests'); };
const NOW=Date.parse('2026-10-28T12:00:00Z');
const URL='/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21';
function setup(options={}) {
  const calls=[];
  const handler=createHandler({now:()=>NOW,
    callTool:async(...args)=>{calls.push(args);return fixtures.search;},...options});
  async function call(url=URL,{method='GET',headers={},ip='203.0.113.1'}={}) {
    const req={method,url,headers:{host:'sam.toys','x-forwarded-proto':'https','x-real-ip':ip,...headers}};
    const res={headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(text){this.body=JSON.parse(text);}};
    await handler(req,res);return res;
  }
  return {call,calls};
}
test('open API allows no Origin and same-origin browsers without authentication',async()=>{
  const s=setup();
  for(const headers of [{},{origin:'https://sam.toys'},{authorization:'Bearer ignored'}]) {
    const r=await s.call(URL,{headers});
    assert.equal(r.statusCode,200);
    assert.equal(r.headers['www-authenticate'],undefined);
    assert.match(r.headers['cache-control'],/no-store/);
    assert.match(r.headers['x-robots-tag'],/noindex/);
  }
  assert.equal(s.calls.length,1);
});

test('cross-origin and malformed browser Origins are rejected before provider work',async()=>{
  const s=setup();
  for(const origin of ['https://evil.example','https://sam.toys.evil.example','http://sam.toys',
    'https://sam.toys:444','null','','garbage','https://sam.toys/path','https://user@sam.toys',
    'https://sam.toys https://evil.example',['https://sam.toys']]) {
    const r=await s.call(URL,{headers:{origin}});
    assert.equal(r.statusCode,403,JSON.stringify(origin));
    assert.match(r.headers['x-robots-tag'],/noindex/);
    assert.equal(r.headers['access-control-allow-origin'],undefined);
  }
  assert.equal((await s.call(URL,{headers:{origin:'https://evil.example','x-forwarded-host':'evil.example'}})).statusCode,403);
  assert.equal((await s.call(URL,{headers:{origin:'https://sam.toys',host:undefined}})).statusCode,403);
  assert.equal((await s.call(URL,{headers:{origin:'https://sam.toys',host:'sam.toys/path'}})).statusCode,403);
  assert.equal((await s.call(URL,{headers:{origin:'https://sam.toys','x-forwarded-proto':'https,http'}})).statusCode,403);
  assert.equal(s.calls.length,0);
});

test('same-origin compares the current host, scheme and port, including preview and local hosts',async()=>{
  for(const [host,protocol,origin] of [
    ['preview.vercel.app','https','https://preview.vercel.app'],
    ['sam.toys:443','https','https://sam.toys'],
    ['localhost:80','http','http://localhost'],
    ['localhost:3000','http','http://localhost:3000'],
  ]) {
    const r=await setup().call(URL,{headers:{host,'x-forwarded-proto':protocol,origin}});
    assert.equal(r.statusCode,200);
  }
  // Without a trusted proxy scheme header, derive the scheme from the socket.
  assert.equal((await setup().call(URL,{headers:{origin:'http://sam.toys','x-forwarded-proto':undefined}})).statusCode,200);
});

test('methods and invalid queries set private noindex headers',async()=>{
  const s=setup();
  for(const [url,options,status] of [[URL,{method:'POST'},405],[URL+'&unknown=value',{},400]]) {
    const r=await s.call(url,options);
    assert.equal(r.statusCode,status);assert.match(r.headers['cache-control'],/no-store/);
    assert.match(r.headers['x-robots-tag'],/noindex/);assert.equal(r.headers['x-content-type-options'],'nosniff');
  }
  assert.equal(s.calls.length,0);
});

test('recorded return search produces ranked estimates and passes eligible airline code arrays upstream',async()=>{
  const s=setup(),r=await s.call();
  assert.equal(r.statusCode,200);assert.equal(r.body.partial,false);
  assert.equal(r.body.results.length,6);
  assert.equal(r.body.results.find(f=>f.flightNumbers[0]==='IB714').estimate.tierPoints,66);
  assert(r.body.results.every((f,i,all)=>i===0 || f.gbpPerTierPoint>=all[i-1].gbpPerTierPoint));
  assert.equal(r.body.meta.goldThreshold,20000);
  assert.equal(r.body.meta.discoveryOnly,false);
  const [name,args]=s.calls[0];assert.equal(name,'sk_flights_search');
  assert(Array.isArray(args.preferredAirlines));assert(args.preferredAirlines.includes('EI'));
  assert.equal(args.includeHiddenCity,false);assert.equal(args.includeVirtualInterlining,false);
  assert.equal(args.adults,1);assert.equal(args.returnDate,'2026-11-21');
  assert.equal(r.body.pages[0].hasMoreResults,true);
});

test('all seven default origins fan out with at most three calls in flight',async()=>{
  let active=0,peak=0;const origins=[];
  const s=setup({callTool:async(_name,args)=>{
    active++;peak=Math.max(peak,active);origins.push(args.origin);
    await new Promise(resolve=>setImmediate(resolve));active--;
    return {flights:[],pagination:{totalAvailable:0,hasMoreResults:false}};
  }});
  const r=await s.call(URL.replace('origin=LHR&',''));
  assert.equal(r.statusCode,200);assert.equal(peak,3);
  assert.deepEqual(origins,['LHR','LGW','LCY','STN','LTN','SEN','IBZ']);
  assert.equal(r.body.pages.length,7);
});

test('anywhere and both calendar tools return unverified discovery, never a fabricated TP ranking',async()=>{
  for(const [url,kind,name] of [
    ['/api/flights?action=anywhere&origin=IBZ&departureDate=2026-11-18','anywhere','sk_destinations_anywhere'],
    ['/api/flights?action=flex&origin=LHR&destination=MAD&departureDate=2026-11-18','flex','sk_flex_departure_calendar'],
    ['/api/flights?action=flex&mode=return&origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21','flex','sk_flex_return_calendar'],
  ]) {
    let called;
    const s=setup({callTool:async(tool)=>{called=tool;return fixtures[kind];}}),r=await s.call(url);
    assert.equal(called,name);assert.equal(r.statusCode,200);assert(r.body.results.length>0);
    assert.equal(r.body.meta.discoveryOnly,true);assert.equal(r.body.meta.ranking,null);
    for(const row of r.body.results){assert.equal(row.eligibility,'unverified');assert.equal(row.estimate,null);assert.equal(row.requiresSearch,true);}
  }
});

test('throttle is bounded per IP, expires under controlled clock and survives malformed requests',async()=>{
  let time=NOW;
  const s=setup({now:()=>time,throttleOptions:{max:2,capacity:2}});
  assert.equal((await s.call(URL+'&limit=999')).statusCode,400);
  assert.equal((await s.call()).statusCode,200);
  const limited=await s.call();assert.equal(limited.statusCode,429);assert.equal(limited.headers['retry-after'],'60');assert.match(limited.headers['x-robots-tag'],/noindex/);
  assert.equal((await s.call(URL,{ip:'203.0.113.2'})).statusCode,200);
  assert.equal((await s.call(URL,{ip:'203.0.113.3'})).statusCode,429);
  time+=60001;assert.equal((await s.call()).statusCode,200);
  // x-forwarded-for never chooses the bucket.
  assert.equal((await s.call(URL,{headers:{'x-forwarded-for':'198.51.100.1'}})).statusCode,200);
  assert.equal((await s.call(URL,{headers:{'x-forwarded-for':'198.51.100.2'}})).statusCode,429);
});

test('return calendar date sort uses return dates when departure is fixed',async()=>{
  const data=structuredClone(fixtures.flex);
  data.chart.points=[{departure:'2026-11-18',return:'2026-11-23',price:1},
    {departure:'2026-11-18',return:'2026-11-21',price:100}];
  const s=setup({callTool:async()=>data});
  const r=await s.call('/api/flights?action=flex&mode=return&origin=LHR&destination=MAD&departureDate=2026-11-18&returnDate=2026-11-21');
  assert.deepEqual(r.body.results.map(p=>p.returnDate),['2026-11-21','2026-11-23']);
});

test('partial origin failures are explicit and total failures/timeout never leak provider errors',async()=>{
  const s=setup({callTool:async(_name,args)=>{if(args.origin==='LGW')throw new Error('private payload');return fixtures.search;}});
  const r=await s.call(URL.replace('origin=LHR','origin=LHR,LGW'));
  assert.equal(r.statusCode,200);assert.equal(r.body.partial,true);
  assert.equal(r.body.failures[0].origin,'LGW');assert(!JSON.stringify(r.body).includes('private payload'));
  for(const [code,status] of [['upstream-throttled',502],['upstream-timeout',504]]) {
    const r=await setup({callTool:async()=>{throw new UpstreamError(code);}}).call();
    assert.equal(r.statusCode,status);assert.match(r.headers['x-robots-tag'],/noindex/);
  }
});

test('overall deadline aborts upstream work and returns 504',async()=>{
  let observed=false;
  const s=setup({requestTimeoutMs:10,callTool:async(_name,_args,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>{observed=true;reject(new UpstreamError('upstream-timeout'));},{once:true});
  })});
  const r=await s.call();assert.equal(r.statusCode,504);assert(observed);
  assert.match(r.headers['x-robots-tag'],/noindex/);
});

test('process concurrency cap rejects excess work and releases after completion',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const s=setup({maxConcurrentRequests:1,callTool:async()=>{await pending;return fixtures.search;}});
  const first=s.call();
  assert.equal((await s.call(URL,{ip:'203.0.113.2'})).statusCode,429);
  release();assert.equal((await first).statusCode,200);
  assert.equal((await s.call()).statusCode,200);
});


test('cache shares normalised queries across IPs and expires at exactly ten minutes',async()=>{
  let time=NOW;
  const s=setup({now:()=>time,throttleOptions:{max:20}});
  const first=await s.call();
  const equivalent='/api/flights?returnDate=2026-11-21&departureDate=2026-11-18&destination=mad&origin=lhr&action=search&fareClass=economy&limit=025&offset=0&maxStops=many&includeHiddenCity=true';
  time+=599999;
  const cached=await s.call(equivalent,{ip:'203.0.113.2'});
  assert.deepEqual(cached.body,first.body);assert.equal(s.calls.length,1);
  assert.match(cached.headers['x-robots-tag'],/noindex/);
  time++;
  assert.equal((await s.call()).statusCode,200);assert.equal(s.calls.length,2);
});

test('cache normalises origin and airline sets but separates materially different queries',async()=>{
  const s=setup({throttleOptions:{max:20}});
  await s.call(URL.replace('origin=LHR','origin=LHR,LGW')+'&airlines=BA,IB');
  await s.call(URL.replace('origin=LHR','origin=lgw,lhr,lhr')+'&airlines=ib,ba,ib');
  assert.equal(s.calls.length,2);
  for(const suffix of ['&includeHiddenCity=false','&limit=10','&offset=1','&fareClass=business','&maxStops=none','&airlines=BA']) await s.call(URL+suffix);
  await s.call(URL.replace('2026-11-18','2026-11-19'));
  assert.equal(s.calls.length,9);
});

test('bounded cache evicts the oldest insertion even when it was recently read',async()=>{
  const s=setup({cacheOptions:{capacity:2},throttleOptions:{max:20}});
  await s.call(); await s.call(URL+'&offset=1'); await s.call();
  assert.equal(s.calls.length,2);
  await s.call(URL+'&offset=2');
  await s.call(URL+'&offset=1');
  assert.equal(s.calls.length,3);
  await s.call();assert.equal(s.calls.length,4);
});

test('cache hits still enforce Origin, validation and the default five-per-minute IP throttle',async()=>{
  const s=setup();
  for(let i=0;i<5;i++) assert.equal((await s.call()).statusCode,200);
  const limited=await s.call();assert.equal(limited.statusCode,429);assert.equal(limited.headers['retry-after'],'60');
  assert.equal((await s.call(URL,{headers:{origin:'https://evil.example'}})).statusCode,403);
  assert.equal((await s.call(URL+'&limit=999',{ip:'203.0.113.2'})).statusCode,400);
  assert.equal(s.calls.length,1);
});

test('errors and partial responses are retried rather than cached; empty successes are cached',async()=>{
  let calls=0;
  const s=setup({callTool:async(_name,args)=>{
    calls++;
    if(args.origin==='LGW' || calls===1) throw new UpstreamError();
    return {flights:[],pagination:{totalAvailable:0,hasMoreResults:false}};
  },throttleOptions:{max:20}});
  assert.equal((await s.call()).statusCode,502);
  assert.equal((await s.call()).statusCode,200);
  await s.call();assert.equal(calls,2);
  const multi=URL.replace('origin=LHR','origin=LHR,LGW');
  assert.equal((await s.call(multi)).body.partial,true);
  await s.call(multi);assert.equal(calls,6);
});

test('discovery responses are cached independently for each action and calendar mode',async()=>{
  let calls=0;
  const s=setup({throttleOptions:{max:20},callTool:async(name)=>{
    calls++;return name==='sk_destinations_anywhere' ? fixtures.anywhere : fixtures.flex;
  }});
  for(const url of [
    '/api/flights?action=anywhere&origin=IBZ&departureDate=2026-11-18',
    URL+'&action=flex',URL+'&action=flex&mode=return',
  ]) { await s.call(url);await s.call(url); }
  assert.equal(calls,3);
});

test('hidden-city fares default on, keep endpoint facts and rank normally with flown-sector earning',async()=>{
  // Synthetic variants of the recorded connection; no claim of a live quote.
  const hidden=structuredClone(require('./fixtures/connecting.json').flights[0]);
  hidden.attributes.push('hidden-city');
  hidden.segments=[
    {flightNumber:'QR110',origin:'LHR',destination:'DOH',bookingClass:'T',operatingCarrier:'QR'},
    {flightNumber:'QR832',origin:'DOH',destination:'BKK',bookingClass:'T',operatingCarrier:'QR'},
  ];
  const standard=structuredClone(hidden);
  standard.id='standard';standard.attributes=[];standard.deepLink=standard.deepLink.replace('-QR832','');
  standard.arrival={airport:'DOH',dateTime:'2026-11-18T18:00:00Z'};
  standard.segments=standard.segments.slice(0,1);standard.price.amount=1000;
  const s=setup({callTool:async()=>({flights:[standard,hidden]})});
  const url='/api/flights?origin=LHR&destination=DOH&departureDate=2026-11-18';
  const r=await s.call(url);
  assert.equal(r.statusCode,200);
  assert.deepEqual(r.body.results.map(f=>f.hiddenCity),[true,false]);
  const row=r.body.results[0];
  assert.equal(row.ticketedTo,'BKK');assert.equal(row.leaveAt,'DOH');
  assert.equal(row.estimate.breakdown.length,1);assert.equal(row.estimate.breakdown[0].to,'DOH');
  const optedOut=await s.call(url+'&includeHiddenCity=false');
  assert.equal(optedOut.body.results.length,1);assert.equal(optedOut.body.results[0].hiddenCity,false);
});

test('return searches force hidden-city off and reject provider hidden-city cards with or without a return leg',async()=>{
  const labeled=structuredClone(fixtures.search.flights[0]);
  labeled.attributes.push('hidden-city');
  const missingReturn=structuredClone(labeled);
  delete missingReturn.returnFlight;
  const unlabelled=structuredClone(require('./fixtures/connecting.json').flights[0]);
  unlabelled.attributes=[];
  const calls=[];
  const s=setup({callTool:async(name,args)=>{
    calls.push([name,args]);
    return {flights:[...fixtures.search.flights,labeled,missingReturn,unlabelled]};
  }});
  for(const suffix of ['', '&includeHiddenCity=true', '&includeHiddenCity=false']) {
    const r=await s.call(URL+suffix);
    assert.equal(r.statusCode,200);
    assert.equal(r.body.results.length,6);
    assert(r.body.results.every(f=>f.hiddenCity===false && f.returnFlight));
    assert.equal(r.body.excluded['hidden-city-return-cannot-be-assumed-flown'],3);
  }
  // All three spellings have the same effective policy and share a cache entry.
  assert.equal(calls.length,1);
  assert.equal(calls[0][1].includeHiddenCity,false);
});
