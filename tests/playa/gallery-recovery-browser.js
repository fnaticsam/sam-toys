// Optional Chromium regression suite. Every request is intercepted locally;
// NODE_PATH supplies playwright-core and PLAYA_BROWSER_PATH selects the browser.
const { chromium } = require('playwright-core');
const { assert, id, setup, suite, session } = require('./helpers');
const tests = [];
const test = (name, check) => tests.push([name, check]);
const unknownYears = [undefined, null, 'invalid', 99, '2024\n', [2024], { value: 2024 }];
const photos = [2024, '2024', ...unknownYears].map((y, index) => ({ id: id(100 + index), y, w: 1200, h: 800, tags: [], t: 'art' }));
const unknownId = photos[2].id;
const recoveryKey = 'playa.export-jobs.v1';
let browser;

async function scenario(check) {
  const fixture = setup();
  fixture.blob.records.set('catalog/catalog.json', {
    etag: '"catalog"',
    body: JSON.stringify({ years: [2024, '2024', { y: 2024 }, null, {}, 'n/a'], photos: [...photos,
      { id: id(200), y: null, w: 0, h: 800 }, { id: 'invalid', y: null, w: 1200, h: 800 }] }),
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([{ name: 'playa_session', value: session.issueToken(process.env.PLAYA_PASSWORD),
    domain: 'gallery.invalid', path: '/playa', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  // Keep the real requested backoff values as evidence, but avoid a minute-long
  // wait. Only the gallery's polling intervals use these synthetic timers.
  await context.addInitScript(() => {
    const schedule = window.setTimeout;
    window.pollDelays = [];
    window.setTimeout = (callback, delay, ...args) => {
      if ([2000, 4000, 8000, 16000, 30000].includes(delay)) {
        window.pollDelays.push(delay);
        return schedule(callback, 60, ...args);
      }
      return schedule(callback, delay, ...args);
    };
  });
  const mock = { posts: [], polls: [], files: [], replies: [], fallback: { state: 'queued' } };
  const rid = id('browser-export').slice(0, 32);
  mock.ready = (signature = 'first') => ({ state: 'ready', done: 1, total: 1, bytes: 100,
    name: `playa-unknown-${unknownId.slice(0, 10)}.jpg`,
    url: `https://gallery.invalid/exports/out/${rid}/fixture.jpg?signature=${signature}` });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/playa/api/export') {
      mock.posts.push(JSON.parse(request.postData()));
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ rid }) });
    }
    if (url.pathname.startsWith('/playa/api/export/')) {
      mock.polls.push(url.pathname);
      const reply = mock.replies.shift() || mock.fallback;
      if (reply.wait) await reply.wait;
      if (reply.abort) return route.abort('failed');
      return route.fulfill({ status: reply.http || 200, contentType: 'application/json', body: JSON.stringify(reply) });
    }
    if (url.pathname.startsWith('/exports/out/')) {
      mock.files.push(request.url());
      return route.fulfill({ contentType: 'application/octet-stream',
        headers: { 'Content-Disposition': 'attachment; filename="fixture.jpg"' }, body: 'synthetic bytes' });
    }
    if (/^\/playa\/m\/(thumb|preview)\//.test(url.pathname))
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"/>' });
    const response = await fixture.call({ method: request.method(), url: url.pathname + url.search,
      headers: { ...(await request.allHeaders()), host: url.host }, body: request.postData() });
    return route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  mock.start = async () => {
    await page.goto(`https://gallery.invalid/playa#year/unknown?photo=${unknownId}`);
    await page.waitForFunction(() => document.getElementById('lightbox').open);
    await page.locator('#photoDownload summary').click();
    await page.getByRole('button', { name: '4096 px', exact: true }).click();
  };
  try {
    await check(page, mock, fixture);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

test('gallery: valid undated photos browse, shortlist and name downloads consistently', () => scenario(async (page, mock, fixture) => {
  await page.goto('https://gallery.invalid/playa');
  await page.locator('#years .card').first().waitFor();
  assert.deepEqual(await page.locator('#years strong').allTextContents(), ['2024', 'Unknown year']);
  assert.match(await page.locator('#totals').textContent(), /9 photos/);
  await page.getByRole('button', { name: /^2024 2 photos/ }).click();
  assert.equal(await page.locator('#browseCount').textContent(), '2 photos');
  await page.locator('.brand').click();
  await page.getByRole('button', { name: /^Unknown year 7 photos/ }).click();
  assert.equal(await page.locator('#browseTitle').textContent(), 'Unknown year');
  assert.equal(await page.locator('#browseCount').textContent(), '7 photos');
  assert.equal(new URL(page.url()).hash, '#year/unknown');
  await page.locator('#grid .tile').first().click();
  assert.equal(await page.locator('#photoTitle').textContent(), 'Unknown year');
  assert.match(await page.locator('#preview').getAttribute('alt'), /Unknown year/);
  await page.waitForFunction(() => !document.getElementById('togglePhoto').disabled);
  await page.locator('#togglePhoto').click();
  await page.waitForFunction(() => document.getElementById('saveState').textContent.includes('Saved across'));
  assert.deepEqual(JSON.parse(fixture.blob.records.get('state/shortlist.json').body).ids, [unknownId]);
  assert.match(await page.locator('#shortItems').textContent(), /Unknown year/);
  assert.equal(await page.locator('#photoDownload a[data-instant]').getAttribute('download'), `playa-unknown-${unknownId.slice(0, 10)}.jpg`);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('shortCount').textContent === '1');
  assert.equal(await page.locator('#browseCount').textContent(), '7 photos');
}));

test('gallery: network, 503 and 429 status failures recover on the same RID without another POST', () => scenario(async (page, mock) => {
  mock.replies = [{ abort: true }, { http: 503 }, { http: 429 }, mock.ready()];
  const download = page.waitForEvent('download');
  await mock.start();
  assert.equal((await download).url(), mock.ready().url);
  assert.deepEqual(await page.evaluate(() => window.pollDelays), [2000, 4000, 8000]);
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.polls.length, 4);
  assert.equal(new Set(mock.polls).size, 1);
  assert.equal(mock.files.length, 1);
  await page.locator('#photoDownload .download-status a').waitFor();
}));

test('gallery: retries stop at the bound and Resume status reuses the job with one active poll', () => scenario(async (page, mock) => {
  mock.fallback = { http: 503 };
  await mock.start();
  const resume = page.getByRole('button', { name: 'Resume status', exact: true });
  await resume.waitFor();
  assert.deepEqual(await page.evaluate(() => window.pollDelays), [2000, 4000, 8000, 16000, 30000]);
  assert.equal(mock.polls.length, 6);
  await page.waitForTimeout(150);
  assert.equal(mock.polls.length, 6);
  assert.ok(await page.locator('#photoDownload .download-options button').first().isDisabled());
  assert.equal(mock.posts.length, 1);
  mock.fallback = mock.ready();
  const download = page.waitForEvent('download');
  await resume.evaluate((node) => { node.click(); node.click(); });
  assert.equal((await download).url(), mock.ready().url);
  assert.equal(mock.polls.length, 7);
  assert.equal(new Set(mock.polls).size, 1);
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.files.length, 1);
}));

test('gallery: failed signed-link refresh never downloads a stale URL and resumes the same RID', () => scenario(async (page, mock) => {
  mock.fallback = mock.ready();
  const firstDownload = page.waitForEvent('download');
  await mock.start();
  await firstDownload;
  await page.locator('#photoDownload .download-status a').waitFor();
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 5 * 60 * 1000; });
  mock.fallback = { http: 503 };
  await page.locator('#photoDownload .download-status a').click();
  await page.getByRole('button', { name: 'Resume status', exact: true }).waitFor();
  assert.equal(mock.files.length, 1);
  assert.equal(mock.posts.length, 1);
  mock.fallback = mock.ready('renewed');
  await page.getByRole('button', { name: 'Resume status', exact: true }).click();
  await page.locator('#photoDownload .download-status a').waitFor();
  assert.equal(mock.files.length, 1);
  const renewedDownload = page.waitForEvent('download');
  await page.locator('#photoDownload .download-status a').click();
  assert.equal((await renewedDownload).url(), mock.ready('renewed').url);
  assert.equal(new Set(mock.polls).size, 1);
  assert.equal(mock.posts.length, 1);
}));

test('gallery: queued photo survives reload with only bounded metadata and no new POST', () => scenario(async (page, mock) => {
  await mock.start();
  await page.waitForFunction((key) => sessionStorage.getItem(key), recoveryKey);
  const stored = JSON.parse(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey));
  assert.equal(stored.v, 1);
  assert.equal(stored.jobs.length, 1);
  assert.deepEqual(Object.keys(stored.jobs[0]).sort(), ['createdAt', 'downloadStarted', 'kind', 'rid', 'size', 'total']);
  assert.equal(stored.jobs[0].kind, 'photo');
  assert.equal(stored.jobs[0].total, 1);
  assert.equal(stored.jobs[0].downloadStarted, false);
  assert.ok(!JSON.stringify(stored).includes(unknownId));
  const before = mock.polls.length;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#photoDownload .download-status').textContent === 'Previous photo download: Preparing…');
  assert.ok(mock.polls.length > before);
  assert.ok(await page.locator('#photoDownload .download-options button').first().isDisabled());
  assert.equal(mock.posts.length, 1);
  const download = page.waitForEvent('download');
  mock.fallback = mock.ready();
  assert.equal((await download).url(), mock.ready().url);
  await page.locator('#photoDownload .download-status a').waitFor();
  const readyRecord = JSON.parse(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey));
  assert.equal(readyRecord.jobs[0].downloadStarted, true);
  assert.ok(!JSON.stringify(readyRecord).includes('https:'));
  assert.ok(!JSON.stringify(readyRecord).includes('.jpg'));
  await page.reload();
  await page.locator('#photoDownload .download-status a').waitFor();
  assert.equal(mock.files.length, 1, 'reload keeps the fallback without restarting a completed automatic download');
  assert.equal(mock.posts.length, 1);
  assert.equal(new Set(mock.polls).size, 1);
}));

test('gallery: queued shortlist survives reload and resumes its original request', () => scenario(async (page, mock, fixture) => {
  fixture.blob.records.set('state/shortlist.json', { etag: '"selected"', body: JSON.stringify({ ids: [unknownId] }) });
  await page.goto('https://gallery.invalid/playa');
  await page.waitForFunction(() => document.getElementById('shortCount').textContent === '1');
  await page.locator('#shortToggle').click();
  await page.locator('#shortDownload summary').click();
  await page.locator('#shortDownload .download-options button').first().click();
  await page.waitForFunction((key) => sessionStorage.getItem(key), recoveryKey);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#shortDownload .download-status').textContent === 'Previous shortlist download: Preparing… 0/1');
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.posts[0].kind, 'zip');
  const download = page.waitForEvent('download');
  mock.fallback = { ...mock.ready(), name: 'playa-shortlist-2024-01-02-2048.zip' };
  await download;
  assert.equal(mock.posts.length, 1);
  assert.equal(new Set(mock.polls).size, 1);
}));

test('gallery: recovery rejects expired, oversized and invalid records without polling', () => scenario(async (page, mock) => {
  await page.goto('https://gallery.invalid/playa');
  await page.locator('#years .card').first().waitFor();
  const job = { rid: id('restore').slice(0, 32), kind: 'photo', size: '4096', total: 1,
    createdAt: Date.now(), downloadStarted: false };
  const records = [
    '{', ' '.repeat(4097), JSON.stringify({ v: 2, jobs: [job] }),
    JSON.stringify({ v: 1, jobs: Array(9).fill(job) }),
    JSON.stringify({ v: 1, jobs: [job, job] }),
    ...[
      { createdAt: Date.now() - 24 * 60 * 60 * 1000 - 1 }, { createdAt: Date.now() + 86400000 },
      { rid: job.rid + '\n' }, { total: 2 }, { size: '2048' }, { kind: 'other' },
      { downloadStarted: 'false' }, { ids: [unknownId] }, { url: mock.ready().url },
    ].map((extra) => JSON.stringify({ v: 1, jobs: [{ ...job, ...extra }] })),
  ];
  for (const record of records) {
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [recoveryKey, record]);
    await page.reload();
    await page.waitForFunction((key) => sessionStorage.getItem(key) === null, recoveryKey);
    assert.equal(mock.polls.length, 0);
    assert.equal(mock.posts.length, 0);
  }
}));

test('gallery: eight restored requests keep separate fallback links and issue no POST', () => scenario(async (page, mock) => {
  await page.goto('https://gallery.invalid/playa');
  await page.locator('#years .card').first().waitFor();
  const jobs = Array.from({ length: 8 }, (_, index) => ({ rid: id('restore-' + index).slice(0, 32),
    kind: 'photo', size: 'original', total: 1, createdAt: Date.now(), downloadStarted: true }));
  await page.evaluate(([key, value]) => sessionStorage.setItem(key, JSON.stringify(value)), [recoveryKey, { v: 1, jobs }]);
  mock.fallback = mock.ready();
  await page.goto(`https://gallery.invalid/playa#year/unknown?photo=${unknownId}`);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#photoDownload .download-status a').length === 8);
  assert.equal(new Set(mock.polls).size, 8);
  assert.equal(mock.posts.length, 0);
  assert.equal(mock.files.length, 0);
  assert.equal(JSON.parse(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey)).jobs.length, 8);
  await page.locator('#photoDownload .download-status a').last().click({ trial: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
}));

test('gallery: explicit logout clears recovery and stops status polling', () => scenario(async (page, mock) => {
  let release;
  mock.replies = [{ ...mock.ready(), wait: new Promise((resolve) => { release = resolve; }) }];
  await mock.start();
  await page.waitForFunction((key) => sessionStorage.getItem(key), recoveryKey);
  await page.locator('#closePhoto').click();
  // Keep the document alive to inspect the click handler and late callbacks;
  // the logged-out login page intentionally has an opaque sandboxed origin.
  await page.locator('#logout').evaluate((node) => node.addEventListener('click', (event) => event.preventDefault()));
  await page.locator('#logout').click();
  await page.waitForFunction((key) => sessionStorage.getItem(key) === null, recoveryKey);
  const stopped = mock.polls.length;
  release();
  await page.waitForTimeout(150);
  assert.equal(mock.polls.length, stopped);
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.files.length, 0);
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey), null);
}));

test('gallery: unavailable browser storage leaves in-page exports working', () => scenario(async (page, mock) => {
  await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', {
    get() { throw new DOMException('Storage disabled', 'SecurityError'); },
  }));
  mock.fallback = mock.ready();
  const download = page.waitForEvent('download');
  await mock.start();
  await download;
  assert.equal(mock.posts.length, 1);
  assert.equal(mock.files.length, 1);
  await page.locator('#photoDownload .download-status a').waitFor();
}));

for (const [name, reply, message] of [
  ['worker failure', { state: 'failed', error: 'integrity' }, 'Could not prepare this download.'],
  ['missing request', { http: 404 }, 'Download status is no longer available.'],
  ['forbidden request', { http: 403 }, 'Download status is no longer available.'],
]) {
  test(`gallery: ${name} stops polling and permits a deliberate new export`, () => scenario(async (page, mock) => {
    mock.fallback = reply;
    await mock.start();
    await page.waitForFunction((text) => document.querySelector('#photoDownload .download-status').textContent === text, message);
    assert.ok(await page.locator('#photoDownload .download-options button').first().isEnabled());
    await page.waitForTimeout(150);
    assert.equal(mock.polls.length, 1);
    assert.equal(mock.posts.length, 1);
    assert.deepEqual(await page.evaluate(() => window.pollDelays), []);
  }));
}

test('gallery: expired authentication redirects without retrying the export or status', () => scenario(async (page, mock) => {
  mock.fallback = { http: 401 };
  await mock.start();
  await page.waitForURL('https://gallery.invalid/playa');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey), null);
  assert.equal(mock.polls.length, 1);
  assert.equal(mock.posts.length, 1);
}));

(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYA_BROWSER_PATH, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try { await suite(tests); } finally { await browser.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
