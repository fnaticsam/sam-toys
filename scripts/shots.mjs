// Run `npm ci`, then `node scripts/shots.mjs [slug ...]`.
// Optional: SHOTS_DIR=/tmp/shots SHOTS_WAIT_MS=8000 node scripts/shots.mjs slug
// Inspect each result before publishing; use a fresh, unauthenticated context.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sites = {
  chillin: 'https://chillin.fun',
  sparkli: 'https://www.sparkli.fun',
  vroom: 'https://vroom.fan',
  ultimatequestion: 'https://www.theultimatequestion.guide',
  ugame: 'https://ugame.events',
  trd: 'https://trd.fun',
  splittt: 'https://splitt.fun',
  taotime: 'https://taotime.me',
  tbb: 'https://tbb.ceo',
  finca: 'https://finca.fan',
  drfit: 'https://drfit.tips',
  driftsea: 'https://driftsea.co',
  flick: 'https://flick.fan',
  bijou: 'https://bijou.fan',
  hike: 'https://hike.fan',
  knomi: 'https://knomi.club',
  seer: 'https://seer.coach',
  materiality: 'https://materiality.cc',
};
const slugs = process.argv.slice(2);
for (const slug of slugs) {
  if (!Object.hasOwn(sites, slug)) throw new Error(`Unknown slug: ${slug}`);
}
const output = process.env.SHOTS_DIR || fileURLToPath(new URL('../assets/shots/', import.meta.url));
const wait = Number(process.env.SHOTS_WAIT_MS || 1500);
if (!Number.isFinite(wait) || wait < 1500) throw new Error('SHOTS_WAIT_MS must be at least 1500');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const queue = slugs.length ? slugs : Object.keys(sites);
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const slug = queue.shift();
      const context = await browser.newContext({ viewport: { width: 1500, height: 938 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      try {
        const response = await page.goto(sites[slug], { waitUntil: 'load', timeout: 60000 });
        if (!response?.ok()) throw new Error(`HTTP ${response?.status()}`);
        let idle = true;
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => { idle = false; });
        await page.evaluate(() => Promise.race([
          document.fonts.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Fonts did not settle')), 20000)),
        ]));
        // Only dismiss a consent control inside a cookie/consent container.
        const consent = page.locator('[role="dialog"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i]');
        const dismiss = consent.getByRole('button', { name: /^(reject all|reject optional cookies|decline|necessary only|accept all|accept all cookies|accept cookies|accept|agree|i agree|got it)$/i }).first();
        if (await dismiss.isVisible()) await dismiss.click();
        await page.waitForTimeout(wait);
        const metadata = await page.evaluate(() => ({
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.content || '',
        }));
        // Avoid replacing an existing asset with an obvious error or challenge.
        if (/^(error|404|500|access denied|just a moment|sign in|log in|login)(\b|[ :–—-])/i.test(metadata.title)) {
          throw new Error(`Unusable page: ${metadata.title}`);
        }
        if (await page.locator('input[type="password"]:visible, input[placeholder="speak the word"]:visible').count()
          || (await page.getByRole('button', { name: /continue with google/i }).isVisible()
            && await page.getByRole('button', { name: /continue with apple/i }).isVisible())) {
          throw new Error('Login wall; existing screenshot left untouched');
        }
        let quality = 85;
        let jpg = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
        while ((jpg.length > 150 * 1024 && quality > 45) || (jpg.length < 40 * 1024 && quality < 100)) {
          quality += jpg.length > 150 * 1024 ? -5 : 5;
          jpg = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
        }
        await writeFile(path.join(output, `${slug}.jpg`), jpg);
        console.log(JSON.stringify({ slug, ...metadata, kb: +(jpg.length / 1024).toFixed(1), quality, idle }));
      } catch (error) {
        console.error(JSON.stringify({ slug, error: error.message }));
        process.exitCode = 1;
      } finally {
        await context.close();
      }
    }
  }));
} finally {
  await browser.close();
}
