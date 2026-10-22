require('../security/install-test-controls').install(require('node:path').resolve(__dirname, '../..'));
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { createHandler } = require('../../api/playa');
const { createStore } = require('../../api/_lib/playa-store');
const session = require('../../api/_lib/playa-session');
const id = (n) => require('node:crypto').createHash('sha256').update(`synthetic-${n}`).digest('hex');
const catalog = JSON.stringify({ version: 1, generated_at: null, years: [], photos: [] });
// Records every simulated Blob operation without touching the network.
function fakeBlob() {
  const calls = [],
    records = new Map();
  let revision = 0;
  class BlobPreconditionFailedError extends Error {}
  class BlobNotFoundError extends Error {}
  const client = {
    calls,
    records,
    BlobPreconditionFailedError,
    BlobNotFoundError,
    fail: false,
    beforePut: null,
    listPageSize: Infinity,
    async list(options) {
      calls.push({ fn: 'list', options });
      if (client.fail) throw new Error('private upstream error must not escape');
      const paths = [...records.keys()].filter((path) => path.startsWith(options.prefix)).sort();
      const start = Number(options.cursor || 0);
      const limit = Math.min(options.limit || 1000, client.listPageSize);
      const end = Math.min(start + limit, paths.length);
      return {
        blobs: paths.slice(start, end).map((pathname) => ({
          pathname,
          size: Buffer.byteLength(records.get(pathname).body),
          uploadedAt: new Date(),
        })),
        hasMore: end < paths.length,
        cursor: end < paths.length ? String(end) : undefined,
      };
    },
    async get(path, options) {
      calls.push({ fn: 'get', path, options });
      if (client.fail) throw new Error('private upstream error must not escape');
      const record = records.get(path);
      if (!record) return null;
      const same = options.ifNoneMatch === record.etag || options.ifNoneMatch === '*';
      return { statusCode: same ? 304 : 200, blob: { etag: record.etag }, stream: same ? null : new Response(record.body).body };
    },
    async put(path, body, options) {
      calls.push({ fn: 'put', path, options });
      if (client.fail) throw new Error('private upstream error must not escape');
      if (client.beforePut) {
        const hook = client.beforePut;
        client.beforePut = null;
        hook();
      }
      const record = records.get(path);
      if ((!options.allowOverwrite && record) || (options.ifMatch && record?.etag !== options.ifMatch))
        throw new BlobPreconditionFailedError();
      const etag = `"revision-${++revision}"`;
      records.set(path, { body, etag });
      return { etag };
    },
    async issueSignedToken(options) {
      calls.push({ fn: 'issueSignedToken', options });
      if (client.fail) throw new Error('private upstream error must not escape');
      return { delegationToken: 'fake', clientSigningToken: 'fake', validUntil: options.validUntil };
    },
    async presignUrl(signed, options) {
      calls.push({ fn: 'presignUrl', signed, options });
      return { presignedUrl: `/${options.pathname}?signature=synthetic&expires=${options.validUntil}` };
    },
  };
  return client;
}
// Connects the real handler and store module to an isolated fake Blob client.
function setup(token = () => 'synthetic-token') {
  const blob = fakeBlob();
  const handler = createHandler(createStore(blob, token));
  return { blob, handler, call: (options) => call(handler, options) };
}
// Drives the handler with mock request events and a writable response.
async function call(handler, { method = 'GET', url = '/playa', headers = {}, body = null, error = false, feed } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers });
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      res.headersSent = true;
      callback();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  const done = new Promise((resolve, reject) => {
    res.on('finish', () => {
      res.body = Buffer.concat(chunks).toString();
      resolve(res);
    });
    res.on('error', reject);
  });
  const task = handler(req, res);
  process.nextTick(() => {
    if (feed) return feed(req);
    if (error) req.emit('error', new Error('synthetic'));
    else {
      if (body !== null) req.emit('data', Buffer.from(body));
      req.emit('end');
    }
  });
  await task;
  return done;
}
const cookie = () => ({ cookie: `playa_session=${session.issueToken(process.env.PLAYA_PASSWORD)}` });
// Asserts the privacy headers required on every response path.
function privateHeaders(response) {
  assert.match(response.headers['cache-control'], /no-store|^private, (no-cache|max-age=300)$/);
  assert.equal(response.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
}
// Runs every named check and reports independent pass/fail counts.
async function suite(tests) {
  let passed = 0,
    failed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
module.exports = { assert, session, id, catalog, setup, call, cookie, privateHeaders, suite };
