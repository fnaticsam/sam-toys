#!/usr/bin/env node
'use strict';
const { run } = require('./robot');
const { fail, safeError } = require('./errors');
function parseArgs(args) {
  const command = args[0];
  if (!['balance', 'reward-search'].includes(command)) fail('COMMAND_INPUT');
  const values = {}, seen = new Set(); let dryRun = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail('CLI_INPUT'); seen.add(arg);
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (!['--from', '--to', '--date', '--cabin'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) fail('CLI_INPUT');
    values[arg.slice(2)] = args[++i];
  }
  if (command === 'balance' && Object.keys(values).length) fail('CLI_INPUT');
  return { command, query: values, dryRun };
}
async function main(args = process.argv.slice(2)) {
  try {
    const { command, query, dryRun } = parseArgs(args);
    const result = await run(command, query, { dryRun, onOtpRequest: id => process.stderr.write(`Manual OTP requested: ${id}\n`) });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write(`BA robot: ${safeError(error)}\n`); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { parseArgs, main };
