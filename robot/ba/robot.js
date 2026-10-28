'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FileDataStore, SupabaseDataStore } = require('./data-store');
const { ManualOtpProvider } = require('./providers');
const { privateDir, lockDirectory } = require('./private-files');
const { Safety } = require('./safety');
const { parseAccount, parseRewards, isoDate } = require('./parsers');
const browser = require('./browser');
const { fail, safeError, RobotError } = require('./errors');

function positive(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,3}$/.test(String(value))) fail('LIMIT_CONFIG');
  return Number(value);
}
function validateQuery(query) {
  if (!query || !/^[A-Z]{3}$/.test(query.from || '') || !/^[A-Z]{3}$/.test(query.to || '') || query.from === query.to) fail('ROUTE_INPUT');
  try { isoDate(query.date); } catch { fail('DATE_INPUT'); }
  if (!['economy', 'premium', 'business', 'first'].includes(query.cabin)) fail('CABIN_INPUT');
  return query;
}
async function runDry(command, query) {
  // Dry runs have no home-directory, datastore, browser, credential or network access.
  const fixture = name => fs.readFile(path.join(__dirname, 'fixtures', name), 'utf8');
  if (command === 'balance') return { synthetic: true, dry_run: true, account: parseAccount(await fixture('account.html')) };
  if (query.from !== 'LHR' || query.to !== 'JFK' || query.date !== '2026-12-03' || query.cabin !== 'economy') fail('DRY_RUN_FIXTURE_ONLY');
  return { synthetic: true, dry_run: true, query, results: parseRewards(await fixture('rewards.html'), query) };
}
async function run(command, query, { env = process.env, dryRun = false, home = os.homedir(), deps = {}, onOtpRequest = () => {} } = {}) {
  if (!['balance', 'reward-search'].includes(command)) fail('COMMAND_INPUT');
  if (command === 'reward-search') validateQuery(query);
  if (dryRun) return runDry(command, query);
  if (env.BA_LIVE_ENABLED !== '1') fail('LIVE_DISABLED');
  if (process.platform !== 'darwin' && !deps.launchBrowser) fail('MACOS_REQUIRED');
  if (!/^\d{6,12}$/.test(env.BA_MEMBERSHIP || '')) fail('BA_MEMBERSHIP_REQUIRED');
  const maxLogins = positive(env.BA_MAX_LOGINS_PER_DAY, 3), maxSearches = positive(env.BA_MAX_SEARCHES_PER_HOUR, 6);
  if (!['manual', 'gmail'].includes(env.BA_OTP_PROVIDER || 'manual')) fail('OTP_PROVIDER_CONFIG');
  if (env.BA_OTP_PROVIDER === 'gmail') fail('GMAIL_OTP_NOT_CONFIGURED');
  const root = await privateDir(path.join(home, 'Library', 'Application Support', 'sam-flights'));
  const unlock = await lockDirectory(path.join(root, 'ba-run.lock'));
  let context, safety, store, search, ledger;
  const accountRef = createHash('sha256').update(`ba:${env.BA_MEMBERSHIP}`).digest('hex');
  try {
    ledger = new FileDataStore(path.join(root, 'ba-safety.json'), { now: deps.now });
    await ledger.checkSafety(accountRef, env.BA_ACKNOWLEDGE_STOP);
    if (env.BA_DATA_STORE && !['file', 'supabase'].includes(env.BA_DATA_STORE)) fail('DATASTORE_CONFIG');
    store = deps.store || (env.BA_DATA_STORE === 'file'
      ? new FileDataStore(path.join(root, 'ba-data.json'), { now: deps.now })
      : new SupabaseDataStore({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }));
    safety = new Safety({ ledger, store, accountRef, maxLogins, maxSearches, sleep: deps.sleep, jitter: deps.jitter });
    const profile = await privateDir(path.join(root, 'ba-profile'));
    context = await (deps.launchBrowser || browser.launchBrowser)(profile);
    const page = await (deps.prepareBrowser || browser.prepareBrowser)(context, safety);
    const otp = deps.otp || new ManualOtpProvider({ store });
    const options = { safety, membership: env.BA_MEMBERSHIP, accountRef, otp, keychain: deps.keychain, onOtpRequest };
    await (deps.ensureSession || browser.ensureSession)(page, options);
    if (command === 'balance') {
      const account = await (deps.readBalance || browser.readBalance)(page, options);
      await safety.check(page);
      const snapshot = await store.saveSnapshot(accountRef, account);
      return { account: snapshot };
    }
    search = await store.createSearch(accountRef, query);
    const results = await (deps.readRewards || browser.readRewards)(page, query, options);
    await safety.check(page);
    await store.completeSearch(search.id, results);
    return { search_id: search.id, query, results };
  } catch (error) {
    const code = safeError(error);
    if (search) await store.failSearch(search.id, code).catch(() => {});
    if (ledger) await ledger.recordEvent(accountRef, 'run_failed', { reason: code }).catch(() => {});
    if (store && store !== ledger) await store.recordEvent(accountRef, 'run_failed', { reason: code }).catch(() => {});
    throw new RobotError(code);
  } finally {
    let cleanupFailed = false;
    try {
      if (context) { try { await context.close(); } catch { cleanupFailed = true; } }
      if (safety) {
        try { await safety.drain(); } catch { fail('EVENT_PERSISTENCE_FAILED'); }
        safety.assert();
      }
      if (cleanupFailed) fail('BROWSER_CLOSE_FAILED');
    } finally {
      // A failed close or an unwritten challenge latch requires manual inspection.
      // Keep the run lock rather than admitting another browser against this profile.
      if (!cleanupFailed && !(safety?.reason && !safety.latched)) await unlock();
    }
  }
}
module.exports = { run, validateQuery };
