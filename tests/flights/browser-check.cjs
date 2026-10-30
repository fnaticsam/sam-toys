/* Run explicitly: node tests/flights/browser-check.cjs
 * Real local handler + recorded/synthetic fixtures; never live provider data.
 * Do not run in the implementation sandbox. The browser reviewer runs this.
 * Optional FLIGHTS_BASELINE_PAGE=/absolute/path/to/pre-change.html records a
 * before/after interaction measurement against the same held provider request. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFixtureServer, NOW } = require('./fixture-server.cjs');

// Runs before page code so timing starts at the actual input, before handlers.
function installMetrics() {
  window.__flightMetrics = { inputs: [], shifts: [] };
  for (const type of ['pointerdown', 'click', 'keydown', 'change', 'input']) {
    addEventListener(type, event => {
      if (!event.isTrusted || event.type === 'keydown' && !['Enter', ' ', 'ArrowDown', 'Tab'].includes(event.key)) return;
      const start = performance.now(), target = event.target.closest('[id],[data-sort],[data-from],[data-k],[data-day]');
      requestAnimationFrame(() => window.__flightMetrics.inputs.push({ type, target: target?.id || target?.getAttribute('data-sort') || target?.getAttribute('data-k') || target?.tagName, ms: performance.now() - start }));
    }, true);
  }
  try { new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__flightMetrics.shifts.push(entry.value);
  }).observe({ type: 'layout-shift', buffered: true }); } catch {}
}

async function main() {
  let playwright;
  if (process.env.FLIGHTS_PLAYWRIGHT_MODULE) playwright = require(process.env.FLIGHTS_PLAYWRIGHT_MODULE);
  else {
    try { playwright = require('playwright'); }
    catch { throw new Error('Install Playwright on the browser host or set FLIGHTS_PLAYWRIGHT_MODULE to its existing module path.'); }
  }
  const out = path.resolve(process.env.FLIGHTS_SCREENSHOT_DIR || '/tmp/flights-browser-qa');
  await fs.mkdir(out, { recursive: true });
  let fixture, browser;
  const passed = [], failed = [], screenshots = [], performanceResults = [];
  let cardMotion = [];
  const check = async (name, fn) => {
    try { await fn(); passed.push(name); }
    catch (e) { failed.push({ name, error: e.stack }); throw e; }
  };
  const permitFixtureOnly = context => context.route('**/*', route => new URL(route.request().url()).origin === fixture.url || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  // Geometric checks intentionally use the visible centre. Locator.click's
  // fallback point can conceal an overlay covering the actual go button.
  const centre = async (page, selector, touch = false) => {
    const handle = await page.waitForFunction(selector => {
      const el = document.querySelector(selector);if(!el)return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : false;
    }, selector);
    const point = await handle.jsonValue();await handle.dispose();
    assert(await page.evaluate(({ selector, x, y }) => !!document.elementFromPoint(x, y)?.closest(selector), { ...point, selector }), `${selector} is covered at its visible centre`);
    if (touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
  };
  const landed = async (page, group, target) => {
    await page.waitForFunction(([group, target]) => {
      const h = document.querySelector(group)?.querySelector(':scope > .glide'), t = document.querySelector(target);
      if (!h || !t) return false;
      const a = h.getBoundingClientRect(), b = t.getBoundingClientRect();
      return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) <= 0.75;
    }, [group, target]);
  };
  const inactiveMotion = page => page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getComputedTiming().endTime > 1).length);
  try {
    fixture = await createFixtureServer();
    browser = await playwright.chromium.launch({ headless: true });
    for (const width of [1280, 390]) {
      const name = width === 1280 ? 'desktop' : 'phone', touch = width < 700;
      const context = await browser.newContext({ viewport: { width, height: 960 }, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
      await permitFixtureOnly(context); await context.addInitScript(installMetrics);
      const page = await context.newPage(), pageErrors = [], canceled = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('requestfailed', request => { if (request.url().includes('/api/flights')) canceled.push(request.url()); });
      await page.clock.setFixedTime(new Date(NOW));
      const snap = async label => {
        const file = path.join(out, `${name}-${label}.png`);
        await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} ${label}: horizontal overflow`);
      };
      const searches = () => fixture.requests.filter(r => new URL(r.url, fixture.url).searchParams.get('action') === 'search');
      const lastSearch = () => searches().at(-1);
      const searchParams = () => new URL(lastSearch().url, fixture.url).searchParams;
      // Reset the session result cache between independent scenarios. Cache is
      // tested separately; otherwise it could conceal error/loading fixtures.
      const home = async (clearCache = true) => {
        if (clearCache && page.url().startsWith(fixture.url)) await page.evaluate(() => sessionStorage.clear());
        await page.goto(fixture.url + '/flights#/search'); if (clearCache) await page.reload(); await page.locator('#to').waitFor();
      };
      const destination = async (code = 'MAD') => {
        await page.locator('#to').fill(code); await centre(page, `.pop [data-to="${code}"]`, touch);
      };
      const origin = async code => {
        const pill = page.locator(`.orow [data-from="${code}"]`);
        if (await pill.count()) await centre(page, `.orow [data-from="${code}"]`, touch);
        else { await page.locator('#fromQ').fill(code); await centre(page, `#fromRes [data-from2="${code}"]`, touch); }
      };
      const day = async key => {
        while (!await page.locator(`[data-k="${key}"]`).isVisible()) await page.locator('#nm').click();
        await centre(page, `[data-k="${key}"]`, touch);
      };
      const dates = async (returning = false) => {
        if (await page.locator('#clr').count()) await page.locator('#clr').click();
        await day('2026-11-18'); if (returning) await day('2026-11-21');
      };
      const search = async () => { await centre(page, '#go', touch); await page.locator('#cards .fc').first().waitFor(); };
      const prepare = async (cabin = 'Economy', returning = false) => {
        fixture.setMode('normal'); await home(); await origin('LON'); await destination(); await dates(returning); await page.locator('#cabin').selectOption({ label: cabin });
      };
      const openFilters = async () => {
        if (touch && !await page.locator('body').evaluate(el => el.classList.contains('sheet'))) await page.locator('#fopen').click();
        await page.locator('#earningOnly').waitFor({ state: 'visible' });
      };
      const closeFilters = async () => { if (touch && await page.locator('body').evaluate(el => el.classList.contains('sheet'))) await page.locator('#fshow').click(); };
      await check(`${name}: approved v4 home, preloaded fonts, compact calendar and pill row`, async () => {
        fixture.setMode('normal'); await home();
        assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
        assert.equal(await page.locator('#to').getAttribute('placeholder'), 'City or airport');
        assert.match(await page.locator('h1').innerText(), /Where to\?/);
        assert.equal(await page.locator('[data-from="LON"]').getAttribute('class').then(c => c.includes('on')), true);
        assert.equal(await page.locator('#go').getAttribute('aria-label'), 'Search');
        assert(await page.locator('#cal').isVisible());
        assert.equal(await page.locator('#cal .mon:visible').count(), touch ? 1 : 2);
        assert.deepEqual(await page.locator('#cal .mon:visible').first().locator('.dow').allTextContents(), ['M','T','W','T','F','S','S']);
        assert.equal(await page.locator('link[rel="preload"][as="font"][href$=".woff2"]').count(), 2);
        assert.equal(await page.evaluate(() => localStorage.getItem('flights.gold.live.v1')), null);
        assert.equal(await page.evaluate(() => localStorage.getItem('flights.proto.gold')), null);
        const layout = await page.evaluate(() => {
          const b = s => document.querySelector(s).getBoundingClientRect(), a = b('#anyPill'), o = b('.orow'), s = b('.searchBox'), c = b('.cabinw');
          return { aligned: Math.abs(a.left - s.left) <= 1, beforeOrigin: a.right <= o.left, cabinRight: c.right >= o.right, glyph: !!document.querySelector('.orow > svg'), cabinY: c.bottom, searchY: document.querySelector('.gobig')?.getBoundingClientRect().top, searchWidth: document.querySelector('.gobig')?.getBoundingClientRect().width, width: s.width };
        });
        assert(layout.aligned && layout.beforeOrigin && layout.glyph);
        if (touch) { assert(layout.cabinY <= layout.searchY); assert(Math.abs(layout.searchWidth - layout.width) <= 1); }
        else assert(layout.cabinRight);
        await landed(page, '.orow', '[data-from="LON"]'); await snap('search');
        const refContext = await browser.newContext({ viewport: { width, height: 960 } }); await permitFixtureOnly(refContext);
        try {
          const ref = await refContext.newPage(); await ref.clock.setFixedTime(new Date(NOW));
          await ref.goto(fixture.url + '/approved#/search'); await ref.locator('#cal').waitFor();
          const file = path.join(out, `${name}-approved-search.png`); await ref.screenshot({ path: file, fullPage: true }); screenshots.push(file);
        } finally { await refContext.close(); }
      });
      await check(`${name}: visible-centre Go validation with suggestions layered above pills`, async () => {
        await centre(page, '#go', touch);
        assert.equal(await page.locator('#to').evaluate(el => el === document.activeElement), true);
        assert.match(await page.locator('.fieldHint').innerText(), /where|destination/i);
        await page.locator('#to').fill('zzqq'); await centre(page, '#go', touch);
        assert.equal(await page.locator('#toError').innerText(), 'No airport matches “zzqq”.');
        await page.locator('#to').fill('Madrid'); await centre(page, '#go', touch);
        assert.match(await page.locator('.fieldHint').innerText(), /Pick a date/); assert(await page.locator('#cal').isVisible());
        await page.locator('#to').fill('Tokyo'); await page.locator('[data-to="TYO"]').waitFor();
        const layers = await page.locator('.pop').evaluate(pop => {
          const opts = [...pop.querySelectorAll('[data-to]')].filter(el => el.offsetWidth);
          return opts.every(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.pop') === pop; });
        });
        assert(layers, 'suggestions must be clickable above the origin row');
        await home(); await dates(); await page.locator('#to').fill('London Heathrow'); await centre(page,'.pop [data-to="LHR"]',touch); await origin('IBZ'); await search();
        assert.equal(searchParams().get('destination'), 'LHR'); assert.equal(searchParams().get('origin'), 'IBZ');
      });
      await check(`${name}: origin pill slide, custom city, persistence and phone suggestions fit`, async () => {
        await home(); await origin('IBZ'); await landed(page, '.orow', '[data-from="IBZ"]');
        await page.reload(); await landed(page, '.orow', '[data-from="IBZ"]');
        await page.locator('#fromQ').fill('Barc'); await page.locator('#fromRes [data-from2="BCN"]').waitFor();
        const box = await page.locator('#fromRes').boundingBox(); assert(box.x >= 0 && box.x + box.width <= width);
        await centre(page, '#fromRes [data-from2="BCN"]', touch); await landed(page, '.orow', '#fromQ');
        assert.equal(await page.locator('#fromQ').inputValue(), 'Barcelona'); await page.reload();
        assert.equal(await page.locator('#fromQ').inputValue(), 'Barcelona'); await landed(page, '.orow', '#fromQ');
        await origin('LON');
        if (!touch) {
          await page.hover('[data-from="IBZ"]'); await landed(page, '.orow', '[data-from="IBZ"]');
          assert.equal(await page.locator('.orow > .glide').getAttribute('data-mode'), 'tint');
          await page.mouse.move(5, 5); await landed(page, '.orow', '[data-from="LON"]');
          await page.locator('[data-from="LON"]').focus(); await page.keyboard.press('Tab');
          await landed(page, '.orow', '[data-from="IBZ"]');
          assert.equal(await page.locator('.orow > .glide').evaluate(el => el.style.transition), 'none');
        }
      });
      await check(`${name}: calendar remains open, one/two taps, cross-month range, clear and £/TP`, async () => {
        await home(); await origin('LON'); await destination(); await dates();
        assert.equal(await page.evaluate(() => S.back), ''); assert(await page.locator('#cal').isVisible());
        await day('2026-11-21'); assert.equal(await page.evaluate(() => S.back), '2026-11-21');
        await page.locator('#clr').click(); assert.deepEqual(await page.evaluate(() => [S.out,S.back]), ['', '']);
        await day('2026-11-30'); await day('2026-12-02');
        assert.deepEqual(await page.evaluate(() => [S.out,S.back]), ['2026-11-30','2026-12-02']);
        assert(await page.locator('#cal .d.in').count() >= 2); await snap('calendar-range');
        const month = await page.locator('.mon:visible .mname').first().innerText();
        const calendarMotion = await page.evaluate(() => {
          document.querySelector('#nm').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.querySelector('#nm').click();
          return document.querySelector('#cal .months').getAnimations().map(a=>({frames:a.effect.getKeyframes(),duration:a.effect.getTiming().duration}));
        });
        assert(calendarMotion.some(a=>a.frames.some(f=>/translateX/.test(f.transform))&&a.duration<=300));
        assert.notEqual(await page.locator('.mon:visible .mname').first().innerText(), month); await page.locator('#pm').click();
        await home(); await destination(); await dates(); await page.locator('#cabin').selectOption({ label:'Business' });
        const flexResponse = page.waitForResponse(r => r.url().includes('/api/flights?') && new URL(r.url()).searchParams.get('action') === 'flex');
        await page.locator('#pt').click(); const response = await flexResponse;
        assert.equal(new URL(response.url()).searchParams.get('fareClass'), 'business');
        await page.locator('.calnote').filter({ hasText: /discovery prices/ }).waitFor();
        assert.match(await page.locator('[data-k="2026-11-18"]').innerText(), /£/); await snap('calendar-prices');
      });
      await check(`${name}: visible-centre Go works with suggestions open; keyboard highlighted Enter`, async () => {
        await prepare(); await page.locator('#to').fill('Madrid'); await search();
        assert.equal(searchParams().get('destination'), 'MAD'); assert.equal(searchParams().get('origin'), 'LON');
        assert.equal(searchParams().get('fareClass'), 'economy'); assert.equal(searchParams().get('limit'), '100');
        assert.equal(searchParams().get('earningOnly'), 'true'); assert.equal(await page.locator('#cal').count(), 0);
        assert.equal(await page.locator('#cards .fc').count(), 4); assert.equal(await page.locator('.fc .sel').first().innerText(), 'Select');
        assert((await page.locator('.fc .prc').allTextContents()).every(t => /^£[\d,]+$/.test(t)));
        await snap('results');
        await home(); await dates(); await page.locator('#to').fill('Tokyo'); await page.locator('[data-to="NRT"]').waitFor();
        await page.locator('#to').press('ArrowDown'); await page.locator('#to').press('ArrowDown'); await page.locator('#to').press('ArrowDown');
        assert.equal(await page.locator('#to').getAttribute('aria-activedescendant'), 'suggest-NRT');
        await page.locator('#to').press('Enter'); await page.locator('#cards .fc').first().waitFor(); assert.equal(searchParams().get('destination'), 'NRT');
      });
      await check(`${name}: nearby ±3 strip uses flex cabin, price marking and keeps return length`, async () => {
        await prepare('Business', true); const before = fixture.requests.length; await search();
        await page.locator('#dstrip .dday b').filter({ hasText: /£/ }).first().waitFor();
        assert.equal(await page.locator('#dstrip .dday').count(), 7);
        assert.deepEqual(await page.locator('#dstrip .dday').evaluateAll(els => els.map(el => el.dataset.day)), ['2026-11-15','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-21']);
        const flex = fixture.requests.slice(before).map(r => new URL(r.url, fixture.url)).find(u => u.searchParams.get('action') === 'flex');
        assert(flex); assert.equal(flex.searchParams.get('fareClass'), 'business'); assert.equal(flex.searchParams.get('returnDate'), '2026-11-21');
        const prices=(await page.locator('#dstrip .dday b').allTextContents()).map(t=>Number(t.replace(/[^0-9.]/g,''))).filter(n=>n>0);
        const min=Math.min(...prices),max=Math.max(...prices);
        assert.equal(await page.locator('#dstrip .dday.low').count(),min<max?prices.filter(p=>p===min).length:0);
        await page.locator('#dstrip [data-day="2026-11-19"]').click(); await page.locator('#cards .fc').first().waitFor();
        assert.equal(searchParams().get('departureDate'), '2026-11-19'); assert.equal(searchParams().get('returnDate'), '2026-11-22');
        assert.equal(searchParams().get('fareClass'), 'business');
        await landed(page,'.ddays','#dstrip .dday.on');await snap('nearby-dates');
      });
      await check(`${name}: skip-last-leg chips, dashed continuation, Show Hide Only and sliding highlight`, async () => {
        await prepare(); await search(); const total = await page.locator('#cards .fc').count(), skip = await page.locator('.tag.skip').count();
        assert(skip > 0); assert.equal(await page.locator('.skipx').count(), skip);
        assert((await page.locator('.skipx .sd i').evaluateAll(els => els.map(el => getComputedStyle(el).borderTopStyle))).every(style => style === 'dashed'));
        await openFilters(); await landed(page, '.seg3', '.seg3 label:first-of-type span');
        await page.locator('.seg3 label').filter({ hasText: /^Only$/ }).click(); await landed(page, '.seg3', '.seg3 label:nth-of-type(3) span');
        assert.equal(await page.locator('#cards .fc').count(), skip); assert.equal(await page.locator('.tag.skip').count(), skip);
        await page.locator('.seg3 label').filter({ hasText: /^Hide$/ }).click();
        assert.equal(await page.locator('#cards .fc').count(), total - skip); assert.equal(await page.locator('.tag.skip').count(), 0);
        await page.locator('.seg3 label').filter({ hasText: /^Show$/ }).click(); assert.equal(await page.locator('#cards .fc').count(), total); await closeFilters();
      });
      await check(`${name}: fare detail uses actual totals, safe link and skipped leg`, async () => {
        const data = await (await fetch(fixture.url + lastSearch().url)).json(), hidden = data.results.find(f => f.hiddenCity); assert(hidden);
        await page.locator(`a.sel[href="#/fare/${encodeURIComponent(hidden.id)}"]`).click(); await page.locator('#book').waitFor();
        assert.equal(await page.locator('#book').getAttribute('href'), hidden.deepLink);
        assert.match(await page.locator('.hero').innerText(), new RegExp(String(hidden.estimate.tierPoints) + '\\s*TP'));
        assert.match(await page.locator('.lg.ghost').innerText(), /^IB 411 · 1h$/);
        assert.match(await page.locator('.st.ghost').innerText(), /Barcelona · BCN/);
        assert.match(await page.locator('#app').innerText(), /Skipping a sector can invalidate the ticket and credit\./);
        await snap('hidden-fare'); await page.locator('a.back').click(); await page.locator('#cards .fc').first().waitFor();
      });
      await check(`${name}: sorts highlight, no-network FLIP and independent filters`, async () => {
        const before = fixture.requests.length; cardMotion=[];
        for (const key of ['tp','cheap','fast','value']) {
          const captured=await page.evaluate(key=>{
            const el=document.querySelector(`[data-sort="${key}"]`);el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));el.click();
            return [...document.querySelectorAll('#cards .fc')].flatMap(el=>el.getAnimations().map(a=>({frames:a.effect.getKeyframes(),duration:a.effect.getTiming().duration,delay:a.effect.getTiming().delay})));
          },key);cardMotion.push(...captured); assert.equal(await page.locator(`[data-sort="${key}"]`).getAttribute('aria-selected'),'true');
          await landed(page, '.tabs', `[data-sort="${key}"]`);
        }
        assert.equal(fixture.requests.length, before);
        assert(cardMotion.length>0,'changed sort order should animate card positions');
        assert(cardMotion.every(a=>a.duration<=220&&a.delay===0&&a.frames.every(f=>f.transform&&!Object.hasOwn(f,'opacity'))),'FLIP must use transform alone');
        await openFilters(); assert.equal(await page.locator('input[name="stops"]').count(), 3);
        assert.equal(await page.locator('.hist i').count(), 48); assert.equal(await page.locator('input[type="range"]').count(), 4);
        await page.locator('input[name="stops"][value="0"]').check();
        await page.locator('#freset').click(); await openFilters();
        const range=page.locator('input[data-r="dep"][data-i="1"]');
        await range.evaluate(el=>{el.value='8';el.dispatchEvent(new Event('input',{bubbles:true}))});
        assert.match(await page.locator('#fopen').innerText(),/Filters ·/);
        await page.locator('#freset').click(); await openFilters();
        for (const airline of await page.locator('.fs input[type="checkbox"]').all()) await airline.uncheck();
        assert.equal(await page.locator('h1').innerText(), 'No flights match these filters');
        assert.equal(await page.locator('#fcol').count(),1); assert.equal(await page.locator('[role="tab"]').count(),4);
        await closeFilters(); await page.locator('#freset2').click(); await page.locator('#cards .fc').first().waitFor();
      });
      await check(`${name}: phone filter sheet closes by button, Escape, backdrop and Show flights`, async () => {
        if (!touch) return;
        for (const way of ['close','escape','backdrop','show']) {
          await openFilters(); assert.equal(await page.locator('#fclose').getAttribute('aria-label'), 'Close filters');
          assert.equal(await page.locator('#fcol').getAttribute('aria-modal'), 'true');
          if (way === 'close') await page.locator('#fclose').click();
          if (way === 'escape') await page.keyboard.press('Escape');
          if (way === 'backdrop') await page.mouse.click(5,5);
          if (way === 'show') await page.locator('#fshow').click();
          assert.equal(await page.locator('body').evaluate(el => el.classList.contains('sheet')), false);
        }
      });
      await check(`${name}: oneworld toggle persists and all-airline fares have neutral No TP`, async () => {
        await openFilters(); await page.locator('#earningOnly').uncheck(); await page.locator('#cards .fc').filter({ hasText:'No TP' }).first().waitFor();
        assert.equal(searchParams().get('earningOnly'), 'false');
        const noTp = page.locator('#cards .fc').filter({hasText:'No TP'}).first(); assert.doesNotMatch(await noTp.innerText(), /\/TP|\+0 TP/);
        await closeFilters(); await snap('all-airlines'); await home(); await destination(); await dates(); await search();
        assert.equal(searchParams().get('earningOnly'), 'false');
        await openFilters(); assert.equal(await page.locator('#earningOnly').isChecked(), false); await page.locator('#earningOnly').check(); await page.locator('#cards .fc').first().waitFor(); await closeFilters();
      });
      await check(`${name}: Starlink display >=50%, local >=80% switch excludes null and keeps boundary`, async () => {
        // Synthetic HTTP mutation deliberately exercises boundaries independent
        // of the dated fleet model. The API still runs the real fixture handler.
        const probabilities = [.92, .8, .799, .5, .499, null];
        const mutate = async route => {
          const res = await route.fetch(), data = await res.json();
          if (data.action === 'search' && data.results.length) {
            const base = data.results.filter(f => !f.hiddenCity)[0];
            data.results = probabilities.map((p,i) => ({ ...base, id:'starlink-boundary-'+i,
              departure:{...base.departure,dateTime:base.departure.dateTime.replace(/T\d{2}:/, 'T'+String(6+i).padStart(2,'0')+':')},
              starlink:{p,basis:'fleet-share',note:'Synthetic boundary fixture; aircraft swaps remain possible.'} }));
          }
          await route.fulfill({ response:res,json:data });
        };
        await page.route('**/api/flights?*', mutate);
        try {
          await prepare(); await search(); assert.equal(await page.locator('#cards .fc').count(),6);
          assert.deepEqual((await page.locator('.fc .sl').allTextContents()).map(s => s.trim()).sort(), ['Starlink 50%','Starlink 80%','Starlink 80%','Starlink 92%'].sort());
          const before = fixture.requests.length; await openFilters(); await page.locator('#starlinkOnly').check();
          assert.equal(await page.locator('#cards .fc').count(),2); assert.equal(fixture.requests.length,before, 'Starlink toggle must not fetch');
          assert.deepEqual((await page.locator('.fc .sl').allTextContents()).map(s=>s.trim()).sort(),['Starlink 80%','Starlink 92%']);
          await closeFilters(); await page.locator('.fc .sel').first().click(); await page.locator('#book').waitFor();
          assert.match(await page.locator('.slf').innerText(), /fleet estimate/); assert.match(await page.locator('.slf').innerText(), /Synthetic boundary fixture/);
          await snap('starlink-fare');
        } finally { await page.unroute('**/api/flights?*',mutate); }
      });
      await check(`${name}: long Business/First fare price columns fit`, async () => {
        const longFare = async route => {
          const res=await route.fetch(),data=await res.json();
          if(data.action==='search')data.results=data.results.map(f=>({...f,priceGbp:12345.67,estimate:{...f.estimate,tierPoints:123456,avios:1234567}}));
          await route.fulfill({response:res,json:data});
        };
        await page.route('**/api/flights?*',longFare);
        try { for (const cabin of ['Business','First']) {
          await prepare(cabin,true); await search();
          assert.equal(await page.locator('.fc .cr').evaluateAll(els => els.filter(el=>el.scrollWidth>el.clientWidth+1 || [...el.querySelectorAll('.prc,.tpv')].some(x=>{const a=x.getBoundingClientRect(),b=el.getBoundingClientRect();return a.right>b.right+1||a.left<b.left-1})).length),0);
          if(!touch)assert.equal(Math.round((await page.locator('.fc .cr').first().boundingBox()).width),248);
          await snap('long-'+cabin.toLowerCase());
        } } finally { await page.unroute('**/api/flights?*',longFare); }
      });
      await check(`${name}: return totals and booking link are not doubled`, async () => {
        await prepare('Economy',true); await search();
        const data=await(await fetch(fixture.url+lastSearch().url)).json();assert(data.results.every(f=>!f.hiddenCity));
        assert.equal(data.results[0].priceGbp,93.17);assert.equal(data.results[0].estimate.tierPoints,66);
        await page.locator('.fc .sel').first().click();await page.locator('#book').waitFor();
        assert.match(await page.locator('.hero').innerText(),/93\.17/);assert.match(await page.locator('.hero').innerText(),/66\s*TP/);
        assert.equal(await page.locator('#book').getAttribute('href'),data.results[0].deepLink);
      });
      await check(`${name}: Gold remains on flights.gold.live.v1 and persists user edits`, async () => {
        await page.locator('#ring').click(); await page.locator('#gtp').waitFor();
        assert.equal(await page.locator('#gtp').inputValue(),'0'); assert.equal(await page.locator('#gtarget').inputValue(),'20000');
        assert.equal(await page.locator('#gend').inputValue(),'2027-03-31'); assert.equal(await page.locator('.gring circle').count(),1);
        await page.locator('#gtp').fill('12500');await page.locator('#gtarget').fill('21000');await page.locator('#gend').fill('2027-03-30');
        await page.locator('button[form="gf"]').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('flights.gold.live.v1')||'{}').tp===12500);await page.reload();await page.locator('#gtp').waitFor();
        assert.equal(await page.locator('#gtp').inputValue(),'12500');assert.equal(await page.locator('#gtarget').inputValue(),'21000');
        assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('flights.gold.live.v1'))),{tp:12500,target:21000,ends:'2027-03-30'});
        assert.equal(await page.evaluate(()=>localStorage.getItem('flights.proto.gold')),null);await snap('gold');
      });
      await check(`${name}: pointerdown prefetch, immediate click skeleton and parallel flex`, async () => {
        await prepare(); fixture.setMode('loading');
        const before=fixture.requests.length,box=await page.locator('#go').boundingBox();
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
        try {
          await page.waitForFunction(()=>window.__flightMetrics.inputs.some(x=>x.type==='pointerdown'&&x.target==='go'));
          // Wait for both held requests to be admitted without fixed sleeps.
          const deadline=Date.now()+5000;
          while(fixture.requests.slice(before).length<2 && Date.now()<deadline)await page.evaluate(()=>new Promise(requestAnimationFrame));
          const actions=fixture.requests.slice(before).map(r=>new URL(r.url,fixture.url).searchParams.get('action'));
          assert(actions.includes('search')&&actions.includes('flex'),'search and flex must start while provider is held');
          assert.equal(actions.filter(a=>a==='search').length,1);
          await page.mouse.up(); await page.locator('[aria-busy="true"]').waitFor();
          assert(await page.locator('.sk,.skeleton').count()>0); assert.equal(await page.locator('.loading-title,.sktabs,.skeleton .rbar').count(),0);
          assert.match(await page.locator('[role="status"]').filter({hasText:'Searching Skiplagged'}).innerText(),/Searching Skiplagged/);
          assert.match(await page.evaluate(()=>location.hash), /loading|results/);
          await page.waitForFunction(()=>window.__flightMetrics.inputs.some(x=>x.type==='click'&&x.target==='go'));
          const clickTiming=await page.evaluate(()=>window.__flightMetrics.inputs.filter(x=>x.type==='click'&&x.target==='go').at(-1).ms);
          assert(clickTiming<100,`Click-to-shell frame took ${clickTiming.toFixed(1)}ms`);performanceResults.push({viewport:width,case:'after-click-shell',ms:clickTiming});
          const timing=await page.evaluate(()=>window.__flightMetrics.inputs.filter(x=>x.type==='pointerdown'&&x.target==='go').at(-1).ms);
          assert(timing<100,`Go's next visual frame took ${timing.toFixed(1)}ms`);performanceResults.push({viewport:width,case:'after-pointerdown-next-frame',ms:timing});
          await snap('skeleton');
        } finally { await page.mouse.up(); fixture.release(); }
        await page.locator('#cards .fc').first().waitFor();
        assert.equal(fixture.requests.slice(before).filter(r=>new URL(r.url,fixture.url).searchParams.get('action')==='search').length,1,'pointerup/click must not duplicate search');
      });
      await check(`${name}: session result cache restores Back/forward and reload without a search request`, async () => {
        fixture.setMode('normal'); const before=searches().length;
        await page.locator('.fc .sel').first().click(); await page.locator('#book').waitFor();
        await page.goBack(); await page.locator('#cards .fc').first().waitFor();
        await page.goForward(); await page.locator('#book').waitFor();
        await page.goBack(); await page.locator('#cards .fc').first().waitFor();
        assert.equal(searches().length,before);
        assert(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>/flight/i.test(k))));
        await page.reload();await page.locator('#cards .fc').first().waitFor();assert.equal(searches().length,before);
        const start=await page.evaluate(()=>performance.now());
        await page.locator('a.back').click();await page.locator('#to').waitFor();await search();
        assert.equal(searches().length,before,'identical query should reuse session cache');
        performanceResults.push({viewport:width,case:'after-cached-query',ms:await page.evaluate(start=>performance.now()-start,start)});
      });
      await check(`${name}: partial, empty, error, busy and canceled requests remain explicit`, async () => {
        for(const mode of ['partial','empty','error','throttled','loading']) {
          await prepare(); fixture.setMode(mode); await centre(page,'#go',touch);
          if(mode==='loading')await page.locator('[aria-busy="true"]').waitFor();
          else if(mode==='partial'){await page.locator('#cards .fc').first().waitFor();assert.match(await page.locator('#app').innerText(),/didn.t (answer|load)/i);}
          else await page.locator('.state').waitFor();
          const text=await page.locator('#app').innerText();
          if(mode==='empty'){assert.match(text,/No earning fares/);assert.match(text,/Other dates/);assert.equal(await page.locator('#allAirlines').innerText(),'All airlines');}
          if(mode==='error')assert.match(text,/unavailable|didn.t answer|failed/i);
          if(mode==='throttled')assert.match(text,/moment|busy|wait|requests/i);
          await snap(mode);await page.locator('a.back').click();await page.locator('#to').waitFor();
        }
        fixture.setMode('normal');assert(canceled.length>0,'navigation must abort the previous fetch');
      });
      await check(`${name}: Anywhere uses chosen origin then explicitly searches destination`, async () => {
        await home();await origin('IBZ');await dates();const before=fixture.requests.length;await centre(page,'#anyPill',touch);
        await page.locator('.list.discovery .row').first().waitFor();
        const request=fixture.requests.slice(before).find(r=>new URL(r.url,fixture.url).searchParams.get('action')==='anywhere');assert(request);
        assert.equal(new URL(request.url,fixture.url).searchParams.get('origin'),'IBZ');
        const cities=await page.locator('.row .tm').allTextContents();assert.equal(cities.length,new Set(cities).size);assert(!cities.includes('Ibiza'));
        assert.equal(searches().filter(r=>fixture.requests.indexOf(r)>=before).length,0,'Anywhere must not fan out route searches');
        await page.locator('.row').filter({hasText:'Madrid'}).first().click();await page.locator('#cards .fc').first().waitFor();
        assert.equal(searchParams().get('destination'),'MAD');assert.equal(searchParams().get('origin'),'IBZ');
      });
      await check(`${name}: same-city validation and city group searches keep names and cabin`, async () => {
        await home();await origin('LON');await dates();await page.locator('#to').fill('London Heathrow');const before=fixture.requests.length;
        await centre(page,'#go',touch);assert.equal(await page.locator('#toError').innerText(),'Choose a different destination.');assert.equal(fixture.requests.length,before);
        await origin('NYC');await page.locator('#to').fill('London');await page.locator('[data-to="LON"]').waitFor();
        await page.locator('#cabin').selectOption({label:'Business'});await page.locator('#to').press('Enter');await page.locator('#cards .fc').first().waitFor();
        assert.equal(searchParams().get('origin'),'NYC');assert.equal(searchParams().get('destination'),'LON');assert.equal(searchParams().get('fareClass'),'business');
        assert.match(await page.locator('a.back').innerText(),/New York → London/);await snap('city-results');
      });
      await check(`${name}: no page errors, no overflow and bounded motion`, async()=>{
        assert.deepEqual(pageErrors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        const durations=await page.evaluate(()=>document.getAnimations().map(a=>a.effect?.getTiming()).filter(Boolean));
        assert(durations.every(t=>t.iterations===Infinity||+t.duration<=300));
        const metrics=await page.evaluate(()=>window.__flightMetrics);
        performanceResults.push({viewport:width,case:'interaction-next-frame',count:metrics.inputs.length,maxMs:Math.max(0,...metrics.inputs.map(x=>x.ms)),cls:metrics.shifts.reduce((a,b)=>a+b,0)});
      });
      await context.close();
    }
    await check('reduced motion: home, highlights, calendar, results, sort, filters and fare are instant', async()=>{
      fixture.setMode('normal');const context=await browser.newContext({viewport:{width:1280,height:960},reducedMotion:'reduce'});await permitFixtureOnly(context);
      try{
        const page=await context.newPage();await page.clock.setFixedTime(new Date(NOW));await page.goto(fixture.url+'/flights#/search');
        await page.locator('[data-from="IBZ"]').click();await landed(page,'.orow','[data-from="IBZ"]');assert.equal(await inactiveMotion(page),0);
        await page.locator('[data-from="LON"]').click();await page.locator('#nm').click();assert.equal(await inactiveMotion(page),0);
        await page.locator('[data-k="2026-11-18"]').click();await page.locator('#to').fill('Madrid');await page.locator('#to').press('Enter');await page.locator('#cards .fc').first().waitFor();
        assert.equal(await inactiveMotion(page),0);await page.locator('[data-sort="tp"]').click();await landed(page,'.tabs','[data-sort="tp"]');assert.equal(await inactiveMotion(page),0);
        await page.locator('.seg3 label').filter({hasText:/^Only$/}).click();assert.equal(await inactiveMotion(page),0);
        await page.locator('.fc .sel').first().click();await page.locator('#book').waitFor();assert.equal(await inactiveMotion(page),0);
      }finally{await context.close();}
    });
    if(process.env.FLIGHTS_BASELINE_PAGE)await check('optional before: held-provider Go feedback measurement',async()=>{
      const before=fixture.requests.length;fixture.setMode('loading');const context=await browser.newContext({viewport:{width:1280,height:960}});await permitFixtureOnly(context);await context.addInitScript(installMetrics);
      try{
        const page=await context.newPage();await page.clock.setFixedTime(new Date(NOW));await page.goto(fixture.url+'/baseline#/search');
        // Only the baseline setup uses its pre-v4 calendar button.
        await page.locator('#to').fill('Madrid');await page.locator('[data-to="MAD"]').click();
        if(!await page.locator('#cal').isVisible())await page.locator('#whenBtn').click();
        if(!await page.locator('[data-k="2026-11-18"]').count())await page.locator('#nm').click();
        await page.locator('[data-k="2026-11-18"]').click();
        const box=await page.locator('#go').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
        const pointerdownStarted=fixture.requests.slice(before).some(r=>r.mode==='loading'&&new URL(r.url,fixture.url).searchParams.get('action')==='search');
        await page.mouse.up();await page.locator('[aria-busy="true"]').waitFor();
        const feedback=await page.evaluate(()=>window.__flightMetrics.inputs.filter(x=>x.target==='go').at(-1)?.ms);
        performanceResults.push({viewport:1280,case:'before-go-next-frame',ms:feedback,pointerdownStarted});
      }finally{fixture.release();await context.close();}
    });
  } catch(error) {
    if(!failed.length)failed.push({name:'browser runtime startup',error:error.stack}); throw error;
  } finally {
    if(browser)await browser.close();if(fixture)await fixture.close();
    const report={passed:passed.length,failed:failed.length,checks:passed,failures:failed,screenshots,performance:performanceResults,fixtureRequests:fixture?.requests.length||0,fixtureProviderCalls:fixture?.toolCalls.length||0,liveProviderCalls:0};
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report,null,2)+'\n');
  }
}
module.exports={main};
if(require.main===module)main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
