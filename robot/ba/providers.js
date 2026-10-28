'use strict';
const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { fail } = require('./errors');

function readKeychainPassword(membership, { exec = execFile } = {}) {
  if (!/^\d{6,12}$/.test(membership || '')) fail('BA_MEMBERSHIP_REQUIRED');
  return new Promise((resolve, reject) => {
    exec('/usr/bin/security', ['find-generic-password', '-s', 'ba-club', '-a', membership, '-w'],
      { encoding: 'buffer', maxBuffer: 16384, timeout: 15000 }, (error, stdout) => {
        if (error || !stdout?.length) {
          if (Buffer.isBuffer(stdout)) stdout.fill(0);
          const { RobotError } = require('./errors'); reject(new RobotError('KEYCHAIN_UNAVAILABLE')); return;
        }
        // security adds one newline; preserve any other password whitespace.
        const password = stdout.toString('utf8').replace(/\r?\n$/, '');
        stdout.fill(0);
        if (!password) { const { RobotError } = require('./errors'); reject(new RobotError('KEYCHAIN_UNAVAILABLE')); return; }
        resolve(password);
      });
  });
}
class OtpProvider { async getCode() { fail('NOT_IMPLEMENTED'); } }
class ManualOtpProvider extends OtpProvider {
  constructor({ store, now = Date.now, sleep = delay, timeoutMs = 180000, pollMs = 2000 }) {
    super(); Object.assign(this, { store, now, sleep, timeoutMs, pollMs });
  }
  async getCode({ accountRef, signal, onRequest = () => {} }) {
    const deadline = this.now() + this.timeoutMs;
    const id = await this.store.createOtpRequest(accountRef, deadline);
    try {
      await onRequest(id);
      while (this.now() < deadline) {
        if (signal?.aborted) fail('SAFETY_STOP');
        const code = await this.store.consumeOtp(accountRef, id);
        if (code) return code;
        try { await this.sleep(Math.min(this.pollMs, deadline - this.now()), undefined, { signal }); }
        catch { fail('SAFETY_STOP'); }
      }
      fail('OTP_TIMEOUT');
    } finally { await this.store.closeOtp(accountRef, id); }
  }
}
class GmailOtpProvider extends OtpProvider {
  // Deliberately no Gmail client, OAuth loading, token refresh or network code.
  // Future implementation must use gmail.readonly and a verified sender query.
  async getCode() { fail('GMAIL_OTP_NOT_CONFIGURED'); }
}
class Notifier { async notify() { fail('NOT_IMPLEMENTED'); } }
class IMessageNotifier extends Notifier {
  constructor({ recipient = process.env.BA_IMESSAGE_RECIPIENT, exec = execFile } = {}) { super(); this.recipient = recipient; this.exec = exec; }
  async notify(message) {
    if (!/^(?:\+[1-9]\d{6,14}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.test(this.recipient || '')) fail('IMESSAGE_RECIPIENT');
    // Fixed summaries only. Never send credentials, account balances, OTPs or page content.
    if (!['BA balance updated.', 'BA reward search completed.', 'BA robot stopped; review the local event log.'].includes(message)) fail('NOTIFICATION_CONTENT');
    const script = 'on run argv\ntell application "Messages"\nset svc to first service whose service type = iMessage\nset targetBuddy to buddy (item 1 of argv) of svc\nsend (item 2 of argv) to targetBuddy\nend tell\nend run';
    await new Promise((resolve, reject) => this.exec('/usr/bin/osascript', ['-e', script, this.recipient, message], { timeout: 15000 }, error => {
      if (error) { const { RobotError } = require('./errors'); reject(new RobotError('IMESSAGE_FAILED')); } else resolve();
    }));
  }
}
module.exports = { readKeychainPassword, OtpProvider, ManualOtpProvider, GmailOtpProvider, Notifier, IMessageNotifier };
