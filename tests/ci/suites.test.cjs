const { test } = require('node:test');
const assert = require('node:assert/strict');
const { affected, discover, suiteFor } = require('../../.github/scripts/tests.cjs');
const selected = paths => [...affected(paths)].sort();
const all = ['browser', 'flights-api', 'flights-unit', 'misc', 'robot-ba'];

test('shared and CI configuration changes run every suite, including Chromium', () => {
  for (const file of ['package.json', 'package-lock.json', '.nvmrc', '.github/workflows/test.yml',
    '.github/scripts/tests.cjs', 'api/_lib/samid/package-lock.json', 'robot/ba/package.json',
    'api/_lib/shared.js', 'vercel.json', 'new-product/index.html']) {
    assert.deepEqual(selected([file]), all, file);
  }
});
test('flight UI, handlers and fixtures select both Node shards and Chromium', () => {
  for (const file of ['flights/index.html', 'tests/flights/fixtures/search.json',
    'api/flights.js', 'api/flights-auth.js', 'api/_lib/flights/earn.js']) {
    assert.deepEqual(selected([file]), ['browser', 'flights-api', 'flights-unit'], file);
  }
});
test('independent suite changes stay scoped and combine across a PR', () => {
  assert.deepEqual(selected(['tests/playa/gate.test.js']), ['misc']);
  assert.deepEqual(selected(['robot/ba/earn.js']), ['robot-ba']);
  assert.deepEqual(selected(['tests/dev-page/stats.test.js', 'robot/ba/earn.js']), ['misc', 'robot-ba']);
  assert.deepEqual(selected(['docs/PROJECT.md']), []);
});
test('new tests get a shard without an explicit workflow allowlist', () => {
  assert.equal(suiteFor('tests/flights/new-domain.test.js'), 'flights-unit');
  assert.equal(suiteFor('tests/flights/flights-auth.test.js'), 'flights-api');
  assert.equal(suiteFor('robot/ba/test/earn.test.js'), 'robot-ba');
  assert.equal(suiteFor('api/_lib/new.test.js'), 'misc');
  const files = discover();
  assert(files.includes('api/_lib/match.test.js'));
  assert(files.includes('tests/ci/suites.test.cjs'));
  assert(!files.some(file => file.includes('node_modules/') || file.endsWith('browser-check.cjs')));
});
