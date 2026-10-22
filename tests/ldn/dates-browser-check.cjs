// Fully offline Chromium check: synthetic listings, local assets fulfilled in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const original = fs.readFileSync(path.join(root, 'ldn/index.html'), 'utf8');
const validity = fs.readFileSync(path.join(root, 'ldn/validity.mjs'), 'utf8');
const evergreen = { id: 'evergreen', category: 'art-museums', rank: 1, name: 'Synthetic standing venue', venue: 'Synthetic standing venue', area: 'Test area', tier: 'evergreen', lat: 51.5136, lng: -0.1313, entry: 'dropin', hours: { thu: [['10:00', '22:00']], fri: [['10:00', '22:00']] } };
const event = { ...evergreen, id: 'event', rank: 2, name: 'Synthetic dated event', tier: 'this-month', validFrom: '2026-10-20', validTo: '2026-10-23' };
const data = { month: '2026-10', generatedAt: '2026-10-22T12:00:00Z', verified: false, categories: [{ id: 'art-museums', label: 'Art', color: '#123456' }], places: [evergreen, event] };
const seed = { ...data, month: '2026-07', generatedAt: '2026-07-18T12:00:00Z', verified: true };
const html = original.replace(/window\.__SEED__ = (\{.*\});<\/script>/, 'window.__SEED__ = ' + JSON.stringify(seed) + ';</script>');
const leaflet = `(() => { const chain = () => ({setView(){return this},addTo(){return this},on(){return this},invalidateSize(){},removeLayer(){},clearLayers(){},eachLayer(){},bindPopup(){return this},fitBounds(){return this}}); window.L={map:chain,tileLayer:chain,layerGroup:chain,marker:chain,divIcon:()=>({}),polyline:chain,latLngBounds:()=>({pad(){return this}})}; })();`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
  try {
    for (const fallback of [false, true]) {
      // A distant visitor timezone must still default to the London date.
      const context = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
      await context.addInitScript(leaflet);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date('2026-10-22T23:30:00Z') });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === 'https://audit.invalid' && url.pathname === '/ldn/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.origin === 'https://audit.invalid' && url.pathname === '/ldn/validity.mjs') return route.fulfill({ contentType: 'text/javascript', body: validity });
        if (url.origin === 'https://audit.invalid' && url.pathname === '/api/ldn-data') return fallback ? route.fulfill({ status: 503, body: '{}' }) : route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
        return route.abort();
      });
      await page.goto('https://audit.invalid/ldn/');
      await page.waitForSelector('.card');
      assert.equal(await page.locator('#plan-date').inputValue(), '2026-10-23');
      const notice = await page.locator('#data-status').textContent();
      const footer = await page.locator('#foot').textContent();
      if (fallback) {
        assert.match(notice, /Live data is unavailable/);
        assert.match(notice, /out of date/);
        assert.match(footer, /recorded for this snapshot/);
        assert.equal(await page.getByText('Dates need checking', { exact: true }).count(), 1);
      } else {
        assert.match(footer, /Independent fact-checking is not recorded/);
        assert.equal(await page.getByText('On now · until 2026-10-23', { exact: true }).count(), 1);
      }
      // Standing venues are never called expired merely because the snapshot is old.
      assert.equal(await page.locator('.card[data-id="evergreen"] .on').count(), 0);
      await page.locator('#plan-btn').click();
      assert.deepEqual(errors, []);
      assert.match(await page.locator('#plan-count').textContent(), fallback ? /1 places/ : /2 places/);
      await page.locator('.loc-chip').first().click();
      await page.locator('#plan-time').fill('14:00');
      await page.locator('#go-btn').click();
      assert.equal(await page.locator('.sname').filter({ hasText: 'Synthetic dated event' }).count(), fallback ? 0 : 1);
      await page.locator('#itin-back').click();
      // Same weekday a week later must exclude the event and update the count.
      await page.locator('#plan-date').fill('2026-10-30');
      await page.locator('#plan-date').dispatchEvent('change');
      assert.match(await page.locator('#plan-count').textContent(), /1 places/);
      await page.locator('#go-btn').click();
      assert.equal(await page.locator('.sname').filter({ hasText: 'Synthetic dated event' }).count(), 0);
      assert.equal(await page.locator('.sname').filter({ hasText: 'Synthetic standing venue' }).count(), 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS London browser: calendar selection, London timezone, live/seed freshness, verification copy, evergreen fallback; all requests intercepted.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
