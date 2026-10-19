// Optional tooling: NODE_PATH exposes playwright-core; PLAYA_BROWSER_PATH selects
// an already-installed Chromium. All requests are intercepted, with no sockets.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const screenshotDir = process.env.PLAYA_SCREENSHOT_DIR || '/tmp/toys-samfun-downloads-logs';
fs.mkdirSync(screenshotDir, { recursive: true });
const { assert, id, setup, suite, session } = require('./helpers');
const { blob, call } = setup();
const year = String(new Date().getUTCFullYear());
const photos = Array.from({ length: 25000 }, (_, i) => ({
  id: id(i),
  y: Number(year),
  w: 1200,
  h: 800,
  t: ['art', 'scenery', 'people'][i % 3],
  tags: ['dust'],
  score: 8,
  pick: i % 2 === 0,
  sel: i % 5 === 0,
  sel_src: 'Selected folder',
  sens: i === 0,
  reason: 'Synthetic browser fixture',
}));
blob.records.set('catalog/catalog.json', {
  etag: '"catalog"',
  body: JSON.stringify({ version: 1, years: [Number(year)], photos }),
});
// Exercises the client with intercepted requests and closes Chromium on every exit.
(async function checkBrowser() {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYA_BROWSER_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      {
        name: 'playa_session',
        value: session.issueToken(process.env.PLAYA_PASSWORD),
        domain: 'gallery.invalid',
        path: '/playa',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    let puts = 0,
      alwaysConflict = false;
    const jobs = new Map(), exports = [], fileRequests = [];
    let nextJob = 0;
    const screenshot = (name) => page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname === '/playa/api/export' && request.method() === 'POST') {
        const body = JSON.parse(request.postData());
        exports.push(body);
        const rid = (++nextJob).toString(16).padStart(32, '0');
        jobs.set(rid, { state: 'queued', done: 0, total: body.ids.length });
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ rid }) });
      }
      if (/^\/exports\/out\//.test(url.pathname)) {
        fileRequests.push(request.url());
        return route.fulfill({
          contentType: 'application/octet-stream',
          headers: { 'Content-Disposition': 'attachment; filename="fixture.jpg"' },
          body: 'synthetic export bytes',
        });
      }
      if (/^\/playa\/api\/export\/[0-9a-f]{32}$/.test(url.pathname)) {
        const data = jobs.get(url.pathname.split('/').at(-1));
        return route.fulfill({ status: data ? 200 : 404, contentType: 'application/json', body: JSON.stringify(data || {}) });
      }
      if (/^\/(?:playa\/m\/)?(thumb|preview)\//.test(url.pathname))
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#6b5140"/></svg>',
        });
      if (request.method() === 'PUT') {
        puts++;
        if (alwaysConflict) return route.fulfill({ status: 412, contentType: 'application/json', body: '{}' });
      }
      const response = await call({
        method: request.method(),
        url: url.pathname + url.search,
        headers: { ...(await request.allHeaders()), host: url.host },
        body: request.postData(),
      });
      return route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text());
    });
    const tests = [];
    // Registers each behavior under its own independently reported name.
    const test = (name, check) => tests.push([name, check]);
    test('browser: runtime home year cards and all five collections', async () => {
      await page.goto('https://gallery.invalid/playa');
      await page.locator('.card').first().waitFor();
      assert.equal(await page.locator('#collections button').count(), 5);
      assert.equal(await page.locator('#years .card').count(), 1);
      assert.match(await page.locator('#totals').textContent(), /25,000/);
      await page.waitForFunction(() => document.getElementById('saveState').textContent.includes('Add photos'));
    });
    test('browser: year grid windows 25,000 items with dimensions and lazy images', async () => {
      await page.locator('.card').first().click();
      await page.waitForFunction(() => document.querySelectorAll('#grid .cell').length > 0);
      assert.ok((await page.locator('#grid .cell').count()) < 100);
      assert.match(await page.locator('#browseCount').textContent(), /25,000/);
      assert.ok(
        await page
          .locator('#grid img')
          .evaluateAll((nodes) =>
            nodes.every((n) => n.loading === 'lazy' && n.getAttribute('width') === '1200' && n.getAttribute('height') === '800'),
          ),
      );
      await page.locator('#main').evaluate((node) => (node.scrollTop = node.scrollHeight / 2));
      await page.waitForTimeout(100);
      assert.ok(Number(await page.locator('#grid .cell').first().getAttribute('aria-posinset')) > 10000);
      assert.ok((await page.locator('#grid .cell').count()) < 100);
      await page.locator('#main').evaluate((node) => (node.scrollTop = 0));
      await page.waitForTimeout(100);
    });
    test('browser: filter chips exclude sensitive photos only from AI picks', async () => {
      await page.getByRole('button', { name: /^AI picks / }).click();
      await page.waitForFunction(() => document.getElementById('browseCount').textContent.startsWith('12,499'));
      assert.equal(await page.locator(`[data-photo="${id(0)}"]`).count(), 0);
      await page.getByRole('button', { name: /^Your selects / }).click();
      await page.waitForFunction(() => document.getElementById('browseCount').textContent.startsWith('5,000'));
      assert.ok((await page.locator(`[data-photo="${id(0)}"]`).count()) > 0);
      await page.getByRole('button', { name: /^All 25/ }).click();
    });
    test('browser: lightbox labels, score, source, tags and download choices', async () => {
      await page.locator('#grid .tile').first().click();
      await page.waitForFunction(() => document.getElementById('lightbox').open);
      assert.match(await page.locator('#selectSource').textContent(), /YOUR SELECT.*Selected folder/);
      assert.match(await page.locator('#aiReason').textContent(), /8\/10.*Synthetic browser fixture/);
      assert.ok((await page.locator('#tags .badge').count()) >= 2);
      await page.locator('#photoDownload summary').click();
      assert.equal(await page.locator('#photoDownload .download-options > *').count(), 3);
      assert.equal(await page.locator('#photoDownload a[data-instant]').getAttribute('href'), `/playa/m/dl/2048/${id(0)}.jpg`);
      assert.equal(await page.locator('#photoDownload a[data-instant]').getAttribute('download'), `playa-${year}-${id(0).slice(0, 10)}.jpg`);
      await screenshot('desktop-photo-choices');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('phone-photo-choices');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('#photoDownload summary').click();
    });
    test('browser: photo exports preserve their selection, progress and ready link', async () => {
      await page.locator('#photoDownload summary').click();
      await page.locator('#photoDownload button').filter({ hasText: /^4096$/ }).click();
      await page.waitForFunction(() => document.querySelector('#photoDownload .download-status').textContent.includes('Preparing… 0/1'));
      assert.deepEqual(exports.at(-1), { kind: 'photo', size: '4096', ids: [id(0)] });
      await screenshot('desktop-photo-preparing');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('phone-photo-preparing');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('#photoDownload summary').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('s');
      assert.match(await page.locator('#position').textContent(), /^1 \//);
      assert.equal(await page.locator('#shortCount').textContent(), '0');
      await page.locator('#next').click();
      assert.equal(await page.locator('#photoDownload .download-status').textContent(), '');
      const rid = [...jobs.keys()].at(-1);
      jobs.set(rid, { state: 'ready', done: 1, total: 1, bytes: 4500000, name: `playa-${year}-${id(0).slice(0, 10)}.jpg`, url: `https://gallery.invalid/exports/out/${rid}/fixture.jpg?signature=fake` });
      await page.locator('#previous').click();
      await page.locator('#photoDownload .download-status a').waitFor();
      assert.equal(await page.locator('#photoDownload .download-status a').textContent(), 'Save file');
      assert.equal(await page.locator('#photoDownload .download-status a').getAttribute('download'), `playa-${year}-${id(0).slice(0, 10)}.jpg`);
      assert.equal(exports.length, 1);
      await screenshot('desktop-photo-ready');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('phone-photo-ready');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('#closePhoto').focus();
    });
    test('browser: stale ready links renew on click and expired exports stop saving', async () => {
      const rid = [...jobs.keys()].at(-1);
      const renewedUrl = `https://gallery.invalid/exports/out/${rid}/fixture.jpg?signature=renewed`;
      jobs.set(rid, { ...jobs.get(rid), url: renewedUrl });
      await page.evaluate(() => {
        window.fixtureDateNow = Date.now;
        Date.now = () => window.fixtureDateNow() + 4 * 60 * 1000;
      });
      try {
        const statusResponse = page.waitForResponse((response) => response.url().endsWith(`/playa/api/export/${rid}`));
        const downloadEvent = page.waitForEvent('download');
        await page.locator('#photoDownload .download-status a').click();
        const [status, download] = await Promise.all([statusResponse, downloadEvent]);
        assert.equal((await status.json()).state, 'ready');
        assert.equal(download.url(), renewedUrl);
        assert.equal(await page.locator('#photoDownload .download-status a').getAttribute('href'), renewedUrl);
        assert.deepEqual(fileRequests, [renewedUrl]);
        assert.ok(await page.locator('#lightbox').evaluate((node) => node.open));
        jobs.set(rid, { state: 'expired' });
        await page.evaluate(() => { Date.now = () => window.fixtureDateNow() + 8 * 60 * 1000; });
        const expiredResponse = page.waitForResponse((response) => response.url().endsWith(`/playa/api/export/${rid}`));
        await page.locator('#photoDownload .download-status a').click();
        assert.equal((await (await expiredResponse).json()).state, 'expired');
        await page.waitForFunction(() => document.querySelector('#photoDownload .download-status').textContent.includes('Download expired.'));
        assert.equal(await page.locator('#photoDownload .download-status a').count(), 0);
        assert.deepEqual(fileRequests, [renewedUrl]);
      } finally {
        await page.evaluate(() => { Date.now = window.fixtureDateNow; delete window.fixtureDateNow; });
        await page.locator('#closePhoto').focus();
      }
    });
    test('browser: focus trap', async () => {
      await page.locator('#closePhoto').focus();
      await page.keyboard.press('Shift+Tab');
      assert.ok(
        await page
          .locator('#filmstrip button')
          .last()
          .evaluate((n) => n === document.activeElement),
      );
      await page.keyboard.press('Tab');
      assert.ok(await page.locator('#closePhoto').evaluate((n) => n === document.activeElement));
    });
    test('browser: keyboard navigation', async () => {
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.getElementById('position').textContent.startsWith('2 /'));
    });
    test('browser: keyboard shortlist persistence', async () => {
      await page.keyboard.press('s');
      await page.waitForFunction(() => document.getElementById('saveState').textContent.includes('Saved across'));
      assert.deepEqual(JSON.parse(blob.records.get('state/shortlist.json').body).ids, [id(1)]);
    });
    test('browser: focus restore', async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('lightbox').open);
      assert.ok(
        await page
          .locator('#grid .tile')
          .first()
          .evaluate((n) => n === document.activeElement),
      );
    });
    test('browser: shortlist conflict refetch merges concurrent addition and retries once', async () => {
      const initial = blob.records.get('state/shortlist.json');
      blob.records.set('state/shortlist.json', {
        etag: '"remote"',
        body: JSON.stringify({ ...JSON.parse(initial.body), ids: [id(1), id(200)] }),
      });
      const before = puts;
      await page.locator('#grid .add').first().click();
      await page.waitForFunction(
        () =>
          document.getElementById('shortCount').textContent === '3' &&
          document.getElementById('saveState').textContent.includes('Saved across'),
      );
      assert.equal(puts - before, 2);
      assert.deepEqual(JSON.parse(blob.records.get('state/shortlist.json').body).ids, [id(1), id(200), id(0)]);
    });
    test('browser: repeated 412 stops after one retry and preserves unsaved UI', async () => {
      alwaysConflict = true;
      const before = puts;
      await page.locator('#grid .add').nth(2).click();
      await page.locator('#retry').waitFor();
      assert.equal(puts - before, 2);
      assert.match(await page.locator('#saveState').textContent(), /not saved/);
      alwaysConflict = false;
      await page.locator('#retry').click();
      await page.waitForFunction(() => document.getElementById('retry').hidden);
      assert.ok(JSON.parse(blob.records.get('state/shortlist.json').body).ids.includes(id(2)));
    });
    test('browser: shortlist survives page reload', async () => {
      await page.reload();
      await page.waitForFunction(() => document.getElementById('shortCount').textContent === '4');
    });
    test('browser: cross-year back and forward navigation', async () => {
      await page.locator('.brand').click();
      await page.locator('#collections button').first().click();
      await page.waitForFunction(
        () => location.hash === '#collection/art' && document.getElementById('browseTitle').textContent === 'Art',
      );
      assert.equal(await page.locator('#browseTitle').textContent(), 'Art');
      await page.goBack();
      await page.waitForFunction(() => !document.getElementById('home').hidden);
      await page.goForward();
      await page.waitForFunction(
        () => document.getElementById('browseTitle').textContent === 'Art' && !document.getElementById('browse').hidden,
      );
    });
    test('browser: shortlist download choices, progress and plain failures', async () => {
      await page.locator('#shortDownload summary').click();
      await screenshot('desktop-shortlist-choices');
      const selected = [...JSON.parse(blob.records.get('state/shortlist.json').body).ids];
      await page.locator('#shortDownload button').filter({ hasText: /^2048$/ }).click();
      await page.waitForFunction(() => document.querySelector('#shortDownload .download-status').textContent.includes('Preparing…'));
      assert.deepEqual(exports.at(-1), { kind: 'zip', size: '2048', ids: selected });
      const rid = [...jobs.keys()].at(-1);
      jobs.set(rid, { state: 'building', done: 2, total: selected.length });
      await page.waitForFunction(() => document.querySelector('#shortDownload .download-status').textContent.includes('2/4'));
      assert.match(await page.locator('#shortDownload .download-status').textContent(), /Est\./);
      await screenshot('desktop-shortlist-preparing');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot('phone-shortlist-preparing');
      await page.locator('#shortDownload summary').click();
      assert.ok(await page.locator('#shortDownload button').first().isDisabled());
      await screenshot('phone-shortlist-choices');
      await page.locator('#shortDownload summary').click();
      jobs.set(rid, { state: 'failed', done: 2, total: selected.length, error: 'integrity' });
      await page.waitForFunction(() => document.querySelector('#shortDownload .download-status').textContent === 'Could not prepare this download.');
      await page.locator('#shortDownload summary').click();
      await page.locator('#shortDownload button').filter({ hasText: /^Original$/ }).click();
      await page.waitForFunction(() => document.querySelector('#shortDownload .download-status').textContent.includes('Size unknown'));
      const originalRid = [...jobs.keys()].at(-1);
      jobs.set(originalRid, { state: 'expired' });
      await page.waitForFunction(() => document.querySelector('#shortDownload .download-status').textContent.includes('expired'));
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    test('browser: 390 px has no page overflow and touch targets at least 44 px', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#shortClose').click();
      await page.waitForTimeout(100);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
      const small = await page.locator('button:visible,a:visible,summary:visible').evaluateAll((nodes) =>
        nodes
          .filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width < 43.9 || r.height < 43.9;
          })
          .map((n) => n.textContent),
      );
      assert.deepEqual(small, []);
      await page.locator('#grid .tile').first().click();
      await page.waitForFunction(() => document.getElementById('lightbox').open);
      assert.ok(await page.locator('#preview').isVisible());
      await page.keyboard.press('Escape');
    });
    test('browser: missing store renders unpublished-gallery state', async () => {
      blob.fail = true;
      await page.reload();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('Gallery not published yet'));
      assert.ok(await page.locator('#status').isVisible());
      blob.fail = false;
    });
    test('browser: no JavaScript or CSP errors', async () => assert.deepEqual(errors, []));
    await suite(tests);
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
