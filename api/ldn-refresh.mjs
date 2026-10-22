// Cron: GET + Authorization: Bearer CRON_SECRET. Manual: POST + x-refresh-secret.
// dryRun still performs paid research, so authentication, lease and deadlines apply.
import { timingSafeEqual, createHash } from 'node:crypto';
import { researchAll, buildDataset, carryOverEnrichment } from './_lib/ldn/research.mjs';
import { sanityGate } from './_lib/ldn/verify.mjs';
import { enrichWithPlaces } from './_lib/ldn/places.mjs';
import { createDatasetStore, RefreshBusy, RefreshConflict } from './_lib/ldn/store.mjs';
import { deadline } from './_lib/ldn/deadline.mjs';

function matches(value, expected) {
  if (!expected || typeof value !== 'string') return false;
  const digest = text => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(value), digest(expected));
}
function monthTag() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

export function createRefreshHandler({ env = process.env, storeFactory = createDatasetStore,
  research = researchAll, build = buildDataset, carry = carryOverEnrichment,
  enrich = enrichWithPlaces, gate = sanityGate, deadlineMs = 240000,
  log = event => console.warn(event) } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method-not-allowed' });
    }
    const authorized = req.method === 'GET'
      ? matches(req.headers.authorization, env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null)
      : matches(req.headers['x-refresh-secret'], env.REFRESH_SECRET);
    if (!authorized) return res.status(401).json({ error: 'unauthorized' });
    const q = new URL(req.url, 'http://localhost').searchParams;
    // Explicit rejection helps clients remove the old credential-bearing URL.
    if (q.has('key')) return res.status(400).json({ error: 'query-auth-removed' });
    const requestedMonth = q.get('month');
    if (requestedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth))
      return res.status(400).json({ error: 'invalid-month' });
    const month = requestedMonth || monthTag();
    const dryRun = ['1', 'true'].includes(q.get('dryRun'));
    const operation = deadline(deadlineMs, req.signal);
    // Research/enrichment stops earlier to leave up to 30 seconds for publication.
    const work = deadline(Math.min(deadlineMs, 210000), operation.signal);
    let store, lease, outcome;
    try {
      store = storeFactory({ env });
      lease = await store.acquire(operation.signal);
      const baseline = await store.current(operation.signal);
      work.signal.throwIfAborted();
      const results = await research({ month, concurrency: 3, signal: work.signal });
      work.signal.throwIfAborted();
      const dataset = build(results, { month, generatedAt: new Date().toISOString() });
      dataset.verified = false;
      const { carried } = carry(baseline.dataset, dataset);
      let placesStats;
      try {
        placesStats = await enrich(dataset, { key: env.GOOGLE_PLACES_API_KEY, signal: work.signal });
      } catch {
        work.signal.throwIfAborted();
        placesStats = { error: 'enrichment-failed' };
      }
      work.signal.throwIfAborted();
      work.dispose();
      const checked = gate(dataset);
      const summary = {
        month, totalPlaces: dataset.places.length,
        perCategory: results.map(r => ({ category: r.category, count: r.places?.length || 0,
          error: r.error ? 'research-failed' : null })),
        carriedEnrichment: carried, places: placesStats,
        gate: { ok: checked.ok, issueCount: checked.issues.length },
      };
      if (dryRun) outcome = { status: 200, body: { ok: true, dryRun: true, summary } };
      else if (!checked.ok) outcome = { status: 200, body: { ok: false, persisted: false, reason: 'sanity-gate-failed', summary } };
      else {
        const publication = await store.publish(dataset, { baseline, lease, signal: operation.signal });
        outcome = { status: 200, body: { ok: true, persisted: true, blobUrl: publication.url,
          snapshot: publication.snapshot, previousSnapshot: publication.previousSnapshot, summary } };
      }
    } catch (error) {
      const code = operation.signal.aborted || work.signal.aborted || error.name === 'TimeoutError' ? 'refresh-timeout' : error instanceof RefreshBusy ? 'refresh-busy' :
        error instanceof RefreshConflict ? 'refresh-conflict' : 'refresh-unavailable';
      log({ event: 'ldn-refresh-failed', code });
      outcome = { status: code === 'refresh-timeout' ? 504 : ['refresh-busy', 'refresh-conflict'].includes(code) ? 409 : 503,
        body: { ok: false, error: code } };
    } finally {
      work.dispose();
      operation.dispose();
      if (lease) {
        const cleanup = deadline(5000);
        try { await store.release(lease, cleanup.signal); }
        catch { log({ event: 'ldn-refresh-release-failed' }); }
        finally { cleanup.dispose(); }
      }
    }
    return res.status(outcome.status).json(outcome.body);
  };
}

export default createRefreshHandler();
