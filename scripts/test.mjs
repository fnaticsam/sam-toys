import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = process.argv.includes('--browser');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const files = [...walk(join(root, 'tests')), ...walk(join(root, 'api'))].filter(file => {
  const name = relative(root, file);
  if (name === 'tests/dev-page/body.test.js') return false; // Private release input; checked by preflight.
  const isBrowser = /browser[^/]*\.(?:js|cjs|mjs)$/.test(name);
  return browser ? isBrowser : !isBrowser && /(?:\.test\.(?:js|cjs|mjs)|routing-check\.js)$/.test(name);
}).sort();
if (!files.length) throw new Error('No tests discovered');

// Never borrow a developer's credentials or private guide for a public CI run.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'PLAYWRIGHT_BROWSERS_PATH', 'PLAYA_BROWSER_PATH', 'BROWSER_PATH']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { NODE_ENV: 'test', TZ: 'UTC', DEV_PASSWORD: 'synthetic-dev-password', PLAYA_PASSWORD: 'synthetic-playa-password', LONDONPLAN_PASSWORD: 'synthetic-london-password' });
const fixture = mkdtempSync(join(tmpdir(), 'sam-toys-tests-'));
try {
  for (const folder of ['api', 'tests', 'scripts']) cpSync(join(root, folder), join(fixture, folder), {
    recursive: true,
    filter: source => !['dev.html', 'dev-stats.json'].includes(source.split('/').at(-1)),
  });
  if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  const ids = ['factory-what', 'box-what', ...Array.from({ length: 32 }, (_, i) => `synthetic-${i}`)];
  writeFileSync(join(fixture, 'api/_lib/dev.html'), '<!doctype html><title>sam.toys / dev</title>' + ids.map((id, i) => `<section id="${id}"><h3>Synthetic section ${i}</h3><p>Synthetic test documentation for section ${i}.</p></section>`).join('\n'));
  let failed = 0;
  for (const file of files) {
    const name = relative(root, file);
    console.log(`\nRunning ${name}`);
    const localEnv = { ...env, ...(name.startsWith('tests/dev-page/') ? { REPO_DIR: fixture } : {}) };
    const result = spawnSync(process.execPath, [file], { cwd: root, env: localEnv, stdio: 'inherit', timeout: 180_000 });
    if (result.status !== 0) { failed++; console.error(`FAIL ${name} (${result.error?.code || result.signal || result.status})`); }
  }
  console.log(`\n${files.length - failed}/${files.length} test files passed. Private guide content is excluded; run release:preflight with approved local assets.`);
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
