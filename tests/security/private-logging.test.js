const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

test('Ask reserves only after auth and never logs model, guide or upstream payloads on failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-toys-ask-test-'));
  fs.mkdirSync(path.join(dir,'api/_lib'),{recursive:true});
  for(const file of ['api/dev-ask.js','api/_lib/dev-session.js','api/_lib/abuse-controls.js']) fs.copyFileSync(path.join(__dirname,'../..',file),path.join(dir,file));
  const marker='SYNTHETIC_PRIVATE_MARKER';
  fs.writeFileSync(path.join(dir,'api/_lib/dev.html'),Array.from({length:34},(_,i)=>`<section id="s${i}"><h3>Synthetic ${i}</h3><p>${marker}</p></section>`).join(''));
  const oldError=console.error,oldFetch=global.fetch, oldPassword=process.env.DEV_PASSWORD,oldKey=process.env.GEMINI_API_KEY,oldIps=process.env.DEV_TRUSTED_IPS;
  const logged=[];console.error=(...args)=>logged.push(args.join(' '));
  process.env.DEV_PASSWORD='synthetic-password';process.env.GEMINI_API_KEY='synthetic-key';delete process.env.DEV_TRUSTED_IPS;
  let calls=0,reservations=0,releases=0;
  const controls=require(path.join(dir,'api/_lib/abuse-controls'));
  controls.reservePaid=async()=>{reservations++;return{release:async()=>{releases++;}};};
  const handler=require(path.join(dir,'api/dev-ask'));
  const {issueToken}=require(path.join(dir,'api/_lib/dev-session'));
  async function call(auth=true) {
    const req={method:'POST',headers:{'content-type':'application/json',...(auth?{cookie:'dev_session='+issueToken(process.env.DEV_PASSWORD)}:{})},body:{q:'Read a synthetic section'}};
    const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=JSON.parse(value);}};
    await handler(req,res);return res;
  }
  try {
    global.fetch=async()=>{calls++;throw new Error('should not call');};
    assert.equal((await call(false)).statusCode,401);assert.equal(reservations,0);assert.equal(calls,0);
    for(const provider of [
      async()=>({ok:false,status:500,text:async()=>marker}),
      async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:marker}]}}]})}),
      async()=>({ok:true,json:async()=>({privateResponse:marker})}),
      async()=>{throw new Error(marker);},
    ]) {
      global.fetch=async()=>{calls++;return provider();};
      const result=await call();assert.equal(result.statusCode,502);assert(!JSON.stringify(result.body).includes(marker));
    }
    assert.equal(reservations,4);assert.equal(releases,4);assert.equal(calls,4);
    assert(!logged.join(' ').includes(marker));assert(!logged.join(' ').includes('synthetic-key'));assert(logged.length>=4);
    controls.reservePaid=async()=>{throw Object.assign(new Error('control failure'),{status:503});};
    assert.equal((await call()).statusCode,503);assert.equal(calls,4);
  } finally {
    console.error=oldError;global.fetch=oldFetch;
    for(const [key,value] of [['DEV_PASSWORD',oldPassword],['GEMINI_API_KEY',oldKey],['DEV_TRUSTED_IPS',oldIps]]) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
