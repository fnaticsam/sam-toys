'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('./errors');

async function privateDir(dir) {
  dir = path.resolve(dir);
  // Reject symlinks along the entire path, including pre-existing parents.
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') fail('PRIVATE_DIRECTORY'); }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PRIVATE_DIRECTORY');
  }
  const stat = await fs.lstat(dir);
  if (stat.uid !== process.getuid()) fail('PRIVATE_DIRECTORY');
  await fs.chmod(dir, 0o700);
  return dir;
}
async function readJson(file, fallback) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) fail('PRIVATE_FILE');
    await fs.chmod(file, 0o600);
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return fallback; fail('PRIVATE_FILE'); }
}
async function writeJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Flush the new ledger before it becomes visible; fail closed on I/O errors.
    const fd = await fs.open(tmp, 'r');
    try { await fd.sync(); } finally { await fd.close(); }
    await fs.rename(tmp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { await fs.unlink(tmp).catch(() => {}); fail('PRIVATE_WRITE'); }
}
async function lockDirectory(dir) {
  try { await fs.mkdir(dir, { mode: 0o700 }); } catch { fail('ROBOT_BUSY'); }
  try { await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch { fail('LOCK_WRITE'); } // Leave a failed lock in place for manual inspection.
  return async () => {
    await fs.unlink(path.join(dir, 'owner.json'));
    await fs.rmdir(dir);
  };
}
module.exports = { privateDir, readJson, writeJson, lockDirectory };
