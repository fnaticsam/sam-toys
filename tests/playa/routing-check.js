// Optional tooling: NODE_PATH must expose @vercel/routing-utils.
const { convertRewrites } = require('@vercel/routing-utils');
const { assert, setup, cookie, catalog, suite, id } = require('./helpers');
const config = require('../../vercel.json');
const rules = convertRewrites(config.rewrites.filter((rule) => rule.source.startsWith('/playa')));
const { call, blob } = setup();
blob.records.set('catalog/catalog.json', { body: catalog, etag: '"catalog"' });
// Same invocation contract as Vercel CLI: select dest, preserve origUrl.pathname,
// merge route query, and forward that URL to the Node function. No live service.
async function invoke(original, headers, options = {}) {
  const url = new URL(original, 'https://gallery.invalid');
  const rule = rules.find((rule) => new RegExp(rule.src).test(url.pathname));
  assert.ok(rule);
  assert.ok(rule.dest.startsWith('/api/playa'));
  const match = new RegExp(rule.src).exec(url.pathname);
  const destination = rule.dest.replace(/\$(\d+)/g, (_, n) => match[Number(n)] || '');
  const query = new URL(destination, url).searchParams;
  for (const [key, value] of query) url.searchParams.set(key, value);
  return call({ ...options, url: url.pathname + url.search, headers });
}
const tests = [];
// Registers each behavior under its own independently reported name.
const test = (name, check) => tests.push([name, check]);
test('Vercel compiler: all three rewrite destinations target the one function', async () => {
  assert.equal(rules.length, 3);
  for (const rule of rules) assert.ok(rule.dest.startsWith('/api/playa'));
});
test('Vercel invocation harness: root and slash root serve shell', async () => {
  for (const path of ['/playa', '/playa/']) assert.equal((await invoke(path, cookie())).statusCode, 200);
});
test('Vercel invocation harness: nested original path serves catalog', async () => {
  const r = await invoke('/playa/api/catalog?view=grid', cookie());
  assert.equal(r.body, catalog);
  assert.equal(r.statusCode, 200);
});
test('Vercel invocation harness: captured path and forged header cannot bypass gate', async () => {
  blob.calls.length = 0;
  const r = await invoke('/playa/api/catalog', { 'x-vercel-original-path': '/playa' });
  assert.equal(r.statusCode, 401);
  assert.equal(blob.calls.length, 0);
});
test('Vercel invocation harness: download, export creation and status retain nested raw paths', async () => {
  blob.records.set('catalog/catalog.json', {
    etag: '"download-catalog"',
    body: JSON.stringify({ version: 1, years: [], photos: [{ id: id(1), y: 2024 }] }),
  });
  const download = await invoke(`/playa/m/dl/2048/${id(1)}.jpg`, cookie());
  assert.equal(download.statusCode, 302);
  assert.match(download.headers.location, new RegExp(`^/dl/2048/${id(1).slice(0, 2)}/${id(1)}/playa-2024-${id(1).slice(0, 10)}\\.jpg\\?`));
  const created = await invoke('/playa/api/export', {
    ...cookie(), host: 'gallery.invalid', origin: 'https://gallery.invalid', 'content-type': 'application/json',
  }, { method: 'POST', body: JSON.stringify({ kind: 'photo', size: '4096', ids: [id(1)] }) });
  assert.equal(created.statusCode, 202);
  const { rid } = JSON.parse(created.body);
  const status = await invoke(`/playa/api/export/${rid}`, cookie());
  assert.equal(status.statusCode, 200);
  assert.deepEqual(JSON.parse(status.body), { state: 'queued' });
});
suite(tests);
