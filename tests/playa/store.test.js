const { assert, id, catalog, setup, cookie, privateHeaders, suite } = require('./helpers');
const { createStore } = require('../../api/_lib/playa-store');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const { call, blob } = setup();
const url = '/playa/api/shortlist';
const origin = 'https://gallery.invalid';
const put = (ids, etag = '"empty"', extra = {}, body) =>
  call({
    url,
    method: 'PUT',
    headers: {
      ...cookie(),
      host: 'gallery.invalid',
      origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'if-match': etag,
      ...extra,
    },
    body: body === undefined ? JSON.stringify({ ids }) : body,
  });
test('catalog: absent returns 503 with no bytes', async () => {
  const r = await call({ url: '/playa/api/catalog', headers: cookie() });
  assert.equal(r.statusCode, 503);
  assert.deepEqual(JSON.parse(r.body), { error: 'catalog-not-published' });
  privateHeaders(r);
});
for (const method of ['GET', 'HEAD']) {
  test(`catalog: authenticated ${method} 200 with ETag`, async () => {
    blob.records.set('catalog/catalog.json', { etag: '"catalog"', body: catalog });
    const r = await call({ method, url: '/playa/api/catalog', headers: cookie() });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, method === 'HEAD' ? '' : catalog);
    assert.equal(r.headers.etag, '"catalog"');
    assert.equal(r.headers['cache-control'], 'private, no-cache');
    privateHeaders(r);
  });
}
test('catalog: authenticated If-None-Match returns 304', async () => {
  const r = await call({ url: '/playa/api/catalog', headers: { ...cookie(), 'if-none-match': '"catalog"' } });
  assert.equal(r.statusCode, 304);
  assert.equal(r.body, '');
  assert.equal(r.headers.etag, '"catalog"');
  privateHeaders(r);
  assert.equal(blob.calls.at(-1).options.ifNoneMatch, '"catalog"');
});
for (const size of ['thumb', 'preview']) {
  for (const method of ['GET', 'HEAD']) {
    test(`media: authenticated ${size} ${method} 302 exact signed pathname and max-age 300`, async () => {
      const { call, blob } = setup();
      blob.records.set('catalog/catalog.json', { etag: '"media"', body: JSON.stringify({ photos: [{ id: id(1) }] }) });
      const now = Date.now(),
        value = id(1);
      const r = await call({ method, url: `/playa/m/${size}/${value}.webp`, headers: cookie() });
      assert.equal(r.statusCode, 302);
      assert.equal(r.body, '');
      const [issue, sign] = blob.calls.filter((entry) => ['issueSignedToken', 'presignUrl'].includes(entry.fn));
      assert.equal(
        r.headers.location,
        `/${size}/${value.slice(0, 2)}/${value}.webp?signature=synthetic&expires=${issue.options.validUntil}`,
      );
      assert.equal(r.headers['cache-control'], 'private, max-age=300');
      const signedPath = new URL(r.headers.location, origin).pathname;
      assert.equal(signedPath, `/${size}/${value.slice(0, 2)}/${value}.webp`);
      privateHeaders(r);
      assert.equal(issue.fn, 'issueSignedToken');
      assert.deepEqual(issue.options.operations, ['get']);
      assert.equal(issue.options.pathname, `${size}/${value.slice(0, 2)}/${value}.webp`);
      assert.equal(issue.options.access, 'private');
      assert.ok(issue.options.validUntil - now <= 301000);
      assert.ok(issue.options.validUntil - now >= 299000);
      assert.equal(sign.options.operation, 'get');
      assert.equal(sign.options.access, 'private');
      assert.equal(sign.options.pathname, issue.options.pathname);
      assert.equal(sign.options.validUntil, issue.options.validUntil);
    });
  }
  test(`media: ${size} refuses unpublished ids with 404 and no grant`, async () => {
    const { call, blob } = setup();
    blob.records.set('catalog/catalog.json', { etag: '"media"', body: catalog });
    const r = await call({ url: `/playa/m/${size}/${id('unpublished')}.webp`, headers: cookie() });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(JSON.parse(r.body), { error: 'not-found' });
    assert.equal(r.headers.location, undefined);
    assert.equal(blob.calls.filter((entry) => ['issueSignedToken', 'presignUrl'].includes(entry.fn)).length, 0);
    privateHeaders(r);
  });
  test(`media: ${size} shares a publication cache and refreshes at 60 seconds`, async () => {
    const { call, blob } = setup(), realNow = Date.now, start = realNow();
    let now = start;
    Date.now = () => now;
    const publish = (n) => blob.records.set('catalog/catalog.json', {
      etag: `"media-${n}"`, body: JSON.stringify({ photos: [{ id: id(n) }] }),
    });
    const get = (n) => call({ url: `/playa/m/${size}/${id(n)}.webp`, headers: cookie() });
    const reads = () => blob.calls.filter((entry) => entry.fn === 'get' && entry.path === 'catalog/catalog.json');
    try {
      publish(1);
      const responses = await Promise.all(Array.from({ length: 12 }, () => get(1)));
      assert.ok(responses.every((r) => r.statusCode === 302));
      assert.equal(reads().length, 1);
      publish(2);
      now = start + 59999;
      assert.equal((await get(1)).statusCode, 302);
      assert.equal((await get(2)).statusCode, 404);
      assert.equal(reads().length, 1);
      now = start + 60000;
      blob.calls.length = 0;
      const hidden = await get(1);
      assert.equal(hidden.statusCode, 404);
      assert.equal(blob.calls.filter((entry) => ['issueSignedToken', 'presignUrl'].includes(entry.fn)).length, 0);
      assert.equal((await get(2)).statusCode, 302);
      assert.equal(reads().length, 1);
    } finally { Date.now = realNow; }
  });
}
test('media: a failed refresh fails closed and the next request retries', async () => {
  const { call, blob } = setup(), realNow = Date.now, start = realNow();
  let now = start;
  Date.now = () => now;
  const get = () => call({ url: `/playa/m/thumb/${id(1)}.webp`, headers: cookie() });
  try {
    blob.records.set('catalog/catalog.json', { etag: '"media"', body: JSON.stringify({ photos: [{ id: id(1) }] }) });
    assert.equal((await get()).statusCode, 302);
    now += 60000;
    blob.calls.length = 0;
    blob.fail = true;
    assert.equal((await get()).statusCode, 503);
    assert.equal(blob.calls.length, 1);
    assert.equal(blob.calls[0].fn, 'get');
    blob.fail = false;
    assert.equal((await get()).statusCode, 302);
  } finally { Date.now = realNow; }
});
test('store boundary: invalid media rejected before Blob', async () => {
  blob.calls.length = 0;
  await assert.rejects(createStore(blob, () => 'fake').media('original', id(1)));
  assert.equal(blob.calls.length, 0);
});
test('shortlist: authenticated GET returns empty state', async () => {
  const r = await call({ url, headers: cookie() });
  assert.deepEqual(JSON.parse(r.body), { ids: [], updated_at: null, etag: '"empty"' });
  privateHeaders(r);
});
test('shortlist: authenticated HEAD has no body', async () => {
  const h = await call({ url, method: 'HEAD', headers: cookie() });
  assert.equal(h.statusCode, 200);
  assert.equal(h.body, '');
});
for (const [name, ids, extra, body, status] of [
  ['non array', 'wrong', {}, undefined, 400],
  ['missing ids', undefined, {}, '{}', 400],
  ['bad id has zero writes', ['no'], {}, undefined, 400],
  ['non-string id', [4], {}, undefined, 400],
  ['trailing newline id', [id(1) + '\n'], {}, undefined, 400],
  ['uppercase', [id(1).toUpperCase()], {}, undefined, 400],
  ['more than 5,000 valid ids has zero writes', Array(5001).fill(id(1)), {}, undefined, 413],
  ['count cap without size overflow', Array(5001).fill(''), {}, undefined, 400],
  ['malformed JSON has zero writes', [], {}, '{', 400],
  ['wrong content type has zero writes', [], { 'content-type': 'text/plain' }, undefined, 415],
  ['oversized raw body', [], {}, ' '.repeat(256 * 1024 + 1), 413],
  ['oversized content length', [], { 'content-length': String(256 * 1024 + 1) }, undefined, 413],
])
  test('shortlist validation: ' + name, async () => {
    blob.calls.length = 0;
    const r = await put(ids, '"empty"', extra, body);
    assert.equal(r.statusCode, status);
    assert.equal(blob.calls.length, 0);
    assert.equal(blob.calls.filter((entry) => entry.fn === 'put').length, 0);
    privateHeaders(r);
  });
for (const [name, headers] of [
  ['cross-site', { 'sec-fetch-site': 'cross-site' }],
  ['same-site', { 'sec-fetch-site': 'same-site' }],
  ['wrong origin', { origin: 'https://elsewhere.invalid' }],
  ['null origin', { origin: 'null' }],
  ['no origin evidence', { origin: undefined, 'sec-fetch-site': undefined }],
  ['forged forwarded host', { origin: 'https://elsewhere.invalid', 'x-forwarded-host': 'elsewhere.invalid' }],
])
  test('shortlist cross-site PUT: ' + name, async () => {
    blob.calls.length = 0;
    const r = await put([], '"empty"', headers);
    assert.equal(r.statusCode, 403);
    assert.equal(blob.calls.length, 0);
    assert.equal(blob.calls.filter((entry) => entry.fn === 'put').length, 0);
    privateHeaders(r);
  });
test('shortlist validation: oversized stream rejected before end with zero writes', async () => {
  blob.calls.length = 0;
  let request;
  let ended = false;
  let timer;
  try {
    const response = await Promise.race([
      call({
        url,
        method: 'PUT',
        headers: { ...cookie(), host: 'gallery.invalid', origin, 'content-type': 'application/json' },
        feed(req) {
          request = req;
          req.on('end', () => {
            ended = true;
          });
          req.emit('data', Buffer.alloc(256 * 1024, ' '));
          req.emit('data', Buffer.from(' '));
          // Deliberately leave the request open: the handler must already reject it.
        },
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('waited for request end')), 1000);
      }),
    ]);
    assert.equal(response.statusCode, 413);
    assert.equal(ended, false);
    assert.equal(blob.calls.length, 0);
    privateHeaders(response);
    request.emit('data', Buffer.from('ignored tail'));
    request.emit('end');
    await new Promise(setImmediate);
    assert.equal(blob.calls.filter((entry) => entry.fn === 'put').length, 0);
  } finally {
    clearTimeout(timer);
  }
});
let saved;
test('shortlist: missing If-Match returns 412 without write', async () => {
  const r = await put([], undefined, { 'if-match': undefined });
  assert.equal(r.statusCode, 412);
  assert.ok(!blob.calls.some((c) => c.fn === 'put'));
  privateHeaders(r);
});
test('shortlist: happy create deduplicates and preserves order', async () => {
  const r = await put([id(2), id(1), id(2)]);
  assert.equal(r.statusCode, 200);
  saved = JSON.parse(r.body);
  assert.deepEqual(saved.ids, [id(2), id(1)]);
  assert.ok(!Number.isNaN(Date.parse(saved.updated_at)));
  assert.notEqual(saved.etag, '"empty"');
  privateHeaders(r);
  const last = blob.calls.findLast((c) => c.fn === 'put');
  assert.equal(last.options.allowOverwrite, false);
  assert.equal(last.options.access, 'private');
  assert.equal(last.options.addRandomSuffix, false);
});
test('shortlist: authenticated PUT then GET keeps order and removes duplicates', async () => {
  const written = await put([id(2), id(1), id(2)], saved.etag);
  assert.equal(written.statusCode, 200);
  saved = JSON.parse(written.body);
  const response = await call({ url, headers: cookie() });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), saved);
  assert.deepEqual(JSON.parse(response.body).ids, [id(2), id(1)]);
  privateHeaders(response);
});
test('shortlist: stale If-Match returns 412 and changes nothing', async () => {
  const before = blob.records.get('state/shortlist.json');
  const r = await put([], '"stale"');
  assert.equal(r.statusCode, 412);
  assert.equal(blob.records.get('state/shortlist.json'), before);
  privateHeaders(r);
});
test('shortlist: happy update uses Blob atomic ifMatch and uncached reads', async () => {
  const r = await put([id(3)], saved.etag);
  assert.equal(r.statusCode, 200);
  const last = blob.calls.findLast((c) => c.fn === 'put');
  assert.equal(last.options.ifMatch, saved.etag);
  assert.equal(last.options.allowOverwrite, true);
  assert.ok(blob.calls.filter((c) => c.fn === 'get').every((c) => c.options.useCache === false));
  saved = JSON.parse(r.body);
});
test('shortlist: concurrent writer loses at Blob CAS, not just read check', async () => {
  blob.beforePut = () =>
    blob.records.set('state/shortlist.json', { body: JSON.stringify({ ids: [id(4)], updated_at: null }), etag: '"concurrent"' });
  const r = await put([id(5)], saved.etag);
  assert.equal(r.statusCode, 412);
  assert.deepEqual(JSON.parse(blob.records.get('state/shortlist.json').body).ids, [id(4)]);
});
test('shortlist: concurrent first creation cannot overwrite', async () => {
  blob.records.delete('state/shortlist.json');
  blob.beforePut = () =>
    blob.records.set('state/shortlist.json', { body: JSON.stringify({ ids: [id(4)], updated_at: null }), etag: '"concurrent"' });
  const r = await put([id(5)]);
  assert.equal(r.statusCode, 412);
  assert.deepEqual(JSON.parse(blob.records.get('state/shortlist.json').body).ids, [id(4)]);
});
test('store-error: missing Blob token fails data closed while shell loads', async () => {
  const missing = setup(() => undefined);
  for (const path of ['/playa/api/catalog', url, `/playa/m/thumb/${id(1)}.webp`]) {
    const r = await missing.call({ url: path, headers: cookie() });
    assert.equal(r.statusCode, 503);
    privateHeaders(r);
    assert.doesNotMatch(r.body, /synthetic|stack|token/);
  }
  assert.equal(missing.blob.calls.length, 0);
  const r = await missing.call({ headers: cookie() });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Gallery not published yet/);
});
test('store-error: upstream failures are private generic 503s, shell still loads', async () => {
  blob.fail = true;
  for (const path of ['/playa/api/catalog', url, `/playa/m/thumb/${id(1)}.webp`]) {
    const r = await call({ url: path, headers: cookie() });
    assert.equal(r.statusCode, 503);
    privateHeaders(r);
    assert.doesNotMatch(r.body, /upstream|synthetic|stack/);
  }
  assert.equal((await call({ headers: cookie() })).statusCode, 200);
  blob.fail = false;
});
test('store configuration: linked token environment is used', async () => {
  const previous = process.env.PLAYA_READ_WRITE_TOKEN;
  try {
    process.env.PLAYA_READ_WRITE_TOKEN = 'synthetic-linked-token';
    await createStore(blob).catalog();
    assert.equal(blob.calls.at(-1).options.token, process.env.PLAYA_READ_WRITE_TOKEN);
  } finally {
    if (previous === undefined) delete process.env.PLAYA_READ_WRITE_TOKEN;
    else process.env.PLAYA_READ_WRITE_TOKEN = previous;
  }
});
suite(tests);
