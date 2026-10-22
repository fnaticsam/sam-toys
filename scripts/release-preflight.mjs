import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const guide = 'api/_lib/dev.html';
if (!existsSync(resolve(root, guide))) throw new Error('Required private guide is missing; obtain the approved deployment input outside public CI.');
if (git('ls-files', '--error-unmatch', guide).status === 0) throw new Error('Private guide must not be tracked.');
if (git('status', '--porcelain', '--untracked-files=no').stdout.trim()) throw new Error('Commit tracked source changes before release preflight.');
const checks = [
  [process.execPath, ['tests/dev-page/body.test.js']],
  ['bash', ['tests/dev-page/secret-scan.sh', guide]],
];
for (const [command, args] of checks) {
  // Existing scanners can echo matching private content. Keep all output private.
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, REPO_DIR: root }, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Private release check failed: ${args[0]} (details suppressed).`);
}
const files = [guide, 'api/_lib/dev-stats.json'].filter(file => existsSync(resolve(root, file)));
const manifest = {
  version: 1,
  sourceCommit: git('rev-parse', 'HEAD').stdout.trim(),
  generatedAt: new Date().toISOString(),
  privateAssets: files.map(file => {
    const data = readFileSync(resolve(root, file));
    return { path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }),
};
writeFileSync(resolve(root, 'release-manifest.local.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log('Private release checks passed; source/asset hashes saved to ignored release-manifest.local.json. No deployment performed.');
