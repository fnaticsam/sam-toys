import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDatasetStore } from '../../api/_lib/ldn/store.mjs';

// Actual installed SDK + its own Undici, with all external connections forbidden.
// A 503 puts the SDK in retry backoff, which is not interrupted by abort alone.
test('actual Blob SDK backoff cannot extend the refresh caller deadline', async t => {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve('@vercel/blob'));
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = sdkRequire('undici');
  const previousDispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const saved = { url: process.env.VERCEL_BLOB_API_URL, retries: process.env.VERCEL_BLOB_RETRIES, random: Math.random };
  process.env.VERCEL_BLOB_API_URL = 'https://blob.invalid';
  process.env.VERCEL_BLOB_RETRIES = '1';
  Math.random = () => 0;
  setGlobalDispatcher(agent);
  let puts = 0;
  agent.get('https://blob.invalid').intercept({ method: 'PUT', path: () => true })
    .reply(() => { puts++; return { statusCode: 503, data: JSON.stringify({ error: { code: 'service_unavailable' } }),
      responseOptions: { headers: { 'content-type': 'application/json' } } }; }).persist();
  const sdk = require('@vercel/blob');
  const store = createDatasetStore({ client: { ...sdk, get: async () => null }, requestTimeoutMs: 100,
    env: { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_synthetic_fixture', LDN_REFRESH_CONTROL_TOKEN: 'vercel_blob_rw_synthetic_fixture' } });
  try {
    const started = performance.now();
    await assert.rejects(store.acquire(), { name: 'TimeoutError' });
    const elapsed = performance.now() - started;
    t.diagnostic(`100ms caller deadline returned in ${Math.round(elapsed)}ms; all network disabled`);
    assert.ok(elapsed < 750, `Caller exceeded the 100ms deadline: ${Math.round(elapsed)}ms`);
    assert.equal(puts, 1);
    // Let the SDK leave its first one-second backoff while still sandboxed. Its
    // late rejection is observed, and the aborted retry cannot send another PUT.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(puts, 1);
  } finally {
    Math.random = saved.random;
    if (saved.url === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = saved.url;
    if (saved.retries === undefined) delete process.env.VERCEL_BLOB_RETRIES; else process.env.VERCEL_BLOB_RETRIES = saved.retries;
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
  }
});
