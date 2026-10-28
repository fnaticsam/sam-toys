'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
require('./helpers');
const { parseArgs } = require('../cli');
const { query } = require('./helpers');

function cli(args) {
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'offline-guard.js'), path.join(__dirname, '../cli.js'), ...args], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BA_LIVE_ENABLED: '0', BA_MEMBERSHIP: 'synthetic-invalid' }
  });
}
test('CLI parses required route arguments and rejects unknown/duplicate/booking commands', () => {
  assert.deepEqual(parseArgs(['reward-search', '--from', 'LHR', '--to', 'JFK', '--date', '2026-12-03', '--cabin', 'economy', '--dry-run']), { command: 'reward-search', query, dryRun: true });
  for (const args of [['book'], ['balance', '--to', 'JFK'], ['balance', '--dry-run', '--dry-run'], ['reward-search', '--from'], ['balance', '--secret', 'x']]) assert.throws(() => parseArgs(args));
});
test('exact balance and reward dry-run commands emit synthetic JSON offline', () => {
  const balance = cli(['balance', '--dry-run']); assert.equal(balance.status, 0, balance.stderr);
  assert.equal(JSON.parse(balance.stdout).account.tier_points, 12450);
  const rewards = cli(['reward-search', '--from', 'LHR', '--to', 'JFK', '--date', '2026-12-03', '--cabin', 'economy', '--dry-run']);
  assert.equal(rewards.status, 0, rewards.stderr); assert.equal(JSON.parse(rewards.stdout).results.length, 2);
  assert.equal(JSON.parse(rewards.stdout).synthetic, true);
});
test('CLI errors contain safe codes only and no stack or supplied secret', () => {
  const disabled = cli(['balance']); assert.equal(disabled.status, 1); assert.equal(disabled.stdout, ''); assert.equal(disabled.stderr, 'BA robot: LIVE_DISABLED\n');
  const bad = cli(['reward-search', '--from', 'a-synthetic-secret', '--to', 'JFK', '--date', '2026-12-03', '--cabin', 'economy', '--dry-run']);
  assert.equal(bad.status, 1); assert.equal(bad.stderr, 'BA robot: ROUTE_INPUT\n');
});
