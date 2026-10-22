// Optional tooling: NODE_PATH exposes playwright-core; UPLOADS_BROWSER_PATH
// selects installed Chromium (or the shared BROWSER_PATH). Every browser request is intercepted; all API
// responses and files are synthetic. No API key, provider or live app is used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.UPLOADS_BROWSER_PATH || process.env.BROWSER_PATH || process.env.PLAYA_BROWSER_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'],
  });
});
after(async () => { if (browser) await browser.close(); });

async function openToy(t, toy) {
  const context = await browser.newContext();
  const html = fs.readFileSync(path.join(__dirname, '../..', toy, 'index.html'), 'utf8');
  const unexpected = [], errors = [];
  await context.route('**/*', route => {
    if (route.request().url() === `https://uploads.invalid/${toy}/`)
      return route.fulfill({ contentType: 'text/html', body: html });
    unexpected.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(() => {
    window.__requests = [];
    window.__ignoreAbort = false;
    window.__activeRequests = 0;
    window.__maxRequests = 0;
    window.__audioDecodes = 0;
    window.AudioContext = window.webkitAudioContext = class {
      constructor() { window.__audioDecodes++; throw new Error('Full audio decode must not run'); }
    };
    window.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      const record = { url, options, aborted: false, settled: false };
      window.__requests.push(record);
      window.__activeRequests++;
      window.__maxRequests = Math.max(window.__maxRequests, window.__activeRequests);
      const finish = fn => value => {
        if (record.settled) return;
        record.settled = true;
        window.__activeRequests--;
        fn(value);
      };
      const done = finish(resolve), fail = finish(reject);
      record.respond = (status, value) => done(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
      record.fail = () => fail(new TypeError('Synthetic network interruption'));
      options.signal?.addEventListener('abort', () => {
        record.aborted = true;
        if (!window.__ignoreAbort) fail(new DOMException('Synthetic abort', 'AbortError'));
      });
    });
    const NativeFileReader = window.FileReader;
    window.__readers = [];
    window.__readsStarted = 0;
    window.FileReader = class {
      constructor() {
        if (!window.__deferReads) {
          const reader = new NativeFileReader();
          for (const method of ['readAsText', 'readAsArrayBuffer']) {
            const original = reader[method].bind(reader);
            reader[method] = file => { window.__readsStarted++; original(file); };
          }
          return reader;
        }
      }
      readAsText(file) { this.start(file); }
      readAsArrayBuffer(file) { this.start(file); }
      start(file) { this.readyState = 1; window.__readsStarted++; window.__readers.push({ file, reader: this }); }
      abort() { this.readyState = 2; this.onabort?.(); }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(unexpected, [], 'no unexpected browser request');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
  });
  await page.goto(`https://uploads.invalid/${toy}/`);
  return page;
}

const image = (name = 'synthetic.png', bytes = 120) => ({ name, mimeType: 'image/png', buffer: Buffer.alloc(bytes) });
const audio = (name = 'synthetic.ogg', bytes = 200) => ({ name, mimeType: 'audio/ogg', buffer: Buffer.alloc(bytes) });
const xml = { name: 'synthetic.xml', mimeType: 'text/xml', buffer: Buffer.from('<DJ_PLAYLISTS><COLLECTION><TRACK Name="New XML track" Artist="Fixture"/></COLLECTION></DJ_PLAYLISTS>') };
const transcript = { tldr: 'Synthetic summary', bullets: ['Synthetic bullet'], transcript: 'Synthetic transcript', language: 'English' };
const respond = (page, index, status, value) => page.evaluate(({ index, status, value }) => window.__requests[index].respond(status, value), { index, status, value });
const requests = page => page.evaluate(() => window.__requests.length);

test('Tracks: repeated Enter is one request, and new work can start after it finishes', async t => {
  const page = await openToy(t, 'tracks');
  await page.locator('#paste-url').fill('https://open.spotify.com/playlist/fixture');
  await page.locator('#paste-url').press('Enter');
  await page.locator('#paste-url').press('Enter');
  assert.equal(await requests(page), 1);
  await respond(page, 0, 200, { tracks: [{ title: 'First result' }] });
  await page.waitForFunction(() => !document.getElementById('paste-go').disabled);
  await page.locator('#paste-url').press('Enter');
  assert.equal(await requests(page), 2);
});

test('Tracks: stale paste success cannot overwrite a completed XML import', async t => {
  const page = await openToy(t, 'tracks');
  await page.evaluate(() => { window.__ignoreAbort = true; });
  await page.locator('#paste-url').fill('https://open.spotify.com/playlist/fixture');
  await page.locator('#paste-go').click();
  await page.locator('#tab-xml').click();
  await page.locator('#xml-file').setInputFiles(xml);
  await page.getByText('New XML track', { exact: true }).waitFor();
  await respond(page, 0, 200, { tracks: [{ title: 'Stale result' }] });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(await page.locator('.card .title').textContent(), 'New XML track');
  assert.equal(await page.locator('a.beatport').count(), 0);
  assert.equal(await page.evaluate(() => window.__requests[0].aborted), true);
});

test('Tracks: stale failure cannot clear new results or unlock a newer operation', async t => {
  const page = await openToy(t, 'tracks');
  await page.evaluate(() => { window.__ignoreAbort = true; });
  await page.locator('#paste-url').fill('https://open.spotify.com/playlist/old');
  await page.locator('#paste-go').click();
  await page.locator('#tab-xml').click();
  await page.locator('#tab-paste').click();
  await page.locator('#paste-url').fill('https://open.spotify.com/playlist/new');
  await page.locator('#paste-go').click();
  await page.evaluate(() => window.__requests[0].fail());
  assert.equal(await page.locator('#paste-go').isDisabled(), true);
  assert.equal(await page.locator('.msg.err').count(), 0);
  await respond(page, 1, 200, { tracks: [{ title: 'Latest result' }] });
  await page.getByText('Latest result', { exact: true }).waitFor();
});

test('Tracks: cancelled XML read cannot replace a newer paste result', async t => {
  const page = await openToy(t, 'tracks');
  await page.evaluate(() => { window.__deferReads = true; });
  await page.locator('#tab-xml').click();
  await page.locator('#xml-file').setInputFiles(xml);
  await page.locator('#tab-paste').click();
  await page.locator('#paste-url').fill('https://open.spotify.com/playlist/fixture');
  await page.locator('#paste-go').click();
  await respond(page, 0, 200, { tracks: [{ title: 'Current paste result' }] });
  await page.getByText('Current paste result', { exact: true }).waitFor();
  await page.evaluate(() => {
    const reader = window.__readers[0].reader;
    reader.result = '<COLLECTION><TRACK Name="Late XML"/></COLLECTION>';
    reader.onload();
  });
  assert.equal(await page.locator('.card .title').textContent(), 'Current paste result');
});

test('Tracks: switching modes while reading screenshots never submits cancelled OCR', async t => {
  const page = await openToy(t, 'tracks');
  await page.evaluate(() => { window.__deferReads = true; });
  await page.locator('#tab-shot').click();
  await page.locator('#shot-file').setInputFiles(image());
  await page.locator('#tab-xml').click();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(await requests(page), 0);
  assert.equal(await page.locator('.msg.err').count(), 0);
  assert.equal(await page.locator('#xml-drop').isDisabled(), false);
});

test('Tracks: pending OCR ignores duplicate drops and stale response after switching', async t => {
  const page = await openToy(t, 'tracks');
  await page.evaluate(() => { window.__ignoreAbort = true; });
  await page.locator('#tab-shot').click();
  await page.locator('#shot-file').setInputFiles(image());
  await page.waitForFunction(() => window.__requests.length === 1);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(120)], 'duplicate.png', { type: 'image/png' }));
    document.getElementById('shot-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
  });
  assert.equal(await requests(page), 1);
  await page.locator('#tab-xml').click();
  await respond(page, 0, 200, { rows: [{ title: 'Stale OCR' }] });
  assert.equal(await page.locator('.card').count(), 0);
  assert.equal(await page.locator('#xml-drop').isDisabled(), false);
});

test('Tracks: image count and exact encoded-size overflow are rejected before reads', async t => {
  const page = await openToy(t, 'tracks');
  await page.locator('#tab-shot').click();
  await page.locator('#shot-file').setInputFiles(Array.from({ length: 9 }, (_, i) => image(`fixture-${i}.png`)));
  await page.getByText('Choose up to 8 screenshots per request.').waitFor();
  await page.locator('#shot-file').setInputFiles(image('oversize.png', 3100000));
  await page.getByText('Those screenshots exceed the 3 MB total upload limit. Send fewer or crop them.').waitFor();
  // Exactly 3 MB raw still exceeds the API cap when separate files add padding.
  await page.locator('#shot-file').setInputFiles([image('first.png', 1500001), image('second.png', 1499999)]);
  assert.equal(await requests(page), 0);
  assert.equal(await page.evaluate(() => window.__readsStarted), 0);
});

test('Tracks: an exact four-million-character image payload remains accepted', async t => {
  const page = await openToy(t, 'tracks');
  await page.locator('#tab-shot').click();
  await page.locator('#shot-file').setInputFiles(image('boundary.png', 3000000));
  await page.waitForFunction(() => window.__requests.length === 1);
  assert.equal(await page.evaluate(() => JSON.parse(window.__requests[0].options.body).images[0].data.length), 4000000);
  await respond(page, 0, 200, { rows: [{ artist: 'Fixture', title: 'Accepted screenshot' }] });
  await page.getByText('Accepted screenshot', { exact: true }).waitFor();
});

test('Tracks: both file pickers work from the keyboard', async t => {
  const page = await openToy(t, 'tracks');
  // Enable chooser interception before keyboard navigation starts.
  page.on('filechooser', () => {});
  await page.locator('#tab-xml').click();
  await page.keyboard.press('Tab'); // Screenshot tab
  await page.keyboard.press('Tab'); // XML picker
  assert.equal(await page.evaluate(() => document.activeElement.id), 'xml-drop');
  const xmlChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const first = await xmlChooser;
  assert.equal(first.isMultiple(), false);
  await first.setFiles([]);
  await page.locator('#tab-shot').click();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'shot-drop');
  const shotChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Space');
  const second = await shotChooser;
  assert.equal(second.isMultiple(), true);
  await second.setFiles([]);
});

test('Voicenotes: a batch reads and uploads one at a time without audio decoding', async t => {
  const page = await openToy(t, 'voicenotes');
  await page.locator('#file').setInputFiles(Array.from({ length: 3 }, (_, i) => audio(`note-${i}.ogg`)));
  await page.waitForFunction(() => window.__requests.length === 1);
  assert.match(await page.locator('#queue-status').textContent(), /2 queued/);
  assert.equal(await page.evaluate(() => window.__readsStarted), 1);
  for (let i = 0; i < 3; i++) {
    await respond(page, i, 200, transcript);
    if (i < 2) await page.waitForFunction(count => window.__requests.length === count, i + 2);
  }
  await page.waitForFunction(() => document.getElementById('queue-status').hidden);
  assert.equal(await page.evaluate(() => window.__maxRequests), 1);
  assert.equal(await page.evaluate(() => window.__audioDecodes), 0);
  assert.equal(await page.locator('.headline').count(), 3);
});

test('Voicenotes: oversized batches are rejected without reading or submitting', async t => {
  const page = await openToy(t, 'voicenotes');
  await page.locator('#file').setInputFiles(Array.from({ length: 12 }, (_, i) => audio(`note-${i}.ogg`)));
  await page.getByText('Up to 10 notes can be queued at once. Choose fewer, or wait for the current notes to finish.').waitFor();
  assert.equal(await requests(page), 0);
  assert.equal(await page.evaluate(() => window.__readsStarted), 0);
});

test('Voicenotes: queue capacity includes the active note and subsequent selections', async t => {
  const page = await openToy(t, 'voicenotes');
  await page.locator('#file').setInputFiles(Array.from({ length: 10 }, (_, i) => audio(`note-${i}.ogg`)));
  await page.waitForFunction(() => window.__requests.length === 1);
  await page.locator('#file').setInputFiles(audio('eleventh.ogg'));
  await page.getByText('Up to 10 notes can be queued at once. Choose fewer, or wait for the current notes to finish.').waitFor();
  assert.match(await page.locator('#queue-status').textContent(), /9 queued/);
  assert.equal(await requests(page), 1);
});

test('Voicenotes: an ambiguous failed POST is not retried and the next note can finish', async t => {
  const page = await openToy(t, 'voicenotes');
  await page.locator('#file').setInputFiles([audio('first.ogg'), audio('second.ogg')]);
  await page.waitForFunction(() => window.__requests.length === 1);
  await page.evaluate(() => window.__requests[0].fail());
  await page.waitForFunction(() => window.__requests.length === 2);
  assert.match(await page.locator('.msg.error').textContent(), /first\.ogg.*may already have been processed/);
  assert.equal(await page.evaluate(() => JSON.parse(window.__requests[1].options.body).filename), 'second.ogg');
  await respond(page, 1, 200, transcript);
  await page.waitForFunction(() => document.getElementById('queue-status').hidden);
  assert.equal(await requests(page), 2);
  assert.equal(await page.locator('.vn.busy').count(), 0);
});

test('Voicenotes: timeout releases the queue without retrying the uncertain note', async t => {
  const page = await openToy(t, 'voicenotes');
  await page.clock.install();
  await page.locator('#file').setInputFiles([audio('slow.ogg'), audio('next.ogg')]);
  await page.waitForFunction(() => window.__requests.length === 1);
  await page.clock.fastForward(70001);
  await page.waitForFunction(() => window.__requests.length === 2);
  assert.match(await page.locator('.msg.error').textContent(), /slow\.ogg.*Timed out.*may already have been processed/);
  assert.equal(await page.evaluate(() => JSON.parse(window.__requests[1].options.body).filename), 'next.ogg');
  assert.equal(await page.evaluate(() => window.__requests[0].aborted), true);
});

test('Voicenotes: file-read failure advances to the next queued note', async t => {
  const page = await openToy(t, 'voicenotes');
  await page.evaluate(() => { window.__deferReads = true; });
  await page.locator('#file').setInputFiles([audio('unreadable.ogg'), audio('readable.ogg')]);
  await page.evaluate(() => { window.__deferReads = false; window.__readers[0].reader.onerror(); });
  await page.waitForFunction(() => window.__requests.length === 1);
  assert.equal(await page.evaluate(() => JSON.parse(window.__requests[0].options.body).filename), 'readable.ogg');
  assert.match(await page.locator('.msg.error').textContent(), /unreadable\.ogg.*Could not read/);
});

test('Both upload tools explain Gemini transfer without promising zero provider retention', async t => {
  const tracks = await openToy(t, 'tracks');
  await tracks.locator('#tab-shot').click();
  assert.match(await tracks.locator('#p-shot').textContent(), /sent through sam\.toys to Google Gemini/);
  assert.match(await tracks.locator('#p-shot').textContent(), /retention depends on the service configuration/);
  const voice = await openToy(t, 'voicenotes');
  assert.match(await voice.locator('#chat').textContent(), /sent through sam\.toys to Google Gemini/);
  assert.match(await voice.locator('#chat').textContent(), /no saved history/);
  assert.doesNotMatch(await voice.locator('.bar').textContent(), /never leaves/);
});
