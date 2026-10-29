/* Run explicitly: node tests/flights/browser-check.cjs
 * Uses the real local handler and committed/synthetic fixtures, never live data.
 * The implementation task deliberately does not run this loopback browser check. */
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
      const lastSearch = () => fixture.requests.filter(r => new URL(r.url, fixture.url).searchParams.get('action') === 'search').at(-1);
      const searchParams = () => new URL(lastSearch().url, fixture.url).searchParams;
      const search = async () => { await page.locator('#go').click(); await page.locator('.fc').first().waitFor(); };
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
      const openFilters = async () => {
        if (width < 700 && !await page.locator('body').evaluate(el => el.classList.contains('sheet'))) await page.locator('#fopen').click();
        await page.locator('#earningOnly').waitFor({ state: 'visible' });
      };
      await check(`${name}: v3 home and approved reference`, async () => {
        fixture.setMode('normal'); await showSearch();
        assert.match(await page.locator('meta[name="robots"]').getAttribute('content'), /noindex/);
        assert.equal(await page.locator('#to').getAttribute('placeholder'), 'City or airport');
        assert.match(await page.locator('h1').innerText(), /Where to\?/);
        assert.match(await page.locator('#fromBtn').innerText(), /London/);
        assert.equal(await page.locator('#go').getAttribute('aria-label'), 'Search');
        await snap('search');
        const refContext = await browser.newContext({ viewport: { width, height: 960 }, deviceScaleFactor: 1 });
        await refContext.route('**/*', route => new URL(route.request().url()).origin === fixture.url || route.request().url().startsWith('data:') ? route.continue() : route.abort());
        try {
          const ref = await refContext.newPage(); await ref.clock.setFixedTime(new Date(NOW));
          await ref.goto(fixture.url + '/approved#/search');
          assert.equal(await ref.evaluate(() => JSON.parse(localStorage.getItem('flights.proto.gold')).tp),12480);
          const file = path.join(out, `${name}-approved-search.png`);
          await ref.screenshot({ path: file, fullPage: true }); screenshots.push(file);
        } finally { await refContext.close(); }
        assert.equal(await page.evaluate(() => localStorage.getItem('flights.proto.gold')),null);
        assert.equal(await page.evaluate(() => localStorage.getItem('flights.gold.live.v1')),null);
      });
      await check(`${name}: go without destination focuses the field`, async () => {
        await page.locator('#go').click();
        assert.equal(await page.locator('#to').evaluate(el => el === document.activeElement), true);
        assert.match(await page.locator('.hintline').innerText(), /where|destination/i);
      });
      await check(`${name}: typed destination errors stay beside the control`, async () => {
        for (const enter of [false, true]) {
          await showSearch();
          await page.locator('#to').fill('zzqq');
          if (enter) await page.locator('#to').press('Enter'); else await page.locator('#go').click();
          assert.equal(await page.locator('#toError').innerText(), 'No airport matches “zzqq”.');
          assert.equal(await page.locator('#to').getAttribute('aria-describedby'), 'toError');
          assert.equal(await page.locator('#destinations').count(), 0);
          await page.locator('#to').fill('Madrid');
          assert.equal(await page.locator('#toError').count(), 0);
          if (enter) await page.locator('#to').press('Enter'); else await page.locator('#go').click();
          assert.equal(await page.locator('#dateError').innerText(), 'Pick a date.');
          assert.equal(await page.locator('#whenBtn').getAttribute('aria-describedby'), 'dateError');
          assert(await page.locator('#cal').isVisible());
          assert.equal(await page.locator('#destinations').count(), 0);
        }
        await showSearch();
      });
      await check(`${name}: go searches a typed airport name without choosing a suggestion`, async () => {
        await page.locator('#fromBtn').click(); await page.locator('[data-from="IBZ"]').click();
        await dates(); await page.locator('#to').fill('London Heathrow'); await search();
        assert.equal(searchParams().get('destination'), 'LHR');
        assert.equal(searchParams().get('origin'), 'IBZ');
        assert.equal(await page.locator('#cal').count(), 0);
        assert.equal(await page.locator('#destinations').count(), 0);
        assert(!/at\/span>/.test(await page.locator('h1').innerText()));
        const heading = await page.locator('h1').innerHTML();
        assert.match(heading, /TP at<\/span>/);
        await showSearch();
      });
      await check(`${name}: highlighted suggestion wins on Enter`, async () => {
        await dates(); await page.locator('#to').fill('Tokyo');
        await page.locator('#to').press('ArrowDown'); await page.locator('#to').press('ArrowDown');
        assert.equal(await page.locator('#to').getAttribute('aria-activedescendant'), 'suggest-NRT');
        await page.locator('#to').press('Enter'); await page.locator('.fc').first().waitFor();
        assert.equal(searchParams().get('destination'), 'NRT');
        assert.equal(await page.locator('#destinations').count(), 0);
        await showSearch();
      });
      await check(`${name}: origin controls and custom airport`, async () => {
        await page.locator('#fromBtn').click();
        assert.equal(await page.locator('#fromPop .opt.on').evaluate(el => el === document.activeElement), true);
        assert.match(await page.locator('#fromPop').innerText(), /London.*all airports/s);
        await page.locator('[data-from="IBZ"]').click();
        assert.match(await page.locator('#fromBtn').innerText(), /Ibiza/);
        await page.locator('#fromBtn').click(); await page.locator('#fromQ').fill('LHR');
        await page.locator('[data-from2="LHR"]').click();
        assert.match(await page.locator('#fromBtn').innerText(), /Heathrow|LHR/);
        await page.locator('#fromBtn').click(); await page.locator('[data-from="LON"]').click();
      });
      await check(`${name}: calendar one-way, return, and flex price toggle`, async () => {
        await destination(); await dates();
        assert.match(await page.locator('#whenBtn').innerText(), /one way/);
        await page.locator('[data-k="2026-11-21"]').click();
        assert(!/one way/.test(await page.locator('#whenBtn').innerText()));
        await snap('calendar-return'); await page.locator('#clr').click();
        await page.locator('[data-k="2026-11-18"]').click();
        const flexResponse = page.waitForResponse(r => r.url().includes('/api/flights?') && new URL(r.url()).searchParams.get('action') === 'flex');
        await page.locator('#pt').click(); await flexResponse;
        await page.locator('.calnote').filter({ hasText: /discovery prices/ }).waitFor();
        assert.match(await page.locator('[data-k="2026-11-18"]').innerText(), /£62\b/);
        await snap('calendar-prices'); await page.locator('#pt').click();
      });
      await check(`${name}: go searches with calendar open and renders v3 cards`, async () => {
        assert(await page.locator('#cal').isVisible());
        await page.locator('#cabin').selectOption({ label: 'Economy' }); await search();
        assert.equal(await page.locator('#cal').count(), 0);
        assert.equal(await page.locator('.fc').count(), 4);
        assert.equal(await page.locator('#fopen').innerText(),'Filters');
        assert((await page.locator('.fc .sel').allTextContents()).every(t=>t==='Select'));
        assert((await page.locator('.fc .sel span').count())===0);
        assert((await page.locator('.fc .air').allTextContents()).every(t=>/IB \d+/.test(t)));
        assert.match(await page.locator('h1').innerText(),/^IB \d+/);
        assert.match(await page.locator('.fc .prc').first().innerText(), /^£[\d,]+$/);
        assert.match(await page.locator('.fc .tpv').first().innerText(), /^\+\d[\d,]* TP$/);
        assert.equal(await page.locator('.fc .line svg').count(), 4);
        assert.equal(await page.locator('[role="tab"]').count(), 4);
        assert.equal(await page.locator('[data-sort="value"]').getAttribute('aria-selected'), 'true');
        assert.equal(searchParams().get('origin'), 'LHR,LGW,LCY,STN,LTN,SEN');
        assert.equal(searchParams().get('earningOnly'), 'true');
        assert.equal(searchParams().get('fareClass'), 'economy');
        assert.equal(searchParams().has('returnDate'), false); await snap('results');
      });
      await check(`${name}: fare detail and hidden-city safe booking link`, async () => {
        const data = await (await fetch(fixture.url + lastSearch().url)).json();
        const href = await page.locator('.fc .sel').first().getAttribute('href');
        const selected = data.results.find(f => f.id === decodeURIComponent(href.slice('#/fare/'.length)));
        assert(selected); await page.locator('.fc .sel').first().click(); await page.locator('#book').waitFor();
        assert.equal(await page.locator('#book').getAttribute('href'), selected.deepLink);
        assert.match(await page.locator('.hero').innerText(), new RegExp(String(selected.estimate.tierPoints) + '\\s*TP'));
        await snap('fare'); await page.locator('a.back').click(); await page.locator('.fc').first().waitFor();
        const hidden = data.results.find(f => f.hiddenCity); assert(hidden);
        await page.locator(`a.sel[href="#/fare/${encodeURIComponent(hidden.id)}"]`).click(); await page.locator('#book').waitFor();
        assert.match(await page.locator('.who').innerText(), /Iberia · Economy · cabin bag only/);
        assert.match(await page.locator('.lg').first().innerText(), /^IB 714 · 2h30$/);
        assert.match(await page.locator('.lg.ghost').innerText(), /^IB 411 · 1h$/);
        assert.match(await page.locator('.st.ghost').innerText(), /Barcelona · BCN/);
        assert.match(await page.locator('#app').innerText(), /Skipping a sector can invalidate the ticket and credit\./);
        await snap('hidden-city'); await page.locator('a.back').click(); await page.locator('.fc').first().waitFor();
      });
      await check(`${name}: phone filter sheet icon, Show flights, backdrop and Escape close`, async () => {
        if(width>=700)return;
        const closed=async()=>assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('sheet')),false);
        await openFilters();
        assert.equal(await page.locator('#fclose').innerText(),'×');
        assert.equal(await page.locator('#fclose').getAttribute('aria-label'),'Close filters');
        assert.equal(await page.locator('.fhd').getByText('Close',{exact:true}).count(),0);
        const reset=await page.locator('#freset').boundingBox(),close=await page.locator('#fclose').boundingBox();
        assert(reset.x+reset.width<=close.x);
        assert.equal(await page.locator('#fshow').innerText(),'Show 4 flights');
        await page.locator('#fclose').click();await closed();
        await openFilters();await page.keyboard.press('Escape');await closed();
        await openFilters();await page.mouse.click(5,5);await closed();
        await openFilters();await page.locator('#fshow').click();await closed();
      });
      await check(`${name}: filters column or phone sheet and all-airline toggle`, async () => {
        await openFilters();
        if (width < 700) assert.equal(await page.locator('body').evaluate(el => el.classList.contains('sheet')), true);
        else assert.equal(await page.locator('#fcol').evaluate(el => getComputedStyle(el).position), 'sticky');
        assert.equal(await page.locator('#earningOnly').isChecked(), true);
        assert.equal(await page.locator('input[name="stops"]').count(), 3);
        assert.equal(await page.locator('.hist i').count(), 48);
        assert.equal(await page.locator('input[type="range"]').count(), 4);
        await page.locator('#earningOnly').uncheck(); await page.locator('.fc').filter({hasText:'No TP'}).first().waitFor();
        assert.equal(searchParams().get('earningOnly'), 'false');
        assert.match(await page.locator('#app').innerText(), /All airlines/);
        const noTp = page.locator('.fc').filter({hasText:'No TP'}).first();
        assert.equal(await noTp.locator('.tpv:not(.no-tp)').count(), 0);
        assert.doesNotMatch(await noTp.innerText(), /\/TP|\+0 TP/);
        const neutralColor = await noTp.getByText('No TP',{exact:true}).evaluate(el => getComputedStyle(el).color);
        const accentColor = await page.locator('.fc .tpv').first().evaluate(el => getComputedStyle(el).color);
        assert.notEqual(neutralColor, accentColor); await snap('all-airlines');
        await page.reload(); await page.locator('#to').waitFor();
        await destination(); await dates(); await search();
        assert.equal(searchParams().get('earningOnly'), 'false');
        await openFilters(); assert.equal(await page.locator('#earningOnly').isChecked(), false);
        if(width < 700) { await page.locator('#fshow').click(); assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('sheet')),false); }
      });
      await check(`${name}: four sorts and independent filter controls`, async () => {
        for (const key of ['value','tp','cheap','fast']) {
          await page.locator(`[data-sort="${key}"]`).click();
          assert.equal(await page.locator(`[data-sort="${key}"]`).getAttribute('aria-selected'),'true');
          if(key==='value'||key==='tp') assert.doesNotMatch(await page.locator('.fc').first().innerText(), /No TP/);
          else assert.match(await page.locator('.fc').first().innerText(), /No TP/);
        }
        await openFilters();
        assert.equal(await page.locator('#fopen').innerText(),'Filters · 1');
        await page.locator('input[name="stops"][value="0"]').check();
        assert.match(await page.locator('#fopen').innerText(), /Filters ·/);
        const range=page.locator('input[data-r="dep"][data-i="1"]');
        await range.evaluate(el=>{el.value='8';el.dispatchEvent(new Event('input',{bubbles:true}));});
        assert((await page.locator('.fc').allTextContents()).every(t=>/No TP/.test(t)));
        await page.locator('#freset').click(); await openFilters();
        const ib=page.locator('.fs input[type="checkbox"][value="IB"]');
        await ib.uncheck(); assert((await page.locator('.fc').allTextContents()).every(t=>/No TP/.test(t)));
        await snap('filters'); await page.locator('#freset').click(); await openFilters();
        for(const airline of await page.locator('.fs input[type="checkbox"]').all())await airline.uncheck();
        assert.match(await page.locator('#cards').innerText(),/No flights match these filters/);
        assert.equal(await page.locator('#fcol').count(),1);assert.equal(await page.locator('[role="tab"]').count(),4);
        if(width<700)await page.locator('#fshow').click();
        await page.locator('#freset2').click();await page.locator('.fc').first().waitFor();await openFilters();
        await page.locator('#earningOnly').check(); await page.locator('.fc').first().waitFor();
        assert.equal(searchParams().get('earningOnly'),'true');
        assert.equal(await page.locator('#fopen').innerText(),'Filters');
        assert.equal(await page.locator('.fc').filter({hasText:'No TP'}).count(),0);
      });
      await check(`${name}: Enter searches an arbitrary typed route`, async () => {
        await showSearch(); await dates();
        await page.locator('#to').fill('JFK'); await page.locator('#to').press('Enter');
        await page.locator('.fc').first().waitFor();
        assert.equal(searchParams().get('destination'),'JFK');
        assert.equal(await page.locator('#cal').count(),0);
        assert.match(await page.locator('a.back').innerText(), /New York|JFK/);
      });
      await check(`${name}: return totals and booking link use backend values once`, async () => {
        await showSearch(); await destination(); await dates(true); await search();
        assert.equal(searchParams().get('returnDate'), '2026-11-21');
        const data = await (await fetch(fixture.url + lastSearch().url)).json();
        assert(data.results.every(f => !f.hiddenCity));
        assert.equal(data.results[0].priceGbp,93.17); assert.equal(data.results[0].estimate.tierPoints,66);
        await page.locator('.fc .sel').first().click(); await page.locator('#book').waitFor();
        assert.match(await page.locator('.hero').innerText(), /93\.17/);
        assert.match(await page.locator('.hero').innerText(), /66\s*TP/);
        assert.equal(await page.locator('#book').getAttribute('href'),data.results[0].deepLink); await snap('return-fare');
      });
      await check(`${name}: Gold defaults, edits and persistence`, async () => {
        await page.locator('#ring').click(); await page.locator('#gtp').waitFor();
        assert.equal(await page.locator('#gtp').inputValue(),'0'); assert.equal(await page.locator('.gring circle').count(),1);
        assert.equal(await page.locator('#gtarget').inputValue(),'20000'); assert.equal(await page.locator('#gend').inputValue(),'2027-03-31');
        await page.evaluate(() => localStorage.setItem('flights.gold.v2',JSON.stringify({tp:12480,target:20000,ends:'2027-03-31'})));
        await page.reload();await page.locator('#gtp').waitFor();assert.equal(await page.locator('#gtp').inputValue(),'0');
        assert.equal(await page.evaluate(() => localStorage.getItem('flights.gold.live.v1')),null);
        await page.evaluate(() => localStorage.setItem('flights.gold.v2',JSON.stringify({tp:1234,target:21000,ends:'2027-03-30'})));
        await page.reload();await page.locator('#gtp').waitFor();assert.equal(await page.locator('#gtp').inputValue(),'1234');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('flights.gold.live.v1')).tp),1234);
        await page.evaluate(() => {localStorage.removeItem('flights.gold.v2');localStorage.removeItem('flights.gold.live.v1');});
        await page.reload();await page.locator('#gtp').waitFor();assert.equal(await page.locator('#gtp').inputValue(),'0');
        await snap('gold-zero'); await page.locator('#gtp').fill('12500'); await page.locator('#gtarget').fill('21000');
        await page.locator('#gend').fill('2027-03-30'); await page.locator('button[form="gf"]').click(); await page.reload();
        await page.locator('#gtp').waitFor(); assert.equal(await page.locator('#gtp').inputValue(),'12500');
        assert.equal(await page.locator('#gtarget').inputValue(),'21000'); assert.equal(await page.locator('#gend').inputValue(),'2027-03-30');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('flights.gold.live.v1')).tp),12500);
        assert.equal(await page.evaluate(() => localStorage.getItem('flights.gold.v2')),null);await snap('gold');
      });
      await check(`${name}: loading, partial, empty, error, busy and cancellation`, async () => {
        for(const mode of ['loading','partial','empty','error','throttled']) {
          fixture.setMode(mode); await showSearch(); await destination(); await dates();
          const cancelled=mode==='loading'?page.waitForEvent('requestfailed',{predicate:r=>r.url().includes('/api/flights?')}):null;
          await page.locator('#go').click();
          if(mode==='loading') await page.locator('.spin').waitFor();
          else if(mode==='partial') {await page.locator('.fc').first().waitFor();assert.match(await page.locator('#app').innerText(),/didn.t answer/i);}
          else await page.locator('.state').waitFor();
          const text=await page.locator('#app').innerText();
          if(mode==='empty'){
            assert.match(text,/No earning fares/);assert.match(text,/Other dates/);assert.match(text,/Anywhere from London/);
            assert.equal(await page.locator('#fcol, .tabs, .rbar').count(),0);
            assert.equal(await page.locator('#allAirlines').innerText(),'All airlines');
            await snap('empty');
            fixture.setMode('normal');await page.locator('#allAirlines').click();await page.locator('.fc').first().waitFor();
            assert.equal(searchParams().get('earningOnly'),'false');
            await openFilters();assert.equal(await page.locator('#earningOnly').isChecked(),false);
            await page.locator('#earningOnly').check();await page.locator('.fc').first().waitFor();
          }
          if(mode==='error')assert.match(text,/unavailable|didn.t answer|failed/i);
          if(mode==='throttled')assert.match(text,/moment|busy|wait|requests/i);
          if(mode!=='empty')await snap(mode); await page.locator('a.back').click(); await page.locator('#to').waitFor(); if(cancelled)await cancelled;
        }
        assert(canceled.length>0,'navigation must abort the old API fetch');
      });
      await check(`${name}: Anywhere discovery performs a route search`, async () => {
        fixture.setMode('normal'); await showSearch(); await page.locator('#anyPill').click(); await dates();
        await page.locator('#go').click(); await page.locator('.list.discovery .row').first().waitFor();
        assert.equal(new URL(fixture.requests.at(-1).url,fixture.url).searchParams.get('action'),'anywhere');
        assert.match(await page.locator('#app').innerText(),/discovery/i);
        const cities=await page.locator('.row .tm').allTextContents(); assert.equal(cities.length,new Set(cities).size);
        assert(!cities.includes('London')); await snap('anywhere');
        await page.locator('.row').filter({hasText:'Madrid'}).first().click(); await page.locator('.fc').first().waitFor();
        assert.equal(searchParams().get('destination'),'MAD');
        assert.equal(searchParams().get('origin'),'LHR,LGW,LCY,STN,LTN,SEN');
      });
      await check(`${name}: same-city groups explain why go and Enter cannot search`, async () => {
        for (const [origin, target] of [['LON', 'London Heathrow'], ['NYC', 'JFK']]) {
          for (const enter of [false, true]) {
            await showSearch(); await dates();
            if (origin === 'NYC') {
              await page.locator('#fromBtn').click(); await page.locator('#fromQ').fill('NYC');
              await page.locator('[data-from2="NYC"]').click();
            }
            await page.locator('#to').fill(target);
            const before = fixture.requests.length;
            if (enter) await page.locator('#to').press('Enter'); else await page.locator('#go').click();
            assert.equal(await page.locator('#toError').innerText(), 'Choose a different destination.');
            assert.equal(fixture.requests.length, before);
            assert.equal(await page.locator('#cal').count(), 0);
            assert.equal(await page.locator('#destinations').count(), 0);
          }
        }
      });
      await page.locator('#fromBtn').click(); await page.locator('[data-from="LON"]').click();
      await check(`${name}: valid typed routes retain the chosen cabin and London origins`, async () => {
        await showSearch(); await dates(); await page.locator('#cabin').selectOption({ label: 'Business' });
        await page.locator('#to').fill('Madrid'); await search();
        assert.equal(searchParams().get('fareClass'), 'business');
        assert.equal(searchParams().get('origin'), 'LHR,LGW,LCY,STN,LTN,SEN');
      });
      await check(`${name}: no uncaught page errors`,async()=>assert.deepEqual(pageErrors,[]));
      await context.close();
    }
  } catch(error) {
    if(!failed.length)failed.push({name:'browser runtime startup',error:error.stack}); throw error;
  } finally {
    if(browser)await browser.close();if(fixture)await fixture.close();
    const report={passed:passed.length,failed:failed.length,checks:passed,failures:failed,screenshots,fixtureRequests:fixture?.requests.length||0,fixtureProviderCalls:fixture?.toolCalls.length||0,liveProviderCalls:0};
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report,null,2)+'\n');
  }
}
module.exports={main};
if(require.main===module)main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
