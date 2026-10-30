// Shared discovery keeps CI shards exhaustive as new Node tests are added.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const suites = ['flights-unit', 'flights-api', 'robot-ba', 'misc'];
function discover(dir = '.') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git'].includes(entry.name)) return [];
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return discover(file);
    return /(?:\.test|[._-]test|^test(?:-.+)?)\.[cm]?[jt]s$/.test(entry.name)
      || (file.split('/').includes('test') && /\.[cm]?[jt]s$/.test(entry.name)) ? [file] : [];
  });
}
function suiteFor(file) {
  if (file.startsWith('robot/ba/')) return 'robot-ba';
  if (!file.startsWith('tests/flights/')) return 'misc';
  return /\/(?:api|mcp|starlink-api|provider-coverage|.*auth.*)\.test\./.test(file)
    ? 'flights-api' : 'flights-unit';
}
function affected(files) {
  const selected = new Set();
  for (const file of files) {
    if (/(?:^|\/)package(?:-lock)?\.json$/.test(file) || file === '.nvmrc' || file.startsWith('.github/')) {
      return new Set([...suites, 'browser']);
    }
    if (/^(flights\/|tests\/flights\/|api\/(?:flights(?:-auth)?\.js|_lib\/flights\/))/.test(file)) {
      ['flights-unit', 'flights-api', 'browser'].forEach(s => selected.add(s));
    } else if (file.startsWith('robot/ba/') && !/(?:^|\/)package(?:-lock)?\.json$/.test(file)) {
      selected.add('robot-ba');
    } else if (/^tests\/(?:dev-page|playa|gemini)\//.test(file)
      || /^api\/(?:dev(?:-ask)?\.js|playa\.js|_lib\/(?:dev[^/]*|playa\/))$/.test(file)) {
      selected.add('misc');
    } else if (file.startsWith('docs/') || /(?:^|\/)\w[\w.-]*\.md$/.test(file)) {
      // Documentation-only edits cannot affect the executable suites.
    } else {
      // Workflow/package files, shared code and unmapped paths fail open to all tests.
      return new Set([...suites, 'browser']);
    }
  }
  return selected;
}
function plan() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const node = pkg.engines?.node || (fs.existsSync('.nvmrc') && fs.readFileSync('.nvmrc', 'utf8').trim()) || '24';
  const locks = ['package-lock.json', 'robot/ba/package-lock.json', 'api/_lib/samid/package-lock.json']
    .filter(file => fs.existsSync(file));
  let selected = new Set([...suites, 'browser']);
  if (process.env.CI_EVENT === 'pull_request') {
    if (!process.env.CI_BASE || !process.env.CI_HEAD) throw new Error('Missing PR diff SHAs');
    const files = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', `${process.env.CI_BASE}...${process.env.CI_HEAD}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
    selected = affected(files);
  }
  const existing = new Set(discover().map(suiteFor));
  const matrix = suites.filter(s => selected.has(s) && existing.has(s));
  const output = `node=${node}\nlocks<<LOCKFILES\n${locks.join('\n')}\nLOCKFILES\nmatrix=${JSON.stringify(matrix)}\nbrowser=${selected.has('browser')}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
function run(suite) {
  if (!suites.includes(suite)) throw new Error(`Unknown suite: ${suite}`);
  const files = discover().filter(file => suiteFor(file) === suite).sort();
  if (!files.length) throw new Error(`No tests found for ${suite}`);
  const cwd = suite === 'robot-ba' ? 'robot/ba' : '.';
  const args = files.map(file => path.relative(cwd, file));
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
module.exports = { discover, suiteFor, affected };
if (require.main === module) {
  if (process.argv[2] === 'plan') plan();
  else if (process.argv[2] === 'run') run(process.argv[3]);
  else throw new Error('Usage: node .github/scripts/tests.cjs plan|run <suite>');
}
