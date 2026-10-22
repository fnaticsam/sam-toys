const test = require('node:test'); const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'); const crypto = require('node:crypto');
const controls = require('../../api/_lib/abuse-controls'); const { fakeBlob } = require('./fake-blob');
const london = require('../../api/_lib/londonplan-session');
const PASSWORD = 'test-only-private-password-123';
function call(handler, { method='HEAD',url='/londonplan',body,headers={} }={}) {
  return new Promise((resolve,reject)=>{
    const req=new EventEmitter();Object.assign(req,{method,url,headers});
    const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(value){this.body=value;resolve(this);}};
    Promise.resolve(handler(req,res)).catch(reject);
    process.nextTick(()=>{if(body!==undefined)req.emit('data',Buffer.from(body));req.emit('end');});
  });
}
function post(handler,url,password=PASSWORD) {return call(handler,{method:'POST',url,body:'password='+encodeURIComponent(password),headers:{'content-type':'application/x-www-form-urlencoded','x-real-ip':'192.0.2.7'}});}
function privateResponse(res) {assert.match(res.headers['cache-control'],/no-store/);assert.equal(res.headers['x-frame-options'],'DENY');assert.equal(res.headers['referrer-policy'],'no-referrer');}

test('Londonplan rejects expired, future, tampered, other-surface and legacy tokens',()=>{
  const time=Date.now();const at=t=>`${t}.${london.sign(PASSWORD,t)}`;
  assert(london.tokenIsValid(PASSWORD,at(time)));
  assert(london.tokenIsValid(PASSWORD,at(time-29*86400000)));
  for(const invalid of [at(time-31*86400000),at(time+120000),at(time)+'\n','0'+at(time),at(time).slice(0,-1)+'z',crypto.createHmac('sha256',PASSWORD).update('londonplan-session-v1').digest('hex'),require('../../api/_lib/dev-session').issueToken(PASSWORD),require('../../api/_lib/playa-session').issueToken(PASSWORD)]) assert(!london.tokenIsValid(PASSWORD,invalid));
  assert(!london.tokenIsValid('changed-password',at(time)));
});
test('Londonplan login issues scoped expiring v2 cookie and clears legacy cookie; logout parses exact parameter',async()=>{
  const saved=controls.checkLogin, old=process.env.LONDONPLAN_PASSWORD;process.env.LONDONPLAN_PASSWORD=PASSWORD;
  controls.checkLogin=async()=>{};
  const handler=require('../../api/londonplan');
  try {
    const login=await post(handler,'/londonplan');assert.equal(login.statusCode,303);privateResponse(login);
    assert.equal(login.headers['set-cookie'].length,2);
    const cookie=login.headers['set-cookie'][0];assert.match(cookie,/^lp_session_v2=\d+\.[a-f0-9]{64}; Max-Age=2592000; Path=\/londonplan; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal(login.headers['set-cookie'][1],london.LEGACY_CLEAR);
    const headers={cookie:cookie.split(';')[0]};
    assert.equal((await call(handler,{headers})).statusCode,200);
    assert.equal((await call(handler,{method:'GET',url:'/londonplan?notlogout=1&x=logout=1',headers})).statusCode,200);
    const logout=await call(handler,{method:'GET',url:'/londonplan?logout=1',headers});assert.equal(logout.statusCode,303);privateResponse(logout);assert.match(logout.headers['set-cookie'][0],/Max-Age=0; Path=\/londonplan/);
    const oldToken=crypto.createHmac('sha256',PASSWORD).update('londonplan-session-v1').digest('hex');
    assert.equal((await call(handler,{headers:{cookie:'lp_session='+oldToken}})).statusCode,401);
  } finally {controls.checkLogin=saved;if(old===undefined)delete process.env.LONDONPLAN_PASSWORD;else process.env.LONDONPLAN_PASSWORD=old;}
});
test('every private password endpoint fails closed before issuing cookies and uses durable attempt state',async()=>{
  const saved=controls.checkLogin;
  const old=Object.fromEntries(['DEV_PASSWORD','PLAYA_PASSWORD','LONDONPLAN_PASSWORD','DEV_TRUSTED_IPS','PLAYA_TRUSTED_IPS'].map(k=>[k,process.env[k]]));
  for(const key of ['DEV_PASSWORD','PLAYA_PASSWORD','LONDONPLAN_PASSWORD'])process.env[key]=PASSWORD;
  delete process.env.DEV_TRUSTED_IPS;delete process.env.PLAYA_TRUSTED_IPS;
  const handlers=[['dev',require('../../api/dev')],['playa',require('../../api/playa').createHandler({})],['londonplan',require('../../api/londonplan')]];
  try {
    for(const [surface,handler] of handlers) {
      for(const status of [429,503]) {
        controls.checkLogin=async(_req,name)=>{assert.equal(name,surface);throw Object.assign(new Error('blocked'),{status});};
        const blocked=await post(handler,'/'+surface);assert.equal(blocked.statusCode,status);assert.equal(blocked.headers['set-cookie'],undefined);privateResponse(blocked);
      }
      const store=controls.createControls({client:fakeBlob(),env:{ABUSE_CONTROL_READ_WRITE_TOKEN:'test-only-token',ABUSE_LOGIN_IP_LIMIT:'1'}});
      controls.checkLogin=(req,name)=>store.checkLogin(req,name);
      assert.equal((await post(handler,'/'+surface,'incorrect')).statusCode,401);
      const blocked=await post(handler,'/'+surface);assert.equal(blocked.statusCode,429);assert.equal(blocked.headers['set-cookie'],undefined);
    }
    let checks=0;controls.checkLogin=async()=>{checks++;throw new Error('should not be consulted');};
    for(const [surface,handler] of handlers) {
      const session=surface==='londonplan'?london:require('../../api/_lib/'+surface+'-session');
      await call(handler,{url:'/'+surface,headers:{cookie:session.COOKIE+'='+session.issueToken(PASSWORD)}});
    }
    assert.equal(checks,0);
  } finally {controls.checkLogin=saved;for(const [key,value] of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
