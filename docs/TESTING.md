# Local checks and release inputs

Use Node from `.nvmrc` and npm from `packageManager`, then run:

```sh
npm ci --ignore-scripts
npm run check
npm audit --audit-level=moderate
npm test
node node_modules/playwright-core/cli.js install chromium
npm run test:browser
```

The test runner discovers test files, runs each in a separate process, and uses synthetic passwords and a generated guide in a temporary directory. It does not inherit provider/storage credentials or load the private guide. Tests stub external APIs. Browser tests intercept requests; `PLAYA_BROWSER_PATH` may select an existing Chromium installation. No deployment or paid request is part of these commands.

CI pins action revisions and installs the lockfile without lifecycle scripts. It checks syntax, the existing public gallery scan, dependency advisories, handlers, and browser behavior. The routing compiler's test dependency is overridden to the patched compatible `path-to-regexp` 6.3.0; route tests exercise that compiler. The scan is a limited guard, not proof that all source or history contains no sensitive information.

## Private release preflight

The real `api/_lib/dev.html` and optional `dev-stats.json` remain ignored deployment inputs. Public CI deliberately cannot validate their contents. After obtaining the approved files outside the repository and committing source changes, run `npm run release:preflight`. It requires the guide, runs the existing private content acceptance test and scanner, and writes an ignored `release-manifest.local.json` with the exact source commit and private asset hashes. Keep this manifest with the private release receipt; do not publish it as a CI artifact. Scanner output is suppressed to avoid printing private matches.

Preflight does not deploy, confirm production health, or replace the separately authorized release process. Owner-specific scan patterns and production configuration remain an operator responsibility.

Audit branches disable automatic Vercel Git previews. Review and merge alone are not evidence of a production release.
