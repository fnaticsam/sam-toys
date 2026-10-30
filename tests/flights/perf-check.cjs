/* Deterministic provider-delay experiment against the actual shipping inline
 * script. This is JavaScript/DOM-write evidence only: no layout, paint or INP.
 * Run: node tests/flights/perf-check.cjs [--baseline /tmp/live.js] [--runs 5] [--verify]
 * The optional baseline can be an extracted inline script or a complete HTML.
 * No browser, live service, package dependency or filesystem mutation is used.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHandler } = require('../../api/flights');
const { NOW, searchFixture } = require('./fixture-server.cjs');
const root = path.resolve(__dirname, '../..');
const DELAY_MS = 120;
const query = { from: 'LHR', to: 'MAD', out: '2026-11-18', back: '', cabin: 'Economy', earningOnly: true };
const extract = source => source.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? source;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const round = n => n === null ? null : Math.round(n * 100) / 100;

async function fixture() {
  const handler = createHandler({ now: () => NOW, callTool: async (_tool, args) => searchFixture(args) });
  const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await handler({ method: 'GET', url: '/api/flights?origin=LHR&destination=MAD&departureDate=2026-11-18', headers: { host: 'sam.toys', 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.42' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.results.length > 0, 'experiment needs real normalized fixture cards');
  return res.body;
}

function page(script, data, session = new Map(), navigation = {}) {
  const writes = [], calls = [], pending = new Set(), listeners = {};
  const classes = () => {
    const values = new Set();
    return { add: x => values.add(x), remove: x => values.delete(x), contains: x => values.has(x), toggle(x, force) { const on = force ?? !values.has(x); on ? values.add(x) : values.delete(x); return on; } };
  };
  const element = () => ({ textContent: '', style: { setProperty() {} }, classList: classes(), setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], querySelector: () => null, getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 100, height: 40 }), animate: () => ({ finished: Promise.resolve() }) });
  const elements = Object.fromEntries(['#app', '#ring', '#toast'].map(key => [key, element()]));
  let html = '';
  Object.defineProperty(elements['#app'], 'innerHTML', { get: () => html, set(value) { html = value; writes.push({ at: performance.now(), html: value }); } });
  const location = { hash: navigation.hash || '#/search' }, local = new Map();
  const history = { state: navigation.state || null, replaceState(state, _title, hash) { this.state = state; location.hash = hash; }, pushState(state, _title, hash) { this.state = state; location.hash = hash; } };
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) });
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const media = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const window = { scrollTo() {}, matchMedia: media, addEventListener(name, fn) { listeners[name] = fn; } };
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, Date: FixedDate, location, window, performance, matchMedia: media,
    history,
    document: { title: '', body: { classList: classes() }, querySelector: key => elements[key] || null, querySelectorAll: () => [], addEventListener() {}, activeElement: null },
    localStorage: storage(local), sessionStorage: storage(session),
    requestAnimationFrame: fn => setTimeout(() => fn(performance.now()), 0), cancelAnimationFrame: clearTimeout,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); if (ms > 1000) timer.unref(); return timer; }, clearTimeout,
    fetch(url) {
      const action = new URL(url, 'https://sam.toys').searchParams.get('action');
      const call = { action, at: performance.now(), resolvedAt: null };
      calls.push(call);
      const task = sleep(DELAY_MS).then(() => { call.resolvedAt = performance.now(); return { ok: true, json: async () => structuredClone(action === 'flex' ? { action: 'flex', results: [], meta: {} } : data) }; });
      pending.add(task); task.finally(() => pending.delete(task));
      return task;
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'flights/cities.js'), 'utf8'), context);
  const initStart = performance.now();
  vm.runInContext(script, context, { filename: 'flights-inline.js' });
  const initMs = performance.now() - initStart;
  context.perfQuery = query;
  vm.runInContext('Object.assign(S, perfQuery)', context);
  return { context, writes, calls, pending, listeners, location, history, session, initMs, run: code => vm.runInContext(code, context) };
}

async function searchMeasurement(p) {
  const writeStart = p.writes.length, callStart = p.calls.length, start = performance.now();
  await p.run('search()');
  const finished = performance.now();
  // Collect parallel flex completion too, without including it in search time.
  await Promise.all([...p.pending]);
  await sleep(0);
  const writes = p.writes.slice(writeStart), calls = p.calls.slice(callStart);
  return {
    firstDomWriteMs: round(writes.length ? writes[0].at - start : null),
    searchReadyMs: round(finished - start),
    requests: calls.map(call => ({ action: call.action, startMs: round(call.at - start) })),
    skeletonBeforeProvider: writes.some(write => write.at < (calls.find(call => call.action === 'search')?.resolvedAt ?? start) && /aria-busy="true"|class="(?:[^" ]* )?skeleton/.test(write.html)),
    parallelFlexBeforeSearchResponse: !!calls.find(call => call.action === 'flex' && call.at < (calls.find(search => search.action === 'search')?.resolvedAt ?? 0)),
    route: p.location.hash,
  };
}

async function measure(script, data, runs) {
  const cold = [], revisit = [], restored = [], historyRestore = [];
  for (let i = 0; i < runs; i++) {
    const p = page(script, data);
    cold.push(await searchMeasurement(p));
    const resultNavigation = { hash: p.location.hash, state: structuredClone(p.history.state) };
    const directRestore = page(script, data, p.session, resultNavigation);
    historyRestore.push({ inlineInitMs: round(directRestore.initMs), restoredResults: directRestore.run("response?.action==='search'&&searchState==='ready'"), searchRequests: directRestore.calls.filter(call => call.action === 'search').length });
    await Promise.all([...directRestore.pending]);
    p.run("go('#/search')");
    revisit.push(await searchMeasurement(p));
    const reload = page(script, data, p.session);
    restored.push(await searchMeasurement(reload));
  }
  const summarize = samples => ({
    medianFirstDomWriteMs: round(median(samples.map(s => s.firstDomWriteMs))),
    medianSearchReadyMs: round(median(samples.map(s => s.searchReadyMs))),
    searchRequestsPerRun: samples.map(s => s.requests.filter(r => r.action === 'search').length),
    flexRequestsPerRun: samples.map(s => s.requests.filter(r => r.action === 'flex').length),
    skeletonBeforeProviderPerRun: samples.map(s => s.skeletonBeforeProvider),
    parallelFlexBeforeSearchResponsePerRun: samples.map(s => s.parallelFlexBeforeSearchResponse),
    firstTrace: samples[0],
  });
  return { cold: summarize(cold), samePageRevisit: summarize(revisit), newPageSessionRestore: summarize(restored), directHistorySessionRestore: { medianInlineInitMs: round(median(historyRestore.map(sample => sample.inlineInitMs))), restoredResultsPerRun: historyRestore.map(sample => sample.restoredResults), searchRequestsPerRun: historyRestore.map(sample => sample.searchRequests) } };
}

async function main() {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const runs = Number(value('--runs') || 5);
  assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 20);
  const data = await fixture();
  const output = { environment: 'Node VM; stub DOM; reduced motion; no browser or live network', node: process.version, runs, simulatedProviderDelayMs: DELAY_MS };
  if (value('--baseline')) output.before = await measure(extract(fs.readFileSync(value('--baseline'), 'utf8')), data, runs);
  output.after = await measure(extract(fs.readFileSync(path.join(root, 'flights/index.html'), 'utf8')), data, runs);
  if (args.includes('--verify')) {
    assert.ok(output.after.cold.skeletonBeforeProviderPerRun.every(Boolean), 'cold search must write its skeleton before provider response');
    assert.ok(output.after.cold.parallelFlexBeforeSearchResponsePerRun.every(Boolean), 'flex must start before search response');
    assert.ok(output.after.samePageRevisit.searchRequestsPerRun.every(n => n === 0), 'repeat query must reuse cached search');
    assert.ok(output.after.newPageSessionRestore.searchRequestsPerRun.every(n => n === 0), 'new page must reuse session search cache');
    assert.ok(output.after.directHistorySessionRestore.restoredResultsPerRun.every(Boolean), 'result history entry must restore cached results');
    assert.ok(output.after.cold.medianFirstDomWriteMs < 100, 'VM shell feedback median must be below 100 ms');
    output.verification = '6 performance contracts passed';
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { measure, page, searchMeasurement };
