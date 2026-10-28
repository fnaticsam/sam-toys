const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { randomBytes, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const jose = createRequire(require.resolve('../../api/_lib/samid/package.json'))('jose');
const { createAuthHandlers } = require('../../api/_lib/flights-auth');
const { requireSamSession, SamSessionRequiredError, FlightsAuthConfigError,
  SESSION_COOKIE, SESSION_TTL_SECONDS } = require('../../api/_lib/flights-session');

let issuer, server, env, key, publicJwk, wrongKey;
let tokenRequests = 0;
const codes = new Map();
const random = () => randomBytes(32).toString('base64url');
const sha = (value) => createHash('sha256').update(value).digest('base64url');
const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

before(async () => {
  const pair = await jose.generateKeyPair('ES256');
  key = pair.privateKey;
  wrongKey = (await jose.generateKeyPair('ES256')).privateKey;
  publicJwk = { ...await jose.exportJWK(pair.publicKey), kid: 'test-es256', alg: 'ES256', use: 'sig' };
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer);
      if (req.method === 'GET' && url.pathname === '/jwks.json') return send(res, 200, { keys: [publicJwk] });
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const p = url.searchParams;
        if (p.get('response_type') !== 'code' || p.get('client_id') !== env.SAM_ID_CLIENT_ID ||
            p.get('redirect_uri') !== env.FLIGHTS_REDIRECT_URI || p.get('code_challenge_method') !== 'S256' ||
            !['state', 'nonce', 'code_challenge'].every((name) => /^[\w-]{43}$/.test(p.get(name)))) {
          return send(res, 400, { error: 'invalid_request' });
        }
        const code = random();
        codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'),
          redirect: p.get('redirect_uri'), until: Date.now() + 60000 });
        const callback = new URL(p.get('redirect_uri'));
        callback.search = new URLSearchParams({ code, state: p.get('state') });
        res.writeHead(302, { Location: callback.href });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        tokenRequests++;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const p = new URLSearchParams(Buffer.concat(chunks).toString());
        const transaction = codes.get(p.get('code'));
        // Atomic consume before any asynchronous signing work.
        codes.delete(p.get('code'));
        const encode = (value) => new URLSearchParams({ v: value }).toString().slice(2);
        const basic = Buffer.from(`${encode(env.SAM_ID_CLIENT_ID)}:${encode(env.SAM_ID_CLIENT_SECRET)}`).toString('base64');
        if (!transaction || req.headers.authorization !== `Basic ${basic}` || transaction.until <= Date.now() ||
            p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== transaction.redirect ||
            sha(p.get('code_verifier') || '') !== transaction.challenge) return send(res, 400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: issuer, sub: 'sam', aud: env.SAM_ID_CLIENT_ID,
          iat: now, exp: now + 300, auth_time: now, amr: ['webauthn'], email: 'owner@example.test',
          nonce: transaction.nonce, ...transaction.claims };
        const idToken = await new jose.SignJWT(claims).setProtectedHeader(
          transaction.header || { alg: 'ES256', kid: publicJwk.kid },
        ).sign(transaction.wrongKey ? wrongKey : key);
        return send(res, 200, { id_token: idToken, token_type: 'Bearer', expires_in: 300 });
      }
      send(res, 404, { error: 'not_found' });
    } catch { send(res, 500, { error: 'fake_issuer_failed' }); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  issuer = `http://127.0.0.1:${server.address().port}`;
  env = { SAM_ID_ISSUER: issuer, SAM_ID_CLIENT_ID: 'sam-toys-flights',
    SAM_ID_CLIENT_SECRET: random(), FLIGHTS_SESSION_SECRET: random(),
    FLIGHTS_REDIRECT_URI: 'https://sam.toys/flights/callback' };
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });

function handlers(options = {}) {
  return createAuthHandlers({ env, ...options });
}
async function invoke(handler, url, { method = 'GET', headers = {} } = {}) {
  const req = { method, url, headers: { host: 'sam.toys', 'x-forwarded-proto': 'https', ...headers } };
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    end(body) { this.text = body || ''; this.body = body ? JSON.parse(body) : undefined; },
  };
  await handler(req, res);
  assert.match(res.headers['cache-control'], /private.*no-store/);
  assert.equal(res.headers['vercel-cdn-cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  return res;
}
const pairs = (res) => (res.headers['set-cookie'] || []).map((cookie) => cookie.split(';')[0]);
const transactionHeader = (res) => pairs(res).join('; ');
function sessionHeader(res) {
  const sessions = pairs(res).filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0], sessions[1]);
  return sessions[0];
}
function assertCleared(res, count = 3) {
  const cookies = res.headers['set-cookie'];
  assert.equal(cookies.length, count);
  for (const cookie of cookies) {
    assert.match(cookie, /Max-Age=0;/);
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
  }
}
async function begin(h = handlers()) {
  const start = await invoke(h.login, '/flights/login?returnTo=https://evil.example');
  assert.equal(start.statusCode, 303);
  const authorize = await fetch(start.headers.location, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const callback = new URL(authorize.headers.get('location'));
  return { h, start, callback, url: callback.pathname + callback.search, cookies: transactionHeader(start),
    transaction: codes.get(callback.searchParams.get('code')) };
}
const finish = (flow, options = {}) => invoke(flow.h.callback, flow.url, { headers: { cookie: flow.cookies }, ...options });

test('happy path: S256 + ES256 creates two scoped 12-hour cookies and a private /me response', async () => {
  const flow = await begin();
  const authorize = new URL(flow.start.headers.location);
  const startCookies = flow.start.headers['set-cookie'];
  assert.equal(startCookies.length, 3);
  for (const cookie of startCookies) {
    assert.match(cookie, /Path=\/flights\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    assert.doesNotMatch(cookie, /Domain=/);
  }
  const verifier = pairs(flow.start).find((cookie) => cookie.startsWith('samid-verifier=')).split('=')[1];
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('code_challenge'), sha(verifier));
  assert.equal(authorize.searchParams.has('client_secret'), false);
  assert.equal(authorize.searchParams.has('code_verifier'), false);
  const result = await finish(flow);
  assert.equal(result.statusCode, 303);
  assert.equal(result.headers.location, '/flights');
  assert.equal(result.headers['set-cookie'].length, 5);
  const cookie = sessionHeader(result);
  const sessions = result.headers['set-cookie'].slice(3);
  for (const [index, path] of ['/flights', '/api/flights-account'].entries()) {
    assert(sessions[index].includes(`; Path=${path}; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`));
    assert.doesNotMatch(sessions[index], /Domain=/);
  }
  assertCleared({ headers: { 'set-cookie': result.headers['set-cookie'].slice(0, 3) } });
  assert.deepEqual(requireSamSession({ headers: { cookie } }, { env }), { sub: 'sam', name: 'Sam' });
  const me = await invoke(flow.h.me, '/api/flights-account/me', { headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.body, { signedIn: true, name: 'Sam' });
  assert.doesNotMatch(JSON.stringify(me), /owner@example|id_token|client_secret/);
});

test('anonymous /me is signedOut and the account helper requires authentication', async () => {
  const response = await invoke(handlers().me, '/api/flights-account/me');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { signedIn: false });
  assert.throws(() => requireSamSession({ headers: {} }, { env }), SamSessionRequiredError);
});

test('bad/missing/duplicate state, missing cookies and provider errors fail before code exchange and clear all transaction cookies', async () => {
  const flow = await begin();
  const before = tokenRequests;
  const cases = [
    [flow.url.replace(/state=[^&]+/, `state=${random()}`), flow.cookies],
    [flow.url.replace(/&state=[^&]+/, ''), flow.cookies],
    [flow.url + `&state=${flow.callback.searchParams.get('state')}`, flow.cookies],
    [flow.url + '&code=duplicate', flow.cookies],
    [flow.url + '&error=access_denied', flow.cookies],
    [flow.url, ''],
    [flow.url, flow.cookies + '; ' + pairs(flow.start)[0]],
  ];
  for (const [url, cookie] of cases) {
    const res = await invoke(flow.h.callback, url, { headers: { cookie } });
    assert.equal(res.statusCode, 400);
    assertCleared(res);
    assert.equal(res.headers.location, undefined);
  }
  assert.equal(tokenRequests, before);
});

test('replayed and expired codes cannot mint a session, even with copied pre-login cookies', async () => {
  const flow = await begin();
  assert.equal((await finish(flow)).statusCode, 303);
  const replay = await finish(flow);
  assert.equal(replay.statusCode, 400);
  assertCleared(replay);
  const expired = await begin();
  expired.transaction.until = Date.now() - 1;
  const result = await finish(expired);
  assert.equal(result.statusCode, 400);
  assertCleared(result);
});

test('concurrent code redemption has only one winner', async () => {
  const flow = await begin();
  const results = await Promise.all([finish(flow), finish(flow)]);
  assert.deepEqual(results.map((res) => res.statusCode).sort(), [303, 400]);
  assertCleared(results.find((res) => res.statusCode === 400));
});

test('separate browsers retain request-local transactions and a crossed callback fails', async () => {
  const h = handlers();
  const [a, b] = await Promise.all([begin(h), begin(h)]);
  assert.notEqual(a.cookies, b.cookies);
  const crossed = await finish(a, { headers: { cookie: b.cookies } });
  assert.equal(crossed.statusCode, 400);
  assertCleared(crossed);
  const results = await Promise.all([finish(a), finish(b)]);
  assert(results.every((res) => res.statusCode === 303));
});

test('PKCE mismatch and incorrect client authentication cannot mint a session', async () => {
  const pkce = await begin();
  pkce.cookies = pkce.cookies.replace(/samid-verifier=[^;]+/, `samid-verifier=${random()}`);
  const pkceResult = await finish(pkce);
  assert.equal(pkceResult.statusCode, 400);
  assertCleared(pkceResult);
  const badClient = await begin(handlers({ env: { ...env, SAM_ID_CLIENT_SECRET: random() } }));
  const clientResult = await finish(badClient);
  assert.equal(clientResult.statusCode, 400);
  assertCleared(clientResult);
});

test('invalid signed ID-token claims, signing key and missing kid are rejected', async (t) => {
  const past = Math.floor(Date.now() / 1000) - 600;
  const cases = {
    nonce: { claims: { nonce: random() } },
    issuer: { claims: { iss: 'https://other.example' } },
    audience: { claims: { aud: 'another-client' } },
    subject: { claims: { sub: 'another-user' } },
    authentication: { claims: { amr: ['pwd'] } },
    expired: { claims: { iat: past, exp: past + 300, auth_time: past } },
    lifetime: { claims: { exp: Math.floor(Date.now() / 1000) + 86400 } },
    future: { claims: { iat: past + 1200, exp: past + 1500, auth_time: past + 1200 } },
    azp: { claims: { azp: 'another-client' } },
    multipleAudiences: { claims: { aud: [env.SAM_ID_CLIENT_ID, 'another-client'] } },
    missingKid: { header: { alg: 'ES256' } },
    forged: { wrongKey: true },
  };
  for (const [name, changes] of Object.entries(cases)) await t.test(name, async () => {
    const flow = await begin();
    Object.assign(flow.transaction, changes);
    const result = await finish(flow);
    assert.equal(result.statusCode, 400);
    assertCleared(result);
  });
});

test('expired, forged, malformed, duplicate and wrong-purpose session cookies fail closed', async () => {
  let now = Date.now();
  const flow = await begin(handlers({ now: () => now }));
  const cookie = sessionHeader(await finish(flow));
  const [, body] = cookie.slice(cookie.indexOf('=') + 1).split('.');
  const changedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), name: 'Attacker' })).toString('base64url');
  const variants = [
    cookie.replace(body, changedBody), cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A'),
    `${SESSION_COOKIE}=v1.bad.cookie`, `${SESSION_COOKIE}=`, `${cookie}; ${cookie}`,
    cookie.replace('v1.', 'v2.'), `${SESSION_COOKIE}=${'x'.repeat(3000)}`,
  ];
  for (const invalid of variants) {
    assert.throws(() => requireSamSession({ headers: { cookie: invalid } }, { env }), SamSessionRequiredError);
    const result = await invoke(flow.h.me, '/api/flights-account/me', { headers: { cookie: invalid } });
    assert.deepEqual(result.body, { signedIn: false });
  }
  // Exact 12-hour server expiry; browser Max-Age is not the authority.
  now += SESSION_TTL_SECONDS * 1000;
  const expired = await invoke(flow.h.me, '/api/flights-account/me', { headers: { cookie } });
  assert.deepEqual(expired.body, { signedIn: false });
  assert.throws(() => requireSamSession({ headers: { cookie } }, { env, now: () => now }), SamSessionRequiredError);
});

test('session is bound to issuer, client and signing secret, and future issuance is refused', async () => {
  const flow = await begin();
  const cookie = sessionHeader(await finish(flow));
  for (const changes of [{ SAM_ID_ISSUER: 'https://another.example' },
    { SAM_ID_CLIENT_ID: 'different-client' }, { FLIGHTS_SESSION_SECRET: random() }]) {
    assert.throws(() => requireSamSession({ headers: { cookie } }, { env: { ...env, ...changes } }), SamSessionRequiredError);
  }
  assert.throws(() => requireSamSession({ headers: { cookie } }, { env, now: () => Date.now() - 60000 }), SamSessionRequiredError);
});

test('logout is POST with an exact same-origin Origin, clears both scopes and redirects safely', async () => {
  const h = handlers();
  const get = await invoke(h.logout, '/flights/logout');
  assert.equal(get.statusCode, 405);
  assert.equal(get.headers.allow, 'POST');
  for (const origin of [undefined, '', 'null', 'https://evil.example', 'https://sam.toys.evil.example',
    'http://sam.toys', 'https://sam.toys/path', ['https://sam.toys']]) {
    const res = await invoke(h.logout, '/flights/logout', { method: 'POST', headers: { origin } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  const crossSite = await invoke(h.logout, '/flights/logout', { method: 'POST',
    headers: { origin: 'https://sam.toys', 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.statusCode, 403);
  const success = await invoke(h.logout, '/flights/logout?returnTo=https://evil.example', {
    method: 'POST', headers: { origin: 'https://sam.toys', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(success.statusCode, 303);
  assert.equal(success.headers.location, '/flights');
  assertCleared(success, 5);
  const deleted = success.headers['set-cookie'];
  assert(deleted.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && cookie.includes('Path=/flights;')));
  assert(deleted.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && cookie.includes('Path=/api/flights-account;')));
});

test('missing or empty required environment fails closed for every route and the account helper', async () => {
  const before = tokenRequests;
  for (const name of ['SAM_ID_ISSUER', 'SAM_ID_CLIENT_ID', 'SAM_ID_CLIENT_SECRET', 'FLIGHTS_SESSION_SECRET', 'FLIGHTS_REDIRECT_URI']) {
    for (const value of [undefined, '']) {
      const incomplete = { ...env, [name]: value }, h = handlers({ env: incomplete });
      for (const [route, path, method] of [['login', '/flights/login', 'GET'], ['callback', '/flights/callback', 'GET'],
        ['logout', '/flights/logout', 'POST'], ['me', '/api/flights-account/me', 'GET']]) {
        const res = await invoke(h[route], path, { method, headers: { origin: 'https://sam.toys' } });
        assert.equal(res.statusCode, 503, `${route} with missing ${name}`);
        assert.equal(res.headers.location, undefined);
        assert.equal(res.headers['set-cookie'], undefined);
        assert.deepEqual(res.body, { error: 'Flights sign-in is unavailable.' });
      }
      assert.throws(() => requireSamSession({ headers: {} }, { env: incomplete }), FlightsAuthConfigError);
    }
  }
  assert.equal(tokenRequests, before);
});

test('malformed/insecure configuration and short session keys fail closed without reflecting details', async () => {
  for (const changes of [
    { SAM_ID_ISSUER: 'https://id.example/' }, { SAM_ID_ISSUER: 'https://user:password@id.example' },
    { SAM_ID_ISSUER: 'https://id.example/path' }, { SAM_ID_ISSUER: 'http://id.example' },
    { FLIGHTS_REDIRECT_URI: 'https://sam.toys/evil' }, { FLIGHTS_REDIRECT_URI: 'https://sam.toys/flights/callback?x=1' },
    { FLIGHTS_REDIRECT_URI: 'http://sam.toys/flights/callback' }, { FLIGHTS_SESSION_SECRET: 'too-short' },
    { NODE_ENV: 'production' }, { VERCEL: '1' },
  ]) {
    const result = await invoke(handlers({ env: { ...env, ...changes } }).login, '/flights/login');
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { error: 'Flights sign-in is unavailable.' });
  }
});

test('all endpoint methods are explicit; forged hosts, schemes and callback destinations are refused', async () => {
  const h = handlers();
  for (const [route, url, method, allowed] of [
    ['login', '/flights/login', 'POST', 'GET'], ['callback', '/flights/callback', 'POST', 'GET'],
    ['me', '/api/flights-account/me', 'POST', 'GET'], ['logout', '/flights/logout', 'GET', 'POST'],
  ]) {
    const result = await invoke(h[route], url, { method });
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.allow, allowed);
  }
  const flow = await begin(h);
  for (const changes of [{ host: 'evil.example' }, { host: undefined }, { host: 'sam.toys/path' },
    { 'x-forwarded-proto': 'https,http' }, { 'x-forwarded-proto': 'http' }]) {
    const result = await invoke(h.callback, flow.url, { headers: { cookie: flow.cookies, ...changes } });
    assert.equal(result.statusCode, 400);
    assertCleared(result);
  }
  for (const url of [flow.url.replace('/flights/callback', '/api/flights-callback'), `https://evil.example${flow.url}`]) {
    const result = await invoke(h.callback, url, { headers: { cookie: flow.cookies } });
    assert.equal(result.statusCode, 400);
    assertCleared(result);
  }
});

test('issuer network failure gives a generic response, clears transactions and has a deadline with redirects refused', async () => {
  let options;
  const h = handlers({ fetch: async (_url, supplied) => { options = supplied; throw new Error('private provider diagnostic'); } });
  const flow = await begin(h);
  const result = await finish(flow);
  assert.equal(result.statusCode, 400);
  assertCleared(result);
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert(options.signal instanceof AbortSignal);
  assert.doesNotMatch(result.text, /private provider diagnostic/);
});
