const test = require('node:test'); const assert = require('node:assert/strict');
const controls = require('../../api/_lib/abuse-controls');
const { createControls } = controls; const { fakeBlob } = require('./fake-blob');
function res() { return { statusCode: 200, headers: {}, setHeader(k,v){this.headers[k]=v;}, status(n){this.statusCode=n;return this;}, json(value){this.value=value;return this;} }; }
function request(body) { return { method:'POST', headers:{ 'content-type':'application/json','x-real-ip':'192.0.2.1' }, body }; }
function fresh(file) { const p = require.resolve('../../api/'+file); delete require.cache[p]; return require(p); }
const audio={audio:Buffer.from('OggS synthetic').toString('base64')};
const image={images:[{data:Buffer.from([0x89,0x50,0x4e,0x47,0,0]).toString('base64')}]};

test('public API invalid JSON getters consistently return application JSON 400', async () => {
  for(const file of ['transcribe.js','tracks-ocr.js','tracks-playlist.js']) {
    const req=request(null); Object.defineProperty(req,'body',{get(){throw new Error('invalid JSON');}});
    const out=res(); await fresh(file)(req,out); assert.equal(out.statusCode,400); assert.equal(typeof out.value.error,'string');
  }
});
test('both public paid handlers require durable reservation, cap model output, and release leases on failure', async () => {
  const oldFetch=global.fetch, oldReserve=controls.reservePaid, oldKey=process.env.GEMINI_API_KEY, oldError=console.error;
  let calls=0, releases=0, payload; process.env.GEMINI_API_KEY='synthetic-key'; console.error=()=>{};
  try {
    for(const [file,body] of [['transcribe.js',audio],['tracks-ocr.js',image]]) {
      controls.reservePaid=async()=>{throw new Error('must reject hostile origin before reservation');};
      const hostile=request(body); hostile.headers.origin='https://untrusted.invalid'; const rejected=res();
      await fresh(file)(hostile,rejected); assert.equal(rejected.statusCode,403);
      global.fetch=async(_url,options)=>{calls++;payload=JSON.parse(options.body);return {ok:false,status:500};};
      for(const status of [429,503]) {
        controls.reservePaid=async()=>{throw Object.assign(new Error('denied'),{status});};
        const out=res(), before=calls; await fresh(file)(request(body),out);
        assert.equal(out.statusCode,status); assert.equal(calls,before);
      }
      controls.reservePaid=async()=>({release:async()=>{releases++;}});
      const out=res(); await fresh(file)(request(body),out); assert.equal(out.statusCode,502); assert.equal(payload.generationConfig.maxOutputTokens,8192);
    }
    assert.equal(releases,2); assert.equal(calls,2);
  } finally { global.fetch=oldFetch; controls.reservePaid=oldReserve; console.error=oldError; if(oldKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey; }
});
test('a new handler instance cannot bypass durable quota when Origin is omitted', async () => {
  const oldFetch=global.fetch, oldReserve=controls.reservePaid, oldKey=process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY='synthetic-key'; let calls=0;
  const store=createControls({client:fakeBlob(),env:{ABUSE_CONTROL_READ_WRITE_TOKEN:'synthetic',ABUSE_PAID_IP_DAILY_LIMIT:'1'}});
  controls.reservePaid=req=>store.reservePaid(req);
  global.fetch=async()=>{calls++;return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"transcript":"synthetic","bullets":[]}'}]}}]})};};
  try { const first=res(),second=res(); await fresh('transcribe.js')(request(audio),first); await fresh('transcribe.js')(request(audio),second); assert.equal(first.statusCode,200);assert.equal(second.statusCode,429);assert.equal(calls,1); }
  finally {global.fetch=oldFetch;controls.reservePaid=oldReserve;if(oldKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldKey;}
});
