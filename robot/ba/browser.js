'use strict';
const site = require('./selectors');
const { parseAccount, parseRewards } = require('./parsers');
const { readKeychainPassword } = require('./providers');
const { fail } = require('./errors');
const path = require('node:path');
const { privateDir, readJson, writeJson } = require('./private-files');

async function prepareProfile(profileDir) {
  const dir = await privateDir(path.join(profileDir, 'Default'));
  const file = path.join(dir, 'Preferences');
  const preferences = await readJson(file, {});
  preferences.credentials_enable_service = false;
  preferences.profile = { ...preferences.profile, password_manager_enabled: false };
  await writeJson(file, preferences);
}

async function launchBrowser(profileDir) {
  // Playwright protocol debug logs can contain fill() arguments. Disable before import.
  for (const name of ['DEBUG', 'DEBUG_FILE', 'PWDEBUG']) delete process.env[name];
  try {
    await prepareProfile(profileDir);
    const { chromium } = require('playwright');
    const browserEnv = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_CTYPE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    return await chromium.launchPersistentContext(profileDir, { headless: false, acceptDownloads: false, serviceWorkers: 'block',
      env: browserEnv, args: ['--disable-save-password-bubble', '--disable-session-crashed-bubble', '--disable-background-networking', '--no-first-run'],
      timeout: 30000 });
  } catch { fail('BROWSER_UNAVAILABLE'); }
}
async function prepareBrowser(context, safety) {
  await safety.attach(context);
  await context.route('**/*', async route => {
    const request = route.request();
    let url; try { url = new URL(request.url()); } catch { await route.abort(); return; }
    const isBA = url.protocol === 'https:' && (url.hostname === 'britishairways.com' || url.hostname.endsWith('.britishairways.com'));
    const forbidden = /(?:^|\/)(?:checkout|payment|purchase|ticketing|booking-confirmation|complete-booking)(?:\/|$)/i.test(url.pathname);
    if (safety.reason || !isBA || forbidden) {
      await route.abort().catch(() => {});
      if (!safety.reason && (request.isNavigationRequest() || forbidden)) safety.stop('UNEXPECTED_NAVIGATION');
      return;
    }
    await route.continue().catch(() => {});
  });
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  for (const extra of pages.slice(1)) await extra.close();
  context.on('page', extra => { if (extra !== page) safety.stop('UNEXPECTED_WINDOW'); });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  return page;
}
async function waitForAny(page, safety, selectors) {
  await safety.step(page, () => page.waitForFunction(list => list.some(selector => {
    const el = document.querySelector(selector);
    return el && el.getClientRects().length > 0;
  }), selectors, { timeout: 30000 }));
}
async function ensureSession(page, { safety, membership, keychain = readKeychainPassword, otp, accountRef, onOtpRequest }) {
  const c = site.controls, f = site.fields;
  await safety.step(page, () => page.goto(site.urls.account, { waitUntil: 'domcontentloaded' }));
  await waitForAny(page, safety, [f.tier, c.membership]);
  if (await page.locator(f.tier).isVisible()) { parseAccount(await page.content(), { membership }); return; }
  await safety.reserve('login'); // Count even Keychain/browser failures; never retry automatically.
  let password;
  try {
    password = await keychain(membership);
    await safety.step(page, () => page.locator(c.membership).fill(membership));
    await safety.step(page, () => page.locator(c.password).fill(password));
  } finally { password = undefined; }
  await safety.step(page, () => page.locator(c.login).click());
  await waitForAny(page, safety, [f.tier, c.otp, c.loginError]);
  if (await page.locator(c.otp).isVisible()) {
    let code;
    try {
      code = await otp.getCode({ accountRef, signal: safety.signal, onRequest: onOtpRequest });
      await safety.step(page, () => page.locator(c.otp).fill(code));
    } finally { code = undefined; }
    await safety.step(page, () => page.locator(c.otpSubmit).click());
    await waitForAny(page, safety, [f.tier, c.loginError]);
  }
  if (!await page.locator(f.tier).isVisible()) fail('LOGIN_NOT_CONFIRMED');
  parseAccount(await page.content(), { membership });
}
async function readBalance(page, { safety, membership }) {
  await safety.check(page); return parseAccount(await page.content(), { membership });
}
async function readRewards(page, query, { safety }) {
  const c = site.controls, f = site.fields;
  await safety.reserve('search');
  await safety.step(page, () => page.goto(site.urls.rewards, { waitUntil: 'domcontentloaded' }));
  await waitForAny(page, safety, [c.from]);
  await safety.step(page, () => page.locator(c.oneWay).check());
  await safety.step(page, () => page.locator(c.adults).selectOption('1'));
  for (const field of ['from', 'to', 'date']) await safety.step(page, () => page.locator(c[field]).fill(query[field]));
  await safety.step(page, () => page.locator(c.cabin).selectOption(site.cabinValues[query.cabin]));
  const before = await page.locator(f.rewardPage).count() ? await page.locator(f.rewardPage).getAttribute(site.resultAttributes.token) : null;
  await safety.step(page, () => page.locator(c.search).click());
  await safety.step(page, () => page.waitForFunction(({ fields, attrs, query, before }) => {
    const result = document.querySelector(fields.rewardPage);
    return result && result.getAttribute(attrs.token) && result.getAttribute(attrs.token) !== before &&
      ['from', 'to', 'date', 'cabin'].every(k => result.getAttribute(attrs[k]) === query[k]) &&
      result.getAttribute(attrs.adults) === '1' && result.getAttribute(attrs.trip) === 'one_way' &&
      (result.querySelector(fields.card) || result.querySelector(fields.empty));
  }, { fields: f, attrs: site.resultAttributes, query, before }, { timeout: 30000 }));
  const cards = page.locator(f.card);
  for (let i = 0; i < await cards.count(); i++) {
    const card = cards.nth(i);
    if (!await card.locator(f.allMixes).count()) {
      const expand = card.locator(c.mixes);
      if (await expand.count() !== 1) fail('MIXES_UNAVAILABLE');
      await safety.step(page, () => expand.click());
      await safety.step(page, () => card.locator(f.allMixes).first().waitFor({ state: 'visible' }));
    }
  }
  await safety.check(page);
  return parseRewards(await page.content(), query);
}
module.exports = { launchBrowser, prepareProfile, prepareBrowser, ensureSession, readBalance, readRewards };
