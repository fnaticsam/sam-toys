/* Run explicitly: node tests/flights/browser-check.cjs
 * Uses only the real local handler with recorded/synthetic fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixtureServer, NOW } = require('./fixture-server.cjs');

async function main() {
  let playwright;
  if (process.env.FLIGHTS_PLAYWRIGHT_MODULE) playwright = require(process.env.FLIGHTS_PLAYWRIGHT_MODULE);
  else {
    try { playwright = require('playwright'); }
    catch { playwright = require('/Users/sammathews/Code/proto-feedback/node_modules/playwright'); }
  }
  const out = path.resolve(process.env.FLIGHTS_SCREENSHOT_DIR || '/tmp/flights-browser-qa');
  await fs.mkdir(out, { recursive: true });
  let fixture, browser;
  const passed = [], failed = [], screenshots = [];
  const check = async (name, fn) => {
    try { await fn(); passed.push(name); }
    catch (e) { failed.push({ name, error: e.stack }); throw e; }
  };
  try {
    fixture = await createFixtureServer();
    browser = await playwright.chromium.launch({ headless: true });
    for (const width of [1280, 390]) {
      const name = width === 1280 ? 'desktop' : 'phone';
      const context = await browser.newContext({ viewport: { width, height: 960 }, deviceScaleFactor: 1 });
      // Block external requests: the UI is self-contained and QA must never
      // contact a live provider even if a regression adds an external request.
      await context.route('**/*', route => new URL(route.request().url()).origin === fixture.url || route.request().url().startsWith('data:') ? route.continue() : route.abort());
      const page = await context.newPage(), pageErrors = [], canceled = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('requestfailed', request => { if (request.url().includes('/api/flights')) canceled.push(request.url()); });
      await page.clock.setFixedTime(new Date(NOW));
      const snap = async label => {
        const file = path.join(out, `${name}-${label}.png`);
        await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${label}: horizontal overflow`);
      };
      const search = async () => { await page.locator('#go').click(); await page.locator('.row').first().waitFor(); };
      const showSearch = async () => { await page.goto(fixture.url + '/flights#/search'); await page.locator('#to').waitFor(); };
      const destination = async (code = 'MAD') => {
        await page.locator('#to').fill(code); await page.locator(`.pop [data-to="${code}"]`).click();
      };
      const dates = async (returning = false) => {
        if (!await page.locator('#cal').isVisible()) await page.locator('#whenBtn').click();
        if (!await page.locator('[data-k="2026-11-18"]').count()) await page.locator('#nm').click();
        if (await page.locator('#clr').count()) await page.locator('#clr').click();
        await page.locator('[data-k="2026-11-18"]').click();
        if (returning) await page.locator('[data-k="2026-11-21"]').click();
      };
      await check(`${name}: static shell and initial design`, async () => {
        fixture.setMode('normal'); await showSearch();
        assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
        assert.equal(await page.locator('#to').getAttribute('placeholder'), 'Where to?');
        assert.match(await page.locator('#fromBtn').innerText(), /From\s+London/);
        await snap('search');
        // Same viewport reference screenshots support direct visual comparison.
        const ref = await context.newPage(); await ref.goto(fixture.url + '/approved#/search');
        const file = path.join(out, `${name}-approved-search.png`);
        await ref.screenshot({ path: file, fullPage: true }); screenshots.push(file); await ref.close();
      });
      await check(`${name}: origin controls and custom airport`, async () => {
        await page.locator('#fromBtn').click();
        assert.equal(await page.locator('.acts').evaluate(el => getComputedStyle(el).visibility), 'hidden');
        assert.equal(await page.locator('#fromPop .opt.on').evaluate(el => el === document.activeElement), true);
        await snap('origin-menu');
        assert.match(await page.locator('#fromPop').innerText(), /London.*all airports/s);
        await page.locator('[data-from="IBZ"]').click();
        assert.match(await page.locator('#fromBtn').innerText(), /Ibiza/);
        await page.locator('#fromBtn').click(); await page.locator('#fromQ').fill('LHR');
        await page.locator('[data-from2="LHR"]').click();
        assert.match(await page.locator('#fromBtn').innerText(), /Heathrow|LHR/);
        await page.locator('#fromBtn').click(); await page.locator('[data-from="LON"]').click();
      });
      await check(`${name}: Anywhere first and keyboard destination selection`, async () => {
        await page.locator('#to').focus();
        assert.equal(await page.locator('.acts').evaluate(el => getComputedStyle(el).visibility), 'hidden');
        assert.equal(await page.locator('.pop [data-to]').first().getAttribute('data-to'), 'ANY');
        const option = page.locator('[data-to="MAD"]');
        assert(await option.evaluate(el => { const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }));
        await snap('destination-menu');
        await page.locator('#to').fill('MAD'); await page.locator('#to').press('ArrowDown'); await page.locator('#to').press('Enter');
        await page.locator('#cal').waitFor(); assert.match(await page.locator('#to').inputValue(), /Madrid/);
      });
      await check(`${name}: one calendar one-way and return dates`, async () => {
        if (!await page.locator('[data-k="2026-11-18"]').count()) await page.locator('#nm').click();
        await snap('calendar');
        await page.locator('[data-k="2026-11-18"]').click();
        assert.match(await page.locator('#whenBtn').innerText(), /one way/);
        await page.locator('[data-k="2026-11-21"]').click();
        assert(!/one way/.test(await page.locator('#whenBtn').innerText()));
        await page.locator('#clr').click();
        await page.locator('[data-k="2026-11-18"]').click();
      });
      await check(`${name}: calendar switch uses real flex discovery prices`, async () => {
        const flexResponse = page.waitForResponse(r => r.url().includes('/api/flights?') && new URL(r.url()).searchParams.get('action') === 'flex');
        await page.locator('#pt').click(); await flexResponse;
        await page.locator('.calnote').filter({ hasText: /discovery prices/ }).waitFor();
        assert.match(await page.locator('[data-k="2026-11-18"]').innerText(), /£62\b/);
        await snap('calendar-prices'); await page.locator('#pt').click();
      });
      await check(`${name}: live handler one-way prices, tier points and real booking link`, async () => {
        await page.locator('#cabin').selectOption({ label: 'Economy' });
        await search(); await snap('results');
        assert.equal(await page.locator('.row').count(), 4);
        assert.match(await page.locator('.row .m').first().innerText(), /^[A-Z]{3} ·/);
        assert.match(await page.locator('.row .p').first().innerText(), /^£[\d,]+$/);
        const last = fixture.requests.filter(r => new URL(r.url, fixture.url).searchParams.get('action') === 'search').at(-1);
        const params = new URL(last.url, fixture.url).searchParams;
        assert.equal(params.get('origin'), 'LHR,LGW,LCY,STN,LTN,SEN');
        assert.equal(params.get('fareClass'), 'economy'); assert.equal(params.has('returnDate'), false);
        const data = await (await fetch(fixture.url + last.url)).json();
        assert(data.results.some(f => f.hiddenCity));
        assert(data.results.every((f, i, all) => !i || f.gbpPerTierPoint >= all[i - 1].gbpPerTierPoint));
        await page.locator('.row').first().click(); await page.locator('#book').waitFor();
        const href = await page.locator('#book').getAttribute('href');
        assert.equal(href, data.results[0].deepLink);
        assert.match(await page.locator('.hero').innerText(), new RegExp(String(data.results[0].estimate.tierPoints) + '\\s*TP'));
        await snap('fare');
        await page.locator('a.back').click(); await page.locator('.row').first().waitFor();
        const hidden = data.results.find(f => f.hiddenCity);
        await page.locator(`a.row[href="#/fare/${encodeURIComponent(hidden.id)}"]`).click();
        await page.locator('#book').waitFor(); await snap('hidden-city');
        assert.match(await page.locator('.who').innerText(), /Iberia · Economy · cabin bag only/);
        assert.match(await page.locator('.lg').first().innerText(), /^IB714 · 2h30$/);
        assert.match(await page.locator('.lg.ghost').innerText(), /^IB411 · 1h$/);
        assert.match(await page.locator('.st.ghost').innerText(), /Barcelona · BCN/);
        assert.equal(await page.locator('.est').count(), 0);
        assert.match(await page.locator('#app').innerText(), /Skipping a sector can invalidate the ticket and credit\./);
      });
      await check(`${name}: return amounts and tier points are backend totals`, async () => {
        await showSearch(); await destination(); await dates(true); await search();
        await snap('return-results');
        const last = fixture.requests.filter(r => new URL(r.url, fixture.url).searchParams.get('action') === 'search').at(-1);
        assert.equal(new URL(last.url, fixture.url).searchParams.get('returnDate'), '2026-11-21');
        const data = await (await fetch(fixture.url + last.url)).json();
        assert(data.results.every(f => !f.hiddenCity));
        assert.equal(data.results[0].priceGbp, 93.17); assert.equal(data.results[0].estimate.tierPoints, 66);
        await page.locator('.row').first().click(); await page.locator('#book').waitFor();
        const text = await page.locator('.hero').innerText();
        assert.match(text, /93\.17/); assert.match(text, /66\s*TP/);
        assert.equal(await page.locator('#book').getAttribute('href'), data.results[0].deepLink);
        await snap('return-fare');
      });
      await check(`${name}: Gold editable defaults and persistence`, async () => {
        await page.locator('#ring').click(); await page.locator('#gtp').waitFor();
        assert.equal(await page.locator('#gtp').inputValue(), '0');
        assert.equal(await page.locator('.gring circle').count(), 1);
        await snap('gold-zero');
        assert.equal(await page.locator('#gtarget').inputValue(), '20000');
        assert.equal(await page.locator('#gend').inputValue(), '2027-03-31');
        await page.locator('#gtp').fill('12500'); await page.locator('#gtarget').fill('21000');
        await page.locator('#gend').fill('2027-03-30'); await page.locator('button[form="gf"]').click();
        await page.reload(); await page.locator('#gtp').waitFor();
        assert.equal(await page.locator('#gtp').inputValue(), '12500');
        assert.equal(await page.locator('#gtarget').inputValue(), '21000');
        assert.equal(await page.locator('#gend').inputValue(), '2027-03-30'); await snap('gold');
      });
      await check(`${name}: loading, empty, error, 429 and partial states`, async () => {
        for (const mode of ['loading', 'empty', 'error', 'throttled', 'partial']) {
          fixture.setMode(mode); await showSearch(); await destination(); await dates();
          const cancelled = mode === 'loading' ? page.waitForEvent('requestfailed', { predicate: r => r.url().includes('/api/flights?') }) : null;
          await page.locator('#go').click();
          if (mode === 'loading') await page.locator('.spin').waitFor();
          else if (mode === 'partial') { await page.locator('.row').first().waitFor(); assert.match(await page.locator('#app').innerText(), /didn.t answer/i); }
          else await page.locator('.state').waitFor();
          const text = await page.locator('#app').innerText();
          if (mode === 'empty') assert.match(text, /No earning fares/);
          if (mode === 'error') assert.match(text, /unavailable|didn.t answer|failed/i);
          if (mode === 'throttled') assert.match(text, /Too many|busy|Slow|wait|requests/i);
          await snap(mode);
          await page.locator('a.back').click(); await page.locator('#to').waitFor();
          if (cancelled) await cancelled;
        }
      });
      await check(`${name}: Anywhere discovery and route search`, async () => {
        fixture.setMode('normal'); await showSearch(); await page.locator('#to').fill(''); await page.locator('#to').focus();
        await page.locator('[data-to="ANY"]').click(); await dates(); await search();
        const last = fixture.requests.at(-1); assert.equal(new URL(last.url, fixture.url).searchParams.get('action'), 'anywhere');
        assert.match(await page.locator('#app').innerText(), /unfiltered|discovery|unverified/i);
        assert.equal(await page.locator('.row .tm').count(), 41);
        assert.equal(await page.locator('.row .tm').allTextContents().then(cities => new Set(cities).size), 41);
        assert.equal(await page.locator('.row .tm').filter({hasText:/^BOD$/}).count(), 0);
        assert.equal(await page.locator('.row .v').first().evaluate(el => getComputedStyle(el).color), 'rgb(13, 13, 15)');
        await snap('anywhere');
        await page.locator('.row').filter({ hasText: 'Madrid' }).first().click(); await page.locator('.row').first().waitFor();
        const routeParams = new URL(fixture.requests.at(-1).url, fixture.url).searchParams;
        assert.equal(routeParams.get('action'), 'search');
        assert.equal(routeParams.get('origin'), 'LHR,LGW,LCY,STN,LTN,SEN');
      });
      await check(`${name}: cabin forwarded and destination removed from explicit London origins`, async () => {
        await showSearch(); await destination('LHR'); await dates();
        await page.locator('#cabin').selectOption({ label: 'Business' }); await search();
        const params = new URL(fixture.requests.at(-1).url, fixture.url).searchParams;
        assert.equal(params.get('fareClass'), 'business'); assert.equal(params.get('origin'), 'LGW,LCY,STN,LTN,SEN');
      });
      await check(`${name}: stale response aborted on navigation and newer search wins`, async () => {
        fixture.setMode('loading'); await showSearch(); await destination(); await dates();
        const cancelled = page.waitForEvent('requestfailed', { predicate: r => r.url().includes('/api/flights?') });
        await page.locator('#go').click(); await page.locator('.spin').waitFor();
        await page.locator('a.back').click(); await page.locator('#to').waitFor();
        await cancelled;
        fixture.setMode('normal'); await destination('JFK');
        // Existing selected date survives the return to the form.
        await search(); assert.match(await page.locator('a.back').innerText(), /New York|JFK/);
        assert(canceled.length > 0, 'navigation must abort the obsolete API fetch');
        assert.equal(await page.locator('#to').count(), 0);
      });
      await check(`${name}: no uncaught page errors`, async () => assert.deepEqual(pageErrors, []));
      await context.close();
    }
  } catch (error) {
    if (!failed.length) failed.push({ name: 'browser runtime startup', error: error.stack });
    throw error;
  } finally {
    if (browser) await browser.close(); if (fixture) await fixture.close();
    const report = { passed: passed.length, failed: failed.length, checks: passed, failures: failed, screenshots,
      fixtureRequests: fixture?.requests.length || 0, fixtureProviderCalls: fixture?.toolCalls.length || 0, liveProviderCalls: 0 };
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}
module.exports = { main };
if (require.main === module) main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
