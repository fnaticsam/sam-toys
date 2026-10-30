# Test CI

`test.yml` runs on PRs targeting `main` and every push to `main`. PR updates
cancel older runs for the same PR; main runs have unique concurrency groups so
neither running nor pending main runs are cancelled by subsequent pushes.

The selection job reads `package.json` engines, then `.nvmrc`, falling back to
Node 24. npm caches include each existing lockfile at the root, `robot/ba`, and
`api/_lib/samid`. Installs use `npm ci`. Playwright is pinned in the root lockfile;
Chromium is cached by that lockfile, with Linux dependencies installed on every
browser run, including cache hits.

| Parallel job | Coverage | Measured test time on ai-box | Expected GitHub job time |
| --- | --- | --- | --- |
| flights-unit | Domain, earning, cities, Starlink and UI unit tests | 0.35 s | 20–60 s |
| flights-api | Handler, MCP, provider coverage and auth tests | 0.25 s | 20–60 s |
| robot-ba | Node tests under `robot/ba`, when present | Not present in this checkout | 20–60 s plus suite runtime |
| misc | All remaining Node tests, including API, Playa, dev stats and CI selection | 1.46 s | 20–60 s |
| Flights / Chromium | `tests/flights/browser-check.cjs`, desktop and phone | ~70 s (42 checks) | 1–3 min; cold install may take 4 min |

Estimates exclude GitHub runner queue time. Node and browser jobs run in parallel
after selection, targeting under five minutes overall. GitHub timings remain
unverified until this uncommitted workflow is pushed.

On PRs, the selector diffs the merge base against the PR head (including both
sides of renames). Flights source, API and fixture edits run both flights shards
and Chromium. Robot and other known test directories select their own shard.
Workflow/package files, shared code and unknown paths select everything;
documentation-only edits select no tests. Main always selects every existing
suite and Chromium. Discovery assigns new Node test files to a shard automatically;
`robot/ba` and `api/_lib/samid` are absent from this checkout and are supported
conditionally rather than creating empty failing jobs.

Run the same shards locally with:

```sh
node .github/scripts/tests.cjs plan
node .github/scripts/tests.cjs run flights-unit
node .github/scripts/tests.cjs run flights-api
node .github/scripts/tests.cjs run misc
node --test
node tests/flights/browser-check.cjs
```

The three private dev-guide suites register explicit Node test skips when
`api/_lib/dev.html` is absent; they execute their existing checks when it exists.
Dev stats still run in public checkouts. Tests set dummy credentials internally,
so no repository secrets are required.
