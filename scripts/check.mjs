import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
let failed = false;
for (const file of ['api', 'scripts', 'tests'].flatMap(folder => walk(join(root, folder))).filter(file => /\.(?:js|cjs|mjs)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  failed ||= result.status !== 0;
}
const scan = spawnSync('bash', ['tests/playa/public-repo-scan.sh'], { cwd: root, stdio: 'inherit' });
failed ||= scan.status !== 0;
process.exitCode = failed ? 1 : 0;
