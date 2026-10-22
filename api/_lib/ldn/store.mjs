// Public datasets and immutable recovery copies stay in the existing store.
// Coordination lives in a separately configured PRIVATE store; no public lock.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { deadline, withinDeadline } from './deadline.mjs';
import seed from './seed.mjs';

const require = createRequire(import.meta.url);
export const CURRENT_KEY = 'ldn/current.json';
export const CONTROL_KEY = 'ldn/control/refresh.json';
// Longer than this function's configured 300-second maximum lifetime.
export const REFRESH_LEASE_MS = 360000;
export { seed };

export class RefreshBusy extends Error { constructor() { super('refresh-busy'); } }
export class RefreshConflict extends Error { constructor() { super('refresh-conflict'); } }
export class RefreshUnavailable extends Error { constructor() { super('refresh-unavailable'); } }

function validDataset(value) {
  return value && typeof value === 'object' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) &&
    Array.isArray(value.categories) && Array.isArray(value.places);
}

export function createDatasetStore({ client = require('@vercel/blob'), env = process.env,
  now = Date.now, randomId = () => randomBytes(16).toString('hex'), requestTimeoutMs = 15000 } = {}) {
  const uncertainPromotions = new Set();
  function options(access, signal) {
    const token = access === 'private' ? env.LDN_REFRESH_CONTROL_TOKEN : env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new RefreshUnavailable();
    return { access, token, ...(signal ? { abortSignal: signal } : {}) };
  }
  async function read(path, access, signal) {
    try {
      return await withinDeadline(requestTimeoutMs, signal, async (requestSignal, assertActive) => {
        const result = await client.get(path, { ...options(access, requestSignal), useCache: false });
        try { assertActive(); }
        catch (error) { void result?.stream?.cancel().catch(() => {}); throw error; }
        if (!result) return null;
        // Consume under the same deadline, and cancel even a stream whose source
        // ignores the SDK's AbortSignal. Never start a write after a late read.
        const reader = result.stream.getReader(), decoder = new TextDecoder();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        requestSignal.addEventListener('abort', cancel, { once: true });
        let body = '';
        try {
          while (true) {
            assertActive();
            const chunk = await reader.read();
            assertActive();
            if (chunk.done) break;
            body += decoder.decode(chunk.value, { stream: true });
          }
          body += decoder.decode();
        } finally { requestSignal.removeEventListener('abort', cancel); reader.releaseLock(); }
        return { body, value: JSON.parse(body), etag: result.blob.etag, url: result.blob.url };
      });
    } catch (error) {
      if (client.BlobNotFoundError && error instanceof client.BlobNotFoundError) return null;
      throw error;
    }
  }
  async function put(path, body, opts) {
    try {
      return await withinDeadline(requestTimeoutMs, opts.abortSignal, async (signal, assertActive) => {
        const result = await client.put(path, body, { ...opts, abortSignal: signal });
        assertActive();
        return result;
      });
    } catch (error) {
      if (opts.abortSignal?.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
        const uncertain = new Error('blob-write-uncertain');
        uncertain.name = error?.name || 'AbortError';
        uncertain.uncertainBlobWrite = true;
        throw uncertain;
      }
      throw error;
    }
  }
  async function control(signal) {
    const record = await read(CONTROL_KEY, 'private', signal);
    if (record && (record.value?.v !== 1 || !Number.isSafeInteger(record.value.expiresAt) ||
      !(record.value.owner === null || /^[a-f0-9]{32}$/.test(record.value.owner)))) throw new RefreshUnavailable();
    return record;
  }
  const writeOptions = (access, signal) => ({ ...options(access, signal),
    addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 });
  async function current(signal) {
    const record = await read(CURRENT_KEY, 'public', signal);
    if (record && !validDataset(record.value)) throw new RefreshUnavailable();
    return record ? { ...record, dataset: record.value, source: 'blob' } :
      { body: null, etag: null, dataset: seed, source: 'seed' };
  }
  async function assertLease(lease, signal) {
    signal?.throwIfAborted();
    const held = await control(signal);
    if (!held || held.etag !== lease.etag || held.value.owner !== lease.owner ||
      held.value.expiresAt <= now()) throw new RefreshConflict();
  }
  async function acquire(signal) {
    // Validate both stores before reserving a lease or making any paid call.
    options('public', signal);
    options('private', signal);
    const old = await control(signal);
    if (old?.value.expiresAt > now()) throw new RefreshBusy();
    const value = { v: 1, owner: randomId(), expiresAt: now() + REFRESH_LEASE_MS };
    try {
      const result = await put(CONTROL_KEY, JSON.stringify(value), {
        ...writeOptions('private', signal), allowOverwrite: !!old,
        ...(old ? { ifMatch: old.etag } : {}),
      });
      return { ...value, etag: result.etag };
    } catch (error) {
      signal?.throwIfAborted();
      // An uncertain response is resolved by reading, never by blindly retrying.
      const winner = await control(signal);
      if (winner?.value.owner === value.owner && winner.value.expiresAt > now())
        return { ...winner.value, etag: winner.etag };
      if (winner?.value.expiresAt > now()) throw new RefreshBusy();
      throw error;
    }
  }
  async function release(lease, signal) {
    // A timed-out current write may still complete remotely. Keep this lease
    // until expiry instead of admitting new paid work into an uncertain run.
    if (uncertainPromotions.has(lease.owner)) return false;
    try {
      await put(CONTROL_KEY, JSON.stringify({ v: 1, owner: null, expiresAt: 0 }), {
        ...writeOptions('private', signal), allowOverwrite: true, ifMatch: lease.etag,
      });
      return true;
    } catch (error) {
      // An expired owner's cleanup must never release a newer owner's lease.
      if (client.BlobPreconditionFailedError && error instanceof client.BlobPreconditionFailedError) return false;
      throw error;
    }
  }
  async function archive(body, month, label, signal) {
    signal?.throwIfAborted();
    const key = `ldn/archive/${month}/${now()}-${randomId()}-${label}.json`;
    await put(key, body, { ...writeOptions('public', signal), allowOverwrite: false });
    return key;
  }
  async function publish(dataset, { baseline, lease, signal } = {}) {
    if (!validDataset(dataset) || !baseline || !lease) throw new RefreshUnavailable();
    await assertLease(lease, signal);
    // Archive the actual prior live body, including on the first upgraded run.
    // No archive failure is ignored, and promotion happens only after both exist.
    const previousSnapshot = baseline.body === null ? null :
      await archive(baseline.body, baseline.dataset.month, 'previous', signal);
    const body = JSON.stringify(dataset);
    const snapshot = await archive(body, dataset.month, 'next', signal);
    await assertLease(lease, signal);
    try {
      const result = await put(CURRENT_KEY, body, {
        ...writeOptions('public', signal), allowOverwrite: baseline.etag !== null,
        ...(baseline.etag !== null ? { ifMatch: baseline.etag } : {}),
      });
      return { url: result.url, snapshot, previousSnapshot };
    } catch (error) {
      // Conditional writes fence stale publishers. A lost success response can
      // still be recognized without repeating a write or discarding the archive.
      if (error.uncertainBlobWrite) uncertainPromotions.add(lease.owner);
      const recovery = deadline(5000);
      try {
        const actual = await current(recovery.signal);
        if (actual.body === body) {
          uncertainPromotions.delete(lease.owner);
          return { url: actual.url, snapshot, previousSnapshot, reconciled: true };
        }
        if (actual.etag !== baseline.etag) throw new RefreshConflict();
      } finally { recovery.dispose(); }
      throw error;
    }
  }
  return {
    acquire, release, current, publish,
    // Operator-only library operation; no public restore endpoint is exposed.
    async restore(snapshot, context) {
      if (!/^ldn\/archive\/\d{4}-(0[1-9]|1[0-2])\/\d+-[a-f0-9]{32}-(previous|next)\.json$/.test(snapshot))
        throw new RefreshUnavailable();
      await assertLease(context.lease, context.signal);
      const record = await read(snapshot, 'public', context.signal);
      if (!record || !validDataset(record.value)) throw new RefreshUnavailable();
      return publish(record.value, context);
    },
    async readDataset({ signal } = {}) {
      if (!env.BLOB_READ_WRITE_TOKEN) return { dataset: seed, source: 'seed' };
      try {
        const value = await current(signal);
        return { dataset: value.dataset, source: value.source };
      } catch {
        signal?.throwIfAborted();
        return { dataset: seed, source: 'seed' };
      }
    },
  };
}

export async function readDataset(options) {
  return createDatasetStore().readDataset(options);
}
