'use strict';
require('./offline-guard');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const site = require('../selectors');
const accountRef = 'a'.repeat(64);
const query = { from: 'LHR', to: 'JFK', date: '2026-12-03', cabin: 'economy' };
const fixture = name => fs.readFile(path.join(__dirname, '..', 'fixtures', name), 'utf8');
async function temp(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ba-offline-')));
  t.after(() => fs.rm(dir, { recursive: true })); return dir;
}
const noSleep = async () => {};
async function fakeBrowser({ session = false, otp = false, loginFailure = false, challenge = false, throwPassword = false, collapsedMixes = false } = {}) {
  const account = await fixture('account.html'), rewards = await fixture('rewards.html');
  const log = []; let state = 'blank', expanded = !collapsedMixes;
  const c = site.controls, f = site.fields;
  const html = () => {
    if (state === 'account') return account;
    if (state === 'results') return expanded ? rewards : rewards.replaceAll('data-testid="all-avios-options"', 'data-testid="collapsed-options"');
    if (state === 'challenge') return '<main>Your account is temporarily locked</main>';
    return `<main>${state}</main>`;
  };
  function locator(selector, cardIndex = null) {
    return {
      async fill(value) { log.push(['fill', selector === c.password || selector === c.otp ? 'redacted-field' : selector]); if (selector === c.password && throwPassword) throw new Error(`synthetic Playwright error with ${value}`); },
      async check() { log.push(['check', selector]); },
      async selectOption(value) { log.push(['select', selector, value]); },
      async getAttribute() { return state === 'results' ? 'synthetic-search-1' : null; },
      async click() {
        log.push(['click', selector]);
        if (selector === c.login) state = challenge ? 'challenge' : loginFailure ? 'error' : otp ? 'otp' : 'account';
        if (selector === c.otpSubmit) state = 'account';
        if (selector === c.search) state = 'results';
        if (selector === c.mixes) expanded = true;
      },
      async isVisible() {
        if (selector === f.tier) return state === 'account';
        if (selector === c.membership) return state === 'login';
        if (selector === c.otp) return state === 'otp';
        if (selector === c.loginError) return state === 'error';
        return state === 'form' || state === 'results';
      },
      async count() {
        if (selector === f.rewardPage) return state === 'results' ? 1 : 0;
        if (selector === f.card) return state === 'results' ? 2 : 0;
        if (selector === f.allMixes) return expanded ? 1 : 0;
        if (selector === f.mix) return cardIndex === 1 ? 2 : 3;
        return 1;
      },
      nth(i) { return locator(selector, i); }, first() { return this; },
      locator(nested) { return locator(nested, cardIndex); },
      async waitFor() { log.push(['wait', selector]); }
    };
  }
  const page = {
    content: async () => html(), locator,
    async goto(url) { log.push(['goto', url]); state = url === site.urls.rewards ? 'form' : session ? 'account' : 'login'; },
    async waitForFunction(_fn, arg) { log.push(['wait-state', arg]); },
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async close() {}
  };
  const context = {
    closed: 0, bindings: {}, handlers: {},
    async exposeBinding(name, fn) { this.bindings[name] = fn; },
    async addInitScript(fn, args) { this.initScript = { fn, args }; },
    async route(_glob, fn) { this.routeHandler = fn; },
    pages: () => [page], async newPage() { return page; },
    on(name, fn) { this.handlers[name] = fn; },
    async close() { this.closed++; }
  };
  return { context, page, log };
}
module.exports = { fixture, temp, noSleep, fakeBrowser, accountRef, query };
