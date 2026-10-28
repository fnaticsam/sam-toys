'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, query } = require('./helpers');
const { parseAccount, parseRewards, detectChallenge, isoDate } = require('../parsers');

test('synthetic account: exact balances, tier and collection-year end', async () => {
  assert.deepEqual(parseAccount(await fixture('account.html'), { membership: '12345678' }), {
    tier: 'Gold', tier_points: 12450, avios: 182345, collection_year_end: '2027-03-31'
  });
});
test('account identity must match without exposing membership in output/errors', async () => {
  assert.throws(() => parseAccount(require('node:fs').readFileSync(require('node:path').join(__dirname, '../fixtures/account.html'), 'utf8'), { membership: '87654321' }), { message: 'ACCOUNT_MISMATCH' });
});
test('missing, duplicate, malformed numeric fields fail closed', async () => {
  const html = await fixture('account.html');
  for (const changed of [html.replace('12,450', '-1'), html.replace('12,450', '12,45'), html.replace('182,345', '9007199254740992'), html.replace('data-testid="avios-balance"', 'data-testid="missing"'), html.replace('</dl>', '<dd data-testid="avios-balance">1</dd></dl>')]) {
    assert.throws(() => parseAccount(changed));
  }
});
test('dates reject rollover dates and accept ISO/leap dates', () => {
  assert.equal(isoDate('29 February 2028'), '2028-02-29');
  assert.equal(isoDate('2027-03-31'), '2027-03-31');
  for (const date of ['2026-02-29', '31 February 2027', '31 Mystery 2027', '2026-13-01']) assert.throws(() => isoDate(date));
});
test('synthetic reward options preserve every cash/Avios mix in minor units', async () => {
  const rows = parseRewards(await fixture('rewards.html'), query);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].mixes, [{ avios: 25000, cash_minor: 5000, currency: 'GBP' }, { avios: 20000, cash_minor: 10000, currency: 'GBP' }, { avios: 15000, cash_minor: 17550, currency: 'GBP' }]);
  assert.equal(rows[1].mixes.length, 2); assert.equal(rows[1].available_seats, null);
  assert.equal(rows[0].price_basis, 'one_adult_one_way');
});
test('only explicit, query-matching empty state is zero availability', async () => {
  const empty = await fixture('no-rewards.html');
  assert.deepEqual(parseRewards(empty, query), []);
  assert.throws(() => parseRewards(empty, { ...query, to: 'NRT' }), { message: 'SEARCH_MISMATCH' });
  assert.throws(() => parseRewards('<main>Loading…</main>', query), { message: 'PAGE_CONTRACT' });
});
test('mismatched route/date/cabin/passengers and ambiguous result pages are rejected', async () => {
  const html = await fixture('rewards.html');
  for (const q of [{ ...query, from: 'LGW' }, { ...query, date: '2026-12-04' }, { ...query, cabin: 'first' }]) assert.throws(() => parseRewards(html, q), { message: 'SEARCH_MISMATCH' });
  assert.throws(() => parseRewards(html.replace('data-adults="1"', 'data-adults="2"'), query), { message: 'SEARCH_MISMATCH' });
  assert.throws(() => parseRewards(html.replace('</main>', '<p data-testid="no-reward-flights">None</p></main>'), query));
});
test('incomplete mix disclosure, invalid amounts/currency and partial cards fail', async () => {
  const html = await fixture('rewards.html');
  for (const changed of [html.replaceAll('all-avios-options', 'collapsed'), html.replace('175.50', '175.5'), html.replace('50.00', '-50.00'), html.replace('GBP', 'pounds'), html.replace('08:25', '25:25')]) assert.throws(() => parseRewards(changed, query));
});
test('challenge text, lock variants, embedded challenge frames stop parsing', async () => {
  const samples = [
    ['<p>Complete this CAPTCHA</p>', 'CAPTCHA'], ['<p>Verify you are human</p>', 'CAPTCHA'],
    ['<p>Bot challenge</p>', 'BOT_CHALLENGE'], [await fixture('challenge.html'), 'UNUSUAL_ACTIVITY'],
    ['<p>Your account is temporarily locked</p>', 'ACCOUNT_LOCKED'], ['<p>Your account has been temporarily locked</p>', 'ACCOUNT_LOCKED'],
    ['<p>Your account has been blocked</p>', 'ACCOUNT_LOCKED'], ['<iframe src="https://invalid.example/hcaptcha"></iframe>', 'CAPTCHA']
  ];
  for (const [html, code] of samples) { assert.equal(detectChallenge(html), code); assert.throws(() => parseAccount(html), { message: code }); }
  assert.equal(detectChallenge('<script>const text = "captcha"</script><p>Normal account</p>'), null);
});
