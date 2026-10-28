'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const { randomInt } = require('node:crypto');
const { detectChallenge } = require('./parsers');
const site = require('./selectors');
const { fail, RobotError } = require('./errors');

class Safety {
  constructor({ ledger, store, accountRef, maxLogins = 3, maxSearches = 6, sleep = delay, jitter = () => randomInt(800, 1801) }) {
    Object.assign(this, { ledger, store, accountRef, maxLogins, maxSearches, sleep, jitter });
    this.controller = new AbortController(); this.reason = null; this.stopping = null; this.context = null; this.latched = false;
  }
  get signal() { return this.controller.signal; }
  assert() { if (this.reason) fail(this.reason); }
  async reserve(action) {
    this.assert();
    if (!['login', 'search'].includes(action)) fail('QUOTA_ACTION');
    await this.ledger.reserveAction(this.accountRef, action, action === 'login' ? this.maxLogins : this.maxSearches, action === 'login' ? 86400000 : 3600000);
  }
  stop(reason) {
    if (this.stopping) return this.stopping;
    const reasons = new Set([...site.challenges.map(c => c[0]), 'UNEXPECTED_NAVIGATION', 'UNEXPECTED_WINDOW']);
    this.reason = reasons.has(reason) ? reason : 'BOT_CHALLENGE';
    this.controller.abort(); // Synchronous: no later step can be admitted.
    const closing = Promise.resolve().then(() => this.context?.close()).catch(() => {});
    this.stopping = (async () => {
      // Local latch is the authority even when Supabase is unavailable.
      try {
        await this.ledger.recordEvent(this.accountRef, 'safety_stop', { reason: this.reason });
        this.latched = true;
        if (this.store !== this.ledger) await this.store.recordEvent(this.accountRef, 'safety_stop', { reason: this.reason });
      } finally { await closing; }
    })();
    // Observer callbacks must not create unhandled rejections. drain() checks persistence.
    this.stopping.catch(() => {});
    return this.stopping;
  }
  async drain() { if (this.stopping) await this.stopping; }
  async inspect(html) {
    this.assert(); const reason = detectChallenge(html);
    if (reason) { await this.stop(reason); this.assert(); }
  }
  async check(page) {
    this.assert();
    let html;
    try { html = await page.content(); } catch { this.assert(); fail('SITE_ACTION_FAILED'); }
    await this.inspect(html);
  }
  async step(page, action) {
    await this.check(page);
    try { await this.sleep(this.jitter(), undefined, { signal: this.signal }); }
    catch { this.assert(); fail('SITE_ACTION_FAILED'); }
    await this.check(page);
    try {
      const result = await action();
      await this.check(page); return result;
    } catch (e) {
      this.assert();
      if (e instanceof RobotError) throw e;
      fail('SITE_ACTION_FAILED');
    }
  }
  async attach(context) {
    this.context = context;
    await context.exposeBinding('__samBaSafetyStop', (_source, reason) => { this.stop(reason); });
    await context.addInitScript(({ patterns, framePattern }) => {
      let stopped = false;
      const check = () => {
        if (stopped) return;
        const text = document.body?.innerText || '';
        let reason = patterns.find(([, pattern]) => new RegExp(pattern, 'i').test(text))?.[0];
        if (!reason && [...document.querySelectorAll('iframe[src], script[src]')].some(el => new RegExp(framePattern, 'i').test(el.src))) reason = 'CAPTCHA';
        if (reason) { stopped = true; window.__samBaSafetyStop(reason).catch(() => {}); }
      };
      new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      document.addEventListener('DOMContentLoaded', check); check();
    }, { patterns: site.challenges.map(([code, regex]) => [code, regex.source]), framePattern: site.challengeFrames.source });
  }
}
module.exports = { Safety };
