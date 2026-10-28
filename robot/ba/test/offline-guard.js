'use strict';
// Loaded before application modules, including in CLI child processes.
// Any accidental network or external command makes an offline test fail.
const denied = () => { throw new Error('OFFLINE_TEST_FORBIDS_EXTERNAL_ACCESS'); };
globalThis.fetch = denied;
for (const name of ['node:http', 'node:https']) {
  const mod = require(name); mod.request = denied; mod.get = denied;
}
require('node:net').connect = denied;
require('node:tls').connect = denied;
const cp = require('node:child_process');
cp.exec = denied; cp.execFile = denied; cp.spawn = denied;
