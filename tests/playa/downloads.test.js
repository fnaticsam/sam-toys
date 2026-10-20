const { assert, id, setup, cookie, privateHeaders, suite } = require('./helpers');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
assert.ok(process.env.PLAYA_PASSWORD, 'Set the test password');
delete process.env.PLAYA_TRUSTED_IPS;
const origin = 'https://gallery.invalid';
const exportRoute = '/playa/api/export';
const rid = (n) => id(`request-${n}`).slice(0, 32);
const name = (value = id(1), ext = 'jpg') => `playa-2024-${value.slice(0, 10)}.${ext}`;
const request = (value, extra = {}) => ({
  v: 1, rid: value, kind: 'photo', size: '4096', ids: [id(1)], created_at: new Date().toISOString(), ...extra,
});
const status = (value, state, extra = {}) => ({
  v: 1, rid: value, state, done: state === 'ready' ? 1 : 0, total: 1,
  updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), ...extra,
});
function fixture() {
  const f = setup();
  f.blob.records.set('catalog/catalog.json', { etag: '"catalog"', body: JSON.stringify({
    version: 1, generated_at: null, years: [2024],
    photos: [1, 2, 3].map((n) => ({ id: id(n), y: 2024, w: 1200, h: 800, tags: [] })),
  }) });
  return f;
}
const record = (f, path, value) => f.blob.records.set(path, { etag: '"synthetic"', body: JSON.stringify(value) });
const reqRecord = (f, value, extra) => record(f, `exports/req/${value}.json`, request(value, extra));
const statRecord = (f, value, state, extra) => record(f, `exports/status/${value}.json`, status(value, state, extra));
const post = (f, value = { kind: 'photo', size: '4096', ids: [id(1)] }, headers = {}, raw) => f.call({
  method: 'POST', url: exportRoute, headers: {
    ...cookie(), host: 'gallery.invalid', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers,
  }, body: raw === undefined ? JSON.stringify(value) : raw,
});
const getStatus = (f, value, method = 'GET') => f.call({ method, url: `${exportRoute}/${value}`, headers: cookie() });
const signCalls = (f) => f.blob.calls.filter((c) => ['issueSignedToken', 'presignUrl'].includes(c.fn));
function exactGrant(f, pathname, before) {
  const [grant, signed] = signCalls(f);
  assert.equal(signCalls(f).length, 2);
  assert.equal(grant.options.pathname, pathname);
  assert.deepEqual(grant.options.operations, ['get']);
  assert.equal(grant.options.access, 'private');
  assert.ok(grant.options.validUntil >= before + 299000 && grant.options.validUntil <= Date.now() + 300000);
  assert.equal(signed.options.pathname, pathname);
  assert.equal(signed.options.operation, 'get');
  assert.equal(signed.options.access, 'private');
  assert.equal(signed.options.validUntil, grant.options.validUntil);
}
const routes = [`/playa/m/dl/2048/${id(1)}.jpg`, exportRoute, `${exportRoute}/${rid(1)}`];
for (const route of routes) {
  test(`downloads admission: ${route.replace(id(1), '<id>').replace(rid(1), '<rid>')}`, async () => {
    const f = fixture();
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      for (const token of ['', 'playa_session=invalid']) {
        const r = await f.call({ method, url: route, headers: { cookie: token } });
        assert.equal(r.statusCode, 401);
        assert.equal(f.blob.calls.length, 0);
        assert.equal(r.headers.location, undefined);
        if (method === 'HEAD') assert.equal(r.body, '');
        privateHeaders(r);
      }
    }
  });
  test(`downloads missing password and rotation: ${route.replace(id(1), '<id>').replace(rid(1), '<rid>')}`, async () => {
    const f = fixture(), previous = process.env.PLAYA_PASSWORD, old = cookie();
    try {
      delete process.env.PLAYA_PASSWORD;
      for (const method of ['GET', 'HEAD', 'POST']) {
        const r = await f.call({ method, url: route, headers: old });
        assert.equal(r.statusCode, 503);
        assert.equal(f.blob.calls.length, 0);
        privateHeaders(r);
      }
      process.env.PLAYA_PASSWORD = previous + '-rotated';
      for (const method of ['GET', 'HEAD', 'POST']) {
        const r = await f.call({ method, url: route, headers: old });
        assert.equal(r.statusCode, 401);
        assert.equal(f.blob.calls.length, 0);
        privateHeaders(r);
      }
    } finally { process.env.PLAYA_PASSWORD = previous; }
  });
}
for (const [route, methods, allow] of [
  [routes[0], ['POST', 'PUT', 'DELETE'], 'GET, HEAD'],
  [exportRoute, ['GET', 'HEAD', 'PUT', 'DELETE'], 'POST'],
  [routes[2], ['POST', 'PUT', 'DELETE'], 'GET, HEAD'],
]) test(`downloads methods: ${allow} only on ${route.replace(id(1), '<id>').replace(rid(1), '<rid>')}`, async () => {
  const f = fixture();
  for (const method of methods) {
    const r = await f.call({ method, url: route, headers: cookie() });
    assert.equal(r.statusCode, 405);
    assert.equal(r.headers.allow, allow);
    assert.equal(f.blob.calls.length, 0);
    privateHeaders(r);
  }
});
for (const method of ['GET', 'HEAD']) test(`downloads instant: ${method} scopes a five-minute grant to the published derivative`, async () => {
  const f = fixture(), before = Date.now();
  const year = 2023;
  record(f, 'catalog/catalog.json', { version: 1, years: [year], photos: [{ id: id(1), y: year }] });
  const r = await f.call({ method, url: routes[0], headers: cookie() });
  assert.equal(r.statusCode, 302);
  assert.equal(r.body, '');
  assert.equal(new URL(r.headers.location, origin).pathname, `/dl/2048/${id(1).slice(0, 2)}/${id(1)}/playa-${year}-${id(1).slice(0, 10)}.jpg`);
  assert.equal(new URL(r.headers.location, origin).searchParams.get('download'), '1');
  exactGrant(f, `dl/2048/${id(1).slice(0, 2)}/${id(1)}/playa-${year}-${id(1).slice(0, 10)}.jpg`, before);
  privateHeaders(r);
});
test('downloads instant: an unpublished id receives no grant', async () => {
  const f = fixture();
  const r = await f.call({ url: `/playa/m/dl/2048/${id('unpublished')}.jpg`, headers: cookie() });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body), { error: 'not-published' });
  assert.equal(signCalls(f).length, 0);
});
for (const path of [
  `/playa/m/dl/2048/${id(1).toUpperCase()}.jpg`, `/playa/m/dl/2048/${id(1).slice(1)}.jpg`,
  `/playa/m/dl/2048/${id(1)}.jpg/extra`, `/playa/m/dl/4096/${id(1)}.jpg`,
  `/playa/m/dl/2048/${id(1)}.webp`, `/playa/m/dl/2048/%2f${id(1)}.jpg`,
  `${exportRoute}/${rid(1).toUpperCase()}`, `${exportRoute}/${rid(1)}0`, `${exportRoute}/${rid(1)}\n`,
  `${exportRoute}/%2f${rid(1)}`, `${exportRoute}/../${rid(1)}`, `${exportRoute}//${rid(1)}`,
  `/playa/../playa/api/export/${rid(1)}`, `/api/playa/api/export/${rid(1)}`,
]) test(`downloads raw routing rejects ${path.replaceAll(id(1), '<id>').replaceAll(rid(1), '<rid>')}`, async () => {
  const f = fixture();
  const r = await f.call({ url: path, headers: { ...cookie(), 'x-original-url': routes[0], 'x-vercel-original-path': routes[0] } });
  assert.equal(r.statusCode, 404);
  assert.equal(f.blob.calls.length, 0);
  privateHeaders(r);
});
for (const [kind, size, ids] of [
  ['photo', '4096', [id(1)]], ['photo', 'original', [id(2)]],
  ['zip', '2048', [id(1), id(2)]], ['zip', '4096', [id(2)]], ['zip', 'original', [id(1), id(3)]],
]) test(`downloads request: ${kind} ${size} persists only the frozen contract`, async () => {
  const f = fixture(), before = Date.now(), r = await post(f, { kind, size, ids });
  assert.equal(r.statusCode, 202);
  const result = JSON.parse(r.body);
  assert.deepEqual(Object.keys(result), ['rid']);
  assert.match(result.rid, /^[a-f0-9]{32}$/);
  const puts = f.blob.calls.filter((c) => c.fn === 'put');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `exports/req/${result.rid}.json`);
  assert.equal(puts[0].options.allowOverwrite, false);
  assert.equal(puts[0].options.addRandomSuffix, false);
  assert.equal(puts[0].options.access, 'private');
  const saved = JSON.parse(f.blob.records.get(puts[0].path).body);
  assert.deepEqual(saved, { v: 1, rid: result.rid, kind, size, ids, created_at: saved.created_at });
  assert.ok(Date.parse(saved.created_at) >= before && Date.parse(saved.created_at) <= Date.now());
  assert.equal(signCalls(f).length, 0);
  privateHeaders(r);
});
test('downloads request: independent requests receive fresh random identifiers', async () => {
  const f = fixture();
  const a = JSON.parse((await post(f)).body), b = JSON.parse((await post(f)).body);
  assert.match(a.rid, /^[a-f0-9]{32}$/);
  assert.match(b.rid, /^[a-f0-9]{32}$/);
  assert.notEqual(a.rid, b.rid);
});
test('downloads request: a zip accepts the 2000 unique published-id boundary', async () => {
  const f = fixture(), ids = Array.from({ length: 2000 }, (_, n) => id(n));
  record(f, 'catalog/catalog.json', { version: 1, years: [2024], photos: ids.map((value) => ({ id: value, y: 2024 })) });
  const r = await post(f, { kind: 'zip', size: '2048', ids });
  assert.equal(r.statusCode, 202);
  const saved = JSON.parse(f.blob.records.get(`exports/req/${JSON.parse(r.body).rid}.json`).body);
  assert.deepEqual(saved.ids, ids);
});
for (const payload of [
  null, [], {}, { kind: 'photo', size: '2048', ids: [id(1)] },
  { kind: 'photo', size: '4096', ids: [id(1), id(2)] }, { kind: 'photo', size: '4096', ids: [] },
  { kind: 'zip', size: '2048', ids: [] }, { kind: 'zip', size: '2048', ids: [id(1), id(1)] },
  { kind: 'zip', size: 2048, ids: [id(1)] }, { kind: 'zip', size: 'other', ids: [id(1)] },
  { kind: 'other', size: '4096', ids: [id(1)] }, { kind: 'photo', size: '4096', ids: [id(1) + '\n'] },
  { kind: 'photo', size: '4096', ids: [id(1).toUpperCase()] }, { kind: 'photo', size: '4096', ids: [7] },
  { kind: 'zip', size: '2048', ids: Array.from({ length: 2001 }, (_, n) => id(n)) },
  { kind: 'photo', size: '4096', ids: [id(1)], path: '../outside' },
]) test(`downloads request validation: malformed payload ${tests.length}`, async () => {
  const f = fixture(), r = await post(f, payload);
  assert.equal(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body), { error: 'invalid-request' });
  assert.equal(f.blob.calls.filter((c) => c.fn === 'put').length, 0);
  assert.equal(signCalls(f).length, 0);
  privateHeaders(r);
});
test('downloads request validation: malformed JSON has no writes', async () => {
  const f = fixture(), r = await post(f, undefined, {}, '{');
  assert.equal(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body), { error: 'invalid-json' });
  assert.equal(f.blob.calls.filter((c) => c.fn === 'put').length, 0);
});
test('downloads request validation: oversized content length is rejected before Blob access', async () => {
  const f = fixture(), r = await post(f, undefined, { 'content-length': String(256 * 1024 + 1) });
  assert.equal(r.statusCode, 413);
  assert.equal(f.blob.calls.length, 0);
  privateHeaders(r);
});
test('downloads request validation: oversized stream is rejected before request end with no writes', async () => {
  const f = fixture();
  let timer, requestStream, ended = false;
  try {
    const response = await Promise.race([
      f.call({
        url: exportRoute, method: 'POST',
        headers: { ...cookie(), host: 'gallery.invalid', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        feed(req) {
          requestStream = req;
          req.on('end', () => { ended = true; });
          req.emit('data', Buffer.alloc(256 * 1024, ' '));
          req.emit('data', Buffer.from(' '));
        },
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('waited for request end')), 1000); }),
    ]);
    assert.equal(response.statusCode, 413);
    assert.equal(ended, false);
    assert.equal(f.blob.calls.length, 0);
    privateHeaders(response);
    requestStream.emit('data', Buffer.from('ignored tail'));
    requestStream.emit('end');
    await new Promise(setImmediate);
    assert.equal(f.blob.calls.filter((c) => c.fn === 'put').length, 0);
  } finally { clearTimeout(timer); }
});
test('downloads request validation: unpublished id has no writes', async () => {
  const f = fixture(), r = await post(f, { kind: 'photo', size: 'original', ids: [id('unpublished')] });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body), { error: 'not-published' });
  assert.equal(f.blob.calls.filter((c) => c.fn === 'put').length, 0);
});
for (const headers of [
  { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://elsewhere.invalid' },
  { origin: 'null' }, { origin: undefined, 'sec-fetch-site': undefined },
  { origin: 'https://elsewhere.invalid', 'x-forwarded-host': 'elsewhere.invalid' },
]) test(`downloads origin: rejected evidence ${tests.length}`, async () => {
  const f = fixture(), r = await post(f, undefined, headers);
  assert.equal(r.statusCode, 403);
  assert.deepEqual(JSON.parse(r.body), { error: 'cross-site' });
  assert.equal(f.blob.calls.length, 0);
  privateHeaders(r);
});
test('downloads request: wrong content type is rejected before Blob access', async () => {
  const f = fixture(), r = await post(f, undefined, { 'content-type': 'text/plain' });
  assert.equal(r.statusCode, 415);
  assert.equal(f.blob.calls.length, 0);
});
test('downloads request: the ninth unfinished request is refused across list pages', async () => {
  const f = fixture();
  f.blob.listPageSize = 3;
  for (let n = 0; n < 8; n++) {
    reqRecord(f, rid(n));
    if (n % 3 !== 0) statRecord(f, rid(n), n % 2 ? 'queued' : 'building');
  }
  const r = await post(f);
  assert.equal(r.statusCode, 429);
  assert.deepEqual(JSON.parse(r.body), { error: 'export-busy' });
  assert.equal(f.blob.calls.filter((c) => c.fn === 'put').length, 0);
  assert.ok(f.blob.calls.filter((c) => c.fn === 'list').length >= 3);
  assert.ok(f.blob.calls.filter((c) => c.fn === 'list').every((c) => c.options.prefix === 'exports/req/'));
  privateHeaders(r);
});
test('downloads request: ready and failed requests do not consume unfinished capacity', async () => {
  const f = fixture();
  f.blob.listPageSize = 2;
  for (let n = 0; n < 10; n++) {
    reqRecord(f, rid(n));
    statRecord(f, rid(n), n % 2 ? 'failed' : 'ready', n % 2 ? { error: 'internal' } : {
      file: { path: `exports/out/${rid(n)}/${name()}`, name: name(), bytes: 10 },
    });
  }
  const r = await post(f);
  assert.equal(r.statusCode, 202);
});
test('downloads request: concurrent submissions in one gate instance enforce the unfinished cap', async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 10 }, () => post(f)));
  assert.equal(responses.filter((r) => r.statusCode === 202).length, 8);
  assert.equal(responses.filter((r) => r.statusCode === 429).length, 2);
  assert.equal([...f.blob.records.keys()].filter((path) => path.startsWith('exports/req/')).length, 8);
});
test('downloads status: missing status with a request maps to queued, neither maps to 404', async () => {
  const f = fixture(), value = rid(1);
  const missing = await getStatus(f, value);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'not-found' });
  reqRecord(f, value);
  const queued = await getStatus(f, value);
  assert.equal(queued.statusCode, 200);
  assert.deepEqual(JSON.parse(queued.body), { state: 'queued' });
  assert.ok(f.blob.calls.filter((c) => c.fn === 'get').every((c) => c.options.useCache === false));
  assert.equal(signCalls(f).length, 0);
  privateHeaders(missing);
  privateHeaders(queued);
});
for (const state of ['queued', 'building', 'failed']) test(`downloads status: ${state} exposes only allowed progress and error fields`, async () => {
  const f = fixture(), value = rid(1);
  reqRecord(f, value);
  statRecord(f, value, state, { done: state === 'building' ? 1 : 0, total: 1, ...(state === 'failed' ? { error: 'integrity' } : {}) });
  const r = await getStatus(f, value), data = JSON.parse(r.body);
  assert.equal(r.statusCode, 200);
  assert.equal(data.state, state);
  assert.equal(data.done, state === 'building' ? 1 : 0);
  assert.equal(data.total, 1);
  if (state === 'failed') assert.equal(data.error, 'integrity');
  assert.equal(signCalls(f).length, 0);
  assert.ok(Object.keys(data).every((k) => ['state', 'done', 'total', 'error', 'expires_at'].includes(k)));
  privateHeaders(r);
});
for (const [kind, size, ext] of [['photo', '4096', 'jpg'], ['photo', 'original', 'arw'], ['zip', '2048', 'zip']]) {
  test(`downloads status: ready ${kind} ${size} signs exactly the validated output`, async () => {
    const f = fixture(), value = rid(1), before = Date.now();
    const filename = kind === 'zip' ? 'playa-shortlist-2024-01-02-2048.zip' : name(id(1), ext);
    const pathname = `exports/out/${value}/${filename}`;
    reqRecord(f, value, { kind, size });
    statRecord(f, value, 'ready', { file: { path: pathname, bytes: 123456, name: filename } });
    const r = await getStatus(f, value), data = JSON.parse(r.body);
    assert.equal(r.statusCode, 200);
    assert.equal(data.state, 'ready');
    assert.equal(data.bytes, 123456);
    assert.equal(data.name, filename);
    assert.equal(new URL(data.url, origin).pathname, `/${pathname}`);
    assert.equal(new URL(data.url, origin).searchParams.get('download'), '1');
    exactGrant(f, pathname, before);
    assert.ok(Object.keys(data).every((k) => ['state', 'done', 'total', 'expires_at', 'url', 'bytes', 'name'].includes(k)));
    privateHeaders(r);
  });
}
test('downloads status: expired ready file is never signed', async () => {
  const f = fixture(), value = rid(1);
  reqRecord(f, value);
  statRecord(f, value, 'ready', {
    expires_at: new Date(Date.now() - 1000).toISOString(), file: { path: `exports/out/${value}/${name()}`, bytes: 10, name: name() },
  });
  const r = await getStatus(f, value);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { state: 'expired' });
  assert.equal(signCalls(f).length, 0);
});
test('downloads status: HEAD suppresses the body and keeps privacy headers', async () => {
  const f = fixture(), value = rid(1);
  reqRecord(f, value);
  const r = await getStatus(f, value, 'HEAD');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, '');
  privateHeaders(r);
});
for (const extra of [
  { file: { path: `exports/out/${rid(2)}/${name()}`, name: name(), bytes: 10 } },
  { file: { path: `catalog/${name()}`, name: name(), bytes: 10 } },
  { file: { path: `exports/out/${rid(1)}/../${name()}`, name: name(), bytes: 10 } },
  { file: { path: `exports/out/${rid(1)}/${name()}?extra=1`, name: name(), bytes: 10 } },
  { file: { path: `exports/out/${rid(1)}/${name()}`, name: '../unsafe.jpg', bytes: 10 } },
  { file: { path: `exports/out/${rid(1)}/${name(id(2))}`, name: name(id(2)), bytes: 10 } },
  { file: { path: `exports/out/${rid(1)}/${name()}`, name: name(), bytes: -1 } },
  { file: { path: `exports/out/${rid(1)}/${name()}`, name: name(), bytes: 1.5 } },
  { rid: rid(2) }, { state: 'unrecognized' }, { v: 2 }, { done: -1 }, { done: 2 }, { total: '1' },
  { expires_at: 'not-a-date' },
]) test(`downloads status validation: unsafe output or malformed status ${tests.length} receives no grant`, async () => {
  const f = fixture(), value = rid(1);
  reqRecord(f, value);
  statRecord(f, value, 'ready', { file: { path: `exports/out/${value}/${name()}`, name: name(), bytes: 10 }, ...extra });
  const r = await getStatus(f, value);
  assert.equal(r.statusCode, 503);
  assert.equal(signCalls(f).length, 0);
  assert.doesNotMatch(r.body, /unsafe|catalog\/|exports\/|unrecognized/);
  privateHeaders(r);
});
test('downloads status validation: failed status never exposes arbitrary error text', async () => {
  const f = fixture(), value = rid(1);
  reqRecord(f, value);
  statRecord(f, value, 'failed', { error: 'private source details' });
  const r = await getStatus(f, value);
  assert.doesNotMatch(r.body, /private source details/);
  assert.equal(signCalls(f).length, 0);
});
test('downloads status validation: original and zip basenames reject trailing newlines', async () => {
  for (const kind of ['photo', 'zip']) {
    const f = fixture(), value = rid(1);
    reqRecord(f, value, { kind, size: 'original' });
    const unsafe = kind === 'photo' ? `${name(id(1), 'arw')}\n` : 'playa-shortlist-2024-01-01-original.zip\n';
    statRecord(f, value, 'ready', { file: { path: `exports/out/${value}/${unsafe}`, name: unsafe, bytes: 10 } });
    assert.equal((await getStatus(f, value)).statusCode, 503);
    assert.equal(signCalls(f).length, 0);
  }
});
test('downloads status validation: unpublishing a requested id prevents a ready grant', async () => {
  const f = fixture(), value = rid(1);
  reqRecord(f, value, { ids: [id('unpublished')] });
  statRecord(f, value, 'ready', { file: { path: `exports/out/${value}/${name()}`, name: name(), bytes: 10 } });
  const r = await getStatus(f, value);
  assert.ok([400, 404, 503].includes(r.statusCode));
  assert.equal(signCalls(f).length, 0);
});
for (const unavailable of ['missing token', 'upstream failure']) test(`downloads store error: ${unavailable} stays generic and private`, async () => {
  const f = unavailable === 'missing token' ? setup(() => undefined) : fixture();
  if (unavailable === 'upstream failure') f.blob.fail = true;
  for (const path of [routes[0], routes[2]]) {
    const r = await f.call({ url: path, headers: cookie() });
    assert.equal(r.statusCode, 503);
    assert.deepEqual(JSON.parse(r.body), { error: 'gallery-not-published' });
    assert.equal(signCalls(f).length, 0);
    privateHeaders(r);
  }
  const r = await post(f);
  assert.equal(r.statusCode, 503);
  assert.deepEqual(JSON.parse(r.body), { error: 'gallery-not-published' });
  assert.equal(f.blob.calls.filter((c) => c.fn === 'put').length, 0);
  if (unavailable === 'missing token') assert.equal(f.blob.calls.length, 0);
  privateHeaders(r);
});
test('downloads privacy: errors and successful signing never log signed URLs', async () => {
  const captured = [], originals = {};
  for (const key of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[key] = console[key];
    console[key] = (...args) => captured.push(args.map(String).join(' '));
  }
  try {
    const f = fixture(), value = rid(1);
    await f.call({ url: routes[0], headers: cookie() });
    reqRecord(f, value);
    statRecord(f, value, 'ready', { file: { path: `exports/out/${value}/${name()}`, name: name(), bytes: 10 } });
    await getStatus(f, value);
    f.blob.fail = true;
    await getStatus(f, value);
    assert.doesNotMatch(captured.join('\n'), /signature=|delegationToken|clientSigningToken|private upstream/);
  } finally { for (const key of Object.keys(originals)) console[key] = originals[key]; }
});
suite(tests);
