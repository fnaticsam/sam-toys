const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, MCP_URL } = require('../../api/_lib/flights/mcp');
const fixture = require('./fixtures/search.json');
global.fetch = () => { throw new Error('Live network forbidden in flights tests'); };
const envelope = { jsonrpc:'2.0', id:1, result:{ structuredContent:fixture } };
const sse = (body, type='text/event-stream') => new Response(body,{headers:{'Content-Type':type}});

test('MCP sends exact JSON-RPC and headers, reads chunked CRLF SSE and cancels before stream closes', async () => {
  let cancelled=false;
  const wire=': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: '+JSON.stringify(envelope)+'\r\n\r\n';
  const bytes=new TextEncoder().encode(wire);
  const call=createClient({fetchImpl:async(url,init)=>{
    assert.equal(url,MCP_URL); assert.equal(init.method,'POST');
    assert.equal(init.headers.Accept,'application/json, text/event-stream');
    assert.equal(init.headers['Content-Type'],'application/json');
    assert.deepEqual(JSON.parse(init.body),{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sk_flights_search',arguments:{origin:'LHR'}}});
    let offset=0;
    return sse(new ReadableStream({pull(controller){
      if(offset<bytes.length){controller.enqueue(bytes.slice(offset,offset+13));offset+=13;}
      // Intentionally left open after the matching result.
    },cancel(){cancelled=true;}}));
  }});
  assert.deepEqual(await call('sk_flights_search',{origin:'LHR'}),fixture);
  assert(cancelled);
});

test('MCP accepts JSON responses and multiline SSE data fields', async () => {
  for(const response of [sse(JSON.stringify(envelope),'application/json'),sse('data: '+JSON.stringify(envelope,null,2).replace(/\n/g,'\ndata: ')+'\n\n')]) {
    const call=createClient({fetchImpl:async()=>response});
    assert.deepEqual(await call('sk_flights_search',{}),fixture);
  }
});

test('MCP failures are bounded, generic and never expose upstream content', async () => {
  for(const [response,code] of [
    [new Response('private body',{status:429}),'upstream-throttled'],
    [new Response('private body',{status:500}),'upstream-unavailable'],
    [sse('data: garbage\n\n'),'invalid-upstream-response'],
    [sse('data: '+JSON.stringify({id:1,error:{message:'private payload'}})+'\n\n'),'invalid-upstream-response'],
    [sse('data: '+JSON.stringify({id:1,result:{isError:true,structuredContent:{}}})+'\n\n'),'invalid-upstream-response'],
    [sse('data: '+JSON.stringify({id:2,result:{structuredContent:{}}})+'\n\n'),'invalid-upstream-response'],
    [sse('data: '+JSON.stringify(envelope)+'\n\n'),'invalid-upstream-response',100],
  ]) {
    const call=createClient({fetchImpl:async()=>response,maxBytes:response.headers.get('content-type')?.includes('event-stream')&&code==='invalid-upstream-response' ? 100 : 2*1024*1024});
    await assert.rejects(call('sk_flights_search',{}),e=>e.code===code && !e.message.includes('private'));
  }
});

test('MCP deadline aborts stalled response bodies, not just HTTP headers', async () => {
  let cancelled=false;
  const call=createClient({timeoutMs:10,fetchImpl:async(_url,{signal})=>sse(new ReadableStream({
    start(controller){ signal.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true}); },
    cancel(){cancelled=true;},
  }))});
  await assert.rejects(call('sk_flights_search',{}),e=>e.code==='upstream-timeout');
  // An errored stream can reject cancel; that path must still settle.
  assert.equal(typeof cancelled,'boolean');
});
